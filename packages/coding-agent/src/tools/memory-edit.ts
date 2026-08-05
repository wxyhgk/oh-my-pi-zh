import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("记忆编辑操作"),
	id: type("string").describe("来自 recall 输出的记忆 id"),
	"content?": type("string").describe("update 操作的替换内容"),
	"importance?": type("number").describe("update 操作的替换重要性(0–1)"),
	"replacement_id?": type("string").describe("invalidate 操作的替换记忆 id"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = "记忆编辑";
	readonly description = memoryEditDescription;
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "更新、遗忘或作废 Mnemopi 记忆";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "mnemopi") return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("此会话的 Mnemopi 后端尚未初始化。");
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit 的 update 操作需要提供 content 或 importance。");
		}

		const importance = params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance));
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` 位于 bank ${result.bank}${result.store ? `(${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? `未找到记忆 ${params.id}${location}。`
				: result.status === "not_editable"
					? `记忆 ${params.id} 是只读事实${location},无法编辑。可通过 memory://${params.id} 读取。`
					: `记忆 ${params.id} ${result.status}${location}。`;
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}
}
