/**
 * Coding-agent runner that drives the hashline {@link Patcher} on behalf of
 * the `edit` tool. Converts an `{input}` tool-call payload into a
 * fully-applied patch, wraps the result in the agent's
 * {@link AgentToolResult} shape, and attaches LSP diagnostics + `outputMeta`
 * for the renderer.
 *
 * Multi-section patches are preflighted up front via {@link Patcher.prepare}
 * so a partial batch never lands; the commit loop then narrows the LSP
 * batch's `flush` flag to true only for the final write so diagnostics
 * round-trip once.
 */
import {
	type BlockResolution,
	buildCompactDiffPreview,
	type Clipboard,
	commitClipboard,
	forkClipboard,
	MismatchError as HashlineMismatchError,
	Patch,
	Patcher,
	type PatchSectionResult,
	type PreparedSection,
	startClipboardBatch,
} from "@oh-my-pi/hashline";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { outputMeta } from "../../tools/output-meta";
import { ToolError } from "../../tools/tool-errors";
import { generateDiffString } from "../diff";
import { getEditClipboard } from "../edit-clipboard";
import { getFileSnapshotStore } from "../file-snapshot-store";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "../renderer";
import { pruneOversizedEditSnapshots } from "../snapshot-details";
import { nativeBlockResolver } from "./block-resolver";
import { HashlineFilesystem } from "./filesystem";
import { hashPatchInput, NOOP_HARD_LIMIT, recordNoopEdit, resetNoopEdit } from "./noop-loop-guard";
import { type HashlineParams, hashlineEditParamsSchema } from "./params";

export interface ExecuteHashlineSingleOptions {
	session: ToolSession;
	input: string;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

function noChangeDiagnostic(path: string): string {
	// The patch parsed and applied cleanly but produced no change — the
	// `+TEXT` body rows matched the file content at the targeted lines
	// byte-for-byte. The model usually misreads this as "wrong anchor, try
	// again with a bigger payload" and starts duplicating content; the
	// message below names the cause directly so the next turn can re-read
	// instead of expanding the patch.
	return (
		`对 ${path} 的编辑解析并应用成功,但未产生任何变更:` +
		`你的正文行与文件中目标行的字节完全相同。` +
		`问题出在其他地方——在发起下一次编辑前,请重新读取该文件。` +
		`不要扩大载荷或添加行;请先验证锚点。`
	);
}

/**
 * Escalated diagnostic surfaced once the same payload has no-op'd
 * {@link NOOP_HARD_LIMIT} times in a row on the same canonical path. Thrown as
 * a {@link ToolError} so the agent loop sees a tool *failure* — empirically
 * far more effective at breaking a no-op edit loop than the soft hint alone
 * (issue #2081 saw 182 byte-identical no-op results in 205 calls before the
 * user aborted).
 */
function noChangeLoopDiagnostic(path: string, count: number): string {
	return (
		`停止。对 ${path} 的编辑已连续 ${count} 次为字节相同的无操作——` +
		`补丁正文与文件中目标行的内容一致,而软提示未能打破这一循环。` +
		`请停止重新提交该载荷。要么预期的变更已在磁盘上(继续下一步),` +
		`要么你的锚点有误(使用 \`read\` 重新读取文件,观察当前行号和 ` +
		`标签,然后编写不同的编辑)。该载荷在改变之前会一直被拒绝。`
	);
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`多个 hashline 区块解析到同一个文件(${previous} 和 ${entry.section.path})。请在应用前将其操作合并到同一个标题下。`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

function narrowBatchRequest(outer: LspBatchRequest | undefined, isLast: boolean): LspBatchRequest | undefined {
	if (!outer) return undefined;
	return { id: outer.id, flush: isLast && outer.flush };
}

interface RenderedSection {
	toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>;
	perFileResult: EditToolPerFileResult;
}

const BLOCK_OP_LABELS: Record<BlockResolution["op"], string> = {
	replace: "PUT N*:",
	insert_after: "PUT >N*:",
	cut: "CUT N*",
	paste_after: "PUT >N*",
};

function formatBlockResolution(resolution: BlockResolution): string {
	const op = BLOCK_OP_LABELS[resolution.op].replace("N", String(resolution.anchorLine));
	const lines = resolution.end - resolution.start + 1;
	const span =
		resolution.start === resolution.end
			? `第 ${resolution.start} 行`
			: `第 ${resolution.start}-${resolution.end} 行`;
	const suffix =
		resolution.op === "insert_after"
			? `;正文落在第 ${resolution.end} 行之后`
			: resolution.op === "paste_after"
				? `;剪贴板内容落在第 ${resolution.end} 行之后`
				: "";
	return `${op} → 解析为 ${span}(共 ${lines} 行)${suffix}`;
}

function renderSection(
	result: PatchSectionResult,
	diagnostics: FileDiagnosticsResult | undefined,
	sourcePath: string,
): RenderedSection {
	if (result.op === "delete") {
		const toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema> = {
			content: [{ type: "text", text: `已删除 ${result.path}` }],
			details: pruneOversizedEditSnapshots({
				diff: "",
				op: "delete",
				path: result.path,
				oldText: result.before,
				meta: outputMeta().get(),
			}),
		};
		return {
			toolResult,
			perFileResult: pruneOversizedEditSnapshots({
				path: result.path,
				diff: "",
				op: "delete",
				oldText: result.before,
			}),
		};
	}

	if (result.op === "noop") {
		const toolResult: AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema> = {
			content: [{ type: "text", text: noChangeDiagnostic(result.path) }],
			details: { diff: "", op: "update", meta: outputMeta().get() },
		};
		return {
			toolResult,
			perFileResult: { path: result.path, diff: "", op: "update" },
		};
	}

	const diff = generateDiffString(result.before, result.after, undefined, { path: result.path });
	const preview = buildCompactDiffPreview(diff.diff);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	const warningsBlock = result.warnings.length > 0 ? `\n\n警告:\n${result.warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const blockBlock =
		result.blockResolutions && result.blockResolutions.length > 0
			? `\n${result.blockResolutions.map(formatBlockResolution).join("\n")}`
			: "";
	const moveBlock = result.moveDest ? `\n已移动到 ${result.moveDest}` : "";
	const firstChangedLine = result.firstChangedLine ?? diff.firstChangedLine;
	return {
		toolResult: {
			content: [
				{
					type: "text",
					text: `${result.header}${blockBlock}${moveBlock}${previewBlock}${warningsBlock}`,
				},
			],
			details: pruneOversizedEditSnapshots({
				diff: diff.diff,
				firstChangedLine,
				diagnostics,
				op: result.op,
				move: result.moveDest,
				path: result.moveDest ?? result.path,
				sourcePath: result.moveDest ? sourcePath : undefined,
				oldText: result.before,
				newText: result.after,
				meta,
			}),
		},
		perFileResult: pruneOversizedEditSnapshots({
			path: result.moveDest ?? result.path,
			diff: diff.diff,
			firstChangedLine,
			diagnostics,
			op: result.op,
			move: result.moveDest,
			sourcePath: result.moveDest ? sourcePath : undefined,
			oldText: result.before,
			newText: result.after,
		}),
	};
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const patch = Patch.parse(options.input, { cwd: options.session.cwd });
	if (patch.sections.length === 0) {
		throw new Error("输入中未找到任何 hashline 区块。");
	}

	const fs = new HashlineFilesystem({
		session: options.session,
		writethrough: options.writethrough,
		beginDeferredDiagnosticsForPath: options.beginDeferredDiagnosticsForPath,
		signal: options.signal,
		batchRequest: options.batchRequest,
	});
	const snapshots = getFileSnapshotStore(options.session);
	const enforceSeenLines = options.session.settings.get("edit.enforceSeenLines");
	const patcher = new Patcher({ fs, snapshots, blockResolver: nativeBlockResolver, enforceSeenLines });

	// Named registers persist across edit calls; the anonymous register is
	// batch-local. Each batch starts without anonymous state and publishes
	// named registers only after writes land.
	const sessionClipboard = getEditClipboard(options.session);
	const clipboard = startClipboardBatch(sessionClipboard);

	// Single-section fast path: prepare, commit, render.
	const inputHash = hashPatchInput(options.input);
	if (patch.sections.length === 1) {
		fs.setBatchRequest(narrowBatchRequest(options.batchRequest, true));
		const prepared = await patcher.prepare(patch.sections[0], clipboard);
		const sectionResult = await patcher.commit(prepared);
		commitClipboard(clipboard, sessionClipboard);
		if (sectionResult.op === "noop") {
			const { count, escalate } = recordNoopEdit(options.session, sectionResult.canonicalPath, inputHash);
			if (escalate) {
				throw new ToolError(noChangeLoopDiagnostic(sectionResult.path, count));
			}
			return renderSection(sectionResult, undefined, prepared.section.path).toolResult;
		}
		resetNoopEdit(options.session, sectionResult.canonicalPath);
		return renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path), prepared.section.path).toolResult;
	}

	// Multi-section: prepare every section up front so we fail fast before
	// any write hits the filesystem. One batch-local register spans the batch,
	// so `CUT` in one section feeds a register-backed `PUT` in a later one.
	const prepared: PreparedSection[] = [];
	// Register state after each section's prepare. Commits are non-atomic: a
	// mid-batch write failure leaves earlier sections on disk, so the session
	// register must reflect exactly the landed prefix — content a landed CUT
	// deleted would otherwise be lost.
	const sectionStates: Clipboard[] = [];
	for (const section of patch.sections) {
		prepared.push(await patcher.prepare(section, clipboard));
		sectionStates.push(forkClipboard(clipboard));
	}
	assertUniqueCanonicalPaths(prepared);
	for (const entry of prepared) {
		if (entry.isNoop) {
			const { count, escalate } = recordNoopEdit(options.session, entry.canonicalPath, inputHash);
			throw escalate
				? new ToolError(noChangeLoopDiagnostic(entry.section.path, count))
				: new ToolError(noChangeDiagnostic(entry.section.path));
		}
	}
	// Then commit each one, narrowing the LSP batch flush flag to the final
	// section only. A no-op apply mid-batch is treated as a hard failure —
	// the model authored anchors that match the current file content.
	const rendered: RenderedSection[] = [];
	for (let i = 0; i < prepared.length; i++) {
		const isLast = i === prepared.length - 1;
		fs.setBatchRequest(narrowBatchRequest(options.batchRequest, isLast));
		const sectionResult = await patcher.commit(prepared[i]);
		commitClipboard(sectionStates[i], sessionClipboard);
		if (sectionResult.op === "noop") {
			const { count, escalate } = recordNoopEdit(options.session, sectionResult.canonicalPath, inputHash);
			throw escalate
				? new ToolError(noChangeLoopDiagnostic(sectionResult.path, count))
				: new ToolError(noChangeDiagnostic(sectionResult.path));
		}
		resetNoopEdit(options.session, sectionResult.canonicalPath);
		rendered.push(renderSection(sectionResult, fs.consumeDiagnostics(sectionResult.path), prepared[i].section.path));
	}
	return {
		content: [
			{
				type: "text",
				text: rendered
					.map(r => r.toolResult.content.map(part => (part.type === "text" ? part.text : "")).join("\n"))
					.join("\n\n"),
			},
		],
		details: pruneOversizedEditSnapshots({
			diff: rendered.map(r => r.toolResult.details?.diff ?? "").join("\n"),
			perFileResults: rendered.map(r => r.perFileResult),
		}),
	};
}

export { HashlineMismatchError, type HashlineParams, hashlineEditParamsSchema };
