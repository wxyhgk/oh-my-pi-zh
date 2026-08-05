/**
 * Context Files Capability
 *
 * System instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.) that provide
 * persistent guidance to the agent.
 */
import * as path from "node:path";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A context file that provides persistent instructions to the agent.
 */
export interface ContextFile {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/** Which level this came from */
	level: "user" | "project";
	/** Distance from cwd (0 = in cwd, 1 = parent, etc.) for project files */
	depth?: number;
	/** Source metadata */
	_source: SourceMeta;
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "上下文文件",
	description: "指导 Agent 行为的持久指令文件(CLAUDE.md、AGENTS.md 等)",
	// Deduplicate by scope: one user-level file, and one project-level file per directory depth.
	// Within each depth level, higher-priority providers shadow lower-priority ones.
	// This supports monorepo hierarchies where AGENTS.md exists at multiple ancestor levels.
	// Clamp depth >= 0: files inside config subdirectories of an ancestor (e.g. .claude/, .github/)
	// are same-scope as the ancestor itself.
	key: file => (file.level === "user" ? "user" : `project:${Math.max(0, file.depth ?? 0)}`),
	toExtensionId: file => `context-file:${file.level}:${path.basename(file.path)}`,
	validate: file => {
		if (!file.path) return "缺少路径";
		if (file.content === undefined) return "缺少内容";
		if (file.level !== "user" && file.level !== "project") return "无效层级:必须为 'user' 或 'project'";
		return undefined;
	},
});
