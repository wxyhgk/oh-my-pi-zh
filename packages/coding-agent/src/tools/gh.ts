import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@wxyhgk/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@wxyhgk/pi-agent-core";
import { getWorktreeDir, hashPath, isEnoent, logger, prompt, untilAborted } from "@wxyhgk/pi-utils";
import type { Settings } from "../config/settings";
import githubDescription from "../prompts/tools/github.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { formatShortSha } from "./gh-format";
import { type CacheStatus, getOrFetchView, invalidateAllForNumber, resolveGithubCacheAuthKey } from "./github-cache";
import type { OutputMeta } from "./output-meta";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const GH_REPO_FIELDS = [
	"nameWithOwner",
	"description",
	"url",
	"defaultBranchRef",
	"homepageUrl",
	"forkCount",
	"isArchived",
	"isFork",
	"primaryLanguage",
	"repositoryTopics",
	"stargazerCount",
	"updatedAt",
	"viewerPermission",
	"visibility",
];
const GH_ISSUE_FIELDS = [
	"author",
	"body",
	"comments",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];
const GH_ISSUE_FIELDS_NO_COMMENTS = [
	"author",
	"body",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
];

const GH_ISSUE_STATE_REASON_FIELD = "stateReason";

function ghJsonErrorNamesField(err: unknown, field: string): boolean {
	if (!(err instanceof Error) || !err.message.includes("Unknown JSON field")) return false;
	return err.message.includes(`"${field}"`) || err.message.includes(`'${field}'`) || err.message.includes(field);
}

function dropJsonField(args: readonly string[], field: string): string[] | undefined {
	const next = [...args];
	const jsonIndex = next.indexOf("--json");
	if (jsonIndex < 0) return undefined;
	const fields = next[jsonIndex + 1];
	if (!fields) return undefined;
	const splitFields = fields.split(",");
	const kept = splitFields.filter(candidate => candidate !== field);
	if (kept.length === splitFields.length) return undefined;
	next[jsonIndex + 1] = kept.join(",");
	return next;
}

/** Runs `gh --json` for issue data, retrying without optional stateReason on older gh releases. */
export async function githubIssueJsonWithStateReasonFallback<T>(
	cwd: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
	options?: git.GhCommandOptions,
): Promise<T> {
	try {
		return await git.github.json<T>(cwd, [...args], signal, options);
	} catch (err) {
		if (!ghJsonErrorNamesField(err, GH_ISSUE_STATE_REASON_FIELD)) throw err;
		const retryArgs = dropJsonField(args, GH_ISSUE_STATE_REASON_FIELD);
		if (!retryArgs) throw err;
		return await git.github.json<T>(cwd, retryArgs, signal, options);
	}
}

const GH_PR_FIELDS = [
	"author",
	"baseRefName",
	"body",
	"comments",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
const GH_PR_FIELDS_NO_COMMENTS = [
	"author",
	"baseRefName",
	"body",
	"createdAt",
	"files",
	"headRefName",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
];
const GH_REPO_CLONE_FIELDS = ["nameWithOwner", "sshUrl", "url"];
const GH_PR_CHECKOUT_FIELDS = [
	"baseRefName",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"isCrossRepository",
	"maintainerCanModify",
	"number",
	"title",
	"url",
];
// /search/<endpoint> API response shapes (subset). Used when projecting raw
// REST results into the normalized `GhSearch*Result` shapes the formatters
// consume. We talk to the API directly because `gh search prs`/`issues`
// quotes multi-token positional queries (`is:"merged is:pr"`) and returns 0
// hits — see https://github.com/cli/cli for the upstream regression.
interface GhApiSearchResponse<T> {
	total_count?: number;
	incomplete_results?: boolean;
	items?: T[];
}
interface GhApiUser {
	login?: string;
	name?: string | null;
}
interface GhApiLabel {
	name?: string;
}
interface GhApiPullRequestRef {
	merged_at?: string | null;
}
interface GhApiSearchIssueItem {
	number?: number;
	title?: string;
	state?: string;
	state_reason?: string | null;
	user?: GhApiUser | null;
	labels?: GhApiLabel[];
	created_at?: string;
	updated_at?: string;
	html_url?: string;
	repository_url?: string;
	pull_request?: GhApiPullRequestRef | null;
}
interface GhApiSearchCodeItem {
	name?: string;
	path?: string;
	sha?: string;
	html_url?: string;
	repository?: { full_name?: string } | null;
	text_matches?: Array<{ fragment?: string; property?: string }>;
}
interface GhApiSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}
interface GhApiSearchCommitItem {
	sha?: string;
	node_id?: string;
	html_url?: string;
	author?: GhApiUser | null;
	committer?: GhApiUser | null;
	commit?: {
		author?: GhApiSearchCommitGitActor | null;
		committer?: GhApiSearchCommitGitActor | null;
		message?: string;
	} | null;
	repository?: { full_name?: string } | null;
}
interface GhApiSearchRepoItem {
	full_name?: string;
	description?: string | null;
	language?: string | null;
	stargazers_count?: number;
	forks_count?: number;
	open_issues_count?: number;
	archived?: boolean;
	fork?: boolean;
	private?: boolean;
	visibility?: string | null;
	updated_at?: string;
	created_at?: string;
	html_url?: string;
	owner?: GhApiUser | null;
}
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const FILE_PREVIEW_LIMIT = 50;
const RUN_WATCH_INTERVAL_DEFAULT = 3;
const RUN_WATCH_INTERVAL_SLOW = 15;
const RUN_WATCH_FAST_WINDOW_MS = 60_000;
const RUN_WATCH_NO_RUNS_GIVE_UP_MS = 90_000;
const RUN_WATCH_MAX_POLL_FAILURES = 5;
const RUN_WATCH_GRACE_DEFAULT = 5;
const RUN_WATCH_TAIL_DEFAULT = 15;
const RUN_WATCH_TAIL_MAX = 200;
const REVIEW_COMMENTS_PAGE_SIZE = 100;
const RUN_JOBS_PAGE_SIZE = 100;
const PR_DIFF_FILES_PAGE_SIZE = 100;
const PR_DIFF_FILES_MAX = 3000;
const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/.*)?$/;
const RUN_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;
const RUN_SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const RUN_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const JOB_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const GITHUB_READONLY_OPS: ReadonlySet<string> = new Set([
	"repo_view",
	"file_read",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
]);

const githubSchema = type({
	op: type(
		"'repo_view' | 'file_read' | 'pr_create' | 'pr_checkout' | 'pr_push' | 'search_issues' | 'search_prs' | 'search_code' | 'search_commits' | 'search_repos' | 'run_watch'",
	).describe("GitHub 操作"),
	"repo?": type("string").describe("仓库标识(owner/repo)"),
	"branch?": type("string").describe("分支"),
	"path?": type("string").describe("仓库内相对文件路径"),
	"pr?": type("string | string[]").describe("PR 编号、URL 或分支"),
	"force?": type("boolean").describe("重置已存在的本地分支"),
	"forceWithLease?": type("boolean").describe("force-with-lease 推送"),
	"title?": type("string").describe("PR 标题"),
	"body?": type("string").describe("PR 正文 Markdown"),
	"base?": type("string").describe("PR 基础分支"),
	"head?": type("string").describe("PR 头部分支"),
	"draft?": type("boolean").describe("以草稿形式创建 PR"),
	"fill?": type("boolean").describe("从提交自动填充 PR 标题/正文"),
	"reviewer?": type("string[]").describe("审查者"),
	"assignee?": type("string[]").describe("被指派人"),
	"label?": type("string[]").describe("标签"),
	"query?": type("string").describe("搜索查询"),
	"since?": type("string").describe("日期下限筛选"),
	"until?": type("string").describe("日期上限筛选"),
	"dateField?": type("'created' | 'updated'").describe("日期字段"),
	"limit?": type("number").describe("最大结果数"),
	"run?": type("string").describe("Actions 运行 ID 或 URL"),
	"tail?": type("number").describe("每个失败任务的日志行数"),
});

type GithubInput = typeof githubSchema.infer;

export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
}

export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
}

export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

interface GhUser {
	login?: string;
	name?: string | null;
}

interface GhLabel {
	name?: string;
}

interface GhComment {
	author?: GhUser | null;
	body?: string;
	createdAt?: string;
	url?: string;
	isMinimized?: boolean;
	minimizedReason?: string | null;
}

interface GhRepoTopic {
	name?: string;
	topic?: { name?: string };
}

interface GhRepoLanguage {
	name?: string;
}

interface GhRepoBranch {
	name?: string;
}

interface GhRepoViewData {
	nameWithOwner?: string;
	description?: string | null;
	url?: string;
	sshUrl?: string;
	defaultBranchRef?: GhRepoBranch | null;
	homepageUrl?: string | null;
	forkCount?: number;
	isArchived?: boolean;
	isFork?: boolean;
	primaryLanguage?: GhRepoLanguage | null;
	repositoryTopics?: GhRepoTopic[];
	stargazerCount?: number;
	updatedAt?: string;
	viewerPermission?: string | null;
	visibility?: string | null;
}

interface GhIssueViewData {
	author?: GhUser | null;
	body?: string | null;
	comments?: GhComment[];
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	state?: string;
	stateReason?: string | null;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhPrFile {
	path?: string;
	additions?: number;
	deletions?: number;
	changeType?: string;
}

interface GhPrViewData extends GhIssueViewData {
	baseRefName?: string;
	files?: GhPrFile[];
	headRefName?: string;
	headRefOid?: string;
	headRepository?: GhRepoViewData | null;
	headRepositoryOwner?: GhUser | null;
	isCrossRepository?: boolean;
	isDraft?: boolean;
	maintainerCanModify?: boolean;
	mergeStateStatus?: string;
	reviewComments?: GhPrReviewComment[];
	reviews?: GhPrReview[];
	reviewDecision?: string;
}

interface GhPrReviewCommit {
	oid?: string | null;
}

interface GhPrReview {
	author?: GhUser | null;
	body?: string | null;
	commit?: GhPrReviewCommit | null;
	state?: string | null;
	submittedAt?: string | null;
}

interface GhPrReviewCommentApi {
	body?: string | null;
	created_at?: string | null;
	html_url?: string | null;
	id?: number;
	in_reply_to_id?: number | null;
	line?: number | null;
	original_line?: number | null;
	path?: string | null;
	side?: string | null;
	user?: GhUser | null;
}

interface GhPrReviewComment {
	author?: GhUser | null;
	body?: string | null;
	createdAt?: string;
	id: number;
	inReplyToId?: number;
	line?: number;
	originalLine?: number;
	path?: string;
	side?: string;
	url?: string;
}

interface GhBranchApiResponse {
	commit?: {
		sha?: string | null;
	} | null;
}

interface GhSearchRepository {
	nameWithOwner?: string;
}

interface GhSearchResult {
	author?: GhUser | null;
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	repository?: GhSearchRepository | null;
	state?: string;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhSearchCodeTextMatch {
	fragment?: string;
	property?: string;
}

interface GhSearchCodeResult {
	path?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	textMatches?: GhSearchCodeTextMatch[];
	url?: string;
}

interface GhSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}

interface GhSearchCommitDetail {
	author?: GhSearchCommitGitActor | null;
	committer?: GhSearchCommitGitActor | null;
	message?: string;
}

interface GhSearchCommitResult {
	author?: GhUser | null;
	commit?: GhSearchCommitDetail | null;
	committer?: GhUser | null;
	id?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	url?: string;
}

interface GhSearchRepoResult {
	createdAt?: string;
	description?: string | null;
	forksCount?: number;
	fullName?: string;
	isArchived?: boolean;
	isFork?: boolean;
	isPrivate?: boolean;
	language?: string | null;
	openIssuesCount?: number;
	owner?: GhUser | null;
	stargazersCount?: number;
	updatedAt?: string;
	url?: string;
	visibility?: string | null;
}

interface GhRunReference {
	repo?: string;
	runId?: number;
}

interface GhActionsRunListResponse {
	workflow_runs?: GhActionsRunApi[];
}

interface GhActionsRunApi {
	id?: number;
	name?: string | null;
	display_title?: string | null;
	status?: string | null;
	conclusion?: string | null;
	head_branch?: string | null;
	head_sha?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
	html_url?: string | null;
}

interface GhActionsJobsResponse {
	total_count?: number;
	jobs?: GhActionsJobApi[];
}

interface GhActionsJobApi {
	id?: number;
	name?: string | null;
	status?: string | null;
	conclusion?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	html_url?: string | null;
}

interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

function normalizeBlock(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trimEnd();
}

function looksLikeGitHubUrl(value: string | undefined): boolean {
	return value?.startsWith("https://github.com/") ?? false;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizePrIdentifierList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const raw = typeof value === "string" ? [value] : value;
	const cleaned: string[] = [];
	for (const entry of raw) {
		const trimmed = entry?.trim();
		if (trimmed) cleaned.push(trimmed);
	}
	return cleaned;
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		throw new ToolError(`${label} 不能为空`);
	}
	return normalized;
}

function resolveSearchLimit(value: number | undefined): number {
	if (value === undefined) {
		return SEARCH_LIMIT_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("limit 必须是正数");
	}

	return Math.min(Math.floor(value), SEARCH_LIMIT_MAX);
}

function resolveTailLimit(value: number | undefined): number {
	if (value === undefined) {
		return RUN_WATCH_TAIL_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("tail 必须是正数");
	}

	return Math.min(Math.floor(value), RUN_WATCH_TAIL_MAX);
}

function appendRepoFlag(args: string[], repo: string | undefined, identifier?: string): void {
	if (!repo || looksLikeGitHubUrl(identifier)) {
		return;
	}

	args.push("--repo", repo);
}

const REPO_API_URL_PREFIX = "https://api.github.com/repos/";

const RELATIVE_DURATION_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIXED_UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 7 * 86_400_000,
};

/**
 * Resolve a search date bound to a GitHub-search-compatible literal. Returns
 * either a `YYYY-MM-DD` date (relative durations and date-only inputs) or a
 * full ISO 8601 datetime string (datetime inputs), so the caller can drop it
 * straight into a qualifier like `created:>=<value>`.
 */
export function parseSearchDateBound(raw: string, now: Date = new Date()): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new ToolError("日期边界不能为空");
	}

	const relMatch = trimmed.match(RELATIVE_DURATION_PATTERN);
	if (relMatch) {
		const count = Number(relMatch[1]);
		const unit = relMatch[2].toLowerCase();
		const fixedMs = FIXED_UNIT_MS[unit];
		let bound: Date;
		if (fixedMs !== undefined) {
			bound = new Date(now.getTime() - count * fixedMs);
		} else {
			bound = new Date(now);
			if (unit === "mo") {
				bound.setUTCMonth(bound.getUTCMonth() - count);
			} else {
				bound.setUTCFullYear(bound.getUTCFullYear() - count);
			}
		}
		return bound.toISOString().slice(0, 10);
	}

	if (ISO_DATE_PATTERN.test(trimmed)) {
		return trimmed;
	}

	const parsedMs = Date.parse(trimmed);
	if (!Number.isNaN(parsedMs)) {
		// GitHub search qualifiers accept seconds precision only
		// (`YYYY-MM-DDTHH:MM:SSZ`); strip the milliseconds toISOString emits.
		return new Date(parsedMs).toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	throw new ToolError(
		`无效的日期边界:${raw}。期望相对时长(如 "3d"、"12h"、"2w")、ISO 日期 "YYYY-MM-DD" 或 ISO 日期时间。`,
	);
}

/**
 * Build the GitHub-search qualifier (e.g. `created:>=2026-05-09`) for the
 * provided bounds, or `undefined` if neither bound is set.
 */
export function buildSearchDateQualifier(
	field: string,
	since: string | undefined,
	until: string | undefined,
	now?: Date,
): string | undefined {
	const sinceVal = since ? parseSearchDateBound(since, now) : undefined;
	const untilVal = until ? parseSearchDateBound(until, now) : undefined;
	if (sinceVal && untilVal) {
		return `${field}:${sinceVal}..${untilVal}`;
	}
	if (sinceVal) {
		return `${field}:>=${sinceVal}`;
	}
	if (untilVal) {
		return `${field}:<=${untilVal}`;
	}
	return undefined;
}

function resolveSearchDateField(
	command: "issues" | "prs" | "commits" | "repos",
	requested: "created" | "updated" | undefined,
): string {
	if (command === "commits") {
		return "committer-date";
	}
	const dateField = requested ?? "created";
	if (command === "repos" && dateField === "updated") {
		return "pushed";
	}
	return dateField;
}

function composeSearchQuery(parts: ReadonlyArray<string | undefined>): string {
	const cleaned: string[] = [];
	for (const part of parts) {
		const trimmed = part?.trim();
		if (trimmed) cleaned.push(trimmed);
	}
	if (cleaned.length === 0) {
		throw new ToolError("必须提供查询(或传入 since/until 按日期筛选)");
	}
	return cleaned.join(" ");
}

function buildGhApiSearchArgs(
	endpoint: "issues" | "code" | "commits" | "repositories",
	query: string,
	limit: number,
	extraHeaders?: ReadonlyArray<string>,
): string[] {
	const args = ["api", "-X", "GET", `/search/${endpoint}`, "-f", `q=${query}`, "-F", `per_page=${limit}`];
	for (const header of extraHeaders ?? []) {
		args.push("-H", header);
	}
	return args;
}

function repoFromRepositoryUrl(value: string | undefined): string | undefined {
	if (!value?.startsWith(REPO_API_URL_PREFIX)) return undefined;
	return value.slice(REPO_API_URL_PREFIX.length);
}

function githubRepoSlugEquals(left: string | undefined, right: string): boolean {
	if (left === undefined || left.length !== right.length) return false;
	for (let idx = 0; idx < left.length; idx += 1) {
		let leftCode = left.charCodeAt(idx);
		let rightCode = right.charCodeAt(idx);
		if (leftCode >= 65 && leftCode <= 90) leftCode += 32;
		if (rightCode >= 65 && rightCode <= 90) rightCode += 32;
		if (leftCode !== rightCode) return false;
	}
	return true;
}

function apiUserToGhUser(user: GhApiUser | null | undefined): GhUser | undefined {
	if (!user) return undefined;
	const login = user.login ?? undefined;
	const name = user.name ?? undefined;
	if (login === undefined && name === undefined) return undefined;
	return { login, name };
}

function apiLabelsToGhLabels(labels: GhApiLabel[] | undefined): GhLabel[] {
	return labels?.map(label => ({ name: label.name })) ?? [];
}

function apiIssueToSearchResult(item: GhApiSearchIssueItem): GhSearchResult {
	const merged = Boolean(item.pull_request?.merged_at);
	return {
		author: apiUserToGhUser(item.user) ?? null,
		createdAt: item.created_at,
		labels: apiLabelsToGhLabels(item.labels),
		number: item.number,
		repository: { nameWithOwner: repoFromRepositoryUrl(item.repository_url) },
		state: merged ? "merged" : item.state,
		title: item.title,
		updatedAt: item.updated_at,
		url: item.html_url,
	};
}

function apiCodeToSearchResult(item: GhApiSearchCodeItem): GhSearchCodeResult {
	return {
		path: item.path,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		textMatches: item.text_matches?.map(match => ({ fragment: match.fragment, property: match.property })),
		url: item.html_url,
	};
}

function apiCommitToSearchResult(item: GhApiSearchCommitItem): GhSearchCommitResult {
	return {
		author: apiUserToGhUser(item.author) ?? null,
		commit: item.commit
			? {
					author: item.commit.author ?? null,
					committer: item.commit.committer ?? null,
					message: item.commit.message,
				}
			: null,
		committer: apiUserToGhUser(item.committer) ?? null,
		id: item.node_id,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		url: item.html_url,
	};
}

function apiRepoToSearchResult(item: GhApiSearchRepoItem): GhSearchRepoResult {
	return {
		createdAt: item.created_at,
		description: item.description,
		forksCount: item.forks_count,
		fullName: item.full_name,
		isArchived: item.archived,
		isFork: item.fork,
		isPrivate: item.private,
		language: item.language,
		openIssuesCount: item.open_issues_count,
		owner: apiUserToGhUser(item.owner) ?? null,
		stargazersCount: item.stargazers_count,
		updatedAt: item.updated_at,
		url: item.html_url,
		visibility: item.visibility ?? null,
	};
}

function sanitizeRemoteName(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/g, "")
		.replace(/-+$/g, "");
	return sanitized.length > 0 ? `fork-${sanitized}` : "fork";
}

/** Maximum disambiguation suffixes we try before giving up on a worktree path. */
const WORKTREE_PATH_MAX_SUFFIX = 100;

function toLocalBranchRef(value: string): string {
	return `refs/heads/${value}`;
}

async function requireGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const repoRoot = await git.repo.root(cwd, signal);
	if (!repoRoot) {
		throw new ToolError("当前 git 仓库不可用。");
	}

	return repoRoot;
}

async function requirePrimaryGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const primaryRepoRoot = await git.repo.primaryRoot(cwd, signal);
	if (!primaryRepoRoot) {
		throw new ToolError("当前 git 仓库不可用。");
	}

	return primaryRepoRoot;
}

async function requireCurrentGitBranch(cwd: string, signal?: AbortSignal): Promise<string> {
	const branch = await git.branch.current(cwd, signal);
	if (!branch) {
		throw new ToolError("当前 git 分支不可用。请显式传入 `branch` 或 `run`。");
	}

	return branch;
}

async function requireCurrentGitHead(cwd: string, signal?: AbortSignal): Promise<string> {
	const headSha = await git.head.sha(cwd, signal);
	if (!headSha) {
		throw new ToolError("当前 git HEAD 不可用。请显式传入 `run`。");
	}

	return headSha;
}

/**
 * Resolve a worktree path that is free of conflicts.
 *
 * Given a `basePath`, return either `basePath` itself or `${basePath}-2`,
 * `${basePath}-3`, … up to {@link WORKTREE_PATH_MAX_SUFFIX} — whichever is the
 * first variant that is **not** registered with git as another worktree and
 * **not** present on disk. The numeric tail salvages two rare cases that
 * would otherwise abort a checkout: stale leftover dirs from an interrupted
 * `git worktree add`, and the (vanishingly unlikely) `hashPath` collision
 * between two repos that happen to produce the same 7-hex digest.
 */
async function resolveAvailableWorktreePath(
	basePath: string,
	existingWorktrees: git.GitWorktreeEntry[],
): Promise<string> {
	const registered = new Set(existingWorktrees.map(entry => path.resolve(entry.path)));
	for (let attempt = 0; attempt < WORKTREE_PATH_MAX_SUFFIX; attempt += 1) {
		const candidate = attempt === 0 ? basePath : `${basePath}-${attempt + 1}`;
		const normalized = path.resolve(candidate);
		if (registered.has(normalized)) continue;
		try {
			await fs.stat(normalized);
		} catch (error) {
			if (isEnoent(error)) {
				return candidate;
			}
			throw error;
		}
	}
	throw new ToolError(`在 ${basePath} 下找不到未使用的工作树路径(已尝试 ${WORKTREE_PATH_MAX_SUFFIX} 个后缀)`);
}

function selectPrCloneUrl(originUrl: string | undefined, repo: Pick<GhRepoViewData, "url" | "sshUrl">): string {
	if (originUrl?.startsWith("http://") || originUrl?.startsWith("https://")) {
		return normalizeOptionalString(repo.url) ?? normalizeOptionalString(repo.sshUrl) ?? "";
	}

	return normalizeOptionalString(repo.sshUrl) ?? normalizeOptionalString(repo.url) ?? "";
}

async function getRemoteUrls(repoRoot: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const remotes = await git.remote.list(repoRoot, signal);
	const urls = new Map<string, string>();
	for (const remoteName of remotes) {
		const remoteUrl = await git.remote.url(repoRoot, remoteName, signal);
		if (remoteUrl) {
			urls.set(remoteName, remoteUrl);
		}
	}
	return urls;
}

async function ensurePrRemote(
	repoRoot: string,
	data: GhPrViewData,
	signal?: AbortSignal,
): Promise<{ name: string; url: string }> {
	if (!data.isCrossRepository) {
		const originUrl = await git.remote.url(repoRoot, "origin", signal);
		if (!originUrl) {
			throw new ToolError("此仓库的 origin 远程不可用。");
		}

		return {
			name: "origin",
			url: originUrl,
		};
	}

	const headRepository = requireNonEmpty(data.headRepository?.nameWithOwner, "head 仓库");
	const repoSummary = await git.github.json<GhRepoViewData>(
		repoRoot,
		["repo", "view", headRepository, "--json", GH_REPO_CLONE_FIELDS.join(",")],
		signal,
		{ repoProvided: true },
	);
	const originUrl = await git.remote.url(repoRoot, "origin", signal);
	const remoteUrl = selectPrCloneUrl(originUrl, repoSummary);
	if (!remoteUrl) {
		throw new ToolError(`无法确定 ${headRepository} 的克隆 URL。`);
	}

	const remotes = await getRemoteUrls(repoRoot, signal);
	for (const [remoteName, url] of remotes) {
		if (url === remoteUrl) {
			return { name: remoteName, url };
		}
	}

	const preferredRemoteName = sanitizeRemoteName(
		data.headRepositoryOwner?.login ?? headRepository.split("/")[0] ?? "fork",
	);
	let remoteName = preferredRemoteName;
	let suffix = 2;
	while (remotes.has(remoteName)) {
		remoteName = `${preferredRemoteName}-${suffix}`;
		suffix += 1;
	}

	await git.remote.add(repoRoot, remoteName, remoteUrl, signal);

	return {
		name: remoteName,
		url: remoteUrl,
	};
}

async function resolvePrBranchPushTarget(
	repoRoot: string,
	localBranch: string,
	signal?: AbortSignal,
): Promise<{
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	maintainerCanModify?: boolean;
	isCrossRepository: boolean;
}> {
	const headRef = await git.config.getBranch(repoRoot, localBranch, "ompPrHeadRef", signal);
	if (!headRef) {
		throw new ToolError(`分支 ${localBranch} 没有 PR 推送元数据;请先通过 op: pr_checkout 检出`);
	}

	const pushRemote = await git.config.getBranch(repoRoot, localBranch, "pushRemote", signal);
	const remote = await git.config.getBranch(repoRoot, localBranch, "remote", signal);
	const prUrl = await git.config.getBranch(repoRoot, localBranch, "ompPrUrl", signal);
	const maintainerCanModifyValue = await git.config.getBranch(
		repoRoot,
		localBranch,
		"ompPrMaintainerCanModify",
		signal,
	);
	const isCrossRepositoryValue = await git.config.getBranch(repoRoot, localBranch, "ompPrIsCrossRepository", signal);

	const remoteName = pushRemote ?? remote;
	if (!remoteName) {
		throw new ToolError(`分支 ${localBranch} 没有配置推送远程`);
	}

	return {
		remoteName,
		remoteBranch: headRef,
		remoteUrl: await git.remote.url(repoRoot, remoteName, signal),
		prUrl,
		maintainerCanModify:
			maintainerCanModifyValue === undefined
				? undefined
				: ["1", "true", "yes", "on"].includes(maintainerCanModifyValue.toLowerCase()),
		isCrossRepository: ["1", "true", "yes", "on"].includes((isCrossRepositoryValue ?? "").toLowerCase()),
	};
}

function formatAuthor(author: GhUser | null | undefined): string | undefined {
	if (!author) return undefined;
	if (author.login) return `@${author.login}`;
	if (author.name) return author.name;
	return undefined;
}

function formatLabels(labels: GhLabel[] | undefined): string | undefined {
	const names = labels?.map(label => label.name).filter((value): value is string => Boolean(value)) ?? [];
	if (names.length === 0) return undefined;
	return names.join(", ");
}

function pushLine(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

function parseRunReference(value: string | undefined): GhRunReference {
	const run = normalizeOptionalString(value);
	if (!run) {
		return {};
	}

	if (/^\d+$/.test(run)) {
		return { runId: Number(run) };
	}

	const match = run.match(RUN_URL_PATTERN);
	if (!match) {
		throw new ToolError("run 必须是数字工作流运行 ID 或完整的 GitHub Actions 运行 URL");
	}

	return {
		repo: match[1],
		runId: Number(match[2]),
	};
}

function parsePullRequestUrl(value: string | undefined): { repo?: string; prNumber?: number } {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		return {};
	}

	const match = normalized.match(PR_URL_PATTERN);
	if (!match) {
		return {};
	}

	return {
		repo: match[1],
		prNumber: Number(match[2]),
	};
}

/**
 * Parse a digit-only decimal positive integer or return undefined. Rejects
 * `1e2`, `0x10`, `12.0`, leading +/-, or any other shape `Number()` would
 * accept — those would otherwise key the cache against the wrong row.
 */
export function parsePositiveDecimalInt(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const num = Number(value);
	if (!Number.isSafeInteger(num) || num <= 0) return undefined;
	return num;
}

function parseIssueUrl(value: string | undefined): { repo?: string; issueNumber?: number } {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return {};
	const match = normalized.match(ISSUE_URL_PATTERN);
	if (!match) return {};
	return {
		repo: match[1],
		issueNumber: Number(match[2]),
	};
}

function normalizePrReviewComment(comment: GhPrReviewCommentApi): GhPrReviewComment | null {
	if (typeof comment.id !== "number") {
		return null;
	}

	return {
		author: comment.user ?? null,
		body: comment.body,
		createdAt: normalizeOptionalString(comment.created_at),
		id: comment.id,
		inReplyToId: typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : undefined,
		line: typeof comment.line === "number" ? comment.line : undefined,
		originalLine: typeof comment.original_line === "number" ? comment.original_line : undefined,
		path: normalizeOptionalString(comment.path),
		side: normalizeOptionalString(comment.side),
		url: normalizeOptionalString(comment.html_url),
	};
}

function normalizeRunJob(job: GhActionsJobApi): GhRunJobSnapshot | null {
	if (typeof job.id !== "number") {
		return null;
	}

	return {
		id: job.id,
		name: normalizeOptionalString(job.name) ?? `job-${job.id}`,
		status: normalizeOptionalString(job.status),
		conclusion: normalizeOptionalString(job.conclusion),
		startedAt: normalizeOptionalString(job.started_at),
		completedAt: normalizeOptionalString(job.completed_at),
		url: normalizeOptionalString(job.html_url),
	};
}

function normalizeRunSnapshot(run: GhActionsRunApi, jobs: GhRunJobSnapshot[]): GhRunSnapshot {
	if (typeof run.id !== "number") {
		throw new ToolError("GitHub Actions 运行响应不包含运行 ID。");
	}

	return {
		id: run.id,
		workflowName: normalizeOptionalString(run.name),
		displayTitle: normalizeOptionalString(run.display_title),
		status: normalizeOptionalString(run.status),
		conclusion: normalizeOptionalString(run.conclusion),
		branch: normalizeOptionalString(run.head_branch),
		headSha: normalizeOptionalString(run.head_sha),
		createdAt: normalizeOptionalString(run.created_at),
		updatedAt: normalizeOptionalString(run.updated_at),
		url: normalizeOptionalString(run.html_url),
		jobs,
	};
}

function getRunOutcome(value: string | undefined): "success" | "failure" | "pending" {
	if (!value) {
		return "pending";
	}

	if (RUN_SUCCESS_CONCLUSIONS.has(value)) {
		return "success";
	}

	if (RUN_FAILURE_CONCLUSIONS.has(value)) {
		return "failure";
	}

	return "pending";
}

function getRunSnapshotOutcome(run: GhRunSnapshot): "success" | "failure" | "pending" {
	if (run.status !== "completed") {
		return "pending";
	}

	return getRunOutcome(run.conclusion);
}

function getRunCollectionOutcome(runs: GhRunSnapshot[]): "success" | "failure" | "pending" {
	if (runs.length === 0) {
		return "pending";
	}

	let pending = false;
	for (const run of runs) {
		if (run.jobs.some(isFailedJob)) {
			return "failure";
		}

		const outcome = getRunSnapshotOutcome(run);
		if (outcome === "failure") {
			return "failure";
		}
		if (outcome === "pending") {
			pending = true;
		}
	}

	return pending ? "pending" : "success";
}

function getRunCollectionSignature(runs: GhRunSnapshot[]): string {
	return runs
		.map(run => run.id)
		.sort((left, right) => left - right)
		.join(",");
}

function isFailedJob(job: GhRunJobSnapshot): boolean {
	return job.conclusion !== undefined && JOB_FAILURE_CONCLUSIONS.has(job.conclusion);
}

const GH_RATE_LIMIT_ERROR_PATTERN = /rate limit|HTTP 429|abuse detection/i;

/**
 * Rate-limit / secondary-limit gh failures are transient; the run_watch poll
 * loops back off and retry them instead of discarding the whole watch.
 */
function isRateLimitedGhError(err: unknown): boolean {
	return err instanceof ToolError && GH_RATE_LIMIT_ERROR_PATTERN.test(err.message);
}

function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "未知";
}

function parseTimestampMs(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getJobDurationSeconds(job: GhRunJobSnapshot, observedAtMs: number): number | undefined {
	const startedAtMs = parseTimestampMs(job.startedAt);
	if (startedAtMs === undefined) {
		return undefined;
	}

	const completedAtMs = parseTimestampMs(job.completedAt) ?? observedAtMs;
	return Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000));
}

function buildRunWatchJobDetails(job: GhRunJobSnapshot, observedAtMs: number): GhRunWatchJobDetails {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		conclusion: job.conclusion,
		durationSeconds: getJobDurationSeconds(job, observedAtMs),
		url: job.url,
	};
}

function buildRunWatchRunDetails(run: GhRunSnapshot, observedAtMs: number): GhRunWatchRunDetails {
	return {
		id: run.id,
		workflowName: run.workflowName,
		displayTitle: run.displayTitle,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.branch,
		headSha: run.headSha,
		url: run.url,
		jobs: run.jobs.map(job => buildRunWatchJobDetails(job, observedAtMs)),
	};
}

function buildFailedLogDetails(failedJobLogs: GhFailedJobLog[]): GhRunWatchFailedLogDetails[] {
	return failedJobLogs.map(entry => ({
		runId: entry.run.id,
		workflowName: entry.run.workflowName,
		jobName: entry.job.name,
		conclusion: entry.job.conclusion,
		tail: entry.tail,
		available: entry.available,
	}));
}

function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## 任务", "", "尚未报告任何任务。"];
	}

	const lines: string[] = [`## 任务 (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  开始时间", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  完成时间", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## 失败任务", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "失败"}]`);
		pushLine(lines, "运行", `#${entry.run.id}`);
		pushLine(lines, "工作流", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "开始时间", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "完成时间", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(options.mode === "full" ? "完整日志:" : `最后 ${options.tail} 行日志:`);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "完整日志不可用。" : "日志尾部不可用。");
		}
		lines.push("");
	}

	return lines;
}

function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### 运行 #${run.id} - ${run.workflowName}` : `### 运行 #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "标题", run.displayTitle ?? undefined);
	pushLine(lines, "分支", run.branch ?? undefined);
	pushLine(lines, "提交", formatShortSha(run.headSha));
	pushLine(lines, "状态", run.status);
	pushLine(lines, "结论", run.conclusion ?? undefined);
	pushLine(lines, "创建时间", run.createdAt);
	pushLine(lines, "更新时间", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}

function formatRunWatchSnapshot(
	repo: string,
	run: GhRunSnapshot,
	pollCount: number,
	note?: string,
	includeOutcome: boolean = false,
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# 正在监控 GitHub Actions 运行 #${run.id}`, ""];
	pushLine(lines, "仓库", repo);
	pushLine(lines, "工作流", run.workflowName ?? undefined);
	pushLine(lines, "标题", run.displayTitle ?? undefined);
	pushLine(lines, "分支", run.branch ?? undefined);
	pushLine(lines, "状态", run.status);
	pushLine(lines, "结论", run.conclusion ?? undefined);
	pushLine(lines, "创建时间", run.createdAt);
	pushLine(lines, "更新时间", run.updatedAt);
	pushLine(lines, "URL", run.url);
	pushLine(lines, "轮询", pollCount);
	pushLine(lines, "失败任务", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`备注: ${note}`);
	}

	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (includeOutcome) {
		lines.push("");
		lines.push(failedJobs.length > 0 ? "检测到失败。" : "所有任务均通过。");
	}

	return lines.join("\n").trim();
}

function formatRunWatchResult(
	repo: string,
	run: GhRunSnapshot,
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# GitHub Actions 运行 #${run.id}`, ""];
	pushLine(lines, "仓库", repo);
	pushLine(lines, "工作流", run.workflowName ?? undefined);
	pushLine(lines, "标题", run.displayTitle ?? undefined);
	pushLine(lines, "分支", run.branch ?? undefined);
	pushLine(lines, "状态", run.status);
	pushLine(lines, "结论", run.conclusion ?? undefined);
	pushLine(lines, "创建时间", run.createdAt);
	pushLine(lines, "更新时间", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (failedJobs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("运行失败。");
	} else if (getRunOutcome(run.conclusion) === "success") {
		lines.push("");
		lines.push("所有任务均通过。");
	} else {
		lines.push("");
		lines.push("运行已完成,但没有成功的任务,且没有可用的失败任务日志。");
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchSnapshot(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	pollCount: number,
	note?: string,
): string {
	const failedJobs = runs.flatMap(run => run.jobs.filter(isFailedJob));
	const completedRuns = runs.filter(run => run.status === "completed").length;
	const lines: string[] = [`# 正在监控 ${formatShortSha(headSha) ?? headSha} 的 GitHub Actions`, ""];
	pushLine(lines, "仓库", repo);
	pushLine(lines, "分支", branch);
	pushLine(lines, "提交", headSha);
	pushLine(lines, "轮询", pollCount);
	pushLine(lines, "运行数", runs.length);
	pushLine(lines, "已完成运行", `${completedRuns}/${runs.length}`);
	pushLine(lines, "失败任务", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`备注: ${note}`);
	}

	if (runs.length === 0) {
		lines.push("");
		lines.push("正在等待此提交的工作流运行。");
		return lines.join("\n").trim();
	}

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	return lines.join("\n").trim();
}

function formatCommitRunWatchResult(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const outcome = getRunCollectionOutcome(runs);
	const lines: string[] = [`# ${formatShortSha(headSha) ?? headSha} 的 GitHub Actions`, ""];
	pushLine(lines, "仓库", repo);
	pushLine(lines, "分支", branch);
	pushLine(lines, "提交", headSha);
	pushLine(lines, "运行数", runs.length);

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	if (failedJobLogs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("此提交的工作流运行失败。");
	} else if (outcome === "success") {
		lines.push("");
		lines.push("此提交的所有工作流运行均已通过。");
	} else {
		lines.push("");
		lines.push("此提交的工作流运行未成功完成。");
	}

	return lines.join("\n").trim();
}

function buildGhDetails(repo: string, run: GhRunSnapshot): GhToolDetails {
	return {
		repo,
		branch: run.branch,
		headSha: run.headSha,
		runId: run.id,
		runIds: [run.id],
		status: run.status,
		conclusion: run.conclusion,
		failedJobs: run.jobs.filter(isFailedJob).map(job => job.name),
	};
}

function buildRunWatchDetails(
	repo: string,
	run: GhRunSnapshot,
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhDetails(repo, run),
		watch: {
			mode: "run",
			state: options?.state ?? "completed",
			repo,
			branch: run.branch,
			headSha: run.headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			run: buildRunWatchRunDetails(run, observedAtMs),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

function buildGhRunCollectionDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
): GhToolDetails {
	const outcome = getRunCollectionOutcome(runs);
	return {
		repo,
		branch,
		headSha,
		runIds: runs.map(run => run.id),
		status: runs.length > 0 && runs.every(run => run.status === "completed") ? "completed" : "in_progress",
		conclusion: outcome,
		failedJobs: runs.flatMap(run =>
			run.jobs.filter(isFailedJob).map(job => `${run.workflowName ?? `运行 ${run.id}`}: ${job.name}`),
		),
	};
}

function buildCommitRunWatchDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhRunCollectionDetails(repo, headSha, branch, runs),
		watch: {
			mode: "commit",
			state: options?.state ?? "completed",
			repo,
			branch,
			headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			runs: runs.map(run => buildRunWatchRunDetails(run, observedAtMs)),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

async function resolveGitHubRepo(
	cwd: string,
	repo: string | undefined,
	runRepo: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	if (repo && runRepo && !githubRepoSlugEquals(repo, runRepo)) {
		throw new ToolError("运行 URL 的仓库与提供的 repo 不匹配");
	}

	if (repo) {
		return repo;
	}

	if (runRepo) {
		return runRepo;
	}

	const resolved = await git.github.text(
		cwd,
		["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
		signal,
	);
	return requireNonEmpty(resolved, "repo");
}

/**
 * Process-lifetime cache of `gh repo view --json nameWithOwner` lookups keyed
 * by absolute cwd. Avoids repeated `gh` chatter when the same protocol handler
 * or tool call resolves the default repo many times in a row.
 *
 * The shared lookup is intentionally **not** bound to any caller's
 * AbortSignal. Cancelling one caller would otherwise kill the underlying
 * `gh repo view` for every concurrent waiter on the same cwd. Each caller's
 * signal is honored at the wait point via `untilAborted` instead, so an abort
 * unwinds only that caller.
 */
const DEFAULT_REPO_RESOLVED = new Map<string, string>();
const DEFAULT_REPO_INFLIGHT = new Map<string, Promise<string>>();

export async function resolveDefaultRepoMemoized(cwd: string, signal?: AbortSignal): Promise<string> {
	const key = path.resolve(cwd);
	const ready = DEFAULT_REPO_RESOLVED.get(key);
	if (ready) return ready;
	let pending = DEFAULT_REPO_INFLIGHT.get(key);
	if (!pending) {
		pending = (async () => {
			// No caller signal: this lookup is shared across every concurrent
			// waiter on the same cwd.
			const resolved = await git.github.text(cwd, [
				"repo",
				"view",
				"--json",
				"nameWithOwner",
				"-q",
				".nameWithOwner",
			]);
			const value = requireNonEmpty(resolved, "repo");
			DEFAULT_REPO_RESOLVED.set(key, value);
			return value;
		})();
		// Drop the in-flight slot on settle so failures don't poison the cache
		// and so a successful resolution survives only in `DEFAULT_REPO_RESOLVED`.
		void pending.then(
			() => DEFAULT_REPO_INFLIGHT.delete(key),
			() => DEFAULT_REPO_INFLIGHT.delete(key),
		);
		DEFAULT_REPO_INFLIGHT.set(key, pending);
	}
	return untilAborted(signal, pending);
}

/**
 * Best-effort cached cwd → `owner/repo` resolution that swallows any failure
 * (not a git checkout, no GitHub remote, `gh` unauthenticated, …) into
 * `undefined`. Use where the cwd repo is a convenience fallback, not a safety
 * check.
 */
async function tryResolveCurrentRepo(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		return await resolveDefaultRepoMemoized(cwd, signal);
	} catch {
		return undefined;
	}
}

/**
 * Best-effort fresh cwd → `owner/repo` resolution for safety checks that must
 * reflect the repository currently mounted at `cwd`, not the process-lifetime
 * default-repo cache.
 */
async function tryResolveCurrentRepoFresh(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		return await resolveGitHubRepo(cwd, undefined, undefined, signal);
	} catch {
		return undefined;
	}
}

/**
 * Matches search-query qualifiers that already scope to a repository, org, or
 * user. When present, callers should avoid layering a default `repo:<current>`
 * on top — the user has already expressed an explicit scope.
 *
 * Only the leading `repo:`/`org:`/`user:`/`owner:` token is treated as a
 * scope marker; arbitrary substrings (e.g. inside quoted text) are ignored.
 */
const REPO_SCOPE_QUALIFIER_PATTERN = /(?:^|\s)-?(?:repo|org|user|owner):\S/i;

/**
 * Resolve the effective `repo:` scope for a search op. Returns the explicit
 * `repo` when set, `undefined` when the query already carries a scoping
 * qualifier, and otherwise the current checkout's `owner/repo` via
 * `resolveDefaultRepoMemoized`. Resolution failures (no git/gh context, no
 * configured remote) silently fall back to `undefined` so the search proceeds
 * across all of GitHub instead of throwing.
 */
async function resolveSearchRepoScope(
	cwd: string,
	repo: string | undefined,
	query: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (repo) return repo;
	if (query && REPO_SCOPE_QUALIFIER_PATTERN.test(query)) return undefined;
	return tryResolveCurrentRepo(cwd, signal);
}

async function resolveGitHubBranchHead(
	cwd: string,
	repo: string,
	branch: string,
	signal?: AbortSignal,
): Promise<string> {
	const response = await git.github.json<GhBranchApiResponse>(
		cwd,
		["api", "--method", "GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`],
		signal,
		{ repoProvided: true },
	);
	return requireNonEmpty(response.commit?.sha, `分支 ${branch} 的 HEAD SHA`);
}

async function fetchRunsForCommit(
	cwd: string,
	repo: string,
	headSha: string,
	signal?: AbortSignal,
	completedRunJobsCache?: Map<number, GhRunJobSnapshot[]>,
): Promise<GhRunSnapshot[]> {
	// Filter only by `head_sha`. The SHA uniquely identifies the commit, so
	// adding the GitHub `branch=` filter would wrongly exclude workflow runs
	// whose `head_branch` is not the local checkout — e.g. tag-push triggered
	// release workflows (`head_branch=v1.2.3`) or PR-triggered runs
	// (`head_branch=<pr head>`). See coding-agent issue tracker for details.
	const response = await git.github.json<GhActionsRunListResponse>(
		cwd,
		[
			"api",
			"--method",
			"GET",
			`/repos/${repo}/actions/runs`,
			"-F",
			`head_sha=${headSha}`,
			"-F",
			`per_page=${RUN_JOBS_PAGE_SIZE}`,
		],
		signal,
		{ repoProvided: true },
	);

	return Promise.all(
		(response.workflow_runs ?? [])
			.filter((run): run is GhActionsRunApi & { id: number } => typeof run.id === "number")
			.map(async run => {
				// Completed runs' job lists are stable until a re-run flips
				// `status` off "completed"; reuse them across watch polls so a
				// long watch does not refetch every finished run's jobs. A run
				// observed non-completed evicts its entry — when the re-run
				// completes, `status` flips back to "completed" and a stale
				// entry would serve the FIRST attempt's jobs and logs forever.
				const completed = run.status === "completed";
				if (!completed) completedRunJobsCache?.delete(run.id);
				let jobs = completed ? completedRunJobsCache?.get(run.id) : undefined;
				if (!jobs) {
					jobs = await fetchRunJobs(cwd, repo, run.id, signal);
					if (completed) completedRunJobsCache?.set(run.id, jobs);
				}
				return normalizeRunSnapshot(run, jobs);
			}),
	);
}

async function fetchRunJobs(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunJobSnapshot[]> {
	const jobs: GhRunJobSnapshot[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhActionsJobsResponse>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/actions/runs/${runId}/jobs`,
				"-F",
				`per_page=${RUN_JOBS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);
		const rawPage = response.jobs ?? [];
		const pageJobs = rawPage.map(job => normalizeRunJob(job)).filter((job): job is GhRunJobSnapshot => job !== null);
		jobs.push(...pageJobs);

		// Compare the raw page length: normalizeRunJob drops malformed items,
		// and a post-filter short page must not end pagination early.
		if (rawPage.length < RUN_JOBS_PAGE_SIZE) {
			break;
		}

		if ((response.total_count ?? 0) <= jobs.length) {
			break;
		}

		page += 1;
	}

	return jobs;
}

async function fetchPrReviewComments(
	cwd: string,
	repo: string,
	prNumber: number,
	signal?: AbortSignal,
): Promise<GhPrReviewComment[]> {
	const reviewComments: GhPrReviewComment[] = [];
	let page = 1;

	while (true) {
		const response = await git.github.json<GhPrReviewCommentApi[]>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/pulls/${prNumber}/comments`,
				"-F",
				`per_page=${REVIEW_COMMENTS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);

		const pageComments = response
			.map(comment => normalizePrReviewComment(comment))
			.filter((comment): comment is GhPrReviewComment => comment !== null);
		reviewComments.push(...pageComments);

		// Compare the raw page length: a dropped malformed item must not end
		// pagination early and silently lose the remaining pages.
		if (response.length < REVIEW_COMMENTS_PAGE_SIZE) {
			break;
		}

		page += 1;
	}

	return reviewComments;
}

async function fetchRunSnapshot(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunSnapshot> {
	const [run, jobs] = await Promise.all([
		git.github.json<GhActionsRunApi>(
			cwd,
			["api", "--method", "GET", `/repos/${repo}/actions/runs/${runId}`],
			signal,
			{
				repoProvided: true,
			},
		),
		fetchRunJobs(cwd, repo, runId, signal),
	]);

	return normalizeRunSnapshot(run, jobs);
}

function tailLogLines(log: string, tail: number): string | undefined {
	const normalized = normalizeBlock(log);
	if (!normalized) {
		return undefined;
	}

	const lines = normalized.split("\n");
	return lines.slice(-tail).join("\n").trimEnd();
}

async function fetchFailedJobLogs(
	cwd: string,
	repo: string,
	failedJobs: Array<{ run: GhRunSnapshot; job: GhRunJobSnapshot }>,
	tail: number,
	signal?: AbortSignal,
): Promise<GhFailedJobLog[]> {
	return Promise.all(
		failedJobs.map(async entry => {
			const result = await git.github.run(cwd, ["api", `/repos/${repo}/actions/jobs/${entry.job.id}/logs`], signal);
			const fullLog = result.exitCode === 0 ? normalizeBlock(result.stdout) : undefined;
			const logTail = fullLog ? tailLogLines(fullLog, tail) : undefined;
			return {
				run: entry.run,
				job: entry.job,
				full: fullLog,
				tail: logTail,
				available: Boolean(fullLog),
			};
		}),
	);
}

function formatCommentsSection(comments: GhComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const visible = comments.filter(comment => !comment.isMinimized);
	const hiddenCount = comments.length - visible.length;
	const lines: string[] = ["## 评论", ""];

	if (visible.length === 0) {
		lines.push(`没有可见评论。已省略 ${hiddenCount} 条已最小化评论。`);
		return lines;
	}

	lines[0] = `## 评论 (${visible.length})`;

	for (const comment of visible) {
		const author = formatAuthor(comment.author) ?? "未知";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		lines.push(normalizeText(comment.body) || "无评论正文。");
		if (comment.url) {
			lines.push("");
			lines.push(`URL: ${comment.url}`);
		}
		lines.push("");
	}

	if (hiddenCount > 0) {
		lines.push(`已省略 ${hiddenCount} 条已最小化评论。`);
	}

	return lines;
}

function formatReviewsSection(reviews: GhPrReview[] | undefined): string[] {
	if (!reviews || reviews.length === 0) {
		return [];
	}

	const lines: string[] = [`## 审查 (${reviews.length})`, ""];
	for (const review of reviews) {
		const author = formatAuthor(review.author) ?? "未知";
		const submittedAt = review.submittedAt ? ` - ${review.submittedAt}` : "";
		const state = review.state ? ` [${review.state}]` : "";
		lines.push(`### ${author}${submittedAt}${state}`);
		if (review.commit?.oid) {
			lines.push("");
			lines.push(`提交: ${formatShortSha(review.commit.oid)}`);
		}
		lines.push("");
		lines.push(normalizeText(review.body) || "无审查正文。");
		lines.push("");
	}

	return lines;
}

function formatReviewCommentLocation(comment: GhPrReviewComment): string | undefined {
	if (!comment.path) {
		return undefined;
	}

	const line = comment.line ?? comment.originalLine;
	return line === undefined ? comment.path : `${comment.path}:${line}`;
}

function formatReviewCommentsSection(comments: GhPrReviewComment[] | undefined): string[] {
	if (!comments || comments.length === 0) {
		return [];
	}

	const lines: string[] = [`## 审查评论 (${comments.length})`, ""];
	for (const comment of comments) {
		const author = formatAuthor(comment.author) ?? "未知";
		const createdAt = comment.createdAt ? ` · ${comment.createdAt}` : "";
		lines.push(`### ${author}${createdAt}`);
		lines.push("");
		pushLine(lines, "位置", formatReviewCommentLocation(comment));
		pushLine(lines, "侧", comment.side);
		pushLine(lines, "回复对象", comment.inReplyToId);
		pushLine(lines, "URL", comment.url);
		lines.push("");
		lines.push(normalizeText(comment.body) || "无审查评论正文。");
		lines.push("");
	}

	return lines;
}

function formatRepoView(data: GhRepoViewData, input: { repo?: string; branch?: string }): string {
	const lines: string[] = [];
	const name = data.nameWithOwner ?? input.repo ?? "GitHub 仓库";
	lines.push(`# ${name}`);
	lines.push("");
	lines.push(normalizeText(data.description) || "未提供描述。");
	lines.push("");
	pushLine(lines, "URL", data.url);
	pushLine(lines, "默认分支", data.defaultBranchRef?.name);
	pushLine(lines, "分支", normalizeOptionalString(input.branch));
	pushLine(lines, "可见性", data.visibility ?? undefined);
	pushLine(lines, "查看者权限", data.viewerPermission ?? undefined);
	pushLine(lines, "主要语言", data.primaryLanguage?.name);
	pushLine(lines, "星标", data.stargazerCount);
	pushLine(lines, "Fork 数", data.forkCount);
	pushLine(lines, "已归档", data.isArchived);
	pushLine(lines, "Fork", data.isFork);
	pushLine(lines, "更新时间", data.updatedAt);
	pushLine(lines, "主页", data.homepageUrl ?? undefined);
	const topics = data.repositoryTopics
		?.map(topic => topic.name ?? topic.topic?.name)
		.filter((value): value is string => Boolean(value))
		.join(", ");
	pushLine(lines, "主题", topics || undefined);
	return lines.join("\n").trim();
}

function formatIssueView(data: GhIssueViewData, input: { issue: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const issueNumber = data.number ?? input.issue;
	lines.push(`# Issue #${issueNumber}: ${data.title ?? "无标题"}`);
	lines.push("");
	pushLine(lines, "状态", data.state);
	pushLine(lines, "状态原因", data.stateReason ?? undefined);
	pushLine(lines, "作者", formatAuthor(data.author));
	pushLine(lines, "创建时间", data.createdAt);
	pushLine(lines, "更新时间", data.updatedAt);
	pushLine(lines, "标签", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## 正文");
	lines.push("");
	lines.push(normalizeText(data.body) || "未提供描述。");

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

function formatPrFiles(files: GhPrFile[] | undefined): string[] {
	if (!files || files.length === 0) return [];

	const lines: string[] = [`## 文件 (${files.length})`, ""];
	for (const file of files.slice(0, FILE_PREVIEW_LIMIT)) {
		const changeType = file.changeType ?? "CHANGED";
		const additions = file.additions ?? 0;
		const deletions = file.deletions ?? 0;
		lines.push(`- ${file.path ?? "(未知文件)"} [${changeType}] (+${additions} -${deletions})`);
	}

	if (files.length > FILE_PREVIEW_LIMIT) {
		lines.push(`[…还有 ${files.length - FILE_PREVIEW_LIMIT} 个文件已省略…]`);
	}

	return lines;
}

function formatPrView(data: GhPrViewData, input: { pr?: string; repo?: string; comments?: boolean }): string {
	const lines: string[] = [];
	const prIdentifier = data.number ?? input.pr ?? "当前";
	lines.push(`# Pull Request #${prIdentifier}: ${data.title ?? "无标题"}`);
	lines.push("");
	pushLine(lines, "状态", data.state);
	pushLine(lines, "草稿", data.isDraft);
	pushLine(lines, "作者", formatAuthor(data.author));
	pushLine(lines, "基础分支", data.baseRefName);
	pushLine(lines, "头部分支", data.headRefName);
	pushLine(lines, "审查决定", data.reviewDecision ?? undefined);
	pushLine(lines, "合并状态", data.mergeStateStatus);
	pushLine(lines, "创建时间", data.createdAt);
	pushLine(lines, "更新时间", data.updatedAt);
	pushLine(lines, "标签", formatLabels(data.labels));
	pushLine(lines, "URL", data.url);
	lines.push("");
	lines.push("## 正文");
	lines.push("");
	lines.push(normalizeText(data.body) || "未提供描述。");

	const fileSection = formatPrFiles(data.files);
	if (fileSection.length > 0) {
		lines.push("");
		lines.push(...fileSection);
	}

	if ((input.comments ?? true) && data.reviews) {
		const reviewSection = formatReviewsSection(data.reviews);
		if (reviewSection.length > 0) {
			lines.push("");
			lines.push(...reviewSection);
		}
	}

	if ((input.comments ?? true) && data.reviewComments) {
		const reviewCommentsSection = formatReviewCommentsSection(data.reviewComments);
		if (reviewCommentsSection.length > 0) {
			lines.push("");
			lines.push(...reviewCommentsSection);
		}
	}

	if ((input.comments ?? true) && data.comments) {
		const commentSection = formatCommentsSection(data.comments);
		if (commentSection.length > 0) {
			lines.push("");
			lines.push(...commentSection);
		}
	}

	return lines.join("\n").trim();
}

function formatPrCheckoutResult(options: {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	reused: boolean;
}): string {
	const { data, localBranch, worktreePath, remoteName, remoteUrl, reused } = options;
	const lines: string[] = [
		reused ? `# Pull Request #${data.number ?? "?"} 工作树` : `# 已检出 Pull Request #${data.number ?? "?"}`,
		"",
	];
	pushLine(lines, "标题", data.title ?? undefined);
	pushLine(lines, "URL", data.url);
	pushLine(lines, "基础分支", data.baseRefName);
	pushLine(lines, "头部分支", data.headRefName);
	pushLine(lines, "本地分支", localBranch);
	pushLine(lines, "工作树", worktreePath);
	pushLine(lines, "远程", remoteName);
	pushLine(lines, "远程 URL", remoteUrl);
	pushLine(lines, "跨仓库", data.isCrossRepository);
	pushLine(lines, "维护者可修改", data.maintainerCanModify);
	lines.push("");
	lines.push(reused ? "复用了现有的 PR 工作树。" : "为此 PR 创建了专用工作树,并配置本地分支推送回 PR 头部分支。");
	return lines.join("\n").trim();
}

function formatPrPushResult(options: {
	localBranch: string;
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	forceWithLease: boolean;
}): string {
	const lines: string[] = ["# 已推送 Pull Request 分支", ""];
	pushLine(lines, "本地分支", options.localBranch);
	pushLine(lines, "远程", options.remoteName);
	pushLine(lines, "远程分支", options.remoteBranch);
	pushLine(lines, "远程 URL", options.remoteUrl);
	pushLine(lines, "PR", options.prUrl);
	pushLine(lines, "force-with-lease", options.forceWithLease);
	lines.push("");
	lines.push(`已将 ${options.localBranch} 推送到 ${options.remoteName}:${options.remoteBranch}。`);
	return lines.join("\n").trim();
}

function formatSearchResults(
	kind: "issues" | "pull requests",
	query: string,
	repo: string | undefined,
	items: GhSearchResult[],
): string {
	const lines: string[] = [`# GitHub ${kind === "issues" ? "Issue" : "Pull Request"} 搜索`, "", `查询: ${query}`];
	pushLine(lines, "仓库", repo);
	pushLine(lines, "结果数", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push(`未找到任何${kind === "issues" ? "Issue" : "Pull Request"}。`);
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- #${item.number ?? "?"} ${item.title ?? "无标题"}`);
		pushLine(lines, "  仓库", item.repository?.nameWithOwner);
		pushLine(lines, "  状态", item.state);
		pushLine(lines, "  作者", formatAuthor(item.author));
		pushLine(lines, "  标签", formatLabels(item.labels));
		pushLine(lines, "  创建时间", item.createdAt);
		pushLine(lines, "  更新时间", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchCodeResults(query: string, repo: string | undefined, items: GhSearchCodeResult[]): string {
	const lines: string[] = [`# GitHub 代码搜索`, "", `查询: ${query}`];
	pushLine(lines, "仓库", repo);
	pushLine(lines, "结果数", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("未找到匹配的代码。");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.path ?? "(未知路径)"}`);
		pushLine(lines, "  仓库", item.repository?.nameWithOwner);
		pushLine(lines, "  提交", formatShortSha(item.sha));
		pushLine(lines, "  URL", item.url);
		const fragment = item.textMatches?.find(match => match.fragment)?.fragment;
		if (fragment) {
			pushLine(lines, "  匹配", normalizeText(fragment).split("\n", 1)[0]);
		}
	}

	return lines.join("\n").trim();
}

function formatSearchCommitMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const firstLine = normalizeText(message).split("\n", 1)[0];
	return firstLine || undefined;
}

function formatSearchCommitsResults(query: string, repo: string | undefined, items: GhSearchCommitResult[]): string {
	const lines: string[] = [`# GitHub 提交搜索`, "", `查询: ${query}`];
	pushLine(lines, "仓库", repo);
	pushLine(lines, "结果数", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("未找到任何提交。");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		const sha = formatShortSha(item.sha) ?? "(未知 SHA)";
		const subject = formatSearchCommitMessage(item.commit?.message) ?? "(无提交信息)";
		lines.push(`- ${sha} ${subject}`);
		pushLine(lines, "  仓库", item.repository?.nameWithOwner);
		pushLine(lines, "  作者", formatAuthor(item.author) ?? item.commit?.author?.name);
		pushLine(lines, "  日期", item.commit?.author?.date ?? item.commit?.committer?.date);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchReposResults(query: string, items: GhSearchRepoResult[]): string {
	const lines: string[] = [`# GitHub 仓库搜索`, "", `查询: ${query}`];
	pushLine(lines, "结果数", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("未找到任何仓库。");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.fullName ?? "(未知仓库)"}`);
		const description = normalizeText(item.description).split("\n", 1)[0];
		if (description) {
			pushLine(lines, "  描述", description);
		}
		pushLine(lines, "  语言", item.language ?? undefined);
		pushLine(lines, "  星标", item.stargazersCount);
		pushLine(lines, "  Fork 数", item.forksCount);
		pushLine(lines, "  打开的 Issue", item.openIssuesCount);
		pushLine(lines, "  可见性", item.visibility ?? undefined);
		pushLine(lines, "  已归档", item.isArchived);
		pushLine(lines, "  Fork", item.isFork);
		pushLine(lines, "  更新时间", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

async function saveArtifactText(session: ToolSession, toolType: string, text: string): Promise<string | undefined> {
	const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.(toolType)) ?? {};
	if (!artifactPath || !artifactId) {
		return undefined;
	}

	await Bun.write(artifactPath, text);
	return artifactId;
}

function appendArtifactReference(text: string, artifactId: string | undefined, label: string): string {
	if (!artifactId) {
		return text;
	}

	return `${text}\n\n${label}: artifact://${artifactId}`;
}

function buildTextResult(
	text: string,
	sourceUrl?: string,
	details?: GhToolDetails,
	options?: { artifactId?: string; artifactLabel?: string; useless?: boolean },
): AgentToolResult<GhToolDetails> {
	const builder = toolResult<GhToolDetails>(details).text(
		appendArtifactReference(text, options?.artifactId, options?.artifactLabel ?? "已保存产物"),
	);
	if (sourceUrl) {
		builder.sourceUrl(sourceUrl);
	}
	if (options?.useless) {
		builder.useless();
	}
	return builder.done();
}

export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<GithubInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITHUB_READONLY_OPS.has(op) ? "read" : "exec";
	};
	readonly summary = "Interact with GitHub repositories, files, pull requests, and Actions";
	readonly loadMode = "discoverable";
	readonly label = "GitHub";
	readonly description = prompt.render(githubDescription);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!git.github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "file_read":
					return executeFileRead(this.session, params, signal);
				case "pr_create":
					return executePrCreate(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "search_code":
					return executeSearchCode(this.session, params, signal);
				case "search_commits":
					return executeSearchCommits(this.session, params, signal);
				case "search_repos":
					return executeSearchRepos(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		});
	}
}

async function executeRepoView(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const branch = normalizeOptionalString(params.branch);
	const args = ["repo", "view"];
	if (repo) {
		args.push(repo);
	}
	if (branch) {
		args.push("--branch", branch);
	}
	args.push("--json", GH_REPO_FIELDS.join(","));

	const data = await git.github.json<GhRepoViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	return buildTextResult(formatRepoView(data, { repo, branch }), data.url);
}

async function executeFileRead(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = await resolveGitHubRepo(session.cwd, normalizeOptionalString(params.repo), undefined, signal);
	const filePath = requireNonEmpty(normalizeOptionalString(params.path), "path");
	if (filePath.startsWith("/")) {
		throw new ToolError("path 必须是仓库内相对路径");
	}
	const branch = normalizeOptionalString(params.branch);
	const endpointPath = filePath
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
	const args = [
		"api",
		`/repos/${repo}/contents/${endpointPath}`,
		"--method",
		"GET",
		"-H",
		"Accept: application/vnd.github.raw+json",
	];
	if (branch) {
		args.push("-f", `ref=${branch}`);
	}
	const text = await git.github.text(session.cwd, args, signal, {
		repoProvided: true,
		trimOutput: false,
	});
	const sourceUrl = `https://github.com/${repo}/blob/${encodeURIComponent(branch ?? "HEAD")}/${endpointPath}`;
	return buildTextResult(text, sourceUrl, { repo, branch });
}

// ────────────────────────────────────────────────────────────────────────────
// Cached issue/PR view fetchers
//
// Used by `executeIssueView`/`executePrView` and by the `issue://` / `pr://`
// internal-URL protocol handlers. The cache wrapper lives in `./github-cache`;
// the fresh fetchers stay here to share the existing formatter helpers.
// ────────────────────────────────────────────────────────────────────────────

export interface IssueViewLookupOptions {
	cwd: string;
	repo?: string;
	/** Issue number or GitHub issue URL. */
	issue: string;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface PrViewLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	includeComments?: boolean;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}

export interface ViewLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

async function fetchIssueViewFresh(
	cwd: string,
	repo: string | undefined,
	identifier: string,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhIssueViewData }> {
	const args = ["issue", "view", identifier];
	appendRepoFlag(args, repo, identifier);
	args.push("--json", (includeComments ? GH_ISSUE_FIELDS : GH_ISSUE_FIELDS_NO_COMMENTS).join(","));
	const data = await githubIssueJsonWithStateReasonFallback<GhIssueViewData>(cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const rendered = formatIssueView(data, { issue: identifier, repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

async function fetchPrViewFresh(
	cwd: string,
	repo: string,
	number: number,
	includeComments: boolean,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: GhPrViewData }> {
	const args = ["pr", "view", String(number)];
	appendRepoFlag(args, repo, String(number));
	args.push("--json", (includeComments ? GH_PR_FIELDS : GH_PR_FIELDS_NO_COMMENTS).join(","));
	const data = await git.github.json<GhPrViewData>(cwd, args, signal, { repoProvided: true });
	if (includeComments && typeof data.number === "number") {
		data.reviewComments = await fetchPrReviewComments(cwd, repo, data.number, signal);
	}
	const rendered = formatPrView(data, { pr: String(number), repo, comments: includeComments });
	return { rendered, sourceUrl: data.url, payload: data };
}

/**
 * Cache-aware issue/view fetcher. Used by both the `github` tool op and the
 * `issue://` protocol handler so a single shared row services both surfaces.
 */
export async function getOrFetchIssue(options: IssueViewLookupOptions): Promise<ViewLookupResult<GhIssueViewData>> {
	const identifier = requireNonEmpty(options.issue, "issue");
	if (identifier.startsWith("-")) {
		throw new ToolError(`无效的 Issue 标识:${identifier}。请传入 Issue 编号或 URL。`);
	}
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const urlParse = parseIssueUrl(identifier);
	// Prefer the URL's repo when the identifier is a full URL; fall back to the
	// explicit `repo` option, then to the cwd's default repo.
	let repo = urlParse.repo ?? normalizeOptionalString(options.repo);
	let cacheNumber = urlParse.issueNumber;
	if (cacheNumber === undefined) {
		cacheNumber = parsePositiveDecimalInt(identifier);
	}
	if (cacheNumber !== undefined && !repo) {
		try {
			repo = await resolveDefaultRepoMemoized(options.cwd, options.signal);
		} catch {
			// Resolution failure leaves `repo` undefined: we'll fall through to a
			// direct fetch below so gh produces its own error message instead of
			// us masking it with a friendlier one.
			repo = undefined;
		}
	}

	const doFetch = () => fetchIssueViewFresh(options.cwd, repo, identifier, includeComments, options.signal);

	if (!repo || cacheNumber === undefined) {
		const fresh = await doFetch();
		return { ...fresh, status: "miss", fetchedAt: Date.now() };
	}

	const lookup = await getOrFetchView<GhIssueViewData>({
		repo,
		kind: "issue",
		number: cacheNumber,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

/**
 * Cache-aware PR view fetcher. Caller must supply a numeric PR number;
 * branch-name / current-branch lookups bypass the cache entirely upstream
 * (see `executePrView`).
 */
export async function getOrFetchPr(options: PrViewLookupOptions): Promise<ViewLookupResult<GhPrViewData>> {
	const includeComments = options.includeComments ?? true;
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrViewFresh(options.cwd, options.repo, options.number, includeComments, options.signal);
	const lookup = await getOrFetchView<GhPrViewData>({
		repo: options.repo,
		kind: "pr",
		number: options.number,
		includeComments,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: lookup.payload,
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// PR diff fetcher
//
// Used by the `pr://<n>/diff[/…]` internal-URL family. Stores the verbatim
// `gh pr diff` text plus a parsed file index so the listing, full-diff, and
// per-file slice variants all share one cache row.
// ────────────────────────────────────────────────────────────────────────────

export interface PrDiffFile {
	/** Display path. Prefers the post-image (`b/<path>`) when present. */
	path: string;
	additions: number;
	deletions: number;
	changeType: "modified" | "added" | "deleted" | "renamed" | "binary";
	/** Pre-image path for renames/deletes; same as `path` otherwise. */
	oldPath?: string;
	/** Byte offset of the section's `diff --git` line in the unified diff. */
	startOffset: number;
	/** Byte offset of the next section (or end-of-text). */
	endOffset: number;
}

export interface PrDiffPayload {
	/** Full unified diff text as returned by `gh pr diff --color never`. */
	unified: string;
	files: PrDiffFile[];
}

export interface PrDiffLookupOptions {
	cwd: string;
	repo: string;
	number: number;
	signal?: AbortSignal;
	settings?: Settings;
	cacheAuthKey?: string | null;
}
/**
 * Split `gh pr diff` output on `^diff --git ` boundaries and parse per-file
 * metadata. The unified diff is preserved verbatim so callers can slice it by
 * byte offsets without re-running gh.
 */
export function parsePrUnifiedDiff(text: string): PrDiffPayload {
	const files: PrDiffFile[] = [];
	if (text.length === 0) {
		return { unified: text, files };
	}

	// Walk match positions manually so we capture each section's byte range.
	const sectionStarts: number[] = [];
	const re = /^diff --git /gm;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		sectionStarts.push(m.index);
		// Avoid zero-length match infinite loop (regex has fixed prefix, but
		// be explicit).
		if (re.lastIndex === m.index) re.lastIndex += 1;
		m = re.exec(text);
	}

	for (let i = 0; i < sectionStarts.length; i += 1) {
		const startOffset = sectionStarts[i] ?? 0;
		const endOffset = sectionStarts[i + 1] ?? text.length;
		const section = text.slice(startOffset, endOffset);
		files.push(parsePrDiffSection(section, startOffset, endOffset));
	}
	return { unified: text, files };
}

interface ParsedDiffHeaderToken {
	value: string;
	nextIndex: number;
}

function skipDiffHeaderSpaces(text: string, index: number): number {
	let i = index;
	while (text.charAt(i) === " ") i += 1;
	return i;
}

function parseDiffQuotedEscape(text: string, slashIndex: number): ParsedDiffHeaderToken {
	const next = text.charAt(slashIndex + 1);
	if (next === "") return { value: "\\", nextIndex: slashIndex + 1 };

	if (next >= "0" && next <= "7") {
		let end = slashIndex + 1;
		while (end < text.length && end < slashIndex + 4) {
			const digit = text.charAt(end);
			if (digit < "0" || digit > "7") break;
			end += 1;
		}
		return {
			value: String.fromCharCode(Number.parseInt(text.slice(slashIndex + 1, end), 8)),
			nextIndex: end,
		};
	}

	switch (next) {
		case "a":
			return { value: "\x07", nextIndex: slashIndex + 2 };
		case "b":
			return { value: "\b", nextIndex: slashIndex + 2 };
		case "f":
			return { value: "\f", nextIndex: slashIndex + 2 };
		case "n":
			return { value: "\n", nextIndex: slashIndex + 2 };
		case "r":
			return { value: "\r", nextIndex: slashIndex + 2 };
		case "t":
			return { value: "\t", nextIndex: slashIndex + 2 };
		case "v":
			return { value: "\v", nextIndex: slashIndex + 2 };
		case "\\":
		case '"':
			return { value: next, nextIndex: slashIndex + 2 };
		default:
			return { value: next, nextIndex: slashIndex + 2 };
	}
}

function parseDiffQuotedToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	if (text.charAt(startIndex) !== '"') return undefined;
	let value = "";
	for (let i = startIndex + 1; i < text.length; i += 1) {
		const ch = text.charAt(i);
		if (ch === '"') return { value, nextIndex: i + 1 };
		if (ch !== "\\") {
			value += ch;
			continue;
		}
		const escaped = parseDiffQuotedEscape(text, i);
		value += escaped.value;
		i = escaped.nextIndex - 1;
	}
	return undefined;
}

function parseDiffHeaderToken(text: string, startIndex: number): ParsedDiffHeaderToken | undefined {
	const start = skipDiffHeaderSpaces(text, startIndex);
	if (start >= text.length) return undefined;
	const quoted = parseDiffQuotedToken(text, start);
	if (quoted) return quoted;
	const end = text.indexOf(" ", start);
	if (end === -1) return { value: text.slice(start), nextIndex: text.length };
	return { value: text.slice(start, end), nextIndex: end };
}

function stripPrDiffPathPrefix(value: string, prefix: "a/" | "b/"): string | undefined {
	return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function parsePrDiffHeaderPaths(header: string): { oldPath?: string; newPath?: string } {
	const trail = header.slice("diff --git ".length);
	if (trail.startsWith('"')) {
		const oldToken = parseDiffQuotedToken(trail, 0);
		if (!oldToken) return {};
		const newToken = parseDiffHeaderToken(trail, oldToken.nextIndex);
		if (!newToken) return {};
		return {
			oldPath: stripPrDiffPathPrefix(oldToken.value, "a/"),
			newPath: stripPrDiffPathPrefix(newToken.value, "b/"),
		};
	}

	const bIdx = trail.indexOf(" b/");
	if (trail.startsWith("a/") && bIdx > 0) {
		return {
			oldPath: trail.slice(2, bIdx),
			newPath: trail.slice(bIdx + 3),
		};
	}
	return {};
}

function isPrDiffFileHeaderLine(line: string): boolean {
	return (
		line === "--- /dev/null" ||
		line === "+++ /dev/null" ||
		line.startsWith("--- a/") ||
		line.startsWith("+++ b/") ||
		line.startsWith('--- "a/') ||
		line.startsWith('+++ "b/')
	);
}

function parsePrDiffSection(section: string, startOffset: number, endOffset: number): PrDiffFile {
	const lines = section.split("\n");
	const header = lines[0] ?? "";
	const headerPaths = parsePrDiffHeaderPaths(header);
	let oldPath = headerPaths.oldPath;
	let newPath = headerPaths.newPath;

	let changeType: PrDiffFile["changeType"] = "modified";
	let isBinary = false;
	let additions = 0;
	let deletions = 0;

	let inHunk = false;
	for (let li = 1; li < lines.length; li += 1) {
		const line = lines[li] ?? "";
		if (line.startsWith("new file mode")) {
			changeType = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			changeType = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			changeType = "renamed";
			oldPath = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("rename to ")) {
			newPath = line.slice("rename to ".length);
			continue;
		}
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			isBinary = true;
			continue;
		}
		if (line.startsWith("@@ ")) {
			inHunk = true;
			continue;
		}
		if (!inHunk && isPrDiffFileHeaderLine(line)) continue;
		if (line.startsWith("+")) {
			additions += 1;
		} else if (line.startsWith("-")) {
			deletions += 1;
		}
	}

	if (isBinary) {
		if (changeType === "modified") changeType = "binary";
		additions = 0;
		deletions = 0;
	}

	const displayPath =
		changeType === "deleted" ? (oldPath ?? newPath ?? "(unknown)") : (newPath ?? oldPath ?? "(unknown)");
	const file: PrDiffFile = {
		path: displayPath,
		additions,
		deletions,
		changeType,
		startOffset,
		endOffset,
	};
	if (oldPath && oldPath !== displayPath) {
		file.oldPath = oldPath;
	}
	return file;
}

/**
 * A single entry from `GET /repos/{owner}/{repo}/pulls/{n}/files`. `patch` is
 * absent for binary files and for individual file diffs GitHub deems too large
 * to render.
 */
interface GhPrFileApi {
	filename?: string;
	previous_filename?: string;
	status?: string;
	additions?: number;
	deletions?: number;
	patch?: string;
}

interface GhPrApi {
	changed_files?: number;
}

/**
 * GitHub rejects the aggregate PR diff endpoint with HTTP 406 once the diff
 * exceeds 20,000 lines. Detect that specific failure so the caller can fall
 * back to the per-file endpoint instead of aborting the whole review.
 */
function isPrDiffTooLargeError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return (
		/\bHTTP 406\b/.test(message) ||
		/exceeded the maximum number of lines/i.test(message) ||
		/\btoo_large\b/.test(message)
	);
}

function formatSyntheticDiffPath(prefix: "a/" | "b/", path: string): string {
	const prefixedPath = `${prefix}${path}`;
	if (!/[\u0000-\u001F\s"\\]/.test(prefixedPath)) return prefixedPath;

	let escaped = "";
	for (const char of prefixedPath) {
		switch (char) {
			case "\\":
				escaped += "\\\\";
				break;
			case '"':
				escaped += '\\"';
				break;
			case "\n":
				escaped += "\\n";
				break;
			case "\r":
				escaped += "\\r";
				break;
			case "\t":
				escaped += "\\t";
				break;
			default: {
				const code = char.charCodeAt(0);
				escaped += code < 32 ? `\\${code.toString(8).padStart(3, "0")}` : char;
			}
		}
	}
	return `"${escaped}"`;
}

/**
 * Reconstruct a `diff --git` section from a single files-API entry. The API's
 * `patch` field carries only the hunk body, so the `diff --git`/`---`/`+++`
 * headers are synthesized to match `gh pr diff` output — this keeps
 * {@link parsePrUnifiedDiff} and the review parser producing identical section
 * boundaries and byte offsets. Files whose `patch` is omitted (binary or
 * too-large) stay visible with an explicit marker rather than being dropped.
 */
function buildSyntheticDiffSection(file: GhPrFileApi): string | undefined {
	const newPath = file.filename;
	if (!newPath) return undefined;
	const status = file.status ?? "modified";
	const oldPath = file.previous_filename ?? newPath;
	const oldDiffPath = formatSyntheticDiffPath("a/", oldPath);
	const newDiffPath = formatSyntheticDiffPath("b/", newPath);
	const lines: string[] = [`diff --git ${oldDiffPath} ${newDiffPath}`];
	if (status === "added") {
		lines.push("new file mode 100644");
	} else if (status === "removed") {
		lines.push("deleted file mode 100644");
	} else if (status === "renamed" || file.previous_filename) {
		lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
	}
	if (typeof file.patch === "string" && file.patch.length > 0) {
		lines.push(status === "added" ? "--- /dev/null" : `--- ${oldDiffPath}`);
		lines.push(status === "removed" ? "+++ /dev/null" : `+++ ${newDiffPath}`);
		lines.push(file.patch);
	} else {
		lines.push(
			`* patch unavailable (binary or too large); additions ${file.additions ?? 0}, deletions ${file.deletions ?? 0}`,
		);
	}
	return lines.join("\n");
}

/**
 * Fallback PR diff retrieval via the paginated per-file endpoint, used when the
 * aggregate `gh pr diff` is rejected for exceeding GitHub's 20,000-line limit.
 * The per-file patches are not subject to that aggregate cap, so even very
 * large PRs can be reassembled into a synthetic unified diff.
 */
async function fetchPrDiffViaFilesApi(
	cwd: string,
	repo: string,
	number: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const pull = await git.github.json<GhPrApi>(
		cwd,
		["api", "--method", "GET", `/repos/${repo}/pulls/${number}`],
		signal,
		{ repoProvided: true },
	);
	if ((pull.changed_files ?? 0) > PR_DIFF_FILES_MAX) {
		throw new ToolError(
			`Pull Request 更改了 ${pull.changed_files} 个文件,超出 per-file diff API 的 ${PR_DIFF_FILES_MAX} 个文件上限。`,
		);
	}

	const sections: string[] = [];
	let page = 1;
	while (true) {
		const response = await git.github.json<GhPrFileApi[]>(
			cwd,
			[
				"api",
				"--method",
				"GET",
				`/repos/${repo}/pulls/${number}/files`,
				"-F",
				`per_page=${PR_DIFF_FILES_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);
		for (const file of response) {
			const section = buildSyntheticDiffSection(file);
			if (section) sections.push(section);
		}
		if (response.length < PR_DIFF_FILES_PAGE_SIZE) {
			break;
		}
		page += 1;
	}
	// Trailing newline mirrors `gh pr diff` so downstream parsers splitting on
	// `^diff --git ` see identical boundaries.
	return sections.length > 0 ? `${sections.join("\n")}\n` : "";
}

async function fetchPrDiffFresh(
	cwd: string,
	repo: string,
	number: number,
	signal: AbortSignal | undefined,
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	const args = ["pr", "diff", String(number), "--color", "never"];
	appendRepoFlag(args, repo, String(number));
	let text: string;
	try {
		text = await git.github.text(cwd, args, signal, { repoProvided: true, trimOutput: false });
	} catch (err) {
		if (!isPrDiffTooLargeError(err)) throw err;
		logger.debug("gh pr diff exceeded GitHub's aggregate line limit; falling back to per-file API", {
			repo,
			number,
			err: String(err),
		});
		text = await fetchPrDiffViaFilesApi(cwd, repo, number, signal);
	}
	const payload = parsePrUnifiedDiff(text);
	// `rendered` already carries the verbatim diff; blank the payload copy so
	// the cache row stores a potentially huge diff once instead of twice.
	// `getOrFetchPrDiff` rehydrates `unified` from `rendered`.
	return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
}

/**
 * Cache-aware PR diff fetcher. Stores the full unified diff plus a parsed
 * file index in a single `pr-diff` cache row so the listing, full-diff, and
 * per-file slice variants of `pr://<n>/diff` share one `gh pr diff`
 * invocation.
 */
export async function getOrFetchPrDiff(options: PrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const authKey = options.cacheAuthKey === undefined ? (resolveGithubCacheAuthKey() ?? null) : options.cacheAuthKey;
	const doFetch = () => fetchPrDiffFresh(options.cwd, options.repo, options.number, options.signal);
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.repo,
		kind: "pr-diff",
		number: options.number,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: doFetch,
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		// Rehydrate the unified text from `rendered` (stored once per row).
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}

function joinSections(sections: string[]): string[] {
	return sections.flatMap((section, idx) => (idx === 0 ? [section] : ["", "---", "", section]));
}

async function executePrCheckout(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const force = params.force ?? false;
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs = prList.length > 0 ? prList : [undefined];
	const isMulti = prRefs.length > 1;

	const settled = await Promise.allSettled(
		prRefs.map(prRef => checkoutPullRequest(session, signal, { prRef, repo, force })),
	);
	const outcomes: PrCheckoutOutcome[] = [];
	const failures: Array<{ prRef: string | undefined; reason: unknown }> = [];
	for (let i = 0; i < settled.length; i++) {
		const entry = settled[i];
		if (entry.status === "fulfilled") outcomes.push(entry.value);
		else failures.push({ prRef: prRefs[i], reason: entry.reason });
	}
	if (failures.length > 0) {
		throwIfAborted(signal);
		const failureLines = failures.map(
			f => `- ${f.prRef ?? "(当前分支)"}: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`,
		);
		if (outcomes.length === 0) {
			if (failures.length === 1) throw failures[0].reason;
			throw new ToolError(`全部 ${failures.length} 个 PR 检出失败:\n${failureLines.join("\n")}`);
		}
		// Partial success: report the worktrees that did get created alongside
		// the failures so the agent does not lose track of them.
		const sections = outcomes.map(formatPrCheckoutResult);
		const header = `# 已检出 ${outcomes.length}/${settled.length} 个 Pull Request 工作树(${failures.length} 个失败)`;
		const text = [header, "", ...joinSections(sections), "", "## 失败", ...failureLines].join("\n").trim();
		return buildTextResult(text, undefined, {
			repo,
			checkouts: outcomes.map(outcomeToSummary),
		});
	}

	if (!isMulti) {
		const [outcome] = outcomes;
		return buildTextResult(formatPrCheckoutResult(outcome), outcome.data.url, {
			repo: repo ?? outcome.data.headRepository?.nameWithOwner,
			branch: outcome.localBranch,
			worktreePath: outcome.worktreePath,
			remote: outcome.remoteName,
			remoteBranch: outcome.headRefName,
			checkouts: [outcomeToSummary(outcome)],
		});
	}

	const sections = outcomes.map(formatPrCheckoutResult);
	const reusedCount = outcomes.reduce((acc, o) => acc + (o.reused ? 1 : 0), 0);
	const newCount = outcomes.length - reusedCount;
	const headerParts: string[] = [];
	if (newCount > 0) headerParts.push(`${newCount} 个已检出`);
	if (reusedCount > 0) headerParts.push(`${reusedCount} 个已复用`);
	const header = `# ${outcomes.length} 个 Pull Request 工作树(${headerParts.join(", ")})`;
	const text = [header, "", ...joinSections(sections)].join("\n").trim();

	return buildTextResult(text, undefined, {
		repo,
		checkouts: outcomes.map(outcomeToSummary),
	});
}

interface PrCheckoutOptions {
	prRef: string | undefined;
	repo: string | undefined;
	force: boolean;
}

interface PrCheckoutOutcome {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	headRefName: string;
	reused: boolean;
}

async function checkoutPullRequest(
	session: ToolSession,
	signal: AbortSignal | undefined,
	options: PrCheckoutOptions,
): Promise<PrCheckoutOutcome> {
	const { prRef, repo, force } = options;
	if (prRef?.startsWith("-")) {
		throw new ToolError(`无效的 PR 标识:${prRef}。请传入 PR 编号、URL 或分支名。`);
	}
	const args = ["pr", "view"];
	if (prRef) args.push(prRef);
	appendRepoFlag(args, repo, prRef);
	args.push("--json", GH_PR_CHECKOUT_FIELDS.join(","));

	const data = await git.github.json<GhPrViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const prNumber = data.number;
	if (typeof prNumber !== "number") {
		throw new ToolError("GitHub CLI 未返回 Pull Request 编号。");
	}

	const headRefName = requireNonEmpty(data.headRefName, "head 分支");
	const headRefOid = requireNonEmpty(data.headRefOid, "head 提交");
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const primaryRepoRoot = await requirePrimaryGitRepoRoot(repoRoot, signal);
	const localBranch = `pr-${prNumber}`;
	const worktreePath = getWorktreeDir(`${prNumber}-${hashPath(primaryRepoRoot)}`);

	// Every git mutation against `repoRoot` from here on must run under the
	// per-repo lock. Worktrees of the same primary repo share `.git/config`,
	// `commit-graph` chain, `packed-refs`, and worktree metadata files — git
	// uses O_EXCL lock files for each, with no waiter. Concurrent in-process
	// callers (e.g. parallel `pr_checkout` calls) would otherwise lose lock
	// races and surface "could not lock config file" / "Another git process
	// seems to be running" errors. The gh API call above stays outside the
	// lock so multiple checkouts can fetch PR metadata in parallel.
	return git.withRepoLock(
		repoRoot,
		async () => {
			const existingWorktrees = await git.worktree.list(repoRoot, signal);
			const existingWorktree = existingWorktrees.find(entry => entry.branch === toLocalBranchRef(localBranch));

			const remote = await ensurePrRemote(repoRoot, data, signal);
			await git.fetch(
				repoRoot,
				remote.name,
				`refs/heads/${headRefName}`,
				`refs/remotes/${remote.name}/${headRefName}`,
				{ signal },
			);

			if (!existingWorktree) {
				const localBranchRef = toLocalBranchRef(localBranch);
				const localBranchExists = await git.ref.exists(repoRoot, localBranchRef, signal);
				if (localBranchExists) {
					const existingOid = await git.ref.resolve(repoRoot, localBranchRef, signal);
					if (existingOid !== headRefOid) {
						if (!force) {
							throw new ToolError(
								`本地分支 ${localBranch} 已存在于 ${formatShortSha(existingOid ?? undefined) ?? existingOid ?? "未知提交"};请传入 force=true 以重置`,
							);
						}

						await git.branch.force(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
					}
				} else {
					await git.branch.create(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
				}
			}

			await git.config.setBranch(repoRoot, localBranch, "remote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "merge", `refs/heads/${headRefName}`, signal);
			await git.config.setBranch(repoRoot, localBranch, "pushRemote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrHeadRef", headRefName, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrUrl", data.url ?? "", signal);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrIsCrossRepository",
				String(Boolean(data.isCrossRepository)),
				signal,
			);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrMaintainerCanModify",
				String(Boolean(data.maintainerCanModify)),
				signal,
			);

			let finalWorktreePath = existingWorktree?.path ?? worktreePath;
			if (!existingWorktree) {
				finalWorktreePath = await resolveAvailableWorktreePath(worktreePath, existingWorktrees);
				await fs.mkdir(path.dirname(finalWorktreePath), { recursive: true });
				await git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal });
			}
			const resolvedWorktreePath = await fs.realpath(finalWorktreePath);

			return {
				data,
				localBranch,
				worktreePath: resolvedWorktreePath,
				remoteName: remote.name,
				remoteUrl: remote.url,
				headRefName,
				reused: Boolean(existingWorktree),
			};
		},
		signal,
	);
}

function outcomeToSummary(outcome: PrCheckoutOutcome): GhPrCheckoutSummary {
	return {
		prNumber: typeof outcome.data.number === "number" ? outcome.data.number : undefined,
		url: outcome.data.url ?? undefined,
		branch: outcome.localBranch,
		worktreePath: outcome.worktreePath,
		remote: outcome.remoteName,
		remoteBranch: outcome.headRefName,
		reused: outcome.reused,
	};
}

async function executePrPush(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const localBranch = normalizeOptionalString(params.branch) ?? (await requireCurrentGitBranch(repoRoot, signal));
	const refExists = await git.ref.exists(repoRoot, toLocalBranchRef(localBranch), signal);
	if (!refExists) {
		throw new ToolError(`本地分支 ${localBranch} 不存在`);
	}

	const target = await resolvePrBranchPushTarget(repoRoot, localBranch, signal);
	const currentBranch = await git.branch.current(repoRoot, signal);
	const sourceRef = currentBranch === localBranch ? "HEAD" : toLocalBranchRef(localBranch);
	const refspec = `${sourceRef}:refs/heads/${target.remoteBranch}`;
	await git.push(repoRoot, {
		forceWithLease: params.forceWithLease,
		refspec,
		remote: target.remoteName,
		signal,
	});

	// A successful push changes what `pr://N` and `pr://N/diff` should show;
	// drop the cached rows so the canonical "push → re-read diff" flow sees
	// fresh data instead of a soft-TTL stale snapshot.
	const pushedPr = parsePullRequestUrl(target.prUrl);
	if (pushedPr.prNumber !== undefined) {
		invalidateAllForNumber(pushedPr.prNumber, pushedPr.repo);
	}

	return buildTextResult(
		formatPrPushResult({
			localBranch,
			remoteName: target.remoteName,
			remoteBranch: target.remoteBranch,
			remoteUrl: target.remoteUrl,
			prUrl: target.prUrl,
			forceWithLease: params.forceWithLease ?? false,
		}),
		target.prUrl,
		{
			branch: localBranch,
			remote: target.remoteName,
			remoteBranch: target.remoteBranch,
		},
	);
}

async function executePrCreate(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const title = normalizeOptionalString(params.title);
	const body = params.body;
	const base = normalizeOptionalString(params.base);
	const head = normalizeOptionalString(params.head);
	const draft = params.draft ?? false;
	const fill = params.fill ?? false;
	const reviewers = normalizePrIdentifierList(params.reviewer);
	const assignees = normalizePrIdentifierList(params.assignee);
	const labels = normalizePrIdentifierList(params.label);

	if (!fill && !title) {
		throw new ToolError("除非 fill 为 true,否则必须提供 title");
	}
	if (fill && (title || body !== undefined)) {
		throw new ToolError("fill 与 title、body 互斥");
	}

	const args = ["pr", "create"];
	appendRepoFlag(args, repo);
	if (title) args.push("--title", title);
	if (base) args.push("--base", base);
	if (head) args.push("--head", head);
	if (draft) args.push("--draft");
	if (fill) args.push("--fill");
	for (const reviewer of reviewers) args.push("--reviewer", reviewer);
	for (const assignee of assignees) args.push("--assignee", assignee);
	for (const label of labels) args.push("--label", label);

	let bodyDir: string | undefined;
	try {
		if (!fill) {
			if (body !== undefined && body.length > 0) {
				// Route through a temp file so multi-KB bodies stay clear of any
				// argv-length limits and shell-quoting hazards on uncommon platforms.
				bodyDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-body-"));
				const bodyFile = path.join(bodyDir, "body.md");
				await Bun.write(bodyFile, body);
				args.push("--body-file", bodyFile);
			} else {
				// Avoid gh dropping into an interactive editor when no body is given.
				args.push("--body", "");
			}
		}

		const output = await git.github.text(session.cwd, args, signal, {
			repoProvided: Boolean(repo),
		});
		const url =
			output
				.split("\n")
				.map(line => line.trim())
				.find(line => line.startsWith("https://github.com/")) ?? output.trim();
		const parsed = parsePullRequestUrl(url);
		const resolvedRepo = repo ?? parsed.repo;

		let prView: GhPrViewData | undefined;
		if (resolvedRepo && parsed.prNumber !== undefined) {
			try {
				prView = await git.github.json<GhPrViewData>(
					session.cwd,
					[
						"pr",
						"view",
						String(parsed.prNumber),
						"--repo",
						resolvedRepo,
						"--json",
						GH_PR_FIELDS_NO_COMMENTS.join(","),
					],
					signal,
					{ repoProvided: true },
				);
			} catch {
				// Best-effort summary; PR creation already succeeded.
			}
		}

		const text = formatPrCreateResult({
			url,
			prNumber: parsed.prNumber,
			data: prView,
			title,
			base,
			head,
			draft,
		});
		return buildTextResult(text, url || prView?.url);
	} finally {
		if (bodyDir) {
			await fs.rm(bodyDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

function formatPrCreateResult(options: {
	url: string;
	prNumber?: number;
	data?: GhPrViewData;
	title?: string;
	base?: string;
	head?: string;
	draft?: boolean;
}): string {
	const number = options.prNumber ?? options.data?.number;
	const headerTitle = options.data?.title ?? options.title ?? "无标题";
	const header =
		number !== undefined
			? `# 已创建 Pull Request #${number}: ${headerTitle}`
			: `# 已创建 Pull Request: ${headerTitle}`;
	const lines: string[] = [header, ""];
	pushLine(lines, "URL", options.url || options.data?.url);
	pushLine(lines, "状态", options.data?.state);
	pushLine(lines, "草稿", options.data?.isDraft ?? options.draft);
	pushLine(lines, "基础分支", options.data?.baseRefName ?? options.base);
	pushLine(lines, "头部分支", options.data?.headRefName ?? options.head);
	pushLine(lines, "作者", formatAuthor(options.data?.author));
	pushLine(lines, "创建时间", options.data?.createdAt);
	pushLine(lines, "标签", formatLabels(options.data?.labels));

	const bodyText = normalizeText(options.data?.body);
	if (bodyText) {
		lines.push("");
		lines.push("## 正文");
		lines.push("");
		lines.push(bodyText);
	}

	return lines.join("\n").trim();
}

async function executeSearchIssues(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("issues", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:issue"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("issues", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchPrs(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("prs", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:pr"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("pull requests", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchCode(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	const since = normalizeOptionalString(params.since);
	const until = normalizeOptionalString(params.until);
	if (since !== undefined || until !== undefined) {
		throw new ToolError("search_code 不支持 since/until;GitHub 代码搜索没有日期限定符。");
	}
	const limit = resolveSearchLimit(params.limit);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), query, signal);
	const apiQuery = composeSearchQuery([query, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("code", apiQuery, limit, ["Accept: application/vnd.github.text-match+json"]);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCodeItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCodeToSearchResult);
	return buildTextResult(formatSearchCodeResults(query, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchCommits(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("commits", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("commits", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCommitItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCommitToSearchResult);
	return buildTextResult(formatSearchCommitsResults(displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeSearchRepos(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("repos", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const query = composeSearchQuery([params.query, dateQualifier]);
	const args = buildGhApiSearchArgs("repositories", query, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchRepoItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiRepoToSearchResult);
	return buildTextResult(formatSearchReposResults(query, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

async function executeRunWatch(
	session: ToolSession,
	toolName: string,
	params: GithubInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branchInput = normalizeOptionalString(params.branch);
	const explicitRepo = normalizeOptionalString(params.repo);
	const runReference = parseRunReference(params.run);
	const repo = await resolveGitHubRepo(session.cwd, explicitRepo, runReference.repo, signal);
	const graceSeconds = RUN_WATCH_GRACE_DEFAULT;
	const tail = resolveTailLimit(params.tail);
	const watchStartMs = Date.now();
	// Fast polls for the first minute for snappy feedback, then back off:
	// every commit-watch poll is one runs-list call plus one jobs call per
	// non-completed run, and long builds must not burn the shared
	// authenticated REST quota.
	const currentIntervalSeconds = () =>
		Date.now() - watchStartMs < RUN_WATCH_FAST_WINDOW_MS ? RUN_WATCH_INTERVAL_DEFAULT : RUN_WATCH_INTERVAL_SLOW;
	let consecutivePollFailures = 0;
	const handlePollError = async (err: unknown): Promise<void> => {
		if (signal?.aborted) throw err;
		consecutivePollFailures += 1;
		if (!isRateLimitedGhError(err) || consecutivePollFailures > RUN_WATCH_MAX_POLL_FAILURES) throw err;
		// Rate-limited: back off with the slow interval and retry instead of
		// discarding the whole watch (and its accumulated context).
		await scheduler.wait(RUN_WATCH_INTERVAL_SLOW * 1000, { signal });
	};
	if (runReference.runId !== undefined) {
		const runId = runReference.runId;
		let pollCount = 0;

		while (true) {
			throwIfAborted(signal);
			pollCount += 1;

			let run: GhRunSnapshot;
			try {
				run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
			} catch (err) {
				await handlePollError(err);
				continue;
			}
			consecutivePollFailures = 0;
			const details = buildRunWatchDetails(repo, run, {
				state: "watching",
				pollCount,
			});
			onUpdate?.({
				content: [{ type: "text", text: formatRunWatchSnapshot(repo, run, pollCount) }],
				details,
			});

			let failedJobs = run.jobs.filter(isFailedJob);
			const runCompleted = run.status === "completed";

			if (failedJobs.length > 0) {
				if (!runCompleted && graceSeconds > 0) {
					const note = `检测到失败。等待 ${graceSeconds} 秒以捕获并发失败,再获取日志。`;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: formatRunWatchSnapshot(repo, run, pollCount, note),
							},
						],
						details: buildRunWatchDetails(repo, run, {
							state: "watching",
							pollCount,
							note,
						}),
					});
					await scheduler.wait(graceSeconds * 1000, { signal });
					try {
						const refetched = await fetchRunSnapshot(session.cwd, repo, runId, signal);
						const refetchedFailed = refetched.jobs.filter(isFailedJob);
						// An auto-retry can reset job conclusions between
						// detection and refetch; keep the originally-detected
						// failure list (and its snapshot) when the refetch no
						// longer shows any failures so the watch never ends
						// with a failure result and zero logs.
						if (refetchedFailed.length > 0) {
							run = refetched;
							failedJobs = refetchedFailed;
						}
					} catch (err) {
						if (signal?.aborted) throw err;
						// Refetch failure: report from the original snapshot.
					}
				}

				const failedJobLogs = await fetchFailedJobLogs(
					session.cwd,
					repo,
					failedJobs.map(job => ({ run, job })),
					tail,
					signal,
				);
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
					failedJobLogs,
				});
				const artifactId = await saveArtifactText(
					session,
					toolName,
					formatRunWatchResult(repo, run, failedJobLogs, tail, { mode: "full" }),
				);
				return buildTextResult(
					formatRunWatchResult(repo, run, failedJobLogs, tail),
					run.url,
					{ ...finalDetails, artifactId },
					{ artifactId, artifactLabel: "失败任务完整日志" },
				);
			}

			if (runCompleted) {
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
				});
				return buildTextResult(formatRunWatchResult(repo, run, [], tail), run.url, finalDetails);
			}

			await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
		}
	}

	let branch: string;
	let headSha: string;
	if (branchInput) {
		branch = branchInput;
		headSha = await resolveGitHubBranchHead(session.cwd, repo, branch, signal);
	} else {
		// No branch/run selector — derive the commit from the current checkout,
		// but only when cwd actually points at `repo`. Otherwise we'd watch an
		// unrelated commit SHA against the explicit repo and silently stream a
		// confident wrong-repo status (issue #1949). GitHub `owner/repo` slugs
		// are case-insensitive — `gh repo view` returns the canonical casing
		// while callers may pass any casing — so the equality check normalizes
		// both sides before deciding the cwd is a different repo (PR #1951).
		const cwdRepo = await tryResolveCurrentRepoFresh(session.cwd, signal);
		if (!githubRepoSlugEquals(cwdRepo, repo)) {
			throw new ToolError(
				`无法推断 ${repo} 的被监控提交:当前检出为 ${cwdRepo ?? "非 GitHub 仓库"}。请传入 \`branch\` 或 \`run\` 以限定监控范围。`,
			);
		}
		branch = await requireCurrentGitBranch(session.cwd, signal);
		headSha = await requireCurrentGitHead(session.cwd, signal);
	}
	let pollCount = 0;
	let settledSuccessSignature: string | undefined;
	let everSawRuns = false;
	const completedRunJobsCache = new Map<number, GhRunJobSnapshot[]>();

	while (true) {
		throwIfAborted(signal);
		pollCount += 1;

		let runs: GhRunSnapshot[];
		try {
			runs = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
		} catch (err) {
			await handlePollError(err);
			continue;
		}
		consecutivePollFailures = 0;
		if (runs.length > 0) everSawRuns = true;
		const details = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
			state: "watching",
			pollCount,
		});
		onUpdate?.({
			content: [{ type: "text", text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount) }],
			details,
		});

		const outcome = getRunCollectionOutcome(runs);
		if (outcome === "failure") {
			let failedPairs = runs.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
			if (graceSeconds > 0) {
				const note = `检测到失败。等待 ${graceSeconds} 秒以捕获并发失败,再获取日志。`;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
						},
					],
					details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
						state: "watching",
						pollCount,
						note,
					}),
				});
				await scheduler.wait(graceSeconds * 1000, { signal });
				try {
					const refetched = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
					const refetchedPairs = refetched.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
					// Keep the originally-detected failure list when an
					// auto-retry reset the conclusions during the grace window
					// (see the run-id branch above).
					if (refetchedPairs.length > 0) {
						runs = refetched;
						failedPairs = refetchedPairs;
					}
				} catch (err) {
					if (signal?.aborted) throw err;
					// Refetch failure: report from the original snapshots.
				}
			}

			const failedJobLogs = await fetchFailedJobLogs(session.cwd, repo, failedPairs, tail, signal);
			const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
				state: "completed",
				failedJobLogs,
			});
			const artifactId = await saveArtifactText(
				session,
				toolName,
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail, { mode: "full" }),
			);
			return buildTextResult(
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail),
				undefined,
				{ ...finalDetails, artifactId },
				{ artifactId, artifactLabel: "失败任务完整日志" },
			);
		}

		if (outcome === "success") {
			const signature = getRunCollectionSignature(runs);
			if (signature === settledSuccessSignature) {
				const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "completed",
				});
				return buildTextResult(
					formatCommitRunWatchResult(repo, headSha, branch, runs, [], tail),
					undefined,
					finalDetails,
				);
			}

			settledSuccessSignature = signature;
			const confirmWaitSeconds = currentIntervalSeconds();
			const note = `所有已知工作流运行均已成功完成。等待 ${confirmWaitSeconds} 秒以确认此提交不再出现新的运行。`;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
					},
				],
				details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "watching",
					pollCount,
					note,
				}),
			});
			await scheduler.wait(confirmWaitSeconds * 1000, { signal });
			continue;
		}

		settledSuccessSignature = undefined;
		if (!everSawRuns && Date.now() - watchStartMs >= RUN_WATCH_NO_RUNS_GIVE_UP_MS) {
			// A repo with no Actions configured (or Actions disabled) never
			// produces a run for this commit; give up with a clear message
			// instead of polling forever.
			const elapsedSec = Math.round((Date.now() - watchStartMs) / 1000);
			return buildTextResult(
				`在 ${elapsedSec} 秒(${pollCount} 次轮询)内未找到 ${repo}@${formatShortSha(headSha) ?? headSha} 的工作流运行。此提交可能不会触发任何 GitHub Actions 工作流,或者该仓库已禁用 Actions。请传入 \`run\` 以监控特定运行。`,
				undefined,
				buildCommitRunWatchDetails(repo, headSha, branch, runs, { state: "completed", pollCount }),
				{ useless: true },
			);
		}
		await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
	}
}
