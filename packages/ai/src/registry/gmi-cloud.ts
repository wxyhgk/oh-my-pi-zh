import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginGmiCloud = createApiKeyLogin({
	providerLabel: "GMI Cloud",
	authUrl: "https://console.gmicloud.ai",
	instructions: "Create or copy your GMI Cloud API key",
	promptMessage: "Paste your GMI Cloud API key",
	placeholder: "eyJ...",
	validation: {
		kind: "models-endpoint",
		provider: "GMI Cloud",
		modelsUrl: "https://api.gmi-serving.com/v1/models",
	},
});

export const gmiCloudProvider = {
	id: "gmi-cloud",
	name: "GMI Cloud",
	login: (cb: OAuthLoginCallbacks) => loginGmiCloud(cb),
} as const satisfies ProviderDefinition;
