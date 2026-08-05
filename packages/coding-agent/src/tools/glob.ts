import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import * as natives from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatGroupedPaths, isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { splitMemoryGlobPattern } from "../internal-urls/memory-protocol";
import type { Theme } from "../modes/theme/theme";
import globDescription from "../prompts/tools/glob.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "../session/streaming-output";
import { isScoutSpawnable } from "../task/spawn-policy";
import { Ellipsis, fileHyperlink, renderFileList, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntries,
	formatPathRelativeToCwd,
	hasGlobPathChars,
	isSshUrl,
	normalizePathLikeInput,
	parseFindPattern,
	partitionExistingPaths,
	resolveExplicitFindPatterns,
	resolveToCwd,
	toPathList,
} from "./path-utils";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const findSchema = type({
	"path?": type("string").describe(
		'要搜索的 glob、文件或目录——单个路径或分号分隔的列表("src/**/*.ts; test/**/*.ts")。省略时搜索工作区根目录(".")',
	),
	"hidden?": type("boolean").describe("包含隐藏文件"),
	"gitignore?": type("boolean").describe("遵循 gitignore"),
	"limit?": type("number").describe("最大结果数"),
});

export type GlobToolInput = typeof findSchema.infer;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const DEFAULT_GLOB_TIMEOUT_MS = 5000;

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	/** Working directory at search time. Used by the renderer to resolve relative
	 * file paths to absolute paths for OSC 8 hyperlinks. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface GlobOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface GlobToolOptions {
	/** Custom operations for find. Default: local filesystem + rg */
	operations?: GlobOperations;
	/** Remap slash-only paths to the session cwd before root-search validation. */
	rootPathAlias?: boolean;
}

interface GlobTarget {
	searchPath: string;
	globPattern: string;
	hasGlob: boolean;
}

export class GlobTool implements AgentTool<typeof findSchema, GlobToolDetails> {
	readonly name = "glob";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "文件搜索";
	get description(): string {
		return prompt.render(globDescription, {
			scoutAvailable: isScoutSpawnable(
				this.session.settings.get("task.disabledAgents") as string[] | undefined,
				this.session.getSessionSpawns?.() ?? "*",
			),
		});
	}
	readonly parameters = findSchema;

	readonly examples: readonly ToolExample<typeof findSchema.infer>[] = [
		{
			caption: "查找文件",
			call: { path: "src/**/*.ts" },
		},
		{
			caption: "多个目标——分号分隔的列表",
			call: { path: "src/**/*.ts; test/**/*.ts" },
		},
		{
			caption: "查找被 gitignore 忽略的文件(如 .env)",
			call: { path: ".env*", gitignore: false },
		},
		{
			caption: "按名称查找目录(同时返回文件和目录;目录以 `/` 结尾)",
			call: { path: "**/tests" },
		},
	];
	readonly strict = true;

	readonly #customOps?: GlobOperations;
	readonly #rootPathAlias: boolean;

	constructor(
		private readonly session: ToolSession,
		options?: GlobToolOptions,
	) {
		this.#customOps = options?.operations;
		this.#rootPathAlias = options?.rootPathAlias === true;
	}

	async execute(
		_toolCallId: string,
		params: typeof findSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GlobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GlobToolDetails>> {
		const { path: pathInput, limit, hidden, gitignore } = params;

		return untilAborted(signal, async () => {
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			const scopedPaths = toPathList(pathInput);
			const effectivePaths = scopedPaths.length > 0 ? scopedPaths : ["."];
			const rawPatternInputs = this.#customOps
				? effectivePaths
				: await expandDelimitedPathEntries(effectivePaths, this.session.cwd, { splitter: parseFindPattern });
			const rawPatterns = rawPatternInputs.map(input => normalizePathLikeInput(input).replace(/\\/g, "/"));
			const aliasResolvedPatterns = this.#rootPathAlias
				? rawPatterns.map(pattern => (/^\/+$/.test(pattern) ? "." : pattern))
				: rawPatterns;
			if (aliasResolvedPatterns.some(pattern => /^\/+$/.test(pattern))) {
				throw new ToolError("不允许从根目录 '/' 搜索");
			}
			const internalRouter = InternalUrlRouter.instance();
			const normalizedPatterns: string[] = [];
			for (const rawPattern of aliasResolvedPatterns) {
				if (!internalRouter.canHandle(rawPattern)) {
					normalizedPatterns.push(rawPattern);
					continue;
				}
				if (isSshUrl(rawPattern)) {
					throw new ToolError(
						`无法对远程 ssh:// 路径执行查找: ${rawPattern}。ssh:// 没有可 glob 的本地文件;请使用 \`read ${rawPattern}\` 列出或查看远程路径。`,
					);
				}
				if (hasGlobPathChars(rawPattern)) {
					if (!/^memory:\/\//i.test(rawPattern)) {
						throw new ToolError(`内部 URL 不支持 Glob 模式: ${rawPattern}`);
					}
					const memoryGlob = splitMemoryGlobPattern(rawPattern);
					const resource = await internalRouter.resolve(memoryGlob.baseUrl, {
						cwd: this.session.cwd,
						settings: this.session.settings,
						signal,
						localProtocolOptions: this.session.localProtocolOptions,
						skills: this.session.skills,
						pathOnly: true,
					});
					if (!resource.sourcePath) {
						throw new ToolError(`找不到没有底层文件的内部 URL: ${memoryGlob.baseUrl}`);
					}
					normalizedPatterns.push(
						path.join(resource.sourcePath.replace(/[*?[{]/g, "[$&]"), memoryGlob.globPattern),
					);
					continue;
				}
				const resource = await internalRouter.resolve(rawPattern, {
					cwd: this.session.cwd,
					settings: this.session.settings,
					signal,
					localProtocolOptions: this.session.localProtocolOptions,
					skills: this.session.skills,
					pathOnly: true,
				});
				if (!resource.sourcePath) {
					throw new ToolError(`找不到没有底层文件的内部 URL: ${rawPattern}`);
				}
				normalizedPatterns.push(resource.sourcePath);
			}
			if (normalizedPatterns.some(pattern => pattern.length === 0)) {
				throw new ToolError("`path` 必须包含非空的 glob 或路径");
			}

			// Tolerate missing entries in a multi-path call: skip ones whose base
			// directory is gone, and only error if every entry is missing. Single
			// missing path keeps the original ENOENT semantics — the user explicitly
			// asked about that one path, so silent empty results would be misleading.
			let missingPaths: string[] = [];
			let effectivePatterns = normalizedPatterns;
			if (normalizedPatterns.length > 1 && !this.#customOps) {
				const partition = await partitionExistingPaths(normalizedPatterns, this.session.cwd, parseFindPattern);
				if (partition.valid.length === 0) {
					throw new ToolError(`路径未找到: ${partition.missing.join(", ")}`);
				}
				effectivePatterns = partition.valid;
				missingPaths = partition.missing;
			}

			const multiPattern = await resolveExplicitFindPatterns(effectivePatterns, this.session.cwd);
			const isSingle = !multiPattern;
			const targets: GlobTarget[] = multiPattern
				? multiPattern.targets.map(target => ({
						searchPath: resolveToCwd(target.basePath, this.session.cwd),
						globPattern: target.globPattern,
						hasGlob: target.hasGlob,
					}))
				: [
						(() => {
							const parsed = parseFindPattern(effectivePatterns[0] ?? ".");
							return {
								searchPath: resolveToCwd(parsed.basePath, this.session.cwd),
								globPattern: parsed.globPattern,
								hasGlob: parsed.hasGlob,
							};
						})(),
					];
			const scopePath = multiPattern?.scopePath ?? formatScopePath(targets[0].searchPath);

			for (const target of targets) {
				if (target.searchPath === "/") {
					throw new ToolError("不允许从根目录 '/' 搜索");
				}
			}

			const requestedLimit = limit ?? DEFAULT_LIMIT;
			if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
				throw new ToolError("limit 必须为正数");
			}
			const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));
			const includeHidden = hidden ?? true;
			const useGitignore = gitignore ?? true;
			const timeoutMs = DEFAULT_GLOB_TIMEOUT_MS;
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const formatMatchPath = (matchPath: string, base: string, fileType?: natives.FileType): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(base, matchPath);
				return formatPathRelativeToCwd(absolutePath, this.session.cwd, {
					trailingSlash: fileType === natives.FileType.Dir || hadTrailingSlash,
				});
			};

			const missingPathsNote =
				missingPaths.length > 0 ? `已跳过缺失路径: ${missingPaths.join(", ")}` : undefined;

			const buildResult = (
				files: string[],
				opts?: { notice?: string; forceTruncated?: boolean; timedOut?: boolean },
			): AgentToolResult<GlobToolDetails> => {
				const notice = opts?.notice;
				const forceTruncated = opts?.forceTruncated ?? false;
				if (files.length === 0) {
					const details: GlobToolDetails = {
						scopePath,
						fileCount: 0,
						files: [],
						truncated: forceTruncated,
						cwd: this.session.cwd,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					// A timed-out empty result is an incomplete scan, not a verified
					// absence — never emit the definitive "No files found" claim next
					// to a timeout notice (the two statements contradict each other).
					const parts = opts?.timedOut ? [] : ["未找到与模式匹配的文件"];
					if (notice) parts.push(notice);
					if (missingPathsNote) parts.push(missingPathsNote);
					// Zero results is useless regardless of notices: the follow-up
					// call has already corrected course by the time compaction runs.
					return toolResult(details).text(parts.join("\n")).useless().done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const baseOutput = formatGroupedPaths(limited);
				const trailingNotes: string[] = [];
				if (notice) trailingNotes.push(notice);
				if (missingPathsNote) trailingNotes.push(missingPathsNote);
				const rawOutput = trailingNotes.length > 0 ? `${baseOutput}\n\n${trailingNotes.join("\n")}` : baseOutput;
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				const details: GlobToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(forceTruncated || limitMeta.resultLimit || truncation.truncated),
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
					cwd: this.session.cwd,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};

				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({ resultLimit: limitMeta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			// Walk each user path as its own root and run the globs concurrently.
			// Collapsing multiple paths to a shared base would force the walker to
			// traverse and stat every unrelated sibling under that ancestor; per-path
			// roots keep each scan bounded to exactly what the user asked for.
			if (this.#customOps?.glob) {
				const customOps = this.#customOps;
				const perTarget = await Promise.all(
					targets.map(async target => {
						if (!(await customOps.exists(target.searchPath))) {
							if (isSingle) throw new ToolError(`路径未找到: ${scopePath}`);
							return [] as string[];
						}
						if (!target.hasGlob && customOps.stat) {
							const stat = await customOps.stat(target.searchPath);
							if (stat.isFile()) return [formatScopePath(target.searchPath)];
						}
						const results = await customOps.glob(target.globPattern, target.searchPath, {
							ignore: ["**/node_modules/**", "**/.git/**"],
							limit: effectiveLimit,
						});
						return results.map(matchPath => formatMatchPath(matchPath, target.searchPath));
					}),
				);
				const seen = new Set<string>();
				const merged: string[] = [];
				for (const group of perTarget) {
					for (const entry of group) {
						if (seen.has(entry)) continue;
						seen.add(entry);
						merged.push(entry);
					}
				}
				return buildResult(merged);
			}

			const onUpdateMatches: string[] = [];
			const onUpdateMtimes: number[] = [];
			const updateIntervalMs = 200;
			let lastUpdate = 0;
			const emitUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdate < updateIntervalMs) return;
				lastUpdate = now;
				const details: GlobToolDetails = {
					scopePath,
					fileCount: onUpdateMatches.length,
					files: onUpdateMatches.slice(),
					truncated: false,
				};
				onUpdate({
					content: [{ type: "text", text: onUpdateMatches.join("\n") }],
					details,
				});
			};
			const streamed = new Set<string>();
			const makeOnMatch =
				(base: string) =>
				(err: Error | null, match: natives.GlobMatch | null): void => {
					if (err || combinedSignal.aborted || !match?.path) return;
					const relativePath = formatMatchPath(match.path, base, match.fileType);
					if (streamed.has(relativePath)) return;
					streamed.add(relativePath);
					onUpdateMatches.push(relativePath);
					onUpdateMtimes.push(match.mtime ?? 0);
					emitUpdate();
				};

			let timedOut = false;
			const runTarget = async (target: GlobTarget): Promise<Array<{ path: string; mtime: number }>> => {
				throwIfAborted(signal);
				let stat: fs.Stats;
				try {
					stat = await fs.promises.stat(target.searchPath);
				} catch (err) {
					if (isEnoent(err)) {
						if (isSingle) throw new ToolError(`路径未找到: ${scopePath}`);
						return [];
					}
					throw err;
				}
				if (!target.hasGlob && stat.isFile()) {
					return [{ path: formatScopePath(target.searchPath), mtime: stat.mtimeMs }];
				}
				if (!stat.isDirectory()) {
					if (isSingle) throw new ToolError(`路径不是目录: ${target.searchPath}`);
					return [];
				}
				try {
					const result = await untilAborted(combinedSignal, () =>
						natives.glob(
							{
								pattern: target.globPattern,
								path: target.searchPath,
								hidden: includeHidden,
								maxResults: effectiveLimit,
								sortByMtime: true,
								gitignore: useGitignore,
								// parseFindPattern explicitly prepends "**/" when the user's
								// pattern begins with a glob (so `*.ts` becomes `**/*.ts`).
								// Anything that arrives here without "**/" was scoped to a
								// single directory by the user (e.g. `dir/*`); disable the
								// native auto-recursion so `dir/*` does not silently match
								// `dir/sub/nested.ts`.
								recursive: false,
								signal: combinedSignal,
							},
							makeOnMatch(target.searchPath),
						),
					);
					throwIfAborted(signal);
					const out: Array<{ path: string; mtime: number }> = [];
					for (const match of result.matches) {
						if (!match.path) continue;
						out.push({
							path: formatMatchPath(match.path, target.searchPath, match.fileType),
							mtime: match.mtime ?? 0,
						});
					}
					return out;
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") {
						if (timeoutSignal.aborted && !signal?.aborted) {
							timedOut = true;
							return [];
						}
						throw new ToolAbortError();
					}
					throw error;
				}
			};

			const perTarget = await Promise.all(targets.map(runTarget));

			if (timedOut) {
				// Drain the partial matches accumulated during streaming and return them
				// instead of throwing — empty results after a multi-second wait force the
				// caller to retry blind, which is the worst possible outcome.
				const partial = onUpdateMatches.map((entry, index) => ({ p: entry, m: onUpdateMtimes[index] ?? 0 }));
				partial.sort((a, b) => b.m - a.m);
				const sortedPaths = partial.map(entry => entry.p);
				const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
				// Walk cost tracks directory-tree size, not pattern specificity: a
				// mtime-ranked scan cannot early-exit, so a "narrow" pattern over a
				// huge tree still times out. Say so instead of implying the pattern
				// was too broad.
				const notice =
					sortedPaths.length > 0
						? `glob 在 ${seconds} 秒后超时;返回 ${sortedPaths.length} 个部分匹配结果——结果不完整,请将搜索范围限定到更深的目录,而不是盲目重试`
						: `Glob 在 ${seconds} 秒后超时,未找到任何匹配——扫描不完整,不代表不存在。遍历受目录大小限制,与模式宽度无关;请将搜索范围限定到更深的目录(例如在巨大的根目录下使用 \`sub/dir/*.ext\` 而不是 \`*.ext\`)。`;
				return buildResult(sortedPaths, { notice, forceTruncated: true, timedOut: true });
			}

			// Merge per-target results: native glob already ranks each target's own
			// matches by mtime and caps them at the limit, so a global mtime re-sort
			// plus dedup yields the correct top-N across all roots.
			const seen = new Set<string>();
			const merged: Array<{ path: string; mtime: number }> = [];
			for (const group of perTarget) {
				for (const entry of group) {
					if (seen.has(entry.path)) continue;
					seen.add(entry.path);
					merged.push(entry);
				}
			}
			merged.sort((a, b) => b.mtime - a.mtime);
			return buildResult(merged.map(entry => entry.path));
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GlobRenderArgs {
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	limit?: number;
}

function formatGlobRenderPaths(args: GlobRenderArgs | undefined): string | undefined {
	const list = toPathList(args?.path ?? args?.paths);
	return list.length > 0 ? list.join(", ") : undefined;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function globStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const globToolRenderer = {
	inline: true,
	renderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`上限 ${args.limit} 条`);

		const text = renderStatusLine(
			{
				icon: "pending",
				title: "文件搜索",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args) || "*",
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GlobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GlobRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "未知错误";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("未找到与模式匹配") ||
				textContent.includes("未找到文件") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("未找到文件", uiTheme), 1, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					iconOverride: globStatusIcon(uiTheme),
					title: "文件搜索",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `已跳过缺失路径: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk —
			// render "incomplete", not a definitive "No files found".
			const emptyLabel = truncated ? "超时前未找到匹配项(扫描不完整)" : "未找到文件";
			const header = renderStatusLine(
				{
					icon: "warning",
					title: "文件搜索",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: truncated ? ["0 个文件", uiTheme.fg("warning", "已超时")] : ["0 个文件"],
				},
				uiTheme,
			);
			const lines = [header, formatEmptyMessage(emptyLabel, uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`在 ${details.scopePath} 中`);
		if (truncated) meta.push(uiTheme.fg("warning", "已截断"));
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: globStatusIcon(uiTheme) }),
				title: "文件搜索",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args),
				meta,
			},
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`结果上限 ${details.resultLimitReached} 条`);
		if (limits?.resultLimit) truncationReasons.push(`结果上限 ${limits.resultLimit.reached} 条`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "行数限制" : "大小限制");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `已截断: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const cwd = details?.cwd;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({
							path: entry,
							isDirectory: entry.endsWith("/"),
							absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						hyperlinkFn: fileHyperlink,
					},
					uiTheme,
				);
				return [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
};
