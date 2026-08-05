import * as fs from "node:fs/promises";
import { type } from "@wxyhgk/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	RenderResultOptions,
	ToolApprovalDecision,
} from "@wxyhgk/pi-agent-core";
import type { ToolExample } from "@wxyhgk/pi-ai";
import { type Component, Text } from "@wxyhgk/pi-tui";
import { isEnoent, prompt } from "@wxyhgk/pi-utils";
import {
	type DapBreakpointRecord,
	type DapCapabilities,
	type DapContinueOutcome,
	type DapDataBreakpointInfoResponse,
	type DapDataBreakpointRecord,
	type DapDisassembledInstruction,
	type DapEvaluateArguments,
	type DapEvaluateResponse,
	type DapFunctionBreakpointRecord,
	type DapInstructionBreakpointRecord,
	type DapModule,
	type DapResolvedAdapter,
	type DapScope,
	type DapSessionSummary,
	type DapSource,
	type DapStackFrame,
	type DapThread,
	type DapVariable,
	dapSessionManager,
	getAdapterConfigs,
	getAvailableAdapters,
	type LaunchProgramKind,
	resolveLaunchOverrides,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../dap";
import type { Theme } from "../modes/theme/theme";
import debugDescription from "../prompts/tools/debug.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import type { OutputMeta } from "./output-meta";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

/**
 * DAP debug actions that only read program state (no mutation, no execution).
 * Execution-side actions (`launch`, `attach`, `continue`, `step_*`, `pause`,
 * `evaluate`, breakpoint mutations, memory writes) are exec-tier.
 */
export const DEBUG_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"output",
	"threads",
	"stack_trace",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"loaded_sources",
	"modules",
	"sessions",
]);
const debugActionSchema = type.enumerated(
	"launch",
	"attach",
	"set_breakpoint",
	"remove_breakpoint",
	"set_instruction_breakpoint",
	"remove_instruction_breakpoint",
	"data_breakpoint_info",
	"set_data_breakpoint",
	"remove_data_breakpoint",
	"continue",
	"step_over",
	"step_in",
	"step_out",
	"pause",
	"evaluate",
	"stack_trace",
	"threads",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"write_memory",
	"modules",
	"loaded_sources",
	"custom_request",
	"output",
	"terminate",
	"sessions",
);
const debugSchema = type({
	action: debugActionSchema,
	"program?": type("string").describe("调试目标路径;Delve 接受 Go 包目录"),
	"args?": type("string[]").describe("程序参数"),
	"adapter?": type("string").describe("已配置的适配器 ID(gdb、lldb-dap、debugpy、dlv、rdbg 或 dap.json 条目)"),
	cwd: "string?",
	"file?": type("string").describe("源文件"),
	"line?": type("number").describe("源文件行"),
	"function?": type("string").describe("函数名"),
	"name?": type("string").describe("变量或数据名称"),
	"condition?": type("string").describe("断点条件"),
	hit_condition: "string?",
	"expression?": type("string").describe("要求值的表达式"),
	"context?": type("string").describe("求值上下文:watch | repl | hover | variables | clipboard"),
	frame_id: "number?",
	"scope_id?": type("number").describe("作用域变量引用"),
	"variable_ref?": type("number").describe("变量引用"),
	"pid?": type("number").describe("要附加的进程 ID"),
	"port?": type("number").describe("远程附加端口"),
	"host?": type("string").describe("远程附加主机"),
	"levels?": type("number").describe("最大堆栈帧数"),
	"memory_reference?": type("string").describe("内存引用或地址"),
	instruction_reference: "string?",
	instruction_count: "number?",
	instruction_offset: "number?",
	"count?": type("number").describe("要读取的字节数"),
	"data?": type("string").describe("base64 编码的内存数据"),
	"data_id?": type("string").describe("数据断点 ID"),
	"access_type?": "'read' | 'write' | 'readWrite'",
	"command?": type("string").describe("自定义 DAP 请求命令"),
	"arguments?": type({
		"[string]": "unknown",
	}).describe("自定义请求参数"),
	offset: "number?",
	resolve_symbols: "boolean?",
	allow_partial: "boolean?",
	start_module: "number?",
	module_count: "number?",
	"timeout?": type("number").describe("单次请求超时秒数"),
});

export type DebugParams = typeof debugSchema.infer;
export type DebugAction = DebugParams["action"];

interface DebugToolDetails {
	action: DebugAction;
	success: boolean;
	snapshot?: DapSessionSummary;
	sessions?: DapSessionSummary[];
	stackFrames?: DapStackFrame[];
	threads?: DapThread[];
	scopes?: DapScope[];
	variables?: DapVariable[];
	sources?: DapSource[];
	modules?: DapModule[];
	evaluation?: DapEvaluateResponse;
	breakpoints?: DapBreakpointRecord[];
	functionBreakpoints?: DapFunctionBreakpointRecord[];
	instructionBreakpoints?: DapInstructionBreakpointRecord[];
	dataBreakpoints?: DapDataBreakpointRecord[];
	dataBreakpointInfo?: DapDataBreakpointInfoResponse;
	disassembly?: DapDisassembledInstruction[];
	memoryAddress?: string;
	memoryData?: string;
	unreadableBytes?: number;
	bytesWritten?: number;
	customBody?: unknown;
	output?: string;
	adapter?: string;
	state?: DapContinueOutcome["state"];
	timedOut?: boolean;
	meta?: OutputMeta;
}

function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
	const lines = [
		`会话 ${snapshot.id}`,
		`适配器: ${snapshot.adapter}`,
		`状态: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`程序: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`停止原因: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`帧: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`指令指针: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`位置: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("配置: 等待 configurationDone;请先设置断点,然后继续。");
	}
	if (snapshot.exitCode !== undefined) lines.push(`退出码: ${snapshot.exitCode}`);
	return lines;
}

function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
	const lines = [`断点(${filePath}):`];
	if (breakpoints.length === 0) {
		lines.push("(无)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- 第 ${breakpoint.line} 行: ${breakpoint.verified ? "已验证" : "待验证"}${breakpoint.condition ? ` 条件 ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
	const lines = ["函数断点:"];
	if (breakpoints.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.name}: ${breakpoint.verified ? "已验证" : "待验证"}${breakpoint.condition ? ` 条件 ${breakpoint.condition}` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatStackFrames(frames: DapStackFrame[]): string {
	const lines = ["堆栈跟踪:"];
	if (frames.length === 0) {
		lines.push("(空)");
		return lines.join("\n");
	}
	for (const frame of frames) {
		const location = frame.source?.path
			? `${frame.source.path}:${frame.line}:${frame.column}`
			: `<未知>:${frame.line}:${frame.column}`;
		lines.push(`- #${frame.id} ${frame.name} @ ${location}`);
	}
	return lines.join("\n");
}

function formatThreads(threads: DapThread[]): string {
	const lines = ["线程:"];
	if (threads.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const thread of threads) {
		lines.push(`- ${thread.id}: ${thread.name}`);
	}
	return lines.join("\n");
}

function formatScopes(scopes: DapScope[]): string {
	const lines = ["作用域:"];
	if (scopes.length === 0) {
		lines.push("(无)");
		return lines.join("\n");
	}
	for (const scope of scopes) {
		lines.push(
			`- ${scope.name}: ref=${scope.variablesReference}, expensive=${scope.expensive ? "是" : "否"}${scope.presentationHint ? `, hint=${scope.presentationHint}` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatVariables(variables: DapVariable[]): string {
	const lines = ["变量:"];
	if (variables.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}
	for (const variable of variables) {
		lines.push(
			`- ${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ""}${variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
	if (!source?.path && !source?.name) {
		return null;
	}
	const base = source.path ?? source.name ?? "<未知>";
	if (line === undefined) {
		return base;
	}
	return `${base}:${line}${column !== undefined ? `:${column}` : ""}`;
}

function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
	const lines = ["反汇编:"];
	if (instructions.length === 0) {
		lines.push("(空)");
		return lines.join("\n");
	}
	const addressWidth = Math.max(...instructions.map(instruction => instruction.address.length));
	const bytesWidth = Math.max(...instructions.map(instruction => instruction.instructionBytes?.length ?? 0), 2);
	for (const instruction of instructions) {
		const location = formatSourceLabel(instruction.location, instruction.line, instruction.column);
		const parts = [
			instruction.address.padEnd(addressWidth),
			(instruction.instructionBytes ?? "").padEnd(bytesWidth),
			instruction.instruction,
		];
		if (instruction.symbol) {
			parts.push(`<${instruction.symbol}>`);
		}
		if (location) {
			parts.push(`[${location}]`);
		}
		lines.push(
			parts
				.filter(part => part.length > 0)
				.join("  ")
				.trimEnd(),
		);
	}
	return lines.join("\n");
}

function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
	const lines = [`内存(${address}):`];
	const buffer = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
	if (buffer.length === 0) {
		lines.push("(无可读字节)");
	} else {
		for (let offset = 0; offset < buffer.length; offset += 16) {
			const chunk = buffer.subarray(offset, offset + 16);
			const hex = Array.from(chunk, byte => byte.toString(16).padStart(2, "0")).join(" ");
			const ascii = Array.from(chunk, byte => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
			lines.push(
				`${(offset === 0 ? address : `+0x${offset.toString(16)}`).padEnd(18)} ${hex.padEnd(47)} |${ascii}|`,
			);
		}
	}
	if (unreadableBytes !== undefined && unreadableBytes > 0) {
		lines.push(`不可读字节数: ${unreadableBytes}`);
	}
	return lines.join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map(row => (row[index] ?? "").length)),
	);
	const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ");
	return [formatRow(headers), formatRow(widths.map(width => "-".repeat(width))), ...rows.map(formatRow)].join("\n");
}

function formatModules(modules: DapModule[]): string {
	if (modules.length === 0) {
		return "模块:\n(无)";
	}
	return [
		"模块:",
		formatTable(
			["ID", "名称", "路径", "符号", "范围"],
			modules.map(module => [
				String(module.id),
				module.name,
				module.path ?? "",
				module.symbolStatus ?? "",
				module.addressRange ?? "",
			]),
		),
	].join("\n");
}

function formatLoadedSources(sources: DapSource[]): string {
	const lines = ["已加载源文件:"];
	if (sources.length === 0) {
		lines.push("(无)");
		return lines.join("\n");
	}
	for (const source of sources) {
		const label = source.path ?? source.name ?? "<未知>";
		lines.push(`- ${label}${source.sourceReference !== undefined ? ` [ref=${source.sourceReference}]` : ""}`);
	}
	return lines.join("\n");
}

function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
	const lines = ["指令断点:"];
	if (breakpoints.length === 0) {
		lines.push("(无)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		const location = `${breakpoint.instructionReference}${breakpoint.offset !== undefined ? `+${breakpoint.offset}` : ""}`;
		lines.push(
			`- ${location}: ${breakpoint.verified ? "已验证" : "待验证"}${breakpoint.condition ? ` 条件 ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` 命中 ${breakpoint.hitCondition} 次后` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
	const lines = [`数据断点信息: ${info.description}`];
	lines.push(`数据 ID: ${info.dataId ?? "(不可用)"}`);
	if (info.accessTypes && info.accessTypes.length > 0) {
		lines.push(`访问类型: ${info.accessTypes.join(", ")}`);
	}
	if (info.canPersist !== undefined) {
		lines.push(`持久化: ${info.canPersist ? "是" : "否"}`);
	}
	return lines.join("\n");
}

function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
	const lines = ["数据断点:"];
	if (breakpoints.length === 0) {
		lines.push("(无)");
		return lines.join("\n");
	}
	for (const breakpoint of breakpoints) {
		lines.push(
			`- ${breakpoint.dataId}: ${breakpoint.verified ? "已验证" : "待验证"}${breakpoint.accessType ? ` (${breakpoint.accessType})` : ""}${breakpoint.condition ? ` 条件 ${breakpoint.condition}` : ""}${breakpoint.hitCondition ? ` 命中 ${breakpoint.hitCondition} 次后` : ""}${breakpoint.message ? ` (${breakpoint.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatCustomResponse(command: string, body: unknown): string {
	let serialized = "";
	try {
		serialized = JSON.stringify(body, null, 2) ?? "null";
	} catch {
		serialized = Bun.inspect(body);
	}
	return `${command} 响应:\n${serialized}`;
}

function formatSessions(sessions: DapSessionSummary[]): string {
	if (sessions.length === 0) {
		return "没有调试会话。";
	}
	return sessions
		.map(session => {
			const location = formatLocation(session);
			return [
				`${session.id}: ${session.status}`,
				`  适配器=${session.adapter}`,
				`  工作目录=${session.cwd}`,
				...(session.program ? [`  程序=${session.program}`] : []),
				...(location ? [`  位置=${location}`] : []),
				...(session.stopReason ? [`  原因=${session.stopReason}`] : []),
			].join("\n");
		})
		.join("\n\n");
}

function formatEvaluation(evaluation: DapEvaluateResponse): string {
	const lines = [`结果: ${evaluation.result}`];
	if (evaluation.type) lines.push(`类型: ${evaluation.type}`);
	if (evaluation.variablesReference > 0) {
		lines.push(`变量引用: ${evaluation.variablesReference}`);
	}
	return lines.join("\n");
}

function buildOutcomeText(outcome: DapContinueOutcome, timeoutSec: number, verb: string): string {
	const lines = formatSessionSnapshot(outcome.snapshot);
	if (outcome.timedOut) {
		lines.push(`程序在 ${timeoutSec} 秒后仍在运行。请使用 pause 中断并检查状态。`);
		return lines.join("\n");
	}
	if (outcome.state === "stopped") {
		lines.push(`${verb} 后停止于 ${formatLocation(outcome.snapshot) ?? "未知位置"}。`);
		return lines.join("\n");
	}
	if (outcome.state === "terminated") {
		lines.push(
			`程序已终止${outcome.snapshot.exitCode !== undefined ? `,退出码 ${outcome.snapshot.exitCode}` : ""}。`,
		);
		return lines.join("\n");
	}
	lines.push("程序正在运行。");
	return lines.join("\n");
}

function getConfiguredAdapters(cwd: string): string {
	const adapters = getAvailableAdapters(cwd).map(adapter => adapter.name);
	const names = adapters.length > 0 ? adapters.join(", ") : "无";
	return truncateToWidth(replaceTabs(names), TRUNCATE_LENGTHS.LONG);
}

const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
	debugpy: "适配器“debugpy”不可用:未在 PATH 中找到 python",
	dlv: "适配器“dlv”不可用:请用“go install github.com/go-delve/delve/cmd/dlv@latest”安装",
	rdbg: "适配器“rdbg”不可用:请用“gem install debug”安装",
	"js-debug-adapter":
		"适配器“js-debug-adapter”不可用:请用 Mason 安装 vscode-js-debug,或将 JS_DEBUG_DAP_SERVER 设为 dapDebugServer.js",
};

const ADAPTER_CANONICAL_COMMANDS: Readonly<Record<string, string>> = {
	debugpy: "python",
	dlv: "dlv",
	rdbg: "rdbg",
	"js-debug-adapter": "js-debug-adapter",
};

function formatAdapterUnavailable(adapterName: string, command: string, cwd: string): string {
	const displayName = truncateToWidth(replaceTabs(adapterName), TRUNCATE_LENGTHS.SHORT);
	const canonicalCommand = ADAPTER_CANONICAL_COMMANDS[adapterName] ?? adapterName;
	if (command !== canonicalCommand) {
		const displayCommand = truncateToWidth(replaceTabs(shortenPath(command)), TRUNCATE_LENGTHS.CONTENT);
		return `适配器“${displayName}”不可用:配置的命令“${displayCommand}”无法解析。请检查此工作区的 DAP 适配器配置。`;
	}
	return (
		ADAPTER_UNAVAILABLE_MESSAGES[adapterName] ??
		`适配器“${displayName}”不可用。已安装的适配器: ${getConfiguredAdapters(cwd)}`
	);
}

async function classifyLaunchProgram(program: string): Promise<LaunchProgramKind> {
	try {
		return (await fs.stat(program)).isDirectory() ? "directory" : "file";
	} catch (error) {
		if (isEnoent(error)) return "missing";
		throw error;
	}
}

function validateLaunchProgram(
	program: string,
	cwd: string,
	programKind: LaunchProgramKind,
	adapter: DapResolvedAdapter,
): void {
	if (programKind !== "directory" || adapter.acceptsDirectoryProgram) return;
	const displayPath = formatPathRelativeToCwd(program, cwd, { trailingSlash: true });
	throw new ToolError(
		`启动程序解析为目录: ${displayPath}。请传入可执行文件路径,或选择支持包目录的适配器。`,
	);
}

interface DebugRenderArgs extends Partial<DebugParams> {}

function getActiveSessionSnapshot(): DapSessionSummary {
	const snapshot = dapSessionManager.getActiveSession();
	if (!snapshot) {
		throw new ToolError("没有活动的调试会话。请先执行 launch 或 attach。");
	}
	return snapshot;
}

function requireCapability(capability: keyof DapCapabilities, description: string): DapSessionSummary {
	const snapshot = getActiveSessionSnapshot();
	if (dapSessionManager.getCapabilities()?.[capability] !== true) {
		throw new ToolError(`当前适配器不支持 ${description}`);
	}
	return snapshot;
}

function resolveDisassemblyReference(memoryReference: string | undefined): string {
	if (memoryReference) {
		return memoryReference;
	}
	const snapshot = getActiveSessionSnapshot();
	if (snapshot.instructionPointerReference) {
		return snapshot.instructionPointerReference;
	}
	throw new ToolError(
		"disassemble 需要 memory_reference,除非当前停止位置有指令指针引用",
	);
}

const DEBUG_ACTION_LABELS: Readonly<Record<string, string>> = {
	launch: "启动",
	attach: "附加",
	set_breakpoint: "设置断点",
	remove_breakpoint: "移除断点",
	set_instruction_breakpoint: "设置指令断点",
	remove_instruction_breakpoint: "移除指令断点",
	data_breakpoint_info: "数据断点信息",
	set_data_breakpoint: "设置数据断点",
	remove_data_breakpoint: "移除数据断点",
	continue: "继续",
	step_over: "单步跳过",
	step_in: "单步进入",
	step_out: "单步跳出",
	pause: "暂停",
	evaluate: "求值",
	stack_trace: "堆栈跟踪",
	threads: "线程",
	scopes: "作用域",
	variables: "变量",
	disassemble: "反汇编",
	read_memory: "读取内存",
	write_memory: "写入内存",
	modules: "模块",
	loaded_sources: "已加载源文件",
	custom_request: "自定义请求",
	output: "输出",
	terminate: "终止",
	sessions: "会话",
};

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? DEBUG_ACTION_LABELS[args.action] ?? args.action.replaceAll("_", " ") : "请求";
	if (args.program) {
		return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${args.file}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

export const debugToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "调试", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				const action = DEBUG_ACTION_LABELS[args?.action ?? result.details?.action ?? "debug"] ??
					(args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
				const success = !options.isPartial && !result.isError;
				const statusIcon = success
					? theme.styledSymbol("tool.debug", "accent")
					: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
				const header = `${statusIcon} 调试 ${action}`;
				const summaryLines = result.details?.snapshot
					? formatSessionSnapshot(result.details.snapshot).map(line => replaceTabs(line))
					: [];
				const text = result.content.find(block => block.type === "text")?.text ?? "无输出";
				const rawLines = replaceTabs(text).split("\n");
				const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
				const displayedLines = rawLines
					.slice(0, previewLimit)
					.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
				const remaining = rawLines.length - displayedLines.length;
				if (remaining > 0) {
					displayedLines.push(
						theme.fg("muted", `… 还有 ${remaining} 行 ${formatExpandHint(theme, options.expanded, true)}`),
					);
				}
				return outputBlock.render(
					{
						header,
						state: result.isError ? "error" : "success",
						sections: [
							...(summaryLines.length > 0
								? [{ label: theme.fg("toolTitle", "会话"), lines: summaryLines }]
								: []),
							{ label: theme.fg("toolTitle", "输出"), lines: displayedLines },
						],
						width,
						applyBg: false,
					},
					theme,
				);
			},
			invalidate() {
				outputBlock.invalidate();
			},
		});
	},
	mergeCallAndResult: true,
	inline: true,
};

export class DebugTool implements AgentTool<typeof debugSchema, DebugToolDetails> {
	readonly name = "debug";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawAction = (args as Partial<DebugParams>).action;
		const action = typeof rawAction === "string" ? rawAction.toLowerCase() : "";
		return DEBUG_READONLY_ACTIONS.has(action) ? "read" : "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<DebugParams>;
		const lines = [`操作: ${typeof params.action === "string" ? params.action : "(缺失)"}`];
		if (typeof params.program === "string" && params.program.length > 0) {
			lines.push(`程序: ${truncateForPrompt(params.program)}`);
		}
		return lines;
	};
	readonly label = "调试";
	readonly summary = "使用 DAP(调试器适配器协议)调试正在运行的进程";
	readonly description: string;
	readonly parameters = debugSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof debugSchema.infer>[] = [
		{
			caption: "启动并检查挂起",
			note: '1. debug(action: "launch", program: "./my_app")\n2. debug(action: "set_breakpoint", file: "src/main.c", line: 42)\n3. debug(action: "continue")\n4. If the program appears hung: debug(action: "pause")\n5. Inspect state with `threads`, `stack_trace`, `scopes`, and `variables`',
		},
		{
			caption: "使用 debugpy 启动 Python 脚本",
			call: { action: "launch", adapter: "debugpy", program: "scripts/job.py", args: ["--flag"] },
		},
		{
			caption: "通过 repl 执行原始调试器命令",
			call: { action: "evaluate", expression: "info registers", context: "repl" },
		},
	];

	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(debugDescription);
	}

	static createIf(session: ToolSession): DebugTool | null {
		return session.settings.get("debug.enabled") ? new DebugTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: DebugParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DebugToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DebugToolDetails>> {
		const timeoutSec = clampTimeout("debug", params.timeout, this.session.settings.get("tools.maxTimeout"));
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const details: DebugToolDetails = { action: params.action, success: true };
		const result = toolResult(details);
		switch (params.action) {
			case "launch": {
				if (!params.program) {
					throw new ToolError("launch 需要 program 参数");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const program = resolveToCwd(params.program, commandCwd);
				const programKind = await classifyLaunchProgram(program);
				const selection = selectLaunchAdapter(program, commandCwd, params.adapter, programKind);
				if (selection.kind === "unavailable") {
					throw new ToolError(formatAdapterUnavailable(selection.adapterName, selection.command, commandCwd));
				}
				if (selection.kind === "none") {
					throw new ToolError(
						`没有可用的调试器适配器。已安装的适配器: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const { adapter } = selection;
				validateLaunchProgram(program, commandCwd, programKind, adapter);
				const extraLaunchArguments = resolveLaunchOverrides(adapter, program, programKind);
				const snapshot = await dapSessionManager.launch(
					{ adapter, program, args: params.args, cwd: commandCwd, extraLaunchArguments },
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "attach": {
				if (params.pid === undefined && params.port === undefined) {
					throw new ToolError("attach 需要 pid 或 port 参数");
				}
				const commandCwd = params.cwd ? resolveToCwd(params.cwd, this.session.cwd) : this.session.cwd;
				const adapter = selectAttachAdapter(commandCwd, params.adapter, params.port);
				if (!adapter) {
					if (params.adapter) {
						const command = getAdapterConfigs(commandCwd)[params.adapter]?.command ?? params.adapter;
						throw new ToolError(formatAdapterUnavailable(params.adapter, command, commandCwd));
					}
					throw new ToolError(
						`没有可用的调试器适配器。已安装的适配器: ${getConfiguredAdapters(commandCwd)}`,
					);
				}
				const snapshot = await dapSessionManager.attach(
					{ adapter, cwd: commandCwd, pid: params.pid, port: params.port, host: params.host },
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = snapshot;
				details.adapter = adapter.name;
				return result.text(formatSessionSnapshot(snapshot).join("\n")).done();
			}
			case "set_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.setFunctionBreakpoint(
						params.function,
						params.condition,
						combinedSignal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("set_breakpoint 需要 file+line 或 function 参数");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.setBreakpoint(
					file,
					params.line,
					params.condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "remove_breakpoint": {
				if (params.function) {
					const response = await dapSessionManager.removeFunctionBreakpoint(
						params.function,
						combinedSignal,
						timeoutSec * 1000,
					);
					details.snapshot = response.snapshot;
					details.functionBreakpoints = response.breakpoints;
					return result.text(formatFunctionBreakpoints(response.breakpoints)).done();
				}
				if (!params.file || params.line === undefined) {
					throw new ToolError("remove_breakpoint 需要 file+line 或 function 参数");
				}
				const file = resolveToCwd(params.file, this.session.cwd);
				const response = await dapSessionManager.removeBreakpoint(
					file,
					params.line,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.breakpoints = response.breakpoints;
				return result.text(formatBreakpoints(response.sourcePath, response.breakpoints)).done();
			}
			case "set_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "指令断点");
				if (!params.instruction_reference) {
					throw new ToolError("set_instruction_breakpoint 需要 instruction_reference 参数");
				}
				const response = await dapSessionManager.setInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					params.condition,
					params.hit_condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "remove_instruction_breakpoint": {
				requireCapability("supportsInstructionBreakpoints", "指令断点");
				if (!params.instruction_reference) {
					throw new ToolError("remove_instruction_breakpoint 需要 instruction_reference 参数");
				}
				const response = await dapSessionManager.removeInstructionBreakpoint(
					params.instruction_reference,
					params.offset,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.instructionBreakpoints = response.breakpoints;
				return result.text(formatInstructionBreakpoints(response.breakpoints)).done();
			}
			case "data_breakpoint_info": {
				requireCapability("supportsDataBreakpoints", "数据断点");
				if (!params.name) {
					throw new ToolError("data_breakpoint_info 需要 name 参数");
				}
				const response = await dapSessionManager.dataBreakpointInfo(
					params.name,
					params.variable_ref ?? params.scope_id,
					params.frame_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpointInfo = response.info;
				return result.text(formatDataBreakpointInfo(response.info)).done();
			}
			case "set_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "数据断点");
				if (!params.data_id) {
					throw new ToolError("set_data_breakpoint 需要 data_id 参数");
				}
				const response = await dapSessionManager.setDataBreakpoint(
					params.data_id,
					params.access_type,
					params.condition,
					params.hit_condition,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "remove_data_breakpoint": {
				requireCapability("supportsDataBreakpoints", "数据断点");
				if (!params.data_id) {
					throw new ToolError("remove_data_breakpoint 需要 data_id 参数");
				}
				const response = await dapSessionManager.removeDataBreakpoint(
					params.data_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.dataBreakpoints = response.breakpoints;
				return result.text(formatDataBreakpoints(response.breakpoints)).done();
			}
			case "continue": {
				const outcome = await dapSessionManager.continue(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "继续")).done();
			}
			case "step_over": {
				const outcome = await dapSessionManager.stepOver(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "单步跳过")).done();
			}
			case "step_in": {
				const outcome = await dapSessionManager.stepIn(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "单步进入")).done();
			}
			case "step_out": {
				const outcome = await dapSessionManager.stepOut(combinedSignal, timeoutSec * 1000);
				details.snapshot = outcome.snapshot;
				details.state = outcome.state;
				details.timedOut = outcome.timedOut;
				return result.text(buildOutcomeText(outcome, timeoutSec, "单步跳出")).done();
			}
			case "pause": {
				const snapshot = await dapSessionManager.pause(combinedSignal, timeoutSec * 1000);
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("程序已暂停。").join("\n")).done();
			}
			case "evaluate": {
				if (!params.expression) {
					throw new ToolError("evaluate 需要 expression 参数");
				}
				const evaluationContext = (params.context as DapEvaluateArguments["context"] | undefined) ?? "repl";
				const response = await dapSessionManager.evaluate(
					params.expression,
					evaluationContext,
					params.frame_id,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.evaluation = response.evaluation;
				return result.text(formatEvaluation(response.evaluation)).done();
			}
			case "stack_trace": {
				const response = await dapSessionManager.stackTrace(params.levels, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.stackFrames = response.stackFrames;
				return result.text(formatStackFrames(response.stackFrames)).done();
			}
			case "threads": {
				const response = await dapSessionManager.threads(combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.threads = response.threads;
				return result.text(formatThreads(response.threads)).done();
			}
			case "scopes": {
				const response = await dapSessionManager.scopes(params.frame_id, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.scopes = response.scopes;
				return result.text(formatScopes(response.scopes)).done();
			}
			case "variables": {
				const variableReference = params.variable_ref ?? params.scope_id;
				if (variableReference === undefined) {
					throw new ToolError("variables 需要 variable_ref 或 scope_id 参数");
				}
				const response = await dapSessionManager.variables(variableReference, combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.variables = response.variables;
				return result.text(formatVariables(response.variables)).done();
			}
			case "disassemble": {
				requireCapability("supportsDisassembleRequest", "反汇编");
				if (params.instruction_count === undefined) {
					throw new ToolError("disassemble 需要 instruction_count 参数");
				}
				const response = await dapSessionManager.disassemble(
					resolveDisassemblyReference(params.memory_reference),
					params.instruction_count,
					params.offset,
					params.instruction_offset,
					params.resolve_symbols,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.disassembly = response.instructions;
				return result.text(formatDisassembly(response.instructions)).done();
			}
			case "read_memory": {
				requireCapability("supportsReadMemoryRequest", "内存读取");
				if (!params.memory_reference) {
					throw new ToolError("read_memory 需要 memory_reference 参数");
				}
				if (params.count === undefined) {
					throw new ToolError("read_memory 需要 count 参数");
				}
				const response = await dapSessionManager.readMemory(
					params.memory_reference,
					params.count,
					params.offset,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.memoryAddress = response.address;
				details.memoryData = response.data;
				details.unreadableBytes = response.unreadableBytes;
				return result.text(formatMemoryRead(response.address, response.data, response.unreadableBytes)).done();
			}
			case "write_memory": {
				requireCapability("supportsWriteMemoryRequest", "内存写入");
				if (!params.memory_reference) {
					throw new ToolError("write_memory 需要 memory_reference 参数");
				}
				if (!params.data) {
					throw new ToolError("write_memory 需要 data 参数");
				}
				const response = await dapSessionManager.writeMemory(
					params.memory_reference,
					params.data,
					params.offset,
					params.allow_partial,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.bytesWritten = response.bytesWritten;
				return result
					.text(
						[
							"内存写入完成。",
							...(response.bytesWritten !== undefined ? [`写入字节数: ${response.bytesWritten}`] : []),
							...(response.offset !== undefined ? [`偏移量: ${response.offset}`] : []),
						].join("\n"),
					)
					.done();
			}
			case "modules": {
				requireCapability("supportsModulesRequest", "模块检查");
				const response = await dapSessionManager.modules(
					params.start_module,
					params.module_count,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.modules = response.modules;
				return result.text(formatModules(response.modules)).done();
			}
			case "loaded_sources": {
				requireCapability("supportsLoadedSourcesRequest", "已加载源文件");
				const response = await dapSessionManager.loadedSources(combinedSignal, timeoutSec * 1000);
				details.snapshot = response.snapshot;
				details.sources = response.sources;
				return result.text(formatLoadedSources(response.sources)).done();
			}
			case "custom_request": {
				if (!params.command) {
					throw new ToolError("custom_request 需要 command 参数");
				}
				const response = await dapSessionManager.customRequest(
					params.command,
					params.arguments,
					combinedSignal,
					timeoutSec * 1000,
				);
				details.snapshot = response.snapshot;
				details.customBody = response.body;
				return result.text(formatCustomResponse(params.command, response.body)).done();
			}
			case "output": {
				const response = dapSessionManager.getOutput();
				details.snapshot = response.snapshot;
				details.output = response.output;
				return result.text(response.output.length > 0 ? response.output : "(未捕获到输出)").done();
			}
			case "terminate": {
				const snapshot = await dapSessionManager.terminate(combinedSignal, timeoutSec * 1000);
				if (!snapshot) {
					return result.text("没有可终止的调试会话。").done();
				}
				details.snapshot = snapshot;
				return result.text(formatSessionSnapshot(snapshot).concat("调试会话已终止。").join("\n")).done();
			}
			case "sessions": {
				const sessions = dapSessionManager.listSessions();
				details.sessions = sessions;
				return result.text(formatSessions(sessions)).done();
			}
			default:
				throw new ToolError(`不支持的调试操作: ${params.action}`);
		}
	}
}
