import * as path from "node:path";
import { formatHashlineHeader } from "@wxyhgk/hashline";
import { type } from "@wxyhgk/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@wxyhgk/pi-agent-core";
import type { ToolExample } from "@wxyhgk/pi-ai";
import { type AstReplaceChange, type AstReplaceFileChange, astEdit } from "@wxyhgk/pi-natives";
import type { Component } from "@wxyhgk/pi-tui";
import { replaceTabs, Text } from "@wxyhgk/pi-tui";
import { $envpos, prompt, untilAborted } from "@wxyhgk/pi-utils";
import { canonicalSnapshotKey, getFileSnapshotStore } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import astEditDescription from "../prompts/tools/ast-edit.md" with { type: "text" };
import {
	Ellipsis,
	fileHyperlink,
	framedBlock,
	outputBlockContentWidth,
	renderStatusLine,
	truncateToWidth,
} from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { parseReadUrlTarget } from "./fetch";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { classifyGroupedLines, formatGroupedFiles, groupLineIndicesByBlank } from "./grouped-file-output";
import type { OutputMeta } from "./output-meta";
import { isInternalUrlPath, resolveToolSearchScope } from "./path-utils";
import {
	appendParseErrorsBulletList,
	capParseErrors,
	formatCodeFrameLine,
	formatErrorDetail,
	formatMoreItems,
	formatParseErrors,
	formatParseErrorsCountLabel,
	PREVIEW_LIMITS,
} from "./render-utils";
import { PREVIEW_PENDING_NOTICE, queueResolveHandler } from "./resolve";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astEditOpSchema = type({
	pat: type("string").describe("AST 模式"),
	out: type("string").describe("替换模板"),
});

const astEditSchema = type({
	ops: astEditOpSchema.array().atLeastLength(1).describe("重写操作"),
	paths: type("string")
		.describe("要重写的文件、目录、glob 或内部 URL")
		.array()
		.atLeastLength(1)
		.describe("要重写的文件、目录、glob 或内部 URL 列表"),
});

interface AstEditCallOptions {
	rewrites: Record<string, string>;
	dryRun: boolean;
	maxFiles: number;
	failOnParseError: boolean;
	signal?: AbortSignal;
}

interface AstEditAggregatedResult {
	changes: AstReplaceChange[];
	fileChanges: AstReplaceFileChange[];
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
}

async function runAstEditTargets(
	targets: Array<{ basePath: string; glob?: string }>,
	commonBasePath: string,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	const aggregatedChanges: AstReplaceChange[] = [];
	const fileCounts = new Map<string, number>();
	const parseErrors: string[] = [];
	let totalReplacements = 0;
	let filesSearched = 0;
	let limitReached = false;
	let applied = !options.dryRun;
	for (const target of targets) {
		const targetResult = await astEdit({
			rewrites: options.rewrites,
			path: target.basePath,
			glob: target.glob,
			dryRun: options.dryRun,
			maxFiles: options.maxFiles,
			failOnParseError: options.failOnParseError,
			signal: options.signal,
		});
		totalReplacements += targetResult.totalReplacements;
		filesSearched += targetResult.filesSearched;
		limitReached = limitReached || targetResult.limitReached;
		applied = applied && targetResult.applied;
		if (targetResult.parseErrors) parseErrors.push(...targetResult.parseErrors);
		for (const change of targetResult.changes) {
			const absolute = path.resolve(target.basePath, change.path);
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, "/");
			aggregatedChanges.push({ ...change, path: rebased });
		}
		for (const fileChange of targetResult.fileChanges) {
			const absolute = path.resolve(target.basePath, fileChange.path);
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, "/");
			fileCounts.set(rebased, (fileCounts.get(rebased) ?? 0) + fileChange.count);
		}
	}
	const fileChanges: AstReplaceFileChange[] = Array.from(fileCounts, ([changePath, count]) => ({
		path: changePath,
		count,
	}));
	return {
		changes: aggregatedChanges,
		fileChanges,
		totalReplacements,
		filesTouched: fileChanges.length,
		filesSearched,
		applied,
		limitReached,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	};
}

function runAstEditOnce(
	targets: Array<{ basePath: string; glob?: string }> | undefined,
	resolvedSearchPath: string,
	globFilter: string | undefined,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	if (targets) {
		return runAstEditTargets(targets, resolvedSearchPath, options);
	}
	return astEdit({
		rewrites: options.rewrites,
		path: resolvedSearchPath,
		glob: globFilter,
		dryRun: options.dryRun,
		maxFiles: options.maxFiles,
		failOnParseError: options.failOnParseError,
		signal: options.signal,
	});
}

export interface AstEditToolDetails {
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileReplacements?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter (no model-only hashline anchors). The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during the edit. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at edit time. Display header paths are cwd-relative, so the
	 * renderer resolves them against this; `searchPath` is the scope target. */
	cwd?: string;
}

type AstEditSchemaInfer = typeof astEditSchema.infer;

export class AstEditTool implements AgentTool<typeof astEditSchema, AstEditToolDetails> {
	readonly name = "ast_edit";
	readonly approval = (args: unknown) => {
		const paths = Array.isArray((args as Partial<AstEditSchemaInfer>).paths)
			? ((args as Partial<AstEditSchemaInfer>).paths as string[])
			: [];
		return paths.length > 0 && paths.every(path => isInternalUrlPath(path)) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<AstEditSchemaInfer>;
		const lines: string[] = [];
		const ops = Array.isArray(params.ops) ? params.ops : [];
		const firstOp = ops[0];
		if (firstOp) {
			lines.push(`模式: ${truncateForPrompt(firstOp.pat)}`);
			lines.push(`替换: ${truncateForPrompt(firstOp.out)}`);
			if (ops.length > 1) {
				lines.push(`+${ops.length - 1} 个操作`);
			}
		}
		if (Array.isArray(params.paths) && params.paths.length > 0) {
			lines.push(`路径: ${truncateForPrompt(params.paths.join(", "))}`);
		}
		return lines;
	};
	readonly label = "AST 编辑";
	readonly summary = "执行基于 AST 的代码编辑(结构化重构)";
	readonly description: string;
	readonly parameters = astEditSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<AstEditSchemaInfer>[] = [
		{
			caption: "跨 TypeScript 文件重命名调用点",
			call: {
				ops: [{ pat: "oldApi($$$ARGS)", out: "newApi($$$ARGS)" }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "删除匹配的调用",
			call: {
				ops: [{ pat: "console.log($$$ARGS)", out: "" }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "重写 import 源路径",
			call: {
				ops: [{ pat: 'import { $$$IMPORTS } from "old-package"', out: 'import { $$$IMPORTS } from "new-package"' }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "现代化为可选链(同一元变量保证两边一致)",
			call: {
				ops: [{ pat: "$A && $A()", out: "$A?.()" }],
				paths: ["src/**/*.ts"],
			},
		},
		{
			caption: "使用捕获交换两个参数",
			call: {
				ops: [{ pat: "assertEqual($A, $B)", out: "assertEqual($B, $A)" }],
				paths: ["tests/**/*.ts"],
			},
		},
		{
			caption: "Python — 将 print 调用转换为 logging",
			call: {
				ops: [{ pat: "print($$$ARGS)", out: "logger.info($$$ARGS)" }],
				paths: ["src/**/*.py"],
			},
		},
	];
	readonly deferrable = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astEditDescription);
	}

	async execute(
		_toolCallId: string,
		params: AstEditSchemaInfer,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstEditToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstEditToolDetails>> {
		return untilAborted(signal, async () => {
			const ops = params.ops.map((entry, index) => {
				if (entry.pat.length === 0) {
					throw new ToolError(`\`ops[${index}].pat\` 必须是非空模式`);
				}
				return [entry.pat, entry.out] as const;
			});
			if (ops.length === 0) {
				throw new ToolError("`ops` 必须至少包含一个操作条目");
			}
			const seenPatterns = new Set<string>();
			for (const [pat] of ops) {
				if (seenPatterns.has(pat)) {
					throw new ToolError(`重复的重写模式: ${pat}`);
				}
				seenPatterns.add(pat);
			}
			const normalizedRewrites = Object.fromEntries(ops);
			const maxFiles = $envpos("PI_MAX_AST_FILES", 1000);

			const scope = await resolveToolSearchScope({
				rawPaths: params.paths,
				cwd: this.session.cwd,
				internalUrlAction: "rewrite",
				settings: this.session.settings,
				signal,
				localProtocolOptions: this.session.localProtocolOptions,
				skills: this.session.skills,
				resolveExternalUrl: async rawPath => {
					if (!parseReadUrlTarget(rawPath)) return undefined;
					throw new ToolError(
						`无法重写外部 URL: ${rawPath}。请使用 \`read\` 或 \`search\` 检查抓取的网页内容;ast_edit 仅适用于本地文件。`,
					);
				},
			});
			const { searchPath: resolvedSearchPath, scopePath, isDirectory, multiTargets, globFilter } = scope;

			const result = await runAstEditOnce(multiTargets, resolvedSearchPath, globFilter, {
				rewrites: normalizedRewrites,
				dryRun: true,
				maxFiles,
				failOnParseError: false,
				signal,
			});

			const { errors: cappedParseErrors, total: parseErrorsTotal } = capParseErrors(result.parseErrors);
			const formatPath = (filePath: string): string =>
				formatResultPath(filePath, isDirectory, resolvedSearchPath, this.session.cwd);

			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileReplacementCounts = new Map<string, number>();
			const changesByFile = new Map<string, AstReplaceChange[]>();
			for (const fileChange of result.fileChanges) {
				const relativePath = formatPath(fileChange.path);
				recordFile(relativePath);
				fileReplacementCounts.set(relativePath, (fileReplacementCounts.get(relativePath) ?? 0) + fileChange.count);
			}
			for (const change of result.changes) {
				const relativePath = formatPath(change.path);
				recordFile(relativePath);
				if (!changesByFile.has(relativePath)) {
					changesByFile.set(relativePath, []);
				}
				changesByFile.get(relativePath)!.push(change);
			}

			const baseDetails: AstEditToolDetails = {
				totalReplacements: result.totalReplacements,
				filesTouched: result.filesTouched,
				filesSearched: result.filesSearched,
				applied: result.applied,
				limitReached: result.limitReached,
				...(cappedParseErrors.length > 0 ? { parseErrors: cappedParseErrors, parseErrorsTotal } : {}),
				scopePath,
				searchPath: resolvedSearchPath,
				cwd: this.session.cwd,
				files: fileList,
				fileReplacements: [],
			};

			if (result.totalReplacements === 0) {
				const parseMessage = cappedParseErrors.length
					? `\n${formatParseErrors(cappedParseErrors, parseErrorsTotal).join("\n")}`
					: "";
				return toolResult(baseDetails).text(`未进行任何替换${parseMessage}`).done();
			}

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const hashContexts = new Map<string, { tag: string }>();
			if (useHashLines) {
				const snapshotStore = getFileSnapshotStore(this.session);
				for (const relativePath of fileList) {
					const absolutePath = path.resolve(this.session.cwd, relativePath);
					try {
						const fullText = normalizeToLF(await Bun.file(absolutePath).text());
						const tag = snapshotStore.record(canonicalSnapshotKey(absolutePath), fullText);
						hashContexts.set(relativePath, { tag });
					} catch {
						// Best-effort: if a file disappears between ast-edit and rendering, emit plain line output.
					}
				}
			}
			const outputLines: string[] = [];
			const displayLines: string[] = [];
			const renderChangesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileChanges = changesByFile.get(relativePath) ?? [];
				const hashContext = hashContexts.get(relativePath);
				const lineNumberWidth = fileChanges.reduce(
					(width, change) => Math.max(width, String(change.startLine).length),
					0,
				);
				for (const change of fileChanges) {
					const beforeFirstLine = change.before.split("\n", 1)[0] ?? "";
					const afterFirstLine = change.after.split("\n", 1)[0] ?? "";
					const beforeLine = beforeFirstLine.slice(0, 120);
					const afterLine = afterFirstLine.slice(0, 120);
					const beforeRef = hashContext ? `${change.startLine}` : `${change.startLine}:${change.startColumn}`;
					const afterRef = hashContext ? `${change.startLine}` : `${change.startLine}:${change.startColumn}`;
					const lineSeparator = hashContext ? ":" : " ";
					modelOut.push(`-${beforeRef}${lineSeparator}${beforeLine}`);
					modelOut.push(`+${afterRef}${lineSeparator}${afterLine}`);
					displayOut.push(formatCodeFrameLine("-", change.startLine, beforeLine, lineNumberWidth));
					displayOut.push(formatCodeFrameLine("+", change.startLine, afterLine, lineNumberWidth));
				}
				return { model: modelOut, display: displayOut };
			};

			if (isDirectory) {
				const grouped = formatGroupedFiles(fileList, relativePath => {
					const rendered = renderChangesForFile(relativePath);
					const count = fileReplacementCounts.get(relativePath) ?? 0;
					const hashContext = hashContexts.get(relativePath);
					const hashSuffix = hashContext ? `#${hashContext.tag}` : "";
					return {
						headerSuffix: `${hashSuffix} (${count} 处替换)`,
						modelLines: rendered.model,
						displayLines: rendered.display,
						skip: rendered.model.length === 0,
					};
				});
				outputLines.push(...grouped.model);
				displayLines.push(...grouped.display);
			} else {
				for (const relativePath of fileList) {
					const rendered = renderChangesForFile(relativePath);
					if (rendered.model.length === 0) continue;
					if (outputLines.length > 0) {
						outputLines.push("");
						displayLines.push("");
					}
					const hashContext = hashContexts.get(relativePath);
					if (hashContext) {
						outputLines.push(formatHashlineHeader(relativePath, hashContext.tag));
					}
					outputLines.push(...rendered.model);
					displayLines.push(...rendered.display);
				}
			}

			const fileReplacements = fileList.map(filePath => ({
				path: filePath,
				count: fileReplacementCounts.get(filePath) ?? 0,
			}));
			if (result.limitReached) {
				outputLines.push("", "已达到文件数上限;请缩小路径范围。");
			}
			if (cappedParseErrors.length) {
				outputLines.push("", ...formatParseErrors(cappedParseErrors, parseErrorsTotal));
			}

			// Register pending action so `resolve` can apply or discard these previewed changes
			if (!result.applied && result.totalReplacements > 0) {
				queueResolveHandler(this.session, {
					label: `AST 编辑:${result.totalReplacements} 处替换,共 ${result.filesTouched} 个文件`,
					sourceToolName: this.name,
					apply: async (_reason: string) => {
						const applyResult = await runAstEditOnce(multiTargets, resolvedSearchPath, globFilter, {
							rewrites: normalizedRewrites,
							dryRun: false,
							maxFiles,
							failOnParseError: false,
						});
						const { errors: cappedApplyParseErrors, total: applyParseErrorsTotal } = capParseErrors(
							applyResult.parseErrors,
						);
						const { record: recordAppliedFile, list: appliedFileList } = createFileRecorder();
						const appliedFileReplacementCounts = new Map<string, number>();
						for (const fileChange of applyResult.fileChanges) {
							const relativePath = formatPath(fileChange.path);
							recordAppliedFile(relativePath);
							appliedFileReplacementCounts.set(
								relativePath,
								(appliedFileReplacementCounts.get(relativePath) ?? 0) + fileChange.count,
							);
						}
						for (const change of applyResult.changes) {
							recordAppliedFile(formatPath(change.path));
						}
						// The preview minted tags from pre-apply content; the rewrite just
						// invalidated them. Re-record post-apply snapshots (canonical keys)
						// so the model's next hashline edit anchors against fresh tags.
						const freshTagLines: string[] = [];
						if (useHashLines) {
							const snapshotStore = getFileSnapshotStore(this.session);
							for (const relativePath of appliedFileList) {
								const appliedAbsolutePath = path.resolve(this.session.cwd, relativePath);
								try {
									const fullText = normalizeToLF(await Bun.file(appliedAbsolutePath).text());
									const freshTag = snapshotStore.record(canonicalSnapshotKey(appliedAbsolutePath), fullText);
									freshTagLines.push(formatHashlineHeader(relativePath, freshTag));
								} catch {
									// File disappeared between apply and re-read; skip its tag.
								}
							}
						}
						const appliedFileReplacements = appliedFileList.map(filePath => ({
							path: filePath,
							count: appliedFileReplacementCounts.get(filePath) ?? 0,
						}));
						const appliedDetails: AstEditToolDetails = {
							totalReplacements: applyResult.totalReplacements,
							filesTouched: applyResult.filesTouched,
							filesSearched: applyResult.filesSearched,
							applied: applyResult.applied,
							limitReached: applyResult.limitReached,
							...(cappedApplyParseErrors.length > 0
								? { parseErrors: cappedApplyParseErrors, parseErrorsTotal: applyParseErrorsTotal }
								: {}),
							scopePath,
							files: appliedFileList,
							fileReplacements: appliedFileReplacements,
						};
						const stalePreview =
							applyResult.totalReplacements !== result.totalReplacements ||
							applyResult.filesTouched !== result.filesTouched ||
							fileList.some(
								filePath => appliedFileReplacementCounts.get(filePath) !== fileReplacementCounts.get(filePath),
							) ||
							appliedFileList.some(
								filePath => fileReplacementCounts.get(filePath) !== appliedFileReplacementCounts.get(filePath),
							);
						if (stalePreview) {
							const staleText =
								applyResult.totalReplacements === 0
									? `预览已过期/不再匹配;未应用任何替换。预览预期有 ${result.totalReplacements} 处替换,涉及 ${result.filesTouched} 个文件。`
									: applyResult.totalReplacements < result.totalReplacements
										? `预览已过期/不再匹配;仅在 ${result.filesTouched} 个文件中的 ${applyResult.filesTouched} 个里应用了 ${result.totalReplacements} 处替换中的 ${applyResult.totalReplacements} 处。`
										: `预览已过期/不再匹配;实际应用了 ${applyResult.totalReplacements} 处替换,但预览预期为 ${result.totalReplacements} 处。`;
							const staleWithTags =
								freshTagLines.length > 0 ? `${staleText}\n${freshTagLines.join("\n")}` : staleText;
							return { ...toolResult(appliedDetails).text(staleWithTags).done(), isError: true };
						}
						const appliedText = `已在 ${applyResult.filesTouched} 个文件中应用 ${applyResult.totalReplacements} 处替换。`;
						const text = freshTagLines.length > 0 ? `${appliedText}\n${freshTagLines.join("\n")}` : appliedText;
						return toolResult(appliedDetails).text(text).done();
					},
				});
				// The renderer's ⟨proposed⟩ badge is TUI-only; this line is the model's
				// in-result signal that the diff above is staged, not applied.
				outputLines.unshift(PREVIEW_PENDING_NOTICE, "");
			}

			const details: AstEditToolDetails = {
				...baseDetails,
				fileReplacements,
				displayContent: displayLines.join("\n"),
			};
			return toolResult(details).text(outputLines.join("\n")).done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstEditRenderArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	paths?: string[];
}

const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

/**
 * Flatten pre-styled change groups into frame body lines. Groups are separated
 * by a blank line and carry no tree guides — the frame border is the container,
 * so nested `├─ │` gutters would just be noise. Collapsed mode always shows at
 * least the first group, then fills up to `budget` lines before summarizing the
 * rest as `… N more changes`.
 */
function buildChangeBody(groups: string[][], expanded: boolean, budget: number, theme: Theme): string[] {
	const lines: string[] = [];
	let shown = 0;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const separator = shown > 0 ? 1 : 0;
		const remainingAfter = groups.length - (i + 1);
		const reserved = !expanded && remainingAfter > 0 ? 1 : 0;
		// Always emit the first group; budget only gates subsequent ones.
		if (!expanded && shown > 0 && lines.length + separator + group.length + reserved > budget) break;
		if (separator) lines.push("");
		lines.push(...group);
		shown++;
	}
	const remaining = groups.length - shown;
	if (!expanded && remaining > 0) lines.push(theme.fg("muted", formatMoreItems(remaining, "改动")));
	return lines;
}

/** One-line header preview of an AST pattern. `renderStatusLine` only flattens
 * CR/LF, so a multi-line tab-indented pattern would otherwise punch raw tabs
 * into the status line; collapse all whitespace runs to single spaces. */
function patternPreview(pat: string | undefined): string | undefined {
	const collapsed = pat?.replace(/\s+/g, " ").trim();
	return collapsed || undefined;
}

export const astEditToolRenderer = {
	inline: true,
	renderCall(args: AstEditRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(`于 ${args.paths.join(", ")} 中`);
		const rewriteCount = args.ops?.length ?? 0;
		if (rewriteCount > 1) meta.push(`${rewriteCount} 个重写`);

		const description =
			rewriteCount === 1 ? patternPreview(args.ops?.[0]?.pat) : rewriteCount ? `${rewriteCount} 个重写` : "?";
		const header = renderStatusLine({ icon: "pending", title: "AST 编辑", description, meta }, uiTheme);
		// Pending call has no body yet — a lone status line is sleeker than an empty frame.
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstEditRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "未知错误";
			const header = renderStatusLine({ icon: "error", title: "AST 编辑" }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const totalReplacements = details?.totalReplacements ?? 0;
		const filesTouched = details?.filesTouched ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (totalReplacements === 0) {
			const rewriteCount = args?.ops?.length ?? 0;
			const description = rewriteCount === 1 ? patternPreview(args?.ops?.[0]?.pat) : undefined;
			const meta = ["0 处替换"];
			if (details?.scopePath) meta.push(`于 ${details.scopePath} 中`);
			if (filesSearched > 0) meta.push(`已搜索 ${filesSearched} 个文件`);
			const header = renderStatusLine({ icon: "warning", title: "AST 编辑", description, meta }, uiTheme);
			// The "0 replacements" count already rides on the status line; only parse
			// errors are worth a body, so frame solely when there are some.
			const bodyLines: string[] = [];
			appendParseErrorsBulletList(bodyLines, details?.parseErrors, uiTheme, details?.parseErrorsTotal);
			if (bodyLines.length === 0) return new Text(header, 0, 0);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: bodyLines }],
				state: "warning",
				borderColor: "borderMuted",
				width,
			}));
		}

		const summaryParts = [`${totalReplacements} 处替换`, `${filesTouched} 个文件`];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`于 ${details.scopePath} 中`);
		meta.push(`已搜索 ${filesSearched} 个文件`);
		if (limitReached) meta.push(uiTheme.fg("warning", "已达上限"));
		const rewriteCount = args?.ops?.length ?? 0;
		const description = rewriteCount === 1 ? patternPreview(args?.ops?.[0]?.pat) : undefined;

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks over the whole output so nested directory headers
		// reconstruct across the blank-line groups the tree list collapses by.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		const styledLines = allLines.map((line, index) => {
			const ctx = contexts[index]!;
			// Swap the inner code-frame gutter `│` for a space so it does not nest a
			// second vertical bar inside the frame border.
			const display = replaceTabs(line.replace("│", " "));
			if (ctx.kind === "dir") {
				const styled = uiTheme.fg("accent", display);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (ctx.kind === "file") {
				const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", display);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (display.startsWith("+")) return uiTheme.fg("toolDiffAdded", display);
			if (display.startsWith("-")) return uiTheme.fg("toolDiffRemoved", display);
			return uiTheme.fg("toolOutput", display);
		});
		const changeGroups = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("解析问题:");
			})
			.map(indices => indices.map(index => styledLines[index]!));

		const badge = { label: "待应用", color: "warning" as const };
		const header = renderStatusLine(
			{ icon: limitReached ? "warning" : "success", title: "AST 编辑", description, badge, meta },
			uiTheme,
		);

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "已达上限;请缩小路径范围"));
		}
		if (details?.parseErrors?.length) {
			extraLines.push(
				uiTheme.fg("warning", formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal)),
			);
		}
		return framedBlock(uiTheme, width => {
			const changeLines = buildChangeBody(changeGroups, Boolean(options.expanded), COLLAPSED_CHANGE_LIMIT, uiTheme);
			const innerWidth = outputBlockContentWidth(width);
			const bodyLines = [...changeLines, ...extraLines].map(l => truncateToWidth(l, innerWidth, Ellipsis.Omit));
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: options.isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
