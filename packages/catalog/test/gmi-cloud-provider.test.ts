import { describe, expect, test } from "bun:test";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { GMI_CLOUD_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("GMI Cloud provider", () => {
	test("static seed covers the descriptor's default model", () => {
		// Regression for the empty-slice bug: without this seed a regen run
		// without a GMI_API_KEY bundles no gmi-cloud models, and the declared
		// defaultModel is unresolvable at boot before async discovery fires.
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "gmi-cloud");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
			envVars: ["GMI_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(GMI_CLOUD_STATIC_MODELS.map(model => model.id)).toContain("deepseek-ai/DeepSeek-V4-Flash");
	});
});
