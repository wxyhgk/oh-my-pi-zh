/**
 * Protocol handlers for `issue://` and `pr://`.
 *
 * Both single-item reads route through the SQLite-backed `github-cache`,
 * sharing rendered markdown across sessions. Root and repo-scoped reads
 * (`issue://`, `pr://owner/repo`) issue a live `gh issue list` / `gh pr list`
 * for browsing.
 *
 * URL shapes:
 * - `issue://` / `pr://` — list recent items in the caller's default repo.
 * - `issue://owner/repo` / `pr://owner/repo` — list recent items for that repo.
 * - `issue://123` / `pr://123` — single item; repo derived from the caller's
 *   session cwd (passed through `ResolveContext`).
 * - `issue://owner/repo/123` / `pr://owner/repo/123` — fully qualified single
 *   item.
 * - `issue://owner/repo/123?comments=0` — single item, comments suppressed.
 * - `issue://owner/repo?state=closed&limit=20` — list options pass through to
 *   `gh`.
 */
import type { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import {
	getOrFetchIssue,
	getOrFetchPr,
	getOrFetchPrDiff,
	githubIssueJsonWithStateReasonFallback,
	type PrDiffFile,
	parsePositiveDecimalInt,
	resolveDefaultRepoMemoized,
} from "../tools/gh";
import { type CacheStatus, formatFreshnessNote } from "../tools/github-cache";
import * as git from "../utils/git";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

type Scheme = "issue" | "pr";

interface ParsedSingle {
	kind: "single";
	repo?: string;
	number: number;
	comments: boolean;
}

interface ParsedPrDiff {
	kind: "pr-diff";
	repo?: string;
	number: number;
	/**
	 * `list` → enumerate changed files.
	 * `all`  → full unified diff.
	 * `slice`→ single file's diff section (1-indexed `index`).
	 */
	mode: "list" | "all" | "slice";
	index?: number;
}

interface ParsedList {
	kind: "list";
	repo?: string;
	state: "open" | "closed" | "merged" | "all";
	limit: number;
	author: string | undefined;
	label: string | undefined;
}

type Parsed = ParsedSingle | ParsedList | ParsedPrDiff;

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;

function parseListOptions(url: InternalUrl, scheme: Scheme, repo: string | undefined): ParsedList {
	const stateRaw = url.searchParams.get("state");
	const allowedStates: ParsedList["state"][] =
		scheme === "pr" ? ["open", "closed", "merged", "all"] : ["open", "closed", "all"];
	if (stateRaw !== null && !(allowedStates as string[]).includes(stateRaw)) {
		// Reject instead of silently falling back to "open": a typo'd state
		// would otherwise return the open list, indistinguishable from "no
		// matches for the requested state".
		throw new Error(`无效的 ${scheme}:// 列表状态 '${stateRaw}'。允许的值:${allowedStates.join(", ")}。`);
	}
	const state = (stateRaw ?? "open") as ParsedList["state"];

	const limitRaw = url.searchParams.get("limit");
	let limit = LIST_LIMIT_DEFAULT;
	if (limitRaw !== null) {
		const parsed = parsePositiveDecimalInt(limitRaw);
		if (parsed === undefined) {
			throw new Error(
				`无效的 ${scheme}:// 列表限制 '${limitRaw}'。应为正整数(最大 ${LIST_LIMIT_MAX})。`,
			);
		}
		limit = Math.min(parsed, LIST_LIMIT_MAX);
	}
	return {
		kind: "list",
		repo,
		state,
		limit,
		author: url.searchParams.get("author") ?? undefined,
		label: url.searchParams.get("label") ?? undefined,
	};
}

function parseUrl(url: InternalUrl, scheme: Scheme): Parsed {
	const host = url.rawHost || url.hostname;
	const rawPath = url.rawPathname ?? url.pathname;
	// Strip a single leading slash so we can detect empty internal segments
	// (e.g. `pr://owner//77` → pathname `//77` → stripped `/77` → ["", "77"]).
	const stripped = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
	const parts: string[] = [];
	if (stripped !== "") {
		for (const seg of stripped.split("/")) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(seg);
			} catch {
				throw new Error(`无效的 ${scheme}:// URL:路径段为空或不安全`);
			}
			if (decoded === "" || decoded === "." || decoded === "..") {
				throw new Error(`无效的 ${scheme}:// URL:路径段为空或不安全`);
			}
			parts.push(seg);
		}
	}

	// Shapes:
	//   scheme://                    → list default repo
	//   scheme://N                   → single item, default repo
	//   scheme://owner/repo          → list specific repo
	//   scheme://owner/repo/N        → single item, specific repo
	//   pr://N/diff[/<sub>]          → diff family, default repo
	//   pr://owner/repo/N/diff[/<sub>] → diff family, specific repo
	let repo: string | undefined;
	let numberPart: string | undefined;
	let diffParts: string[] = [];

	if (!host && parts.length === 0) {
		return parseListOptions(url, scheme, undefined);
	}
	if (host && parts.length === 0) {
		// scheme://N (numeric) or scheme://owner (host-only, no repo segment)
		numberPart = host;
	} else if (parts[0] === "diff" && parsePositiveDecimalInt(host) !== undefined) {
		// <scheme>://N/diff[/<sub>] — short form with diff suffix. Restrict this
		// ambiguity to numeric hosts so `<scheme>://owner/diff` remains the valid
		// repo-scoped listing for a repository named `diff`. `issue://` falls
		// through to the `scheme === "issue"` branch below for the "issues have
		// no diff" rejection rather than being misparsed as repo `<N>/diff`.
		numberPart = host;
		diffParts = parts;
	} else if (host && parts.length === 1) {
		// scheme://owner/repo  → list
		repo = `${host}/${parts[0]}`;
		return parseListOptions(url, scheme, repo);
	} else if (host && parts.length >= 2) {
		// scheme://owner/repo/N[/diff[/<sub>]]
		repo = `${host}/${parts[0]}`;
		numberPart = parts[1];
		diffParts = parts.slice(2);
	} else {
		throw new Error(
			`无效的 ${scheme}:// URL。应为 ${scheme}://、${scheme}://<number>、${scheme}://<owner>/<repo> 或 ${scheme}://<owner>/<repo>/<number>`,
		);
	}

	// Reject unrecognized trailing segments before parsing the number so
	// shapes like `issue://owner/repo/foo/bar` surface as "Invalid URL"
	// rather than the misleading "Invalid number: foo".
	if (diffParts.length > 0) {
		if (scheme === "issue") {
			throw new Error(
				`无效的 issue:// URL。Issue 视图没有 diff;拉取请求请使用 pr://<owner>/<repo>/<n>/diff。`,
			);
		}
		if (diffParts[0] !== "diff" || diffParts.length > 2) {
			throw new Error(
				`无效的 pr:// URL。应为 pr://<n>、pr://<n>/diff、pr://<n>/diff/all 或 pr://<n>/diff/<i>`,
			);
		}
	}

	const num = parsePositiveDecimalInt(numberPart);
	if (num === undefined) {
		throw new Error(`无效的 ${scheme}:// 编号:${numberPart ?? "(缺失)"}`);
	}

	if (diffParts.length === 0) {
		const commentsParam = url.searchParams.get("comments");
		const comments =
			commentsParam === null ? true : !(commentsParam === "0" || commentsParam.toLowerCase() === "false");
		return { kind: "single", repo, number: num, comments };
	}

	// diffParts has already been validated above; scheme is `pr`.
	if (diffParts.length === 1) {
		return { kind: "pr-diff", repo, number: num, mode: "list" };
	}
	const sub = diffParts[1] ?? "";
	if (sub === "all") {
		return { kind: "pr-diff", repo, number: num, mode: "all" };
	}
	const idx = parsePositiveDecimalInt(sub);
	if (idx === undefined) {
		throw new Error(`无效的 pr:// diff 子路径 '${sub}'。请使用 'all' 或从 1 开始计数的文件编号。`);
	}
	return { kind: "pr-diff", repo, number: num, mode: "slice", index: idx };
}

/**
 * Resolve the working directory the protocol should use.
 *
 * Order:
 * 1. Caller-supplied `context.cwd` (the session that initiated `read`).
 * 2. First registered session via `AgentRegistry` (single-session fallback).
 * 3. `process.cwd()` (last resort).
 *
 * The earlier-fallback drives `gh repo view` and any `gh issue list` /
 * `gh pr list` for short-form URLs, so getting this right is what keeps
 * reads of `issue://N` from picking the wrong repo across concurrent sessions.
 */
function resolveCwd(context: ResolveContext | undefined): string {
	if (context?.cwd) return context.cwd;
	for (const ref of AgentRegistry.global().list()) {
		const cwd = ref.session?.sessionManager?.getCwd();
		if (cwd) return cwd;
	}
	return process.cwd();
}

function settingsFromContext(context: ResolveContext | undefined): Settings | undefined {
	const raw = context?.settings;
	if (!raw || typeof raw !== "object") return undefined;
	if (typeof (raw as { get?: unknown }).get !== "function") return undefined;
	return raw as Settings;
}

async function resolveListRepo(
	scheme: Scheme,
	parsedRepo: string | undefined,
	context: ResolveContext | undefined,
): Promise<string> {
	if (parsedRepo) return parsedRepo;
	const cwd = resolveCwd(context);
	try {
		return await resolveDefaultRepoMemoized(cwd, context?.signal);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`${scheme}:// 无法从当前会话解析默认仓库:${message}\n请改用 ${scheme}://<owner>/<repo>。`,
		);
	}
}

interface IssueListItem {
	number?: number;
	title?: string;
	state?: string;
	stateReason?: string | null;
	author?: { login?: string } | null;
	labels?: Array<{ name?: string }>;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
}

interface PrListItem extends IssueListItem {
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
}

function formatListItem(scheme: Scheme, repo: string, item: IssueListItem | PrListItem): string {
	const number = item.number ?? "?";
	const title = item.title ?? "(无标题)";
	const state = item.state?.toLowerCase() ?? "?";
	const author = item.author?.login ?? "?";
	const updated = item.updatedAt ?? item.createdAt ?? "";
	const draftSuffix = scheme === "pr" && (item as PrListItem).isDraft ? " [草稿]" : "";
	const labels = (item.labels ?? [])
		.map(l => l.name)
		.filter(Boolean)
		.join(", ");
	const labelSuffix = labels ? `  标签:${labels}` : "";
	const itemUrl = number === "?" ? `${scheme}://${repo}` : `${scheme}://${repo}/${number}`;
	return `- [${state}${draftSuffix}] #${number}  @${author}  ${updated}\n    ${title}${labelSuffix}\n    ${itemUrl}`;
}

async function fetchAndRenderList(
	scheme: Scheme,
	options: ParsedList,
	url: InternalUrl,
	context: ResolveContext | undefined,
): Promise<InternalResource> {
	const repo = await resolveListRepo(scheme, options.repo, context);
	const cwd = resolveCwd(context);
	const fields =
		scheme === "issue"
			? ["number", "title", "state", "author", "labels", "createdAt", "updatedAt", "url"]
			: [
					"number",
					"title",
					"state",
					"isDraft",
					"author",
					"baseRefName",
					"headRefName",
					"labels",
					"createdAt",
					"updatedAt",
					"url",
				];
	const args = [
		scheme,
		"list",
		"--repo",
		repo,
		"--state",
		options.state,
		"--limit",
		String(options.limit),
		"--json",
		fields.join(","),
	];
	if (options.author) args.push("--author", options.author);
	if (options.label) args.push("--label", options.label);

	const items =
		scheme === "issue"
			? await githubIssueJsonWithStateReasonFallback<Array<IssueListItem>>(cwd, args, context?.signal, {
					repoProvided: true,
				})
			: await git.github.json<Array<PrListItem>>(cwd, args, context?.signal, {
					repoProvided: true,
				});
	const header =
		scheme === "issue"
			? `# ${repo} 中的 Issue(${options.state},最多 ${options.limit} 条)`
			: `# ${repo} 中的拉取请求(${options.state},最多 ${options.limit} 条)`;
	const body =
		items.length === 0 ? "_无匹配。_" : items.map(item => formatListItem(scheme, repo, item)).join("\n\n");
	const footer = `\n\n---\n读取指定条目:\`${scheme}://${repo}/<N>\`(或当前仓库使用 \`${scheme}://<N>\`)。`;
	const rendered = `${header}\n\n${body}${footer}`;

	return {
		url: url.href,
		content: rendered,
		contentType: "text/markdown",
		size: Buffer.byteLength(rendered, "utf-8"),
		notes: [`${repo} 的实时列表`],
	};
}

interface BuildSingleArgs {
	url: InternalUrl;
	scheme: Scheme;
	parsed: ParsedSingle;
	rendered: string;
	status: CacheStatus;
	fetchedAt: number;
	/** Resolved repo (post short-form expansion) — used for the PR-only diff hint. */
	repo?: string;
}

function buildSingleResource({
	url,
	scheme,
	parsed,
	rendered,
	status,
	fetchedAt,
	repo,
}: BuildSingleArgs): InternalResource {
	const notes: string[] = [formatFreshnessNote(status, fetchedAt)];
	if (!parsed.comments) notes.push("评论已禁用");
	if (scheme === "pr") {
		const repoSegment = repo ?? parsed.repo;
		const diffUrl = repoSegment ? `pr://${repoSegment}/${parsed.number}/diff` : `pr://${parsed.number}/diff`;
		notes.push(`差异:${diffUrl}`);
	}
	const content =
		status === "stale"
			? `> 警告:GitHub 实时刷新失败;此 ${scheme} 内容为缓存,可能已过期。\n\n${rendered}`
			: rendered;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes,
	};
}

function formatFileLine(idx: number, file: PrDiffFile, repo: string, prNumber: number): string {
	const stats = file.changeType === "binary" ? "(二进制)" : `+${file.additions} -${file.deletions}`;
	const rename = file.oldPath ? `  (从 ${file.oldPath} 重命名)` : "";
	return `${idx}. ${file.path}  ${stats}  [${file.changeType}]${rename}\n   pr://${repo}/${prNumber}/diff/${idx}`;
}

async function fetchAndRenderPrDiff(
	url: InternalUrl,
	parsed: ParsedPrDiff,
	context: ResolveContext | undefined,
): Promise<InternalResource> {
	const cwd = resolveCwd(context);
	let repo = parsed.repo;
	if (!repo) {
		try {
			repo = await resolveDefaultRepoMemoized(cwd, context?.signal);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`pr://${parsed.number}/diff 无法从当前会话解析默认仓库:${message}\n请使用 pr://<owner>/<repo>/${parsed.number}/diff。`,
			);
		}
	}
	const lookup = await getOrFetchPrDiff({
		cwd,
		repo,
		number: parsed.number,
		signal: context?.signal,
		settings: settingsFromContext(context),
	});
	const files = lookup.payload.files;
	const freshness = formatFreshnessNote(lookup.status, lookup.fetchedAt);

	if (parsed.mode === "all") {
		const content = lookup.payload.unified;
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [
				freshness,
				`pr://${repo}/${parsed.number} 的完整差异(${files.length} 个文件)`,
			],
		};
	}

	if (parsed.mode === "slice") {
		const index = parsed.index ?? 0;
		if (index < 1 || index > files.length) {
			throw new Error(
				`pr://${repo}/${parsed.number}/diff/${index} 超出范围;该 PR 有 ${files.length} 个文件。使用 pr://${repo}/${parsed.number}/diff 可查看可用编号。`,
			);
		}
		const file = files[index - 1];
		if (!file) {
			throw new Error(`pr://${repo}/${parsed.number}/diff/${index} 解析到缺失的分片(解析器缺陷)。`);
		}
		const content = lookup.payload.unified.slice(file.startOffset, file.endOffset);
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [
				freshness,
				`正在显示文件 ${index}/${files.length}:${file.path}`,
				`读取全部:pr://${repo}/${parsed.number}/diff/all`,
			],
		};
	}

	// mode === "list"
	const header = `# 拉取请求差异:${repo}#${parsed.number}(${files.length} 个文件)`;
	const body =
		files.length === 0
			? "_无文件变更。_"
			: files.map((f, i) => formatFileLine(i + 1, f, repo, parsed.number)).join("\n\n");
	const footer = `\n\n---\n读取全部:\`pr://${repo}/${parsed.number}/diff/all\`。每个文件也可通过 \`pr://${repo}/${parsed.number}/diff/<i>\` 读取。`;
	const content = `${header}\n\n${body}${footer}`;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [freshness, `pr://${repo}/${parsed.number} 的文件列表`],
	};
}

/**
 * Handler for `issue://` URLs.
 */
export class IssueProtocolHandler implements ProtocolHandler {
	readonly scheme = "issue";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("已中止");
		}
		const parsed = parseUrl(url, "issue");
		if (parsed.kind === "list") {
			try {
				return await fetchAndRenderList("issue", parsed, url, context);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`issue:// 列表获取失败:${message}`);
			}
		}
		// parseUrl already rejects `issue://.../diff`; this guard is a belt-and-
		// suspenders catch in case the union grows.
		if (parsed.kind !== "single") {
			throw new Error(`无效的 issue:// URL:意外的变体 '${parsed.kind}'`);
		}
		try {
			const lookup = await getOrFetchIssue({
				cwd: resolveCwd(context),
				repo: parsed.repo,
				issue: String(parsed.number),
				includeComments: parsed.comments,
				signal: context?.signal,
				settings: settingsFromContext(context),
			});
			return buildSingleResource({
				url,
				scheme: "issue",
				parsed,
				rendered: lookup.rendered,
				status: lookup.status,
				fetchedAt: lookup.fetchedAt,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`issue:// 解析失败:${message}`);
		}
	}
}

/**
 * Handler for `pr://` URLs.
 */
export class PrProtocolHandler implements ProtocolHandler {
	readonly scheme = "pr";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (context?.signal?.aborted) {
			throw new Error("已中止");
		}
		const parsed = parseUrl(url, "pr");
		if (parsed.kind === "list") {
			try {
				return await fetchAndRenderList("pr", parsed, url, context);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`pr:// 列表获取失败:${message}`);
			}
		}
		if (parsed.kind === "pr-diff") {
			try {
				return await fetchAndRenderPrDiff(url, parsed, context);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`pr:// 差异解析失败:${message}`);
			}
		}
		const cwd = resolveCwd(context);
		let repo = parsed.repo;
		if (!repo) {
			try {
				repo = await resolveDefaultRepoMemoized(cwd, context?.signal);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(
					`pr://${parsed.number} 无法从当前会话解析默认仓库:${message}\n请使用 pr://<owner>/<repo>/${parsed.number}。`,
				);
			}
		}
		try {
			const lookup = await getOrFetchPr({
				cwd,
				repo,
				number: parsed.number,
				includeComments: parsed.comments,
				signal: context?.signal,
				settings: settingsFromContext(context),
			});
			return buildSingleResource({
				url,
				scheme: "pr",
				parsed,
				rendered: lookup.rendered,
				status: lookup.status,
				fetchedAt: lookup.fetchedAt,
				repo,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`pr:// 解析失败:${message}`);
		}
	}
}
