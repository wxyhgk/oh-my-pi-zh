import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import type {
	SecurityAccountRef,
	SecurityKnowledgeBaseRef,
	SecurityModelRef,
	SecurityOutputPlan,
	SecurityScanPlan,
	SecurityTarget,
} from "./contracts";
import { canonicalSecurityJson, createSecurityPlanId, parseSecurityScanPlan } from "./contracts";

export type SecurityTargetRequest =
	| { kind: "repository"; includePaths?: string[]; excludePaths?: string[] }
	| { kind: "scoped_path"; includePaths: string[]; excludePaths?: string[] }
	| { kind: "ref_diff"; baseRevision: string; headRevision: string; includePaths?: string[]; excludePaths?: string[] }
	| { kind: "working_tree"; includePaths?: string[]; excludePaths?: string[] };

export interface SecurityPlanRequest {
	cwd: string;
	target: SecurityTargetRequest;
	knowledgeBasePaths?: string[];
	outputRoot: string;
	archiveExisting?: boolean;
	model: SecurityModelRef;
	account: SecurityAccountRef;
	config: unknown;
	workflowFingerprint: string;
	signal?: AbortSignal;
	createdAt?: string;
}

export interface SecurityPlanFreshnessInput {
	config: unknown;
	workflowFingerprint: string;
	signal?: AbortSignal;
}

export interface SecurityGitAdapter {
	root(cwd: string, signal?: AbortSignal): Promise<string | null>;
	headSha(cwd: string, signal?: AbortSignal): Promise<string | null>;
	resolveRef(cwd: string, refName: string, signal?: AbortSignal): Promise<string | null>;
	diffTree(cwd: string, base: string, head: string, signal?: AbortSignal): Promise<string>;
	status(cwd: string, signal?: AbortSignal): Promise<string>;
	files(cwd: string, signal?: AbortSignal): Promise<string[]>;
	untracked(cwd: string, signal?: AbortSignal): Promise<string[]>;
}

export const DEFAULT_SECURITY_GIT_ADAPTER: SecurityGitAdapter = {
	root: (cwd, signal) => git.repo.root(cwd, signal),
	headSha: (cwd, signal) => git.head.sha(cwd, signal),
	resolveRef: (cwd, refName, signal) => git.ref.resolve(cwd, refName, signal),
	diffTree: (cwd, base, head, signal) => git.diff.tree(cwd, base, head, { signal }),
	status: (cwd, signal) => git.status(cwd, { porcelainV1: true, untrackedFiles: "all", signal }),
	files: (cwd, signal) => git.ls.files(cwd, { signal }),
	untracked: (cwd, signal) => git.ls.untracked(cwd, signal),
};

export class StaleSecurityScanPlanError extends Error {
	constructor(
		readonly expected: string,
		readonly actual: string,
	) {
		super(`安全扫描计划已过期:预期 ${expected},实际 ${actual}。请重新运行安全 preflight。`);
		this.name = "StaleSecurityScanPlanError";
	}
}

function pathIsWithin(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function hashFile(filePath: string): Promise<{ sha256: string; size: number }> {
	const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
	return { sha256: Bun.SHA256.hash(bytes, "hex"), size: bytes.byteLength };
}

function normalizeRelativePath(input: string): string {
	const slashed = input.replaceAll("\\", "/");
	if (slashed.includes("\0")) throw new Error(`安全范围路径包含空字节:${input}`);
	const rawSegments = slashed.split("/");
	const normalized = path.posix.normalize(slashed).replace(/^\.\//, "").replace(/\/$/, "");
	if (!slashed) return "";
	if (normalized === ".") return ".";
	if (
		rawSegments.includes("..") ||
		normalized.startsWith("../") ||
		normalized === ".." ||
		path.posix.isAbsolute(normalized) ||
		/^[a-zA-Z]:/.test(slashed)
	) {
		throw new Error(`安全范围路径必须是仓库相对路径:${input}`);
	}
	return normalized;
}

function normalizeScopePaths(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map(normalizeRelativePath))].sort();
}

function scopeContainsPath(candidate: string, normalizedPath: string): boolean {
	return (
		candidate === "" ||
		candidate === "." ||
		normalizedPath === candidate ||
		normalizedPath.startsWith(`${candidate}/`)
	);
}

export function pathMatchesSecurityScope(
	relativePath: string,
	includePaths: readonly string[],
	excludePaths: readonly string[],
): boolean {
	const normalized = normalizeRelativePath(relativePath);
	const included =
		includePaths.length === 0 || includePaths.some(candidate => scopeContainsPath(candidate, normalized));
	const excluded = excludePaths.some(candidate => scopeContainsPath(candidate, normalized));
	return included && !excluded;
}

async function validateScopePaths(repositoryRoot: string, paths: readonly string[]): Promise<void> {
	for (const relative of paths) {
		if (!relative) continue;
		const absolute = path.resolve(repositoryRoot, relative);
		if (!pathIsWithin(absolute, repositoryRoot)) throw new Error(`安全范围越出了仓库:${relative}`);
		const canonical = await fs.realpath(absolute);
		if (!pathIsWithin(canonical, repositoryRoot)) {
			throw new Error(`安全范围解析到仓库之外:${relative}`);
		}
	}
}

async function digestWorkingTree(
	repositoryRoot: string,
	includePaths: readonly string[],
	excludePaths: readonly string[],
	adapter: SecurityGitAdapter,
	signal?: AbortSignal,
): Promise<string> {
	const tracked = await adapter.files(repositoryRoot, signal);
	const untracked = await adapter.untracked(repositoryRoot, signal);
	const files = [...new Set([...tracked, ...untracked])]
		.map(normalizeRelativePath)
		.filter(candidate => pathMatchesSecurityScope(candidate, includePaths, excludePaths))
		.sort();
	const hasher = new Bun.CryptoHasher("sha256");
	for (const relativePath of files) {
		if (signal?.aborted) throw signal.reason;
		const absolutePath = path.resolve(repositoryRoot, relativePath);
		if (!pathIsWithin(absolutePath, repositoryRoot)) throw new Error(`Git 路径越出了仓库:${relativePath}`);
		const stats = await fs.lstat(absolutePath).catch(() => null);
		hasher.update(relativePath);
		hasher.update("\0");
		if (!stats) {
			hasher.update("missing\0");
			continue;
		}
		hasher.update(`mode:${stats.mode & 0o111}\0`);
		if (stats.isSymbolicLink()) {
			hasher.update("symlink\0");
			hasher.update(await fs.readlink(absolutePath));
		} else if (stats.isFile()) {
			hasher.update(new Uint8Array(await Bun.file(absolutePath).arrayBuffer()));
		} else {
			hasher.update("unsupported\0");
		}
		hasher.update("\0");
	}
	const head = (await adapter.headSha(repositoryRoot, signal)) ?? "unborn";
	hasher.update(head);
	return `omp-security-tree/v1:sha256:${hasher.digest("hex")}`;
}

async function normalizeTarget(
	repositoryRoot: string,
	request: SecurityTargetRequest,
	adapter: SecurityGitAdapter,
	signal?: AbortSignal,
): Promise<SecurityTarget> {
	if (request.kind === "scoped_path" && !request.includePaths?.some(value => value.trim().length > 0)) {
		throw new Error("scoped_path 安全扫描至少需要一个 include 路径");
	}
	const includePaths = normalizeScopePaths(request.includePaths);
	const excludePaths = normalizeScopePaths(request.excludePaths);
	await validateScopePaths(repositoryRoot, includePaths);
	await validateScopePaths(repositoryRoot, excludePaths);
	const displayName = path.basename(repositoryRoot);
	if (request.kind === "ref_diff") {
		const baseRevision = await adapter.resolveRef(repositoryRoot, request.baseRevision, signal);
		const headRevision = await adapter.resolveRef(repositoryRoot, request.headRevision, signal);
		if (!baseRevision) throw new Error(`未知的安全扫描基线版本:${request.baseRevision}`);
		if (!headRevision) throw new Error(`未知的安全扫描目标版本:${request.headRevision}`);
		const rawDiff = await adapter.diffTree(repositoryRoot, baseRevision, headRevision, signal);
		return {
			kind: "ref_diff",
			repositoryRoot,
			displayName,
			baseRevision,
			headRevision,
			includePaths,
			excludePaths,
			treeDigest: `omp-security-diff/v1:sha256:${Bun.SHA256.hash(
				canonicalSecurityJson({ baseRevision, headRevision, includePaths, excludePaths, rawDiff }),
				"hex",
			)}`,
		};
	}
	const revision = await adapter.headSha(repositoryRoot, signal);
	const target: SecurityTarget = {
		kind: request.kind,
		repositoryRoot,
		displayName,
		includePaths,
		excludePaths,
		treeDigest: await digestWorkingTree(repositoryRoot, includePaths, excludePaths, adapter, signal),
	};
	if (revision !== null) target.revision = revision;
	return target;
}

async function normalizeKnowledgeBases(
	paths: readonly string[] | undefined,
	baseDirectory: string,
): Promise<SecurityKnowledgeBaseRef[]> {
	const results: SecurityKnowledgeBaseRef[] = [];
	for (const input of paths ?? []) {
		const canonical = await fs.realpath(path.resolve(baseDirectory, input));
		const stats = await fs.stat(canonical);
		if (!stats.isFile()) throw new Error(`安全知识库不是文件:${input}`);
		const digest = await hashFile(canonical);
		results.push({ path: canonical, sha256: digest.sha256, size: digest.size });
	}
	return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function normalizeOutput(
	repositoryRoot: string,
	outputRoot: string,
	archiveExisting: boolean,
): Promise<SecurityOutputPlan> {
	const requested = path.resolve(outputRoot);
	const parent = await fs.realpath(path.dirname(requested));
	const canonicalCandidate = path.join(parent, path.basename(requested));
	if (pathIsWithin(canonicalCandidate, repositoryRoot)) {
		throw new Error("安全输出目录必须位于被扫描仓库之外");
	}
	let existingState: SecurityOutputPlan["existingState"] = "absent";
	try {
		const stats = await fs.lstat(canonicalCandidate);
		if (stats.isSymbolicLink()) throw new Error("安全输出目录不能是符号链接");
		if (!stats.isDirectory()) throw new Error("安全输出路径已存在且不是目录");
		const real = await fs.realpath(canonicalCandidate);
		if (real !== canonicalCandidate) throw new Error("安全输出目录不具有规范身份");
		const entries = await fs.readdir(canonicalCandidate);
		existingState = entries.length === 0 ? "empty" : "archivable";
		if (entries.length > 0 && !archiveExisting) {
			throw new Error("安全输出目录不为空;请启用 archiveExisting 或选择其他目录");
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		await fs.mkdir(canonicalCandidate, { recursive: false, mode: 0o700 });
		existingState = "empty";
	}
	if (process.platform !== "win32") await fs.chmod(canonicalCandidate, 0o700);
	return { root: canonicalCandidate, archiveExisting, existingState };
}

export interface PreparedSecurityOutput {
	root: string;
	archivedTo?: string;
}

export async function prepareSecurityOutputDirectory(
	output: SecurityOutputPlan,
	archiveSuffix: string = Bun.randomUUIDv7(),
): Promise<PreparedSecurityOutput> {
	const root = path.resolve(output.root);
	const stats = await fs.lstat(root);
	if (stats.isSymbolicLink()) throw new Error("安全输出目录不能是符号链接");
	if (!stats.isDirectory()) throw new Error("安全输出路径已存在且不是目录");
	const canonical = await fs.realpath(root);
	if (canonical !== root) throw new Error("安全输出目录不具有规范身份");
	const entries = await fs.readdir(root);
	let archivedTo: string | undefined;
	if (entries.length > 0) {
		if (!output.archiveExisting) {
			throw new Error("安全输出目录不为空;请启用 archiveExisting 或选择其他目录");
		}
		const safeSuffix = archiveSuffix.replace(/[^a-zA-Z0-9._-]/g, "-");
		archivedTo = `${root}.archive-${safeSuffix}`;
		await fs.rename(root, archivedTo);
		await fs.mkdir(root, { mode: 0o700 });
	}
	if (process.platform !== "win32") await fs.chmod(root, 0o700);
	return { root, archivedTo };
}

interface SecurityPlanMaterial {
	repositoryRoot: string;
	target: SecurityTarget;
	knowledgeBases: SecurityKnowledgeBaseRef[];
	output: SecurityOutputPlan;
	model: SecurityModelRef;
	account: SecurityAccountRef;
	configFingerprint: string;
	workflowFingerprint: string;
}

async function buildPlanMaterial(
	request: SecurityPlanRequest,
	adapter: SecurityGitAdapter,
): Promise<SecurityPlanMaterial> {
	const repositoryRoot = await adapter.root(path.resolve(request.cwd), request.signal);
	if (!repositoryRoot) throw new Error(`安全扫描需要 Git 仓库:${request.cwd}`);
	const canonicalRoot = await fs.realpath(repositoryRoot);
	const target = await normalizeTarget(canonicalRoot, request.target, adapter, request.signal);
	const knowledgeBases = await normalizeKnowledgeBases(request.knowledgeBasePaths, canonicalRoot);
	const output = await normalizeOutput(canonicalRoot, request.outputRoot, request.archiveExisting ?? false);
	const model: SecurityModelRef = {
		provider: request.model.provider,
		modelId: request.model.modelId,
	};
	if (request.model.thinkingLevel !== undefined) model.thinkingLevel = request.model.thinkingLevel;
	const account: SecurityAccountRef = {
		provider: request.account.provider,
		credentialId: request.account.credentialId,
	};
	if (request.account.accountId !== undefined) account.accountId = request.account.accountId;
	if (request.account.email !== undefined) account.email = request.account.email;
	if (request.account.organizationId !== undefined) account.organizationId = request.account.organizationId;
	if (request.account.organizationName !== undefined) account.organizationName = request.account.organizationName;
	return {
		repositoryRoot: canonicalRoot,
		target,
		knowledgeBases,
		output,
		model,
		account,
		configFingerprint: `omp-security-config/v1:sha256:${Bun.SHA256.hash(canonicalSecurityJson(request.config), "hex")}`,
		workflowFingerprint: request.workflowFingerprint,
	};
}

export async function createSecurityScanPlan(
	request: SecurityPlanRequest,
	adapter: SecurityGitAdapter = DEFAULT_SECURITY_GIT_ADAPTER,
): Promise<SecurityScanPlan> {
	const material = await buildPlanMaterial(request, adapter);
	const fingerprint = `omp-security-plan/v1:sha256:${Bun.SHA256.hash(canonicalSecurityJson(material), "hex")}`;
	return parseSecurityScanPlan({
		documentType: "omp-security.scan-plan",
		schemaVersion: "1.0",
		id: createSecurityPlanId(fingerprint),
		createdAt: request.createdAt ?? new Date().toISOString(),
		...material,
		fingerprint,
	});
}

function requestFromPlan(plan: SecurityScanPlan, freshness: SecurityPlanFreshnessInput): SecurityPlanRequest {
	const target: SecurityTargetRequest =
		plan.target.kind === "ref_diff"
			? {
					kind: "ref_diff",
					baseRevision: plan.target.baseRevision ?? "",
					headRevision: plan.target.headRevision ?? "",
					includePaths: plan.target.includePaths,
					excludePaths: plan.target.excludePaths,
				}
			: plan.target.kind === "scoped_path"
				? { kind: "scoped_path", includePaths: plan.target.includePaths, excludePaths: plan.target.excludePaths }
				: plan.target.kind === "working_tree"
					? {
							kind: "working_tree",
							includePaths: plan.target.includePaths,
							excludePaths: plan.target.excludePaths,
						}
					: { kind: "repository", includePaths: plan.target.includePaths, excludePaths: plan.target.excludePaths };
	return {
		cwd: plan.repositoryRoot,
		target,
		knowledgeBasePaths: plan.knowledgeBases.map(item => item.path),
		outputRoot: plan.output.root,
		archiveExisting: plan.output.archiveExisting,
		model: plan.model,
		account: plan.account,
		config: freshness.config,
		workflowFingerprint: freshness.workflowFingerprint,
		signal: freshness.signal,
		createdAt: plan.createdAt,
	};
}

export async function assertSecurityScanPlanFresh(
	plan: SecurityScanPlan,
	freshness: SecurityPlanFreshnessInput,
	adapter: SecurityGitAdapter = DEFAULT_SECURITY_GIT_ADAPTER,
): Promise<void> {
	const current = await createSecurityScanPlan(requestFromPlan(plan, freshness), adapter);
	if (current.fingerprint !== plan.fingerprint) {
		throw new StaleSecurityScanPlanError(plan.fingerprint, current.fingerprint);
	}
}
