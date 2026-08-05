/**
 * InspectorPanel - Detail view for selected extension.
 *
 * Shows name, description, origin, status, and kind-specific preview.
 */
import * as os from "node:os";
import { isZodSchema, zodToWireSchema } from "@wxyhgk/pi-ai/utils/schema";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@wxyhgk/pi-tui";
import { theme } from "../../../modes/theme/theme";
import { shortenPath } from "../../../tools/render-utils";
import type { Extension, ExtensionState } from "./types";

export class InspectorPanel implements Component {
	#extension: Extension | null = null;

	setExtension(extension: Extension | null): void {
		this.#extension = extension;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		if (!this.#extension) {
			return [theme.fg("muted", "选择一个扩展"), theme.fg("dim", "以查看详情")];
		}

		const ext = this.#extension;
		const lines: string[] = [];

		// Name header
		lines.push(theme.bold(theme.fg("accent", ext.displayName)));
		lines.push("");

		// Kind badge
		lines.push(theme.fg("muted", "类型: ") + this.#getKindBadge(ext.kind));
		lines.push("");

		// Description (wrapped)
		const desc = ext.description;
		const isValidDescription = typeof desc === "string" && desc.length > 0;
		if (isValidDescription && width > 2) {
			const wrapped = wrapTextWithAnsi(desc, width - 2);
			for (const line of wrapped) {
				lines.push(truncateToWidth(line, width));
			}
			lines.push("");
		} else if (isValidDescription) {
			// Width too small for wrapping, show truncated single line
			lines.push(truncateToWidth(desc, width));
			lines.push("");
		}

		// Origin
		lines.push(theme.fg("muted", "来源:"));
		const levelLabel = ext.source.level === "user" ? "用户" : ext.source.level === "project" ? "项目" : "内置";
		lines.push(`  ${theme.italic(`经由 ${ext.source.providerName} (${levelLabel})`)}`);
		const shortened = shortenPath(ext.path, os.homedir());
		// If path is very long, show just the last parts
		const displayPath =
			shortened.length > 40 && shortened.split("/").length > 3
				? `.../${shortened.split("/").slice(-3).join("/")}`
				: shortened;
		lines.push(`  ${theme.fg("dim", displayPath)}`);
		lines.push("");

		// Status badge
		lines.push(theme.fg("muted", "状态:"));
		lines.push(`  ${this.#getStatusBadge(ext.state, ext.disabledReason, ext.shadowedBy)}`);
		lines.push("");

		// Preview section (routed based on kind)
		const previewLines = this.#renderPreview(ext, width);
		lines.push(...previewLines);

		return lines;
	}

	#renderPreview(ext: Extension, width: number): string[] {
		const lines: string[] = [];
		let content: string[] = [];

		switch (ext.kind) {
			case "context-file":
				content = this.#renderFilePreview(ext.raw, width);
				break;
			case "tool":
				content = this.#renderToolArgs(ext.raw, width);
				break;
			case "skill":
				content = this.#renderSkillContent(ext.raw, width);
				break;
			case "mcp":
				content = this.#renderMcpDetails(ext.raw, width);
				break;
			default:
				content = this.#renderDefaultPreview(ext, width);
				break;
		}

		if (content.length > 0) {
			lines.push(...content);
		}

		return lines;
	}

	#renderFilePreview(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "预览:"));
		lines.push(theme.fg("dim", theme.boxRound.horizontal.repeat(Math.min(width - 2, 40))));

		const content = this.#getContextFileContent(raw);
		if (!content) {
			lines.push(theme.fg("dim", "  (无内容)"));
			lines.push("");
			return lines;
		}

		const fileLines = content.split("\n");
		for (const line of fileLines.slice(0, 20)) {
			const highlighted = this.#highlightMarkdown(line);
			lines.push(truncateToWidth(highlighted, width - 2));
		}

		if (fileLines.length > 20) {
			lines.push(theme.fg("dim", "(截断至第 20 行)"));
		}

		lines.push("");
		return lines;
	}

	#getContextFileContent(raw: unknown): string | null {
		if (raw && typeof raw === "object" && "content" in raw) {
			const content = (raw as { content?: unknown }).content;
			return typeof content === "string" ? content : null;
		}
		return null;
	}

	#highlightMarkdown(line: string): string {
		// Basic markdown syntax highlighting
		let highlighted = line;

		// Headers
		if (/^#{1,6}\s/.test(highlighted)) {
			highlighted = theme.bold(theme.fg("accent", highlighted));
		}
		// Code blocks
		else if (/^```/.test(highlighted)) {
			highlighted = theme.fg("dim", highlighted);
		}
		// Lists
		else if (/^[\s]*[-*+]\s/.test(highlighted)) {
			highlighted = highlighted.replace(/^([\s]*[-*+]\s)/, theme.fg("accent", "$1"));
		}
		// Numbered lists
		else if (/^[\s]*\d+\.\s/.test(highlighted)) {
			highlighted = highlighted.replace(/^([\s]*\d+\.\s)/, theme.fg("accent", "$1"));
		}

		return highlighted;
	}

	#renderToolArgs(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "参数:"));
		lines.push(theme.fg("dim", theme.boxRound.horizontal.repeat(Math.min(width - 2, 40))));

		try {
			const tool = raw as any;
			const wire = (s: unknown): any => (isZodSchema(s) ? zodToWireSchema(s) : s);
			const paramSchema = wire(tool?.parameters);
			const inputSchema = wire(tool?.inputSchema);
			const params = paramSchema?.properties || inputSchema?.properties || {};

			if (Object.keys(params).length === 0) {
				lines.push(theme.fg("dim", "  (无参数)"));
			} else {
				const required = new Set(paramSchema?.required || inputSchema?.required || []);

				for (const [name, spec] of Object.entries(params)) {
					const param = spec as any;
					const type = param.type || "any";
					const isRequired = required.has(name);
					const defaultVal = param.default !== undefined ? `默认: ${param.default}` : null;

					const nameCol = theme.fg("accent", name.padEnd(12));
					const typeCol = theme.fg("muted", type.padEnd(10));
					const reqCol = isRequired
						? theme.fg("warning", "必填")
						: defaultVal
							? theme.fg("dim", defaultVal)
							: theme.fg("dim", "可选");

					lines.push(`  ${nameCol} ${typeCol} ${reqCol}`);
				}
			}
		} catch {
			lines.push(theme.fg("dim", "  (无法解析工具定义)"));
		}

		lines.push("");
		return lines;
	}

	#renderSkillContent(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "说明:"));
		lines.push(theme.fg("dim", theme.boxRound.horizontal.repeat(Math.min(width - 2, 40))));

		try {
			const skill = raw as any;
			const instruction = skill?.prompt || skill?.instruction || skill?.content || "";

			if (!instruction) {
				lines.push(theme.fg("dim", "  (无说明文本)"));
			} else {
				const instructionLines = instruction.split("\n").slice(0, 15);
				for (const line of instructionLines) {
					lines.push(truncateToWidth(line, width - 2));
				}

				if (instruction.split("\n").length > 15) {
					lines.push(theme.fg("dim", "(截断至第 15 行)"));
				}
			}
		} catch {
			lines.push(theme.fg("dim", "  (无法解析技能内容)"));
		}

		lines.push("");
		return lines;
	}

	#renderMcpDetails(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "连接:"));
		lines.push(theme.fg("dim", theme.boxRound.horizontal.repeat(Math.min(width - 2, 40))));

		try {
			const mcp = raw as any;
			const transport = mcp?.transport || mcp?.type || "未知";
			const command = mcp?.command || mcp?.cmd || "";
			const args = mcp?.args || mcp?.arguments || [];

			lines.push(`  ${theme.fg("muted", "传输方式:")}  ${theme.fg("accent", transport)}`);

			if (command) {
				lines.push(`  ${theme.fg("muted", "命令:")}    ${theme.fg("success", command)}`);
			}

			if (Array.isArray(args) && args.length > 0) {
				lines.push(`  ${theme.fg("muted", "参数:")}       ${theme.fg("dim", args.join(" "))}`);
			}

			// Environment variables if present
			if (mcp?.env && typeof mcp.env === "object") {
				const envCount = Object.keys(mcp.env).length;
				if (envCount > 0) {
					lines.push(`  ${theme.fg("muted", "环境变量:")}   ${theme.fg("dim", `${envCount} 个已定义`)}`);
				}
			}
		} catch {
			lines.push(theme.fg("dim", "  (无法解析 MCP 配置)"));
		}

		lines.push("");
		return lines;
	}

	#renderDefaultPreview(ext: Extension, width: number): string[] {
		const lines: string[] = [];

		// Show trigger pattern if present
		if (ext.trigger) {
			lines.push(theme.fg("muted", "触发:"));
			lines.push(theme.fg("dim", theme.boxRound.horizontal.repeat(Math.min(width - 2, 40))));
			lines.push(`  ${theme.fg("accent", ext.trigger)}`);
			lines.push("");
		}

		return lines;
	}

	#getKindBadge(kind: string): string {
		const kindColors: Record<string, string> = {
			"extension-module": "accent",
			skill: "accent",
			rule: "success",
			tool: "warning",
			mcp: "accent",
			prompt: "muted",
			hook: "warning",
			"context-file": "dim",
			instruction: "muted",
			"slash-command": "accent",
		};

		const color = kindColors[kind] || "muted";
		return theme.fg(color as any, kind);
	}

	#getStatusBadge(state: ExtensionState, reason?: string, shadowedBy?: string): string {
		switch (state) {
			case "active":
				return theme.fg("success", `${theme.status.enabled} 已启用`);
			case "disabled": {
				const reasonText =
					reason === "provider-disabled"
						? "提供商已禁用"
						: reason === "item-disabled"
							? "手动禁用"
							: "未知";
				return theme.fg("dim", `${theme.status.disabled} 已禁用 (${reasonText})`);
			}
			case "shadowed":
				return theme.fg("warning", `${theme.status.shadowed} 被遮蔽${shadowedBy ? ` (${shadowedBy})` : ""}`);
		}
	}
}
