import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type FetchImpl } from "@wxyhgk/pi-ai";
import { buildModel } from "@wxyhgk/pi-catalog/build";
import { writeModelCache } from "@wxyhgk/pi-catalog/model-cache";
import { getBundledModel } from "@wxyhgk/pi-catalog/models";
import { parseArgs } from "@wxyhgk/pi-coding-agent/cli/args";
import { ModelRegistry, type ProviderConfigInput } from "@wxyhgk/pi-coding-agent/config/model-registry";
import { getModelMatchPreferences, resolveModelScope } from "@wxyhgk/pi-coding-agent/config/model-resolver";
import { Settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { buildSessionOptions as buildCliSessionOptions } from "@wxyhgk/pi-coding-agent/main";
import { createAgentSession, type ExtensionFactory } from "@wxyhgk/pi-coding-agent/sdk";
import { AuthStorage } from "@wxyhgk/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@wxyhgk/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@wxyhgk/pi-utils";

describe("createAgentSession deferred model pattern resolution", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-model-selection-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "runtime-reasoning-model",
					name: "Runtime Reasoning Model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	const dynamicOnlyProviderConfig: ProviderConfigInput = {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		fetchDynamicModels: async () => [
			{
				id: "cached-runtime-model",
				name: "Cached Runtime Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	};

	const dynamicOnlyProviderExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", dynamicOnlyProviderConfig);
	};

	async function buildSessionOptions(modelPattern: string | string[]) {
		// Pass an explicit ModelRegistry so createAgentSession skips its implicit
		// ModelRegistry.refreshInBackground() — a network model-discovery pass
		// (~250ms/session) that contributes nothing here: the model resolves from
		// the inline extension provider, never from network catalogs. Mirrors the
		// explicit-registry pattern the resume tests below already rely on.
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelPattern,
		};
	}

	test("resolves explicit modelPattern after extension providers register", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			await buildSessionOptions("runtime-provider/runtime-model"),
		);

		expect(session.model).toBeDefined();
		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-model");
		expect(modelFallbackMessage).toBeUndefined();
	});

	test("resolves explicit dynamic-only modelPattern from fresh runtime cache", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir, "dynamic-auth.db"));
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, "models.yml");
		const primerRegistry = new ModelRegistry(authStorage, modelsPath);
		primerRegistry.registerProvider("runtime-provider", dynamicOnlyProviderConfig, "ext://runtime");
		await primerRegistry.refreshRuntimeProviders("online");
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [dynamicOnlyProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			modelPattern: "runtime-provider/cached-runtime-model",
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("cached-runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("does not silently fallback when explicit modelPattern is unresolved", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			await buildSessionOptions("missing-provider/missing-model"),
		);

		expect(session.model).toBeUndefined();
		expect(modelFallbackMessage).toBe('Model "missing-provider/missing-model" not found');
	});

	test("uses auth fallback when deferred subagent modelPattern resolves without working credentials", async () => {
		const parentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!parentModel) {
			throw new Error("Expected bundled anthropic parent model");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "fallback-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(parentModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "fallback-models.yml"));
		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async requested => {
			if (requested.provider === "runtime-provider") return undefined;
			if (requested.provider === parentModel.provider) return "test-key";
			return undefined;
		});
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			modelPattern: "runtime-provider/runtime-model",
			modelPatternAuthFallback: `${parentModel.provider}/${parentModel.id}`,
		});

		try {
			expect(session.model?.provider).toBe(parentModel.provider);
			expect(session.model?.id).toBe(parentModel.id);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
			getApiKeySpy.mockRestore();
		}
	});

	test("resolves deferred role-alias modelPattern after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", "runtime-provider/runtime-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...(await buildSessionOptions("@smol")),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resolves deferred bare configured role names after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "runtime-provider/runtime-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...(await buildSessionOptions("task")),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resolves deferred suffixed bare configured roles after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "runtime-provider/runtime-reasoning-model");
		const authStorage = await AuthStorage.create(path.join(tempDir, "cli-auth.db"));
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "cli-models.yml"));
		const parsed = parseArgs(["--model", "task:high"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.modelPattern).toBe("task:high");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			try {
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-reasoning-model");
				expect(session.thinkingLevel).toBe(Effort.High);
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("defers bare role chains when an earlier candidate may be registered by extensions", async () => {
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!fallbackModel) {
			throw new Error("Expected bundled anthropic fallback model");
		}
		const settings = Settings.isolated();
		settings.setModelRole("task", `runtime-provider/runtime-model,${fallbackModel.provider}/${fallbackModel.id}`);
		const authStorage = await AuthStorage.create(path.join(tempDir, "role-chain-auth.db"));
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "role-chain-models.yml"));
		const parsed = parseArgs(["--model", "task"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			try {
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-model");
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("prefers authenticated providers for deferred bare role candidates", async () => {
		const settings = Settings.isolated({
			modelProviderOrder: ["aimlapi", "openai"],
		});
		settings.setModelRole("task", "missing-provider/missing-model,gpt-4o-mini");
		const authStorage = await AuthStorage.create(path.join(tempDir, "ambiguous-role-auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "ambiguous-role-models.yml"));
		const parsed = parseArgs(["--model", "task"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");

			const { session } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			try {
				expect(session.model?.provider).toBe("openai");
				expect(session.model?.id).toBe("gpt-4o-mini");
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("uses a configured suffixed role fallback when its primary model is unavailable", async () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				slow: ["missing-provider/missing-fallback", "runtime-provider/runtime-reasoning-model"],
			},
		});
		settings.setModelRole("slow", "missing-provider/missing-model");
		const authStorage = await AuthStorage.create(path.join(tempDir, "missing-role-auth.db"));
		authStorage.setRuntimeApiKey("runtime-provider", "test-key");
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "missing-role-models.yml"));
		const parsed = parseArgs(["--model", "slow:low"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.modelPattern).toBe("slow:low");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			try {
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-reasoning-model");
				// `low` differs from the fallback model's default (`high`), so this
				// proves the suffix is inherited rather than the model default applied.
				expect(session.thinkingLevel).toBe(Effort.Low);
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("preserves deferred bare role fallback chains", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...(await buildSessionOptions("task")),
			modelPatternFallbackRole: "subagent:deferred",
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred"]).toEqual([
				"runtime-provider/runtime-reasoning-model",
			]);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("skips a depleted coding-plan model before creating a noninteractive subagent session", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model");
		const options = await buildSessionOptions("task");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware",
			settings,
			hasUI: false,
		});
		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-reasoning-model");
		} finally {
			await session.dispose();
		}
	});

	test("defers ACP reserve fallback until prompt-time capabilities are configured", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model");
		const options = await buildSessionOptions("task");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware-acp",
			settings,
			hasUI: false,
			deferUsageReserveConfirmation: true,
		});
		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("enforces fail-closed reserve policy without requiring a fallback candidate", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		const options = await buildSessionOptions("runtime-provider/runtime-model");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "reserve",
			accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
		});

		await expect(
			createAgentSession({
				...options,
				settings,
				hasUI: false,
			}),
		).rejects.toThrow("储备策略为 fail-closed");
	});

	test("installs fallback chain for remaining deferred subagent modelPattern candidates", async () => {
		const { session } = await createAgentSession({
			...(await buildSessionOptions(["runtime-provider/runtime-model", "runtime-provider/runtime-reasoning-model"])),
			modelPatternFallbackRole: "subagent:deferred",
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred"]).toEqual([
				"runtime-provider/runtime-reasoning-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("installs an inherited fallback chain for a deferred singleton modelPattern", async () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["runtime-provider/runtime-reasoning-model"],
			},
		});
		settings.setModelRole("default", "runtime-provider/runtime-reasoning-model");
		const { session } = await createAgentSession({
			...(await buildSessionOptions("runtime-provider/runtime-model")),
			settings,
			modelPatternFallbackRole: "subagent:deferred-default",
			modelPatternDefaultFallbackChain: ["runtime-provider/runtime-reasoning-model"],
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred-default")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred-default"]).toEqual([
				"runtime-provider/runtime-reasoning-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("splits deferred comma-delimited modelPattern and installs fallback chain", async () => {
		const { session } = await createAgentSession({
			...(await buildSessionOptions("runtime-provider/runtime-model,runtime-provider/runtime-reasoning-model")),
			modelPatternFallbackRole: "subagent:deferred",
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred"]).toEqual([
				"runtime-provider/runtime-reasoning-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("does not apply default role thinking override when modelPattern is explicit", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "off" });
		settings.setModelRole("smol", "runtime-provider/runtime-reasoning-model");
		settings.setModelRole("default", "@smol:high");

		const { session } = await createAgentSession({
			...(await buildSessionOptions("runtime-provider/runtime-reasoning-model")),
			settings,
		});

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		expect(session.thinkingLevel).toBe("off");
	});

	test("clamps a max default thinking level to the model's ladder ceiling", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "max" });

		const { session } = await createAgentSession({
			...(await buildSessionOptions("runtime-provider/runtime-reasoning-model")),
			settings,
		});

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		// The extension model has no explicit ladder; the inferred fallback tops
		// out at xhigh, so the real max level clamps down.
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	test("selects the settings default model without synchronously validating auth", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated();
		settings.setModelRole("default", `${defaultModel.provider}/${defaultModel.id}`);

		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("settings default model should not validate auth during startup"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			try {
				expect(session.model?.provider).toBe(defaultModel.provider);
				expect(session.model?.id).toBe(defaultModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
			authStorage.close();
		}
	});

	test("refreshes cached llama.cpp vision metadata for the startup default model", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir, "llama-vision-auth.db"));
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, "llama-vision-models.yml");
		const cacheDbPath = path.join(tempDir, "models.db");
		const cachedModel = buildModel({
			id: "vision-model",
			name: "vision-model",
			provider: "llama.cpp",
			api: "openai-responses",
			baseUrl: "http://127.0.0.1:8080",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32768,
		});
		writeModelCache("llama.cpp", Date.now(), [cachedModel], true, "", cacheDbPath);

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({ data: [{ id: "vision-model", object: "model", meta: { n_ctx: 239104 } }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 239104,
							params: { max_tokens: -1, n_predict: -1 },
						},
						modalities: { vision: true },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });
		const settings = Settings.isolated();
		settings.setModelRole("default", "llama.cpp/vision-model");

		expect(modelRegistry.find("llama.cpp", "vision-model")?.input).toEqual(["text"]);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.input).toEqual(["text", "image"]);
			expect(modelRegistry.find("llama.cpp", "vision-model")?.input).toEqual(["text", "image"]);
		} finally {
			await session.dispose();
		}
	});

	test("restores the saved session model without resolving auth over the network", async () => {
		// Regression: `restoreSessionModel` probed each saved-model candidate with
		// the async `getApiKey`, which refreshes OAuth tokens and hits the auth
		// broker. When the broker was unreachable that blocked resume for the full
		// ~10s refresh timeout — the "Still starting … restoreSessionModel" hang.
		// Selection now uses the synchronous, side-effect-free `hasConfiguredAuth`
		// probe; the real key is resolved lazily per request via the resolver.
		const savedModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!savedModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "resume-saved-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(savedModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-saved-model.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-saved", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${savedModel.provider}/${savedModel.id}`,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "resume-saved-sessions"));

		// A rejecting getApiKey stands in for the unreachable broker / hanging
		// OAuth refresh: if startup awaits it to pick the restore model, it surfaces.
		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("startup model restore must not resolve auth over the network"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				sessionManager,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			try {
				expect(session.model?.provider).toBe(savedModel.provider);
				expect(session.model?.id).toBe(savedModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
		}
	});

	test("prefers the provider default over catalog order in the startup fallback", async () => {
		// Regression: with an Anthropic key but no configured `default` role and no
		// session/CLI model, the step-4 startup fallback used to pick the first
		// anthropic model in models.json catalog order (claude-3-5-sonnet-20240620)
		// instead of the provider's configured default from DEFAULT_MODEL_PER_PROVIDER
		// (claude-opus-4-8).
		const providerDefault = getBundledModel("anthropic", "claude-opus-4-8");
		const catalogFirst = getBundledModel("anthropic", "claude-3-5-sonnet-20240620");
		if (!providerDefault || !catalogFirst) {
			throw new Error("Expected bundled anthropic models for fallback regression");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "fallbackauth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		// No `default` model role configured: forces the step-4 startup fallback.
		const settings = Settings.isolated({ enabledModels: ["anthropic/*"] });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.provider).toBe("anthropic");
			expect(session.model?.id).toBe(providerDefault.id);
			expect(session.model?.id).not.toBe(catalogFirst.id);
		} finally {
			await session.dispose();
		}
	});

	test("prefers Codex OAuth over plain OpenAI for the shared startup default", async () => {
		const openaiDefault = getBundledModel("openai", "gpt-5.5");
		const codexDefault = getBundledModel("openai-codex", "gpt-5.5");
		if (!openaiDefault || !codexDefault) {
			throw new Error("Expected bundled OpenAI and Codex GPT-5.5 defaults");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "codex-fallback-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "sk-or-v1-invalid-openai-key");
		authStorage.setRuntimeApiKey("openai-codex", "codex-oauth-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ enabledModels: ["openai/gpt-5.5", "openai-codex/gpt-5.5"] }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.provider).toBe("openai-codex");
			expect(session.model?.id).toBe(codexDefault.id);
			expect(session.model?.id).toBe(openaiDefault.id);
		} finally {
			await session.dispose();
		}
	});

	test("restores role model max selector from extension provider after startup resume", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-extension.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${defaultModel.provider}/${defaultModel.id}`,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "runtime-provider/runtime-reasoning-model:max",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-reasoning-model");
			expect(session.thinkingLevel).toBe(Effort.XHigh);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("restores extension role model when saved default cannot be restored before extensions load", async () => {
		const settingsDefaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!settingsDefaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(settingsDefaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Saved default points at a provider that has no usable credentials. The
		// last active role (`smol`) is supplied by the inline extension and is
		// only resolvable once provider registrations are processed.
		const targetSessionFile = path.join(tempDir, "resume-extension-default-missing.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext-no-default", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "anthropic/not-available",
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "runtime-provider/runtime-model",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions-no-default"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${settingsDefaultModel.provider}/${settingsDefaultModel.id}`);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("resolves the default role to an extension model in enabledModels instead of silently substituting an in-scope provider (issue #6694)", async () => {
		const configuredModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!configuredModel) {
			throw new Error("Expected bundled anthropic configured model");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "scope-6694-auth.db"));
		authStoragesToClose.push(authStorage);
		// The extension provider carries an inline apiKey; the "normally
		// configured" provider needs credentials so it lands in the startup scope.
		authStorage.setRuntimeApiKey(configuredModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "scope-6694-models.yml"));

		const enabledModels = ["runtime-provider/runtime-model", `${configuredModel.provider}/${configuredModel.id}`];
		const settings = Settings.isolated({ enabledModels });
		settings.setModelRole("default", "runtime-provider/runtime-model");

		// main.ts resolves the model scope BEFORE extensions register providers,
		// so the extension-registered model is dropped and only the configured
		// provider survives into the startup scope.
		const scopedModels = await resolveModelScope(
			enabledModels,
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.map(scoped => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${configuredModel.provider}/${configuredModel.id}`,
		]);

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parseArgs([]),
				scopedModels,
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);

			const { session } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			try {
				// The configured default role names the extension model, which is
				// itself listed in enabledModels. Once extensions register their
				// providers it must win — not be silently replaced by the other
				// in-scope provider's model.
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-model");
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});
	test("pins the first CLI --models scoped model even when the saved default role is out of scope", async () => {
		const scopedTarget = getBundledModel("openai", "gpt-4o-mini");
		const savedDefault = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!scopedTarget || !savedDefault) {
			throw new Error("Expected bundled openai and anthropic models");
		}
		const authStorage = await AuthStorage.create(path.join(tempDir, "cli-scope-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(scopedTarget.provider, "test-key");
		authStorage.setRuntimeApiKey(savedDefault.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "cli-scope-models.yml"));
		const settings = Settings.isolated({});
		settings.setModelRole("default", `${savedDefault.provider}/${savedDefault.id}`);

		const parsed = parseArgs(["--models", `${scopedTarget.provider}/${scopedTarget.id}`]);
		const scopedModels = await resolveModelScope(
			parsed.models ?? [],
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.map(scoped => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${scopedTarget.provider}/${scopedTarget.id}`,
		]);

		const cliOptions = await buildCliSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);
		// The issue #6694 deferral must NOT apply to an explicit CLI scope:
		// createAgentSession re-resolves the default role against
		// `settings.enabledModels` only and never sees `--models`, so leaving
		// `options.model` unset would let the saved out-of-scope default
		// silently escape the scope the user just asked for.
		expect(cliOptions.model?.provider).toBe(scopedTarget.provider);
		expect(cliOptions.model?.id).toBe(scopedTarget.id);
	});
});
