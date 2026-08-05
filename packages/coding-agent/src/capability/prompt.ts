/**
 * Prompts Capability
 *
 * Reusable prompt templates (Codex format) available via /prompts: menu.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A reusable prompt template.
 */
export interface Prompt {
	/** Prompt name (filename without extension) */
	name: string;
	/** Absolute path to prompt file */
	path: string;
	/** Prompt content (markdown) */
	content: string;
	/** Source metadata */
	_source: SourceMeta;
}

export const promptCapability = defineCapability<Prompt>({
	id: "prompts",
	displayName: "提示词",
	description: "可通过 /prompts: 菜单使用的可复用提示词模板",
	key: prompt => prompt.name,
	toExtensionId: prompt => `prompt:${prompt.name}`,
	validate: prompt => {
		if (!prompt.name) return "缺少名称";
		if (!prompt.path) return "缺少路径";
		if (prompt.content === undefined) return "缺少内容";
		return undefined;
	},
});
