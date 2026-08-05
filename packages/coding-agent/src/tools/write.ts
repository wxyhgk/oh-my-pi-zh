import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { formatHashlineHeader, stripHashlinePrefixes } from "@oh-my-pi/hashline";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { isEnoent, isRecord, prompt, untilAborted } from "@oh-my-pi/pi-utils";

import { canonicalSnapshotKey, getFileSnapshotStore } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import { couldBecomeXdUrl, parseXdUrl } from "../internal-urls/xd-protocol";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import { getLanguageFromPath, highlightCode, type Theme } from "../modes/theme/theme";
import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { fileHyperlink, framedBlock, renderStatusLine } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import {
	type ArchiveMemberContent,
	archiveFormatFromPath,
	parseArchivePathCandidates,
	readArchiveEntries,
	writeArchive,
} from "../utils/zip";
import { routeWriteThroughBridge } from "./acp-bridge";
import { resolveToolTier, truncateForPrompt } from "./approval";
import { assertEditableFile } from "./auto-generated-guard";
import {
	type ConflictEntry,
	conflictRegionPresent,
	conflictRegionsEqual,
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { type OutputMeta, outputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	isInternalUrlPath,
	pathTargetsSsh,
	peelWriteUrlSelector,
	probeLiteralPathExists,
	splitPathAndSel,
} from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath, unwrapHashlineHeaderPath } from "./plan-mode-guard";
import {
	cachedRenderedString,
	createRenderedStringCache,
	Ellipsis,
	formatDiagnostics,
	formatErrorDetail,
	formatExpandHint,
	formatStatusIcon,
	getLspBatchRequest,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import { dispatchReportIssueDevice, REPORT_ISSUE_DEVICE_NAME, renderReportIssueDeviceCall } from "./report-tool-issue";
import { dispatchResolutionDevice, isResolutionDeviceName, renderResolutionDeviceCall } from "./resolve";
import {
	deleteRowByKey,
	deleteRowByRowId,
	insertRow,
	isSqliteFile,
	parseSqlitePathCandidates,
	resolveTableRowLookup,
	updateRowByKey,
	updateRowByRowId,
} from "./sqlite-reader";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import {
	dispatchXdevTool,
	renderXdevCall,
	renderXdevResult,
	resolveXdevTool,
	type XdevDispatch,
	xdevListing,
} from "./xdev";

const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;
const EXECUTABLE_NOTICE = "[注意:已通过 chmod +x 设为可执行]";
const URI_LIKE_WRITE_PATH_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}(.*)$/i;
const XD_MISSING_DELIMITER_RE = /^xd\/+(.*)$/i;
const XD_SCHEME_NEAR_MISSES: Record<string, true> = { dx: true, xdd: true, xdt: true };

function assertWriteTargetAddressable(target: string, router: InternalUrlRouter): void {
	const trimmed = target.trim();
	if (path.win32.isAbsolute(trimmed) || router.canHandle(trimmed)) return;

	const missingDelimiter = trimmed.match(XD_MISSING_DELIMITER_RE);
	if (missingDelimiter) {
		throw new ToolError(
			`未知的 URI 类写入目标 '${trimmed}'。您是指 'xd://${missingDelimiter[1]}' 吗?请在路径前加 './' 以文件系统路径方式写入。`,
		);
	}

	const uriLike = trimmed.match(URI_LIKE_WRITE_PATH_RE);
	if (!uriLike) return;

	const scheme = uriLike[1]!.toLowerCase();
	// conflict:// has no router handler but is spliced downstream by
	// parseConflictUri (which emits its own precise id/scope errors); let it pass.
	if (scheme === "conflict") return;
	const canonicalScheme = router.getHandler(scheme) ? scheme : XD_SCHEME_NEAR_MISSES[scheme] ? "xd" : undefined;
	const suggestion = canonicalScheme
		? ` 您是指 '${canonicalScheme}://${uriLike[2]}' 吗?`
		: " 工具设备使用 'xd://<tool>'。";
	throw new ToolError(
		`未知的 URI 类写入目标 '${trimmed}'。${suggestion}请在路径前加 './' 以文件系统路径方式写入。`,
	);
}

/**
 * Fail closed when a local write target looks like a mis-dispatched read.
 *
 * A read-only step that selects `write` instead of `read` passes the full read
 * expression (`src/foo.tsx:1-260:raw`) as the target. Because a literal colon
 * filename is legal on POSIX (issue #4618), that request otherwise resolves to
 * filesystem creation and reports success, leaving a stray zero-byte file the
 * model cannot recover from — the local analogue of the `xd://` near-miss guard
 * ({@link assertWriteTargetAddressable}, issue #6123).
 *
 * Fires only on the high-confidence combination the report identifies: the tail
 * parses as a read-tool selector, the literal target is missing, and no content
 * was supplied. Non-empty content is the escape hatch — it is never blocked, so
 * a deliberate write to a selector-shaped filename still succeeds. An existing
 * literal path or an ambiguous stat (`"unknown"`: EACCES, transient I/O) also
 * passes through so a real file is never shadowed by the guard.
 */
function readSelectorForEmptyWrite(target: string, content: string): string | undefined {
	if (content.length > 0) return undefined;
	return splitPathAndSel(target).sel;
}

function throwReadSelectorMisfire(target: string, sel: string): never {
	throw new ToolError(
		`写入目标 '${target}' 以读取工具选择器 ':${sel}' 结尾,且不存在该文件——拒绝创建同名字面量文件。` +
			`如果您想读取它,请使用 read({ path: "${target}" })。` +
			`如果您确实想创建该文件,请在 \`content\` 中传入其内容(非空写入永远不会被阻止)。`,
	);
}

/**
 * Recognize a semicolon-joined list of read-tool selectors mis-dispatched as a
 * single write target — the multi-file read expression the scout emitted in
 * issue #6809 (`a.txt:1-2;b/c.txt:3-4`). Every `;`-segment must be non-empty and
 * carry its own read selector ({@link splitPathAndSel} peels a `:N-M`, `:raw`,
 * or `:conflicts` tail). No real call targets such a list: `read` accepts one
 * path, `write` writes one file. Unlike {@link readSelectorForEmptyWrite} this
 * fires regardless of `content` — the non-empty-content escape hatch exists for
 * a lone selector-shaped *filename*, never a `;`-list, and honoring it here
 * silently creates a nested directory tree (`a.txt:1-2;b/`) in the workspace.
 * The caller still probes the literal target first, so an existing POSIX file
 * by that exact name stays writable (same escape as the single-selector guard).
 */
function readSelectorListMisfire(target: string): number | undefined {
	if (!target.includes(";")) return undefined;
	const segments = target.split(";");
	if (segments.length < 2) return undefined;
	for (const segment of segments) {
		const trimmed = segment.trim();
		if (trimmed.length === 0 || splitPathAndSel(trimmed).sel === undefined) return undefined;
	}
	return segments.length;
}

function throwReadSelectorListMisfire(target: string, count: number): never {
	throw new ToolError(
		`写入目标 '${target}' 是由 ${count} 个读取工具选择器以分号连接而成的列表,而非文件系统路径——拒绝创建。` +
			`write 只创建一个文件;要读取这些范围,请对每个路径分别调用一次 read()(例如 read({ path: "<one path>:<range>" }))。`,
	);
}

async function assertNotReadSelectorMisfire(target: string, content: string, cwd: string): Promise<void> {
	const listCount = readSelectorListMisfire(target);
	if (listCount !== undefined && (await probeLiteralPathExists(target, cwd)) === "missing") {
		throwReadSelectorListMisfire(target, listCount);
	}
	const sel = readSelectorForEmptyWrite(target, content);
	if (sel === undefined) return;
	if ((await probeLiteralPathExists(target, cwd)) !== "missing") return;
	throwReadSelectorMisfire(target, sel);
}

const BULK_DIRECTIVE_RE = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/;
/**
 * The head of a per-id directive line — `<id>:` / `<id>=` (optionally `#`-prefixed),
 * regardless of whether its value is a valid `@side` token. Used only to sharpen the
 * error message when a directive block is malformed (e.g. `15: some literal text`).
 */
const BULK_DIRECTIVE_HEAD_RE = /^#?\d+\s*[:=]/;

function truncateDirectiveLine(line: string): string {
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * Parse `conflict://*` per-id directive content: every non-empty line must be
 * `<id>: @side` (also accepted: `#<id> = @side`), where `@side` is one of
 * `@ours` / `@theirs` / `@base` / `@both`.
 *
 * Returns `null` only when NO line is directive-shaped (→ uniform bulk mode).
 * Throws on duplicate ids, and — critically — on a *partial* directive block:
 * content that mixes valid `<id>: @side` lines with lines that aren't. Without
 * that guard a per-id write carrying any non-token value (a literal or
 * multi-line replacement, e.g. `15: <multi-line content>`) fell through to
 * uniform bulk mode, which pasted the raw directive text verbatim into every
 * block and still reported success. Per-id bulk is token-only; literal or
 * multi-line replacements must go through individual `conflict://<N>` writes.
 */
function parseBulkDirectives(content: string): Map<number, string> | null {
	const map = new Map<number, string>();
	const stray: string[] = [];
	let sawDirective = false;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const match = line.match(BULK_DIRECTIVE_RE);
		if (!match) {
			stray.push(line);
			continue;
		}
		sawDirective = true;
		const id = Number.parseInt(match[1], 10);
		if (map.has(id)) {
			throw new ToolError(`批量指令列表重复列出了冲突 #${id}——每个 id 只能出现一次。`);
		}
		map.set(id, match[2]);
	}
	// No directive lines at all → not a per-id block; caller uses uniform mode.
	if (!sawDirective) return null;
	if (stray.length > 0) {
		const sample = stray[0]!;
		const tokenHint = BULK_DIRECTIVE_HEAD_RE.test(sample)
			? `按 id 的批量写入只接受 @ours/@theirs/@base/@both 这些 token——每个 id 一行,每行一个选择。`
			: "";
		throw new ToolError(
			`\`conflict://*\` 按 id 的块格式错误:${stray.length} 行不是 \`<id>: @side\` 指令(首例: \`${truncateDirectiveLine(sample)}\`)。` +
				tokenHint +
				`按 id 的块不支持字面量或多行替换内容——请使用单独的 \`write({ path: "conflict://<N>", content })\` 调用来解决这些块(可以一次发出多个)。` +
				`若只想纯粹地选择一边,请让每个非空行都是 \`<id>: @ours\`(或 @theirs/@base/@both)。`,
		);
	}
	return map;
}

/**
 * Resolve per-id directives, preferring the pre-strip `raw` content and falling
 * back to the hashline-stripped `stripped` content.
 *
 * Raw is preferred because the `<id>:` directive heads look exactly like
 * hashline `LINE:` prefixes and would be eaten by stripping. When the two
 * contents are identical (hashline mode off) a single parse decides everything,
 * so a malformed-block error propagates straight through — the previous
 * `?? parseBulkDirectives(...)` chain would have swallowed it and silently
 * degraded to uniform bulk mode, pasting the raw directive text into every
 * block. When they differ, a malformed raw block still defers to a *clean*
 * stripped block, but otherwise surfaces its error rather than degrading.
 */
function resolveBulkDirectives(raw: string, stripped: string): Map<number, string> | null {
	if (raw === stripped) return parseBulkDirectives(raw);
	let rawResult: Map<number, string> | null;
	try {
		rawResult = parseBulkDirectives(raw);
	} catch (rawError) {
		let fallback: Map<number, string> | null = null;
		try {
			fallback = parseBulkDirectives(stripped);
		} catch {
			fallback = null;
		}
		if (fallback) return fallback;
		throw rawError;
	}
	return rawResult ?? parseBulkDirectives(stripped);
}

const writeSchema = type({
	path: type("string").describe("文件路径"),
	content: type("string").describe("文件内容"),
});

export type WriteToolInput = typeof writeSchema.infer;

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	/** Set when the file was auto-chmod'd because content begins with a `#!` shebang. */
	madeExecutable?: boolean;
	/** Absolute filesystem path the write resolved to. Used by the renderer to wrap
	 * the (possibly cwd-relative) header path in an OSC 8 `file://` hyperlink. */
	resolvedPath?: string;
	/** Set when the write dispatched an `xd://` tool device; drives renderer delegation. */
	xdev?: XdevDispatch;
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Includes a fallback for loosely-formed section headers that still carry
 * line-number prefixes (for example legacy or malformed hashline echoes).
 */
function stripWriteContentWithPotentialLooseHeader(lines: string[]): { text: string; stripped: boolean } {
	const cleaned = stripHashlinePrefixes(lines);
	if (cleaned !== lines) {
		return { text: cleaned.join("\n"), stripped: true };
	}

	const headerIndex = lines.findIndex(line => line.trim().length > 0);
	if (headerIndex === -1 || !LOOSE_HASHLINE_HEADER_RE.test(lines[headerIndex])) {
		return { text: lines.join("\n"), stripped: false };
	}

	const linesWithoutHeader = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1));
	const cleanedWithoutHeader = stripHashlinePrefixes(linesWithoutHeader);
	if (cleanedWithoutHeader === linesWithoutHeader) {
		return { text: lines.join("\n"), stripped: false };
	}
	return { text: cleanedWithoutHeader.join("\n"), stripped: true };
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Only active when hashline edit mode is enabled — the model sees `[PATH#HASH]`
 * headers plus `LINE:` prefixes in read output and sometimes copies them into write content.
 */
function stripWriteContent(session: ToolSession, content: string): { text: string; stripped: boolean } {
	if (!resolveFileDisplayMode(session).hashLines) {
		return { text: content, stripped: false };
	}
	return stripWriteContentWithPotentialLooseHeader(content.split("\n"));
}

/**
 * Record a snapshot of the freshly-written `content` for `absolutePath`
 * so subsequent hashline edits address the new file with a current tag,
 * and return the matching `[displayPath#TAG]` header. Returns `undefined`
 * when the session is not in hashline mode so callers can no-op cheaply.
 *
 * Mirrors the post-commit snapshot recording the hashline patcher performs
 * after a successful edit: the model gets a tag without an extra `read`.
 */
function maybeWriteSnapshotHeader(session: ToolSession, absolutePath: string, content: string): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized);
	return formatHashlineHeader(formatPathRelativeToCwd(absolutePath, session.cwd), tag);
}

/**
 * Append a trailing note line to the first text block of a tool result.
 * Mutates `result` in place (the result object is owned by this call).
 */
function appendNoteToResult(result: AgentToolResult<WriteToolDetails>, note: string): void {
	const firstText = result.content.find(
		(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
	);
	if (firstText) {
		firstText.text = firstText.text.length > 0 ? `${firstText.text}\n${note}` : note;
	} else {
		result.content.push({ type: "text", text: note });
	}
}

function emitWriteProgress(
	onUpdate: AgentToolUpdateCallback<WriteToolDetails> | undefined,
	content: string,
	displayPath: string,
	resolvedPath?: string,
): void {
	onUpdate?.({
		content: [{ type: "text", text: `正在向 ${shortenPath(displayPath)} 写入 ${content.length} 字节...` }],
		details: resolvedPath ? { resolvedPath } : {},
	});
}

/**
 * If `content` begins with a `#!` shebang, ensure the file is executable.
 *
 * Mirrors `chmod a+x` (adds user/group/other execute bits to existing mode).
 * Errors are swallowed: chmod failure (e.g. Windows ACL, read-only mount)
 * MUST NOT fail an otherwise successful write. Returns whether the mode
 * actually changed so the caller can surface a note.
 */
async function maybeMarkExecutableForShebang(absolutePath: string, content: string): Promise<boolean> {
	if (!content.startsWith("#!")) return false;
	try {
		const stat = await fs.stat(absolutePath);
		const currentMode = stat.mode & 0o7777;
		const newMode = currentMode | 0o111;
		if (newMode === currentMode) return false;
		await fs.chmod(absolutePath, newMode);
		return true;
	} catch {
		return false;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

function isArchivePathNotFound(error: unknown): boolean {
	if (isEnoent(error)) return true;
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

function normalizeArchiveWriteSubPath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.length === 0) {
		throw new ToolError("归档写入路径必须指向归档内的文件");
	}
	if (normalized.endsWith("/")) {
		throw new ToolError("归档写入路径必须指向文件,而非目录");
	}

	const parts = normalized.split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			throw new ToolError("归档路径不能包含 '..'");
		}
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) {
		throw new ToolError("归档写入路径必须指向归档内的文件");
	}

	return normalizedParts.join("/");
}

function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
	if (queryString.trim().length > 0) {
		throw new ToolError("SQLite 写入路径不支持查询参数");
	}

	const normalized = subPath.replace(/^:+/, "").trim();
	if (!normalized) {
		throw new ToolError("SQLite 写入路径必须指向一个表");
	}

	const separatorIndex = normalized.indexOf(":");
	const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite 写入路径必须指向一个表");
	}
	if (key !== undefined && key.length === 0) {
		throw new ToolError("SQLite 行写入需要非空的行键");
	}

	return { table, key };
}

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails> {
	readonly name = "write";
	readonly approval = (args: unknown): ToolTier => {
		const rawPath = (args as Partial<WriteParams>).path;
		if (typeof rawPath !== "string") return "write";
		// Unwrap a hashline `[path#TAG]` wrapper first (parity with execute) so a
		// wrapped `[ssh://h/x#ABCD]` can't dodge scheme detection and the tier checks below.
		const path = unwrapHashlineHeaderPath(rawPath);
		// xd:// device writes execute the mounted tool — take its approval tier.
		// The resolution devices (xd://resolve, xd://reject, xd://propose)
		// finalize a staged, already-previewed action, so they stay at read tier.
		const xdevTarget = parseXdUrl(path);
		if (xdevTarget) {
			if (xdevTarget.name === REPORT_ISSUE_DEVICE_NAME) return "write";
			if (xdevTarget.name && isResolutionDeviceName(xdevTarget.name)) return "read";
			const inst =
				xdevTarget.name && this.session.xdev ? resolveXdevTool(this.session.xdev, xdevTarget.name) : undefined;
			if (!inst) return "exec";
			// Decode the device JSON payload and evaluate the mounted tool's own
			// approval (which may be argument-dependent, e.g. ast_edit is read-tier
			// for internal-URL paths, debug is read-tier for inspection actions).
			// Malformed JSON, non-object payloads, missing content, and approval
			// functions that reject schema-invalid objects stay exec so the gate
			// fails closed — the dispatch itself rejects invalid arguments too.
			const rawContent = (args as Partial<WriteParams>).content;
			if (typeof rawContent !== "string") return "exec";
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawContent);
			} catch {
				return "exec";
			}
			if (!isRecord(parsed)) return "exec";
			try {
				return resolveToolTier(inst, parsed);
			} catch {
				return "exec";
			}
		}
		// Remote SSH writes open an outbound connection and run a remote shell —
		// gate them like the exec-tier `ssh` tool, ahead of the handler-write
		// logic. Substring match also covers selector-suffixed targets.
		if (pathTargetsSsh(path)) return "exec";
		if (!isInternalUrlPath(path)) return "write";
		// Internal URLs are usually session-local artifacts (read tier), but a
		// scheme whose handler exposes a `write` hook mutates handler-owned user
		// data (e.g. vault:// notes) and must take the write tier so always-ask
		// mode actually prompts.
		const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(path.trim());
		const handler = match ? InternalUrlRouter.instance().getHandler(match[1]!.toLowerCase()) : undefined;
		return handler?.write ? "write" : "read";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<WriteParams>;
		const targetPath = typeof params.path === "string" ? params.path : "(缺失)";
		const content = typeof params.content === "string" ? params.content : "";
		return [`路径: ${truncateForPrompt(targetPath)}`, `内容:\n${truncateForPrompt(content)}`];
	};
	readonly label = "写入";
	readonly description: string;
	readonly parameters = writeSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "essential";

	/** Stream matchers should see the real file content, not its JSON-escaped argument encoding. */
	matcherDigest(args: unknown): string | undefined {
		const content = (args as Partial<WriteParams>).content;
		return typeof content === "string" ? content : undefined;
	}

	readonly #writethrough: WritethroughCallback;
	readonly #deferredDiagnostics: DeferredDiagnostics | undefined;

	constructor(private readonly session: ToolSession) {
		const enableLsp = session.enableLsp ?? true;
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics =
			enableDiagnostics && session.queueDeferredDiagnostics ? new DeferredDiagnostics(session, dedup) : undefined;
		this.#writethrough = enableLsp
			? createLspWritethrough(session.cwd, {
					enableFormat,
					enableDiagnostics,
					transformDiagnostics: dedup
						? (path, result) => getDiagnosticsLedger(session).reduce(path, result)
						: undefined,
				})
			: writethroughNoop;
		this.description = prompt.render(writeDescription);
	}

	async #resolveArchiveWritePath(writePath: string): Promise<ResolvedArchiveWritePath | null> {
		const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallback: ResolvedArchiveWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.archivePath),
			archivePath: fallbackCandidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
			exists: false,
		};

		for (const candidate of candidates) {
			const absolutePath = resolvePlanPath(this.session, candidate.archivePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}

				return {
					absolutePath,
					archivePath: candidate.archivePath,
					archiveSubPath: normalizeArchiveWriteSubPath(candidate.subPath),
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		return fallback;
	}

	async #writeArchiveEntry(
		content: string,
		resolvedArchivePath: ResolvedArchiveWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Resolve symlinks before the tmp+rename swap: renaming over a symlink
		// replaces the link itself with a regular file instead of writing
		// through to its target.
		const finalPath = resolvedArchivePath.exists
			? await fs.realpath(resolvedArchivePath.absolutePath).catch(() => resolvedArchivePath.absolutePath)
			: resolvedArchivePath.absolutePath;
		// A realpath swap can land on a name without an archive extension; a
		// whole-archive rewrite then defaults to an uncompressed tar, matching the
		// previous `isZip`/`isGzip`/else fallthrough.
		const format = archiveFormatFromPath(finalPath) ?? "tar";
		// Rewrites are whole-archive: write to a temp file and rename so a
		// crash/disk-full mid-write can't destroy the original archive.
		const tmpPath = `${finalPath}.tmp-${process.pid}`;

		const parentDir = path.dirname(resolvedArchivePath.absolutePath);
		if (parentDir && parentDir !== ".") {
			await fs.mkdir(parentDir, { recursive: true });
		}

		const entries = new Map<string, ArchiveMemberContent>();
		if (resolvedArchivePath.exists) {
			try {
				const existing = await readArchiveEntries({ bytes: await Bun.file(finalPath).bytes(), format });
				for (const [entryPath, data] of existing) {
					entries.set(entryPath, data);
				}
			} catch (error) {
				throw new ToolError(error instanceof Error ? error.message : String(error));
			}
		}
		const writeTarget = `${resolvedArchivePath.archivePath}:${resolvedArchivePath.archiveSubPath}`;
		const sel = readSelectorForEmptyWrite(writeTarget, content);
		if (sel !== undefined && !entries.has(resolvedArchivePath.archiveSubPath)) {
			throwReadSelectorMisfire(writeTarget, sel);
		}
		entries.set(resolvedArchivePath.archiveSubPath, content);

		try {
			await writeArchive(tmpPath, format, entries);
			await fs.rename(tmpPath, finalPath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}

		invalidateFsScanAfterWrite(resolvedArchivePath.absolutePath);
		const outputPath = `${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
			resolvedArchivePath.archiveSubPath
		}`;
		return {
			content: [{ type: "text", text: `已成功向 ${outputPath} 写入 ${content.length} 字节` }],
			details: { resolvedPath: resolvedArchivePath.absolutePath },
		};
	}

	async #resolveSqliteWritePath(writePath: string): Promise<ResolvedSqliteWritePath | null> {
		const candidates = parseSqlitePathCandidates(writePath).filter(candidate => candidate.sqlitePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString);
		const fallback: ResolvedSqliteWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.sqlitePath),
			sqlitePath: fallbackCandidate.sqlitePath,
			table: fallbackTarget.table,
			key: fallbackTarget.key,
			exists: false,
		};

		let sawExistingNonSqlite = false;
		for (const candidate of candidates) {
			const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
			const absolutePath = resolvePlanPath(this.session, candidate.sqlitePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}
				if (!(await isSqliteFile(absolutePath))) {
					sawExistingNonSqlite = true;
					continue;
				}

				return {
					absolutePath,
					sqlitePath: candidate.sqlitePath,
					table: target.table,
					key: target.key,
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		if (sawExistingNonSqlite) {
			return null;
		}

		return fallback;
	}

	async #writeSqliteRow(
		displayPath: string,
		content: string,
		resolvedSqlitePath: ResolvedSqliteWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		let db: Database | null = null;
		try {
			if (!resolvedSqlitePath.exists) {
				throw new ToolError(`未找到 SQLite 数据库 '${displayPath}'`);
			}

			db = new Database(resolvedSqlitePath.absolutePath, { create: false, strict: true });
			db.run("PRAGMA busy_timeout = 3000");

			const trimmedContent = content.trim();
			let resultText: string;
			if (trimmedContent.length === 0) {
				if (!resolvedSqlitePath.key) {
					throw new ToolError("SQLite 删除操作需要在路径中包含行键");
				}

				const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
				const deleted =
					lookup.kind === "pk"
						? deleteRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key)
						: deleteRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key);
				resultText =
					deleted > 0
						? `已从 ${resolvedSqlitePath.table} 删除行 '${resolvedSqlitePath.key}'`
						: `未从 ${resolvedSqlitePath.table} 删除键为 '${resolvedSqlitePath.key}' 的行`;
			} else {
				let parsedContent: unknown;
				try {
					parsedContent = Bun.JSON5.parse(content);
				} catch (error) {
					throw new ToolError(
						`SQLite 写入内容必须是有效的 JSON5: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				if (!isRecord(parsedContent)) {
					throw new ToolError("SQLite 写入内容必须是 JSON 对象");
				}

				if (resolvedSqlitePath.key) {
					const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
					const updated =
						lookup.kind === "pk"
							? updateRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key, parsedContent)
							: updateRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key, parsedContent);
					resultText =
						updated > 0
							? `已更新 ${resolvedSqlitePath.table} 中键为 '${resolvedSqlitePath.key}' 的行`
							: `未更新 ${resolvedSqlitePath.table} 中键为 '${resolvedSqlitePath.key}' 的行`;
				} else {
					insertRow(db, resolvedSqlitePath.table, parsedContent);
					resultText = `已向 ${resolvedSqlitePath.table} 插入一行`;
				}
			}

			invalidateFsScanAfterWrite(resolvedSqlitePath.absolutePath);
			return toolResult<WriteToolDetails>({ resolvedPath: resolvedSqlitePath.absolutePath })
				.text(resultText)
				.sourcePath(resolvedSqlitePath.absolutePath)
				.done();
		} catch (error) {
			if (isEnoent(error)) {
				throw new ToolError(`未找到 SQLite 数据库 '${displayPath}'`);
			}
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		} finally {
			db?.close();
		}
	}

	/**
	 * Resolve a single `conflict://<N>` write by splicing the recorded
	 * marker region in the registered file with `replacementContent`.
	 * The write deliberately bypasses the LSP writethrough: the file may
	 * still hold other unresolved marker blocks, so formatting could
	 * corrupt them and diagnostics would be marker-noise anyway.
	 *
	 * Entry ids are session-stable: they keep working even after later
	 * writes resolve other blocks in the same file. The recorded range
	 * is re-validated on disk before splicing so an out-of-band edit
	 * surfaces as a clear error instead of corrupting the file.
	 */
	async #resolveConflict(
		entry: ConflictEntry,
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const absolutePath = entry.absolutePath;
		if (!(await fs.exists(absolutePath))) {
			throw new ToolError(`冲突 #${entry.id} 的目标 '${entry.displayPath}' 已不存在。`);
		}

		const expanded = expandContentTokens(replacementContent, entry);
		const originalText = await Bun.file(absolutePath).text();
		const splice = spliceConflict(originalText, entry, expanded);
		const newContent = splice.text;

		await writethroughNoop(absolutePath, newContent, signal);
		invalidateFsScanAfterWrite(absolutePath);
		this.session.bumpFileMutationVersion?.(absolutePath);
		this.session.fileSnapshotStore?.invalidate(absolutePath);
		const history = this.session.conflictHistory;
		history?.invalidate(entry.id);
		if (history) {
			// Drop stale duplicate registrations of the same region: a re-read
			// after an out-of-band shift registers a fresh id at the new
			// startLine while the stale twin persists at the old one. A DISTINCT
			// conflict block that is merely byte-identical still occurs in the
			// post-splice content and must stay addressable.
			for (const other of history.entries()) {
				if (
					other.absolutePath === absolutePath &&
					conflictRegionsEqual(other, entry) &&
					!conflictRegionPresent(newContent, other)
				) {
					history.invalidate(other.id);
				}
			}
		}

		const header = maybeWriteSnapshotHeader(this.session, absolutePath, newContent);
		const range =
			entry.startLine === entry.endLine
				? `第 ${entry.startLine} 行`
				: `第 ${entry.startLine}\u2013${entry.endLine} 行`;
		const summary = `已在 ${entry.displayPath} 的 ${range} 解决冲突 #${entry.id}。`;
		let resultText = header ? `${header}\n${summary}` : summary;
		if (stripped) {
			resultText += `\n注意:写入前已自动剥离内容中的 hashline 显示前缀。`;
		}
		const echoTrimmed = splice.trimmedLeading + splice.trimmedTrailing;
		if (echoTrimmed > 0) {
			resultText += `\nNote: dropped ${echoTrimmed} content line(s) that duplicated the code adjacent to the conflict region — writes replace only the marker block; surrounding lines stay in place.`;
		}

		return {
			content: [{ type: "text", text: resultText }],
			details: { resolvedPath: absolutePath },
		};
	}

	/**
	 * Look up a single conflict entry by id and dispatch to {@link #resolveConflict}.
	 * Throws a clear `not found` error when the id has been invalidated.
	 */
	async #resolveSingleConflictById(
		id: number,
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const entry = getConflictHistory(this.session).get(id);
		if (!entry) {
			throw new ToolError(
				`未找到冲突 #${id}。冲突 id 会在 \`read\` 显示标记块时注册;请重新读取文件以获取当前的 id。`,
			);
		}
		return this.#resolveConflict(entry, replacementContent, stripped, signal);
	}

	/**
	 * Bulk-resolve every registered conflict via `conflict://*`.
	 *
	 * Entries are grouped by file and applied bottom-up by recorded start
	 * line so each splice keeps later anchors valid. `content` tokens are
	 * expanded *per entry*, so `content: "@ours"` keeps each block's own
	 * ours side rather than collapsing every conflict to the first
	 * block's ours.
	 *
	 * All-or-nothing semantics within a file: if any splice for a file
	 * fails (stale anchors, missing base for `@base`, etc.), that file is
	 * left untouched and the error is surfaced. Files that succeed are
	 * still written. The result text reports per-file counts so the agent
	 * can re-read the failed files and retry.
	 */
	async #resolveAllConflicts(
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
		rawContent: string = replacementContent,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const history = getConflictHistory(this.session);
		const allEntries = history.entries();
		if (allEntries.length === 0) {
			throw new ToolError(
				"`conflict://*` 没有可解决的冲突——当前没有注册任何冲突。请先重新读取含冲突的文件。",
			);
		}

		// Per-id directive mode: content made solely of `<id>: @side` lines
		// resolves each listed conflict with that side in one call. Ideal for
		// merge-hell files where dozens of pick-one blocks each need their own
		// winner — one call instead of one write per conflict. Parsed from the
		// PRE-strip content: hashline prefix stripping would otherwise eat the
		// `<id>: ` heads as echoed line numbers.
		const directives = resolveBulkDirectives(rawContent, replacementContent);
		if (directives) {
			const known = new Set(allEntries.map(entry => entry.id));
			const unknown = [...directives.keys()].filter(id => !known.has(id));
			if (unknown.length > 0) {
				throw new ToolError(
					`批量指令引用了未知的冲突 id: ${unknown.map(id => `#${id}`).join(", ")}。当前已注册: ${allEntries.map(e => `#${e.id}`).join(", ")}。`,
				);
			}
		}
		const selectedEntries = directives ? allEntries.filter(entry => directives.has(entry.id)) : allEntries;
		const contentFor = (entry: ConflictEntry): string =>
			directives ? (directives.get(entry.id) as string) : replacementContent;

		const byFile = new Map<string, ConflictEntry[]>();
		for (const entry of selectedEntries) {
			const bucket = byFile.get(entry.absolutePath) ?? [];
			bucket.push(entry);
			byFile.set(entry.absolutePath, bucket);
		}

		const succeededFiles: { displayPath: string; count: number; header?: string }[] = [];
		const failedFiles: { displayPath: string; count: number; error: string }[] = [];
		let totalResolvedIds = 0;
		let totalEchoTrimmed = 0;

		for (const [absolutePath, fileEntries] of byFile) {
			const sample = fileEntries[0]!;
			if (!(await fs.exists(absolutePath))) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: "文件已不存在",
				});
				continue;
			}

			fileEntries.sort((a, b) => b.startLine - a.startLine);

			let text: string;
			const resolvedEntries: ConflictEntry[] = [];
			const staleEntries: ConflictEntry[] = [];
			let failure: string | undefined;
			try {
				text = await Bun.file(absolutePath).text();
			} catch (error) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			for (const entry of fileEntries) {
				try {
					const expanded = expandContentTokens(contentFor(entry), entry);
					const splice = spliceConflict(text, entry, expanded);
					text = splice.text;
					totalEchoTrimmed += splice.trimmedLeading + splice.trimmedTrailing;
					resolvedEntries.push(entry);
				} catch (error) {
					// A locate-miss for a region an earlier entry already spliced
					// in this pass is a stale duplicate registration (re-read after
					// an out-of-band shift) — treat it as already resolved.
					if (resolvedEntries.some(done => conflictRegionsEqual(done, entry))) {
						staleEntries.push(entry);
						continue;
					}
					failure = error instanceof Error ? error.message : String(error);
					break;
				}
			}
			if (failure !== undefined) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: failure,
				});
				continue;
			}

			await writethroughNoop(absolutePath, text, signal);
			invalidateFsScanAfterWrite(absolutePath);
			this.session.bumpFileMutationVersion?.(absolutePath);
			this.session.fileSnapshotStore?.invalidate(absolutePath);
			for (const entry of resolvedEntries) history.invalidate(entry.id);
			for (const entry of staleEntries) history.invalidate(entry.id);
			const header = maybeWriteSnapshotHeader(this.session, absolutePath, text);
			succeededFiles.push({ displayPath: sample.displayPath, count: resolvedEntries.length, header });
			totalResolvedIds += resolvedEntries.length;
		}

		const summaryLines: string[] = [];
		const fileWord = (_n: number) => "个文件";
		const conflictWord = (_n: number) => "个冲突";
		if (succeededFiles.length > 0) {
			summaryLines.push(
				`已解决 ${totalResolvedIds} ${conflictWord(totalResolvedIds)}(涉及 ${succeededFiles.length} ${fileWord(succeededFiles.length)}):`,
			);
			for (const file of succeededFiles) {
				summaryLines.push(`  ${file.displayPath}: ${file.count} ${conflictWord(file.count)}`);
			}
		}
		if (directives && selectedEntries.length < allEntries.length) {
			const remaining = allEntries.filter(entry => !directives.has(entry.id)).map(entry => `#${entry.id}`);
			summaryLines.push(
				`指令模式:${remaining.length} 个未列出的冲突仍已注册(${remaining.join(", ")})。`,
			);
		}
		if (totalEchoTrimmed > 0) {
			summaryLines.push(
				`注意:已丢弃 ${totalEchoTrimmed} 行与冲突区域相邻代码重复的内容——写入只替换标记块;周围的行保持不变。`,
			);
		}
		if (failedFiles.length > 0) {
			summaryLines.push(
				`解决 ${failedFiles.length} 个文件失败——已注册的条目保持原样,可重试:`,
			);
			for (const file of failedFiles) {
				summaryLines.push(`  ${file.displayPath}: ${file.count} 个冲突 (${file.error})`);
			}
		}
		const headerLines = succeededFiles
			.map(file => file.header)
			.filter((header): header is string => header !== undefined);
		if (headerLines.length > 0) {
			summaryLines.push("快照:");
			for (const header of headerLines) summaryLines.push(`  ${header}`);
		}
		if (stripped && !directives) {
			summaryLines.push("注意:写入前已自动剥离内容中的 hashline 显示前缀。");
		}
		const resultText = summaryLines.join("\n");

		if (failedFiles.length > 0 && succeededFiles.length === 0) {
			throw new ToolError(resultText);
		}
		return {
			content: [{ type: "text", text: resultText }],
			details: {},
			isError: failedFiles.length > 0 ? true : undefined,
		};
	}

	async execute(
		_toolCallId: string,
		{ path: rawPath, content }: WriteParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Strip a hashline `[path#TAG]` wrapper up front so every downstream
		// decision (scheme routing, internal-URL handler dispatch, plan-mode
		// guard, plan path resolution, ACP bridge routing) sees the same
		// filesystem target. Without this, a model that pastes a `read`
		// header as the `path` arg would slip past `isInternalUrlPath`
		// (which fails on a leading `[`) and the bridge router would send a
		// `[local://scratch.md#ABCD]` write to the editor instead of the
		// session-local sandbox.
		// Peel a read-tool selector (`:raw`, `:1-20`, …) so the write target matches
		// what `read` resolves for the same URL; line-range/malformed selectors throw.
		const path = peelWriteUrlSelector(unwrapHashlineHeaderPath(rawPath));
		return untilAborted(signal, async () => {
			// Strip hashline display prefixes ([PATH#HASH] + LINE:) if the model copied them from read output
			const { text: cleanContent, stripped } = stripWriteContent(this.session, content);
			const internalRouter = InternalUrlRouter.instance();
			assertWriteTargetAddressable(path, internalRouter);
			if (internalRouter.canHandle(path)) {
				const parsed = parseInternalUrl(path);
				const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
				const handler = internalRouter.getHandler(scheme);
				if (handler?.write) {
					// Handler-owned writes mutate user data outside the local
					// sandbox. xd:// dispatches retain each wrapped tool's tier.
					if (scheme !== "xd") {
						enforcePlanModeWrite(this.session, path, { op: "update" });
						emitWriteProgress(onUpdate, cleanContent, path);
					}
					let xdResult: AgentToolResult<WriteToolDetails> | undefined;
					await internalRouter.write(path, cleanContent, {
						cwd: this.session.cwd,
						signal,
						xd: {
							write: async (name, deviceContent) => {
								if (name === REPORT_ISSUE_DEVICE_NAME) {
									const { result, xdev } = await dispatchReportIssueDevice(this.session, deviceContent);
									xdResult = {
										content: result.content,
										details: { xdev },
										isError: result.isError,
										useless: result.useless,
									};
									return;
								}
								if (name && isResolutionDeviceName(name)) {
									const { result, xdev } = await dispatchResolutionDevice(this.session, name, deviceContent);
									xdResult = {
										content: result.content,
										details: { xdev },
										isError: result.isError,
										useless: result.useless,
									};
									return;
								}
								const xdev = this.session.xdev;
								if (!xdev) {
									throw new ToolError("当前会话未挂载 xd://。");
								}
								if (!name) {
									throw new ToolError(`不能直接写入 xd:// 本身——请选择一个设备:\n${xdevListing(xdev)}`);
								}
								const { result, xdev: dispatch } = await dispatchXdevTool(
									xdev,
									name,
									deviceContent,
									_toolCallId,
									signal,
									onUpdate as AgentToolUpdateCallback,
									// The write tool's own gate just resolved approval at this
									// device's tier (see #approval above) — mark it so a wrapped
									// inner tool does not prompt a second time.
									context ? { ...context, xdevApproved: true } : undefined,
								);
								xdResult = {
									content: result.content,
									details: { xdev: dispatch },
									isError: result.isError,
									useless: result.useless,
								};
							},
						},
					});
					if (xdResult) return xdResult;
					let resultText = `已成功向 ${path} 写入 ${cleanContent.length} 字节`;
					if (stripped) {
						resultText += `\n注意:写入前已自动剥离内容中的 hashline 显示前缀。`;
					}
					return { content: [{ type: "text", text: resultText }], details: {} };
				}
				if (scheme !== "local") await internalRouter.write(path, cleanContent);
				// local:// is backed by the session-local artifact sandbox and is
				// resolved by resolvePlanPath below so write/read share the same root.
			}

			const conflictUri = parseConflictUri(path);
			if (conflictUri) {
				if (conflictUri.scope) {
					throw new ToolError(
						`冲突 URI 的范围 '/${conflictUri.scope}' 是只读的——请读取 \`conflict://${conflictUri.id}/${conflictUri.scope}\` 以查看该侧内容。要写入,请去掉范围(\`conflict://${conflictUri.id}\`),并将所选内容(或如 \`@${conflictUri.scope}\` 的简写)放入 \`content\`。`,
					);
				}
				emitWriteProgress(onUpdate, cleanContent, path);
				const result =
					conflictUri.id === "*"
						? await this.#resolveAllConflicts(cleanContent, stripped, signal, content)
						: await this.#resolveSingleConflictById(conflictUri.id, cleanContent, stripped, signal);
				if (conflictUri.recoveredPrefix !== undefined) {
					appendNoteToResult(
						result,
						`注意:已从路径中剥离错误的 '${conflictUri.recoveredPrefix}:' 前缀;冲突 URI 是全局的(请使用 \`conflict://${conflictUri.id}\`,而非 \`<file>:conflict://${conflictUri.id}\`)。`,
					);
				}
				return result;
			}
			const resolvedArchivePath = await this.#resolveArchiveWritePath(path);
			if (resolvedArchivePath) {
				enforcePlanModeWrite(this.session, resolvedArchivePath.archivePath, {
					op: resolvedArchivePath.exists ? "update" : "create",
				});

				emitWriteProgress(
					onUpdate,
					cleanContent,
					`${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
						resolvedArchivePath.archiveSubPath
					}`,
					resolvedArchivePath.absolutePath,
				);
				const archiveResult = await this.#writeArchiveEntry(cleanContent, resolvedArchivePath);
				if (stripped) {
					const firstText = archiveResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\n注意:写入前已自动剥离内容中的 hashline 显示前缀。`;
					}
				}
				return archiveResult;
			}

			const resolvedSqlitePath = await this.#resolveSqliteWritePath(path);
			if (resolvedSqlitePath) {
				enforcePlanModeWrite(this.session, resolvedSqlitePath.sqlitePath, { op: "update" });

				emitWriteProgress(onUpdate, cleanContent, path, resolvedSqlitePath.absolutePath);
				const sqliteResult = await this.#writeSqliteRow(path, cleanContent, resolvedSqlitePath);
				if (stripped) {
					const firstText = sqliteResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\n注意:写入前已自动剥离内容中的 hashline 显示前缀。`;
					}
				}
				return sqliteResult;
			}

			await assertNotReadSelectorMisfire(path, cleanContent, this.session.cwd);
			enforcePlanModeWrite(this.session, path, { op: "create" });
			const absolutePath = resolvePlanPath(this.session, path);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			// Check if file exists and is auto-generated before overwriting
			if (await fs.exists(absolutePath)) {
				await assertEditableFile(absolutePath, path, this.session.settings);
			}

			const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
			emitWriteProgress(onUpdate, cleanContent, displayPath, absolutePath);

			// Try ACP bridge first for editor-visible filesystem paths. Internal
			// artifacts such as local:// plans are owned by OMP, not the editor.
			const bridgeWrite = await routeWriteThroughBridge(this.session, path, absolutePath, cleanContent, signal);
			if (bridgeWrite) {
				// `write` always replaces the whole file, so (unlike hashline's
				// hunk-scoped diff) there's no size cost to keying the header/
				// executable-bit check on the verified post-write content —
				// use it so a drifted write (e.g. client format-on-save) still
				// hands back a tag that matches what's actually on disk.
				const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, bridgeWrite.text);
				const header = maybeWriteSnapshotHeader(this.session, absolutePath, bridgeWrite.text);
				const writeLine = `已成功向 ${displayPath} 写入 ${cleanContent.length} 字节`;
				let resultText = header ? `${header}\n${writeLine}` : writeLine;
				if (stripped) {
					resultText += `\n注意:写入前已自动剥离内容中的 hashline 显示前缀。`;
				}
				if (madeExecutable) {
					resultText += `\n${EXECUTABLE_NOTICE}`;
				}
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			const diagnostics = await this.#writethrough(
				absolutePath,
				cleanContent,
				signal,
				undefined,
				batchRequest,
				dst => this.#deferredDiagnostics?.begin(dst),
			);
			invalidateFsScanAfterWrite(absolutePath);
			if (!this.#deferredDiagnostics || batchRequest?.flush === false) {
				this.session.bumpFileMutationVersion?.(absolutePath);
			}
			const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, cleanContent);

			const header = maybeWriteSnapshotHeader(this.session, absolutePath, cleanContent);
			const writeLine = `已成功向 ${displayPath} 写入 ${cleanContent.length} 字节`;
			let resultText = header ? `${header}\n${writeLine}` : writeLine;
			if (stripped) {
				resultText += `\n注意:写入前已自动剥离内容中的 hashline 显示前缀。`;
			}
			if (madeExecutable) {
				resultText += `\n${EXECUTABLE_NOTICE}`;
			}
			if (!diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					resolvedPath: absolutePath,
					diagnostics,
					madeExecutable: madeExecutable || undefined,
					meta: outputMeta()
						.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** Bounded newline scan: whether `text` spans more than `maxLines` lines.
 *  Runs on every live compose (the repaint predicate below), so it must not
 *  materialize the split the way `countLines` does. */
function exceedsLineCount(text: string, maxLines: number): boolean {
	if (!text) return false;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		if (++lines > maxLines) return true;
	}
	return false;
}

function writeContentOf(args: unknown): string {
	if (args == null || typeof args !== "object" || !("content" in args)) return "";
	const content = args.content;
	return typeof content === "string" ? content : "";
}

function formatLineCountSuffix(lineCount: number, uiTheme: Theme): string {
	if (lineCount <= 0) return "";
	return uiTheme.fg("dim", ` · ${lineCount} 行`);
}

function normalizeDisplayText(text: unknown): string {
	let displayText = "";
	if (typeof text === "string") {
		displayText = text;
	} else if (text !== undefined && text !== null) {
		displayText = String(text);
	}
	return displayText.replace(/\r/g, "");
}

/**
 * Minimum line-number gutter width for write previews. The streaming preview's
 * gutter must stay byte-stable as the line count grows: a width derived purely
 * from `String(totalLines).length` widens at the 10/100/1000-line crossings,
 * rewriting every already-rendered row — which forces the transcript's commit
 * audit to recommit the block's committed prefix (a full duplicate in native
 * scrollback). Reserving 3 digits keeps the gutter constant through 999 lines
 * and keeps the streamed rows byte-identical to the final result render.
 */
const WRITE_GUTTER_MIN_WIDTH = 3;

function formatStreamingContent(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	spinnerFrame?: number,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	const bodyText = cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const lines = normalizeDisplayText(content).split("\n");
		const totalLines = lines.length;
		// Collapsed: follow the streaming edge with a bounded tail window so the box
		// stays short enough not to strand its scrolled-off head above the viewport
		// while the block is volatile. `Ctrl+O` (expanded) lifts the cap for a
		// deliberate full view — matching the eval streaming preview.
		const startIndex = expanded ? 0 : Math.max(0, totalLines - WRITE_STREAMING_PREVIEW_LINES);
		const visibleLines = lines.slice(startIndex);
		const hidden = startIndex;
		const highlighted = highlightCode(visibleLines.join("\n"), language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);

		let text = "\n\n";
		if (hidden > 0) {
			text += `${uiTheme.fg("dim", `… (前面还有 ${hidden} 行)`)}\n`;
		}
		for (let i = 0; i < highlighted.length; i++) {
			const lineNum = startIndex + i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(highlighted[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		return text;
	});
	// The animated glyph lives on this trailing line — inside the transcript's
	// volatile-tail holdback — never in the header: an animating head row pins
	// the native-scrollback commit boundary at the top of the block, so a long
	// expanded preview could never scroll-append mid-stream.
	const spinner = spinnerFrame !== undefined ? `${formatStatusIcon("running", uiTheme, spinnerFrame)} ` : "";
	return `${bodyText}${spinner}${uiTheme.fg("dim", `… (流式)`)}`;
}

function renderContentPreview(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	return cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const rawLines = normalizeDisplayText(content).split("\n");
		const totalLines = rawLines.length;
		const maxLines = expanded ? totalLines : Math.min(totalLines, WRITE_PREVIEW_LINES);
		const visibleLines = rawLines.slice(0, maxLines);
		const highlighted = highlightCode(visibleLines.join("\n"), language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
		const hidden = totalLines - maxLines;

		let text = "\n\n";
		for (let i = 0; i < highlighted.length; i++) {
			const lineNum = i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(highlighted[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		if (!expanded && hidden > 0) {
			const hint = formatExpandHint(uiTheme, expanded, hidden > 0);
			const moreLine = `${uiTheme.fg("dim", `… 还有 ${hidden} 行`)}${hint ? ` ${hint}` : ""}`;
			text += uiTheme.fg("dim", moreLine);
		}
		return text.trimEnd();
	});
}

/** Render context for the write tool: resolves an `xd://`-mounted tool so its live renderer drives device dispatch previews. */
export interface WriteRenderContext {
	resolveXdevMounted?: (name: string) => AgentTool | undefined;
}

export const writeToolRenderer = {
	renderCall(
		args: WriteRenderArgs,
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
	): Component | undefined {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		// Render NOTHING until the streamed path arrives and provably is not an
		// xd:// device; xd:// writes then delegate to the mounted tool's renderer.
		// A present-but-malformed path (array/object from a bad provider parse)
		// is definitively not xd:// — fall through to the legacy frame.
		if (args.path === undefined && args.file_path === undefined) return undefined;
		if (rawPath && couldBecomeXdUrl(rawPath)) {
			const xdev = parseXdUrl(rawPath);
			// The path string is settled once the content field started streaming.
			const pathSettled = args.content !== undefined;
			if (!xdev?.name || !pathSettled) return undefined;
			if (isResolutionDeviceName(xdev.name)) return renderResolutionDeviceCall(xdev.name, args.content, uiTheme);
			if (xdev.name === REPORT_ISSUE_DEVICE_NAME) return renderReportIssueDeviceCall(args.content, uiTheme);
			return renderXdevCall(xdev.name, args.content, options, uiTheme, options.renderContext?.resolveXdevMounted);
		}
		const filePath = shortenPath(rawPath);
		const lang = rawPath ? (getLanguageFromPath(rawPath) ?? "text") : "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		// No status icon on the head row: it's the head of the framed block, and
		// native-scrollback commits are prefix-only — an animated glyph would pin
		// the commit boundary at the top, and the pending hourglass just adds
		// noise. The liveness cue rides the trailing "(streaming)" line instead.
		const header = renderStatusLine(
			{
				title: "写入",
				description: `${langIcon} ${pathDisplay}`,
			},
			uiTheme,
		);
		const content = normalizeDisplayText(args.content);
		const streamingCache = createRenderedStringCache();
		return framedBlock(uiTheme, width => {
			const body = content
				? formatStreamingContent(
						content,
						Boolean(options?.expanded),
						lang,
						uiTheme,
						options?.spinnerFrame,
						streamingCache,
					)
				: "";
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: "pending",
				borderColor: "borderMuted",
				width,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		// xd:// dispatch results render as the mounted tool's own result.
		const xdev = result.details?.xdev;
		if (xdev) {
			const delegated = renderXdevResult(xdev, result, options, uiTheme, options.renderContext?.resolveXdevMounted);
			if (delegated) return delegated;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			return new Text(uiTheme.fg("toolOutput", replaceTabs(text)), 0, 0);
		}
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const filePath = shortenPath(rawPath);
		const fileContent = normalizeDisplayText(args?.content);
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		// The header shows the cwd-relative path but links to the absolute path the
		// write resolved to (args.path may be relative, which would yield a broken
		// `file://` URI). Falls back to plain text when the result lacks a path.
		const linkTarget = result.details?.resolvedPath;
		const styledPath = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const pathDisplay = filePath && linkTarget ? fileHyperlink(linkTarget, styledPath) : styledPath;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const header = renderStatusLine(
				{ icon: "error", title: "写入", description: `${langIcon} ${pathDisplay}` },
				uiTheme,
			);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const isPartial = options.isPartial === true;
		const progressText = result.content?.find(c => c.type === "text")?.text ?? "";
		const lineCount = countLines(fileContent);
		const lineSuffix = formatLineCountSuffix(lineCount, uiTheme);
		const execSuffix =
			!isPartial && result.details?.madeExecutable
				? `${uiTheme.fg("dim", " · ")}${uiTheme.fg("success", "已设为可执行!")}`
				: "";
		const header = renderStatusLine(
			{
				icon: isPartial ? "running" : undefined,
				iconOverride: isPartial ? undefined : uiTheme.styledSymbol("tool.write", "accent"),
				spinnerFrame: options.spinnerFrame,
				title: "写入",
				description: `${langIcon} ${pathDisplay}${lineSuffix}${execSuffix}`,
			},
			uiTheme,
		);
		const diagnostics = result.details?.diagnostics;

		const previewCache = createRenderedStringCache();
		return framedBlock(uiTheme, width => {
			const { expanded } = options;
			let body = renderContentPreview(fileContent, expanded, lang, uiTheme, previewCache);
			if (isPartial && progressText) {
				const safeProgressText = truncateToWidth(
					replaceTabs(progressText),
					TRUNCATE_LENGTHS.LINE,
					Ellipsis.Unicode,
				);
				body = `${uiTheme.fg("muted", safeProgressText)}${body ? `\n${body}` : ""}`;
			}
			if (!isPartial && diagnostics) {
				const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
					uiTheme.getLangIcon(getLanguageFromPath(fp)),
				);
				if (diagText.trim()) {
					const diagLines = diagText.split("\n");
					const firstNonEmpty = diagLines.findIndex(line => line.trim());
					if (firstNonEmpty >= 0) body += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
				}
			}
			const bodyLines = body.split("\n");
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				width,
			};
		});
	},
	mergeCallAndResult: true,
	// The collapsed pending preview follows the streaming edge with a tail
	// window once the content outgrows it (`… (N earlier lines)` + last rows);
	// the first partial result re-anchors the frame to the top of the file, so
	// tail rows already committed to viewport/native scrollback would survive
	// as stale content above the new frame without a full replay. Expanded and
	// short previews stay top-anchored and skip the (scrollback-wiping) reset.
	forceFirstResultViewportRepaint: (args: unknown, options: RenderResultOptions) =>
		!options.expanded && exceedsLineCount(writeContentOf(args), WRITE_STREAMING_PREVIEW_LINES),
};
