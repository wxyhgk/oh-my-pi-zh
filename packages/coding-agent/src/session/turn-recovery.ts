import { scheduler } from "node:timers/promises";
import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	isSyntheticToolResultMessage,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantRetryRecovery,
	AssistantRetryRecoveryKind,
	CodexCompactionContext,
	Effort,
	Model,
	TextContent,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { isFireworksFastModelId, toFireworksBaseModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { extractRetryHint, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { RecoveredRetryError } from "../extensibility/shared-events";
import emptyStopRetryTemplate from "../prompts/system/empty-stop-retry.md" with { type: "text" };
import thinkingLoopRedirectTemplate from "../prompts/system/thinking-loop-redirect.md" with { type: "text" };
import unexpectedStopRetryTemplate from "../prompts/system/unexpected-stop-retry.md" with { type: "text" };
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampThinkingLevelToCeiling,
	modelSupportsEffortCeiling,
} from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type { InitialRetryFallbackState } from "./agent-session-types";
import { isEmptyErrorTurn } from "./messages";
import {
	type ActiveRetryFallbackState,
	calculateRetryBackoffDelayMs,
	findRetryFallbackCandidates,
	formatRetryFallbackSelector,
	getRetryFallbackChains,
	getRetryFallbackRevertPolicy,
	parseRetryFallbackSelector,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	type RetryFallbackRevertPolicy,
	type RetryFallbackSelector,
	resolveRetryFallbackChainKey,
	validateRetryFallbackChains,
} from "./retry-fallback-chains";
import { getLatestCompactionEntry } from "./session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE, type SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { classifyUnexpectedStop, isUnexpectedStopCandidate } from "./unexpected-stop-classifier";

const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
const UNEXPECTED_STOP_MAX_RETRIES = 3;
const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
const EMPTY_STOP_MAX_RETRIES = 3;
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
const NON_WHITESPACE_RE = /\S/;

function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

function syntheticToolResultTailStart(messages: readonly AgentMessage[]): number {
	let index = messages.length;
	while (index > 0 && isSyntheticToolResultMessage(messages[index - 1])) {
		index--;
	}
	return index;
}

function retryableAssistantTurnEnd(messages: readonly AgentMessage[]): number | undefined {
	const turnEnd = syntheticToolResultTailStart(messages);
	const message = messages[turnEnd - 1];
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
	return turnEnd;
}

/** Result shape shared with automatic maintenance recovery. */
export interface RecoveryCompactionResult {
	deferredHandoff: boolean;
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}

/** Capabilities borrowed from the owning AgentSession. */
export interface TurnRecoveryHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	configWarnings: string[];
	model(): Model | undefined;
	thinkingLevel(): ThinkingLevel | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	/** Hard per-session effort ceiling; fallback recovery must never raise thinking above it. */
	thinkingLevelCeiling(): Effort | undefined;
	isDisposed(): boolean;
	isStreaming(): boolean;
	isCompacting(): boolean;
	abortInProgress(): boolean;
	streamingEditAbortTriggered(): boolean;
	promptGeneration(): number;
	sessionId(): string;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: { delayMs?: number; generation?: number; onError?: (error: unknown) => void }): void;
	waitForSessionMessagePersistence(message: AssistantMessage): Promise<void>;
	appendSessionMessage(message: AssistantMessage): void;
	persistedAssistantEntryId(message: AssistantMessage): string | undefined;
	sessionMessageAlreadyPersisted(message: AssistantMessage): boolean;
	setModelWithProviderSessionReset(model: Model): Promise<void>;
	resetCurrentResponsesProviderSession(reason: string): void;
	/**
	 * Spend a saved Codex reset for the blocked pool, if eligible.
	 * `activeBlockUnblockAtMs` is the absolute unblock time parsed from the
	 * live usage-limit error — authoritative for the active account when the
	 * usage report still shows a pre-block snapshot.
	 */
	maybeAutoRedeemCodexReset(activeBlockUnblockAtMs?: number): Promise<boolean>;
	runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred?: boolean,
		allowDefer?: boolean,
		options?: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			suppressHandoff?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
		},
	): Promise<RecoveryCompactionResult>;
	withBashBranchTransition<T>(operation: () => T): T;
}

/** Construction-time retry state restored from model selection. */
export interface TurnRecoveryOptions {
	initialRetryFallback?: InitialRetryFallbackState;
}

type PendingRecoveredRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

type UsageLimitOutcome = {
	switchedCredential: boolean;
	retryAfterMs: number;
	retryAtMs: number | undefined;
};

/** Owns terminal-stop recovery, automatic retries, and fallback routing. */
export class TurnRecovery {
	readonly #host: TurnRecoveryHost;
	#retryAbortController: AbortController | undefined;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined;
	#retryResolve: (() => void) | undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined;
	#pendingRecoveredRetryErrors: PendingRecoveredRetryError[] = [];
	#usageLimitOutcomes = new WeakMap<AssistantMessage, Promise<UsageLimitOutcome>>();
	#emptyStopRetryCount = 0;
	#unexpectedStopRetryCount = 0;
	#acceptTerminalEmptyStopForPrompt = false;

	constructor(host: TurnRecoveryHost, options: TurnRecoveryOptions = {}) {
		this.#host = host;
		if (options.initialRetryFallback) {
			this.#activeRetryFallback = {
				...options.initialRetryFallback,
				lastAppliedFallbackThinkingLevel: host.configuredThinkingLevel(),
				pinned: options.initialRetryFallback.pinned ?? false,
			};
		}
		this.#validateRetryFallbackChains();
	}

	/** Current automatic retry attempt. */
	get attempt(): number {
		return this.#retryAttempt;
	}

	/** Promise settled when the active retry saga finishes. */
	get retryPromise(): Promise<void> | undefined {
		return this.#retryPromise;
	}

	/** Resolved selector while fallback routing owns the current model. */
	get retryFallbackModel(): string | undefined {
		const model = this.#host.model();
		return this.#activeRetryFallback && model
			? formatRetryFallbackSelector(model, this.#host.thinkingLevel())
			: undefined;
	}

	/** Resets per-prompt recovery counters and terminal-stop acceptance. */
	resetForNewPrompt(): void {
		this.#emptyStopRetryCount = 0;
		this.#unexpectedStopRetryCount = 0;
		this.#acceptTerminalEmptyStopForPrompt = false;
	}

	/** Sets whether one terminal empty stop is accepted for the current prompt. */
	setAcceptTerminalEmptyStop(accept: boolean): void {
		this.#acceptTerminalEmptyStopForPrompt = accept;
	}

	/** Closes a successful retry saga and annotates recovered persisted errors. */
	async onAssistantSettledSuccessfully(message: AssistantMessage): Promise<void> {
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			this.#isEmptyAssistantStop(message) ||
			this.#retryAttempt === 0
		) {
			return;
		}
		const model = this.#host.model();
		if (this.#activeRetryFallback && model) {
			await this.#host.emitSessionEvent({
				type: "retry_fallback_succeeded",
				model: formatRetryFallbackSelector(model, this.#host.thinkingLevel()),
				role: this.#activeRetryFallback.role,
			});
		}
		const recoveredErrors = await this.#markPendingRecoveredRetryErrors(message);
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: true,
			attempt: this.#retryAttempt,
			recoveredErrors,
		});
		this.#clearPendingRecoveredRetryErrors();
		this.#retryAttempt = 0;
	}

	/** Closes a failed retry saga when no compaction continuation took ownership. */
	async onErrorSettledWithoutRetry(message: AssistantMessage, compaction: RecoveryCompactionResult): Promise<void> {
		if (message.stopReason !== "error" || this.#retryAttempt === 0 || compaction.continuationScheduled) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: message.errorMessage,
		});
		this.#clearPendingRecoveredRetryErrors();
	}

	/** Persists an otherwise skipped terminal empty error turn. */
	persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		return this.#persistTerminalEmptyErrorTurn(message);
	}

	/** Handles empty terminal assistant turns and schedules bounded recovery. */
	handleEmptyAssistantStop(message: AssistantMessage): Promise<boolean> {
		return this.#handleEmptyAssistantStop(message);
	}

	/** Classifies suspicious terminal stops and schedules bounded recovery. */
	handleUnexpectedAssistantStop(message: AssistantMessage): Promise<boolean> {
		return this.#handleUnexpectedAssistantStop(message);
	}

	/** Removes a persisted failed assistant turn after its persistence slot settles. */
	dropPersistedAssistantTurn(message: AssistantMessage): Promise<void> {
		return this.#dropPersistedAssistantTurn(message);
	}

	/** Runs recovery compaction and restores the failed turn when no rewrite occurs. */
	runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		message: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<RecoveryCompactionResult> {
		return this.#runRecoveryCompactionWithRollback(reason, message, allowDefer, options);
	}

	/** Restores the configured primary after fallback cooldown expiry. */
	maybeRestoreRetryFallbackPrimary(): Promise<void> {
		return this.#maybeRestoreRetryFallbackPrimary();
	}

	/** Applies automatic retry, credential rotation, and model fallback policy. */
	handleRetryableError(
		message: AssistantMessage,
		options?: {
			allowModelFallback?: boolean;
			fireworksFastFallback?: boolean;
			hardErrorFallback?: boolean;
			preserveFailedTurn?: boolean;
		},
	): Promise<boolean> {
		return this.#handleRetryableError(message, options);
	}

	/**
	 * Records a usage-limit failure before replay eligibility decides whether the
	 * failed turn may be discarded. Returns whether credential recovery switched
	 * the active account.
	 */
	async recordUsageLimitOutcome(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		const activeModel = this.#host.model();
		if (!activeModel || !AIError.is(id, AIError.Flag.UsageLimit)) return false;

		let recorded = this.#usageLimitOutcomes.get(message);
		if (!recorded) {
			const errorMessage = message.errorMessage || "未知错误";
			const retryAfterMs =
				this.#parseRetryAfterMsFromError(errorMessage) ??
				calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			recorded = (async (): Promise<UsageLimitOutcome> => {
				const outcome = await this.#host.modelRegistry.authStorage.markUsageLimitReached(
					activeModel.provider,
					this.#host.sessionId(),
					{ retryAfterMs, baseUrl: activeModel.baseUrl, modelId: activeModel.id },
				);
				return {
					switchedCredential: outcome.switched,
					retryAfterMs,
					retryAtMs: outcome.retryAtMs,
				};
			})();
			this.#usageLimitOutcomes.set(message, recorded);
		}
		return (await recorded).switchedCredential;
	}

	/** Prompts after transient overlap with a prior agent run. */
	promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		return this.#promptAgentWithIdleRetry(messages, options);
	}

	/** Parses provider retry and rate-limit reset hints into a delay. */
	parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		return this.#parseRetryAfterMsFromError(errorMessage);
	}

	/** Resolve the pending retry promise */
	resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	#clearPendingRecoveredRetryErrors(): void {
		this.#pendingRecoveredRetryErrors = [];
	}

	/**
	 * Durably record a terminal empty error turn (`stopReason: "error"` with no
	 * substantive content) that `#persistSessionMessageIfMissing` skipped, so the
	 * session JSONL keeps a record of why the run stopped instead of ending at the
	 * last tool result. A no-op for non-empty/non-error turns and idempotent via
	 * the already-persisted guard; the turn is dropped from active context by the
	 * caller (or `isProviderRefusalMessage`/`isEmptyErrorTurn` filters) so it is
	 * never replayed on the wire. Used by the retry-lifecycle dead-ends and the
	 * non-retry terminal error tail.
	 */
	async #persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		await this.#host.waitForSessionMessagePersistence(message);
		if (!isEmptyErrorTurn(message)) return;
		if (this.#host.sessionMessageAlreadyPersisted(message)) return;
		this.#host.appendSessionMessage(message);
	}

	#retryRecoveryKind(
		id: number,
		switchedCredential: boolean,
		switchedModel: boolean,
		delayMs: number,
	): AssistantRetryRecoveryKind {
		if (switchedCredential) return "credential";
		if (switchedModel) return "model";
		if (AIError.is(id, AIError.Flag.UsageLimit) && delayMs > 0) return "wait";
		return "plain";
	}

	#retryRecoveryNote(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
		const parts: string[] = [];
		if (rateLimited) {
			parts.push("被限流");
		} else if (recovery === "plain") {
			parts.push("错误");
		}
		if (recovery === "credential") {
			parts.push("已切换账户");
		} else if (recovery === "model") {
			parts.push("已切换模型");
		} else if (recovery === "wait") {
			parts.push("已等待");
		}
		parts.push("已重试");
		return parts.join("; ");
	}

	async #recordPendingRecoveredRetryError(
		message: AssistantMessage,
		id: number,
		options: { switchedCredential: boolean; switchedModel: boolean; delayMs: number },
	): Promise<void> {
		await this.persistTerminalEmptyErrorTurn(message);
		const persistenceKey = sessionMessagePersistenceKey(message);
		if (!persistenceKey) return;
		let branchEntry: SessionEntry | undefined;
		for (const entry of this.#host.sessionManager.getBranch().slice().reverse()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (sessionMessagePersistenceKey(entry.message) !== persistenceKey) continue;
			if (!sameMessageContent(entry.message, message) && !this.#isSameAssistantMessage(entry.message, message)) {
				continue;
			}
			branchEntry = entry;
			break;
		}
		if (!branchEntry) return;
		if (this.#pendingRecoveredRetryErrors.some(error => error.entryId === branchEntry.id)) return;
		const rateLimited = AIError.is(id, AIError.Flag.UsageLimit);
		const recovery = this.#retryRecoveryKind(id, options.switchedCredential, options.switchedModel, options.delayMs);
		const note = this.#retryRecoveryNote(recovery, rateLimited);
		this.#pendingRecoveredRetryErrors.push({
			entryId: branchEntry.id,
			persistenceKey,
			recovery,
			attempt: this.#retryAttempt,
			note,
		});
	}

	async #markPendingRecoveredRetryErrors(supersedingMessage: AssistantMessage): Promise<RecoveredRetryError[]> {
		if (this.#pendingRecoveredRetryErrors.length === 0) return [];
		const branch = this.#host.sessionManager.getBranch();
		const branchById = new Map<string, SessionEntry>();
		for (const entry of branch) {
			branchById.set(entry.id, entry);
		}
		const recoveredAt = new Date().toISOString();
		const supersededBy: AssistantRetryRecovery["supersededBy"] = {
			timestamp: supersedingMessage.timestamp,
			provider: supersedingMessage.provider,
			model: supersedingMessage.model,
		};
		if (supersedingMessage.responseId) {
			supersededBy.responseId = supersedingMessage.responseId;
		}
		const recoveredErrors: RecoveredRetryError[] = [];
		for (const pending of this.#pendingRecoveredRetryErrors) {
			let entry = branchById.get(pending.entryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") {
				entry = branch
					.slice()
					.reverse()
					.find(
						candidate =>
							candidate.type === "message" &&
							candidate.message.role === "assistant" &&
							sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey,
					);
			}
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			const retryRecovery: AssistantRetryRecovery = {
				kind: "auto-retry",
				status: "recovered",
				attempt: pending.attempt,
				recoveredAt,
				recovery: pending.recovery,
				note: pending.note,
				supersededBy,
			};
			entry.message.retryRecovery = retryRecovery;
			recoveredErrors.push({
				entryId: entry.id,
				persistenceKey: pending.persistenceKey,
				note: retryRecovery.note,
				retryRecovery,
			});
		}
		if (recoveredErrors.length > 0) {
			await this.#host.sessionManager.rewriteEntries();
		}
		return recoveredErrors;
	}

	async #handleEmptyAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.#isEmptyAssistantStop(assistantMessage)) {
			this.#emptyStopRetryCount = 0;
			return false;
		}

		if (this.#acceptTerminalEmptyStopForPrompt && assistantMessage.stopReason === "stop") {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#discardAcceptedTerminalEmptyStop(assistantMessage);
			this.#emptyStopRetryCount = 0;
			return false;
		}

		this.#emptyStopRetryCount++;
		if (this.#emptyStopRetryCount > EMPTY_STOP_MAX_RETRIES) {
			const attempts = this.#emptyStopRetryCount - 1;
			const finalError =
				"Assistant 在重试达到上限后仍返回空停止；请尝试切换模型，或运行 `/shake images` 移除已归档的帧";
			logger.warn(finalError, {
				attempts,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt > 0 ? this.#retryAttempt : attempts,
				finalError,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#retryAttempt = 0;
			this.resolveRetry();
			// A zero-content turn carries no transcript value, while its provider usage
			// can anchor the next prompt at the full failed-request size and re-trigger
			// compaction at the same boundary. Remove every capped empty stop; toolUse
			// orphans still need this for Anthropic message-history validity.
			await this.dropPersistedAssistantTurn(assistantMessage);
			return false;
		}
		this.discardAssistantTurn(assistantMessage);
		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#emptyStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({ generation: this.#host.promptGeneration() });
		return true;
	}

	#isEmptyAssistantStop(assistantMessage: AssistantMessage): boolean {
		switch (assistantMessage.stopReason) {
			case "stop":
				// Unsigned thinking alone is not actionable, but a signature is
				// provider-authenticated content and makes the stop terminal.
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
					if (content.type === "thinking" && hasNonWhitespace(content.thinkingSignature ?? "")) return false;
				}
				return true;
			case "toolUse":
				// An orphaned toolUse stop (no tool_use block) corrupts Anthropic history:
				// a later tool_result has nothing to anchor to. Thinking alone cannot anchor
				// a tool_result, so it does not rescue a toolUse stop here.
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			default:
				return false;
		}
	}

	#emptyStopRetryReminder(): string {
		return prompt.render(emptyStopRetryTemplate, {
			retryCount: this.#emptyStopRetryCount,
			maxRetries: EMPTY_STOP_MAX_RETRIES,
		});
	}
	async #handleUnexpectedAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.#host.settings.get("features.unexpectedStopDetection")) {
			return false;
		}
		if (!isUnexpectedStopCandidate(assistantMessage)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const text = assistantMessage.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("\n");
		if (!/\S/.test(text)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), UNEXPECTED_STOP_TIMEOUT_MS);
		let classification: boolean | undefined;
		try {
			classification = await classifyUnexpectedStop(text, {
				settings: this.#host.settings,
				registry: this.#host.modelRegistry,
				sessionId: this.#host.sessionId(),
				metadataResolver: (provider: string) => this.#host.agent.metadataForProvider(provider),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}

		if (classification !== true) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#unexpectedStopRetryCount++;
		if (this.#unexpectedStopRetryCount > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#unexpectedStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({ generation: this.#host.promptGeneration() });
		return true;
	}

	#unexpectedStopRetryReminder(): string {
		return prompt.render(unexpectedStopRetryTemplate, {
			retryCount: this.#unexpectedStopRetryCount,
			maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
		});
	}

	removeAssistantMessageFromActiveContext(
		assistantMessage: AssistantMessage,
		reason = "assistant-context-cleanup",
	): void {
		const messages = this.#host.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
		if (lastAssistant !== undefined && this.#isSameAssistantMessage(lastAssistant, assistantMessage)) {
			this.#host.agent.replaceMessages(messages.slice(0, -1));
			return;
		}
		// A miss means the failed turn is still in active context (or was never
		// there); log just enough to explain why the identity check failed.
		logger.debug("agent active context assistant removal missed", {
			reason,
			lastRole: lastMessage?.role,
			candidateTimestamp: assistantMessage.timestamp,
			lastTimestamp: lastAssistant?.timestamp,
			candidateStopReason: assistantMessage.stopReason,
			lastStopReason: lastAssistant?.stopReason,
		});
	}

	/**
	 * Drop a recoverable assistant turn from the persisted session branch once a
	 * recovery path (context promotion or compaction) is committed. Waits for the
	 * in-flight `message_end` persistence slot first so the branch entry exists
	 * before we reparent past it. Active context removal is the caller's
	 * responsibility — recovery paths clear it eagerly so the retry never
	 * replays the failed turn, while no-recovery paths leave the persisted entry
	 * (and the user-visible transcript line) in place.
	 */
	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<void> {
		await this.#host.waitForSessionMessagePersistence(assistantMessage);
		this.discardAssistantTurn(assistantMessage);
	}

	/**
	 * Drop the failed assistant turn from persisted history, run
	 * {@link #runAutoCompaction} for an `overflow` / `incomplete` recovery, and
	 * restore the assistant entry if compaction did not actually commit
	 * anything (no usable model/preparation, hook cancel, compaction error,
	 * or a no-progress automatic-continuation block before any summary was
	 * written).
	 *
	 * Compaction has to see a clean branch — otherwise its `prepareCompaction`
	 * pass would keep the failed turn in the kept region and the retry would
	 * replay it. But a return that was not paired with a fresh compaction
	 * summary or a successful history rewrite means no recovery is in progress,
	 * even if queued user input gets drained next. Restoring the failed turn
	 * before that continuation preserves the visible stop reason and rebuilds the
	 * active assistant tail that `Agent.continue()` needs to dequeue follow-ups.
	 */
	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<RecoveryCompactionResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		await this.dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#host.runAutoCompaction(reason, true, false, allowDefer, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.#host.sessionManager.appendMessage(assistantMessage);
		const lastMessage = this.#host.agent.state.messages.at(-1);
		if (
			lastMessage?.role === "assistant" &&
			this.#isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			return;
		}
		this.#host.agent.appendMessage(assistantMessage);
	}

	#discardAcceptedTerminalEmptyStop(assistantMessage: AssistantMessage): void {
		const branch = this.#host.sessionManager.getBranch();
		const branchEntry = branch
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message, assistantMessage),
			);
		const parentEntry =
			branchEntry?.parentId === null || branchEntry?.parentId === undefined
				? undefined
				: branch.find(entry => entry.id === branchEntry.parentId);
		const prunePrompt = parentEntry?.type === "custom_message";

		this.removeAssistantMessageFromActiveContext(assistantMessage, "accepted-terminal-empty-stop");
		if (prunePrompt && this.#host.agent.state.messages.at(-1)?.role === "custom") {
			this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, -1));
		}

		if (!branchEntry) return;
		const targetParentId = prunePrompt ? parentEntry.parentId : branchEntry.parentId;
		this.#host.withBashBranchTransition(() => {
			if (targetParentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(targetParentId);
			}
		});
		this.#host.sessionManager.appendCustomEntry("accepted-terminal-empty-stop");
	}

	/**
	 * Drop an assistant turn from BOTH the live agent context and the persisted
	 * session branch (reparenting the leaf to the turn's parent), so a discarded
	 * turn does not resurface on reload. Used for empty/reasoning-only stops and
	 * the Gemini header-runaway interrupt, which must not replay a partial,
	 * loop-fueling thinking block.
	 */
	discardAssistantTurn(assistantMessage: AssistantMessage): void {
		this.removeAssistantMessageFromActiveContext(assistantMessage);

		const branch = this.#host.sessionManager.getBranch();
		const persistedEntryId = this.#host.persistedAssistantEntryId(assistantMessage);
		const branchEntry =
			(persistedEntryId === undefined
				? undefined
				: branch.find(
						entry =>
							entry.id === persistedEntryId && entry.type === "message" && entry.message.role === "assistant",
					)) ??
			branch
				.slice()
				.reverse()
				.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage),
				);
		if (!branchEntry) {
			return;
		}
		this.#host.withBashBranchTransition(() => {
			if (branchEntry.parentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(branchEntry.parentId);
			}
		});
	}

	#isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
		return (
			left === right ||
			(left.timestamp === right.timestamp &&
				left.provider === right.provider &&
				left.model === right.model &&
				left.stopReason === right.stopReason &&
				left.errorMessage === right.errorMessage &&
				Bun.hash(JSON.stringify(left.content)) === Bun.hash(JSON.stringify(right.content)))
		);
	}

	/**
	 * Classify retry decisions against the active session model. Test stream
	 * shims and provider adapters can emit generic assistant metadata, but retry
	 * policy belongs to the model that was actually requested for this turn.
	 */
	#classifyRetryMessage(message: AssistantMessage): number {
		const activeModel = this.#host.model();
		if (!activeModel || message.api === activeModel.api) {
			return AIError.classifyMessage(message);
		}

		const id = AIError.classifyMessage({
			api: activeModel.api,
			errorId: message.errorId,
			errorMessage: message.errorMessage,
			errorStatus: message.errorStatus,
		});
		message.errorId = id;
		return id;
	}

	/**
	 * Retry an empty, reason-less provider abort: a turn with no content that
	 * carries the generic sentinel (bare `abort()`), whether the provider
	 * finalized it as `stopReason: "aborted"` or leaked it as `stopReason:
	 * "error"` (a stalled/dropped stream reported as an error rather than an
	 * abort — issue #5375). Only fires while the session is neither aborting nor
	 * tearing down. A user/lifecycle abort (`#abortInProgress`), a dispose-driven
	 * abort (`#isDisposed`), or a session-induced streaming-edit guard abort
	 * (`StreamingEditGuard.abortTriggered` — auto-generated-file guard or failed-patch
	 * preview) is deliberate and MUST settle the turn instead: routing it through
	 * retry would orphan `#retryPromise` on a continuation the guard skips
	 * (hanging the in-flight `prompt()`) or silently undo the guard's intended
	 * abort. Deliberate user interrupts (`UserInterrupt`) and silent aborts carry
	 * their own marker, not the generic sentinel, so they never match here.
	 */
	isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		if (
			(message.stopReason !== "aborted" && message.stopReason !== "error") ||
			message.content.length !== 0 ||
			this.#host.abortInProgress() ||
			this.#host.isDisposed() ||
			this.#host.streamingEditAbortTriggered()
		) {
			return false;
		}

		const id = this.#classifyRetryMessage(message);
		if (message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) return true;
		if (message.errorMessage !== "Request was aborted" && message.errorMessage !== "Request was aborted.") {
			return false;
		}

		message.errorId = AIError.create(AIError.Flag.Abort);
		return true;
	}

	/**
	 * Check if an error is retryable (transient errors or usage limits).
	 * Context overflow is NOT retryable (handled by compaction instead).
	 * Usage-limit errors are retryable because the retry handler performs credential switching.
	 */
	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;

		const id = this.#classifyRetryMessage(message);
		// Context overflow is handled by compaction, not retry
		const contextWindow = this.#host.model()?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;

		// A classifier refusal/sensitivity stop is the model's decision, not a route
		// failure, but only after we confirm no user-visible output has already been
		// streamed. Visible text, images, tool calls, or server tools must not be
		// discarded and replayed.
		if (this.#hasReplayUnsafeOutput(message)) return false;
		if (this.isClassifierRefusal(message)) return true;
		return AIError.retriable(id);
	}

	/**
	 * Classify a reasonless abort or stream stall whose emitted tool calls all
	 * have results. The failed assistant/tool-result pair stays in context so
	 * continuation cannot replay completed side effects; synthetic results tell
	 * the next turn that an unexecuted call must be reissued.
	 */
	classifyResolvedInterruptedToolTurn(message: AssistantMessage): "reasonless-abort" | "stream-stall" | undefined {
		const id = this.#classifyRetryMessage(message);
		const genericAbort =
			message.errorMessage === "Request was aborted" || message.errorMessage === "Request was aborted.";
		const reasonlessAbort =
			(message.stopReason === "aborted" || message.stopReason === "error") &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered() &&
			((message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) || genericAbort);
		const streamStall =
			message.stopReason === "error" &&
			message.errorMessage?.toLowerCase().includes("stream stall") === true &&
			AIError.retriable(id);
		if (!reasonlessAbort && !streamStall) return undefined;
		if (reasonlessAbort && genericAbort) message.errorId = AIError.create(AIError.Flag.Abort);

		// The Cursor server-execution marker gate applies only to the stream-stall
		// path: an unmarked/unresolved Cursor block there means the server has not
		// finished executing, so resuming would race it. A reasonless abort instead
		// ends the turn and the agent loop pairs every un-run call (Cursor's unmarked
		// `todo`/MCP blocks included) with a synthetic `executed: false` result, so
		// the tool-result reconciliation below is the safety gate and the marker is
		// irrelevant.
		const resolvedToolCallIds: string[] = [];
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (
				streamStall &&
				message.provider === "cursor" &&
				(!(kCursorExecResolved in block) || block[kCursorExecResolved] !== true)
			) {
				return undefined;
			}
			resolvedToolCallIds.push(block.id);
		}
		if (resolvedToolCallIds.length === 0) return undefined;

		const messages = this.#host.agent.state.messages;
		let assistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role === "assistant" && this.#isSameAssistantMessage(candidate, message)) {
				assistantIndex = i;
				break;
			}
		}
		if (assistantIndex < 0) return undefined;

		const unresolvedToolCallIds = new Set(resolvedToolCallIds);
		for (let i = assistantIndex + 1; i < messages.length; i++) {
			const candidate = messages[i];
			if (candidate.role === "toolResult") unresolvedToolCallIds.delete(candidate.toolCallId);
		}
		if (unresolvedToolCallIds.size > 0) return undefined;
		return reasonlessAbort ? "reasonless-abort" : "stream-stall";
	}
	/**
	 * Retried turns remove the failed assistant message from active context.
	 * Thinking-only partials are safe to discard and replay: reasoning models
	 * routinely stall after long thinking with no visible output, and duplicated
	 * thinking display is materially lower harm than duplicated final text.
	 * Whitespace-only text is likewise safe since nothing meaningful reached the
	 * user. Visible text, generated images, server tools, and retained tool calls
	 * are NOT safe: each has already rendered or may have side effects, so replaying
	 * the turn can duplicate user-visible output or work.
	 */
	#hasReplayUnsafeOutput(message: AssistantMessage): boolean {
		return message.content.some(
			block =>
				block.type === "toolCall" ||
				block.type === "image" ||
				block.type === "anthropicServerTool" ||
				(block.type === "text" && block.text.trim().length > 0),
		);
	}

	/**
	 * OpenRouter can repeatedly close Gemini streams at the reasoning-to-payload
	 * transition. One retry covers a transient edge failure; the normal ten-retry
	 * budget would otherwise re-run the same expensive reasoning cycle unchanged.
	 */
	#isOpenRouterThinkingStreamClose(message: AssistantMessage): boolean {
		return (
			message.provider === "openrouter" &&
			/server_error:\s*stream closed with reason:\s*error/i.test(message.errorMessage ?? "") &&
			message.content.some(block => block.type === "thinking" && block.thinking.trim().length > 0)
		);
	}

	/** Checks whether a provider error represents a classifier refusal. */
	isClassifierRefusal(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const stopType = message.stopDetails?.type;
		return stopType === "refusal" || stopType === "sensitive";
	}

	#getRetryFallbackResolutionContext(): RetryFallbackResolutionContext {
		return {
			chains: this.#getRetryFallbackChains(),
			getModelRole: role => this.#host.settings.getModelRole(role),
			modelLookup: this.#host.modelRegistry,
		};
	}

	#getRetryFallbackChains(): RetryFallbackChains {
		return getRetryFallbackChains(this.#host.settings);
	}

	#validateRetryFallbackChains(): void {
		validateRetryFallbackChains(this.#host.settings, this.#host.modelRegistry, message =>
			this.#host.configWarnings.push(message),
		);
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return getRetryFallbackRevertPolicy(this.#host.settings);
	}

	/** Clears fallback ownership after an explicit model change. */
	clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
	}

	/** Checks whether a fallback selector remains in cooldown. */
	isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#host.modelRegistry.isSelectorSuppressed(selector.raw);
	}

	/** Records the cooldown that should suppress a failing selector. */
	noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#host.modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	/**
	 * Map the failing model selector to the chain key that owns it, by
	 * specificity: an exact model-selector key, then a `provider/*` wildcard,
	 * then a model role whose current assignment matches, then `default`.
	 * Model-oriented keys win over roles so a chain follows the model across
	 * role reassignments.
	 */
	resolveRetryFallbackRole(
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
	): string | undefined {
		return resolveRetryFallbackChainKey(this.#getRetryFallbackResolutionContext(), currentSelector, currentModel);
	}

	/** Finds fallback candidates that follow the active selector. */
	findRetryFallbackCandidates(
		role: string,
		currentSelector: string,
		currentModel: Model | null | undefined = this.#host.model(),
	): RetryFallbackSelector[] {
		return findRetryFallbackCandidates(
			this.#getRetryFallbackResolutionContext(),
			role,
			currentSelector,
			currentModel,
		);
	}

	async applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
		options?: { pinFallback?: boolean; apiKey?: string; signal?: AbortSignal },
	): Promise<void> {
		const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
		const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`未找到重试回退模型：${selector.raw}`);
		}
		const apiKey =
			options?.apiKey ?? (await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId(), options));
		if (!apiKey) {
			throw new Error(`找不到重试回退 ${selector.raw} 的 API 密钥`);
		}
		if (options?.signal?.aborted) return;

		// Capture the configured selector (auto-aware) so a fallback chain preserves
		// `auto` instead of collapsing it to the level it resolved to this turn.
		const currentThinkingLevel = this.#host.configuredThinkingLevel();
		const requestedThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;
		// A fallback selector's explicit level (or the carried level after the
		// replacement model's floor clamp) must never exceed the session's
		// per-spawn effort ceiling.
		const nextThinkingLevel =
			requestedThinkingLevel === AUTO_THINKING
				? requestedThinkingLevel
				: clampThinkingLevelToCeiling(candidate, requestedThinkingLevel, this.#host.thinkingLevelCeiling());
		const candidateSelector = formatModelStringWithRouting(candidate);
		await this.#host.setModelWithProviderSessionReset(candidate);
		this.#host.sessionManager.appendModelChange(candidateSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#host.settings.getStorage()?.recordModelUsage(candidateSelector);
		this.#host.setThinkingLevel(nextThinkingLevel);
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#activeRetryFallback.pinned = this.#activeRetryFallback.pinned || options?.pinFallback === true;
		}
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
	}

	async #tryRetryModelFallback(currentSelector: string, options?: { pinFallback?: boolean }): Promise<boolean> {
		const role = this.#activeRetryFallback?.role ?? this.resolveRetryFallbackRole(currentSelector);
		if (!role) return false;

		const ceiling = this.#host.thinkingLevelCeiling();
		for (const selector of this.findRetryFallbackCandidates(role, currentSelector)) {
			if (this.isRetryFallbackSelectorSuppressed(selector)) continue;
			const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
			const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
			if (!candidate) continue;
			// A candidate whose effort floor exceeds the per-spawn ceiling would be
			// clamped UP past the cap by its model floor — skip it entirely.
			if (ceiling !== undefined && !modelSupportsEffortCeiling(candidate, ceiling)) continue;
			const apiKey = await this.#host.modelRegistry.getApiKey(candidate, this.#host.sessionId());
			if (!apiKey) continue;
			await this.applyRetryFallbackCandidate(role, selector, currentSelector, options);
			return true;
		}

		return false;
	}

	/** The active model when it is a Fireworks Fast (`-fast`) variant, else undefined. */
	#activeFireworksFastModel(): Model | undefined {
		const model = this.#host.model();
		return model?.provider === "fireworks" && isFireworksFastModelId(model.id) ? model : undefined;
	}

	/**
	 * True when the current turn failed on a Fireworks Fast (`-fast`) model in a
	 * way that should degrade to the reliable base (Standard) model. Fast is a
	 * speed-optimized router with no SLA, so any *pre-content* failure — a
	 * transient overload/5xx or a hard "router/model not found / unsupported" —
	 * is worth retrying on the base id. Skips failures the base model shares:
	 * context overflow (compaction's job), usage limits and auth errors (same
	 * account/key), and turns that already emitted any replay-unsafe output.
	 * Requires the base model to exist in the registry.
	 */
	isFireworksFastFallbackEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;
		// A content refusal/sensitivity stop is the model's decision, not a route
		// failure — switching to the base model would just re-trigger it.
		if (this.isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed)) return false;
		return this.#host.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
	}

	/**
	 * True when a turn failed with a hard (non-retryable) provider error but a
	 * configured `retry.fallbackChains` entry covers the active model: the same
	 * model is not worth retrying, yet a DIFFERENT model is a fresh chance, so
	 * the chain is consulted before the error becomes final. Skips failures a
	 * model switch cannot fix or must not replay: cancellations (abort-flavored
	 * errors are not model faults), context overflow (compaction's job),
	 * classifier refusals (chain consult is handled on the retryable path with
	 * `pinFallback`), and turns that already emitted replay-unsafe output.
	 */
	isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const model = this.#host.model();
		if (!model) return false;
		const retrySettings = this.#host.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		if (this.isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (this.#hasReplayUnsafeOutput(message)) return false;
		const currentSelector = formatRetryFallbackSelector(model, this.#host.thinkingLevel());
		const role = this.#activeRetryFallback?.role ?? this.resolveRetryFallbackRole(currentSelector);
		if (!role) return false;
		return this.findRetryFallbackCandidates(role, currentSelector).length > 0;
	}

	/**
	 * Switch the active model from a Fireworks Fast (`-fast`) variant to its base
	 * (Standard) id and stick there for the rest of the session — the auto
	 * fallback that makes Fast a safe default. Returns false when the current
	 * model is not a fast variant, the base id is missing, or it has no key.
	 */
	async #tryFireworksFastFallback(currentSelector: string): Promise<boolean> {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		const baseModel = this.#host.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id));
		if (!baseModel) return false;
		const apiKey = await this.#host.modelRegistry.getApiKey(baseModel, this.#host.sessionId());
		if (!apiKey) return false;
		const baseSelector = formatModelStringWithRouting(baseModel);
		await this.#host.setModelWithProviderSessionReset(baseModel);
		this.#host.sessionManager.appendModelChange(baseSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#host.settings.getStorage()?.recordModelUsage(baseSelector);
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: baseSelector,
			role: "fireworks-fast",
		});
		return true;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<void> {
		if (!this.#activeRetryFallback) return;
		if (this.#activeRetryFallback.pinned) return;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#host.modelRegistry);
		if (!originalSelector) {
			this.clearActiveRetryFallback();
			return;
		}

		const currentModel = this.#host.model();
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel());
		if (currentSelector === originalSelector.raw) {
			if (!this.isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.clearActiveRetryFallback();
			}
			return;
		}
		if (this.isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const resolvedPrimary = resolveModelOverride(
			[originalSelector.raw],
			this.#host.modelRegistry,
			this.#host.settings,
		);
		const primaryModel =
			resolvedPrimary.model ?? this.#host.modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#host.modelRegistry.getApiKey(primaryModel, this.#host.sessionId());
		if (!apiKey) return;

		const currentThinkingLevel = this.#host.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		const primarySelector = formatModelStringWithRouting(primaryModel);
		await this.#host.setModelWithProviderSessionReset(primaryModel);
		this.#host.sessionManager.appendModelChange(primarySelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#host.settings.getStorage()?.recordModelUsage(primarySelector);
		this.#host.setThinkingLevel(thinkingToApply);
		this.clearActiveRetryFallback();
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const retryHintMs = extractRetryHint(undefined, errorMessage);
		if (retryHintMs !== undefined) {
			return retryHintMs;
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		// Smart Fallback if no exact headers found
		return undefined;
	}

	/**
	 * Handle retryable errors with exponential backoff, credential rotation, and
	 * model-fallback chains. Also entered for NON-retryable errors when a switch
	 * is the recovery (`fireworksFastFallback`, `hardErrorFallback`): then a
	 * successful model switch retries immediately, and a failed switch surfaces
	 * the error without a same-model backoff retry.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(
		message: AssistantMessage,
		options?: {
			allowModelFallback?: boolean;
			fireworksFastFallback?: boolean;
			hardErrorFallback?: boolean;
			preserveFailedTurn?: boolean;
		},
	): Promise<boolean> {
		const retrySettings = this.#host.settings.getGroup("retry");
		// The Fireworks Fast→base degrade is an intrinsic model-selection safety net,
		// not a retry loop, so it runs even when the user disabled retries: it switches
		// the model once and lets the base turn proceed.
		if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;
		const classifierRefusal = this.isClassifierRefusal(message);

		const generation = this.#host.promptGeneration();
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		// All attempts on the current model are spent. Don't fail yet: the
		// fallback chain below gets one last consult. Credential rotation can
		// consume the entire budget without the fallback branch ever running
		// (every rotation sets switchedCredential and skips it), so without
		// this last resort a provider-wide usage cap never fails over to the
		// configured chain.
		const maxRetries = this.#isOpenRouterThinkingStreamClose(message)
			? Math.min(retrySettings.maxRetries, 1)
			: retrySettings.maxRetries;
		const retryBudgetExhausted = this.#retryAttempt > maxRetries;

		const errorMessage = message.errorMessage || "未知错误";
		const id = this.#classifyRetryMessage(message);
		const staleOpenAIResponsesReplayError = AIError.is(id, AIError.Flag.StaleResponsesItem);
		const recordedUsageLimitOutcome = await this.#usageLimitOutcomes.get(message);
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = staleOpenAIResponsesReplayError
			? 0
			: calculateRetryBackoffDelayMs(retrySettings.baseDelayMs, this.#retryAttempt);
		let switchedCredential = false;
		let switchedModel = false;
		// Set when a usage-limit error pinned the wait to credential
		// availability — suppresses the generic retry-after bump below.
		let usageLimitWaitMs: number | undefined;

		if (staleOpenAIResponsesReplayError) {
			this.#host.resetCurrentResponsesProviderSession("stale replay error");
		}

		if (!retryBudgetExhausted && !staleOpenAIResponsesReplayError && recordedUsageLimitOutcome) {
			if (
				recordedUsageLimitOutcome.switchedCredential ||
				// Convert the parsed hint to an absolute timestamp NOW, before the
				// hook's usage IO — a duration re-anchored after slow fetches drifts.
				(await this.#host.maybeAutoRedeemCodexReset(
					parsedRetryAfterMs === undefined ? undefined : Date.now() + parsedRetryAfterMs,
				))
			) {
				switchedCredential = true;
				delayMs = 0;
			} else {
				// No sibling credential is usable right now. Wait for whichever
				// comes first: the provider's retry-after window for the current
				// account, or the earliest moment a temporarily blocked sibling
				// frees up (e.g. a 60s post-401 block or a 5-min usage-probe
				// block) — the next attempt's getApiKey re-ranks and picks it up.
				// Without this, one short-lived sibling block escalates a
				// recoverable situation into the provider's multi-hour wait and
				// trips the fail-fast cap below.
				usageLimitWaitMs = recordedUsageLimitOutcome.retryAfterMs;
				if (recordedUsageLimitOutcome.retryAtMs !== undefined) {
					const siblingWaitMs =
						Math.max(0, recordedUsageLimitOutcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;
					if (siblingWaitMs < usageLimitWaitMs) {
						usageLimitWaitMs = siblingWaitMs;
					}
				}
				if (usageLimitWaitMs > delayMs) {
					delayMs = usageLimitWaitMs;
				}
			}
		}

		const allowModelFallback = options?.allowModelFallback !== false;
		const currentModel = this.#host.model();
		const currentSelector = currentModel
			? formatRetryFallbackSelector(currentModel, this.#host.thinkingLevel())
			: undefined;
		if (!staleOpenAIResponsesReplayError && !switchedCredential && currentSelector) {
			// A refusal chain stops at the retry budget: the exhausted-attempt
			// last resort is for provider failures, not classifier decisions.
			if (allowModelFallback && retrySettings.modelFallback && !(retryBudgetExhausted && classifierRefusal)) {
				if (!classifierRefusal) {
					this.noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
				}
				switchedModel = await this.#tryRetryModelFallback(currentSelector, { pinFallback: classifierRefusal });
			}
			// Auto fallback from a Fireworks Fast variant to its base model. Independent
			// of the role-fallback setting: it's intrinsic to the Fast contract (speed
			// best-effort, degrade to Standard on failure) and triggers on hard router
			// errors the generic retry classifier would otherwise reject.
			if (!switchedModel && allowModelFallback && options?.fireworksFastFallback) {
				switchedModel = await this.#tryFireworksFastFallback(currentSelector);
			}
			if (switchedModel) {
				delayMs = 0;
			} else if (usageLimitWaitMs === undefined && parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
				delayMs = parsedRetryAfterMs;
			}
		}

		if (retryBudgetExhausted) {
			if (!switchedModel) {
				await this.persistTerminalEmptyErrorTurn(message);
				// Max retries exceeded and no fallback model to switch to: emit
				// final failure and reset.
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: message.errorMessage,
				});
				this.#clearPendingRecoveredRetryErrors();
				this.#retryAttempt = 0;
				this.resolveRetry(); // Resolve so waitForRetry() completes
				return false;
			}
			// The fallback model gets a fresh retry budget — leaving the spent
			// counter in place would exhaust it again on its first error.
			this.#retryAttempt = 1;
		}
		if (classifierRefusal && !switchedModel) {
			// A prior attempt in this saga already announced `auto_retry_start`
			// (retryAttempt was incremented for each call to this method, so > 1
			// means at least one earlier attempt started the loop) but this
			// attempt is not going to retry — the saga must close with its own
			// `auto_retry_end` so subscribers tracking retry-outstanding state
			// (e.g. suppressing a duplicate error toast) don't stay latched on
			// an announcement that never resolves.
			if (this.#retryAttempt > 1) {
				await this.persistTerminalEmptyErrorTurn(message);
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: errorMessage,
				});
				this.#clearPendingRecoveredRetryErrors();
			}
			this.#retryAttempt = 0;
			this.resolveRetry();
			return false;
		}
		// A fallback switch was the whole reason we entered (Fast→base degrade or
		// a hard-error chain consult) but it could not happen (e.g. no candidate
		// has a credential). Don't fall through to backing-off and retrying the
		// failing model for an error the generic classifier wouldn't retry —
		// surface it instead.
		if (
			(options?.fireworksFastFallback || options?.hardErrorFallback) &&
			!switchedModel &&
			!this.isRetryableError(message)
		) {
			// Same auto_retry_end backstop as the classifier-refusal branch above.
			if (this.#retryAttempt > 1) {
				await this.persistTerminalEmptyErrorTurn(message);
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: errorMessage,
				});
				this.#clearPendingRecoveredRetryErrors();
			}
			this.#retryAttempt = 0;
			this.resolveRetry();
			return false;
		}

		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// subagent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
		const maxDelayMs = retrySettings.maxDelayMs;
		if (maxDelayMs > 0 && delayMs > maxDelayMs && !switchedCredential && !switchedModel) {
			await this.persistTerminalEmptyErrorTurn(message);
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `提供商要求等待 ${delayMs}ms，超过 retry.maxDelayMs（${maxDelayMs}ms）。原始错误：${errorMessage}`,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.resolveRetry();
			return false;
		}

		await this.#recordPendingRecoveredRetryError(message, id, { switchedCredential, switchedModel, delayMs });

		await this.#host.emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: maxRetries,
			delayMs,
			errorMessage,
			errorId: message.errorId,
		});

		// Resolved stream-stall tools have already emitted results. Keep that failed
		// turn intact so continuation cannot repeat their side effects.
		if (!options?.preserveFailedTurn) {
			this.removeAssistantMessageFromActiveContext(message, "auto-retry");
		}

		// A thinking/response loop retried into identical context loops again. Inject a
		// hidden redirect so the retried turn sees a directive to break the repeated
		// pattern instead of re-sampling the same stalled reasoning.
		this.#maybeInjectThinkingLoopRedirect(id);

		// Wait with exponential backoff (abortable).
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "重试已取消",
			});
			this.#clearPendingRecoveredRetryErrors();
			this.resolveRetry();
			return false;
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		// The identity-keyed removal above can miss when a context rebuild
		// recreated the failed turn's message object between settle and retry
		// (fresh identity, same failed tail — issue #5382). Agent.continue()
		// rejects any assistant tail, so a missed removal fails the scheduled
		// retry locally before a provider request is ever made. Re-check the
		// tail after the backoff (covering rebuilds during the sleep too) and
		// strip a still-failed assistant tail by position. Never in
		// preserveFailedTurn mode — the kept turn ends in synthetic tool
		// results that continue() accepts — and never once a newer prompt owns
		// the session.
		if (!options?.preserveFailedTurn && this.#host.promptGeneration() === generation) {
			this.#stripFailedAssistantTail();
		}

		// Retry via continue() outside the agent_end event callback chain. A
		// continuation that still fails locally must close the retry saga —
		// otherwise auto_retry_end never fires, retryPromise stays pending, and
		// the in-flight prompt() (and the TUI retry indicator) hang forever.
		this.#host.scheduleAgentContinue({
			delayMs: 1,
			generation,
			onError: error => void this.#failRetryAfterLocalContinueError(message, error),
		});

		return true;
	}

	/**
	 * Positional backstop for {@link removeAssistantMessageFromActiveContext}:
	 * when the identity check missed, the failed assistant turn is still the
	 * active tail and the scheduled continue() would reject it. An
	 * error/aborted-stopped assistant tail is never legal continuation input
	 * and no recovery path wants it replayed on the wire, so drop it by
	 * position; any healthy tail is left untouched.
	 */
	#stripFailedAssistantTail(): void {
		const messages = this.#host.agent.state.messages;
		const tail = messages[messages.length - 1];
		if (tail?.role !== "assistant") return;
		if (tail.stopReason !== "error" && tail.stopReason !== "aborted") return;
		logger.debug("agent active context failed assistant tail stripped positionally", {
			stopReason: tail.stopReason,
			timestamp: tail.timestamp,
		});
		this.#host.agent.replaceMessages(messages.slice(0, -1));
	}

	/**
	 * Close the retry saga when the scheduled continue() failed locally (no
	 * provider request was made). Mirrors the other retry dead-ends: emit the
	 * closing `auto_retry_end` so subscribers stop showing retry progress, and
	 * resolve the retry promise so the in-flight prompt() unwinds (issue #5382).
	 */
	async #failRetryAfterLocalContinueError(message: AssistantMessage, error: unknown): Promise<void> {
		if (this.#retryAttempt === 0) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		const localError = error instanceof Error ? error.message : String(error);
		await this.persistTerminalEmptyErrorTurn(message);
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: `本地重试续跑失败：${localError}。原始错误：${message.errorMessage ?? "未知错误"}`,
		});
		this.#clearPendingRecoveredRetryErrors();
		this.resolveRetry();
	}

	/**
	 * Inject a hidden redirect notice when a thinking/response loop is being retried, so
	 * the retried turn carries an instruction to break the repeated pattern instead of
	 * re-sampling the same stalled context. Injected on every {@link AIError.Flag.ThinkingLoop}
	 * retry (the failed assistant is dropped each attempt, so the notice does not accumulate
	 * unboundedly). No-op unless `id` carries the ThinkingLoop flag and the loop guard is
	 * enabled. The notice is generic on purpose — the detector's detail can quote raw model
	 * text, which must not be interpolated into a higher-priority developer message.
	 */
	#maybeInjectThinkingLoopRedirect(id: number): void {
		if (!AIError.is(id, AIError.Flag.ThinkingLoop)) return;
		if (this.#host.settings.get("model.loopGuard.enabled") !== true) return;
		this.#host.agent.appendMessage({
			role: "custom",
			customType: THINKING_LOOP_REDIRECT_TYPE,
			content: thinkingLoopRedirectTemplate,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.sessionManager.appendCustomMessageEntry(
			THINKING_LOOP_REDIRECT_TYPE,
			thinkingLoopRedirectTemplate,
			false,
			undefined,
			"agent",
		);
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this.resolveRetry();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.#host.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("等待先前 Agent 运行结束以继续提示时超时。");
				}
				await this.#host.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.#host.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.#host.settings.set("retry.enabled", enabled);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from active agent state when present and
	 * re-attempts with a fresh retry budget.
	 *
	 * A stream that stalls or aborts mid-tool-call ends the turn with
	 * `stopReason: "error" | "aborted"` and then appends one synthetic
	 * {@link isSyntheticToolResultMessage tool_result} per emitted tool call to
	 * preserve the provider's tool_use/tool_result pairing (see
	 * `createAbortedToolResult` in `agent-loop.ts`). Those placeholders trail the
	 * failed assistant turn, so the retry lookback walks back over them before
	 * checking the assistant message; it strips both the placeholders and the
	 * failed turn before re-attempting.
	 *
	 * A restored session deliberately omits failed assistant turns from provider
	 * context. In that case, the persisted display transcript remains the source
	 * of truth for whether the current branch has a retryable failed tail.
	 *
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.#host.isStreaming() || this.#host.isCompacting() || this.isRetrying) return false;

		const messages = this.#host.agent.state.messages;
		const activeTurnEnd = retryableAssistantTurnEnd(messages);
		if (activeTurnEnd !== undefined) {
			// Remove the failed/aborted assistant message plus its synthetic tool
			// results (same as auto-retry does before re-attempting).
			this.#host.agent.replaceMessages(messages.slice(0, activeTurnEnd - 1));
		} else {
			// A restored session already dropped the failed assistant turn (and its
			// paired synthetic tool results) from provider context, so the persisted
			// display transcript is the source of truth for a retryable failed tail.
			const transcriptMessages = this.#host.sessionManager.buildSessionContext({ transcript: true }).messages;
			if (retryableAssistantTurnEnd(transcriptMessages) === undefined) return false;
		}

		// Reset retry budget for a fresh attempt
		this.#retryAttempt = 0;

		// Re-attempt the turn
		this.#host.scheduleAgentContinue({ delayMs: 1 });

		return true;
	}
}
