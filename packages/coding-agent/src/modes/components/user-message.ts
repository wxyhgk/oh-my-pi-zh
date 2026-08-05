import { type Component, Container, Markdown } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { imageReferenceHyperlink, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
// Do not emit OSC 133 C ("command start") here: the transcript has no matching
// command-finished marker, so terminals can group later assistant/tool output
// under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		// Paint the magic keywords ("ultrathink"/"orchestrate"/"workflowz") inside the rendered
		// bubble too — matching the live editor glow. The Markdown component routes code spans and
		// fenced blocks through its own code styling (never `color`), so those are already excluded;
		// `highlightMagicKeywords` additionally restores the bubble's own foreground after each
		// painted keyword so the gradient never bleeds into the rest of the line.
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const baseText = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		const imageLabel = (value: string) => theme.fg("accent", `\x1b[1m\x1b[4m${value}\x1b[24m\x1b[22m`);
		const color = (value: string) =>
			renderPlaceholders(value, {
				renderText: baseText,
				renderReference: (label, kind, index) =>
					kind === "image"
						? imageReferenceHyperlink(label, index, imageLinks, imageLabel)
						: theme.fg("accent", `\x1b[1m${label}\x1b[22m`),
			});
		const md = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor,
			color,
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const wrapped = lines.slice();
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_END;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}

/**
 * Collapsed placeholder for a synthetic (agent-attributed) user input in the
 * file/remote-backed transcript viewer — chiefly the advisor's `Session update`
 * replay dumps, which can each be hundreds of KiB of Markdown and, on cold open,
 * blocked the TUI for tens of seconds while every historical body was laid out
 * before the viewport clip (issue #6308).
 *
 * Collapsed by default: renders one dim summary row (label · size · line count ·
 * expand hint) and builds NO Markdown. The heavy {@link UserMessageComponent} is
 * constructed lazily only when expanded via `ctrl+o`, so blocks above the
 * viewport never pay layout cost until the reader asks to see them. The raw
 * observability data stays intact in `__advisor.jsonl`.
 */
export class CollapsedSyntheticMessageComponent implements Component {
	#expanded = false;
	#cache?: { width: number; lines: readonly string[] };
	#body?: UserMessageComponent;
	readonly #summary: string;

	constructor(
		private readonly text: string,
		private readonly imageLinks?: readonly (string | undefined)[],
	) {
		this.#summary = summarizeSyntheticInput(text);
	}

	/** ctrl+o toggle: reveal/hide the full Markdown body. */
	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#body?.invalidate?.();
	}

	dispose(): void {
		this.#body?.dispose?.();
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines = this.#expanded ? this.#renderExpanded(width) : [` ${this.#summaryRow(width)}`];
		this.#cache = { width, lines };
		return lines;
	}

	#renderExpanded(width: number): readonly string[] {
		if (!this.#body) this.#body = new UserMessageComponent(this.text, true, this.imageLinks);
		return [` ${this.#summaryRow(width)}`, ...this.#body.render(width)];
	}

	#summaryRow(width: number): string {
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		return theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)));
	}
}

/** Truncate a plain summary label to `maxWidth` display columns, appending `…`. */
function truncateSummary(text: string, maxWidth: number): string {
	if (Bun.stringWidth(text, { countAnsiEscapeCodes: false }) <= maxWidth) return text;
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = Bun.stringWidth(ch, { countAnsiEscapeCodes: false });
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/**
 * One-line summary for a collapsed synthetic input: `<label> · <size> · <n>
 * lines`. The label is the first Markdown heading's text (e.g. `Session
 * update`), falling back to `Synthetic input` when the body opens with none.
 */
function summarizeSyntheticInput(text: string): string {
	const size = formatBytes(Buffer.byteLength(text, "utf-8"));
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const dot = theme.sep.dot.trim();
	return `${syntheticInputLabel(text)} ${dot} ${size} ${dot} ${lineCount} 行`;
}

/** First Markdown heading text in `text`, else `Synthetic input`. */
function syntheticInputLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading ? heading[1]!.trim() || "合成输入" : "合成输入";
	}
	return "合成输入";
}
