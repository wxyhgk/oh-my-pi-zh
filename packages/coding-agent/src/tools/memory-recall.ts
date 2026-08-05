import { type } from "@wxyhgk/omptype";
import type { AgentTool, AgentToolResult } from "@wxyhgk/pi-agent-core";
import { logger, untilAborted } from "@wxyhgk/pi-utils";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRecallSchema = type({
	query: type("string").describe("自然语言搜索查询"),
});

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "回忆";
	readonly description = recallDescription;
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "搜索记忆中相关的历史上下文";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = this.session.settings.get("memory.backend");
			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("此会话的 Mnemopi 后端尚未初始化。");
				}
				try {
					const results = await state.recallResultsScoped(params.query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "未找到相关记忆。" }],
							details: {},
							useless: true,
						};
					}
					const formatted = state.formatScopedRecallWithIds(results);
					return {
						content: [
							{
								type: "text",
								text: `找到 ${results.length} 条相关记忆(截至 ${formatCurrentTime()} UTC):\n\n${formatted}`,
							},
						],
						details: {},
					};
				} catch (err) {
					logger.warn("recall 失败", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("此会话的 Hindsight 后端尚未初始化。");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "未找到相关记忆。" }],
						details: {},
						useless: true,
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `找到 ${results.length} 条相关记忆(截至 ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall 失败", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
