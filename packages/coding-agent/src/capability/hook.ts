/**
 * Hooks Capability
 *
 * Pre/post tool execution hooks defined as shell scripts.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A hook script.
 */
export interface Hook {
	/** Hook name (filename without extension) */
	name: string;
	/** Absolute path to hook file */
	path: string;
	/** Hook type (pre/post) and associated tool */
	type: "pre" | "post";
	/** Tool this hook applies to, or "*" for all */
	tool: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const hookCapability = defineCapability<Hook>({
	id: "hooks",
	displayName: "钩子",
	description: "工具执行前/后的钩子",
	key: hook => `${hook.type}:${hook.tool}:${hook.name}`,
	toExtensionId: hook => `hook:${hook.type}:${hook.tool}:${hook.name}`,
	validate: hook => {
		if (!hook.name) return "缺少名称";
		if (!hook.path) return "缺少路径";
		if (hook.type !== "pre" && hook.type !== "post") return "无效类型(必须为 'pre' 或 'post')";
		if (!hook.tool) return "缺少工具";
		return undefined;
	},
});
