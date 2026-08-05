import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginAiand = createApiKeyLogin({
	providerLabel: "ai&",
	authUrl: "https://console.aiand.com/api-keys",
	instructions: "Copy your API key from the ai& console",
	promptMessage: "Paste your ai& API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "ai&",
		modelsUrl: "https://api.aiand.com/v1/models",
	},
});

export const aiandProvider = {
	id: "aiand",
	name: "ai&",
	login: (cb: OAuthLoginCallbacks) => loginAiand(cb),
} as const satisfies ProviderDefinition;
