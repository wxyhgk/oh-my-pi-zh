import type { ModelSpec, ResolvedBedrockCompat } from "../types";
import { applyCompatOverrides } from "./apply";

const NO_EXPLICIT_CHECKPOINTS: ResolvedBedrockCompat = {
	promptCacheMode: "none",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 0,
	promptCacheMaximumCheckpoints: 0,
};
const EXPLICIT_CHECKPOINTS_1024_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 1024,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_1024_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 1024,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_2048_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 2048,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_4096_5M: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: false,
	promptCacheMinimumTokens: 4096,
	promptCacheMaximumCheckpoints: 4,
};

const EXPLICIT_CHECKPOINTS_4096_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 4096,
	promptCacheMaximumCheckpoints: 4,
};

// AWS モデルカード: 512 トークン、最大 4 個のキャッシュチェックポイント、5 分と 1 時間の TTL。
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html
const EXPLICIT_CHECKPOINTS_512_1H: ResolvedBedrockCompat = {
	promptCacheMode: "explicit",
	supportsLongPromptCacheRetention: true,
	promptCacheMinimumTokens: 512,
	promptCacheMaximumCheckpoints: 4,
};

/**
 * Explicit Nova cache points complement Bedrock's automatic prefix caching:
 * AWS recommends them for consistent cache hits and input-cost savings. Keep
 * these exact documented model and inference-profile IDs conservative rather
 * than treating arbitrary Nova-like application profiles as checkpoint-capable.
 */
function detectedBedrockCompat(modelId: string): ResolvedBedrockCompat {
	const id = modelId.toLowerCase();

	if (
		id === "amazon.nova-lite-v1:0" ||
		id === "us.amazon.nova-lite-v1:0" ||
		id === "amazon.nova-micro-v1:0" ||
		id === "us.amazon.nova-micro-v1:0" ||
		id === "amazon.nova-pro-v1:0" ||
		id === "us.amazon.nova-pro-v1:0" ||
		id === "amazon.nova-premier-v1:0" ||
		id === "us.amazon.nova-premier-v1:0" ||
		id === "amazon.nova-2-lite-v1:0" ||
		id === "us.amazon.nova-2-lite-v1:0" ||
		id === "eu.amazon.nova-2-lite-v1:0" ||
		id === "jp.amazon.nova-2-lite-v1:0" ||
		id === "global.amazon.nova-2-lite-v1:0"
	) {
		return EXPLICIT_CHECKPOINTS_1024_5M;
	}

	// https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
	// This list is deliberately sourced from AWS model cards, not cache pricing:
	// https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html
	if (
		id.includes("anthropic.claude-opus-4-5") ||
		id.includes("anthropic.claude-sonnet-4-5") ||
		id.includes("anthropic.claude-haiku-4-5") ||
		id.includes("anthropic.claude-opus-4-7") ||
		id.includes("anthropic.claude-opus-4-8") ||
		id.includes("anthropic.claude-sonnet-5")
	) {
		return EXPLICIT_CHECKPOINTS_4096_1H;
	}
	if (id.includes("anthropic.claude-opus-5")) {
		return EXPLICIT_CHECKPOINTS_512_1H;
	}
	if (id.includes("anthropic.claude-opus-4-6")) {
		return EXPLICIT_CHECKPOINTS_4096_5M;
	}
	if (id.includes("anthropic.claude-3-5-haiku")) {
		return EXPLICIT_CHECKPOINTS_2048_5M;
	}
	if (id.includes("anthropic.claude-fable-5")) {
		return EXPLICIT_CHECKPOINTS_1024_1H;
	}

	if (
		id.includes("anthropic.claude-opus-4-1") ||
		id.includes("anthropic.claude-opus-4-20250514") ||
		id.includes("anthropic.claude-sonnet-4-20250514") ||
		id.includes("anthropic.claude-sonnet-4-6") ||
		id.includes("anthropic.claude-3-7-sonnet") ||
		id.includes("anthropic.claude-3-5-sonnet-20241022-v2")
	) {
		return EXPLICIT_CHECKPOINTS_1024_5M;
	}

	return NO_EXPLICIT_CHECKPOINTS;
}

/** Resolve Bedrock Converse prompt-cache capabilities once per model. */
export function buildBedrockCompat(spec: ModelSpec<"bedrock-converse-stream">): ResolvedBedrockCompat {
	const compat = { ...detectedBedrockCompat(spec.id) };
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
