import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { localBackend } from "../memory-backend/local-backend";
import learnDescription from "../prompts/tools/learn.md" with { type: "text" };
import type { ToolSession } from ".";

const learnSchema = type({
	memory: type("string").describe("要记住的持久、自包含的经验教训(是什么、何时、为什么)"),
	"context?": type("string").describe("该经验教训的可选来源上下文"),
	"skill?": type({
		action: "'create' | 'update'",
		name: type("string").describe("kebab-case 技能名称"),
		description: type("string").describe("何时使用该技能的一行描述"),
		body: type("string").describe("SKILL.md 的 markdown 正文(不含 frontmatter)"),
	}).describe("在同一调用中同时创建或增强托管技能"),
});

export type LearnParams = typeof learnSchema.infer;

/**
 * Orchestrating "learn" tool: persists a lesson to long-term memory and,
 * given a `skill` payload, mints/enhances a managed skill via the shared
 * `writeManagedSkill` primitive. Gated behind `autolearn.enabled` plus a live
 * memory backend — `hindsight`/`mnemopi` (remote/SQLite) or `local` (the
 * file-based rollout backend, where lessons append to `learned.md`).
 */
export class LearnTool implements AgentTool<typeof learnSchema> {
	readonly name = "learn";
	readonly approval = (args: unknown) =>
		(args as Partial<LearnParams>).skill || this.session.settings.get("memory.backend") === "local"
			? "write"
			: "read";
	readonly label = "学习";
	readonly description = learnDescription;
	readonly parameters = learnSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "将可复用的经验教训存入记忆(可选同时创建托管技能)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LearnTool | null {
		if (!session.settings.get("autolearn.enabled")) return null;
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "local") return null;
		return new LearnTool(session);
	}

	async execute(_id: string, params: LearnParams): Promise<AgentToolResult> {
		// 1) Persist or queue the lesson to long-term memory (mirrors MemoryRetainTool).
		const backend = this.session.settings.get("memory.backend");
		let memoryMessage = "经验教训已存储";
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("此会话的 Mnemopi 后端尚未初始化。");
			}
			const id = state.rememberScoped(params.memory, {
				source: "coding-agent-learn",
				importance: 0.8,
				metadata: {
					session_id: state.sessionId,
					cwd: state.session.sessionManager.getCwd(),
					context: params.context ?? null,
					tool: "learn",
				},
				scope: "bank",
				extract: true,
				extractEntities: true,
				veracity: "tool",
				memoryType: "fact",
			});
			// rememberScoped returns undefined when the retain failed (closed DB /
			// disk error); mirror mnemopiBackend.save and fail loudly rather than
			// reporting (and minting a skill for) a lesson that was silently dropped.
			if (!id) {
				throw new Error("Mnemopi 未能存储经验教训(未返回记忆 ID)。");
			}
		} else if (backend === "local") {
			const result = await localBackend.save?.(
				{ agentDir: this.session.settings.getAgentDir(), cwd: this.session.settings.getCwd() },
				{ content: params.memory, context: params.context, source: "coding-agent-learn", importance: 0.8 },
			);
			if (!result || result.stored === 0) {
				throw new Error("经验教训经清理后为空;未存储任何内容。");
			}
		} else {
			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("此会话的 Hindsight 后端尚未初始化。");
			}
			state.enqueueRetain(params.memory, params.context);
			memoryMessage = "经验教训已排队等待留存";
		}

		// 2) Optionally mint/enhance a managed skill. A failure here is surfaced
		// as a partial outcome — the lesson is already stored or queued.
		if (params.skill) {
			// A managed skill resolves below any authored skill of the same name, so
			// minting one under a claimed name writes a file that never surfaces. The
			// lesson is already stored/queued; refuse the skill rather than report a
			// false "Created" (mirrors ManageSkillTool).
			let safeSkillName: string | undefined;
			try {
				safeSkillName = sanitizeSkillName(params.skill.name);
			} catch {
				safeSkillName = undefined;
			}
			if (params.skill.action === "create" && safeSkillName && isNameClaimedByAuthoredSkill(safeSkillName)) {
				return {
					content: [
						{
							type: "text",
							text: `${memoryMessage}。未创建托管技能 "${params.skill.name}":同名的手写技能已存在,托管技能不能覆盖手写技能。请换一个名称。`,
						},
					],
					isError: true,
					details: { skill: null, shadowed: true },
				};
			}
			try {
				await writeManagedSkill(params.skill);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${memoryMessage},但托管技能写入失败: ${reason}`);
			}
			const verb = params.skill.action === "create" ? "已创建" : "已更新";
			return {
				content: [{ type: "text", text: `${memoryMessage}。${verb}托管技能 "${params.skill.name}"。` }],
				details: { skill: params.skill.name },
			};
		}

		return {
			content: [{ type: "text", text: `${memoryMessage}。` }],
			details: { skill: null },
		};
	}
}
