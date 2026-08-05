/**
 * Vibe mode tools — the director's entire non-read surface.
 *
 * Five thin tools over {@link VibeSessionRegistry}: spawn/send/wait/kill/list
 * persistent worker sessions ("fast"/"good" CLIs). Spawns and sends return
 * immediately; turn results self-deliver through the async job manager.
 *
 * The TUI renderers lean into the "you are driving little CLIs" fiction:
 * spawn/send draw a mini composer (a message typed into a tiny Claude-Code-like
 * terminal), and wait/list draw the "TV wall" — one live screen per worker,
 * stacked, each showing its tool calls and streamed text as it works.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../modes/theme/shimmer";
import type { Theme } from "../modes/theme/theme";
import vibeKillDescription from "../prompts/tools/vibe-kill.md" with { type: "text" };
import vibeListDescription from "../prompts/tools/vibe-list.md" with { type: "text" };
import vibeSendDescription from "../prompts/tools/vibe-send.md" with { type: "text" };
import vibeSpawnDescription from "../prompts/tools/vibe-spawn.md" with { type: "text" };
import vibeWaitDescription from "../prompts/tools/vibe-wait.md" with { type: "text" };
import { oneLineLabel } from "../task/types";
import { renderStatusLine } from "../tui";
import {
	type VibeCli,
	type VibeKillOutcome,
	type VibeScreenSnapshot,
	type VibeSendOutcome,
	VibeSessionRegistry,
	type VibeSessionState,
	type VibeWaitOutcome,
} from "../vibe/runtime";
import type { Tool, ToolSession } from "./index";
import {
	Ellipsis,
	formatBadge,
	formatDuration,
	formatStatusIcon,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	truncateToWidth,
} from "./render-utils";

export const VIBE_TOOL_NAMES = ["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;

const vibeSpawnSchema = type({
	cli: type("'fast' | 'good'").describe(
		"worker 类型:fast = 低延迟模型,适合机械性工作;good = 强模型,适合困难工作",
	),
	"name?": type("string <= 48").describe("可选的会话名称;省略时自动生成"),
	prompt: type("string > 0").describe("首条指令;worker 启动时不携带其他上下文"),
});

const vibeSendSchema = type({
	session: type("string > 0").describe("来自 vibe_spawn / vibe_list 的会话 id"),
	message: type("string > 0").describe("发送给会话的消息;轮次进行中则用于引导,否则作为其下一轮执行"),
});

const vibeWaitSchema = type({
	"sessions?": type("string[]").describe("要监视的会话 id;省略则监视所有有轮次在执行的会话"),
	"timeout?": type("number > 0").describe("最大等待秒数(默认 30)"),
});

const vibeKillSchema = type({
	session: type("string > 0").describe("要终止的会话 id"),
});

const vibeListSchema = type({});

type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Details payload shared by every vibe tool for TUI rendering. */
export interface VibeToolDetails {
	op: VibeOp;
	/** Live TV-wall snapshot of the owner's worker sessions at (or during) the call. */
	screens: VibeScreenSnapshot[];
	spawned?: { id: string; cli: VibeCli; jobId: string };
	send?: VibeSendOutcome;
	wait?: {
		settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning: string[];
		timedOut: boolean;
		/** True on interim progress emissions while the wait is still blocking. */
		waiting?: boolean;
	};
	killed?: VibeKillOutcome;
}

function screensOf(session: ToolSession, ids?: string[]): VibeScreenSnapshot[] {
	return VibeSessionRegistry.global().screens(session, ids);
}

function textResult(text: string, details: VibeToolDetails): AgentToolResult<VibeToolDetails> {
	return { content: [{ type: "text", text }], details };
}

export class VibeSpawnTool implements AgentTool<typeof vibeSpawnSchema, VibeToolDetails> {
	readonly name = "vibe_spawn";
	readonly approval = "exec" as const;
	readonly label = "Vibe 派生";
	readonly summary = "派生一个持久的 fast/good worker 会话";
	readonly description: string;
	readonly parameters = vibeSpawnSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeSpawnDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeSpawnSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const { id, jobId } = await VibeSessionRegistry.global().spawn(this.session, params);
		return textResult(
			`已派生 ${params.cli} 会话 \`${id}\`(轮次任务 \`${jobId}\`)。轮次结束后结果会自动送达——期间可继续指挥其他会话。用 vibe_send \`${id}\` 继续该会话。`,
			{ op: "spawn", screens: screensOf(this.session), spawned: { id, cli: params.cli, jobId } },
		);
	}
}

export class VibeSendTool implements AgentTool<typeof vibeSendSchema, VibeToolDetails> {
	readonly name = "vibe_send";
	readonly approval = "exec" as const;
	readonly label = "Vibe 发送";
	readonly summary = "向 worker 会话发送消息(引导或下一轮)";
	readonly description: string;
	readonly parameters = vibeSendSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeSendDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeSendSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const outcome = await VibeSessionRegistry.global().send(this.session, params);
		const ack =
			outcome.mode === "turn"
				? `已在 \`${outcome.id}\` 上开始新一轮(任务 \`${outcome.jobId}\`)。轮次结束时结果会自动送达。`
				: outcome.mode === "steered"
					? `已引导 \`${outcome.id}\` 的进行中轮次——运行中的轮次会在下一步看到你的消息。`
					: `\`${outcome.id}\` 正处于轮次中;你的消息已排队,将自动作为下一轮执行。`;
		return textResult(ack, { op: "send", screens: screensOf(this.session), send: outcome });
	}
}

const WAIT_PROGRESS_INTERVAL_MS = 500;

export class VibeWaitTool implements AgentTool<typeof vibeWaitSchema, VibeToolDetails> {
	readonly name = "vibe_wait";
	readonly approval = "read" as const;
	readonly label = "Vibe 等待";
	readonly summary = "阻塞直到 worker 会话完成其轮次";
	readonly description: string;
	readonly parameters = vibeWaitSchema;
	readonly strict = true;
	readonly interruptible = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeWaitDescription);
	}

	async execute(
		_toolCallId: string,
		params: typeof vibeWaitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<VibeToolDetails>,
	): Promise<AgentToolResult<VibeToolDetails>> {
		const registry = VibeSessionRegistry.global();
		// Live TV-wall frames while the wait blocks: each tick re-snapshots the
		// watched workers so their tool calls and streamed text play in place.
		const emitProgress = (): void => {
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: {
					op: "wait",
					screens: screensOf(this.session, params.sessions),
					wait: { settled: [], stillRunning: [], timedOut: false, waiting: true },
				},
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, WAIT_PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();
		let outcome: VibeWaitOutcome;
		try {
			outcome = await registry.wait(this.session, {
				sessions: params.sessions,
				timeoutMs: params.timeout !== undefined ? params.timeout * 1000 : undefined,
				signal,
			});
		} finally {
			clearInterval(progressTimer);
		}
		const details: VibeToolDetails = {
			op: "wait",
			screens: screensOf(this.session, params.sessions),
			wait: {
				settled: outcome.settled.map(({ id, jobId, status }) => ({ id, jobId, status })),
				stillRunning: outcome.stillRunning,
				timedOut: outcome.timedOut,
			},
		};
		if (outcome.settled.length === 0 && outcome.stillRunning.length === 0) {
			return { ...textResult("当前没有正在执行的轮次可等待。", details), useless: true };
		}
		const lines: string[] = [];
		for (const entry of outcome.settled) {
			lines.push(`## \`${entry.id}\` — ${statusLabel(entry.status)}`, entry.resultText, "");
		}
		if (outcome.stillRunning.length > 0) {
			lines.push(`仍在运行:${outcome.stillRunning.map(id => `\`${id}\``).join(", ")}。`);
		}
		if (outcome.timedOut) {
			lines.push("等待窗口在任一轮次结束前已超时——请重新调用 vibe_wait 继续等待。");
		}
		const result = textResult(lines.join("\n").trimEnd(), details);
		// A pure "still waiting" frame is noise once a newer wait exists.
		return outcome.settled.length === 0 ? { ...result, useless: true } : result;
	}
}

export class VibeKillTool implements AgentTool<typeof vibeKillSchema, VibeToolDetails> {
	readonly name = "vibe_kill";
	readonly approval = "read" as const;
	readonly label = "Vibe 终止";
	readonly summary = "终止一个 worker 会话";
	readonly description: string;
	readonly parameters = vibeKillSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeKillDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeKillSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const outcome = await VibeSessionRegistry.global().kill(this.session, params.session);
		const cancelNote = outcome.cancelledTurn ? " 其进行中的轮次已被取消。" : "";
		return textResult(
			`已终止会话 \`${outcome.id}\`。${cancelNote}转录记录保留在 history://${outcome.id}。`,
			{
				op: "kill",
				screens: screensOf(this.session),
				killed: outcome,
			},
		);
	}
}

export class VibeListTool implements AgentTool<typeof vibeListSchema, VibeToolDetails> {
	readonly name = "vibe_list";
	readonly approval = "read" as const;
	readonly label = "Vibe 列表";
	readonly summary = "列出 worker 会话及其状态";
	readonly description: string;
	readonly parameters = vibeListSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeListDescription);
	}

	async execute(): Promise<AgentToolResult<VibeToolDetails>> {
		const screens = screensOf(this.session);
		const details: VibeToolDetails = { op: "list", screens };
		if (screens.length === 0) {
			return textResult("没有 vibe 会话。用 vibe_spawn 派生一个。", details);
		}
		const lines = screens.map(screen => {
			const parts = [
				`- \`${screen.id}\` [${screen.cli}] ${statusLabel(screen.state)}`,
				`${screen.turns} 轮次`,
			];
			if (screen.queued > 0) parts.push(`${screen.queued} 排队中`);
			if (screen.model) parts.push(screen.model);
			if (screen.lastActivity) parts.push(`最近:${screen.lastActivity}`);
			return parts.join(" · ");
		});
		return textResult(lines.join("\n"), details);
	}
}

/** Creates the ephemeral tools installed while `/vibe` mode is active. */
export function createVibeTools(session: ToolSession): Tool[] {
	return [
		new VibeSpawnTool(session),
		new VibeSendTool(session),
		new VibeWaitTool(session),
		new VibeKillTool(session),
		new VibeListTool(session),
	];
}

// =============================================================================
// TUI Renderer — mini composer (spawn/send) + TV wall (wait/list)
// =============================================================================

const COMPOSER_LINE_MAX = 96;
const TV_LINE_MAX = 110;
const TV_TRACE_COLLAPSED = 2;
const TV_TRACE_EXPANDED = 6;
const TV_OUTPUT_COLLAPSED = 1;
const TV_OUTPUT_EXPANDED = 3;
const CURSOR_GLYPH = "▌";

function stateToIcon(state: VibeSessionState): ToolUIStatus {
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "done";
		case "dead":
			return "aborted";
	}
}

function stateToColor(state: VibeSessionState): ToolUIColor {
	switch (state) {
		case "running":
			return "accent";
		case "starting":
			return "accent";
		case "idle":
			return "success";
		case "dead":
			return "muted";
	}
}

interface VibeRenderArgs {
	cli?: VibeCli;
	prompt?: string;
	name?: string;
	session?: string;
	message?: string;
	sessions?: string[];
}

/** 会话状态/结算状态的 UI 显示词(枚举值本身保留英文)。 */
function statusLabel(status: VibeSessionState | "completed" | "failed" | "cancelled"): string {
	switch (status) {
		case "running":
			return "运行中";
		case "starting":
			return "启动中";
		case "idle":
			return "空闲";
		case "dead":
			return "已停止";
		case "completed":
			return "已完成";
		case "failed":
			return "失败";
		case "cancelled":
			return "已取消";
	}
}

/** vibe 操作词的中文显示(仅渲染标题使用,操作枚举值本身保留英文)。 */
function opLabel(op: VibeOp): string {
	switch (op) {
		case "spawn":
			return "派生";
		case "send":
			return "发送";
		case "wait":
			return "等待";
		case "kill":
			return "终止";
		case "list":
			return "会话";
	}
}

/** One-line, escape-stripped fragment for embedding in a frame row. */
function frameText(text: string, max: number): string {
	return oneLineLabel(replaceTabs(text), max);
}

/**
 * Draw a left-railed mini terminal:
 * ```
 * ╭─ <header>
 * │ <body…>
 * ╰─ <footer>
 * ```
 */
function miniFrame(uiTheme: Theme, header: string, body: string[], footer?: string): string[] {
	const box = uiTheme.boxRound;
	const rail = (glyph: string) => uiTheme.fg("dim", glyph);
	const lines = [`${rail(`${box.topLeft}${box.horizontal}`)} ${header}`];
	for (const row of body) {
		lines.push(`${rail(box.vertical)} ${row}`);
	}
	lines.push(
		footer ? `${rail(`${box.bottomLeft}${box.horizontal}`)} ${footer}` : rail(`${box.bottomLeft}${box.horizontal}`),
	);
	return lines;
}

/** The `>` composer rows of the mini CLI: the director's message being typed in. */
function composerRows(uiTheme: Theme, message: string, options: { cursor: boolean; expanded: boolean }): string[] {
	const promptGlyph = uiTheme.fg("accent", ">");
	const rawLines = message.split(/\r?\n/).filter(line => line.trim().length > 0);
	const maxRows = options.expanded ? 6 : 2;
	const visible = rawLines.slice(0, maxRows).map(line => frameText(line, COMPOSER_LINE_MAX));
	if (visible.length === 0) visible.push("");
	if (rawLines.length > maxRows) {
		visible[visible.length - 1] = `${visible[visible.length - 1]} …`;
	} else if (options.cursor) {
		visible[visible.length - 1] = `${visible[visible.length - 1]}${uiTheme.fg("accent", CURSOR_GLYPH)}`;
	}
	return visible.map((line, index) =>
		index === 0 ? `${promptGlyph} ${uiTheme.fg("toolOutput", line)}` : `  ${uiTheme.fg("toolOutput", line)}`,
	);
}

/** Render one worker "TV": header + live tool calls + streamed text tail. */
function tvScreen(
	uiTheme: Theme,
	screen: VibeScreenSnapshot,
	options: RenderResultOptions,
	settledStatus?: "completed" | "failed" | "cancelled",
): string[] {
	const live = screen.state === "running" || screen.state === "starting";
	const spinnerFrame = live ? options.spinnerFrame : undefined;
	const icon = formatStatusIcon(
		settledStatus === "failed" ? "error" : settledStatus === "cancelled" ? "aborted" : stateToIcon(screen.state),
		uiTheme,
		spinnerFrame,
	);
	const badge = formatBadge(screen.cli, stateToColor(screen.state), uiTheme);
	const idText =
		live && options.spinnerFrame !== undefined && shimmerEnabled()
			? shimmerText(screen.id, uiTheme)
			: uiTheme.fg(live ? "accent" : "toolOutput", screen.id);
	const headParts = [icon, badge, idText, uiTheme.fg("dim", statusLabel(settledStatus ?? screen.state))];
	const turnsLabel = `${screen.turns}轮${screen.queued > 0 ? `+${screen.queued}队` : ""}`;
	headParts.push(uiTheme.fg("muted", turnsLabel));
	if (screen.turnStartedAt !== undefined) {
		headParts.push(uiTheme.fg("dim", formatDuration(Date.now() - screen.turnStartedAt)));
	}
	if (screen.model) headParts.push(uiTheme.fg("muted", frameText(screen.model, 40)));

	const body: string[] = [];
	const hook = uiTheme.tree.hook;
	if (live) {
		if (screen.turnMessage) {
			body.push(`${uiTheme.fg("accent", ">")} ${uiTheme.fg("dim", frameText(screen.turnMessage, TV_LINE_MAX))}`);
		}
		const traceCap = options.expanded ? TV_TRACE_EXPANDED : TV_TRACE_COLLAPSED;
		for (const line of screen.trace.slice(-traceCap)) {
			body.push(`${uiTheme.fg("dim", hook)} ${uiTheme.fg("dim", frameText(line, TV_LINE_MAX))}`);
		}
		if (screen.currentTool) {
			const detail = screen.lastIntent ?? screen.currentToolArgs;
			const label = `${screen.currentTool}${detail ? `: ${detail}` : ""}`;
			const painted =
				options.spinnerFrame !== undefined && shimmerEnabled()
					? shimmerText(frameText(label, TV_LINE_MAX), uiTheme)
					: uiTheme.fg("muted", frameText(label, TV_LINE_MAX));
			body.push(`${uiTheme.fg("accent", hook)} ${painted}`);
		} else if (screen.lastIntent) {
			body.push(`${uiTheme.fg("accent", hook)} ${uiTheme.fg("muted", frameText(screen.lastIntent, TV_LINE_MAX))}`);
		}
		const outputCap = options.expanded ? TV_OUTPUT_EXPANDED : TV_OUTPUT_COLLAPSED;
		for (const line of screen.outputTail.slice(-outputCap)) {
			if (line.trim().length === 0) continue;
			body.push(`  ${uiTheme.fg("muted", frameText(line, TV_LINE_MAX))}`);
		}
	} else if (screen.lastActivity) {
		body.push(`${uiTheme.fg("dim", hook)} ${uiTheme.fg("muted", frameText(screen.lastActivity, TV_LINE_MAX))}`);
	}
	const footer = settledStatus
		? uiTheme.fg(
				settledStatus === "completed" ? "success" : settledStatus === "failed" ? "error" : "warning",
				`轮次${statusLabel(settledStatus)} — 结果已送达`,
			)
		: undefined;
	return miniFrame(uiTheme, headParts.join(" "), body, footer);
}

/**
 * Width-aware component over prebuilt lines, or — given a builder — lines
 * recomputed on every paint. Spinner ticks repaint the tool block WITHOUT
 * re-invoking renderCall/renderResult, so time-based content (shimmer sweep,
 * spinner glyph, cursor blink, elapsed turn duration) must be produced inside
 * a builder that reads the shared mutable `options` at paint time; prebuilt
 * arrays are for static frames only.
 */
function linesComponent(lines: string[] | (() => string[])): Component {
	return {
		render(width: number): readonly string[] {
			const rows = typeof lines === "function" ? lines() : lines;
			return rows.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		invalidate() {},
	};
}

function describeCall(op: VibeOp, args: VibeRenderArgs | undefined): string {
	switch (op) {
		case "spawn":
			return `派生 ${args?.cli ?? "?"}${args?.name ? ` · ${frameText(args.name, 40)}` : ""}`;
		case "send":
			return `发送 → ${args?.session ? frameText(args.session, 40) : "?"}`;
		case "wait":
			return args?.sessions?.length
				? `等待 ${frameText(args.sessions.join(", "), 60)}`
				: "等待运行中的会话";
		case "kill":
			return `终止 ${args?.session ? frameText(args.session, 40) : "?"}`;
		case "list":
			return "会话";
	}
}

/** Build the shared vibe renderer for one tool name. */
export function createVibeToolRenderer(op: VibeOp) {
	const composerOp = op === "spawn" || op === "send";
	return {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: composerOp,
		animatedPartialResult: op === "wait",

		renderCall(args: VibeRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const title = uiTheme.fg("muted", `vibe ${describeCall(op, args)}`);
			if (composerOp) {
				const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
				return linesComponent(() => {
					const cursorOn = ((options.spinnerFrame ?? 0) & 1) === 0;
					return miniFrame(
						uiTheme,
						title,
						composerRows(uiTheme, message, { cursor: cursorOn, expanded: options.expanded }),
						uiTheme.fg("dim", op === "spawn" ? "正在启动 CLI…" : "正在投递…"),
					);
				});
			}
			return new Text(renderStatusLine({ icon: "pending", title: `vibe ${describeCall(op, args)}` }, uiTheme), 0, 0);
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: VibeToolDetails; isError?: boolean },
			options: RenderResultOptions,
			uiTheme: Theme,
			args?: VibeRenderArgs,
		): Component {
			const details = result.details;
			if (!details || result.isError) {
				const fallback = result.content.find(part => part.type === "text")?.text ?? "";
				const header = renderStatusLine(
					{ icon: result.isError ? "error" : "done", title: `vibe ${describeCall(op, args)}` },
					uiTheme,
				);
				const body = fallback
					? `\n  ${uiTheme.fg(result.isError ? "error" : "dim", frameText(fallback, TV_LINE_MAX))}`
					: "";
				return new Text(`${header}${body}`, 0, 0);
			}

			if (composerOp) {
				const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
				const target =
					op === "spawn"
						? `${uiTheme.fg("muted", "vibe 派生")} ${formatBadge(details.spawned?.cli ?? args?.cli ?? "?", "accent", uiTheme)} ${uiTheme.fg("accent", frameText(details.spawned?.id ?? args?.name ?? "", 40))}`
						: `${uiTheme.fg("muted", "vibe 发送 →")} ${uiTheme.fg("accent", frameText(args?.session ?? "?", 40))}`;
				const ack =
					op === "spawn"
						? uiTheme.fg("success", `轮次已开始${details.spawned ? ` (任务 ${details.spawned.jobId})` : ""}`)
						: details.send?.mode === "steered"
							? uiTheme.fg("success", "已引导进入运行中的轮次")
							: details.send?.mode === "queued"
								? uiTheme.fg("warning", "轮次进行中——已排队作为下一轮")
								: uiTheme.fg(
										"success",
										`轮次已开始${details.send?.jobId ? ` (任务 ${details.send.jobId})` : ""}`,
									);
				const lines = miniFrame(
					uiTheme,
					target,
					composerRows(uiTheme, message, { cursor: false, expanded: options.expanded }),
					ack,
				);
				return linesComponent(lines);
			}

			if (op === "kill") {
				const killedNote = details.killed?.cancelledTurn ? " (进行中的轮次已取消)" : "";
				const header = renderStatusLine(
					{
						icon: "done",
						title: `vibe 终止 ${frameText(details.killed?.id ?? args?.session ?? "?", 40)}${killedNote}`,
					},
					uiTheme,
				);
				return new Text(header, 0, 0);
			}

			// wait/list: the TV wall.
			const screens = details.screens;
			if (screens.length === 0) {
				const fallback = result.content.find(part => part.type === "text")?.text ?? "没有会话";
				return new Text(
					renderStatusLine(
						{ icon: "warning", title: `vibe ${opLabel(op)}`, meta: [uiTheme.fg("dim", frameText(fallback, 60))] },
						uiTheme,
					),
					0,
					0,
				);
			}
			const waiting = details.wait?.waiting === true;
			const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
			return linesComponent(() => {
				const running = screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
				const meta: string[] = [];
				if (running > 0) meta.push(uiTheme.fg("accent", `${running} 运行中`));
				if (settledById.size > 0) meta.push(uiTheme.fg("success", `${settledById.size} 已结束`));
				if (details.wait?.timedOut) meta.push(uiTheme.fg("warning", "已超时"));
				const title =
					op === "wait"
						? waiting
							? "vibe 等待 — 正在观看画面墙"
							: "vibe 等待"
						: `vibe 会话 (${screens.length})`;
				const header = renderStatusLine(
					{
						icon: details.wait?.timedOut ? "warning" : running > 0 ? "info" : "done",
						spinnerFrame: running > 0 ? options.spinnerFrame : undefined,
						title,
						meta,
					},
					uiTheme,
				);
				const lines = [header];
				for (const screen of screens) {
					lines.push(...tvScreen(uiTheme, screen, options, settledById.get(screen.id)));
				}
				return lines;
			});
		},
	};
}
