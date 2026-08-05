import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	canBranch?: () => boolean;
}

class BtwFooter implements Component {
	#getLine: () => string;
	#line: string | undefined;
	#text: Text | undefined;

	constructor(getLine: () => string) {
		this.#getLine = getLine;
	}

	render(width: number): readonly string[] {
		const line = this.#getLine();
		if (line !== this.#line || !this.#text) {
			this.#line = line;
			this.#text = new Text(line, 1, 0);
		}
		return this.#text.render(width);
	}
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#rebuild();
	}

	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", replaceTabs(this.#question)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new BtwFooter(() => this.#footerLine()));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc 取消 /btw");
			case "complete": {
				if (!this.isCopyable()) return theme.fg("muted", "Esc 关闭");
				const actions = ["c 复制"];
				if (this.#canBranch?.() ?? this.isBranchable()) actions.push("b 分支到对话");
				actions.push("Esc 关闭");
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} 正在分支到对话…`);
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
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} 正在等待响应…` : "未返回文本。";
			return new Text(theme.fg("dim", waiting), 1, 0);
		}
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
