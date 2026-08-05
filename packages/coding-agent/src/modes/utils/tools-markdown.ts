import type { Tool } from "../../tools";

export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<Pick<Tool, "description" | "name">>;
	/** Tools mounted under `xd://` URLs, listed after the active set. */
	xdevTools?: ReadonlyArray<{ name: string; summary: string }>;
}

function escapeTableCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " ")
		.trim();
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0 && !bindings.xdevTools?.length) {
		return "当前没有对 Agent 可见的工具。";
	}

	const rows: string[] = [];
	for (const tool of bindings.tools) {
		const description = escapeTableCell(tool.description) || "未提供描述。";
		rows.push(`| \`${tool.name}\` | ${description} |`);
	}
	for (const mounted of bindings.xdevTools ?? []) {
		rows.push(`| \`xd://${mounted.name}\` | ${escapeTableCell(mounted.summary) || "未提供描述。"} |`);
	}

	return ["| 工具 | 描述 |", "|------|-------------|", ...rows].join("\n");
}
