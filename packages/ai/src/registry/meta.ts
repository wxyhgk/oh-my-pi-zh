import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginMeta = createApiKeyLogin({
	providerLabel: "Meta Model API",
	authUrl: "https://developer.meta.com/ai/",
	instructions: "Create or copy your key from the Meta Model API dashboard",
	promptMessage: "Paste your Meta Model API key",
	placeholder: "Model API key",
	validation: {
		kind: "models-endpoint",
		provider: "Meta Model API",
		modelsUrl: "https://api.meta.ai/v1/models",
	},
});

export const metaProvider = {
	id: "meta",
	name: "Meta Model API",
	login: (cb: OAuthLoginCallbacks) => loginMeta(cb),
} as const satisfies ProviderDefinition;
