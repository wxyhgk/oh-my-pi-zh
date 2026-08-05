import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginNovita = createApiKeyLogin({
	providerLabel: "Novita",
	authUrl: "https://novita.ai/settings/key-management",
	instructions: "Create or copy your API key from the Novita dashboard",
	promptMessage: "Paste your Novita API key",
	placeholder: "sk_...",
	validation: {
		// Validate against inference, not billing: `/openapi/v1/billing/balance/detail`
		// requires the account-level Balance permission, which Novita's Developer and
		// Basic team roles don't hold, so their valid inference keys were rejected.
		kind: "chat-completions",
		provider: "Novita",
		baseUrl: "https://api.novita.ai/openai/v1",
		model: "moonshotai/kimi-k2.7-code",
	},
});

export const novitaProvider = {
	id: "novita",
	name: "Novita",
	login: loginNovita,
} satisfies ProviderDefinition & { readonly id: "novita" };
