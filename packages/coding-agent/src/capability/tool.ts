/**
 * Custom Tools Capability
 *
 * User-defined tools that extend agent capabilities.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A custom tool definition.
 */
export interface CustomTool {
	/** Tool name (unique key) */
	name: string;
	/** Absolute path to tool definition file */
	path: string;
	/** Tool description */
	description: string;
	/** Tool implementation (script path or inline) */
	implementation?: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const toolCapability = defineCapability<CustomTool>({
	id: "tools",
	displayName: "自定义工具",
	description: "扩展 Agent 能力的用户自定义工具",
	key: tool => tool.name,
	toExtensionId: tool => `tool:${tool.name}`,
	validate: tool => {
		if (!tool.name) return "缺少名称";
		if (!tool.path) return "缺少路径";
		return undefined;
	},
});
