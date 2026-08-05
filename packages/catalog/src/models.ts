import { buildModel } from "./build";
import MODELS from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, ModelSpec, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, stencil.so overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
const modelRegistry = new Map<string, Map<string, Model<Api>>>();

/** Build (once) and return one provider's enriched bundled models. */
function getProviderModels(provider: string): Map<string, Model<Api>> | undefined {
	const cachedModels = modelRegistry.get(provider);
	if (cachedModels !== undefined) return cachedModels;
	if (!Object.hasOwn(MODELS, provider)) return undefined;

	const providerModels = new Map<string, Model<Api>>();
	const rawModels = MODELS[provider as keyof typeof MODELS];
	for (const [id, model] of Object.entries(rawModels)) {
		providerModels.set(id, buildModel(model as ModelSpec<Api>));
	}
	modelRegistry.set(provider, providerModels);
	return providerModels;
}

export type GeneratedProvider = keyof typeof MODELS;

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getProviderModels(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): KnownProvider[] {
	return Object.keys(MODELS) as KnownProvider[];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getProviderModels(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const orchestration = usage.orchestration;
	usage.cost.input = (model.cost.input / 1000000) * (usage.input + (orchestration?.input ?? 0));
	usage.cost.output = (model.cost.output / 1000000) * (usage.output + (orchestration?.output ?? 0));
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * (usage.cacheRead + (orchestration?.cacheRead ?? 0));
	usage.cost.cacheWrite = cacheWriteCost(model, usage);
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/**
 * Price cache-write tokens, honoring the TTL breakdown when the provider reports one.
 *
 * `model.cost.cacheWrite` is the 5-minute write rate (Anthropic bills 5m writes at
 * 1.25x base input). When `usage.cttl` is present the write mixes 5m and 1h
 * breakpoints — omp defaults to 1h retention on first-party Anthropic, and 1h writes
 * bill at 2x base input — so each component is priced at its own rate instead of the
 * flat 5m rate. Deriving 1h from `input * 2` (Anthropic's published multiplier) is
 * model-independent and stays correct even for legacy entries whose stored
 * `cacheWrite` scalar drifts from 1.25x input. Providers that omit `cttl`
 * (everyone but Anthropic) keep the flat-rate calculation.
 *
 * The breakdown is documented to sum to `usage.cacheWrite`, but the two are written
 * from independent wire fields (`cache_creation` vs `cache_creation_input_tokens`),
 * so any unattributed remainder is priced at the flat rate instead of being dropped:
 * a partial or stale breakdown must never make write tokens free.
 */
function cacheWriteCost<TApi extends Api>(model: Model<TApi>, usage: Usage): number {
	const rate5m = model.cost.cacheWrite / 1000000;
	const cttl = usage.cttl;
	if (!cttl) return rate5m * usage.cacheWrite;
	const fiveMinute = cttl.ephemeral5m ?? 0;
	const oneHour = cttl.ephemeral1h ?? 0;
	const residual = Math.max(0, usage.cacheWrite - fiveMinute - oneHour);
	return rate5m * (fiveMinute + residual) + ((model.cost.input * 2) / 1000000) * oneHour;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
