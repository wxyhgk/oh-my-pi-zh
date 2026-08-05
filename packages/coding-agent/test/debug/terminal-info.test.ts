import { describe, expect, it } from "bun:test";
import {
	collectTerminalState,
	formatTerminalState,
	type TerminalStateInfo,
} from "@wxyhgk/pi-coding-agent/debug/terminal-info";
import { TERMINAL } from "@wxyhgk/pi-tui";

const sample: TerminalStateInfo = {
	detectedId: "kitty",
	columns: 120,
	rows: 40,
	cellWidthPx: 9,
	cellHeightPx: 18,
	trueColor: true,
	imageProtocol: "Kitty graphics",
	notifyProtocol: "OSC 99 (kitty desktop notifications)",
	osc99Confirmed: true,
	hyperlinks: false,
	deccara: true,
	screenToScrollback: true,
	synchronizedOutput: false,
	multiplexer: null,
	env: { TERM: "xterm-kitty", TERM_PROGRAM: undefined, TERM_PROGRAM_VERSION: undefined, COLORTERM: "truecolor" },
};

describe("formatTerminalState", () => {
	it("surfaces the negotiated subprotocols and their on/off state", () => {
		const out = formatTerminalState(sample);
		expect(out).toContain("检测到:     kitty");
		expect(out).toContain("图形:       Kitty graphics");
		expect(out).toContain("通知:       OSC 99 (kitty desktop notifications) · 已通过 DA 确认");
		expect(out).toContain("超链接:     否 (OSC 8)");
		expect(out).toContain("真彩色:     是 (24-bit SGR)");
		expect(out).toContain("DECCARA:    是 (矩形区域 SGR 背景填充)");
		expect(out).toContain("同步输出:   否 (DEC 2026)");
	});

	it("reports geometry, cell size, and the scrollback strategy", () => {
		const out = formatTerminalState(sample);
		expect(out).toContain("120x40 格 · 单格 9x18px");
		// supportsScreenToScrollback -> the non-destructive CSI 22 J clear.
		expect(out).toContain("屏幕→历史清除: CSI 22 J");
	});

	it("renders the redraw fallback when screen-to-scrollback is unsupported", () => {
		const out = formatTerminalState({ ...sample, screenToScrollback: false });
		expect(out).toContain("屏幕→历史清除: CSI 2 J (重绘)");
	});

	it("drops the OSC-99-confirmed marker when the terminal never answered the probe", () => {
		const out = formatTerminalState({ ...sample, osc99Confirmed: false });
		expect(out).toContain("通知:       OSC 99 (kitty desktop notifications)");
		expect(out).not.toContain("已通过 DA 确认");
	});

	it("shows 'none' for no multiplexer and '(unset)' for absent detection vars", () => {
		const out = formatTerminalState(sample);
		expect(out).toContain("多路复用:  无");
		expect(out).toContain("TERM:                 xterm-kitty");
		expect(out).toContain("COLORTERM:            truecolor");
		expect(out).toContain("TERM_PROGRAM:         (未设置)");
	});

	it("names the multiplexer when one wraps the session", () => {
		expect(formatTerminalState({ ...sample, multiplexer: "tmux" })).toContain("多路复用:  tmux");
	});
});

describe("collectTerminalState", () => {
	it("passes live geometry through and maps protocols to human-readable names (never raw escapes)", () => {
		const info = collectTerminalState({ columns: 88, rows: 25, synchronizedOutput: true });
		expect(info.columns).toBe(88);
		expect(info.rows).toBe(25);
		expect(info.synchronizedOutput).toBe(true);
		// The graphics/notify subprotocols are surfaced as readable labels, not the
		// enum's underlying escape sequences (\x1b_G, \x1b]99;;, …).
		expect(info.imageProtocol).not.toContain("\x1b");
		expect(info.notifyProtocol).not.toContain("\x1b");
		expect(info.imageProtocol.length).toBeGreaterThan(0);
		expect(info.notifyProtocol.length).toBeGreaterThan(0);
		// Capability booleans mirror the resolved TERMINAL singleton.
		expect(info.deccara).toBe(TERMINAL.deccara);
		expect(info.hyperlinks).toBe(TERMINAL.hyperlinks);
		expect(info.trueColor).toBe(TERMINAL.trueColor);
	});
});
