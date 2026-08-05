import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginSiliconFlow = createApiKeyLogin({
	providerLabel: "SiliconFlow",
	authUrl: "https://cloud.siliconflow.com/account/ak",
	instructions: "Create or copy your API key from the SiliconFlow console",
	promptMessage: "Paste your SiliconFlow API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "siliconflow",
		modelsUrl: "https://api.siliconflow.com/v1/models",
	},
});

export const siliconflowProvider = {
	id: "siliconflow",
	name: "SiliconFlow",
	login: (cb: OAuthLoginCallbacks) => loginSiliconFlow(cb),
} as const satisfies ProviderDefinition;
