import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createProviderErrorMessage } from "../../ai/src/providers/error-message";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"], model: Model): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage: "timeout",
		timestamp: Date.now(),
	};
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	fallbackChains?: Record<string, string[]>,
): TurnRecoveryHost {
	const settings = Settings.isolated(fallbackChains ? { "retry.fallbackChains": fallbackChains } : {});
	return {
		agent: undefined as never,
		sessionManager: undefined as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		sessionId: () => "test-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

describe("TurnRecovery replay-unsafe output classification", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-replay-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("treats a failed turn with partial non-whitespace text as NOT retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Here is the first part of my answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("allows replay-safe hard fallback and excludes visible text with a configured chain", () => {
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
			}),
		);
		// Thinking-only output is replay-safe: nothing visible reached the user.
		const message = makeMessage([{ type: "thinking", thinking: "safe reasoning before failing" }], model);
		const visible = makeMessage([{ type: "text", text: "Already shown" }], model);
		expect(recovery.isHardErrorFallbackEligible(visible)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("excludes a Fireworks Fast failed turn with partial visible text from Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		const message = makeMessage([{ type: "text", text: "partial visible output" }], fastModel);
		expect(recovery.isFireworksFastFallbackEligible(message)).toBe(false);
	});

	it("keeps a Fireworks Fast empty/whitespace failed turn eligible for Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([], fastModel))).toBe(true);
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([{ type: "text", text: "   \n" }], fastModel))).toBe(
			true,
		);
	});

	it("treats a thinking-only partial turn as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Let me reason about this step by step." }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a whitespace-only text partial as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("keeps the tool-call case replay-unsafe (no regression)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps an empty-content error retriable (baseline)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a mix of thinking and text as replay-unsafe (text wins)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Reasoning before the visible answer." },
				{ type: "text", text: "The answer is 42." },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats thinking plus whitespace-only text as replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Long reasoning." },
				{ type: "text", text: "  " },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("does not retry malformed calls after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Already shown" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("retries malformed calls with replay-safe output", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Unshown reasoning" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats generated images as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats Anthropic server tools as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{
					type: "anthropicServerTool",
					block: { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "status" } },
				},
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps replay-safe classifier refusals retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const thinking = makeMessage([{ type: "thinking", thinking: "reasoning before refusal" }], model);
		thinking.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(thinking)).toBe(true);

		const whitespace = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		whitespace.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(whitespace)).toBe(true);

		const empty = makeMessage([], model);
		empty.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(empty)).toBe(true);
	});

	it("does not retry a classifier refusal after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Visible refusal output" }], model);
		message.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps pre-stream provider diagnostics replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = createProviderErrorMessage(model, new Error("fetch failed"));
		expect(recovery.isRetryableError(message)).toBe(true);
	});
});
