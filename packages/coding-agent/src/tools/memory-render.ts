/**
 * Inline TUI renderers for the long-term memory tools (`retain`, `recall`,
 * `reflect`).
 *
 * These keep the transcript terse — one status line plus, for `retain`, one
 * `Remember: …` line per stored item — instead of the generic JSON arg tree,
 * which exploded multi-line memory blobs into an unreadable wall. The tool
 * container is a transparent passthrough, so these renderers stay frameless:
 * a status line with a couple of dim bullets reads far cleaner than boxing a
 * one-line memory note.
 */
import type { Component } from "@wxyhgk/pi-tui";
import { Text } from "@wxyhgk/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import {
	createCachedComponent,
	formatErrorMessage,
	formatExpandHint,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIStatus,
} from "./render-utils";

// Each stored memory renders as `<bullet> <content>`; the bullet glyph comes
// from the active theme (`•` by default, a nerd-font dot under nerd themes).

interface RetainRenderArgs {
	items?: unknown;
}

interface QueryRenderArgs {
	query?: string;
}

function retainContents(args: RetainRenderArgs | undefined): string[] {
	const items = args?.items;
	if (!Array.isArray(items)) return [];

	const contents: string[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object" || !("content" in item) || typeof item.content !== "string") continue;
		const content = replaceTabs(item.content.trim());
		if (content.length > 0) contents.push(content);
	}
	return contents;
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content?.find(c => c.type === "text")?.text ?? "").trim();
}

/** Single-line query header used by `recall`/`reflect` calls and results. */
function queryHeader(
	title: string,
	query: string | undefined,
	icon: ToolUIStatus,
	theme: Theme,
	meta?: string[],
	iconOverride?: string,
): string {
	const trimmed = replaceTabs((query ?? "").trim());
	const description = trimmed ? truncateToWidth(trimmed, 80, Ellipsis.Unicode) : undefined;
	return renderStatusLine({ icon, iconOverride, title, description, meta }, theme);
}

function retainComponent(contents: string[], header: string, getExpanded: () => boolean, theme: Theme): Component {
	return createCachedComponent(getExpanded, (width, expanded) => {
		const lines = [header];
		const limit = expanded ? contents.length : PREVIEW_LIMITS.COLLAPSED_ITEMS;
		const shown = contents.slice(0, limit);
		const bullet = theme.format.bullet;
		const contentWidth = Math.max(8, width - 2 - Bun.stringWidth(bullet) - 1);
		for (const content of shown) {
			const value = truncateToWidth(content, contentWidth, Ellipsis.Unicode);
			lines.push(`  ${theme.fg("muted", bullet)} ${theme.fg("toolOutput", value)}`);
		}
		const remaining = contents.length - shown.length;
		if (remaining > 0) {
			lines.push(`  ${theme.fg("dim", `… 还有 ${remaining} 条`)} ${formatExpandHint(theme, expanded, true)}`);
		}
		return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
	});
}

export const retainToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: RetainRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		const contents = retainContents(args);
		const header = renderStatusLine({ icon: "pending", title: "保留" }, theme);
		return retainComponent(contents, header, () => options.expanded, theme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: { count?: number }; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: RetainRenderArgs,
	): Component {
		if (result.isError) {
			return new Text(formatErrorMessage(resultText(result) || "保留失败", theme), 0, 0);
		}
		const contents = retainContents(args);
		// `summary` is the tool's own "N memories stored/queued." line; drop the
		// trailing period so it reads cleanly as a status meta segment.
		const summary = resultText(result).replace(/[.。]$/, "");
		const header = renderStatusLine(
			{
				iconOverride: theme.styledSymbol("tool.memory", "accent"),
				title: "保留",
				meta: summary ? [summary] : undefined,
			},
			theme,
		);
		return retainComponent(contents, header, () => options.expanded, theme);
	},
};

export const recallToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: QueryRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(queryHeader("回忆", args.query, "pending", theme), 0, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: QueryRenderArgs,
	): Component {
		if (result.isError) {
			return new Text(formatErrorMessage(resultText(result) || "回忆失败", theme), 0, 0);
		}
		const text = resultText(result);
		const match = text.match(/^找到 (\d+) 条相关/);
		const found = match ? Number(match[1]) : 0;
		const meta = [found > 0 ? `找到 ${found} 条` : "无匹配"];
		const header =
			found > 0
				? queryHeader("回忆", args?.query, "success", theme, meta, theme.styledSymbol("tool.memory", "accent"))
				: queryHeader("回忆", args?.query, "warning", theme, meta);
		if (found === 0) {
			return new Text(header, 0, 0);
		}
		// Collapsed view is the header alone; expand to inspect the recalled
		// memories without dumping the whole block into the transcript.
		const body = text.replace(/^[^\n]*\n+/, "");
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => {
				const lines = [header];
				if (expanded) {
					const bodyLines = body.split("\n").slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED);
					for (const line of bodyLines) {
						lines.push(`  ${theme.fg("muted", replaceTabs(line))}`);
					}
				} else {
					lines.push(`  ${formatExpandHint(theme, false, true)}`);
				}
				return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};

export const reflectToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: QueryRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(queryHeader("反思", args.query, "pending", theme), 0, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: QueryRenderArgs,
	): Component {
		if (result.isError) {
			return new Text(formatErrorMessage(resultText(result) || "反思失败", theme), 0, 0);
		}
		const header = queryHeader(
			"反思",
			args?.query,
			"success",
			theme,
			undefined,
			theme.styledSymbol("tool.memory", "accent"),
		);
		const answer = resultText(result);
		const answerLines = answer.split("\n").filter(line => line.trim().length > 0);
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => {
				const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
				const shown = answerLines.slice(0, limit);
				const lines = [header];
				for (const line of shown) {
					lines.push(`  ${theme.fg("toolOutput", replaceTabs(line))}`);
				}
				const remaining = answerLines.length - shown.length;
				if (remaining > 0) {
					lines.push(
						`  ${theme.fg("dim", `… 还有 ${remaining} 行`)} ${formatExpandHint(theme, expanded, true)}`,
					);
				}
				return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};
