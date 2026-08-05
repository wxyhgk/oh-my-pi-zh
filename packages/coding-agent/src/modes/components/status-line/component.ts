import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import type { OAuthAccountIdentity } from "../../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../utils/active-repo-context";
import * as git from "../../../utils/git";
import * as jj from "../../../utils/jj";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { calculateTokensPerSecond } from "../../../utils/token-rate";
import { sanitizeStatusText } from "../../shared";
import { theme } from "../../theme/theme";
import {
	type CodexResetFireworksEvent,
	type CodexResetUsageSnapshot,
	detectCodexResetFireworks,
} from "../codex-reset-fireworks";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import { getPreset } from "./presets";
import { renderSegment, type SegmentContext } from "./segments";
import { getSeparator } from "./separators";
import type {
	CollabStatus,
	EffectiveStatusLineSettings,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "./types";

const JJ_REFRESH_TTL_MS = 5000;
const WATCHER_FAILURE_POLL_TTL_MS = 5000;

function normalizeCodexIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * Fireworks are stateful, so their report match must be stricter than the
 * status display's fallback matching: every known credential identifier must
 * be present and equal or a workspace sibling can mutate this account's
 * baseline.
 */
function codexReportMatchesExactIdentity(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	const accountId = normalizeCodexIdentityValue(identity.accountId);
	const email = normalizeCodexIdentityValue(identity.email);
	const projectId = normalizeCodexIdentityValue(identity.projectId);
	const orgId = normalizeCodexIdentityValue(identity.orgId);
	if (!accountId && !email && !projectId && !orgId) return false;

	const metadata = report.metadata ?? {};
	const reportAccountId =
		normalizeCodexIdentityValue(metadata.accountId) ?? normalizeCodexIdentityValue(metadata.account_id);
	const reportProjectId =
		normalizeCodexIdentityValue(metadata.projectId) ?? normalizeCodexIdentityValue(metadata.project_id);
	if (accountId && reportAccountId !== accountId) return false;
	if (email && normalizeCodexIdentityValue(metadata.email) !== email) return false;
	if (projectId && reportProjectId !== projectId) return false;
	if (orgId && normalizeCodexIdentityValue(metadata.orgId) !== orgId) return false;
	return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Context-usage memo
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cheap structural fingerprint of a message's tokenizable content. O(blocks) —
 * only reads string `.length` and primitives, never copies or serializes.
 * Detects in-place growth of the streaming tail (and other in-place mutations)
 * so the cached `getContextUsage()` result is recomputed when — and only when —
 * the numbers it depends on change.
 */
function messageFingerprint(msg: AgentMessage): string {
	const role = (msg as { role?: string }).role ?? "";
	const ts = (msg as { timestamp?: number }).timestamp ?? 0;
	let textLen = 0;
	let blocks = 0;
	let images = 0;
	if (role === "bashExecution") {
		const b = msg as { command?: unknown; output?: unknown };
		if (typeof b.command === "string") textLen += b.command.length;
		if (typeof b.output === "string") textLen += b.output.length;
	} else if (role === "user") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") textLen += block.text.length;
			}
		}
	} else if (role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const usageExt = assistantMsg.usage as unknown as { promptTokensDetails?: unknown };
		const usageTotal = assistantMsg.usage?.totalTokens ?? 0;
		const promptBuckets = usageExt?.promptTokensDetails ? 1 : 0;
		const stopReason = assistantMsg.stopReason ?? "";

		let signatureLen = 0;
		let redactedLen = 0;
		const msgExt = assistantMsg as unknown as {
			thinkingSignature?: string;
			textSignature?: string;
			thoughtSignature?: string;
			redactedThinking?: { data?: string };
		};
		const thinkingSignature = msgExt.thinkingSignature;
		if (typeof thinkingSignature === "string") {
			signatureLen += thinkingSignature.length;
		}
		const textSignature = msgExt.textSignature;
		if (typeof textSignature === "string") {
			signatureLen += textSignature.length;
		}
		const thoughtSignature = msgExt.thoughtSignature;
		if (typeof thoughtSignature === "string") {
			signatureLen += thoughtSignature.length;
		}
		const redactedData = msgExt.redactedThinking?.data;
		if (typeof redactedData === "string") {
			redactedLen += redactedData.length;
		}

		const content = (msg as { content?: unknown }).content;
		if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as {
					type?: string;
					text?: string;
					thinking?: string;
					thinkingSignature?: string;
					signature?: string;
					textSignature?: string;
					thoughtSignature?: string;
					data?: string;
					name?: string;
					arguments?: unknown;
				};
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "thinking") {
					if (typeof b.thinking === "string") textLen += b.thinking.length;
					if (typeof b.thinkingSignature === "string") signatureLen += b.thinkingSignature.length;
					if (typeof b.signature === "string") signatureLen += b.signature.length;
					if (typeof b.textSignature === "string") signatureLen += b.textSignature.length;
					if (typeof b.thoughtSignature === "string") signatureLen += b.thoughtSignature.length;
				} else if (b.type === "redactedThinking" && typeof b.data === "string") {
					redactedLen += b.data.length;
				} else if (b.type === "toolCall") {
					if (typeof b.name === "string") textLen += b.name.length;
					if (b.arguments !== undefined) {
						try {
							textLen += JSON.stringify(b.arguments, (_key, value) =>
								typeof value === "bigint" ? value.toString() : value,
							).length;
						} catch {
							textLen += String(b.arguments).length;
						}
					}
				}
			}
		}
		return `${role}:${ts}:${textLen}:${blocks}:${images}:${signatureLen}:${redactedLen}:${usageTotal}:${promptBuckets}:${stopReason}`;
	} else if (role === "toolResult" || role === "hookMessage") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "image") images++;
			}
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		const s = (msg as { summary?: unknown }).summary;
		if (typeof s === "string") textLen += s.length;
	}
	return `${role}:${ts}:${textLen}:${blocks}:${images}`;
}

interface ContextUsageMemo {
	messagesRef: readonly AgentMessage[];
	length: number;
	lastFingerprint: string | undefined;
	modelContextWindow: number;
	contextUsageRevision: number;
	usedTokens: number;
	contextWindow: number;
	systemPromptRef: readonly string[] | undefined;
	toolsRef: readonly any[] | undefined;
	skillsRef: readonly any[] | undefined;
}

interface ActiveRepoCache {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	/** Project + worktree dir name when `projectDir` is a linked worktree, else null. */
	worktree: WorktreeContext | null;
}

interface BranchResolveRequest {
	id: number;
	cwd: string;
	controller: AbortController;
}

interface JjResolveRequest {
	id: number;
	controller: AbortController;
}

interface WorktreeContext {
	/** Primary-checkout (project) name shown by the path segment. */
	projectName: string;
	/** Worktree directory name — suppressed from the path when it equals the branch. */
	worktreeName: string;
}

/**
 * Project + worktree-dir names when `cwd` is a linked git worktree, else null.
 * The project name comes from the shared primary checkout; bare-repo worktrees
 * resolve to the shared `foo.git` dir, so a trailing `.git` is stripped.
 */
function resolveWorktreeContext(cwd: string): WorktreeContext | null {
	const worktree = git.repo.linkedWorktreeSync(cwd);
	if (!worktree) return null;
	const base = path.basename(worktree.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	if (!projectName) return null;
	return { projectName, worktreeName: path.basename(worktree.root) };
}

/**
 * Per-{@link AgentSession} active-processing meter for the `time_spent`
 * segment. `activeMs` is the union of every completed `agent_start`→
 * `agent_end` window; `activeStartedAt` is the start timestamp of the
 * currently-running window, or `null` when idle.
 *
 * `sessionFile` snapshots the loaded session-file path at meter-creation
 * time. `AgentSession.switchSession` (/resume, /move, ACP fork, RPC
 * `switch_session`, extension `switchSession`) mutates the loaded file
 * under the same {@link AgentSession} ref, so the WeakMap key alone
 * cannot tell two conversations apart. `#meter()` compares this snapshot
 * against the live `session.sessionFile`, and a real-to-real change
 * starts the meter fresh instead of crediting the new conversation with
 * the previous one's accumulated active time. The undefined → real
 * first-save transition does not reset, since the session identity has
 * not changed.
 */
interface ActiveMeter {
	activeMs: number;
	activeStartedAt: number | null;
	sessionFile: string | undefined;
}

const EMPTY_MESSAGES: readonly AgentMessage[] = [];
const STATUS_USAGE_START_DELAY_MS = 0;
const STATUS_USAGE_REFRESH_TIMEOUT_MS = 2_000;

function hasContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("context_pct") || segments.includes("context_total");
}
function hasGitSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("git");
}

function hasPrSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("pr");
}
function hasPathSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("path");
}

function hasGitBackedSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return hasGitSegment(segments) || hasPrSegment(segments);
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#effectiveSettings: EffectiveStatusLineSettings | undefined;
	#cachedBranch: string | null | undefined = undefined;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#cachedBranchCwd: string | undefined = undefined;
	#cachedBranchHasGitRepository = false;
	// In-flight reftable resolve slot. Ownership is the launch id, not the cwd:
	// two live resolves can share a cwd string across an invalidation, and a
	// stale one must never free (or poison) a slot it no longer owns.
	#branchResolveSeq = 0;
	#branchResolveActive: BranchResolveRequest | undefined = undefined;
	// Bumped on every branch-cache reset (#invalidateGitCaches — a HEAD move or
	// repo-context change). An in-flight reftable resolve captures this at
	// launch; a mismatch on resolve means the cache was invalidated underneath
	// it (a newer resolve superseded it), so its result is stale and must be
	// dropped rather than overwrite the value the newer resolve committed.
	// Mirrors #jjCacheGeneration / #getJjBranch in this file.
	// Timestamp of the latest branch read; only bounds cache freshness when the
	// HEAD watcher could not be installed.
	#branchLastFetch: number | undefined = undefined;
	// Bumped on every branch-cache reset (invalidateGitCaches — a HEAD move or
	// repo-context change). An in-flight reftable resolve captures this at
	// launch; a mismatch on resolve means the cache was invalidated underneath
	// it (a newer resolve superseded it), so its result is stale and must be
	// dropped rather than overwrite the value the newer resolve committed.
	// Mirrors #jjCacheGeneration / #getJjBranch in this file.
	#branchCacheGeneration = 0;
	#gitWatcher: fs.FSWatcher | null = null;
	#gitWatcherErrorListener: (() => void) | undefined = undefined;
	#gitWatcherUnavailable = false;
	#onBranchChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#subagentCount: number = 0;
	/**
	 * Active-processing accounting for the `time_spent` segment, keyed per
	 * {@link AgentSession} so the focus-controller mid-turn attach path
	 * cannot leak an unmatched synthesized `agent_start` from a subagent
	 * into the main session's meter.
	 *
	 * Each meter is `{ activeMs, activeStartedAt }`: `activeMs` is the union
	 * of every completed `agent_start`→`agent_end` window since
	 * {@link resetActiveTime} last reset it; `activeStartedAt` is the start
	 * timestamp of the currently-running window (or `null` when idle).
	 * `getActiveMs()` returns `activeMs + (now - activeStartedAt)` for the
	 * currently-attached session, so the counter ticks live during a turn
	 * and freezes the instant the agent yields.
	 *
	 * WeakMap so meters die with their session (e.g. a parked subagent
	 * dropped from the registry); the main session's meter survives focus
	 * round-trips because the same {@link AgentSession} ref is reused.
	 */
	#activeMeters: WeakMap<AgentSession, ActiveMeter> = new WeakMap();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: SegmentContext["loopMode"] = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#vibeModeStatus: { enabled: boolean } | null = null;
	/**
	 * Injected aggregator that returns the aggregate tok/s of this session's
	 * live vibe worker sessions, or null when no workers are streaming. Kept as
	 * a callback so the render layer doesn't import the heavy vibe/task
	 * dependency graph; interactive-mode wires it to VibeSessionRegistry.
	 */
	#vibeWorkerTokenRate: (() => number | null) | null = null;
	#collabStatus: CollabStatus | null = null;
	#focusedAgentId: string | undefined;
	#activeRepoCache: ActiveRepoCache | undefined;

	// Git status caching (1s TTL)
	#cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#cachedGitStatusCwd: string | undefined = undefined;
	#gitStatusLastFetch = 0;
	#gitStatusInFlightCwd: string | undefined = undefined;
	#jjRoot: string | null | undefined = undefined;
	#jjRootCwd: string | undefined = undefined;
	#cachedJjBranch: string | null = null;
	#jjBranchLastFetch = 0;
	#jjResolveSeq = 0;
	#jjBranchActive: JjResolveRequest | undefined = undefined;
	#cachedJjStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	#jjStatusLastFetch = 0;
	#jjStatusActive: JjResolveRequest | undefined = undefined;
	// Bumped on every jj-cache reset — a cwd switch (#jjRootFor) or a HEAD /
	// bookmark move (#invalidateGitCaches). An in-flight jj query captures this
	// at launch; a mismatch on resolve means the caches were reset underneath it
	// (including a reset that re-resolves to the SAME root, which a root-equality
	// check cannot detect), so the result is stale and must be dropped rather
	// than poison the fresh cache or advance its throttle.
	#jjCacheGeneration = 0;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#defaultBranchCwd: string | undefined = undefined;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;

	// Provider usage caching (5-min TTL, OAuth/sub only)
	#cachedUsage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null = null;
	#cachedUsageContextKey: string | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageStartTimer: Timer | null = null;
	// A timed-out request may still resolve. Its result remains eligible only
	// until a newer request has applied.
	#usageRefreshSequence = 0;
	#latestAppliedUsageRefreshSequence = 0;
	#codexResetSnapshots = new Map<string, CodexResetUsageSnapshot>();
	#onCodexResetFireworks: ((event: CodexResetFireworksEvent) => void) | undefined;
	// Context-usage memo. The status line redraws on every agent event, so the
	// hot path must not recompute context tokens unless an input changed.
	// `getContextUsage()` anchors on the last assistant's real prompt-token
	// count (matching the provider and the `/context` panel), so a stable
	// message list + model window yields a stable result we can return verbatim.
	#contextUsageCache: ContextUsageMemo | undefined;

	constructor(private session: AgentSession) {
		this.#settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
			compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
		};
	}
	#gitEnabled(): boolean {
		return settings.get("git.enabled");
	}
	#hasGitBackedSegment(): boolean {
		const effectiveSettings = this.#resolveSettings();
		return (
			hasGitBackedSegment(effectiveSettings.leftSegments) || hasGitBackedSegment(effectiveSettings.rightSegments)
		);
	}

	#resolveActiveRepoCache(): ActiveRepoCache {
		const projectDir = getProjectDir();
		if (this.#activeRepoCache?.projectDir === projectDir) {
			return this.#activeRepoCache;
		}

		const activeRepo = resolveActiveRepoContextSync(projectDir);
		const effectiveGitCwd = activeRepo?.repoRoot ?? projectDir;
		// Only collapse the bare-cwd case: a single-direct-child-repo context
		// (activeRepo set) renders `<parent> ↳ <child>`, which we leave intact.
		const worktree = activeRepo ? null : resolveWorktreeContext(effectiveGitCwd);
		this.#activeRepoCache = { projectDir, activeRepo, effectiveGitCwd, worktree };
		return this.#activeRepoCache;
	}

	/**
	 * Re-point the status line at another session (focus proxy). Invalidate: model/context/usage all derive
	 * from it. `focusedAgentId` is the focused subagent id while the view is proxied, undefined for main.
	 */
	setSession(session: AgentSession, focusedAgentId?: string): void {
		const sessionChanged = this.session !== session;
		if (!sessionChanged && this.#focusedAgentId === focusedAgentId) return;
		this.session = session;
		this.#focusedAgentId = focusedAgentId;
		if (sessionChanged) {
			this.#invalidateSessionCaches();
			this.#closeStaleActiveWindow();
		}
		this.invalidate();
	}

	/**
	 * Drop a meter's in-flight window when the newly-attached session is no
	 * longer streaming. Handles the case where the focus controller
	 * synthesized an `agent_start` on a mid-turn attach but the matching
	 * real `agent_end` never reached us — the user detached before it
	 * fired, and re-focusing later (after the agent finished) would
	 * otherwise tick over the entire detached gap. Crediting that gap to
	 * `activeMs` would be wrong (the agent finished at some point we never
	 * observed), so the window is dropped rather than folded in.
	 */
	#closeStaleActiveWindow(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		if (this.session.isStreaming) return;
		meter.activeStartedAt = null;
	}

	updateSettings(settings: StatusLineSettings): void {
		this.#settings = settings;
		this.#effectiveSettings = undefined;
		if (this.#onBranchChange) this.#setupGitWatcher();
	}

	getEffectiveSettingsForTest(): EffectiveStatusLineSettings {
		return this.#resolveSettings();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = count;
	}

	/**
	 * Compatibility shim for callers predating the simplified subagent badge.
	 * The status line now intentionally shows only the active count.
	 */
	setSubagentHubHint(_hint: string | undefined): void {}

	/** Active subagent count as currently displayed (collab state mirroring). */
	get subagentCount(): number {
		return this.#subagentCount;
	}

	/**
	 * Reset the currently-attached session's active-time accumulators so
	 * the `time_spent` segment starts from zero. Called from `/clear`,
	 * fresh-session, and joined-collab paths; both the completed
	 * accumulator and any in-flight window are dropped, so a reset
	 * mid-turn ignores the running window (the matching `markActivityEnd`
	 * will see an idle meter and no-op).
	 */
	resetActiveTime(): void {
		const meter = this.#meter();
		meter.activeMs = 0;
		meter.activeStartedAt = null;
	}

	/**
	 * Mark the currently-attached session as having started a unit of
	 * active processing. Idempotent: a second start while a window is
	 * already open is a no-op, so reentrant `agent_start` events (e.g.
	 * nested auto-compaction loops, focus-controller mid-turn attach onto
	 * an already-running window) do not double-count.
	 */
	markActivityStart(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt !== null) return;
		meter.activeStartedAt = Date.now();
	}

	/**
	 * Close the currently-attached session's open active-processing
	 * window, folding its elapsed time into the accumulator. Idempotent
	 * when the meter is already idle so callers can fire it on every
	 * `agent_end` without guarding.
	 */
	markActivityEnd(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		meter.activeMs += Math.max(0, Date.now() - meter.activeStartedAt);
		meter.activeStartedAt = null;
	}

	/**
	 * Snapshot of total active-processing time for the currently-attached
	 * session, including any in-flight window. Exposed for the segment
	 * context builder; tests assert against this too.
	 */
	getActiveMs(): number {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return meter.activeMs;
		return meter.activeMs + Math.max(0, Date.now() - meter.activeStartedAt);
	}

	/**
	 * Return (lazily creating) the meter for the currently-attached
	 * session. Detects an in-place session-file swap under the same
	 * {@link AgentSession} ref (`switchSession` paths: `/resume`, `/move`,
	 * ACP fork/load, RPC `switch_session`, extension `switchSession`):
	 * a real-to-real change starts the meter fresh so the new
	 * conversation does not inherit the previous one's accumulated active
	 * time. The undefined → real first-save transition only refreshes the
	 * snapshot — the conversation identity has not changed.
	 */
	#meter(): ActiveMeter {
		const currentFile = this.session.sessionFile;
		let meter = this.#activeMeters.get(this.session);
		if (meter) {
			const switched =
				currentFile !== undefined && meter.sessionFile !== undefined && meter.sessionFile !== currentFile;
			if (switched) {
				meter = undefined;
			} else {
				meter.sessionFile = currentFile;
			}
		}
		if (!meter) {
			meter = { activeMs: 0, activeStartedAt: null, sessionFile: currentFile };
			this.#activeMeters.set(this.session, meter);
		}
		return meter;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setLoopModeStatus(status: NonNullable<SegmentContext["loopMode"]> | undefined): void {
		this.#loopModeStatus = status ?? null;
	}

	setGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#goalModeStatus = status ?? null;
	}

	setVibeModeStatus(status: { enabled: boolean } | undefined): void {
		this.#vibeModeStatus = status ?? null;
	}

	/**
	 * Inject the aggregator that returns the aggregate tok/s of this session's
	 * live vibe worker sessions (null when no workers are streaming). Wired by
	 * interactive-mode, which owns the VibeSessionRegistry coupling, so the
	 * render layer stays off the heavy vibe/task dependency graph. Pass
	 * `undefined` to clear.
	 */
	setVibeWorkerTokenRateProvider(provider: (() => number | null) | undefined): void {
		this.#vibeWorkerTokenRate = provider ?? null;
	}

	setCollabStatus(status: CollabStatus | null): void {
		this.#collabStatus = status;
	}

	/** Set the callback that presents detected Codex reset celebrations, or clear it with `undefined`. */
	setCodexResetFireworksHandler(handler: ((event: CodexResetFireworksEvent) => void) | undefined): void {
		this.#onCodexResetFireworks = handler;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		this.#retireGitWatcher();
		this.#gitWatcherUnavailable = false;

		if (!this.#gitEnabled() || !this.#hasGitBackedSegment()) {
			this.invalidateGitCaches();
			return;
		}

		const { effectiveGitCwd } = this.#resolveActiveRepoCache();
		const repository = git.repo.resolveSync(effectiveGitCwd);
		if (!repository) {
			// There is no path to watch yet. Cache the negative result only for the
			// fallback poll interval so a later `git init` becomes visible without
			// generic invalidations or a render-path probe on every paint.
			this.#gitWatcherUnavailable = true;
			return;
		}

		const watchPath = git.repo.isReftableSync(repository)
			? path.join(repository.gitDir, "reftable")
			: repository.headPath;

		try {
			const watcher = fs.watch(watchPath, () => {
				if (this.#disposed || this.#gitWatcher !== watcher) return;
				this.invalidateGitCaches();
				this.#onBranchChange?.();
			});
			const onError = () => {
				if (this.#gitWatcher !== watcher) return;
				this.#retireGitWatcher();
				this.#gitWatcherUnavailable = true;
				if (this.#disposed) return;
				this.invalidateGitCaches();
				this.#onBranchChange?.();
			};
			this.#gitWatcher = watcher;
			this.#gitWatcherErrorListener = onError;
			watcher.on("error", onError);
		} catch {
			this.#gitWatcherUnavailable = true;
		}
	}

	#retireGitWatcher(): void {
		const watcher = this.#gitWatcher;
		const onError = this.#gitWatcherErrorListener;
		this.#gitWatcher = null;
		this.#gitWatcherErrorListener = undefined;
		if (!watcher) return;
		if (onError) watcher.off("error", onError);
		watcher.close();
	}

	dispose(): void {
		this.#disposed = true;
		this.#branchResolveActive?.controller.abort();
		this.#branchResolveActive = undefined;
		this.#resetJjRequests();
		this.#onBranchChange = null;
		this.#clearUsageStartTimer();
		this.#onCodexResetFireworks = undefined;
		this.#codexResetSnapshots.clear();
		this.#retireGitWatcher();
	}

	#clearUsageStartTimer(): void {
		if (!this.#usageStartTimer) return;
		clearTimeout(this.#usageStartTimer);
		this.#usageStartTimer = null;
	}

	invalidate(): void {
		// Generic repaint invalidation (theme change, message event, model
		// switch, …). Must NOT abort or restart a live reftable HEAD/PR resolve:
		// the render path self-invalidates via cwd/context cache-miss checks, so
		// a generic paint only needs to re-render — not tear down in-flight VCS
		// work. Aborting here would fan out a new git subprocess on every agent
		// event, re-introducing the render-path spawn churn the async resolve
		// was designed to avoid. Explicit Git/repository invalidation (watcher
		// HEAD-move, cwd/repo switch) goes through {@link invalidateGitCaches}.
		// A tool may open, close, or merge a PR without moving HEAD. Expire the
		// settled PR context on ordinary activity while leaving HEAD work intact.
		this.#cachedPrContext = undefined;
	}
	#invalidateSessionCaches(): void {
		this.#clearUsageStartTimer();
		this.#cachedUsage = null;
		this.#usageFetchedAt = 0;
		this.#usageInFlight = false;
		this.#contextUsageCache = undefined;
		this.#lastTokensPerSecond = null;
		this.#lastTokensPerSecondTimestamp = null;
	}

	/**
	 * Explicit Git/repository cache invalidation. Aborts any in-flight
	 * reftable HEAD/PR resolve, bumps the stale-result generation, and drops
	 * the branch/PR/jj caches so the next render refetches from disk. Called
	 * by the git watcher on a HEAD move and by {@link applyCwdChange} on a
	 * repo/cwd switch. Generic repaints use {@link invalidate} instead and
	 * must never reach this path.
	 */
	invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedBranchHasGitRepository = false;
		// Abort before releasing the in-flight slot. Releasing alone would allow
		// repeated invalidations to fan out still-running git subprocesses.
		this.#branchResolveActive?.controller.abort();
		this.#branchResolveActive = undefined;
		this.#branchLastFetch = undefined;
		this.#branchCacheGeneration++;
		this.#cachedPrContext = undefined;
		// jj label/status share the git segment's lifecycle: a HEAD move (e.g. a
		// colocated `jj new`/bookmark move) must drop the throttled jj caches too,
		// mirroring #jjRootFor's per-cwd reset so the next render refetches.
		this.#resetJjRequests();
		this.#jjRoot = undefined;
		this.#jjRootCwd = undefined;
		this.#cachedJjBranch = null;
		this.#jjBranchLastFetch = 0;
		this.#cachedJjStatus = null;
		this.#jjStatusLastFetch = 0;
		this.#jjCacheGeneration++;
	}

	/**
	 * Re-point the status line's VCS watcher and caches at a new cwd/repository.
	 * Atomically retires the old watcher/listeners, invalidates VCS caches and
	 * in-flight controllers, then runs watcher setup for the new cwd and requests
	 * a repaint. Called by {@link InteractiveMode.applyCwdChange} after the
	 * SessionManager's cwd has moved — the watcher ownership always follows the
	 * effective cwd/repo, so a stale watcher for the previous repo can never
	 * invalidate the new one. Generic repaints use {@link invalidate} and must
	 * never retire the watcher or abort a live resolve.
	 */
	applyCwdChange(): void {
		this.#retireGitWatcher();
		this.invalidateGitCaches();
		this.#setupGitWatcher();
		this.#onBranchChange?.();
	}

	#resetJjRequests(): void {
		this.#jjBranchActive?.controller.abort();
		this.#jjBranchActive = undefined;
		this.#jjStatusActive?.controller.abort();
		this.#jjStatusActive = undefined;
	}
	#getCurrentBranch(effectiveGitCwd?: string): string | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const fallbackCacheExpired =
			this.#gitWatcherUnavailable &&
			(this.#branchLastFetch === undefined || Date.now() - this.#branchLastFetch >= WATCHER_FAILURE_POLL_TTL_MS);
		if (this.#cachedBranch !== undefined && this.#cachedBranchCwd === gitCwd && !fallbackCacheExpired) {
			return this.#cachedBranch;
		}

		// A reftable repo resolves HEAD by spawning `git symbolic-ref` +
		// `git rev-parse` — the unbounded spawn that froze the render path (F7).
		// A non-reftable repo resolves HEAD with cheap sync filesystem reads, so
		// only the reftable branch moves off the render path, mirroring
		// #getGitStatus and #getJjBranch in this file.
		const repository = git.repo.resolveSync(gitCwd);
		if (repository && git.repo.isReftableSync(repository)) {
			if (this.#branchResolveActive !== undefined) {
				return this.#branchResolveActive.cwd === gitCwd && this.#cachedBranchCwd === gitCwd
					? (this.#cachedBranch ?? null)
					: null;
			}
			const request: BranchResolveRequest = {
				id: ++this.#branchResolveSeq,
				cwd: gitCwd,
				controller: new AbortController(),
			};
			this.#branchResolveActive = request;
			// Capture the cache generation at launch. invalidateGitCaches bumps it
			// on a HEAD move and clears the in-flight slot, so a fresher resolve can
			// start while this one is still pending. Without a generation check the
			// older resolve would finish later, install its stale HEAD, and clear the
			// slot — dropping the fresh result and freezing the status line on the
			// pre-change branch. Mirrors #jjCacheGeneration / #getJjBranch.
			const generation = this.#branchCacheGeneration;
			(async () => {
				let next: string | null = null;
				let repoId: string | null = null;
				try {
					const headState = await git.head.resolve(gitCwd, request.controller.signal);
					repoId = headState?.headPath ?? null;
					next = !headState
						? null
						: headState.kind === "ref"
							? (headState.branchName ?? headState.ref)
							: "detached";
				} catch {
					next = null;
				} finally {
					// Release the slot only if this resolve still owns it: after an
					// invalidation a fresher resolve may hold it, and freeing that
					// slot here would let a third same-generation resolve launch and
					// race the fresh one to the cache commit.
					if (this.#branchResolveActive?.id === request.id) this.#branchResolveActive = undefined;
				}
				// Only the latest generation may update the cache; a mismatch means a
				// newer resolve superseded this one (or the component disposed).
				if (this.#branchCacheGeneration !== generation || this.#disposed) return;
				const prev = this.#cachedBranchCwd === gitCwd ? this.#cachedBranch : undefined;
				this.#cachedBranchCwd = gitCwd;
				this.#cachedBranchRepoId = repoId;
				this.#cachedBranchHasGitRepository = next === null;
				this.#cachedBranch = next;
				this.#branchLastFetch = Date.now();
				if (prev !== next && this.#onBranchChange) this.#onBranchChange();
			})();
			return this.#cachedBranchCwd === gitCwd ? (this.#cachedBranch ?? null) : null;
		}

		// Non-reftable: cheap sync filesystem read, safe on the render path.
		const head = git.head.resolveSync(gitCwd);
		const gitHeadPath = head?.headPath ?? null;
		this.#cachedBranchCwd = gitCwd;
		this.#cachedBranchRepoId = gitHeadPath;
		this.#branchLastFetch = Date.now();
		if (!head) {
			this.#cachedBranch = null;
			return null;
		}
		this.#cachedBranch = head.kind === "ref" ? (head.branchName ?? head.ref) : "detached";
		return this.#cachedBranch ?? null;
	}

	#isDefaultBranch(branch: string, effectiveGitCwd: string): boolean {
		if (this.#defaultBranchCwd !== effectiveGitCwd) {
			this.#defaultBranch = undefined;
			this.#defaultBranchCwd = effectiveGitCwd;
		}

		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			const lookupCwd = effectiveGitCwd;
			(async () => {
				const resolved = await git.branch.default(lookupCwd);
				if (this.#disposed || this.#defaultBranchCwd !== lookupCwd) return;
				if (resolved) {
					this.#defaultBranch = resolved;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(effectiveGitCwd?: string): { staged: number; unstaged: number; untracked: number } | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#gitStatusInFlightCwd !== undefined) {
			return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
		}
		if (this.#cachedGitStatusCwd === gitCwd && Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlightCwd = gitCwd;

		(async () => {
			let nextStatus: { staged: number; unstaged: number; untracked: number } | null = null;
			try {
				nextStatus = await git.status.summary(gitCwd);
			} catch {
				nextStatus = null;
			} finally {
				if (this.#gitStatusInFlightCwd === gitCwd) {
					const prev = this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
					this.#cachedGitStatus = nextStatus;
					this.#cachedGitStatusCwd = gitCwd;
					this.#gitStatusLastFetch = Date.now();
					this.#gitStatusInFlightCwd = undefined;
					if (!this.#disposed && this.#onBranchChange && JSON.stringify(prev) !== JSON.stringify(nextStatus)) {
						this.#onBranchChange();
					}
				}
			}
		})();

		return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
	}

	// Resolve (and cache per cwd) the jj workspace root, resetting both jj caches
	// on a cwd change so a directory switch refetches label + status.
	#jjRootFor(cwd: string): string | null {
		if (this.#jjRoot === undefined || this.#jjRootCwd !== cwd) {
			this.#jjRootCwd = cwd;
			this.#jjRoot = jj.repo.rootSync(cwd);
			this.#cachedJjBranch = null;
			this.#jjBranchLastFetch = 0;
			this.#cachedJjStatus = null;
			this.#jjStatusLastFetch = 0;
			this.#jjCacheGeneration++;
		}
		return this.#jjRoot;
	}

	// jj working-copy bookmark label (nearest bookmark, change-id fallback), shown
	// in the `git` segment where git HEAD is detached/absent under jj. Throttled,
	// cached, and repaints on resolve.
	#getJjBranch(effectiveGitCwd?: string): string | null {
		const cwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const root = this.#jjRootFor(cwd);
		if (!root) return null;
		if (this.#jjBranchActive || Date.now() - this.#jjBranchLastFetch < JJ_REFRESH_TTL_MS) {
			return this.#cachedJjBranch;
		}
		const request: JjResolveRequest = {
			id: ++this.#jjResolveSeq,
			controller: new AbortController(),
		};
		this.#jjBranchActive = request;
		const generation = this.#jjCacheGeneration;
		(async () => {
			let next: string | null = null;
			try {
				next = await jj.workingCopy.label(root, {
					signal: request.controller.signal,
					timeoutMs: jj.JJ_COMMAND_TIMEOUT_MS,
				});
			} finally {
				if (this.#jjBranchActive?.id === request.id) this.#jjBranchActive = undefined;
				// Advance the throttle only if no reset raced this query; a reset
				// leaves LastFetch at 0 so the current root refetches instead of
				// being throttled on a superseded result.
				if (this.#jjCacheGeneration === generation) this.#jjBranchLastFetch = Date.now();
			}
			// Drop a result whose caches were reset mid-flight — a repo switch OR a
			// same-root HEAD/bookmark move — so a superseded label never lands in
			// the live cache.
			if (this.#jjCacheGeneration !== generation || this.#disposed) return;
			const changed = next !== this.#cachedJjBranch;
			this.#cachedJjBranch = next;
			if (changed) this.#onBranchChange?.();
		})();
		return this.#cachedJjBranch;
	}

	// jj working-copy status counts (`@` vs its parent), used in place of git
	// status in a jj repo where `git status` has no `.git` to read. Throttled,
	// cached, and repaints on resolve like #getJjBranch.
	#getJjStatus(effectiveGitCwd?: string): { staged: number; unstaged: number; untracked: number } | null {
		const cwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const root = this.#jjRootFor(cwd);
		if (!root) return null;
		if (this.#jjStatusActive || Date.now() - this.#jjStatusLastFetch < JJ_REFRESH_TTL_MS) {
			return this.#cachedJjStatus;
		}
		const request: JjResolveRequest = {
			id: ++this.#jjResolveSeq,
			controller: new AbortController(),
		};
		this.#jjStatusActive = request;
		const generation = this.#jjCacheGeneration;
		(async () => {
			let next: { staged: number; unstaged: number; untracked: number } | null = null;
			try {
				next = await jj.status.summary(root, {
					signal: request.controller.signal,
					timeoutMs: jj.JJ_COMMAND_TIMEOUT_MS,
				});
			} finally {
				if (this.#jjStatusActive?.id === request.id) this.#jjStatusActive = undefined;
				if (this.#jjCacheGeneration === generation) this.#jjStatusLastFetch = Date.now();
			}
			if (this.#jjCacheGeneration !== generation || this.#disposed) return;
			const prev = this.#cachedJjStatus;
			this.#cachedJjStatus = next;
			if (JSON.stringify(prev) !== JSON.stringify(next)) this.#onBranchChange?.();
		})();
		return this.#cachedJjStatus;
	}

	#lookupPr(effectiveGitCwd?: string): { number: number; url: string } | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const branch = this.#getCurrentBranch(gitCwd);
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		if (!branch) {
			this.#cachedPr = null;
			this.#cachedPrContext = undefined;
			return null;
		}

		// Don't look up if detached, default branch, or already in flight.
		if (branch === "detached" || this.#isDefaultBranch(branch, gitCwd) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;
		const lookupCwd = gitCwd;

		// Fire async lookup, keep stale value visible until resolved
		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch(lookupCwd);
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				// Route through the shared `gh` helper so the child inherits
				// `GH_NON_INTERACTIVE_ENV` (disables terminal/keychain prompts) and
				// hard-terminates on the git command deadline instead of stalling
				// the status-line indefinitely (#4234). Requires `gh repo set-default`;
				// non-zero exit still falls through to the null cache below.
				const result = await git.github.run(
					lookupCwd,
					["pr", "view", "--json", "number,url"],
					AbortSignal.timeout(git.GIT_COMMAND_TIMEOUT_MS),
				);
				if (this.#disposed) return;
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				if (this.#disposed) return;
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (!this.#disposed && this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		// Aggregate tok/s across the main session AND every live vibe worker.
		// In vibe mode the director is often idle while workers stream, so the
		// main session's own rate alone would show a stale/zero value while
		// parallel work is actively generating tokens.
		const workerRate = this.#getVibeWorkerTokensPerSecond();
		if (workerRate !== null) {
			// At least one worker is streaming — add the director's live rate
			// only when it is itself streaming (a finalized last-turn rate would
			// double-count and overstate throughput).
			const mainRate = this.session.isStreaming ? calculateTokensPerSecond(this.session.state.messages, true) : 0;
			return (mainRate ?? 0) + workerRate;
		}

		// No workers streaming — fall back to the main session's own rate with
		// its sticky per-assistant-message cache so the badge doesn't flicker
		// off in the brief gap between stream end and the finalized message.
		return this.#getMainSessionTokensPerSecond();
	}

	/**
	 * Main session's tok/s with sticky caching keyed on the last assistant
	 * message timestamp. Preserves the pre-aggregation behavior when no vibe
	 * workers are active.
	 */
	#getMainSessionTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	/**
	 * Aggregate tok/s across every live vibe worker session owned by this
	 * session. Returns null when no workers are streaming (so the main
	 * session's own rate shines through unchanged). The aggregation itself is
	 * injected via {@link setVibeWorkerTokenRateProvider} to keep this render
	 * layer off the heavy vibe/task dependency graph.
	 */
	#getVibeWorkerTokensPerSecond(): number | null {
		return this.#vibeWorkerTokenRate?.() ?? null;
	}

	#formatUsageContextKey(activeProvider: string | undefined, identity: OAuthAccountIdentity | undefined): string {
		if (!activeProvider) return "";
		// orgId is part of the key: rotating between two same-email Anthropic
		// subscriptions must invalidate the cached usage immediately instead of
		// showing the previous org's quota for the rest of the cache TTL.
		return [
			activeProvider,
			identity?.accountId ?? "",
			identity?.email ?? "",
			identity?.projectId ?? "",
			identity?.orgId ?? "",
		].join("\0");
	}

	#getUsageContextKey(session: AgentSession): string {
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const identity = activeProvider
			? session.modelRegistry?.authStorage?.getOAuthAccountIdentity(activeProvider, session.sessionId)
			: undefined;
		return this.#formatUsageContextKey(activeProvider, identity);
	}

	/**
	 * Startup redraws only arm a short-delayed task; timeout releases the render
	 * cadence while a late successful fetch can still refresh the cached segment.
	 */
	refreshUsageInBackground(): void {
		const now = Date.now();
		const session = this.session;
		const usageContextKey = this.#getUsageContextKey(session);
		if (this.#cachedUsageContextKey !== usageContextKey) {
			this.#cachedUsage = null;
			this.#usageFetchedAt = 0;
			this.#cachedUsageContextKey = usageContextKey;
		}
		if (this.#usageInFlight || this.#usageStartTimer) return;
		if (this.#usageFetchedAt > 0 && now - this.#usageFetchedAt < 5 * 60_000) return;
		const fetcher = (session as { fetchUsageReports?: (signal?: AbortSignal) => Promise<unknown> }).fetchUsageReports;
		if (typeof fetcher !== "function") return;
		this.#usageInFlight = true;
		this.#usageStartTimer = setTimeout(() => {
			this.#usageStartTimer = null;
			void this.#runUsageRefresh(session, fetcher);
		}, STATUS_USAGE_START_DELAY_MS);
	}

	async #runUsageRefresh(session: AgentSession, fetcher: (signal?: AbortSignal) => Promise<unknown>): Promise<void> {
		if (this.#disposed || this.session !== session) {
			this.#usageInFlight = false;
			return;
		}
		const sequence = ++this.#usageRefreshSequence;
		const signal = AbortSignal.timeout(STATUS_USAGE_REFRESH_TIMEOUT_MS);
		let reportsPromise: Promise<unknown> | undefined;
		try {
			reportsPromise = fetcher.call(session, signal);
			this.#applyUsageRefreshReports(
				session,
				await this.#raceUsageRefreshWithSignal(reportsPromise, signal),
				sequence,
			);
		} catch {
			if (this.session !== session) return;
			this.#usageFetchedAt = Date.now();
			if (signal.aborted && reportsPromise) {
				this.#observeLateUsageRefresh(session, reportsPromise, sequence);
			}
		} finally {
			if (this.session === session) this.#usageInFlight = false;
		}
	}

	#applyUsageRefreshReports(session: AgentSession, reports: unknown, sequence: number): void {
		if (this.#disposed || this.session !== session || sequence < this.#latestAppliedUsageRefreshSequence) {
			return;
		}
		this.#latestAppliedUsageRefreshSequence = sequence;
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const activeIdentity =
			activeProvider && session.modelRegistry?.authStorage
				? session.modelRegistry.authStorage.getOAuthAccountIdentity(activeProvider, session.sessionId)
				: undefined;
		const normalized = this.#normalizeUsageReports(reports, activeProvider, activeIdentity);
		const resetSnapshot =
			activeProvider === "openai-codex" ? this.#normalizeCodexResetSnapshot(reports, activeIdentity) : null;
		this.#cachedUsage = normalized;
		this.#usageFetchedAt = Date.now();
		if (!resetSnapshot) return;
		const contextKey = this.#formatUsageContextKey(activeProvider, activeIdentity);
		const previous = this.#codexResetSnapshots.get(contextKey);
		this.#codexResetSnapshots.set(contextKey, resetSnapshot);
		if (!previous || !settings.get("tui.codexResetFireworks")) return;
		const event = detectCodexResetFireworks(previous, resetSnapshot);
		if (event) this.#onCodexResetFireworks?.(event);
	}

	#observeLateUsageRefresh(session: AgentSession, reportsPromise: Promise<unknown>, sequence: number): void {
		void reportsPromise
			.then(reports => {
				this.#applyUsageRefreshReports(session, reports, sequence);
			})
			.catch(() => {
				if (this.#disposed || this.session !== session || sequence < this.#latestAppliedUsageRefreshSequence) {
					return;
				}
				this.#usageFetchedAt = Date.now();
			});
	}

	async #raceUsageRefreshWithSignal(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) throw signal.reason;
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#normalizeCodexResetSnapshot(
		reports: unknown,
		activeIdentity: OAuthAccountIdentity | undefined,
	): CodexResetUsageSnapshot | null {
		if (!Array.isArray(reports)) return null;
		let matchingReport: UsageReport | undefined;
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			if (
				!("provider" in report) ||
				report.provider !== "openai-codex" ||
				!("limits" in report) ||
				!Array.isArray(report.limits)
			) {
				continue;
			}
			// The report boundary above validates the fields this extractor iterates;
			// optional metadata and credit fields are narrowed again before use.
			const usageReport = report as UsageReport;
			if (!codexReportMatchesExactIdentity(usageReport, activeIdentity)) continue;
			matchingReport = usageReport;
			break;
		}
		if (!matchingReport) return null;

		const plan =
			typeof matchingReport.metadata?.planType === "string" && matchingReport.metadata.planType
				? matchingReport.metadata.planType
				: undefined;
		let sevenDay: CodexResetUsageSnapshot["sevenDay"];
		let sevenDayTier: string | undefined;
		for (const limit of matchingReport.limits) {
			if (!limit || typeof limit !== "object") continue;
			const candidate = limit as {
				scope?: { windowId?: string; tier?: string };
				window?: { resetsAt?: number };
				amount?: { usedFraction?: number };
			};
			const fraction = candidate.amount?.usedFraction;
			if (candidate.scope?.windowId !== "7d" || typeof fraction !== "number" || !Number.isFinite(fraction)) {
				continue;
			}
			const tier =
				typeof candidate.scope?.tier === "string" && candidate.scope.tier ? candidate.scope.tier : undefined;
			if (sevenDay && (sevenDayTier === undefined || tier)) continue;
			const resetsAt = candidate.window?.resetsAt;
			sevenDay = {
				percent: fraction * 100,
				resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : undefined,
				tier,
				plan,
			};
			sevenDayTier = tier;
		}

		const fetchedAt = matchingReport.fetchedAt;
		const availableCount = matchingReport.resetCredits?.availableCount;
		const observedAt = typeof fetchedAt === "number" && Number.isFinite(fetchedAt) ? fetchedAt : undefined;
		const savedResets =
			typeof availableCount === "number" && Number.isFinite(availableCount)
				? Math.max(0, Math.trunc(availableCount))
				: undefined;
		if (!sevenDay && savedResets === undefined) return null;
		return { observedAt, sevenDay, savedResets };
	}

	#normalizeUsageReports(
		reports: unknown,
		activeProvider?: string,
		activeIdentity?: OAuthAccountIdentity,
	): {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null {
		if (!Array.isArray(reports)) return null;
		let fiveHour: { percent: number; resetMinutes?: number } | undefined;
		let sevenDay: { percent: number; resetHours?: number } | undefined;
		let fiveHourTier: string | undefined;
		let sevenDayTier: string | undefined;
		const now = Date.now();
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			const provider = (report as { provider?: unknown }).provider;
			if (activeProvider && provider !== activeProvider) continue;
			const limits = (report as { limits?: unknown }).limits;
			if (!Array.isArray(limits)) continue;
			const usageReport = report as UsageReport;
			for (const limit of limits) {
				if (!limit || typeof limit !== "object") continue;
				if (activeIdentity && !limitMatchesActiveAccount(usageReport, limit as UsageLimit, activeIdentity)) {
					continue;
				}
				const l = limit as {
					scope?: { windowId?: string; tier?: string };
					window?: { resetsAt?: number };
					amount?: { usedFraction?: number };
				};
				const fraction = l.amount?.usedFraction;
				if (typeof fraction !== "number") continue;
				const windowId = l.scope?.windowId;
				const tier = l.scope?.tier;
				const resetsAt = l.window?.resetsAt;
				// Accept tiered limits, but prefer untiered (backward compat with Anthropic).
				// An untiered limit always replaces a tiered one; among same-tieredness, first wins.
				if (windowId === "5h" && (!fiveHour || (fiveHourTier !== undefined && !tier))) {
					fiveHour = {
						percent: fraction * 100,
						resetMinutes:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 60_000)) : undefined,
					};
					fiveHourTier = tier || undefined;
				}
				if (windowId === "7d" && (!sevenDay || (sevenDayTier !== undefined && !tier))) {
					sevenDay = {
						percent: fraction * 100,
						resetHours:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 3_600_000)) : undefined,
					};
					sevenDayTier = tier || undefined;
				}
			}
		}
		if (!fiveHour && !sevenDay) return null;
		// Single compact label; prefer the five-hour tier if displayed windows ever disagree.
		const effectiveTier = fiveHourTier ?? sevenDayTier;
		return { tier: effectiveTier, fiveHour, sevenDay };
	}

	/**
	 * Used-tokens / context-window totals for the status-line context% segment,
	 * memoized so the per-event redraw stays O(1) when nothing changed.
	 *
	 * The numerator comes from `session.getContextUsage()`, which anchors on the
	 * last assistant's real prompt-token count — so the bar matches the provider
	 * and the `/context` panel — and reports `null` while that count is unknown
	 * (right after compaction, before the next response). Exposed (non-private)
	 * for unit tests and the collab host's state broadcast.
	 */
	getCachedContextBreakdown(): { usedTokens: number; contextWindow: number } {
		const messages = this.session.messages ?? EMPTY_MESSAGES;
		const modelContextWindow = this.session.model?.contextWindow ?? 0;
		const length = messages.length;
		const lastFingerprint = length > 0 ? messageFingerprint(messages[length - 1]!) : undefined;
		// Bumps when the in-flight pending snapshot is set/cleared. Without it a
		// value computed mid-turn (estimate of the active tail) would survive after
		// the turn ends/aborts, since clearing the snapshot touches no message.
		const contextUsageRevision = this.session.contextUsageRevision ?? 0;

		const systemPrompt = this.session.systemPrompt;
		const tools = this.session.agent?.state?.tools;
		const skills = this.session.skills;

		const cache = this.#contextUsageCache;
		if (
			cache &&
			cache.messagesRef === messages &&
			cache.length === length &&
			cache.lastFingerprint === lastFingerprint &&
			cache.modelContextWindow === modelContextWindow &&
			cache.contextUsageRevision === contextUsageRevision &&
			cache.systemPromptRef === systemPrompt &&
			cache.toolsRef === tools &&
			cache.skillsRef === skills
		) {
			return { usedTokens: cache.usedTokens, contextWindow: cache.contextWindow };
		}

		const usage = this.session.getContextUsage();
		const usedTokens = usage?.tokens ?? 0;
		const contextWindow = usage?.contextWindow ?? modelContextWindow;
		this.#contextUsageCache = {
			messagesRef: messages,
			length,
			lastFingerprint,
			modelContextWindow,
			contextUsageRevision,
			usedTokens,
			contextWindow,
			systemPromptRef: systemPrompt,
			toolsRef: tools,
			skillsRef: skills,
		};
		return { usedTokens, contextWindow };
	}

	#buildSegmentContext(
		width: number,
		segmentOptions: StatusLineSettings["segmentOptions"],
		includePath: boolean,
		includeContext: boolean,
		includeGit: boolean,
		includePr: boolean,
	): SegmentContext {
		const state = this.session.state;

		// Trigger background fetch (5-min TTL); render uses cached value
		this.refreshUsageInBackground();

		// Get usage statistics
		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
		};
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

		let contextWindow = state.model?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		let contextPercent: number | null = 0;
		let contextTokens = 0;
		if (includeContext) {
			const breakdown = this.getCachedContextBreakdown();
			contextTokens = breakdown.usedTokens;
			contextWindow = breakdown.contextWindow || contextWindow;
			contextPercent = contextWindow > 0 ? (breakdown.usedTokens / contextWindow) * 100 : null;
		}

		// Collab guest: context comes from the host's state frames — the local
		// replica does no accounting of its own.
		const collabState = this.#collabStatus?.stateOverride;
		if (collabState?.contextUsage) {
			contextWindow = collabState.contextUsage.contextWindow || contextWindow;
			contextTokens = collabState.contextUsage.tokens ?? contextTokens;
			contextPercent = collabState.contextUsage.percent ?? contextPercent;
		}

		const shouldResolveActiveRepo = this.#gitEnabled() && (includePath || includeGit || includePr);
		const projectDir = getProjectDir();
		const activeRepoCache = shouldResolveActiveRepo
			? this.#resolveActiveRepoCache()
			: { projectDir, activeRepo: null, effectiveGitCwd: projectDir, worktree: null };
		let gitBranch = includeGit || includePr ? this.#getCurrentBranch(activeRepoCache.effectiveGitCwd) : null;
		// A jj repo has no git branch to read: git HEAD is detached (colocated) or
		// absent. A pending reftable resolve owns this cwd as an explicit Git repo,
		// so it must not be mistaken for an absent Git checkout and fall through to
		// an ancestor jj workspace.
		const gitHeadResolvePending = this.#branchResolveActive?.cwd === activeRepoCache.effectiveGitCwd;
		const gitHeadIsJjLike =
			!this.#cachedBranchHasGitRepository &&
			!gitHeadResolvePending &&
			(gitBranch === "detached" || gitBranch === null);
		if (includeGit && gitHeadIsJjLike) {
			gitBranch = this.#getJjBranch(activeRepoCache.effectiveGitCwd) ?? gitBranch;
		}
		const gitStatus = includeGit
			? ((gitHeadIsJjLike ? this.#getJjStatus(activeRepoCache.effectiveGitCwd) : null) ??
				this.#getGitStatus(activeRepoCache.effectiveGitCwd))
			: null;
		const gitPr = includePr ? this.#lookupPr(activeRepoCache.effectiveGitCwd) : null;
		return {
			session: this.session,
			focusedAgentId: this.#focusedAgentId,
			activeRepo: activeRepoCache.activeRepo,
			width,
			options: segmentOptions ?? {},
			compactThinkingLevel: this.#resolveSettings().compactThinkingLevel ?? false,
			planMode: this.#planModeStatus,
			loopMode: this.#loopModeStatus,
			prewalk:
				typeof this.session.getPrewalkState === "function" && this.session.getPrewalkState()
					? { enabled: true }
					: null,
			goalMode: this.#goalModeStatus,
			vibeMode: this.#vibeModeStatus,
			collab: this.#collabStatus,
			usageStats,
			contextPercent,
			contextTokens,
			contextWindow,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
			activeMs: this.getActiveMs(),
			git: {
				branch: gitBranch,
				status: gitStatus,
				pr: gitPr,
			},
			worktree: activeRepoCache.worktree,
			usage: this.#cachedUsage,
		};
	}

	#resolveSettings(): EffectiveStatusLineSettings {
		if (this.#effectiveSettings === undefined) {
			this.#effectiveSettings = this.#computeEffectiveSettings();
		}
		return this.#effectiveSettings;
	}

	#computeEffectiveSettings(): EffectiveStatusLineSettings {
		const preset = this.#settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.#settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.#settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		return {
			...this.#settings,
			leftSegments,
			rightSegments,
			separator: this.#settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
	}

	#subagentBadgeText(): string | undefined {
		if (this.#subagentCount === 0) return undefined;
		return theme.fg("statusLineSubagents", `${theme.icon.agents} ${this.#subagentCount} 个子 Agent`);
	}

	#buildStatusLine(width: number): string {
		const effectiveSettings = this.#resolveSettings();
		const includePath =
			hasPathSegment(effectiveSettings.leftSegments) || hasPathSegment(effectiveSettings.rightSegments);
		const includeContext =
			hasContextSegment(effectiveSettings.leftSegments) || hasContextSegment(effectiveSettings.rightSegments);
		const gitEnabled = this.#gitEnabled();
		const includeGit =
			gitEnabled &&
			(hasGitSegment(effectiveSettings.leftSegments) || hasGitSegment(effectiveSettings.rightSegments));
		const includePr =
			gitEnabled && (hasPrSegment(effectiveSettings.leftSegments) || hasPrSegment(effectiveSettings.rightSegments));
		const ctx = this.#buildSegmentContext(
			width,
			effectiveSettings.segmentOptions,
			includePath,
			includeContext,
			includeGit,
			includePr,
		);
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		// `transparent` reuses the empty-string sentinel (`\x1b[49m`) so the bar
		// inherits the terminal's default background, matching custom themes that
		// set `statusLineBg: ""`. Powerline end caps need a contrasting fill to
		// bridge the bar into the surrounding terminal; without one they read as
		// stray glyphs, so the cap renderer drops them when the fill is empty.
		const TRANSPARENT_BG_ANSI = "\x1b[49m";
		const themeBgAnsi = theme.getBgAnsi("statusLineBg");
		const bgAnsi = effectiveSettings.transparent ? TRANSPARENT_BG_ANSI : themeBgAnsi;
		const transparentBg = bgAnsi === TRANSPARENT_BG_ANSI;
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");
		const subagentBadge = this.#subagentBadgeText();

		// Collect visible segment contents
		const leftParts: string[] = [];
		const leftSegIds: StatusLineSegmentId[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			if (subagentBadge && segId === "subagents") continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				leftParts.push(rendered.content);
				leftSegIds.push(segId);
			}
		}

		const rightParts: string[] = [];
		for (const segId of effectiveSettings.rightSegments) {
			if (subagentBadge && segId === "subagents") continue;
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				rightParts.push(rendered.content);
			}
		}

		const runningBackgroundJobs = this.session.getAsyncJobSnapshot()?.running.length ?? 0;
		if (runningBackgroundJobs > 0) {
			rightParts.unshift(theme.fg("statusLineSubagents", `${theme.icon.job} ${runningBackgroundJobs}`));
		}
		if (subagentBadge) {
			rightParts.unshift(subagentBadge);
		}
		const topFillWidth = Math.max(0, width);
		const left = [...leftParts];
		const right = [...rightParts];

		const leftSepWidth = visibleWidth(separatorDef.left);
		const rightSepWidth = visibleWidth(separatorDef.right);
		// Transparent mode drops powerline caps (they need a bg fill to bridge),
		// so the width budget excludes them too.
		const leftCapWidth = separatorDef.endCaps && !transparentBg ? visibleWidth(separatorDef.endCaps.right) : 0;
		const rightCapWidth = separatorDef.endCaps && !transparentBg ? visibleWidth(separatorDef.endCaps.left) : 0;

		const groupWidth = (parts: string[], capWidth: number, sepWidth: number): number => {
			if (parts.length === 0) return 0;
			const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
			const sepTotal = Math.max(0, parts.length - 1) * (sepWidth + 2);
			return partsWidth + sepTotal + 2 + capWidth;
		};

		let leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		let rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
			}
			// Shrink path before dropping left segments — path is the only elastic segment
			const pathIdx = leftSegIds.indexOf("path");
			if (pathIdx >= 0 && totalWidth() > topFillWidth) {
				const overflow = totalWidth() - topFillWidth;
				const currentPathVW = visibleWidth(left[pathIdx]);
				const minPathVW = 8; // icon + ellipsis + a few chars
				const shrinkable = currentPathVW - minPathVW;
				if (shrinkable > 0) {
					const shrinkBy = Math.min(shrinkable, overflow);
					const currentMaxLen = ctx.options.path?.maxLength ?? 40;
					let newMaxLen = Math.max(4, Math.min(currentMaxLen, currentPathVW) - shrinkBy);
					const pathCtx = (maxLen: number): SegmentContext => ({
						...ctx,
						options: { ...ctx.options, path: { ...ctx.options.path, maxLength: maxLen } },
					});
					let reRendered = renderSegment("path", pathCtx(newMaxLen));
					if (reRendered.visible && reRendered.content) {
						// maxLength governs path text, not icon prefix; iterate to compensate
						for (let i = 0; i < 8; i++) {
							const saved = currentPathVW - visibleWidth(reRendered.content);
							if (saved >= shrinkBy) break;
							const nextMaxLen = Math.max(4, newMaxLen - (shrinkBy - saved));
							if (nextMaxLen >= newMaxLen) break; // no progress or hit floor
							newMaxLen = nextMaxLen;
							const adjusted = renderSegment("path", pathCtx(newMaxLen));
							if (!adjusted.visible || !adjusted.content) break;
							reRendered = adjusted;
						}
						left[pathIdx] = reRendered.content;
						leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
					}
				}
			}
			const leftOverflowDropIndex = (): number => {
				// Preserve the current working directory as long as possible. The
				// previous right-to-left pop could collapse a normal-width bar to
				// just the model segment, hiding the path before less-critical left
				// segments such as model/mode/collab were removed.
				for (let i = leftSegIds.length - 1; i >= 0; i--) {
					if (leftSegIds[i] !== "path") return i;
				}
				return left.length - 1;
			};

			while (totalWidth() > topFillWidth && left.length > 0) {
				const dropIdx = leftOverflowDropIndex();
				left.splice(dropIdx, 1);
				leftSegIds.splice(dropIdx, 1);
				leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
			}
		}

		const renderGroup = (parts: string[], direction: "left" | "right"): string => {
			if (parts.length === 0) return "";
			const sep = direction === "left" ? separatorDef.left : separatorDef.right;
			const cap =
				separatorDef.endCaps && !transparentBg
					? direction === "left"
						? separatorDef.endCaps.right
						: separatorDef.endCaps.left
					: "";
			const capPrefix = separatorDef.endCaps?.useBgAsFg ? bgAnsi.replace("\x1b[48;", "\x1b[38;") : bgAnsi + sepAnsi;
			const capText = cap ? `${capPrefix}${this.#focusedAgentId ? "\x1b[22m" : ""}${cap}\x1b[0m` : "";

			let content = bgAnsi + fgAnsi;
			content += ` ${parts.join(` ${sepAnsi}${sep}${fgAnsi} `)} `;
			content += "\x1b[0m";

			if (capText) {
				return direction === "right" ? capText + content : content + capText;
			}
			return content;
		};

		const leftGroup = renderGroup(left, "left");
		const rightGroup = renderGroup(right, "right");
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		const sessionName =
			effectiveSettings.sessionAccent !== false ? this.session.sessionManager?.getSessionName() : undefined;
		const accentHex = sessionName
			? getSessionAccentHex(sessionName, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance)
			: undefined;
		const gapColor = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("border");
		const gapFill = `${gapColor}${theme.boxRound.horizontal.repeat(gapWidth)}\x1b[39m`;
		return leftGroup + gapFill + rightGroup;
	}

	getTopBorder(width: number): { content: string; width: number } {
		let content = this.#buildStatusLine(width);
		if (this.#focusedAgentId && content) {
			// Dim the whole bar while focus-proxied. Group/cap terminators emit full
			// `\x1b[0m` resets that would cancel faint mid-bar, so re-open it after each.
			content = `\x1b[2m${content.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")}\x1b[22m`;
		}
		return {
			content,
			width: visibleWidth(content),
		};
	}

	render(width: number): readonly string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			return [];
		}

		return Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => truncateToWidth(sanitizeStatusText(text), width));
	}
}
