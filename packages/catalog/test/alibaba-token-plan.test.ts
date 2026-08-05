import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	ALIBABA_TOKEN_PLAN_BASE_URL,
	ALIBABA_TOKEN_PLAN_STATIC_MODELS,
	alibabaTokenPlanModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { serializeAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";

describe("QwenCloud Token Plan provider", () => {
	test("ships the documented Individual text-model allowlist", () => {
		expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.map(model => model.id)).toEqual([
			"qwen3.8-max-preview",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.6-flash",
			"glm-5.2",
			"deepseek-v4-pro",
		]);

		const preview = ALIBABA_TOKEN_PLAN_STATIC_MODELS[0];
		expect(preview).toMatchObject({
			provider: "alibaba-token-plan",
			baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
			contextWindow: 983_616,
			maxTokens: 131_072,
			input: ["text", "image"],
			thinking: {
				efforts: [Effort.Low, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
			},
		});

		expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(model => model.id === "glm-5.2")?.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.Max,
		]);
	});

	test("discovers subscribed chat models from the native models endpoint", async () => {
		let requestedUrl = "";
		let authorization = "";
		const fetchMock: FetchImpl = (input, init) => {
			requestedUrl = String(input);
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return Promise.resolve(
				Response.json({
					data: [
						{
							id: "qwen3.7-plus",
							name: "server metadata must not replace curated metadata",
							owned_by: "qwencloud",
							context_length: 262_144,
							max_completion_tokens: 16_384,
						},
						{ id: "deepseek-v4-flash", owned_by: "qwencloud" },
						{ id: "deepseek-v4-flash-0731", owned_by: "qwencloud" },
						{ id: "kimi-k2.7-code", owned_by: "qwencloud" },
						{ id: "MiniMax-M2.5", owned_by: "qwencloud" },
						{ id: "fun-asr", owned_by: "qwencloud" },
						{ id: "qwen-image-2.0-pro", owned_by: "qwencloud" },
						{ id: "qwen-audio-3.0-tts-plus", owned_by: "qwencloud" },
						{ id: "happyhorse-1.1-t2v", owned_by: "qwencloud" },
						{ id: "text-embedding-v4", owned_by: "qwencloud" },
						{ id: "wan2.7-image", owned_by: "qwencloud" },
					],
				}),
			);
		};

		const apiKey = `  ${serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=test")}  `;
		const options = alibabaTokenPlanModelManagerOptions({ apiKey, fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe(`${ALIBABA_TOKEN_PLAN_BASE_URL}/models`);
		expect(authorization).toBe("Bearer sk-sp-test");
		expect(models?.map(model => model.id)).toEqual([
			"deepseek-v4-flash",
			"deepseek-v4-flash-0731",
			"kimi-k2.7-code",
			"MiniMax-M2.5",
			"qwen3.7-plus",
		]);
		expect(models?.find(model => model.id === "deepseek-v4-flash")).toMatchObject({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: ["high", "max"],
			},
		});
		expect(models?.find(model => model.id === "deepseek-v4-flash-0731")).toMatchObject({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: ["high", "max"],
			},
		});
		expect(models?.find(model => model.id === "qwen3.7-plus")).toMatchObject({
			id: "qwen3.7-plus",
			provider: "alibaba-token-plan",
			name: "Qwen3.7 Plus",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});
		expect(options.dynamicModelsAuthoritative).toBe(true);
	});

	test("routes discovery to the credential's region when it is China (Beijing)", async () => {
		let requestedUrl = "";
		const fetchMock: FetchImpl = input => {
			requestedUrl = String(input);
			return Promise.resolve(Response.json({ data: [{ id: "qwen3.7-plus", owned_by: "qwencloud" }] }));
		};

		const apiKey = serializeAlibabaTokenPlanCredential(
			"sk-sp-beijing",
			"",
			"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		);
		const options = alibabaTokenPlanModelManagerOptions({ apiKey, fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models");
		expect(models?.[0]).toMatchObject({
			id: "qwen3.7-plus",
			baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		});
	});

	test("rejects malformed compound credentials before model discovery", () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json({ data: [] }));
		};

		const options = alibabaTokenPlanModelManagerOptions({
			apiKey: '  {"token":"sk-sp-test","cookie":"session=secret"',
			fetch: fetchMock,
		});
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(fetched).toBe(false);
	});

	test("uses Token Plan-specific environment keys and authoritative discovery", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "alibaba-token-plan");
		expect(descriptor).toMatchObject({
			defaultModel: "qwen3.7-plus",
			envVars: ["ALIBABA_TOKEN_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY"],
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { label: "QwenCloud Token Plan" },
		});
	});
});
