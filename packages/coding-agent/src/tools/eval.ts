import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, ToolExample } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { jsBackend, juliaBackend, pythonBackend, rubyBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { IdleTimeout } from "../eval/idle-timeout";
import { defaultEvalSessionId } from "../eval/session-id";
import type { EvalCellResult, EvalDisplayOutput, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary, TailBuffer } from "../session/streaming-output";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { webpExclusionForModel } from "../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type EvalBackendsAllowance, resolveEvalBackends } from "./eval-backends";
import { upsertStatusEvent } from "./eval-render";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export { EVAL_DEFAULT_PREVIEW_LINES, evalToolRenderer } from "./eval-render";

/** Language tokens the eval tool accepts, in stable display order. */
export type EvalLanguageToken = "py" | "js" | "rb" | "jl";
const EVAL_LANGUAGE_ORDER: readonly EvalLanguageToken[] = ["py", "js", "rb", "jl"];
const EVAL_LANGUAGE_RUNTIME: Record<EvalLanguageToken, string> = {
	py: '"py" 用于 IPython 内核',
	js: '"js" 用于持久化 JS 虚拟机',
	rb: '"rb" 用于持久化 Ruby 内核',
	jl: '"jl" 用于持久化 Julia 内核',
};
const EVAL_LANGUAGE_NAME: Record<EvalLanguageToken, string> = {
	py: "Python",
	js: "JavaScript",
	rb: "Ruby",
	jl: "Julia",
};

/** Join names as an English "or" list: ["A"]→"A", ["A","B"]→"A or B", 3+→"A, B, or C". */
function joinWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} 或 ${items[1]}`;
	return `${items.slice(0, -1).join("、")} 或 ${items[items.length - 1]}`;
}

function describeLanguageField(langs: readonly EvalLanguageToken[]): string {
	return `运行时: ${langs.map(lang => EVAL_LANGUAGE_RUNTIME[lang]).join(", ")}`;
}

function describeCodeField(langs: readonly EvalLanguageToken[]): string {
	const replLangs = langs.filter(lang => lang === "rb" || lang === "jl");
	// No persistent REPL backends → keep the original py/js phrasing verbatim so the
	// default (rb/jl off) wire schema stays byte-identical to the pre-feature one.
	if (replLangs.length === 0) return "要在此 eval 调用中原样运行的代码。可随意使用顶层 await。";
	const awaitLangs = langs.filter(lang => lang === "py" || lang === "js");
	const clauses: string[] = [];
	if (awaitLangs.length > 0) clauses.push(`顶层 \`await\` 可在 ${awaitLangs.join("/")} 中使用`);
	clauses.push(`${replLangs.join("/")} 会像 REPL 一样自动显示最后一个表达式`);
	return `要在此 eval 调用中原样运行的代码。${clauses.join("; ")}。`;
}

/** One-line discovery summary listing the runtimes available this session. */
function summarizeEvalLanguages(langs: readonly EvalLanguageToken[]): string {
	const names = langs.map(lang => EVAL_LANGUAGE_NAME[lang]);
	const list = names.length > 0 ? joinWithOr(names) : "Python 或 JavaScript";
	// "in-process" matches the historical py/js summary; persistent kernels (rb/jl) switch wording.
	const backend = langs.some(lang => lang === "rb" || lang === "jl") ? "持久化" : "进程内";
	return `在${backend} eval 后端中执行 ${list} 代码`;
}

/** Resolved-allowance → enabled language tokens, preserving display order. */
function enabledEvalLanguages(backends: EvalBackendsAllowance): EvalLanguageToken[] {
	const allowed: Record<EvalLanguageToken, boolean> = {
		py: backends.python,
		js: backends.js,
		rb: backends.ruby,
		jl: backends.julia,
	};
	return EVAL_LANGUAGE_ORDER.filter(lang => allowed[lang]);
}

const evalCellCommonFields = {
	"title?": type("string").describe('显示在记录中的简短标签(例如 "imports"、"load config")'),
	"timeout?": type("number").describe("此 eval 调用的超时时间(秒);0 表示禁用单元格超时"),
	"reset?": type("boolean").describe("运行前清除该语言的内核。其他语言不受影响。"),
};

/**
 * Per-call input: a single cell. State persists within a language across
 * separate eval calls and across tool calls, so each call is one logical step
 * and later calls reuse what earlier ones defined. This static schema carries
 * the full language union for typing; {@link buildEvalSchema} narrows the wire
 * copy per session so disabled backends are never advertised to the model.
 */
export const evalSchema = type({
	language: type("'py' | 'js' | 'rb' | 'jl'").describe(describeLanguageField(EVAL_LANGUAGE_ORDER)),
	...evalCellCommonFields,
	code: type("string").describe(describeCodeField(EVAL_LANGUAGE_ORDER)),
});
export type EvalToolParams = typeof evalSchema.infer;
export type EvalCellInput = EvalToolParams;

/**
 * Build a session-scoped copy of the eval schema whose `language` enum and field
 * descriptions advertise only the runtimes enabled for this session. Disabled
 * backends never reach the model: the wire schema, BM25 discovery corpus, and
 * tool description stay in lockstep with {@link resolveEvalBackends}. The static
 * {@link evalSchema} (full union) remains the type-level source of truth.
 */
function buildEvalSchema(langs: readonly EvalLanguageToken[]): typeof evalSchema {
	const schema = type({
		language: type.enumerated(...langs).describe(describeLanguageField(langs)),
		code: type("string").describe(describeCodeField(langs)),
		...evalCellCommonFields,
	});
	return schema as unknown as typeof evalSchema;
}

export type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

export type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

/** Cap per `display()` value sent back to the model. */
const MAX_DISPLAY_TEXT_BYTES = 8000;

function formatDisplayJsonForText(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	if (text.length > MAX_DISPLAY_TEXT_BYTES) {
		text = `${text.slice(0, MAX_DISPLAY_TEXT_BYTES)}\n[…${text.length - MAX_DISPLAY_TEXT_BYTES} 字符已省略…]`;
	}
	return text;
}

/**
 * Format display() JSON values into text the model can see. Images are surfaced
 * separately as ImageContent so the model can actually inspect them; this helper
 * intentionally does not touch images.
 */
function formatDisplayOutputsForText(outputs: EvalDisplayOutput[]): string {
	const chunks: string[] = [];
	let displayIndex = 0;
	for (const output of outputs) {
		if (output.type !== "json") continue;
		displayIndex++;
		chunks.push(`显示[${displayIndex}]:\n${formatDisplayJsonForText(output.data)}`);
	}
	return chunks.join("\n\n");
}

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	rb?: boolean;
	jl?: boolean;
	/**
	 * Parent spawn policy (`getSessionSpawns`). `true`/omitted means unrestricted,
	 * `false`/`""` hides `agent()`, and a comma list drives the advertised default.
	 */
	spawns?: boolean | string | null;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	const rb = options.rb ?? false;
	const jl = options.jl ?? false;
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	return prompt.render(evalDescription, {
		py,
		js,
		rb,
		jl,
		spawns: spawnPolicy.enabled,
		spawnDefaultAgent: spawnPolicy.defaultAgent,
		spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
	});
}

export interface EvalToolOptions {
	proxyExecutor?: EvalProxyExecutor;
}

interface ResolvedBackend {
	backend: ExecutorBackend;
	notice?: string;
}

interface ResolvedEvalCell {
	index: number;
	title?: string;
	code: string;
	timeoutMs: number;
	reset: boolean;
	resolved: ResolvedBackend;
}

function uniqueEvalLanguages(cells: ResolvedEvalCell[]): EvalLanguage[] {
	return [...new Set(cells.map(cell => cell.resolved.backend.id))];
}

function detailsNotice(cells: ResolvedEvalCell[]): string | undefined {
	const notices = [
		...new Set(cells.map(cell => cell.resolved.notice).filter((notice): notice is string => Boolean(notice))),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

async function resolveBackend(session: ToolSession, language: EvalLanguage): Promise<ResolvedBackend> {
	const backends = resolveEvalBackends(session);
	const allowPy = backends.python;
	const allowJs = backends.js;
	const allowRb = backends.ruby;
	const allowJl = backends.julia;

	if (language === "python") {
		if (!allowPy) throw new ToolError("Python 后端已禁用(PI_PY=0 或 eval.py = false)。");
		if (!(await pythonBackend.isAvailable(session))) {
			const alternatives = [allowJs ? '"js"' : null, allowRb ? '"rb"' : null, allowJl ? '"jl"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `当前会话中 Python 后端不可用。请传入 language: ${alternatives.join(" 或 ")}，或安装 python 内核。`
					: '当前会话中 Python 后端不可用。请安装 python 内核以使用 language: "py"。',
			);
		}
		return { backend: pythonBackend };
	}
	if (language === "ruby") {
		if (!allowRb) throw new ToolError("Ruby 后端已禁用(PI_RB=0 或 eval.rb = false)。");
		if (!(await rubyBackend.isAvailable(session))) {
			const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowJl ? '"jl"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `当前会话中 Ruby 后端不可用。请传入 language: ${alternatives.join(" 或 ")}，或安装 Ruby。`
					: '当前会话中 Ruby 后端不可用。请安装 Ruby 以使用 language: "rb"。',
			);
		}
		return { backend: rubyBackend };
	}
	if (language === "julia") {
		if (!allowJl) throw new ToolError("Julia 后端已禁用(PI_JL=0 或 eval.jl = false)。");
		if (!(await juliaBackend.isAvailable(session))) {
			const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowRb ? '"rb"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `当前会话中 Julia 后端不可用。请传入 language: ${alternatives.join(" 或 ")}，或安装 Julia。`
					: '当前会话中 Julia 后端不可用。请安装 Julia 以使用 language: "jl"。',
			);
		}
		return { backend: juliaBackend };
	}
	if (!allowJs) throw new ToolError("JavaScript 后端已禁用(PI_JS=0 或 eval.js = false)。");
	return { backend: jsBackend };
}
function formatEvalInputLanguage(value: string): string {
	if (value === "py" || value === "python") return "python";
	if (value === "js" || value === "javascript") return "javascript";
	if (value === "rb" || value === "ruby") return "ruby";
	if (value === "jl" || value === "julia") return "julia";
	return value;
}

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<EvalToolParams>;
		const language =
			typeof params.language === "string" ? formatEvalInputLanguage(params.language) : "javascript(默认)";
		const code = typeof params.code === "string" ? params.code : "";
		return [`语言: ${language}`, `代码:\n${truncateForPrompt(code)}`];
	};
	get summary(): string {
		return summarizeEvalLanguages(this.#enabledLanguages());
	}
	readonly loadMode = "essential";
	readonly label = "代码执行";
	get description(): string {
		if (!this.session) return getEvalToolDescription();
		const backends = resolveEvalBackends(this.session);
		const sessionSpawns = this.session.getSessionSpawns?.() ?? "*";
		return getEvalToolDescription({
			py: backends.python,
			js: backends.js,
			rb: backends.ruby,
			jl: backends.julia,
			spawns: sessionSpawns,
		});
	}
	/** All reuse-chain examples; the `examples` getter filters by enabled languages. */
	private static readonly ALL_EXAMPLES: readonly ToolExample<typeof evalSchema.infer>[] = [
		{
			caption: "首次调用——一次性设置",
			call: {
				language: "py",
				title: "imports",
				code: "import json\nfrom pathlib import Path",
			},
		},
		{
			caption: "第二次调用——复用,不要重新导入",
			call: {
				language: "py",
				title: "load config",
				code: "data = json.loads(read('package.json'))\ndisplay(data)",
			},
		},
		{
			caption: "第三次调用——复用已加载的配置",
			call: {
				language: "py",
				title: "scan deps",
				code: "display(sorted(data['dependencies']))",
			},
		},
		{
			caption: "Ruby 首次调用——一次性设置",
			call: {
				language: "rb",
				title: "setup",
				code: "require 'json'\npkg_path = 'package.json'",
			},
		},
		{
			caption: "Ruby 第二次调用——复用,不要重新 require",
			call: {
				language: "rb",
				title: "load config",
				code: "pkg = JSON.parse(read(pkg_path))\ndisplay(pkg.keys.sort)",
			},
		},
	];
	get examples(): readonly ToolExample<typeof evalSchema.infer>[] {
		const langs = new Set(this.#enabledLanguages());
		return EvalTool.ALL_EXAMPLES.filter(ex => "call" in ex && langs.has(ex.call.language as EvalLanguageToken));
	}
	get parameters(): typeof evalSchema {
		const langs = this.#enabledLanguages();
		if (langs.length === 0 || langs.length === EVAL_LANGUAGE_ORDER.length) return evalSchema;
		const key = langs.join(",");
		if (this.#paramsKey !== key) {
			this.#cachedParams = buildEvalSchema(langs);
			this.#paramsKey = key;
		}
		return this.#cachedParams ?? evalSchema;
	}
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly intent = (args: Partial<typeof evalSchema.infer>): string | undefined => {
		const title = typeof args.title === "string" ? args.title : undefined;
		const language = typeof args.language === "string" ? formatEvalInputLanguage(args.language) : "javascript";
		return title || `运行 ${language}`;
	};

	readonly #proxyExecutor?: EvalProxyExecutor;

	#paramsKey?: string;
	#cachedParams?: typeof evalSchema;

	/**
	 * Languages enabled for this session, in display order. Detached tools (no
	 * session) fall back to the shipped defaults (py/js; rb/jl are opt-in).
	 */
	#enabledLanguages(): EvalLanguageToken[] {
		return this.session ? enabledEvalLanguages(resolveEvalBackends(this.session)) : ["py", "js"];
	}

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async execute(
		_toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("未使用代理执行器时,eval 工具需要会话");
		}
		const session = this.session;
		const excludeWebP = webpExclusionForModel(session.getActiveModel?.());

		const cellLanguage: EvalLanguage =
			params.language === "py"
				? "python"
				: params.language === "rb"
					? "ruby"
					: params.language === "jl"
						? "julia"
						: "js";
		const resolved = await resolveBackend(session, cellLanguage);
		const cells: ResolvedEvalCell[] = [
			{
				index: 0,
				title: params.title,
				code: params.code,
				timeoutMs: (params.timeout ?? 30) * 1000,
				reset: params.reset ?? false,
				resolved,
			},
		];
		const languages = uniqueEvalLanguages(cells);
		const notice = detailsNotice(cells);
		const sessionAbortController = new AbortController();
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};

		const execution = (async (): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			try {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				session.assertEvalExecutionAllowed?.();

				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
				const jsonOutputs: unknown[] = [];
				const images: ImageContent[] = [];
				const statusEvents: EvalStatusEvent[] = [];

				const cellResults: EvalCellResult[] = cells.map(cell => ({
					index: cell.index,
					title: cell.title,
					code: cell.code,
					language: cell.resolved.backend.id,
					output: "",
					status: "pending",
				}));
				const cellOutputs: string[] = [];
				// The cell currently inside backend.execute(). Streamed stdout is
				// appended to its rendered `output` live so a long-running cell (e.g. a
				// sleep loop) shows progress instead of nothing until it returns. A
				// dedicated per-cell tail buffer keeps attribution correct and avoids
				// double-counting against the aggregate `tailBuffer`; on completion the
				// authoritative `cellResult.output` (below) overwrites this live tail.
				let activeLiveCell: { result: EvalCellResult; buf: TailBuffer } | undefined;

				const appendTail = (text: string) => {
					tailBuffer.append(text);
				};

				const buildUpdateDetails = (): EvalToolDetails => {
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: cellResults.map(cell => ({
							...cell,
							statusEvents: cell.statusEvents ? [...cell.statusEvents] : undefined,
						})),
					};
					if (jsonOutputs.length > 0) {
						details.jsonOutputs = jsonOutputs;
					}
					if (images.length > 0) {
						details.images = images;
					}
					if (statusEvents.length > 0) {
						details.statusEvents = statusEvents;
					}
					if (notice) {
						details.notice = notice;
					}
					return details;
				};

				const pushUpdate = () => {
					if (!onUpdate) return;
					const tailText = tailBuffer.text();
					onUpdate({
						content: [{ type: "text", text: tailText }],
						details: buildUpdateDetails(),
					});
				};

				const sessionFile = session.getSessionFile?.() ?? undefined;
				const kernelOwnerId = session.getEvalKernelOwnerId?.() ?? undefined;
				const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.("eval")) ?? {};
				session.assertEvalExecutionAllowed?.();
				outputSink = new OutputSink({
					artifactPath,
					artifactId,
					headBytes: resolveOutputSinkHeadBytes(session.settings),
					maxColumns: resolveOutputMaxColumns(session.settings),
					onChunk: chunk => {
						appendTail(chunk);
						if (activeLiveCell) {
							activeLiveCell.buf.append(chunk);
							activeLiveCell.result.output = activeLiveCell.buf.text();
						}
						pushUpdate();
					},
				});
				const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);

				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const backend = cell.resolved.backend;
					// The per-cell `timeout` is a budget on the cell runtime's *own*
					// work. Host-side `agent()`/`parallel()`/`completion()` bridge calls suspend
					// that budget entirely and restart a fresh timeout window when control
					// returns to the active backend runtime. Compute, stdout, `log()`/`phase()`, and
					// ordinary tool calls all count against the budget. The watchdog drives
					// `combinedSignal`; we pass no wall-clock deadline downstream so the
					// backends never arm a competing fixed timer.
					const idleTimeoutMs =
						cell.timeoutMs === 0
							? undefined
							: clampTimeout("eval", cell.timeoutMs / 1000, session.settings.get("tools.maxTimeout")) * 1000;
					const idle = idleTimeoutMs === undefined ? undefined : new IdleTimeout(idleTimeoutMs);
					const combinedSignal =
						signal && idle
							? AbortSignal.any([signal, idle.signal, sessionAbortController.signal])
							: signal
								? AbortSignal.any([signal, sessionAbortController.signal])
								: idle
									? AbortSignal.any([idle.signal, sessionAbortController.signal])
									: sessionAbortController.signal;

					const cellResult = cellResults[i];
					cellResult.status = "running";
					cellResult.output = "";
					cellResult.statusEvents = undefined;
					cellResult.exitCode = undefined;
					cellResult.durationMs = undefined;
					activeLiveCell = { result: cellResult, buf: new TailBuffer(DEFAULT_MAX_BYTES * 2) };
					pushUpdate();

					const startTime = Date.now();
					let result: ExecutorBackendResult;
					try {
						result = await backend.execute(cell.code, {
							cwd: session.cwd,
							sessionId,
							sessionFile: sessionFile ?? undefined,
							kernelOwnerId,
							signal: combinedSignal,
							session,
							idleTimeoutMs,
							reset: cell.reset,
							onChunk: chunk => {
								outputSink!.push(chunk);
							},
							onStatus: event => {
								if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
									idle?.pause();
									return;
								}
								if (event.op === EVAL_TIMEOUT_RESUME_OP) {
									idle?.resume();
									return;
								}
								cellResult.statusEvents ??= [];
								upsertStatusEvent(cellResult.statusEvents, event);
								pushUpdate();
							},
						});
					} finally {
						idle?.dispose();
						activeLiveCell = undefined;
					}
					const durationMs = Date.now() - startTime;

					const cellStatusEvents: EvalStatusEvent[] = [];
					const cellDisplayOutputs: EvalDisplayOutput[] = [];
					const cellImageNotes: string[] = [];
					let cellHasMarkdown = false;
					for (const output of result.displayOutputs) {
						if (output.type === "json") {
							jsonOutputs.push(output.data);
							cellDisplayOutputs.push(output);
						}
						if (output.type === "image") {
							const resized = await resizeImage(
								{
									type: "image",
									data: output.data,
									mimeType: output.mimeType,
								},
								{ excludeWebP },
							);
							const image: ImageContent = {
								type: "image",
								data: resized.data,
								mimeType: resized.mimeType,
							};
							images.push(image);
							cellDisplayOutputs.push({
								type: "image",
								data: image.data,
								mimeType: image.mimeType,
							});
							const dimensionNote = formatDimensionNote(resized);
							if (dimensionNote) {
								cellImageNotes.push(`显示图片 ${cellImageNotes.length + 1}: ${dimensionNote}`);
							}
						}
						if (output.type === "status") {
							upsertStatusEvent(statusEvents, output.event);
							upsertStatusEvent(cellStatusEvents, output.event);
						}
						if (output.type === "markdown") {
							cellHasMarkdown = true;
						}
					}

					const stdoutTrimmed = result.output.trim();
					const imageText = cellImageNotes.join("\n");
					const displayText = formatDisplayOutputsForText(cellDisplayOutputs);
					const visibleDisplayText =
						displayText && imageText ? `${displayText}\n\n${imageText}` : displayText || imageText;
					const cellOutput =
						stdoutTrimmed && visibleDisplayText
							? `${stdoutTrimmed}\n\n${visibleDisplayText}`
							: stdoutTrimmed || visibleDisplayText;
					cellResult.output = cellOutput;
					cellResult.exitCode = result.exitCode;
					cellResult.durationMs = durationMs;
					cellResult.statusEvents = cellStatusEvents.length > 0 ? cellStatusEvents : undefined;
					cellResult.hasMarkdown = cellHasMarkdown || undefined;

					if (cellOutput) {
						cellOutputs.push(cellOutput);
						appendTail(cellOutput);
					}

					if (result.cancelled) {
						cellResult.status = "error";
						pushUpdate();
						const errorMsg = result.output || "命令已中止";
						const combinedOutput = cellOutputs.join("\n\n");
						const outputText = combinedOutput || errorMsg;

						const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
						const details: EvalToolDetails = {
							language: languages[0],
							languages,
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
						};
						if (notice) details.notice = notice;

						return toolResult(details)
							.content([{ type: "text", text: outputText }, ...images])
							.truncationFromSummary(summaryForMeta, { direction: "tail" })
							.done();
					}

					if (result.exitCode !== 0 && result.exitCode !== undefined) {
						cellResult.status = "error";
						pushUpdate();
						const combinedOutput = cellOutputs.join("\n\n");
						const outputText = combinedOutput
							? `${combinedOutput}\n\n命令以退出码 ${result.exitCode} 结束`
							: `命令以退出码 ${result.exitCode} 结束`;

						const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
						const details: EvalToolDetails = {
							language: languages[0],
							languages,
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
						};
						if (notice) details.notice = notice;

						return toolResult(details)
							.content([{ type: "text", text: outputText }, ...images])
							.truncationFromSummary(summaryForMeta, { direction: "tail" })
							.done();
					}

					cellResult.status = "complete";
					pushUpdate();
				}

				const combinedOutput = cellOutputs.join("\n\n");
				const hasImages = images.length > 0;
				const outputText =
					combinedOutput ||
					(hasImages
						? `(显示了 ${images.length} 张图片;无文本输出)`
						: "(无输出)");
				const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);

				const details: EvalToolDetails = {
					language: languages[0],
					languages,
					cells: cellResults,
					jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
					statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
				};
				if (notice) details.notice = notice;

				return toolResult(details)
					.content([{ type: "text", text: outputText }, ...images])
					.truncationFromSummary(summaryForMeta, { direction: "tail" })
					.done();
			} finally {
				if (!outputDumped) {
					try {
						await finalizeOutput();
					} catch {}
				}
			}
		})();

		return await (session.trackEvalExecution?.(execution, sessionAbortController) ?? execution);
	}
}

async function summarizeFinal(
	combinedOutput: string,
	finalizeOutput: () => Promise<OutputSummary | undefined>,
): Promise<OutputSummary> {
	const rawSummary = (await finalizeOutput()) ?? {
		output: "",
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	};
	const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
	const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
	const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
	const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
	return {
		output: combinedOutput,
		truncated: rawSummary.truncated,
		totalLines: outputLines + missingLines,
		totalBytes: outputBytes + missingBytes,
		outputLines,
		outputBytes,
		artifactId: rawSummary.artifactId,
		columnDroppedBytes: rawSummary.columnDroppedBytes,
		columnTruncatedLines: rawSummary.columnTruncatedLines,
		columnMax: rawSummary.columnMax,
	};
}
