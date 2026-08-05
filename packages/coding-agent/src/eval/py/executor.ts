import * as fs from "node:fs";
import * as path from "node:path";

import { getProjectDir, logger } from "@wxyhgk/pi-utils";
import type { ToolSession } from "../../tools";
import {
	attachSessionOwner,
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	resolveOwnerScopedSessionKey,
	type SessionOwners,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { JsStatusEvent } from "../js/shared/types";
import {
	checkPythonKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "./kernel";
import { resolveExplicitPythonRuntime } from "./runtime";
import { ensurePyToolBridge } from "./tool-bridge";

export type PythonKernelMode = "session" | "per-call";

export interface PythonExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Absolute wall-clock deadline in milliseconds since epoch */
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used only for timeout-annotation text when the
	 * caller drives cancellation via the eval watchdog `signal` instead of a
	 * wall-clock `deadlineMs`/`timeoutMs`. Does not arm a timer.
	 */
	idleTimeoutMs?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => Promise<void> | void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session identifier for kernel reuse */
	sessionId?: string;
	/** Logical owner identifier for retained kernel cleanup */
	kernelOwnerId?: string;
	/** Kernel mode (session reuse vs per-call) */
	kernelMode?: PythonKernelMode;
	/**
	 * Explicit interpreter path (`python.interpreter` resolved from the
	 * session's settings). Skips automatic runtime discovery when set.
	 */
	interpreter?: string;
	/** Restart the kernel before executing */
	reset?: boolean;
	/** Session file path for accessing task outputs */
	sessionFile?: string;
	/**
	 * Effective artifacts directory for the current session. Subagents share
	 * the parent's directory, so this can differ from `sessionFile`'s sibling
	 * dir. When present, exported to the kernel as `PI_ARTIFACTS_DIR` and
	 * preferred over `PI_SESSION_FILE`-derived paths.
	 */
	artifactsDir?: string;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * On-disk roots the prelude helpers (`read`/`write`) substitute for
	 * internal-URL schemes (e.g. `{ local: "/…/artifacts/local" }`). Exported to
	 * the kernel as `PI_EVAL_LOCAL_ROOTS` (JSON) so `write("local://x")` lands
	 * where `read local://x` resolves instead of a literal `local:/` directory.
	 */
	localRoots?: Record<string, string>;
	/**
	 * ToolSession used to resolve host-side `tool.<name>(args)` calls made from
	 * the Python prelude's bridge proxy. When omitted, the bridge env vars are
	 * not injected and any `tool.foo(...)` raises in Python.
	 */
	toolSession?: ToolSession;
	/** Callback for status events emitted by tool bridge invocations. */
	emitStatus?: (event: JsStatusEvent) => void;
	/**
	 * Live status events streamed as they are emitted (both host-side bridge
	 * helpers like `agent()` and kernel-side `display`/`log`/`phase`). Mirrors
	 * what lands in `displayOutputs` so callers can render progress before the
	 * cell finishes.
	 */
	onStatus?: (event: JsStatusEvent) => void;
	/** @internal Bridge session id, set by `executePython` before delegating. */
	bridgeSessionId?: string;
	/** @internal Bridge endpoint info, set by `executePython` before delegating. */
	bridge?: { url: string; token: string };
}

export interface PythonKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface PythonResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Execution exit code (0 ok, 1 error, undefined if cancelled) */
	exitCode: number | undefined;
	/** Whether the execution was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Artifact ID if full output was saved to artifact storage */
	artifactId?: string;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
	/** Rich display outputs captured from display_data/execute_result */
	displayOutputs: KernelDisplayOutput[];
	/** Whether stdin was requested */
	stdinRequested: boolean;
}

// ---------------------------------------------------------------------------
// Session bookkeeping
//
// One PythonKernel subprocess per (session id, cwd, interpreter) tuple. The
// runner mutates process-global cwd/sys.path during execution, so cross-directory
// work must never share a live kernel. Multiple agent owners can still register against
// the same tuple; the kernel stays alive until the last owner detaches.
// ---------------------------------------------------------------------------

interface SessionKernelReplacement {
	generation: number;
	deadlineMs?: number;
	promise: Promise<PythonKernel>;
}

interface PythonSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: PythonKernel;
	generation: number;
	replacement?: SessionKernelReplacement;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

interface StartingPythonSession extends SessionOwners {
	promise: Promise<PythonSession>;
}

const sessions = new Map<string, PythonSession>();
const startingSessions = new Map<string, StartingPythonSession>();
const resettingSessions = new Map<string, Promise<void>>();

function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitPythonRuntime(interpreter, cwd, {}).pythonPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function buildSessionKey(sessionId: string, cwd: string, interpreter: string | undefined): string {
	const normalizedCwd = normalizeSessionCwd(cwd);
	return `${sessionId}\0${normalizedCwd}\0${normalizeExplicitInterpreter(normalizedCwd, interpreter)}`;
}

// ---------------------------------------------------------------------------
// Cancellation plumbing
// ---------------------------------------------------------------------------

class PythonExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "命令超时" : "命令已中止");
		this.name = "PythonExecutionCancelledError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new PythonExecutionCancelledError(true);
	}
	return remainingMs;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return "命令超时";
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `命令在 ${secs} 秒后超时`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	if (kernelKilled) {
		return "eval 单元超时且内核未响应中断;内核已被终止,将在下次调用时重新创建。";
	}
	const duration = secs === undefined ? "配置的超时时间" : `${secs}s`;
	return `eval 单元在 ${duration} 后超时;内核已中断但仍保持运行。若状态疑似损坏,可通过 { reset: true } 重置内核。`;
}

function createCancelledPythonResult(timedOut: boolean, timeoutMs?: number): PythonResult {
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "命令超时") : "";
	return createCancelledKernelResult(output);
}

// ---------------------------------------------------------------------------
// Kernel start helpers
// ---------------------------------------------------------------------------

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await PythonKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
	});
}

async function acquireSession(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<PythonSession> {
	const existing = sessions.get(sessionKey);
	if (existing) {
		attachSessionOwner(existing, sessionId, options.kernelOwnerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		attachSessionOwner(starting, sessionId, options.kernelOwnerId);
		return await starting.promise;
	}
	let startingSession!: StartingPythonSession;
	const startup = (async () => {
		const kernel = await startKernel(cwd, options);
		const session: PythonSession = {
			sessionKey,
			sessionId,
			cwd,
			kernel,
			generation: 0,
			ownerIds: new Set(startingSession.ownerIds),
			hasFallbackOwner: startingSession.hasFallbackOwner,
		};
		// Publish only while this startup still owns the key: owner disposal or
		// a concurrent dispose-all may have already reaped the starting record,
		// and publishing here would resurrect a kernel that was just torn down.
		if (startingSessions.get(sessionKey) === startingSession) {
			sessions.set(sessionKey, session);
		}
		return session;
	})();
	startingSession = {
		ownerIds: new Set(),
		hasFallbackOwner: false,
		promise: startup,
	};
	attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
	startingSessions.set(sessionKey, startingSession);
	try {
		return await startup;
	} finally {
		if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
	}
}

async function replaceSessionKernel(
	session: PythonSession,
	kernel: PythonKernel,
	generation: number,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<PythonKernel> {
	const inFlight = session.replacement;
	if (inFlight?.generation === generation) {
		if (
			inFlight.deadlineMs !== undefined &&
			(options.deadlineMs === undefined || options.deadlineMs > inFlight.deadlineMs)
		) {
			inFlight.deadlineMs = options.deadlineMs;
		}
		return await waitForPromiseWithCancellation(inFlight.promise, options, PythonExecutionCancelledError);
	}
	if (sessions.get(session.sessionKey) !== session || session.generation !== generation || session.kernel !== kernel) {
		throw new PythonExecutionCancelledError(false);
	}

	const deferred = Promise.withResolvers<PythonKernel>();
	const replacement: SessionKernelReplacement = {
		generation,
		deadlineMs: options.deadlineMs,
		promise: deferred.promise,
	};
	session.replacement = replacement;
	void (async () => {
		try {
			const remaining = getRemainingTimeoutMs(options.deadlineMs);
			await kernel
				.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
				.catch(() => undefined);
			if (replacement.deadlineMs !== undefined && replacement.deadlineMs <= Date.now()) {
				throw new PythonExecutionCancelledError(true);
			}
			if (
				sessions.get(session.sessionKey) !== session ||
				session.generation !== generation ||
				session.kernel !== kernel
			) {
				throw new PythonExecutionCancelledError(false);
			}
			const next = await startKernel(cwd, {
				...options,
				signal: undefined,
				deadlineMs: undefined,
			});
			if (
				sessions.get(session.sessionKey) !== session ||
				session.generation !== generation ||
				session.kernel !== kernel
			) {
				await next.shutdown().catch(() => undefined);
				throw new PythonExecutionCancelledError(false);
			}
			session.kernel = next;
			session.generation += 1;
			deferred.resolve(next);
		} catch (err) {
			deferred.reject(err);
		} finally {
			if (session.replacement === replacement) session.replacement = undefined;
		}
	})();
	return await waitForPromiseWithCancellation(deferred.promise, options, PythonExecutionCancelledError);
}

async function shutdownInvalidatedSession(session: PythonSession): Promise<KernelShutdownResult> {
	const replacement = session.replacement;
	if (replacement) await replacement.promise.catch(() => undefined);
	return await session.kernel.shutdown();
}

async function acquireLiveSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<PythonKernel> {
	while (sessions.get(session.sessionKey) === session) {
		const kernel = session.kernel;
		const generation = session.generation;
		if (kernel.isAlive()) return kernel;
		await replaceSessionKernel(session, kernel, generation, cwd, options);
	}
	throw new PythonExecutionCancelledError(false);
}

async function resetSession(sessionKey: string): Promise<void> {
	const existing =
		sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!existing) return;
	existing.generation += 1;
	sessions.delete(sessionKey);
	await shutdownInvalidatedSession(existing).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Public dispose entry points
// ---------------------------------------------------------------------------

export async function disposeAllKernelSessions(): Promise<void> {
	const pending = [...startingSessions.values()].map(starting => starting.promise);
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = [...sessions.entries()];
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.some(([, session]) => session === result.value)) {
			all.push([result.value.sessionKey, result.value]);
		}
	}
	for (const [id, session] of all) {
		session.generation += 1;
		if (sessions.get(id) === session) sessions.delete(id);
	}
	const results = await Promise.allSettled(all.map(([, session]) => shutdownInvalidatedSession(session)));
	for (let i = 0; i < all.length; i += 1) {
		const [id, session] = all[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
		const reason = result.status === "rejected" ? result.reason : "未确认";
		logger.warn("Python 内核关闭未确认", {
			sessionId: session.sessionId,
			sessionKey: id,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(id)) sessions.set(id, session);
	}
}

export async function disposeKernelSessionsByOwner(ownerId: string): Promise<void> {
	const toShutdown: PythonSession[] = [];
	for (const session of [...sessions.values()]) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toShutdown.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	const startingToShutdown: StartingPythonSession[] = [];
	for (const [sessionKey, starting] of [...startingSessions.entries()]) {
		if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
		if (starting.ownerIds.size === 1) {
			startingSessions.delete(sessionKey);
			startingToShutdown.push(starting);
			continue;
		}
		starting.ownerIds.delete(ownerId);
	}
	for (const session of toShutdown) {
		session.generation += 1;
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		const session = result.value;
		session.generation += 1;
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		toShutdown.push(session);
	}
	const results = await Promise.allSettled(toShutdown.map(session => shutdownInvalidatedSession(session)));
	for (let i = 0; i < toShutdown.length; i += 1) {
		const session = toShutdown[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) {
			session.ownerIds.delete(ownerId);
			continue;
		}
		const reason = result.status === "rejected" ? result.reason : "未确认";
		logger.warn("Python 内核关闭未确认", {
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
	}
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executeWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options: PythonExecutorOptions | undefined,
): Promise<PythonResult> {
	return executeWithKernelBase<PythonExecutorOptions>({
		kernel,
		code,
		options,
		runIdPrefix: "py",
		errorLogLabel: "Python",
		cancelledErrorClass: PythonExecutionCancelledError,
		buildKernelEnvPatch: buildManagedKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
	});
}

async function ensureKernelAvailable(cwd: string, options: PythonExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkPythonKernelAvailability(cwd, options.interpreter),
		options,
		PythonExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python 内核不可用");
	}
}

async function ensureToolBridge(options: PythonExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("启动 Python 工具桥接失败", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function executePerCall(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = `py-bridge:${crypto.randomUUID()}`;
	}
	const kernel = await startKernel(cwd, options);
	try {
		return await executeWithKernel(kernel, code, { ...options, cwd });
	} finally {
		await kernel.shutdown().catch(() => undefined);
	}
}

async function executeOnSession(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = resolveOwnerScopedSessionKey({
		baseKey: buildSessionKey(sessionId, cwd, options.interpreter),
		ownerId: options.kernelOwnerId,
		reset: options.reset === true,
		hasSession: key => sessions.has(key) || startingSessions.has(key),
		getOwners: key => sessions.get(key) ?? startingSessions.get(key),
	});
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = sessionId;
	}
	if (options.reset) {
		// Coalesce concurrent resets: if another reset is in flight for this
		// session, await it instead of throwing — the caller's intent ("start
		// from a clean kernel") is satisfied once that reset settles.
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetSession(sessionKey);
			resettingSessions.set(
				sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(sessionKey);
			}
		}
	} else {
		// A reset already in progress is an internal coordination state, not a
		// user-visible failure. Wait for it to clear, then proceed with the
		// requested execution on the freshly-restarted kernel.
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const session = await acquireSession(sessionKey, sessionId, cwd, options);
	if (options.signal?.aborted) {
		throw new PythonExecutionCancelledError(
			isTimedOutCancellation(options.signal.reason, PythonExecutionCancelledError, options.signal),
		);
	}
	const kernel = await acquireLiveSessionKernel(session, cwd, options);
	if (sessions.get(session.sessionKey) !== session || session.kernel !== kernel) {
		throw new PythonExecutionCancelledError(false);
	}
	const runOptions = { ...options, cwd };
	try {
		return await executeWithKernel(kernel, code, runOptions);
	} catch (err) {
		if (isCancellationError(err, PythonExecutionCancelledError) || options.signal?.aborted) throw err;
		if (kernel.isAlive()) throw err;
		const retryKernel = await acquireLiveSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session || session.kernel !== retryKernel) {
			throw new PythonExecutionCancelledError(false);
		}
		return await executeWithKernel(retryKernel, code, runOptions);
	}
}

export async function executePythonWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options?: PythonExecutorOptions,
): Promise<PythonResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executePython(code: string, options?: PythonExecutorOptions): Promise<PythonResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: PythonExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new PythonExecutionCancelledError(
				isTimedOutCancellation(
					executionOptions.signal.reason,
					PythonExecutionCancelledError,
					executionOptions.signal,
				),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);

		const kernelMode = executionOptions.kernelMode ?? "session";
		if (kernelMode === "per-call") {
			return await executePerCall(code, cwd, executionOptions);
		}
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err, PythonExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledPythonResult(
				isTimedOutCancellation(err, PythonExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}
