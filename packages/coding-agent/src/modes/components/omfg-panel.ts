import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@wxyhgk/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export type OmfgPanelState =
	| "generating"
	| "validating"
	| "confirming"
	| "saving"
	| "saved"
	| "rejected"
	| "aborted"
	| "error";

interface OmfgPanelComponentOptions {
	complaint: string;
	tui: TUI;
}

export class OmfgPanelComponent extends Container {
	#complaint: string;
	#tui: TUI;
	#state: OmfgPanelState = "generating";
	#status = "正在生成 TTSR 规则…";
	#preview = "";
	#savedPath: string | undefined;
	#errorMessage: string | undefined;
	#closed = false;

	constructor(options: OmfgPanelComponentOptions) {
		super();
		this.#complaint = options.complaint;
		this.#tui = options.tui;
		this.#rebuild();
	}

	appendDraft(delta: string): void {
		if (!delta || this.#closed) return;
		this.#preview += delta;
		this.#rebuild();
	}

	setRule(text: string): void {
		if (this.#closed) return;
		this.#preview = text;
		this.#rebuild();
	}

	setStatus(state: OmfgPanelState, status: string): void {
		if (this.#closed) return;
		this.#state = state;
		this.#status = status;
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markSaved(path: string): void {
		if (this.#closed) return;
		this.#state = "saved";
		this.#savedPath = path;
		this.#status = `已保存 ${path}`;
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markRejected(): void {
		if (this.#closed) return;
		this.#state = "rejected";
		this.#status = "规则未保存。";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#status = "已取消。";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#status = "无法创建规则。";
		this.#errorMessage = message;
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", replaceTabs(`/omfg ${this.#complaint}`)), 1, 0));
		this.addChild(new Text(theme.fg("muted", replaceTabs(this.#status)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#footerLine(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.#tui.requestRender();
	}

	#footerLine(): string {
		switch (this.#state) {
			case "generating":
			case "validating":
			case "confirming":
			case "saving":
				return theme.fg("muted", "Esc 取消 /omfg");
			case "saved":
				return theme.fg(
					"success",
					`${theme.status.success} 已实时注册 · ${replaceTabs(this.#savedPath ?? "已保存")} · Esc 关闭`,
				);
			case "rejected":
				return theme.fg("warning", `${theme.status.warning} 未保存 · Esc 关闭`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} 已取消 · Esc 关闭`);
			case "error":
				return theme.fg("error", `${theme.status.error} 错误 · Esc 关闭`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? "未知错误")), 1, 0);
		}
		const text = replaceTabs(this.#preview).trim();
		if (!text) {
			return new Text(theme.fg("dim", `${theme.status.pending} 正在等待候选规则…`), 1, 0);
		}
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
