/**
 * Extension runner - executes extensions and manages their lifecycle.
 */
import type {
	AgentMessage,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@wxyhgk/pi-agent-core";
import type { CredentialDisabledEvent, ImageContent, Model, ProviderResponseMetadata } from "@wxyhgk/pi-ai";
import type { KeyId } from "@wxyhgk/pi-tui";
import { logger } from "@wxyhgk/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AsyncJobSnapshot } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import type { BranchHandler, NavigateTreeHandler, NewSessionHandler } from "../session-handler-types";
import { ManagedTimers } from "./managed-timers";
import { createExtensionModelQuery } from "./model-api";
import type {
	AfterProviderResponseEvent,
	AssistantThinkingRenderer,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	InputEvent,
	InputEventResult,
	McpNotificationEvent,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	SessionStopEvent,
	SessionStopEventResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
	UserPythonEvent,
	UserPythonEventResult,
} from "./types";

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string[];
}

export type ExtensionErrorListener = (error: ExtensionError) => void;

export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;
let extensionHandlerTimeoutMs = EXTENSION_HANDLER_TIMEOUT_MS;

function throwUnsupportedServiceTierAction(): never {
	throw new Error("此扩展宿主不支持服务层级操作");
}

export function testSetExtensionHandlerTimeoutMs(timeoutMs: number): void {
	extensionHandlerTimeoutMs = timeoutMs;
}

/**
 * Dedicated cap for `session_shutdown` handlers. The generic 30s budget is
 * appropriate for events extensions can observe (e.g. `session_start`,
 * `before_provider_request`), but `session_shutdown` is fire-and-forget
 * teardown — extensions receive no result and the user has already asked to
 * leave. A hung handler (e.g. an extension waiting on a stuck IPC pipe to a
 * companion app) MUST NOT hold Ctrl+C / `/exit` hostage for the full window.
 * See issue #2600.
 */
export const SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000;
let sessionShutdownHandlerTimeoutMs = SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS;

export function testSetSessionShutdownHandlerTimeoutMs(timeoutMs: number): void {
	sessionShutdownHandlerTimeoutMs = timeoutMs;
}

/** Per-event handler budget. Defaults to the generic cap; `session_shutdown`
 *  uses its own short cap so teardown stays prompt. */
function handlerTimeoutForEvent(eventType: string): number {
	return eventType === "session_shutdown" ? sessionShutdownHandlerTimeoutMs : extensionHandlerTimeoutMs;
}

const EXTENSION_HANDLER_TIMEOUT = Symbol("extensionHandlerTimeout");
const EXTENSION_HANDLER_ABORTED = Symbol("extensionHandlerAborted");

function attachHandlerSignal(
	dialogOptions: ExtensionUIDialogOptions | undefined,
	handlerSignal: AbortSignal,
): ExtensionUIDialogOptions {
	if (!dialogOptions) return { signal: handlerSignal };
	if (!dialogOptions.signal) return { ...dialogOptions, signal: handlerSignal };
	if (dialogOptions.signal === handlerSignal) return dialogOptions;
	return { ...dialogOptions, signal: AbortSignal.any([dialogOptions.signal, handlerSignal]) };
}

function createHandlerUIContext(ui: ExtensionUIContext, handlerSignal: AbortSignal): ExtensionUIContext {
	const askDialog = ui.askDialog;
	const dialogMethods = {
		select: (title, options, dialogOptions) =>
			ui.select(title, options, attachHandlerSignal(dialogOptions, handlerSignal)),
		confirm: (title, message, dialogOptions) =>
			ui.confirm(title, message, attachHandlerSignal(dialogOptions, handlerSignal)),
		input: (title, placeholder, dialogOptions) =>
			ui.input(title, placeholder, attachHandlerSignal(dialogOptions, handlerSignal)),
		askDialog: askDialog
			? (questions, dialogOptions) =>
					askDialog.call(ui, questions, attachHandlerSignal(dialogOptions, handlerSignal))
			: undefined,
		editor: (title, prefill, dialogOptions, editorOptions) =>
			ui.editor(title, prefill, attachHandlerSignal(dialogOptions, handlerSignal), editorOptions),
	} satisfies Pick<ExtensionUIContext, "select" | "confirm" | "input" | "askDialog" | "editor">;
	const delegatedMethods = new Map<PropertyKey, unknown>();

	return new Proxy(ui, {
		get(target, property) {
			if (Object.hasOwn(dialogMethods, property)) {
				return Reflect.get(dialogMethods, property, dialogMethods);
			}
			const cached = delegatedMethods.get(property);
			if (cached) return cached;
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const delegated: unknown = value.bind(target);
			delegatedMethods.set(property, delegated);
			return delegated;
		},
	});
}

/**
 * Scope `ctx` to a single handler run without spreading it: `{ ...ctx }` would
 * snapshot live accessors (notably the `model` getter), so a handler calling
 * `pi.setModel()` and then reading `ctx.model` would see a stale model.
 * Prototype delegation keeps every getter live while overriding `ui`.
 */
function createHandlerContext(ctx: ExtensionContext, handlerSignal: AbortSignal): ExtensionContext {
	const scoped: ExtensionContext = Object.create(ctx);
	Object.defineProperty(scoped, "ui", {
		value: createHandlerUIContext(ctx.ui, handlerSignal),
		enumerable: true,
		configurable: true,
	});
	return scoped;
}

/**
 * Race `work` against a `timeoutMs` budget and optional cancellation signal,
 * clearing the timer and abort listener as soon as one branch settles.
 *
 * We deliberately avoid `Bun.sleep(timeoutMs).then(...)` here: that leaves an
 * uncancellable timer registered with the event loop, so every successful
 * handler race leaks a timer that keeps the process alive until the deadline
 * fires — up to the default 30s cap, which stalls non-interactive CLI exit
 * after any subscribed `tool_call`/`tool_result` handler runs (issue #3948
 * review, `chatgpt-codex-connector[bot]`). `setTimeout` returns a handle we
 * can `clearTimeout` on the winning branch.
 */
async function raceHandlerWithTimeout<T>(
	work: (handlerSignal: AbortSignal) => Promise<T> | T,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T | typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED> {
	if (signal?.aborted) return EXTENSION_HANDLER_ABORTED;

	const timeoutController = new AbortController();
	const handlerSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
	const { promise: interruptPromise, resolve: resolveInterrupt } = Promise.withResolvers<
		typeof EXTENSION_HANDLER_TIMEOUT | typeof EXTENSION_HANDLER_ABORTED
	>();
	const onAbort = () => resolveInterrupt(EXTENSION_HANDLER_ABORTED);
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timeoutController.abort(new DOMException(`Handler timed out after ${timeoutMs}ms`, "TimeoutError"));
		resolveInterrupt(EXTENSION_HANDLER_TIMEOUT);
	}, timeoutMs);
	try {
		if (signal?.aborted) return EXTENSION_HANDLER_ABORTED;
		const workPromise = Promise.resolve(work(handlerSignal));
		const result = await Promise.race([workPromise, interruptPromise]);
		if (result === EXTENSION_HANDLER_TIMEOUT) {
			await Promise.race([
				workPromise.then(
					() => undefined,
					() => undefined,
				),
				Bun.sleep(0),
			]);
		}
		return result;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

const MAX_PENDING_CREDENTIAL_DISABLED = 32;

/**
 * Buffer cap for `mcp_notification` events received before {@link ExtensionRunner.initialize}
 * has run. Sized to match the manager-side buffer in `MCPManager.NOTIFICATION_BUFFER_CAP` so
 * the two layers can't drop different amounts of the same burst — the pipe drains, or it
 * spills, but it does so consistently at both ends. Drop-oldest under pressure.
 */
const MAX_PENDING_MCP_NOTIFICATIONS = 100;

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeBranchResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_branch" }
		? SessionBeforeBranchResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: TEvent extends { type: "session.compacting" }
					? SessionCompactingResult | undefined
					: TEvent extends { type: "session_stop" }
						? SessionStopEventResult | undefined
						: undefined;

// Session-lifecycle handler types live once in session-handler-types (imported
// above for local use); re-exported here to keep this module's public API stable.
export type { BranchHandler, NavigateTreeHandler, NewSessionHandler };

export type SwitchSessionHandler = (sessionPath: string) => Promise<{ cancelled: boolean }>;

export type ShutdownHandler = () => void;

/**
 * Emit `session_shutdown` and clear timers owned by an extension runner.
 *
 * Returns whether any shutdown handlers were present. Timer cleanup runs even
 * when a handler fails so extension background work cannot outlive its host.
 */
export async function emitSessionShutdownEvent(extensionRunner: ExtensionRunner | undefined): Promise<boolean> {
	if (!extensionRunner) return false;
	try {
		if (!extensionRunner.hasHandlers("session_shutdown")) return false;
		await extensionRunner.emit({
			type: "session_shutdown",
		});
		return true;
	} finally {
		extensionRunner.clearManagedTimers();
	}
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: (_theme: string | Theme) => Promise.resolve({ success: false, error: "UI 不可用" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	#uiContext: ExtensionUIContext;
	#errorListeners: Set<ExtensionErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasPendingMessagesFn: () => boolean = () => false;
	#getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	#compactFn: (instructionsOrOptions?: string | CompactOptions) => Promise<void> = async () => {};
	#getSystemPromptFn: () => string[] = () => [];
	#getAsyncJobSnapshotFn: () => AsyncJobSnapshot | null = () => null;
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	#switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	#reloadHandler: () => Promise<void> = async () => {};
	#shutdownHandler: ShutdownHandler = () => {};
	#getMemoryFn?: () => MemoryRuntimeContext | undefined;
	#commandDiagnostics: Array<{ type: string; message: string; path: string }> = [];
	#initialized = false;
	/**
	 * Buffer for `credential_disabled` events received via {@link emitCredentialDisabled}
	 * before {@link initialize} has run. Drained through {@link emit} once initialize sets
	 * up the runtime context, so extension handlers see a populated UI/runtime context
	 * rather than the constructor's no-op default. Bounded at
	 * {@link MAX_PENDING_CREDENTIAL_DISABLED}; oldest entries are dropped under pressure.
	 */
	#pendingCredentialDisabled: CredentialDisabledEvent[] = [];

	/**
	 * Buffer for `mcp_notification` events received via {@link emitMcpNotification} before
	 * {@link initialize} has run. Two-layer race: `MCPManager` also buffers frames until
	 * its first `addNotificationListener` subscriber attaches, but the sdk.ts bridge is
	 * registered inside `createAgentSession` — BEFORE the mode controller calls
	 * `ExtensionRunner.initialize()`. Without this second buffer, the manager's drain
	 * arrives at the bridge → the bridge calls `emitMcpNotification` → the runner drops
	 * the frame because `#initialized === false`, and the frame evaporates a second time.
	 * Bounded at {@link MAX_PENDING_MCP_NOTIFICATIONS}; oldest entries are dropped under
	 * pressure. Drained in {@link initialize} once the runtime/UI context is wired.
	 */
	#pendingMcpNotifications: Array<Omit<McpNotificationEvent, "type">> = [];

	/**
	 * Timers scheduled by extensions through the sanctioned `ctx.setInterval` /
	 * `ctx.setTimeout` helpers. Callbacks run with the same isolation as handler
	 * dispatch — a throw is logged and routed through {@link onError} instead of
	 * escaping to the process `uncaughtException` handler and tearing down the
	 * whole session (issue #5664). Handles are `unref`'d and every outstanding
	 * timer is cleared on session teardown via {@link clearManagedTimers}.
	 */
	#managedTimers = new ManagedTimers((event, error, stack) =>
		this.emitError({ extensionPath: "<timer>", event, error, stack }),
	);
	/**
	 * Dedup markers for `tool_call` emission, keyed `${toolCallId}:${toolName}`.
	 * The agent loop emits `tool_call` at arg-prep time (before scheduling and
	 * `tool_execution_start`) via the session's `beforeToolCall` wiring; the
	 * marker tells `ExtensionToolWrapper.execute` not to emit a second event for
	 * the same dispatch. Keyed by call id + tool name because a nested xd://
	 * device dispatch reuses the model's toolCallId under a different tool name
	 * and must still emit its own event. Bounded: markers for calls whose
	 * execute path never runs (policy deny, validation failure) would otherwise
	 * accumulate for the session's lifetime.
	 */
	#emittedToolCalls = new Set<string>();

	/** Records that the loop already emitted `tool_call` for this dispatch. */
	markToolCallEmitted(toolCallId: string, toolName: string): void {
		if (this.#emittedToolCalls.size >= 512) {
			const oldest = this.#emittedToolCalls.values().next().value;
			if (oldest !== undefined) this.#emittedToolCalls.delete(oldest);
		}
		this.#emittedToolCalls.add(`${toolCallId}:${toolName}`);
	}

	/** Consumes a {@link markToolCallEmitted} marker; true when the loop already emitted. */
	consumeToolCallEmitted(toolCallId: string, toolName: string): boolean {
		return this.#emittedToolCalls.delete(`${toolCallId}:${toolName}`);
	}

	/**
	 * Resolves a tool NAME to its native built-in implementation (the pre-extension-override,
	 * unwrapped tool) plus a factory for the `AgentToolContext` that native tool expects, or
	 * undefined when no native built-in of that name exists. Set by the SDK; backs same-tool
	 * `invokeTool`. The context factory is the same one the agent loop uses for tool execution, so a
	 * delegated native call sees the ordinary session tool context (ui, cwd, snapshot state, etc.).
	 */
	#nativeToolResolver?: (name: string) => { tool: AgentTool; makeContext: () => AgentToolContext } | undefined;

	/** Wires the native-tool resolver used by {@link invokeNativeTool}. */
	setNativeToolResolver(
		resolve: (name: string) => { tool: AgentTool; makeContext: () => AgentToolContext } | undefined,
	): void {
		this.#nativeToolResolver = resolve;
	}

	/** Whether a native built-in of `name` is available to delegate to. */
	hasNativeTool(name: string): boolean {
		return this.#nativeToolResolver?.(name) !== undefined;
	}

	/**
	 * Run the native built-in of `name` with `params` and return its result — the delegation target
	 * of a same-tool `ctx.invokeTool`. Calls the unwrapped native `execute` directly with the loop's
	 * ordinary tool context, so it inherits the caller's already-granted approval (the caller is the
	 * same tool) rather than re-running the gate. `depth` guards a wrapper that recurses into itself;
	 * it is per call chain (threaded from the caller), not session-global, so concurrent independent
	 * delegations do not interfere.
	 */
	async invokeNativeTool<TDetails = unknown>(
		name: string,
		params: Record<string, unknown>,
		options?: {
			signal?: AbortSignal;
			onUpdate?: AgentToolUpdateCallback<TDetails>;
			depth?: number;
			/**
			 * The caller tool's own context. Reused for the native call so metadata the native tool
			 * reads — `toolCall` (write/edit LSP batch flushing) and provider metadata /
			 * `providerSafetyApproved` (computer) — is preserved. Falls back to a fresh session tool
			 * context only when the caller had none.
			 */
			callerContext?: AgentToolContext;
		},
	): Promise<AgentToolResult<TDetails>> {
		const resolved = this.#nativeToolResolver?.(name);
		if (!resolved) throw new Error(`invokeTool:不存在名为 “${name}” 的内置原生工具可供委托`);
		const depth = options?.depth ?? 0;
		if (depth >= 8) {
			throw new Error(`invokeTool:委托深度超过 8(对 “${name}” 的递归 invokeTool?)`);
		}
		const toolCallId = `invoke-${name}-${Date.now().toString(36)}-${depth}`;
		return (await resolved.tool.execute(
			toolCallId,
			params as never,
			options?.signal,
			options?.onUpdate as never,
			options?.callerContext ?? resolved.makeContext(),
		)) as AgentToolResult<TDetails>;
	}

	constructor(
		private readonly extensions: Extension[],
		private readonly runtime: ExtensionRuntime,
		/** Ignored: `cwd` is always read live via the `cwd` getter below, not cached here. */
		_initialCwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
		getMemory?: () => MemoryRuntimeContext | undefined,
		private readonly settings?: Settings,
		private readonly localProtocolOptions?: LocalProtocolOptions,
		getAsyncJobSnapshot?: () => AsyncJobSnapshot | null,
	) {
		this.#uiContext = noOpUIContext;
		this.#getMemoryFn = getMemory;
		this.#getAsyncJobSnapshotFn = getAsyncJobSnapshot ?? (() => null);
	}

	/**
	 * Live session directory, not a session-start snapshot: `/move`
	 * (`SessionManager.moveTo()`) relocates the owning session by updating
	 * `sessionManager`'s own `#cwd`, not a process-global. Reading it here
	 * via the getter — instead of caching the constructor-time value in a
	 * field — keeps every `ExtensionContext` built below in sync with this
	 * session's actual, current directory. Deliberately `sessionManager.getCwd()`
	 * rather than `getProjectDir()`: the latter is a single process-wide value
	 * that only the interactive TUI's `/move` handler happens to also update
	 * (`InteractiveModeContext#applyCwdChange`) — an SDK/ACP host running
	 * several concurrent sessions each with their own `cwd` (see
	 * `CreateAgentSessionOptions.cwd`) must never have one session's move
	 * leak into another's `ctx.cwd` by reading a shared global.
	 */
	get cwd(): string {
		return this.sessionManager.getCwd();
	}

	initialize(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.getServiceTiers = actions.getServiceTiers ?? throwUnsupportedServiceTierAction;
		this.runtime.setServiceTier = actions.setServiceTier ?? throwUnsupportedServiceTierAction;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setSessionName = actions.setSessionName;

		// Context actions (required)
		this.#getModel = contextActions.getModel;
		this.#isIdleFn = contextActions.isIdle;
		this.#abortFn = contextActions.abort;
		this.#hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.#shutdownHandler = contextActions.shutdown;
		this.#getSystemPromptFn = contextActions.getSystemPrompt;

		// Command context actions (optional, only for interactive mode)
		if (commandContextActions) {
			this.#waitForIdleFn = commandContextActions.waitForIdle;
			this.#newSessionHandler = commandContextActions.newSession;
			this.#branchHandler = commandContextActions.branch;
			this.#navigateTreeHandler = commandContextActions.navigateTree;
			this.#switchSessionHandler = commandContextActions.switchSession;
			this.#reloadHandler = commandContextActions.reload;
			this.#getContextUsageFn = commandContextActions.getContextUsage;
			this.#compactFn = commandContextActions.compact;
		}

		this.#uiContext = uiContext ?? noOpUIContext;
		this.#initialized = true;

		// Drain events buffered by emitCredentialDisabled() before initialize ran. The
		// spread adds the `type` discriminator — `event` is the pi-ai shape (no `type`).
		// Deferred by one microtask so callers that register an onError listener
		// synchronously after initialize() see handler errors routed through it.
		const pending = this.#pendingCredentialDisabled.splice(0);
		queueMicrotask(() => {
			for (const event of pending) {
				this.emit({ type: "credential_disabled", ...event }).catch((error: unknown) => {
					logger.warn("credential_disabled handler threw during initialize flush", {
						provider: event.provider,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});

		// Drain events buffered by emitMcpNotification() before initialize ran, using the
		// same deferred-microtask ordering as the credential-disabled drain above so any
		// onError listener registered synchronously after initialize() still catches
		// handler errors during flush.
		const pendingMcp = this.#pendingMcpNotifications.splice(0);
		queueMicrotask(() => {
			for (const event of pendingMcp) {
				this.emit({ type: "mcp_notification", ...event }).catch((error: unknown) => {
					logger.warn("mcp_notification handler threw during initialize flush", {
						server: event.server,
						method: event.method,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});
	}

	/**
	 * Forward a `credential_disabled` event from `AuthStorage` to extension handlers.
	 *
	 * If {@link initialize} has not yet run, the event is buffered and replayed once
	 * initialize wires the runtime/UI context. This matters because mode controllers
	 * (interactive, RPC, ACP, print, subagent) call `initialize()` AFTER `createAgentSession`
	 * returns, but `AuthStorage` can fire `credential_disabled` during startup model probes
	 * inside `createAgentSession()`. Without deferral, extension handlers would observe
	 * `hasUI=false`, an unset model, and no-op runtime actions on exactly the headline
	 * "OAuth invalid_grant during startup" path the event was designed to surface.
	 *
	 * Always returns; never throws. Errors from handlers are routed through
	 * {@link onError} via {@link emit}'s normal isolation.
	 */
	async emitCredentialDisabled(event: CredentialDisabledEvent): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingCredentialDisabled.length >= MAX_PENDING_CREDENTIAL_DISABLED) {
				this.#pendingCredentialDisabled.shift();
			}
			this.#pendingCredentialDisabled.push(event);
			return;
		}
		await this.emit({ type: "credential_disabled", ...event });
	}

	/**
	 * Forward an MCP server notification to extension handlers.
	 *
	 * If {@link initialize} has not yet run, the notification is buffered and replayed
	 * once initialize wires the runtime/UI context. Matches the credential-disabled
	 * deferral above: the sdk.ts bridge registers `MCPManager.addNotificationListener`
	 * inside `createAgentSession` — BEFORE the mode controller calls `initialize()` on
	 * this runner — so notification frames drained by the manager (either fresh
	 * arrivals or replay from its own startup buffer) can reach us pre-init. Without
	 * this buffer they would evaporate for a second time here.
	 *
	 * Bounded at {@link MAX_PENDING_MCP_NOTIFICATIONS}; oldest entries drop under
	 * pressure. Never throws; per-handler errors are routed through {@link onError}
	 * via {@link emit}'s normal isolation.
	 */
	async emitMcpNotification(event: Omit<McpNotificationEvent, "type">): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingMcpNotifications.length >= MAX_PENDING_MCP_NOTIFICATIONS) {
				this.#pendingMcpNotifications.shift();
			}
			this.#pendingMcpNotifications.push(event);
			return;
		}
		await this.emit({ type: "mcp_notification", ...event });
	}

	/** Emits a session stop pass that can be cancelled with the active settle signal. */
	async emitSessionStop(event: Omit<SessionStopEvent, "type">): Promise<SessionStopEventResult | undefined> {
		if (event.signal.aborted) return undefined;
		return await this.emit({ type: "session_stop", ...event });
	}

	getUIContext(): ExtensionUIContext {
		return this.#uiContext;
	}

	hasUI(): boolean {
		return this.#uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map(e => e.path);
	}

	/** Get all registered tools from all extensions. */
	getAllRegisteredTools(): RegisteredTool[] {
		const tools: RegisteredTool[] = [];
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				tools.push(tool);
			}
		}
		return tools;
	}

	/**
	 * Aggregate the registered CLI flags across a set of extensions (last write
	 * wins on name collision). Static so callers that need the flag set before a
	 * runner exists — e.g. the CLI resolving `@file`/flag args before session
	 * creation — share this exact logic instead of duplicating it.
	 */
	static aggregateFlags(extensions: readonly Extension[]): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of extensions) {
			for (const [name, flag] of ext.flags) {
				allFlags.set(name, flag);
			}
		}
		return allFlags;
	}

	getFlags(): Map<string, ExtensionFlag> {
		return ExtensionRunner.aggregateFlags(this.extensions);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	static readonly #RESERVED_SHORTCUTS: Record<string, true> = {
		"ctrl+c": true,
		"ctrl+d": true,
		"ctrl+z": true,
		"ctrl+k": true,
		"ctrl+p": true,
		"ctrl+l": true,
		"ctrl+o": true,
		"ctrl+t": true,
		"ctrl+g": true,
		"alt+m": true,
		// Default chord for `app.message.followUp` (Windows Terminal can't deliver Ctrl+Enter; #1903).
		"ctrl+q": true,
		"shift+tab": true,
		"shift+ctrl+p": true,
		"alt+enter": true,
		escape: true,
		enter: true,
	};

	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		const allShortcuts = new Map<KeyId, ExtensionShortcut>();
		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				if (ExtensionRunner.#RESERVED_SHORTCUTS[normalizedKey]) {
					logger.warn("Extension shortcut conflicts with built-in shortcut", {
						key,
						extensionPath: shortcut.extensionPath,
					});
					continue;
				}

				const existing = allShortcuts.get(normalizedKey);
				if (existing) {
					logger.warn("Extension shortcut conflict", {
						key,
						extensionPath: shortcut.extensionPath,
						existingExtensionPath: existing.extensionPath,
					});
				}
				allShortcuts.set(normalizedKey, shortcut);
			}
		}
		return allShortcuts;
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getAssistantThinkingRenderers(): AssistantThinkingRenderer[] {
		return this.extensions.flatMap(ext => ext.assistantThinkingRenderers);
	}

	getRegisteredCommands(reserved?: ReadonlySet<string>): RegisteredCommand[] {
		this.#commandDiagnostics = [];

		const commands = new Map<string, RegisteredCommand>();
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				if (reserved?.has(command.name)) {
					const message = `扩展命令 “${command.name}”(来自 ${ext.path})与内置命令冲突,已跳过。`;
					this.#commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						logger.warn(message);
					}
					continue;
				}

				commands.set(command.name, command);
			}
		}
		return [...commands.values()];
	}

	getCommandDiagnostics(): Array<{ type: string; message: string; path: string }> {
		return this.#commandDiagnostics;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const command = this.extensions[index]?.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	/**
	 * Creates an extension context, optionally scoped to a provider request model.
	 *
	 * `delegation` wires the same-tool `ctx.invokeTool` for a re-registered built-in: when `toolName`
	 * names an existing native built-in, the context carries an `invokeTool` that runs it (see
	 * {@link invokeNativeTool}). The rest inherits the wrapper's own call so a bare
	 * `ctx.invokeTool(params)` behaves like the outer call — `context` preserves `toolCall`/provider
	 * metadata, `signal`/`onUpdate` default to the wrapper's own channels so aborting the outer tool
	 * call stops the native one and native progress still streams, and `depth` bounds recursion per
	 * call chain. Explicit options passed to `invokeTool` override the inherited `signal`/`onUpdate`.
	 */
	createContext(
		model?: Model,
		delegation?: {
			toolName: string;
			depth?: number;
			context?: AgentToolContext;
			signal?: AbortSignal;
			onUpdate?: AgentToolUpdateCallback;
		},
	): ExtensionContext {
		const getModel = model ? () => model : this.#getModel;
		return {
			ui: this.#uiContext,
			getContextUsage: () => this.#getContextUsageFn(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
			getAsyncJobSnapshot: () => this.#getAsyncJobSnapshotFn(),
			hasUI: this.hasUI(),
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			get model() {
				return getModel();
			},
			models: createExtensionModelQuery(this.modelRegistry, this.settings, getModel),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasPendingMessages: () => this.#hasPendingMessagesFn(),
			shutdown: () => this.#shutdownHandler(),
			getSystemPrompt: () => this.#getSystemPromptFn(),
			localProtocolOptions: this.localProtocolOptions,
			memory: this.#getMemoryFn?.(),
			setInterval: (callback, ms, ...args) => this.#managedTimers.setInterval(callback, ms, ...args),
			setTimeout: (callback, ms, ...args) => this.#managedTimers.setTimeout(callback, ms, ...args),
			clearTimer: timer => this.#managedTimers.clear(timer),
			invokeTool:
				delegation !== undefined && this.hasNativeTool(delegation.toolName)
					? (params, options) =>
							this.invokeNativeTool(delegation.toolName, params, {
								// Inherit the wrapper's own channels so a bare `ctx.invokeTool(params)` aborts
								// and streams with the outer call. Explicit options win.
								signal: options?.signal ?? delegation.signal,
								onUpdate: options?.onUpdate ?? delegation.onUpdate,
								depth: (delegation.depth ?? 0) + 1,
								callerContext: delegation.context,
							})
					: undefined,
		};
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 */
	shutdown(): void {
		this.#shutdownHandler();
	}

	/**
	 * Clear every timer scheduled through `ctx.setInterval` / `ctx.setTimeout`.
	 * Called during session teardown so extension background work does not
	 * outlive the session (a self-scheduling interval would otherwise keep
	 * firing against a disposed session).
	 */
	clearManagedTimers(): void {
		this.#managedTimers.clearAll();
	}

	createCommandContext(): ExtensionCommandContext {
		return {
			...this.createContext(),
			getContextUsage: () => this.#getContextUsageFn(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
			switchSession: sessionPath => this.#switchSessionHandler(sessionPath),
			reload: () => this.#reloadHandler(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
		};
	}

	#isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_branch" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}
	#isSessionShutdownEvent(event: RunnerEmitEvent): event is Extract<RunnerEmitEvent, { type: "session_shutdown" }> {
		return event.type === "session_shutdown";
	}
	async #runHandlerWithTimeout<TEvent extends { type: string }, TResult>(
		handler: (event: TEvent, ctx: ExtensionContext) => Promise<TResult | undefined> | TResult | undefined,
		event: TEvent,
		ctx: ExtensionContext,
		ext: Extension,
		timeoutMs: number,
	): Promise<TResult | undefined> {
		const signal =
			event.type === "session_stop" && "signal" in event && event.signal instanceof AbortSignal
				? event.signal
				: undefined;
		if (signal?.aborted) return undefined;
		try {
			const handlerResult = await raceHandlerWithTimeout(
				handlerSignal => handler(event, createHandlerContext(ctx, handlerSignal)),
				timeoutMs,
				signal,
			);
			if (handlerResult === EXTENSION_HANDLER_ABORTED) return undefined;
			if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
				const error = `处理器在 ${timeoutMs}ms 后超时`;
				logger.warn("Extension handler timed out", {
					extensionPath: ext.path,
					event: event.type,
					timeoutMs,
				});
				this.emitError({
					extensionPath: ext.path,
					event: event.type,
					error,
				});
				return undefined;
			}
			return handlerResult as TResult | undefined;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error: message,
				stack,
			});
			return undefined;
		}
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		// Defer the per-event context allocation (and the Promise.race/Bun.sleep
		// timeout machinery) to the first matching handler. Streaming sessions emit
		// message_update / tool_execution_* per delta with usually no extension
		// subscribed; building `ctx` for a zero-handler event is pure waste.
		let ctx: ExtensionContext | undefined;
		let result: SessionBeforeEventResult | SessionCompactingResult | SessionStopEventResult | undefined;

		if (this.#isSessionShutdownEvent(event)) {
			const timeoutMs = handlerTimeoutForEvent(event.type);
			const promises: Promise<unknown>[] = [];
			for (const ext of this.extensions) {
				const handlers = ext.handlers.get(event.type);
				if (!handlers || handlers.length === 0) continue;
				ctx ??= this.createContext();
				for (const handler of handlers) {
					promises.push(this.#runHandlerWithTimeout(handler, event, ctx, ext, timeoutMs));
				}
			}
			if (promises.length > 0) await Promise.all(promises);
			return result as RunnerEmitResult<TEvent>;
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;
			ctx ??= this.createContext();

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					handlerTimeoutForEvent(event.type),
				);

				if (this.#isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult as SessionBeforeEventResult;
					if (result.cancel) {
						return result as RunnerEmitResult<TEvent>;
					}
				}

				if (event.type === "session.compacting" && handlerResult) {
					result = handlerResult as SessionCompactingResult;
				}

				if (event.type === "session_stop" && handlerResult) {
					result = handlerResult as SessionStopEventResult;
					const hasContinuationContext =
						(typeof result.additionalContext === "string" && result.additionalContext.length > 0) ||
						(typeof result.reason === "string" && result.reason.length > 0);
					if ((result.continue === true || result.decision === "block") && hasContinuationContext) {
						return result as RunnerEmitResult<TEvent>;
					}
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = (await this.#runHandlerWithTimeout(
					handler,
					currentEvent,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;

				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
			}
		}

		if (!modified) return undefined;

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	/**
	 * Emit a `tool_call` event to every subscribed extension before the tool executes.
	 *
	 * Each handler is bounded by `extensionHandlerTimeoutMs` (default 30s). This
	 * matches the timeout policy already applied to `emitToolResult` and every
	 * other handler routed through `#runHandlerWithTimeout`; without it a single
	 * hung extension (unresolved `await`, network call with no timeout) would
	 * park `ExtensionToolWrapper.execute` indefinitely and freeze tool
	 * dispatch — see issue #3948.
	 *
	 * On-timeout policy: **fail-closed** (return `{ block: true }`). This is
	 * symmetric with the existing error path below and safer for a
	 * pre-execution gate — an unresponsive extension MUST NOT be treated as
	 * silent consent to run the tool.
	 */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		const timeoutMs = extensionHandlerTimeoutMs;
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await raceHandlerWithTimeout(
						handlerSignal => handler(event, createHandlerContext(ctx, handlerSignal)),
						timeoutMs,
					);

					if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
						const error = `处理器在 ${timeoutMs}ms 后超时`;
						logger.warn("Extension handler timed out", {
							extensionPath: ext.path,
							event: "tool_call",
							timeoutMs,
						});
						this.emitError({
							extensionPath: ext.path,
							event: "tool_call",
							error,
						});
						return {
							block: true,
							reason: `Extension ${ext.path} timed out after ${timeoutMs}ms`,
						};
					}

					if (handlerResult) {
						result = handlerResult as ToolCallEventResult;
						if (result.block) {
							return result;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_call",
						error: message,
						stack,
					});
					return { block: true, reason: `Extension ${ext.path} failed: ${message}` };
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return this.emitUserEvent<UserBashEventResult>(event, "user_bash");
	}

	async emitUserPython(event: UserPythonEvent): Promise<UserPythonEventResult | undefined> {
		return this.emitUserEvent<UserPythonEventResult>(event, "user_python");
	}

	private async emitUserEvent<R>(
		event: UserBashEvent | UserPythonEvent,
		eventName: "user_bash" | "user_python",
	): Promise<R | undefined> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventName);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult) {
					return handlerResult as R;
				}
			}
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				const result = handlerResult as ResourcesDiscoverResult | undefined;

				if (result?.skillPaths?.length) {
					skillPaths.push(...result.skillPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.promptPaths?.length) {
					promptPaths.push(...result.promptPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.themePaths?.length) {
					themePaths.push(...result.themePaths.map(path => ({ path, extensionPath: ext.path })));
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive" | "rpc" | "extension",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				const event: InputEvent = { type: "input", text: currentText, images: currentImages, source };
				const result = (await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs)) as
					| InputEventResult
					| undefined;
				if (result?.handled) return result;
				if (result?.text !== undefined) {
					currentText = result.text;
					currentImages = result.images ?? currentImages;
				}
			}
		}
		return currentText !== text || currentImages !== images ? { text: currentText, images: currentImages } : {};
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();

		// Check if any extensions actually have context handlers before cloning
		let hasContextHandlers = false;
		for (const ext of this.extensions) {
			if (ext.handlers.get("context")?.length) {
				hasContextHandlers = true;
				break;
			}
		}
		if (!hasContextHandlers) return messages;

		let currentMessages: AgentMessage[];
		try {
			currentMessages = structuredClone(messages);
		} catch {
			// Messages may contain non-cloneable objects (e.g. in ToolResultMessage.details
			// or ProviderPayload). Fall back to a shallow array clone — extensions should
			// return new message arrays rather than mutating in place.
			currentMessages = [...messages];
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ContextEvent = { type: "context", messages: currentMessages };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult && (handlerResult as ContextEventResult).messages) {
					currentMessages = (handlerResult as ContextEventResult).messages!;
				}
			}
		}

		return currentMessages;
	}

	/** Runs request payload hooks with the model used for that provider request. */
	async emitBeforeProviderRequest(payload: unknown, model?: Model): Promise<BeforeProviderRequestEventResult> {
		const ctx = this.createContext(model);
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult !== undefined) {
					currentPayload = handlerResult;
				}
			}
		}

		return currentPayload;
	}

	async emitAfterProviderResponse(response: ProviderResponseMetadata, _model?: Model): Promise<void> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("after_provider_response");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: AfterProviderResponseEvent = {
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
					requestId: response.requestId,
					metadata: response.metadata,
				};
				await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs);
			}
		}
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string[],
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		const ctx = this.createContext();
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let currentSystemPrompt = systemPrompt;
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt,
					images,
					systemPrompt: currentSystemPrompt,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult) {
					const result = handlerResult as BeforeAgentStartEventResult;
					if (result.message) {
						messages.push(result.message);
					}
					if (result.systemPrompt !== undefined) {
						currentSystemPrompt =
							typeof result.systemPrompt === "string" ? [result.systemPrompt] : result.systemPrompt;
						systemPromptModified = true;
					}
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}
}
