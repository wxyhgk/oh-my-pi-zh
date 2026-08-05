import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginSiliconFlowCn = createApiKeyLogin({
	providerLabel: "SiliconFlow (China)",
	authUrl: "https://cloud.siliconflow.cn/account/ak",
	instructions: "Create or copy your API key from the SiliconFlow console",
	promptMessage: "Paste your SiliconFlow API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "siliconflow-cn",
		modelsUrl: "https://api.siliconflow.cn/v1/models",
	},
});

export const siliconflowCnProvider = {
	id: "siliconflow-cn",
	name: "SiliconFlow (China)",
	login: (cb: OAuthLoginCallbacks) => loginSiliconFlowCn(cb),
} as const satisfies ProviderDefinition;
