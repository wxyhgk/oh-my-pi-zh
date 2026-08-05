import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginXAI = createApiKeyLogin({
	providerLabel: "xAI",
	authUrl: "https://console.x.ai/team/default/api-keys",
	instructions: "Create or copy your API key from the xAI Console",
	promptMessage: "Paste your xAI API key",
	placeholder: "xai-...",
	validation: {
		kind: "models-endpoint",
		provider: "xAI",
		modelsUrl: "https://api.x.ai/v1/models",
	},
});

export const xaiProvider = {
	id: "xai",
	name: "xAI API",
	login: (cb: OAuthLoginCallbacks) => loginXAI(cb),
} as const satisfies ProviderDefinition;
