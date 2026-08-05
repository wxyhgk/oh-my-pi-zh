/**
 * Image Generation Providers
 *
 * Leaf module (no runtime deps) shared by the image_gen tool, the settings
 * schema, and settings migrations — mirrors `web/search/types.ts` so the
 * provider list, auto order, and settings choices never drift apart.
 */

/** Image generation backends, in settings/tool vocabulary. */
export type ImageProvider = "antigravity" | "gemini" | "openai" | "openai-codex" | "openrouter" | "xai";

/** Auto-resolution fallback order when no configured entry or session provider matches. */
export const AUTO_IMAGE_PROVIDER_ORDER: readonly ImageProvider[] = [
	"openai",
	"openai-codex",
	"antigravity",
	"xai",
	"openrouter",
	"gemini",
];

/** Settings choices for `providers.imageOrder` (labels shared with the retired single-preference enum). */
export const IMAGE_PROVIDER_CHOICES = [
	{
		value: "openai",
		label: "OpenAI",
		description: "使用 OPENAI_API_KEY (gpt-image-2) 或当前激活的 GPT 模型;回退到已连接的 Codex 订阅",
	},
	{
		value: "openai-codex",
		label: "OpenAI Codex (ChatGPT)",
		description: "使用已连接的 Codex / ChatGPT 订阅 — 无需 OPENAI_API_KEY",
	},
	{
		value: "antigravity",
		label: "Antigravity",
		description: "需要 google-antigravity OAuth",
	},
	{
		value: "xai",
		label: "xAI Grok Imagine",
		description: "需要 xAI Grok OAuth 或 XAI_API_KEY",
	},
	{ value: "gemini", label: "Gemini", description: "需要 GEMINI_API_KEY" },
	{ value: "openrouter", label: "OpenRouter", description: "需要 OPENROUTER_API_KEY" },
] as const satisfies ReadonlyArray<{ value: ImageProvider; label: string; description: string }>;

export function isImageProviderId(value: unknown): value is ImageProvider {
	return typeof value === "string" && AUTO_IMAGE_PROVIDER_ORDER.includes(value as ImageProvider);
}
