/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 *
 * Park/dispose is gated against concurrent ensureLive/hub-send:
 * - A disposing session is never handed out.
 * - ensureLive during an in-flight park either cancels the park (session still
 *   live) or waits for detach+park and then revives.
 * - Concurrent ensureLive/park operations coalesce per id.
 *
 * Every adoption, park, and revival is bound to the exact {@link AgentRef} it
 * started from, so stale async work (a late finalizer, a cancelled initializer,
 * a superseded revive) can never clobber a newer same-id ref.
 */

import { logger } from "@wxyhgk/pi-utils";
import type { AgentSession } from "../session/agent-session";
import {
	type AgentRef,
	type AgentRefExpectation,
	AgentRegistry,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "./agent-registry";

export type AgentReviver = (expected: AgentRef) => Promise<AgentSession>;

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	ref: AgentRef;
	idleTtlMs: number;
	revive?: AgentReviver;
	timer?: NodeJS.Timeout;
}

interface ParkInFlight {
	/** The exact ref this park was started for. */
	ref: AgentRef;
	/** Resolves when the park attempt finishes (success, cancel, or dispose error). */
	promise: Promise<void>;
	/** Cancel before the session is detached. Returns true if cancel took effect. */
	cancel: () => boolean;
	/** True once cancel() succeeded (ensureLive kept the live session). */
	cancelled: boolean;
	/** True once the live session has been detached and status is parked. */
	detached: boolean;
}

interface RevivingAgent {
	ref: AgentRef;
	promise: Promise<AgentSession>;
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) {
			current.#unsubscribe?.();
			current.#unsubscribe = undefined;
			for (const adopted of current.#adopted.values()) {
				clearTimeout(adopted.timer);
			}
			current.#adopted.clear();
			current.#revivals.clear();
			current.#parks.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts, each bound to the ref it started from. A park is
	 * cancelable until the live session is detached; after detach, ensureLive
	 * waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
	/** In-flight revives, bound to the parked ref that initiated them, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** TTL applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtlMs = 0;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * When `expected` is given, the adoption is refused if the id no longer
	 * resolves to that ref (or that ref's session).
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void {
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref || (expected !== undefined && ref !== expected && ref.session !== expected)) {
			logger.warn("AgentLifecycleManager.adopt: 未知或已被替换的 Agent id", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = { ref, idleTtlMs: opts.idleTtlMs, revive: opts.revive };
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live) — and, when `expected` is given, still bound to that ref. */
	has(id: string, expected?: AgentRefExpectation): boolean {
		const adopted = this.#adopted.get(id);
		return Boolean(
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected),
		);
	}

	/**
	 * True when this manager owns `registry` — i.e. its adopt/park/revive state
	 * describes that registry's refs. Lets a caller holding a specific registry
	 * (e.g. a custom-registry {@link IrcBus} that fell back to the global
	 * manager) skip lifecycle gating that would consult unrelated park state.
	 */
	manages(registry: AgentRegistry): boolean {
		return this.#registry === registry;
	}

	/**
	 * True while {@link park} is disposing this agent's session (lets dispose
	 * hooks distinguish park from teardown). False once the park is cancelled
	 * by ensureLive or after detach+dispose completes. When `expected` is
	 * given, only a park bound to that ref (or its session) counts.
	 */
	isParking(id: string, expected?: AgentRefExpectation): boolean {
		const park = this.#parks.get(id);
		return Boolean(
			park && !park.cancelled && (expected === undefined || park.ref === expected || park.ref.session === expected),
		);
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 *
	 * The session is detached (and status flipped to `parked`) *before*
	 * `session.dispose()` so concurrent {@link ensureLive}/hub-send never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(id: string): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;

		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = this.#registry.get(id);
		if (!ref || adopted.ref !== ref) return;
		const session = ref.session;
		if (!session) return;

		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Cancel only before detach — once detached the old session is already
				// leaving the registry and must finish disposing.
				if (park.detached || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				// Yield so a same-tick ensureLive/hub-send can cancel before we
				// commit to dispose. Deterministic with Promise microtasks; no timers.
				await Promise.resolve();
				if (cancelled) return;

				// Re-check liveness: release/unregister/replace may have raced us.
				const live = this.#registry.get(id);
				if (live !== ref || !live.session || live.session !== session) return;
				if (this.#adopted.get(id)?.ref !== ref) return;

				// Commit: detach + parked *before* dispose so callers never see a
				// dying session via ref.session / idle status.
				park.detached = true;
				this.#registry.detachSession(id, ref);
				this.#registry.setStatus(id, "parked", ref);

				try {
					await session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: 会话释放失败", { id, error: String(error) });
				}
			} finally {
				// Only clear if we are still the in-flight entry (a later park would
				// have replaced us only after we resolved).
				if (this.#parks.get(id) === park) this.#parks.delete(id);
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls share one in-flight revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		const park = this.#parks.get(id);
		if (park) {
			const parked = this.#registry.get(id);
			// Cancel if the live session is still attached — keep it instead of
			// thrashing dispose + revive.
			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				const kept = this.#registry.get(id)?.session;
				if (kept) {
					// Park cleared the idle timer; re-arm so TTL park still works.
					const adopted = this.#adopted.get(id);
					if (adopted && adopted.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
					return kept;
				}
			} else {
				// Already committed to detach (or no live session): wait for park,
				// then fall through to the revive path.
				await park.promise;
			}
		}

		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(`未知 Agent "${id}"——它从未被注册或已被释放。如存在记录,可通过 history://${id} 读取。`);
		}
		if (ref.session) return ref.session;
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return inflight.promise;
		const revival = this.#resolveAndRevive(id, ref);
		const pending: RevivingAgent = { ref, promise: revival };
		this.#revivals.set(id, pending);
		try {
			return await revival;
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef): Promise<AgentSession> {
		let adoption = this.#adopted.get(id);
		let revive = adoption?.ref === ref ? adoption.revive : undefined;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			if (revive) {
				adoption = { ref, idleTtlMs: this.#persistedReviveTtlMs, revive };
				this.#adopted.set(id, adoption);
				coldAdopted = true;
			}
		}
		if (this.#registry.get(id) !== ref) {
			throw new Error(`Agent "${id}" 在准备其持久化会话期间发生了变化。`);
		}
		if (ref.status !== "parked" || !revive || !adoption) {
			throw new Error(
				`Agent "${id}" 当前状态为 ${ref.status},无法恢复${revive ? "" : "(未注册恢复器)"}。其记录仍可通过 history://${id} 读取。`,
			);
		}
		try {
			return await this.#revive(id, revive, ref, adoption);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
			if (coldAdopted && this.#adopted.get(id) === adoption) this.#adopted.delete(id);
			throw error;
		}
	}

	/**
	 * Dispose if live and drop timers. When `expected` is given, only a ref
	 * matching it is released; a stale release can never take down a newer
	 * same-id ref. Returns true when a matching ref was released.
	 *
	 * By default the ref is unregistered (teardown / one-shot removal). Pass
	 * `tombstone: true` for an explicit kill: the ref is kept registered as a
	 * terminal `aborted` row (session detached) instead of being removed, so a
	 * later persisted-subagent scan (e.g. Agent Hub reopen) skips it via its
	 * `if (!registry.get(id))` guard rather than re-adopting the surviving
	 * on-disk transcript as a fresh `parked` row. Mirrors
	 * `finalizeSubagentLifecycle`'s genuine-kill path.
	 */
	async release(id: string, expected?: AgentRefExpectation, options?: { tombstone?: boolean }): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		const current = this.#registry.get(id);
		const currentMatches =
			current && (expected === undefined || current === expected || current.session === expected);
		const adoptedMatches =
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		if (!ref) return false;
		if (adopted?.ref === ref) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(id);
		}

		const park = this.#parks.get(id);
		if (park && park.ref === ref) {
			// Prefer cancel when the session is still live so release owns dispose.
			if (!park.detached) park.cancel();
			await park.promise;
		}

		if (options?.tombstone) {
			// Explicit kill: mark the ref terminal `aborted` and detach the session
			// BEFORE disposing. aborted refs must satisfy the AgentRef invariant
			// (session === null) so ensureLive / hub focus can never route into a
			// disposed session; setting the terminal status first also makes
			// createAgentSession's dispose wrapper (unregisterUnlessParked) preserve
			// the ref instead of removing it, so a later persisted-subagent rescan
			// skips it. The transcript file is left intact (history://<id>).
			this.#registry.setStatus(id, "aborted", ref);
		}
		const live = this.#registry.get(id) === ref ? ref.session : null;
		if (options?.tombstone) this.#registry.detachSession(id, ref);
		if (live) {
			try {
				await live.dispose();
			} catch (error) {
				logger.warn("AgentLifecycleManager.release: 会话释放失败", { id, error: String(error) });
			}
		}
		if (!options?.tombstone) this.#registry.unregister(id, ref);
		return true;
	}

	/** Teardown everything (process exit / main session dispose). */
	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		const ids = [...new Set([...this.#adopted.keys(), ...this.#parks.keys()])];
		await Promise.all(ids.map(id => this.release(id)));
		this.#revivals.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
	}

	async #revive(id: string, revive: AgentReviver, ref: AgentRef, adopted: AdoptedAgent): Promise<AgentSession> {
		const session = await revive(ref);
		let liveRef = this.#registry.get(id);
		if (liveRef === ref && ref.status === "parked" && !ref.session) {
			// A simple reviver returned a session without claiming the parked ref;
			// attach it here while the exact ref is still revivable.
			if (!this.#registry.attachSession(id, session, ref.sessionFile, ref)) {
				await session.dispose();
				throw new Error(`Agent "${id}" 在持久化会话挂接前发生了变化。`);
			}
			liveRef = ref;
		} else if (
			liveRef !== ref ||
			liveRef.status !== "running" ||
			liveRef.session !== session ||
			liveRef.kind !== ref.kind ||
			liveRef.parentId !== ref.parentId ||
			liveRef.sessionFile !== ref.sessionFile
		) {
			// createAgentSession may have already claimed this exact parked ref and
			// attached the returned session. Any other state — especially an
			// `aborted` tombstone set while revive() was in flight — is stale.
			await session.dispose();
			throw new Error(`Agent "${id}" 在恢复其持久化会话期间被替换或进入终态。`);
		}
		adopted.ref = liveRef;
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		if (!this.#registry.setStatus(id, "idle", liveRef)) {
			await session.dispose();
			throw new Error(`Agent "${id}" 在持久化会话进入空闲状态前发生了变化。`);
		}
		return session;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			void this.park(id);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted || adopted.ref !== event.ref) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			// Don't re-arm while a park is in flight — the park owns the transition.
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
