import { type } from "@wxyhgk/omptype";
import type { AgentTool, AgentToolResult } from "@wxyhgk/pi-agent-core";
import { logger, untilAborted } from "@wxyhgk/pi-utils";
import { ensureBankExists } from "../hindsight/bank";
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryReflectSchema = type({
	query: type("string").describe("要回答的问题"),
	"context?": type("string").describe("可选上下文"),
});

export type MemoryReflectParams = typeof memoryReflectSchema.infer;

export class MemoryReflectTool implements AgentTool<typeof memoryReflectSchema> {
	readonly name = "reflect";
	readonly approval = "read" as const;
	readonly label = "反思";
	readonly description = reflectDescription;
	readonly parameters = memoryReflectSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "综合长期记忆生成答案";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryReflectTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		return new MemoryReflectTool(session);
	}

	async execute(_id: string, params: MemoryReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = this.session.settings.get("memory.backend");
			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("此会话的 Mnemopi 后端尚未初始化。");
				}

				try {
					const query = params.context?.trim()
						? `${params.query.trim()}\n\n附加上下文:\n${params.context.trim()}`
						: params.query;
					const results = await state.recallResultsScoped(query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "未找到可据以思考的相关信息。" }],
							details: {},
						};
					}
					const summary = state.formatContextScoped(results);
					return {
						content: [{ type: "text", text: `基于回忆到的记忆:\n\n${summary}` }],
						details: {},
					};
				} catch (err) {
					logger.warn("reflect 失败", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("此会话的 Hindsight 后端尚未初始化。");
			}

			try {
				await ensureBankExists(state.client, state.bankId, state.config, state.banksSet);
				const response = await state.client.reflect(state.bankId, params.query, {
					context: params.context,
					budget: state.config.recallBudget,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const text = response.text?.trim() || "未找到可据以思考的相关信息。";
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			} catch (err) {
				logger.warn("reflect 失败", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
