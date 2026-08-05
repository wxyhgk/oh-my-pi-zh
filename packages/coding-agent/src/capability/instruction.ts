/**
 * Instructions Capability
 *
 * GitHub Copilot-style instructions with optional file pattern matching.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * An instruction with optional file pattern matching.
 */
export interface Instruction {
	/** Instruction name (derived from filename) */
	name: string;
	/** Absolute path to instruction file */
	path: string;
	/** Instruction content (markdown) */
	content: string;
	/** Glob pattern for files this applies to */
	applyTo?: string;
	/** Source metadata */
	_source: SourceMeta;
}

export const instructionCapability = defineCapability<Instruction>({
	id: "instructions",
	displayName: "指令",
	description: "带 glob 模式匹配的文件特定指令(GitHub Copilot 格式)",
	key: inst => inst.name,
	toExtensionId: inst => `instruction:${inst.name}`,
	validate: inst => {
		if (!inst.name) return "缺少名称";
		if (!inst.path) return "缺少路径";
		if (inst.content === undefined) return "缺少内容";
		return undefined;
	},
});
