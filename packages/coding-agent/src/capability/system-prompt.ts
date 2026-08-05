/**
 * System Prompt Capability
 *
 * Custom system prompt files (SYSTEM.md) that modify the agent's base system prompt.
 * Distinct from context-files which are user instructions shown in conversation.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A system prompt customization file.
 */
export interface SystemPrompt {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/** Which level this came from */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const systemPromptCapability = defineCapability<SystemPrompt>({
	id: "system-prompt",
	displayName: "系统提示词",
	description: "修改 Agent 行为的自定义系统提示词文件(SYSTEM.md)",
	key: sp => sp.level,
	validate: sp => {
		if (!sp.path) return "缺少路径";
		if (sp.content === undefined) return "缺少内容";
		return undefined;
	},
});
