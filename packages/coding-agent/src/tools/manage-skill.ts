import * as path from "node:path";
import { type } from "@wxyhgk/omptype";
import type { AgentTool, AgentToolResult } from "@wxyhgk/pi-agent-core";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	sanitizeSkillName,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import manageSkillDescription from "../prompts/tools/manage-skill.md" with { type: "text" };
import type { ToolSession } from ".";

const manageSkillSchema = type({
	action: "'create' | 'update' | 'delete'",
	name: type("string").describe("kebab-case 格式的技能名称"),
	"description?": type("string").describe(
		"技能适用场景的一句话描述(create/update 必填)",
	),
	"body?": type("string").describe("SKILL.md 的 markdown 正文,不含 frontmatter(create/update 必填)"),
}).narrow(
	(p, ctx) =>
		p.action === "delete" ||
		(p.description !== undefined && p.body !== undefined) ||
		// Enforce the action/field contract at validation time rather than only in
		// execute. Kept as a cross-field narrow (not a discriminated union) so the
		// wire schema stays a single root object — strict structured-output mode and
		// the Anthropic tool-schema builder both require that.
		ctx.mustBe('用于 "create" 和 "update" 时必须同时提供 "description" 与 "body"'),
);

export type ManageSkillParams = typeof manageSkillSchema.infer;

/**
 * Direct create/update/delete of isolated managed skills. Gated behind
 * `autolearn.enabled`; backend-independent (the skill side is standalone).
 */
export class ManageSkillTool implements AgentTool<typeof manageSkillSchema> {
	readonly name = "manage_skill";
	readonly approval = "write" as const;
	readonly label = "管理技能";
	readonly description = manageSkillDescription;
	readonly parameters = manageSkillSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "创建、更新或删除独立的托管技能";

	constructor(private readonly refreshSkills?: () => Promise<void>) {}

	static createIf(session: ToolSession): ManageSkillTool | null {
		if (!session.settings.get("autolearn.enabled")) return null;
		return new ManageSkillTool(session.refreshSkills);
	}

	async execute(_id: string, params: ManageSkillParams): Promise<AgentToolResult> {
		if (params.action === "delete") {
			await deleteManagedSkill(params.name);
			await this.refreshSkills?.();
			return {
				content: [{ type: "text", text: `已删除托管技能 "${params.name}"。` }],
				details: { action: "delete", name: params.name },
			};
		}

		// Defensive narrowing: the schema refine already rejects create/update
		// without both fields, so this is unreachable for valid input — it only
		// proves the strings are present to `writeManagedSkill`'s typed contract.
		if (!params.description || !params.body) {
			throw new Error(`"${params.action}" 操作需要同时提供 "description" 和 "body"。`);
		}
		// A managed skill resolves below any authored skill of the same name
		// (authored always wins in discovery), so creating one under a name an
		// authored skill already claims writes a file that never surfaces. Refuse
		// up front rather than report a false "Created". `sanitizeSkillName`
		// normalizes to the on-disk name the discovery scan compares against.
		if (params.action === "create" && isNameClaimedByAuthoredSkill(sanitizeSkillName(params.name))) {
			return {
				content: [
					{
						type: "text",
						text: `无法创建托管技能 "${params.name}":同名的手写技能已存在,托管技能不能覆盖手写技能。请换一个名称。`,
					},
				],
				isError: true,
				details: { action: "create", name: params.name, shadowed: true },
			};
		}
		const { path: skillPath } = await writeManagedSkill({
			action: params.action,
			name: params.name,
			description: params.description,
			body: params.body,
		});
		await this.refreshSkills?.();
		const relativePath = path.relative(getManagedSkillsDir(), skillPath);
		const verb = params.action === "create" ? "已创建" : "已更新";
		return {
			content: [{ type: "text", text: `${verb}托管技能 "${params.name}"(managed-skills/${relativePath})。` }],
			details: { action: params.action, name: params.name },
		};
	}
}
