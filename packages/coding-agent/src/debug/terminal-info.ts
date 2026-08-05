/**
 * Terminal state collection for the debug menu.
 *
 * Surfaces the detected terminal, the established subprotocols the renderer
 * negotiated (graphics, desktop notifications, hyperlinks, true color), the
 * scrollback/erase strategy, and the live geometry — the details that decide
 * which escape sequences the renderer emits.
 */
import {
	getCellDimensions,
	ImageProtocol,
	isOsc99Supported,
	NotifyProtocol,
	TERMINAL,
	TERMINAL_ID,
} from "@wxyhgk/pi-tui";

/** Live values the debug view reads off the running TUI, not the static capability table. */
export interface TerminalRuntimeState {
	columns: number;
	rows: number;
	/** Whether DEC 2026 synchronized-output wrappers are currently emitted. */
	synchronizedOutput: boolean;
}

export interface TerminalStateInfo {
	detectedId: string;
	columns: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	trueColor: boolean;
	imageProtocol: string;
	notifyProtocol: string;
	osc99Confirmed: boolean;
	hyperlinks: boolean;
	deccara: boolean;
	screenToScrollback: boolean;
	synchronizedOutput: boolean;
	multiplexer: string | null;
	env: { TERM?: string; TERM_PROGRAM?: string; TERM_PROGRAM_VERSION?: string; COLORTERM?: string };
}

const IMAGE_PROTOCOL_NAMES: Record<ImageProtocol, string> = {
	[ImageProtocol.Kitty]: "Kitty graphics",
	[ImageProtocol.Iterm2]: "iTerm2 inline images",
	[ImageProtocol.Sixel]: "Sixel",
};

const NOTIFY_PROTOCOL_NAMES: Record<NotifyProtocol, string> = {
	[NotifyProtocol.Bell]: "BEL (\\a)",
	[NotifyProtocol.Osc99]: "OSC 99 (kitty 桌面通知)",
	[NotifyProtocol.Osc9]: "OSC 9 (iTerm2/WezTerm)",
};

/** Identify the multiplexer wrapping the session, if any (mirrors the renderer's gate). */
function detectMultiplexer(env: NodeJS.ProcessEnv): string | null {
	if (env.TMUX) return "tmux";
	if (env.STY) return "screen";
	if (env.ZELLIJ) return "zellij";
	const term = env.TERM?.toLowerCase() ?? "";
	if (term.startsWith("tmux")) return "tmux";
	if (term.startsWith("screen")) return "screen";
	return null;
}

/** Snapshot the active terminal capabilities and the live runtime geometry. */
export function collectTerminalState(runtime: TerminalRuntimeState): TerminalStateInfo {
	const env = Bun.env;
	const cell = getCellDimensions();
	return {
		detectedId: TERMINAL_ID,
		columns: runtime.columns,
		rows: runtime.rows,
		cellWidthPx: cell.widthPx,
		cellHeightPx: cell.heightPx,
		trueColor: TERMINAL.trueColor,
		imageProtocol: TERMINAL.imageProtocol === null ? "无" : IMAGE_PROTOCOL_NAMES[TERMINAL.imageProtocol],
		notifyProtocol: NOTIFY_PROTOCOL_NAMES[TERMINAL.notifyProtocol],
		osc99Confirmed: isOsc99Supported(),
		hyperlinks: TERMINAL.hyperlinks,
		deccara: TERMINAL.deccara,
		screenToScrollback: TERMINAL.supportsScreenToScrollback,
		synchronizedOutput: runtime.synchronizedOutput,
		multiplexer: detectMultiplexer(env),
		env: {
			TERM: env.TERM,
			TERM_PROGRAM: env.TERM_PROGRAM,
			TERM_PROGRAM_VERSION: env.TERM_PROGRAM_VERSION,
			COLORTERM: env.COLORTERM,
		},
	};
}

const yesNo = (value: boolean): string => (value ? "是" : "否");

/** Format terminal state for display in the debug menu. */
export function formatTerminalState(info: TerminalStateInfo): string {
	const lines = [
		"终端状态",
		"━━━━━━━━━━━━━━",
		`检测到:     ${info.detectedId}`,
		`几何:       ${info.columns}x${info.rows} 格 · 单格 ${info.cellWidthPx}x${info.cellHeightPx}px`,
		info.multiplexer ? `多路复用:  ${info.multiplexer}` : "多路复用:  无",
		"",
		"子协议",
		`  图形:       ${info.imageProtocol}`,
		`  通知:       ${info.notifyProtocol}${info.osc99Confirmed ? " · 已通过 DA 确认" : ""}`,
		`  超链接:     ${yesNo(info.hyperlinks)} (OSC 8)`,
		`  真彩色:     ${yesNo(info.trueColor)} (24-bit SGR)`,
		`  DECCARA:    ${yesNo(info.deccara)} (矩形区域 SGR 背景填充)`,
		`  同步输出:   ${yesNo(info.synchronizedOutput)} (DEC 2026)`,
		"",
		"滚动回退",
		`  屏幕→历史清除: ${info.screenToScrollback ? "CSI 22 J" : "CSI 2 J (重绘)"}`,
		"",
		"检测信号",
		`  TERM:                 ${info.env.TERM ?? "(未设置)"}`,
		`  TERM_PROGRAM:         ${info.env.TERM_PROGRAM ?? "(未设置)"}`,
		`  TERM_PROGRAM_VERSION: ${info.env.TERM_PROGRAM_VERSION ?? "(未设置)"}`,
		`  COLORTERM:            ${info.env.COLORTERM ?? "(未设置)"}`,
	];
	return lines.join("\n");
}
