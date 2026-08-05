/**
 * Contracts: vibe worker-session registry lifecycle.
 *
 * 1. `spawn` returns immediately (session id + turn job id) while the turn
 *    runs in the background; the settled turn self-delivers a result carrying
 *    the activity trace AND the worker's response, and the session stays
 *    addressable (idle) afterwards.
 * 2. `send` routes by state: steering into a streaming mid-turn worker,
 *    queueing when the worker is mid-turn but not steerable (drained into the
 *    next turn automatically), and starting a follow-up turn on the SAME
 *    worker id when idle.
 * 3. `runSubagentFollowUpTurn` continues a live session in place: consecutive
 *    turns hit the same AgentSession instance (context retained) and the
 *    finalized result carries the yield payload + tool trace.
 * 4. `wait` wakes on the FIRST settling turn among concurrent sessions and
 *    acknowledges its delivery so the result is not delivered twice.
 * 5. `kill` cancels the in-flight turn job and releases the worker session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@wxyhgk/pi-coding-agent/async/job-manager";
import { Settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@wxyhgk/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@wxyhgk/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@wxyhgk/pi-coding-agent/session/agent-session";
import { SessionManager, SessionPersistenceIndeterminateError } from "@wxyhgk/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@wxyhgk/pi-coding-agent/session/session-storage";
import * as executorModule from "@wxyhgk/pi-coding-agent/task/executor";
import type { AgentProgress, SingleResult } from "@wxyhgk/pi-coding-agent/task/types";
import type { ToolSession } from "@wxyhgk/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@wxyhgk/pi-coding-agent/vibe/runtime";

const PERSISTED_WORKER_SYSTEM_PROMPT = "Persisted vibe worker";
const PERSISTED_WORKER_TOOLS = ["read", "yield"];
const INITIAL_VIBE_TASK = "Complete the first persisted turn.";
const FOLLOW_UP_VIBE_TASK = "Continue from the persisted conversation.";
const RESTORED_VIBE_RESPONSE = "Continued from persisted context.";

async function fileExists(file: string): Promise<boolean> {
	try {
		return (await fs.stat(file)).isFile();
	} catch {
		return false;
	}
}

type AtomicWriteHook = (commit: () => Promise<void>) => Promise<void>;

class FaultInjectingSessionStorage extends FileSessionStorage {
	readonly atomicWriteHooks: AtomicWriteHook[] = [];
	atomicWriteAttempts = 0;
	failedWriterClosed = false;
	#appendFault: { error: Error; prefixBytes: number } | undefined;

	failNextAppendWithPrefix(error: Error, prefixBytes: number): void {
		this.#appendFault = { error, prefixBytes };
	}

	override async writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.atomicWriteAttempts++;
		const hook = this.atomicWriteHooks.shift();
		const commit = () => super.writeTextAtomic(filePath, content, options);
		if (hook) await hook(commit);
		else await commit();
	}

	override openWriter(
		filePath: string,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	): SessionStorageWriter {
		const inner = super.openWriter(filePath, options);
		let injectedError: Error | undefined;
		let pendingFault: Promise<void> = Promise.resolve();
		let faulted = false;
		return {
			append: line => {
				const fault = this.#appendFault;
				if (!fault) return inner.append(line);
				this.#appendFault = undefined;
				faulted = true;
				const prefix = Buffer.from(line).subarray(0, fault.prefixBytes);
				const operation = fs.appendFile(filePath, prefix).then(() => {
					injectedError = fault.error;
					options?.onError?.(fault.error);
					throw fault.error;
				});
				pendingFault = operation.catch(() => {});
				return operation;
			},
			flush: async () => {
				await pendingFault;
				if (injectedError) throw injectedError;
				await inner.flush();
			},
			isOpen: () => inner.isOpen(),
			close: async () => {
				await pendingFault;
				await inner.close();
				if (faulted) this.failedWriterClosed = true;
			},
			getError: () => injectedError ?? inner.getError(),
		};
	}
}

class SwitchGatedSessionStorage extends FaultInjectingSessionStorage {
	#readGate:
		| {
				filePath: string;
				started: ReturnType<typeof Promise.withResolvers<void>>;
				release: ReturnType<typeof Promise.withResolvers<void>>;
		  }
		| undefined;

	gateNextRead(filePath: string): { started: Promise<void>; release: () => void } {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#readGate = { filePath, started, release };
		return { started: started.promise, release: release.resolve };
	}

	override async readTextSlices(
		filePath: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[string, string]> {
		const gate = this.#readGate;
		if (gate?.filePath === filePath) {
			this.#readGate = undefined;
			gate.started.resolve();
			await gate.release.promise;
		}
		return super.readTextSlices(filePath, prefixBytes, suffixBytes);
	}
}

interface TestSessionOptions {
	manager?: AsyncJobManager;
	sessionManager?: SessionManager;
	ownerId?: string;
	parentSessionId?: string;
}

function createSession(options: TestSessionOptions = {}): ToolSession {
	const sessionManager = options.sessionManager;
	return {
		cwd: sessionManager?.getCwd() ?? "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => sessionManager?.getSessionFile() ?? null,
		getSessionId: () => options.parentSessionId ?? sessionManager?.getSessionId() ?? "vibe-test-parent",
		getAgentId: () => options.ownerId ?? "Main",
		getArtifactsDir: () => sessionManager?.getArtifactsDir() ?? null,
		getSessionSpawns: () => "*",
		sessionManager,
		asyncJobManager: options.manager,
	};
}

interface PersistWorkerOptions {
	cwd: string;
	artifactsDir: string;
	id: string;
	task: string;
}

async function persistWorkerSession(options: PersistWorkerOptions): Promise<string> {
	const childSessionFile = path.join(options.artifactsDir, `${options.id}.jsonl`);
	const childManager = SessionManager.create(options.cwd, options.artifactsDir);
	await childManager.setSessionFile(childSessionFile);
	childManager.appendSessionInit({
		systemPrompt: PERSISTED_WORKER_SYSTEM_PROMPT,
		task: options.task,
		tools: [...PERSISTED_WORKER_TOOLS],
		spawns: "",
	});
	await childManager.flush();
	await childManager.close();
	return childSessionFile;
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

/**
 * Minimal stand-in for a worker AgentSession: records prompts/steers, replays
 * a scripted event stream through subscribed listeners on each prompt, and
 * reports a final assistant message — enough surface for the executor's run
 * monitor + driveSessionToYield.
 */
function createFakeWorkerSession(options: { streaming?: boolean; onDispose?: () => void | Promise<void> } = {}) {
	const listeners = new Set<(event: unknown) => void>();
	const prompts: string[] = [];
	const steers: string[] = [];
	let disposed = false;
	let lastAssistant: { stopReason: string; content: Array<{ type: string; text: string }> } | undefined;
	let script: { events: unknown[]; responseText: string } | undefined;
	const fake = {
		isStreaming: options.streaming ?? false,
		model: undefined,
		subscribe(listener: (event: unknown) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text: string): Promise<boolean> {
			prompts.push(text);
			const active = script;
			script = undefined;
			if (active) {
				for (const event of active.events) {
					for (const listener of [...listeners]) listener(event);
				}
				lastAssistant = { stopReason: "stop", content: [{ type: "text", text: active.responseText }] };
				const end = { type: "message_end", message: { role: "assistant", content: lastAssistant.content } };
				for (const listener of [...listeners]) listener(end);
			}
			return true;
		},
		async steer(text: string): Promise<void> {
			steers.push(text);
		},
		async waitForIdle(): Promise<void> {},
		getLastAssistantMessage() {
			return lastAssistant;
		},
		async abort(): Promise<void> {},
		async dispose(): Promise<void> {
			disposed = true;
			await options.onDispose?.();
		},
	};
	return {
		session: fake as unknown as AgentSession,
		prompts,
		steers,
		isDisposed: () => disposed,
		setStreaming(value: boolean) {
			fake.isStreaming = value;
		},
		setScript(next: { events: unknown[]; responseText: string }) {
			script = next;
		},
	};
}

/** Scripted turn: one `read` tool call, then a successful `yield` carrying `data`. */
function yieldTurnEvents(data: unknown): unknown[] {
	return [
		{ type: "tool_execution_start", toolName: "read", args: { path: "src/foo.ts" }, intent: "Reading foo" },
		{ type: "tool_execution_end", toolName: "read", result: {}, isError: false },
		{ type: "tool_execution_start", toolName: "yield", args: {} },
		{
			type: "tool_execution_end",
			toolName: "yield",
			result: { details: { status: "success", data } },
			isError: false,
		},
	];
}

/** Progress snapshot in the shape the executor's run monitor emits. */
function progressSnapshot(id: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "prompt",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

describe("vibe session registry", () => {
	const managers: AsyncJobManager[] = [];
	const persistedManagers: SessionManager[] = [];
	const tempRoots: string[] = [];

	async function createPersistedParent(storage?: SessionStorage): Promise<SessionManager> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vibe-resume-"));
		tempRoots.push(root);
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, path.join(root, "sessions"), storage);
		persistedManagers.push(manager);
		return manager;
	}

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	function installPersistedSpawnMock(): void {
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const artifactsDir = options.artifactsDir;
			if (!artifactsDir) throw new Error("Persisted vibe test requires an artifacts directory");
			const parentSessionFile = options.sessionFile;
			if (!parentSessionFile) throw new Error("Persisted vibe test requires a parent session file");
			const snapshot = await SessionManager.open(parentSessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
			});
			try {
				const actions = snapshot.getEntries().flatMap(entry => {
					if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return [];
					const data = entry.data as Record<string, unknown>;
					return data.id === options.id && typeof data.action === "string" ? [data.action] : [];
				});
				expect(actions).toEqual(["spawn", "turn-started"]);
			} finally {
				await snapshot.close();
			}
			const childSessionFile = await persistWorkerSession({
				cwd: options.cwd,
				artifactsDir,
				id: options.id,
				task: options.task,
			});
			const worker = createFakeWorkerSession();
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: options.parentAgentId ?? "Main",
				session: worker.session,
				sessionFile: childSessionFile,
				status: "running",
			});
			AgentRegistry.global().setStatus(options.id, "idle");
			AgentLifecycleManager.global().adopt(options.id, {
				idleTtlMs: 0,
				revive: async () => worker.session,
			});
			return makeResult(options.id, { output: "Persisted first turn." });
		});
	}

	function installPersistedReviver(capture: { sessionFile?: string; prompts?: string[] }): void {
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async ref => {
			if (!ref.sessionFile) return undefined;
			const persisted = await SessionManager.peekSessionInit(ref.sessionFile);
			if (!persisted?.init) return undefined;
			const worker = createFakeWorkerSession();
			worker.prompts.push(persisted.init.task);
			worker.setScript({
				events: yieldTurnEvents({ report: RESTORED_VIBE_RESPONSE }),
				responseText: RESTORED_VIBE_RESPONSE,
			});
			capture.sessionFile = ref.sessionFile;
			capture.prompts = worker.prompts;
			return async () => worker.session;
		}, 0);
	}

	async function simulateProcessBoundary(): Promise<void> {
		await AgentLifecycleManager.global().dispose();
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		for (const manager of persistedManagers.splice(0)) {
			await manager.close();
		}
		for (const root of tempRoots.splice(0)) {
			await fs.rm(root, { recursive: true, force: true });
		}
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("spawn returns immediately and self-delivers a turn result with activity trace + response", async () => {
		const gate = deferred();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			options.onProgress?.(
				progressSnapshot(options.id, {
					toolCount: 2,
					recentTools: [
						{ tool: "bash", args: "bun test", endMs: 2 },
						{ tool: "read", args: "src/foo.ts", endMs: 1 },
					],
					lastIntent: "Running tests",
					resolvedModel: "prov/fast-model",
				}),
			);
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id, { output: "Implemented the widget.", requests: 3 });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();

		const { id, jobId } = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "Build the widget." });
		expect(id).toBe("Fast");

		// Ack is immediate: the job is still running behind the gate.
		const job = manager.getJob(jobId)!;
		expect(job.status).toBe("running");
		expect(registry.screens(session)[0]?.cli).toBe("fast");

		gate.resolve();
		await job.promise;

		expect(job.status).toBe("completed");
		const text = job.resultText ?? "";
		// Envelope + summarized activity (compressed tool trace, oldest first) + response.
		expect(text).toContain('<vibe-turn session="Fast" cli="fast" turn="1" status="completed"');
		expect(text).toContain('model="prov/fast-model"');
		expect(text.indexOf("read(src/foo.ts)")).toBeGreaterThan(-1);
		expect(text.indexOf("read(src/foo.ts)")).toBeLessThan(text.indexOf("bash(bun test)"));
		expect(text).toContain("Implemented the widget.");
		// Session survives the turn, addressable for follow-ups.
		const entry = registry.screens(session)[0]!;
		expect(entry.state).toBe("idle");
		expect(entry.turns).toBe(1);
	});

	it("retains a failed spawn when its tombstone cannot flush and retries it on mode exit", async () => {
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const originalFlush = parentManager.flush.bind(parentManager);
		const flush = vi
			.spyOn(parentManager, "flush")
			.mockImplementationOnce(originalFlush)
			.mockRejectedValueOnce(new Error("tombstone write failed"));
		const register = vi.spyOn(jobs, "register").mockImplementation(() => {
			throw new Error("job registry failed");
		});

		await expect(
			VibeSessionRegistry.global().spawn(session, {
				cli: "fast",
				name: "failed-spawn",
				prompt: INITIAL_VIBE_TASK,
			}),
		).rejects.toThrow("tombstone write failed");

		expect(VibeSessionRegistry.global().screens(session)[0]).toMatchObject({
			id: "failed-spawn",
			state: "dead",
			lastActivity: "spawn failed",
		});
		expect(parentManager.buildSessionContext().mode).toBe("vibe");
		flush.mockRestore();
		register.mockRestore();
		expect(await VibeSessionRegistry.global().killAll(session)).toBe(1);
		expect(VibeSessionRegistry.global().listIds(session)).toEqual([]);
		expect(parentManager.buildSessionContext().mode).toBe("none");
	});

	it("send steers a streaming mid-turn worker and queues for a non-steerable one", async () => {
		const gate = deferred();
		const fake = createFakeWorkerSession({ streaming: true });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: fake.session,
				status: "running",
			});
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id);
		});
		const followUps: Array<{ id: string; message: string }> = [];
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUps.push({ id: options.id, message: options.message });
			return makeResult(options.id, { output: "queued work done" });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(session, { cli: "good", name: "Good", prompt: "Design it." });
		await pollUntil(() => AgentRegistry.global().get("Good") !== undefined);

		// Streaming worker → steering.
		const steered = await registry.send(session, { session: "Good", message: "Focus on the API first." });
		expect(steered.mode).toBe("steered");
		expect(fake.steers).toEqual(["Focus on the API first."]);

		// Not streaming → queued for the next turn.
		fake.setStreaming(false);
		const queued = await registry.send(session, { session: "Good", message: "Then write tests." });
		expect(queued.mode).toBe("queued");
		expect(registry.screens(session)[0]?.queued).toBe(1);

		// Settling the turn drains the queue into an automatic follow-up turn.
		gate.resolve();
		await manager.getJob(jobId)!.promise;
		await pollUntil(() => followUps.length === 1);
		expect(followUps[0]).toEqual({ id: "Good", message: "Then write tests." });
	});

	it("send to an idle session starts a follow-up turn on the same worker", async () => {
		const gate = deferred();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id);
		});
		const followUps: Array<{ id: string; message: string }> = [];
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUps.push({ id: options.id, message: options.message });
			options.onProgress?.(
				progressSnapshot(options.id, {
					toolCount: 1,
					recentTools: [{ tool: "edit", args: "src/foo.ts", endMs: 1 }],
				}),
			);
			return makeResult(options.id, { output: "Renamed everything." });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const spawn = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "First task." });
		gate.resolve();
		await manager.getJob(spawn.jobId)!.promise;

		const outcome = await registry.send(session, { session: "Fast", message: "Now rename the helpers." });
		expect(outcome.mode).toBe("turn");
		const turnJob = manager.getJob(outcome.jobId!)!;
		await turnJob.promise;

		expect(followUps).toEqual([{ id: "Fast", message: "Now rename the helpers." }]);
		const text = turnJob.resultText ?? "";
		expect(text).toContain('turn="2"');
		expect(text).toContain("edit(src/foo.ts)");
		expect(text).toContain("Renamed everything.");
		expect(registry.screens(session)[0]?.turns).toBe(2);
	});

	it("rehydrates an idle worker after a process boundary and continues turn two with prior context", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		expect(await fileExists(parentSessionFile)).toBe(false);
		const firstManager = createManager();
		const firstSession = createSession({ manager: firstManager, sessionManager: parentManager });
		const firstRegistry = VibeSessionRegistry.global();
		const spawned = await firstRegistry.spawn(firstSession, {
			cli: "fast",
			name: "push-fixes",
			prompt: INITIAL_VIBE_TASK,
		});
		expect(await fileExists(parentSessionFile)).toBe(true);
		await firstManager.getJob(spawned.jobId)!.promise;
		expect(firstRegistry.screens(firstSession)[0]).toMatchObject({ id: "push-fixes", state: "idle", turns: 1 });

		const wrongOwner = createSession({ manager: firstManager, sessionManager: parentManager, ownerId: "Other" });
		await expect(
			firstRegistry.send(wrongOwner, { session: "push-fixes", message: FOLLOW_UP_VIBE_TASK }),
		).rejects.toThrow('Unknown vibe session "push-fixes"');
		const wrongParent = createSession({
			manager: firstManager,
			sessionManager: parentManager,
			parentSessionId: "different-parent",
		});
		await expect(
			firstRegistry.send(wrongParent, { session: "push-fixes", message: FOLLOW_UP_VIBE_TASK }),
		).rejects.toThrow('Unknown vibe session "push-fixes"');

		await parentManager.flush();
		await parentManager.close();
		await simulateProcessBoundary();
		const resumedManager = await SessionManager.open(parentSessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		persistedManagers.push(resumedManager);
		const resumedJobs = createManager();
		const resumedSession = createSession({ manager: resumedJobs, sessionManager: resumedManager });
		const revived: { sessionFile?: string; prompts?: string[] } = {};
		installPersistedReviver(revived);

		const resumedRegistry = VibeSessionRegistry.global();
		expect(await resumedRegistry.rehydrate(resumedSession)).toBe(1);
		expect(AgentRegistry.global().get("push-fixes")?.status).toBe("parked");
		expect(resumedRegistry.screens(resumedSession)[0]).toMatchObject({
			id: "push-fixes",
			state: "idle",
			turns: 1,
		});

		const outcome = await resumedRegistry.send(resumedSession, {
			session: "push-fixes",
			message: FOLLOW_UP_VIBE_TASK,
		});
		expect(outcome.mode).toBe("turn");
		const turnJob = resumedJobs.getJob(outcome.jobId!)!;
		await turnJob.promise;
		expect(revived.sessionFile).toBe(path.join(parentSessionFile.slice(0, -6), "push-fixes.jsonl"));
		expect(revived.prompts).toEqual([INITIAL_VIBE_TASK, FOLLOW_UP_VIBE_TASK]);
		expect(turnJob.resultText).toContain('turn="2"');
		expect(turnJob.resultText).toContain(RESTORED_VIBE_RESPONSE);
	});

	it("suspends an idle persisted worker for same-process disposal and resumes turn two", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const firstJobs = createManager();
		const firstSession = createSession({ manager: firstJobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(firstSession, {
			cli: "fast",
			name: "idle-dispose",
			prompt: INITIAL_VIBE_TASK,
		});
		await firstJobs.getJob(spawned.jobId)!.promise;
		expect(await registry.suspendScope(registry.ownerScope(firstSession), firstJobs)).toBe(1);
		expect(AgentRegistry.global().get("idle-dispose")).toBeUndefined();
		expect(
			parentManager.getEntries().some(entry => {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
				return (entry.data as Record<string, unknown>).action === "tombstone";
			}),
		).toBe(false);
		await parentManager.close();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedJobs = createManager();
		const resumedSession = createSession({ manager: resumedJobs, sessionManager: reopened });
		const revived: { sessionFile?: string; prompts?: string[] } = {};
		installPersistedReviver(revived);
		expect(await registry.rehydrate(resumedSession)).toBe(1);
		const outcome = await registry.send(resumedSession, {
			session: "idle-dispose",
			message: FOLLOW_UP_VIBE_TASK,
		});
		const turnJob = resumedJobs.getJob(outcome.jobId!)!;
		await turnJob.promise;
		expect(revived.prompts).toEqual([INITIAL_VIBE_TASK, FOLLOW_UP_VIBE_TASK]);
		expect(turnJob.resultText).toContain('turn="2"');
	});

	it("suspends a blocked in-flight worker for fresh-process disposal without tombstoning it", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const artifactsDir = options.artifactsDir;
			if (!artifactsDir) throw new Error("Persisted vibe test requires an artifacts directory");
			const childSessionFile = await persistWorkerSession({
				cwd: options.cwd,
				artifactsDir,
				id: options.id,
				task: options.task,
			});
			const worker = createFakeWorkerSession();
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: options.parentAgentId ?? "Main",
				session: worker.session,
				sessionFile: childSessionFile,
				status: "running",
			});
			const signal = options.signal;
			if (!signal) throw new Error("Persisted blocked worker requires a cancellation signal");
			await new Promise<void>(resolve => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return makeResult(options.id, { output: "Interrupted by disposal.", aborted: true });
		});
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const firstJobs = createManager();
		const firstSession = createSession({ manager: firstJobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		await registry.spawn(firstSession, {
			cli: "fast",
			name: "running-dispose",
			prompt: INITIAL_VIBE_TASK,
		});
		await pollUntil(() => AgentRegistry.global().get("running-dispose")?.status === "running");
		expect(await registry.suspendScope(registry.ownerScope(firstSession), firstJobs)).toBe(1);
		expect(
			parentManager.getEntries().some(entry => {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
				return (entry.data as Record<string, unknown>).action === "tombstone";
			}),
		).toBe(false);
		await parentManager.close();
		await simulateProcessBoundary();

		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedJobs = createManager();
		const resumedSession = createSession({ manager: resumedJobs, sessionManager: reopened });
		const revived: { sessionFile?: string; prompts?: string[] } = {};
		installPersistedReviver(revived);
		const freshRegistry = VibeSessionRegistry.global();
		expect(await freshRegistry.rehydrate(resumedSession)).toBe(1);
		expect(freshRegistry.screens(resumedSession)[0]).toMatchObject({
			id: "running-dispose",
			state: "idle",
			turns: 1,
			lastActivity: "turn 1 interrupted by process restart",
		});
		const outcome = await freshRegistry.send(resumedSession, {
			session: "running-dispose",
			message: FOLLOW_UP_VIBE_TASK,
		});
		const turnJob = resumedJobs.getJob(outcome.jobId!)!;
		await turnJob.promise;
		expect(revived.prompts).toEqual([INITIAL_VIBE_TASK, FOLLOW_UP_VIBE_TASK]);
		expect(turnJob.resultText).toContain('turn="2"');
	});

	it("bounds parent-session suspension when a cancelled turn ignores abort and settles late", async () => {
		const gate = deferred();
		const started = deferred();
		const disposed = deferred();
		const fake = createFakeWorkerSession({ onDispose: disposed.resolve });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: fake.session,
				status: "running",
			});
			started.resolve();
			await gate.promise;
			return makeResult(options.id);
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(session, {
			cli: "fast",
			name: "IgnoresSuspendAbort",
			prompt: "Keep working through a parent-session switch.",
		});
		await started.promise;

		vi.useFakeTimers();
		try {
			const suspension = registry.suspendScope(registry.ownerScope(session), manager);
			await disposed.promise;
			await flushMicrotasks();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			vi.advanceTimersByTime(250);

			expect(await suspension).toBe(1);
			expect(manager.getJob(jobId)!.status).toBe("cancelled");
			expect(fake.isDisposed()).toBe(true);
			expect(AgentRegistry.global().get("IgnoresSuspendAbort")).toBeUndefined();
			expect(registry.listIds(session)).toEqual([]);

			gate.resolve();
			await manager.getJob(jobId)!.promise;
			expect(manager.getJob(jobId)!.status).toBe("cancelled");
			expect(fake.isDisposed()).toBe(true);
			expect(AgentRegistry.global().get("IgnoresSuspendAbort")).toBeUndefined();
			expect(registry.listIds(session)).toEqual([]);
		} finally {
			gate.resolve();
			vi.useRealTimers();
		}
	});

	it("restores an interrupted turn as idle without replay and continues only after send", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const firstJobs = createManager();
		const firstSession = createSession({ manager: firstJobs, sessionManager: parentManager });
		const spawned = await VibeSessionRegistry.global().spawn(firstSession, {
			cli: "fast",
			name: "interrupted",
			prompt: INITIAL_VIBE_TASK,
		});
		await firstJobs.getJob(spawned.jobId)!.promise;
		const turnStarted = parentManager.getEntries().find(entry => {
			if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
			const data = entry.data as Record<string, unknown>;
			return data.id === "interrupted" && data.action === "turn-started";
		});
		if (!turnStarted) throw new Error("Expected a persisted turn-started lifecycle event");
		parentManager.branch(turnStarted.id);
		parentManager.appendModeChange("vibe");
		await parentManager.flush();
		await parentManager.close();
		await simulateProcessBoundary();

		const resumedManager = await SessionManager.open(parentSessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		persistedManagers.push(resumedManager);
		const resumedJobs = createManager();
		const resumedSession = createSession({ manager: resumedJobs, sessionManager: resumedManager });
		const revived: { sessionFile?: string; prompts?: string[] } = {};
		installPersistedReviver(revived);
		const registry = VibeSessionRegistry.global();
		expect(await registry.rehydrate(resumedSession)).toBe(1);
		expect(registry.screens(resumedSession)[0]).toMatchObject({
			id: "interrupted",
			state: "idle",
			turns: 1,
			lastActivity: "turn 1 interrupted by process restart",
		});
		expect(revived).toEqual({});

		const outcome = await registry.send(resumedSession, {
			session: "interrupted",
			message: FOLLOW_UP_VIBE_TASK,
		});
		const turnJob = resumedJobs.getJob(outcome.jobId!)!;
		await turnJob.promise;
		expect(revived.prompts).toEqual([INITIAL_VIBE_TASK, FOLLOW_UP_VIBE_TASK]);
		expect(turnJob.resultText).toContain('turn="2"');
	});

	it("never lets an old lifecycle append cross into a target session during its load window", async () => {
		installPersistedSpawnMock();
		const storage = new SwitchGatedSessionStorage();
		const sourceManager = await createPersistedParent(storage);
		sourceManager.appendModeChange("vibe");
		const sourceSessionId = sourceManager.getSessionId();
		const sourceSessionFile = sourceManager.getSessionFile();
		if (!sourceSessionFile) throw new Error("Persisted source session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: sourceManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "switch-race",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;

		const targetManager = await createPersistedParent(storage);
		targetManager.appendModeChange("goal");
		targetManager.appendCustomEntry("target-only");
		await targetManager.ensureOnDisk();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Persisted target session file was not created");
		await targetManager.close();

		const lifecycleAppendStarted = Promise.withResolvers<void>();
		const releaseLifecycleAppend = Promise.withResolvers<void>();
		const originalEnsureOnDisk = sourceManager.ensureOnDisk.bind(sourceManager);
		let gateLifecycleAppend = true;
		const ensureOnDisk = vi.spyOn(sourceManager, "ensureOnDisk").mockImplementation(async () => {
			if (gateLifecycleAppend) {
				gateLifecycleAppend = false;
				lifecycleAppendStarted.resolve();
				await releaseLifecycleAppend.promise;
			}
			await originalEnsureOnDisk();
		});
		const followUp = await registry.send(session, {
			session: "switch-race",
			message: FOLLOW_UP_VIBE_TASK,
		});
		const turnJob = jobs.getJob(followUp.jobId!)!;
		await lifecycleAppendStarted.promise;

		const targetRead = storage.gateNextRead(targetSessionFile);
		const switching = sourceManager.setSessionFile(targetSessionFile);
		await targetRead.started;
		releaseLifecycleAppend.resolve();
		await turnJob.promise.catch(() => undefined);
		targetRead.release();
		await switching;
		ensureOnDisk.mockRestore();

		expect(turnJob.status).toBe("failed");
		expect(sourceManager.buildSessionContext().mode).toBe("goal");
		expect(
			sourceManager
				.getBranch()
				.map(entry =>
					entry.type === "mode_change"
						? `mode:${entry.mode}`
						: `custom:${entry.type === "custom" ? entry.customType : entry.type}`,
				),
		).toEqual(["mode:goal", "custom:target-only"]);
		expect(
			sourceManager.getEntries().some(entry => {
				if (entry.type !== "custom" || entry.customType !== "vibe-session-lifecycle") return false;
				if (typeof entry.data !== "object" || entry.data === null) return false;
				return (entry.data as Record<string, unknown>).parentSessionId === sourceSessionId;
			}),
		).toBe(false);
		expect(await fs.readFile(targetSessionFile, "utf8")).not.toContain(sourceSessionId);
	});

	it("never sends through or releases a registry ref with the wrong child session file", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "exact-ref",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;
		await AgentLifecycleManager.global().release("exact-ref");
		const mismatchedFile = path.join(parentSessionFile.slice(0, -6), "another-parent.jsonl");
		AgentRegistry.global().register({
			id: "exact-ref",
			displayName: "exact-ref",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: mismatchedFile,
			status: "parked",
		});

		await expect(registry.send(session, { session: "exact-ref", message: FOLLOW_UP_VIBE_TASK })).rejects.toThrow(
			"no longer resolves to this parent session",
		);
		await registry.kill(session, "exact-ref");
		expect(AgentRegistry.global().get("exact-ref")).toMatchObject({
			status: "parked",
			sessionFile: mismatchedFile,
		});
	});

	it("suspends a parent without tombstones so the same worker id can move between isolated scopes", async () => {
		installPersistedSpawnMock();
		const parentA = await createPersistedParent();
		const parentB = await createPersistedParent();
		parentA.appendModeChange("vibe");
		parentB.appendModeChange("vibe");
		const jobsA = createManager();
		const jobsB = createManager();
		const sessionA = createSession({ manager: jobsA, sessionManager: parentA });
		const sessionB = createSession({ manager: jobsB, sessionManager: parentB });
		const registry = VibeSessionRegistry.global();
		const workerA = await registry.spawn(sessionA, {
			cli: "fast",
			name: "shared-name",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobsA.getJob(workerA.jobId)!.promise;
		expect(await registry.suspendScope(registry.ownerScope(sessionA), jobsA)).toBe(1);
		expect(AgentRegistry.global().get("shared-name")).toBeUndefined();

		const workerB = await registry.spawn(sessionB, {
			cli: "fast",
			name: "shared-name",
			prompt: INITIAL_VIBE_TASK,
		});
		expect(workerB.id).toBe("shared-name");
		await jobsB.getJob(workerB.jobId)!.promise;
		expect(await registry.suspendScope(registry.ownerScope(sessionB), jobsB)).toBe(1);
		const revived: { sessionFile?: string; prompts?: string[] } = {};
		installPersistedReviver(revived);
		expect(await registry.rehydrate(sessionA)).toBe(1);
		expect(registry.listIds(sessionA)).toEqual(["shared-name"]);
		await expect(registry.send(sessionB, { session: "shared-name", message: FOLLOW_UP_VIBE_TASK })).rejects.toThrow(
			'Unknown vibe session "shared-name"',
		);

		const outcome = await registry.send(sessionA, {
			session: "shared-name",
			message: FOLLOW_UP_VIBE_TASK,
		});
		await jobsA.getJob(outcome.jobId!)!.promise;
		expect(revived.prompts).toEqual([INITIAL_VIBE_TASK, FOLLOW_UP_VIBE_TASK]);
	});

	it("does not let late teardown from a suspended parent mutate a new same-id worker", async () => {
		const parentA = await createPersistedParent();
		const parentB = await createPersistedParent();
		parentA.appendModeChange("vibe");
		parentB.appendModeChange("vibe");
		const parentAFile = parentA.getSessionFile();
		if (!parentAFile) throw new Error("Persisted parent A session file was not created");
		let workerA: ReturnType<typeof createFakeWorkerSession> | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const artifactsDir = options.artifactsDir;
			if (!artifactsDir) throw new Error("Persisted vibe test requires an artifacts directory");
			const childSessionFile = await persistWorkerSession({
				cwd: options.cwd,
				artifactsDir,
				id: options.id,
				task: options.task,
			});
			const worker = createFakeWorkerSession();
			if (options.sessionFile === parentAFile) workerA = worker;
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: options.parentAgentId ?? "Main",
				session: worker.session,
				sessionFile: childSessionFile,
				status: "running",
			});
			if (options.sessionFile === parentAFile) {
				const signal = options.signal;
				if (!signal) throw new Error("Persisted blocked worker requires a cancellation signal");
				await new Promise<void>(resolve => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return makeResult(options.id, { output: "Parent A suspended.", aborted: true });
			}
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id, { output: "Parent B finished." });
		});
		const jobsA = createManager();
		const jobsB = createManager();
		const sessionA = createSession({ manager: jobsA, sessionManager: parentA });
		const sessionB = createSession({ manager: jobsB, sessionManager: parentB });
		const registry = VibeSessionRegistry.global();
		await registry.spawn(sessionA, { cli: "fast", name: "reused", prompt: INITIAL_VIBE_TASK });
		await pollUntil(() => workerA !== undefined);
		const oldRef = AgentRegistry.global().get("reused");
		if (!oldRef) throw new Error("Expected parent A worker ref");
		expect(await registry.suspendScope(registry.ownerScope(sessionA), jobsA)).toBe(1);

		const second = await registry.spawn(sessionB, { cli: "fast", name: "reused", prompt: INITIAL_VIBE_TASK });
		await jobsB.getJob(second.jobId)!.promise;
		const replacement = AgentRegistry.global().get("reused");
		expect(replacement).toMatchObject({ status: "idle" });
		expect(replacement).not.toBe(oldRef);

		await executorModule.finalizeSubagentLifecycle({
			id: "reused",
			session: workerA!.session,
			aborted: true,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
		});
		await AgentLifecycleManager.global().release("reused", oldRef);
		expect(AgentRegistry.global().get("reused")).toBe(replacement);
		expect(registry.screens(sessionB)[0]).toMatchObject({ id: "reused", state: "idle" });
	});

	it("rejects escaped child paths and JSONL files without persisted worker init", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const spawned = await VibeSessionRegistry.global().spawn(session, {
			cli: "fast",
			name: "valid-worker",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;

		const lifecycleEntries = parentManager.getEntries().filter(entry => {
			if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
			return (entry.data as Record<string, unknown>).id === "valid-worker";
		});
		if (lifecycleEntries.length < 3) throw new Error("Expected complete persisted worker lifecycle events");
		const artifactsDir = parentSessionFile.slice(0, -6);
		const invalidManager = SessionManager.create(parentManager.getCwd(), artifactsDir);
		persistedManagers.push(invalidManager);
		await invalidManager.ensureOnDisk();
		const invalidSource = invalidManager.getSessionFile();
		if (!invalidSource) throw new Error("Expected an invalid child fixture path");
		await invalidManager.close();
		await fs.rename(invalidSource, path.join(artifactsDir, "invalid-init.jsonl"));

		for (const { id, childSessionFile } of [
			{ id: "escaped", childSessionFile: "../escaped.jsonl" },
			{ id: "invalid-init", childSessionFile: "invalid-init.jsonl" },
		]) {
			for (const entry of lifecycleEntries) {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) continue;
				const data: Record<string, unknown> = { ...(entry.data as Record<string, unknown>), id };
				if (data.action === "spawn") data.childSessionFile = childSessionFile;
				parentManager.appendCustomEntry(entry.customType, data);
			}
		}
		await parentManager.flush();
		await parentManager.close();
		await simulateProcessBoundary();

		const resumedManager = await SessionManager.open(parentSessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		persistedManagers.push(resumedManager);
		const resumedSession = createSession({ manager: createManager(), sessionManager: resumedManager });
		const registry = VibeSessionRegistry.global();
		expect(await registry.rehydrate(resumedSession)).toBe(1);
		expect(registry.listIds(resumedSession)).toEqual(["valid-worker"]);
		expect(AgentRegistry.global().get("escaped")).toBeUndefined();
		expect(AgentRegistry.global().get("invalid-init")).toBeUndefined();
	});

	it("reserves orphan JSONL and lifecycle-known ids before allocating a worker name", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const artifactsDir = parentSessionFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });
		await fs.writeFile(path.join(artifactsDir, "orphan.jsonl"), "orphaned transcript");
		const firstJobs = createManager();
		const firstSession = createSession({ manager: firstJobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const orphanCollision = await registry.spawn(firstSession, {
			cli: "fast",
			name: "orphan",
			prompt: INITIAL_VIBE_TASK,
		});
		expect(orphanCollision.id).toBe("orphan-2");
		await firstJobs.getJob(orphanCollision.jobId)!.promise;

		const metadataOnly = await registry.spawn(firstSession, {
			cli: "fast",
			name: "metadata-only",
			prompt: INITIAL_VIBE_TASK,
		});
		await firstJobs.getJob(metadataOnly.jobId)!.promise;
		await registry.kill(firstSession, metadataOnly.id);
		await fs.rm(path.join(artifactsDir, "metadata-only.jsonl"), { force: true });
		await simulateProcessBoundary();

		const resumedJobs = createManager();
		const resumedSession = createSession({ manager: resumedJobs, sessionManager: parentManager });
		const metadataCollision = await VibeSessionRegistry.global().spawn(resumedSession, {
			cli: "fast",
			name: "metadata-only",
			prompt: INITIAL_VIBE_TASK,
		});
		expect(metadataCollision.id).toBe("metadata-only-2");
		await resumedJobs.getJob(metadataCollision.jobId)!.promise;
	});

	it("retains a cold candidate blocked by another parent id collision so mode exit can tombstone it", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "collision",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;
		await registry.suspendScope(registry.ownerScope(session), jobs);
		const otherWorker = createFakeWorkerSession();
		const otherSessionFile = path.join(path.dirname(parentSessionFile), "other-parent", "collision.jsonl");
		const otherRef = AgentRegistry.global().register({
			id: "collision",
			displayName: "collision",
			kind: "sub",
			parentId: "Main",
			session: otherWorker.session,
			sessionFile: otherSessionFile,
			status: "idle",
		});

		expect(await registry.rehydrate(session)).toBe(1);
		expect(registry.screens(session)[0]?.lastActivity).toBe("blocked by an agent id collision");
		expect(await registry.killAll(session)).toBe(1);
		expect(AgentRegistry.global().get("collision")).toBe(otherRef);
		expect(otherWorker.isDisposed()).toBe(false);
		expect(
			parentManager.getEntries().some(entry => {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
				const data = entry.data as Record<string, unknown>;
				return data.id === "collision" && data.action === "tombstone";
			}),
		).toBe(true);

		AgentRegistry.global().unregister("collision", otherRef);
		await parentManager.close();
		await simulateProcessBoundary();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedSession = createSession({ manager: createManager(), sessionManager: reopened });
		expect(await VibeSessionRegistry.global().rehydrate(resumedSession)).toBe(0);
		expect(AgentRegistry.global().get("collision")).toMatchObject({ status: "aborted", session: null });
	});

	it("rejects a spawn queued behind mode exit and leaves no live or untombstoned worker", async () => {
		const storage = new FaultInjectingSessionStorage();
		const parentManager = await createPersistedParent(storage);
		parentManager.appendModeChange("vibe");
		await parentManager.ensureOnDisk();
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const exitWriteStarted = Promise.withResolvers<void>();
		const releaseExitWrite = Promise.withResolvers<void>();
		storage.atomicWriteHooks.push(async commit => {
			exitWriteStarted.resolve();
			await releaseExitWrite.promise;
			await commit();
		});

		const exiting = registry.killAll(session);
		await exitWriteStarted.promise;
		let spawnSettled = false;
		const lateSpawn = registry
			.spawn(session, { cli: "fast", name: "late-after-exit", prompt: INITIAL_VIBE_TASK })
			.then(
				() => ({ error: undefined }),
				error => ({ error }),
			)
			.finally(() => {
				spawnSettled = true;
			});
		await flushMicrotasks();
		expect(spawnSettled).toBe(false);

		releaseExitWrite.resolve();
		expect(await exiting).toBe(0);
		const { error } = await lateSpawn;
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("Vibe mode has exited");
		expect(registry.listIds(session)).toEqual([]);
		expect(AgentRegistry.global().get("late-after-exit")).toBeUndefined();
		expect(parentManager.buildSessionContext().mode).toBe("none");
		expect(
			parentManager.getEntries().some(entry => {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
				const data = entry.data as Record<string, unknown>;
				return data.id === "late-after-exit" && data.action === "spawn";
			}),
		).toBe(false);
	});

	it("keeps mode and workers live after a real atomic mode-exit failure, then retries cleanly", async () => {
		installPersistedSpawnMock();
		const storage = new FaultInjectingSessionStorage();
		const parentManager = await createPersistedParent(storage);
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const first = await registry.spawn(session, {
			cli: "fast",
			name: "retry-exit-one",
			prompt: INITIAL_VIBE_TASK,
		});
		const second = await registry.spawn(session, {
			cli: "good",
			name: "retry-exit-two",
			prompt: INITIAL_VIBE_TASK,
		});
		await Promise.all([jobs.getJob(first.jobId)!.promise, jobs.getJob(second.jobId)!.promise]);
		const firstRef = AgentRegistry.global().get("retry-exit-one");
		const secondRef = AgentRegistry.global().get("retry-exit-two");
		if (!firstRef || !secondRef) throw new Error("Expected both live worker refs");
		await parentManager.flush();
		const beforeBytes = await fs.readFile(parentSessionFile);
		const beforeSize = (await fs.stat(parentSessionFile)).size;
		storage.atomicWriteHooks.push(async () => {
			throw Object.assign(new Error("atomic publish unavailable"), { code: "ENOSPC" });
		});

		await expect(registry.killAll(session)).rejects.toThrow("atomic publish unavailable");

		expect((await fs.stat(parentSessionFile)).size).toBe(beforeSize);
		expect(await fs.readFile(parentSessionFile)).toEqual(beforeBytes);
		expect(registry.screens(session).map(screen => [screen.id, screen.state])).toEqual([
			["retry-exit-one", "idle"],
			["retry-exit-two", "idle"],
		]);
		expect(AgentRegistry.global().get("retry-exit-one")?.status).toBe("idle");
		expect(AgentRegistry.global().get("retry-exit-two")?.status).toBe("idle");
		expect(parentManager.buildSessionContext().mode).toBe("vibe");
		const failedExitActions = parentManager.getEntries().flatMap(entry => {
			if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return [];
			const data = entry.data as Record<string, unknown>;
			return typeof data.id === "string" && data.id.startsWith("retry-exit-") && data.action === "tombstone"
				? [data.action]
				: [];
		});
		expect(failedExitActions).toEqual([]);

		VibeSessionRegistry.resetGlobalForTests();
		const reloadedRegistry = VibeSessionRegistry.global();
		expect(await reloadedRegistry.rehydrate(session)).toBe(2);
		expect(reloadedRegistry.listIds(session)).toEqual(["retry-exit-one", "retry-exit-two"]);
		expect(AgentRegistry.global().get("retry-exit-one")).toBe(firstRef);
		expect(AgentRegistry.global().get("retry-exit-two")).toBe(secondRef);

		expect(await reloadedRegistry.killAll(session)).toBe(2);
		expect(reloadedRegistry.listIds(session)).toEqual([]);
		expect(AgentRegistry.global().get("retry-exit-one")?.status).toBe("aborted");
		expect(AgentRegistry.global().get("retry-exit-two")?.status).toBe("aborted");
		expect(parentManager.buildSessionContext().mode).toBe("none");

		await parentManager.close();
		await simulateProcessBoundary();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedSession = createSession({ manager: createManager(), sessionManager: reopened });
		expect(reopened.buildSessionContext().mode).toBe("none");
		expect(await VibeSessionRegistry.global().rehydrate(resumedSession)).toBe(0);
		expect(AgentRegistry.global().get("retry-exit-one")).toMatchObject({ status: "aborted", session: null });
		expect(AgentRegistry.global().get("retry-exit-two")).toMatchObject({ status: "aborted", session: null });
	});

	it("fail-closes workers when mode-exit rollback durability is indeterminate", async () => {
		installPersistedSpawnMock();
		const storage = new FaultInjectingSessionStorage();
		const parentManager = await createPersistedParent(storage);
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "indeterminate-exit",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;
		storage.atomicWriteHooks.push(
			async commit => {
				await commit();
				throw new Error("mode exit committed but acknowledgement failed");
			},
			async () => {
				throw new Error("authoritative rollback publish failed");
			},
		);

		const failure = await registry.killAll(session).catch(error => error);

		expect(failure).toBeInstanceOf(SessionPersistenceIndeterminateError);
		expect(registry.listIds(session)).toEqual([]);
		expect(AgentRegistry.global().get("indeterminate-exit")).toMatchObject({ status: "aborted", session: null });
		expect(parentManager.buildSessionContext().mode).toBe("vibe");
		const durableText = await fs.readFile(parentSessionFile, "utf8");
		expect(durableText).toContain('"reason":"mode-exit"');
		expect(durableText).toContain('"mode":"none"');

		await parentManager.recoverPersistenceFromCurrentState();
		expect(await registry.killAll(session)).toBe(1);
		expect(parentManager.buildSessionContext().mode).toBe("none");
	});

	it("tears down and repairs a partial writer failure while persisting an explicit tombstone", async () => {
		installPersistedSpawnMock();
		const storage = new FaultInjectingSessionStorage();
		const parentManager = await createPersistedParent(storage);
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "explicit-io-failure",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;
		const liveRef = AgentRegistry.global().get("explicit-io-failure");
		if (!liveRef?.session) throw new Error("Expected a live worker ref");
		const dispose = vi.spyOn(liveRef.session, "dispose");
		await parentManager.flush();
		const beforeSize = (await fs.stat(parentSessionFile)).size;
		storage.failNextAppendWithPrefix(Object.assign(new Error("explicit tombstone ENOSPC"), { code: "ENOSPC" }), 23);

		await expect(registry.kill(session, "explicit-io-failure")).rejects.toThrow("explicit tombstone ENOSPC");

		expect(dispose).toHaveBeenCalled();
		expect(storage.failedWriterClosed).toBe(true);
		expect(registry.listIds(session)).toEqual([]);
		expect(AgentRegistry.global().get("explicit-io-failure")).toMatchObject({ status: "aborted", session: null });
		await parentManager.flush();
		expect((await fs.stat(parentSessionFile)).size).toBeGreaterThan(beforeSize);
		const repairedLines = (await fs.readFile(parentSessionFile, "utf8")).trimEnd().split("\n");
		expect(repairedLines.every(line => Boolean(JSON.parse(line)))).toBe(true);
		expect(
			parentManager.getEntries().some(entry => {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
				const data = entry.data as Record<string, unknown>;
				return data.id === "explicit-io-failure" && data.action === "tombstone" && data.reason === "explicit-kill";
			}),
		).toBe(true);

		await parentManager.close();
		await simulateProcessBoundary();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedSession = createSession({ manager: createManager(), sessionManager: reopened });
		expect(await VibeSessionRegistry.global().rehydrate(resumedSession)).toBe(0);
		expect(AgentRegistry.global().get("explicit-io-failure")).toMatchObject({ status: "aborted", session: null });
	});

	it("serializes explicit kill ahead of a failing mode exit so rollback cannot erase it", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const explicit = await registry.spawn(session, {
			cli: "fast",
			name: "overlap-explicit",
			prompt: INITIAL_VIBE_TASK,
		});
		const survivor = await registry.spawn(session, {
			cli: "good",
			name: "overlap-survivor",
			prompt: INITIAL_VIBE_TASK,
		});
		await Promise.all([jobs.getJob(explicit.jobId)!.promise, jobs.getJob(survivor.jobId)!.promise]);

		const originalFlush = parentManager.flush.bind(parentManager);
		const explicitFlushStarted = Promise.withResolvers<void>();
		const releaseExplicitFlush = Promise.withResolvers<void>();
		const explicitTeardownStarted = Promise.withResolvers<void>();
		const releaseExplicitTeardown = Promise.withResolvers<void>();
		const lifecycle = AgentLifecycleManager.global();
		const originalRelease = lifecycle.release.bind(lifecycle);
		const releaseSpy = vi.spyOn(lifecycle, "release").mockImplementation(async (id, expected) => {
			if (id === "overlap-explicit") {
				explicitTeardownStarted.resolve();
				await releaseExplicitTeardown.promise;
			}
			return originalRelease(id, expected);
		});
		let flushCalls = 0;
		const flush = vi.spyOn(parentManager, "flush").mockImplementation(async () => {
			flushCalls++;
			if (flushCalls === 1) {
				explicitFlushStarted.resolve();
				await releaseExplicitFlush.promise;
				await originalFlush();
				return;
			}
			if (flushCalls === 2) throw new Error("overlapping mode exit failed");
			await originalFlush();
		});

		const explicitKill = registry.kill(session, "overlap-explicit");
		await explicitFlushStarted.promise;
		const failedExit = registry.killAll(session).catch(error => error);
		await flushMicrotasks();
		expect(flushCalls).toBe(1);
		releaseExplicitFlush.resolve();
		await explicitTeardownStarted.promise;
		await flushMicrotasks();
		expect(flushCalls).toBe(1);
		releaseExplicitTeardown.resolve();
		expect((await explicitKill).id).toBe("overlap-explicit");
		const exitError = await failedExit;
		expect(exitError).toBeInstanceOf(Error);
		expect(String(exitError)).toContain("overlapping mode exit failed");
		expect(flushCalls).toBe(2);
		expect(parentManager.buildSessionContext().mode).toBe("vibe");
		expect(AgentRegistry.global().get("overlap-explicit")).toMatchObject({ status: "aborted", session: null });
		expect(AgentRegistry.global().get("overlap-survivor")?.status).toBe("idle");

		flush.mockRestore();
		releaseSpy.mockRestore();
		await parentManager.close();
		await simulateProcessBoundary();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedSession = createSession({ manager: createManager(), sessionManager: reopened });
		expect(await VibeSessionRegistry.global().rehydrate(resumedSession)).toBe(1);
		expect(AgentRegistry.global().get("overlap-explicit")).toMatchObject({ status: "aborted", session: null });
		expect(AgentRegistry.global().get("overlap-survivor")).toMatchObject({ status: "parked", session: null });
	});

	it("serializes overlapping mode exits so a later success cannot be revoked by an earlier failure", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "overlap-mode-exit",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;

		const originalFlush = parentManager.flush.bind(parentManager);
		const firstExitFlushStarted = Promise.withResolvers<void>();
		const releaseFirstExitFlush = Promise.withResolvers<void>();
		let flushCalls = 0;
		const flush = vi.spyOn(parentManager, "flush").mockImplementation(async () => {
			flushCalls++;
			if (flushCalls === 1) {
				firstExitFlushStarted.resolve();
				await releaseFirstExitFlush.promise;
				throw new Error("first mode exit failed");
			}
			await originalFlush();
		});

		const firstExit = registry.killAll(session).catch(error => error);
		await firstExitFlushStarted.promise;
		const successfulExit = registry.killAll(session);
		await flushMicrotasks();
		expect(flushCalls).toBe(1);
		releaseFirstExitFlush.resolve();
		const firstError = await firstExit;
		expect(firstError).toBeInstanceOf(Error);
		expect(String(firstError)).toContain("first mode exit failed");
		expect(await successfulExit).toBe(1);
		expect(flushCalls).toBe(2);
		expect(parentManager.buildSessionContext().mode).toBe("none");
		expect(registry.listIds(session)).toEqual([]);
		expect(AgentRegistry.global().get("overlap-mode-exit")).toMatchObject({ status: "aborted", session: null });
		expect(await registry.killAll(session)).toBe(0);
		expect(flushCalls).toBe(2);

		flush.mockRestore();
		await parentManager.close();
		await simulateProcessBoundary();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedSession = createSession({ manager: createManager(), sessionManager: reopened });
		expect(await VibeSessionRegistry.global().rehydrate(resumedSession)).toBe(0);
		expect(AgentRegistry.global().get("overlap-mode-exit")).toMatchObject({ status: "aborted", session: null });
	});

	it("persists mode none when re-exiting a rewound pre-exit vibe branch", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "rewound-mode-exit",
			prompt: INITIAL_VIBE_TASK,
		});
		await jobs.getJob(spawned.jobId)!.promise;
		const preExitLeaf = parentManager.getLeafId();
		if (!preExitLeaf) throw new Error("Expected a pre-exit Vibe branch leaf");

		expect(await registry.killAll(session)).toBe(1);
		expect(parentManager.buildSessionContext().mode).toBe("none");
		parentManager.branch(preExitLeaf);
		expect(parentManager.buildSessionContext().mode).toBe("vibe");
		expect(await registry.rehydrate(session)).toBe(0);
		expect(registry.listIds(session)).toEqual([]);

		expect(await registry.killAll(session)).toBe(0);
		expect(parentManager.buildSessionContext().mode).toBe("none");

		await parentManager.close();
		await simulateProcessBoundary();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		expect(reopened.buildSessionContext().mode).toBe("none");
	});

	it("does not rehydrate workers tombstoned by explicit kill or deliberate mode exit", async () => {
		installPersistedSpawnMock();
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const firstManager = createManager();
		const firstSession = createSession({ manager: firstManager, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		const explicitlyKilled = await registry.spawn(firstSession, {
			cli: "fast",
			name: "explicitly-killed",
			prompt: INITIAL_VIBE_TASK,
		});
		const modeExited = await registry.spawn(firstSession, {
			cli: "good",
			name: "mode-exited",
			prompt: INITIAL_VIBE_TASK,
		});
		await Promise.all([
			firstManager.getJob(explicitlyKilled.jobId)!.promise,
			firstManager.getJob(modeExited.jobId)!.promise,
		]);
		const preKillLeaf = parentManager.getLeafId();
		if (!preKillLeaf) throw new Error("Expected a persisted lifecycle leaf before kill");
		expect((await registry.kill(firstSession, "explicitly-killed")).cancelledTurn).toBe(false);
		parentManager.appendCustomEntry("vibe-session-lifecycle", {
			version: 1,
			action: "tombstone-revoked",
			id: "explicitly-killed",
			ownerId: "Main",
			parentSessionId: parentManager.getSessionId(),
			reason: "mode-exit",
		});
		await parentManager.flush();
		expect(await registry.killAll(firstSession)).toBe(1);
		const killedSnapshot = await SessionManager.open(parentSessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		try {
			const tombstonedIds = killedSnapshot.getEntries().flatMap(entry => {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return [];
				const data = entry.data as Record<string, unknown>;
				return data.action === "tombstone" && typeof data.id === "string" ? [data.id] : [];
			});
			expect(tombstonedIds.toSorted()).toEqual(["explicitly-killed", "mode-exited"]);
		} finally {
			await killedSnapshot.close();
		}
		parentManager.branch(preKillLeaf);

		parentManager.appendModeChange("none");
		await parentManager.flush();
		await parentManager.close();
		await simulateProcessBoundary();
		const artifactsDir = parentSessionFile.slice(0, -6);
		for (const id of ["explicitly-killed", "mode-exited"]) {
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile: path.join(artifactsDir, `${id}.jsonl`),
				status: "parked",
			});
		}
		const resumedManager = await SessionManager.open(parentSessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		persistedManagers.push(resumedManager);
		expect(resumedManager.buildSessionContext().mode).toBe("none");
		const resumedSession = createSession({ manager: createManager(), sessionManager: resumedManager });
		const resumedRegistry = VibeSessionRegistry.global();
		expect(await resumedRegistry.rehydrate(resumedSession)).toBe(0);
		expect(resumedRegistry.listIds(resumedSession)).toEqual([]);
		const explicitRef = AgentRegistry.global().get("explicitly-killed");
		const modeExitRef = AgentRegistry.global().get("mode-exited");
		expect(explicitRef).toMatchObject({ status: "aborted", session: null });
		expect(modeExitRef).toMatchObject({ status: "aborted", session: null });
		if (!explicitRef?.sessionFile || !modeExitRef?.sessionFile) {
			throw new Error("Tombstoned workers must retain readable transcript references");
		}
		expect((await SessionManager.peekSessionInit(explicitRef.sessionFile))?.init?.task).toBe(INITIAL_VIBE_TASK);
		expect((await SessionManager.peekSessionInit(modeExitRef.sessionFile))?.init?.task).toBe(INITIAL_VIBE_TASK);
		await expect(AgentLifecycleManager.global().ensureLive("explicitly-killed")).rejects.toThrow("无法恢复");
		await expect(
			resumedRegistry.send(resumedSession, { session: "explicitly-killed", message: FOLLOW_UP_VIBE_TASK }),
		).rejects.toThrow('Unknown vibe session "explicitly-killed"');
		await expect(
			resumedRegistry.send(resumedSession, { session: "mode-exited", message: FOLLOW_UP_VIBE_TASK }),
		).rejects.toThrow('Unknown vibe session "mode-exited"');
	});

	it("runSubagentFollowUpTurn continues the same live session and finalizes trace + yield response", async () => {
		const fake = createFakeWorkerSession();
		AgentRegistry.global().register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: fake.session,
			status: "idle",
		});
		const agent = { name: "task", description: "worker", systemPrompt: "sp", source: "bundled" as const };

		fake.setScript({ events: yieldTurnEvents({ report: "did the first thing" }), responseText: "first summary" });
		const progressSnapshots: AgentProgress[] = [];
		const first = await executorModule.runSubagentFollowUpTurn({
			id: "Worker",
			agent,
			message: "do the first thing",
			onProgress: progress => progressSnapshots.push({ ...progress, recentTools: progress.recentTools.slice() }),
		});
		expect(first.exitCode).toBe(0);
		expect(first.output).toContain("did the first thing");
		expect(progressSnapshots.some(progress => progress.recentTools.some(entry => entry.tool === "read"))).toBe(true);

		// Second turn lands on the SAME session instance — prior context retained.
		fake.setScript({ events: yieldTurnEvents({ report: "built on prior work" }), responseText: "second summary" });
		const second = await executorModule.runSubagentFollowUpTurn({ id: "Worker", agent, message: "now extend it" });
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("built on prior work");
		expect(fake.prompts).toEqual(["do the first thing", "now extend it"]);
		expect(fake.isDisposed()).toBe(false);
	});

	it("wait wakes on the first settling turn among concurrent sessions and suppresses its re-delivery", async () => {
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			const gate = deferred();
			gates.set(options.id, gate);
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id, { output: `${options.id} finished.` });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const fast = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "Task A." });
		const good = await registry.spawn(session, { cli: "good", name: "Good", prompt: "Task B." });
		await pollUntil(() => gates.size === 2);

		const waitPromise = registry.wait(session, { sessions: ["Fast", "Good"], timeoutMs: 5000 });
		gates.get("Fast")!.resolve();
		const outcome = await waitPromise;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled.map(entry => entry.id)).toEqual(["Fast"]);
		expect(outcome.settled[0]!.resultText).toContain("Fast finished.");
		expect(outcome.stillRunning).toEqual(["Good"]);
		// The reported result must not be delivered a second time as a follow-up.
		expect(manager.isDeliverySuppressed(fast.jobId)).toBe(true);
		expect(manager.isDeliverySuppressed(good.jobId)).toBe(false);

		gates.get("Good")!.resolve();
		await manager.getJob(good.jobId)!.promise;
	});

	it("wait reports the settled turn even when a queued follow-up starts immediately", async () => {
		const firstGate = deferred();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			await firstGate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id, { output: "First turn done." });
		});
		const followUpGate = deferred();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			await followUpGate.promise;
			return makeResult(options.id, { output: "Follow-up done." });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "Task A." });
		await pollUntil(() => AgentRegistry.global().get("Fast") !== undefined);

		// Queued while mid-turn: #finishTurn starts this follow-up turn inside
		// the settling job's callback, BEFORE the watched job's promise resolves.
		const queued = await registry.send(session, { session: "Fast", message: "Task B." });
		expect(queued.mode).toBe("queued");

		const waitPromise = registry.wait(session, { sessions: ["Fast"], timeoutMs: 5000 });
		firstGate.resolve();
		const outcome = await waitPromise;

		// The settled first turn is reported (not shadowed by the new in-flight
		// turn) and acknowledged so it is not re-delivered …
		expect(outcome.settled.map(entry => entry.jobId)).toEqual([jobId]);
		expect(outcome.settled[0]!.resultText).toContain("First turn done.");
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		// … while the drained-queue follow-up shows as still running.
		expect(outcome.stillRunning).toEqual(["Fast"]);

		followUpGate.resolve();
		await manager.getJob("Fast-t2")!.promise;
	});

	it("bounds kill teardown when a cancelled turn ignores abort and settles late", async () => {
		const gate = deferred();
		const started = deferred();
		const disposed = deferred();
		const fake = createFakeWorkerSession({ onDispose: disposed.resolve });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: fake.session,
				status: "running",
			});
			started.resolve();
			await gate.promise;
			return makeResult(options.id);
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(session, {
			cli: "fast",
			name: "IgnoresKillAbort",
			prompt: "Keep working through explicit termination.",
		});
		await started.promise;

		vi.useFakeTimers();
		try {
			const kill = registry.kill(session, "IgnoresKillAbort");
			await disposed.promise;
			await flushMicrotasks();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			vi.advanceTimersByTime(250);

			const outcome = await kill;
			expect(outcome.cancelledTurn).toBe(true);
			expect(manager.getJob(jobId)!.status).toBe("cancelled");
			expect(fake.isDisposed()).toBe(true);
			expect(AgentRegistry.global().get("IgnoresKillAbort")).toBeUndefined();
			expect(registry.screens(session)[0]?.state).toBe("dead");
			await expect(registry.send(session, { session: "IgnoresKillAbort", message: "hello?" })).rejects.toThrow(
				"dead",
			);

			gate.resolve();
			await manager.getJob(jobId)!.promise;
			expect(manager.getJob(jobId)!.status).toBe("cancelled");
			expect(fake.isDisposed()).toBe(true);
			expect(AgentRegistry.global().get("IgnoresKillAbort")).toBeUndefined();
			expect(registry.screens(session)[0]?.state).toBe("dead");
			await expect(registry.send(session, { session: "IgnoresKillAbort", message: "still there?" })).rejects.toThrow(
				"dead",
			);
		} finally {
			gate.resolve();
			vi.useRealTimers();
		}
	});

	it("keeps a persisted in-flight kill terminal when the old executor finalizes late", async () => {
		let worker: ReturnType<typeof createFakeWorkerSession> | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const artifactsDir = options.artifactsDir;
			if (!artifactsDir) throw new Error("Persisted vibe test requires an artifacts directory");
			const childSessionFile = await persistWorkerSession({
				cwd: options.cwd,
				artifactsDir,
				id: options.id,
				task: options.task,
			});
			worker = createFakeWorkerSession();
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: options.parentAgentId ?? "Main",
				session: worker.session,
				sessionFile: childSessionFile,
				status: "running",
			});
			const signal = options.signal;
			if (!signal) throw new Error("Persisted blocked worker requires a cancellation signal");
			await new Promise<void>(resolve => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return makeResult(options.id, { output: "Killed during work.", aborted: true });
		});
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		await registry.spawn(session, { cli: "fast", name: "persisted-kill", prompt: "Keep working." });
		await pollUntil(() => worker !== undefined);

		expect((await registry.kill(session, "persisted-kill")).cancelledTurn).toBe(true);
		const terminal = AgentRegistry.global().get("persisted-kill");
		expect(terminal).toMatchObject({ status: "aborted", session: null });

		await executorModule.finalizeSubagentLifecycle({
			id: "persisted-kill",
			session: worker!.session,
			aborted: true,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
		});
		expect(AgentRegistry.global().get("persisted-kill")).toBe(terminal);
		expect(AgentRegistry.global().get("persisted-kill")).toMatchObject({ status: "aborted", session: null });
		await expect(AgentLifecycleManager.global().ensureLive("persisted-kill")).rejects.toThrow("无法恢复");
	});

	it("does not terminalize a same-path replacement installed while the killed worker disposes", async () => {
		let worker: ReturnType<typeof createFakeWorkerSession> | undefined;
		let replacement: ReturnType<AgentRegistry["register"]> | undefined;
		let replacementWorker: ReturnType<typeof createFakeWorkerSession> | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const artifactsDir = options.artifactsDir;
			if (!artifactsDir) throw new Error("Persisted vibe test requires an artifacts directory");
			const childSessionFile = await persistWorkerSession({
				cwd: options.cwd,
				artifactsDir,
				id: options.id,
				task: options.task,
			});
			replacementWorker = createFakeWorkerSession();
			worker = createFakeWorkerSession({
				onDispose: () => {
					replacement = AgentRegistry.global().register({
						id: options.id,
						displayName: options.id,
						kind: "sub",
						parentId: options.parentAgentId ?? "Main",
						session: replacementWorker!.session,
						sessionFile: childSessionFile,
						status: "idle",
					});
				},
			});
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: options.parentAgentId ?? "Main",
				session: worker.session,
				sessionFile: childSessionFile,
				status: "running",
			});
			const signal = options.signal;
			if (!signal) throw new Error("Persisted blocked worker requires a cancellation signal");
			await new Promise<void>(resolve => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return makeResult(options.id, { output: "Old worker killed.", aborted: true });
		});
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		await registry.spawn(session, { cli: "fast", name: "same-path-replacement", prompt: "Keep working." });
		await pollUntil(() => worker !== undefined);

		expect((await registry.kill(session, "same-path-replacement")).cancelledTurn).toBe(true);
		expect(replacement).toBeDefined();
		expect(AgentRegistry.global().get("same-path-replacement")).toBe(replacement);
		expect(replacement).toMatchObject({ status: "idle", session: replacementWorker!.session });
		expect(replacementWorker!.isDisposed()).toBe(false);
	});

	it("persists a kill issued before child initialization and terminalizes the worker if it registers late", async () => {
		// Handshake so kill() lands while the worker is mid-init, not before its
		// job body has started executing: on a loaded runner the job may not have
		// dispatched yet when spawn() returns, and kill would then observe no
		// registration at all (the mock registers only after the abort lands),
		// failing the registry assertion below. Resolving once the body is inside
		// the abort-wait keeps the test exercising exactly the late-registration
		// path it names.
		const workerStarted = deferred();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const artifactsDir = options.artifactsDir;
			if (!artifactsDir) throw new Error("Persisted vibe test requires an artifacts directory");
			const signal = options.signal;
			if (!signal) throw new Error("Pre-initialization worker requires a cancellation signal");
			workerStarted.resolve();
			await new Promise<void>(resolve => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			const childSessionFile = await persistWorkerSession({
				cwd: options.cwd,
				artifactsDir,
				id: options.id,
				task: options.task,
			});
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: options.parentAgentId ?? "Main",
				session: createFakeWorkerSession().session,
				sessionFile: childSessionFile,
				status: "idle",
			});
			return makeResult(options.id, { output: "Killed before initialization.", aborted: true });
		});
		const parentManager = await createPersistedParent();
		parentManager.appendModeChange("vibe");
		const parentSessionFile = parentManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Persisted parent session file was not created");
		const jobs = createManager();
		const session = createSession({ manager: jobs, sessionManager: parentManager });
		const registry = VibeSessionRegistry.global();
		await registry.spawn(session, { cli: "fast", name: "pre-init-kill", prompt: "Start later." });
		// Wait for the worker to be mid-init (inside the abort-wait) before
		// issuing the kill — see the handshake comment at the top of the test.
		await workerStarted.promise;

		expect((await registry.kill(session, "pre-init-kill")).cancelledTurn).toBe(true);
		expect(AgentRegistry.global().get("pre-init-kill")).toMatchObject({ status: "aborted", session: null });
		expect(
			parentManager.getEntries().some(entry => {
				if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) return false;
				const data = entry.data as Record<string, unknown>;
				return data.id === "pre-init-kill" && data.action === "tombstone";
			}),
		).toBe(true);

		await parentManager.close();
		await simulateProcessBoundary();
		const reopened = await SessionManager.open(parentSessionFile, undefined, undefined, { suppressBreadcrumb: true });
		persistedManagers.push(reopened);
		const resumedSession = createSession({ manager: createManager(), sessionManager: reopened });
		expect(await VibeSessionRegistry.global().rehydrate(resumedSession)).toBe(0);
		expect(AgentRegistry.global().get("pre-init-kill")).toMatchObject({ status: "aborted", session: null });
	});

	it("killAll terminates every session for the owner (mode-exit path)", async () => {
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			const gate = deferred();
			gates.set(options.id, gate);
			await gate.promise;
			return makeResult(options.id);
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const one = await registry.spawn(session, { cli: "fast", name: "One", prompt: "A." });
		const two = await registry.spawn(session, { cli: "good", name: "Two", prompt: "B." });
		await pollUntil(() => gates.size === 2);

		const killPromise = registry.killAll(session);
		await pollUntil(() => manager.getJob(one.jobId)?.status === "cancelled");
		gates.get("One")!.resolve();
		await pollUntil(() => manager.getJob(two.jobId)?.status === "cancelled");
		gates.get("Two")!.resolve();
		const killed = await killPromise;
		expect(killed).toBe(2);
		expect(registry.listIds(session)).toEqual([]);
		expect(AgentRegistry.global().get("One")).toBeUndefined();
		expect(AgentRegistry.global().get("Two")).toBeUndefined();
	});
});
