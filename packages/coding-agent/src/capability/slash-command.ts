/**
 * Slash Commands Capability
 *
 * File-based slash commands defined as markdown files.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A file-based slash command.
 */
export interface SlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Absolute path to command file */
	path: string;
	/** Command content (markdown template) */
	content: string;
	/** Source level */
	level: "user" | "project" | "native";
	/** Source metadata */
	_source: SourceMeta;
}

export const slashCommandCapability = defineCapability<SlashCommand>({
	id: "slash-commands",
	displayName: "斜杠命令",
	description: "以 Markdown 文件定义的自定义斜杠命令",
	key: cmd => cmd.name,
	toExtensionId: cmd => `slash-command:${cmd.name}`,
	validate: cmd => {
		if (!cmd.name) return "缺少名称";
		if (!cmd.path) return "缺少路径";
		if (cmd.content === undefined) return "缺少内容";
		if (cmd.level !== "user" && cmd.level !== "project" && cmd.level !== "native") {
			return "无效层级:必须为 'user'、'project' 或 'native'";
		}
		return undefined;
	},
});
