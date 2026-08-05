import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatNumber, prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import { formatDuration } from "../../slash-commands/helpers/format";
import type { ToolSession } from "../../tools";
import { formatErrorDetail, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { framedBlock, renderStatusLine, truncateToWidth } from "../../tui";
import { completionBudgetReport, remainingTokens } from "../runtime";
import type { Goal, GoalStatus, GoalToolDetails } from "../state";

const goalSchema = type({
	op: type("'create' | 'get' | 'complete' | 'resume' | 'drop'").describe("目标操作"),
	"objective?": type("string").describe("目标描述"),
	"token_budget?": type("number.integer").describe("token 预算"),
});

export type GoalToolInput = typeof goalSchema.infer;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null,
	};
}

function validateCreateParams(params: GoalToolInput): { objective: string; tokenBudget?: number } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError("op=create 时必须提供 objective");
	}
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("提供 token_budget 时必须为正整数");
	}
	return { objective, tokenBudget };
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "目标";
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) {
			throw new ToolError("目标模式未启用。");
		}

		let response: GoalToolResponse;
		if (params.op === "create") {
			const created = await runtime.createGoal(validateCreateParams(params));
			response = buildGoalToolResponse(created.goal);
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null);
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal);
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null);
		} else {
			const completed = await runtime.completeGoalFromTool();
			response = buildGoalToolResponse(completed, { includeCompletionReport: true });
		}
		let text: string;
		if (response.goal) {
			text = `目标:${response.goal.objective}\n状态:${response.goal.status}\n已用 tokens:${response.goal.tokensUsed}`;
			if (response.goal.tokenBudget !== undefined) {
				text += ` / ${response.goal.tokenBudget} 预算`;
			}
			if (response.remainingTokens !== null) {
				text += `\n剩余 tokens:${response.remainingTokens}`;
			}
			if (response.completionBudgetReport) {
				text += `\n\n${response.completionBudgetReport}`;
			}
		} else {
			text = "当前没有活动目标。";
		}
		return {
			content: [{ type: "text", text }],
			details: {
				op: params.op,
				goal: response.goal,
				remainingTokens: response.remainingTokens,
				completionBudgetReport: response.completionBudgetReport,
			},
		};
	}
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "设置";
		case "complete":
			return "完成";
		case "get":
			return "检查";
		case "resume":
			return "恢复";
		case "drop":
			return "移除";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
	token_budget?: number;
}

export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		if (args.op === "create" && args.token_budget !== undefined) {
			meta.push(`预算 ${formatNumber(args.token_budget)}`);
		}
		return new Text(renderStatusLine({ icon: "pending", title: "目标", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "目标", description }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(fallbackText || "Goal 工具执行失败", uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			return new Text(
				renderStatusLine({ icon: "warning", title: "目标", description, meta: ["当前没有活动目标"] }, uiTheme),
				0,
				0,
			);
		}

		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.goal", "accent"),
				title: "目标",
				description,
				badge: { label: goal.status, color: goalBadgeColor(goal.status) },
			},
			uiTheme,
		);

		const lines: string[] = [];
		const objectiveText = truncateToWidth(goal.objective.trim(), TRUNCATE_LENGTHS.LONG);
		lines.push(uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`)));

		const used = formatNumber(goal.tokensUsed);
		const tokensLine =
			goal.tokenBudget !== undefined
				? `${used} / ${formatNumber(goal.tokenBudget)} tokens(剩余 ${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))})`
				: `${used} tokens`;
		const metaParts = [tokensLine];
		if (goal.timeUsedSeconds > 0) {
			metaParts.push(`${formatDuration(goal.timeUsedSeconds * 1000)} 已耗时`);
		}
		lines.push(uiTheme.fg("dim", metaParts.join(" · ")));

		const report = details?.completionBudgetReport;
		const sections: Array<{ label?: string; lines: string[] }> = [{ lines }];
		if (report) {
			sections.push({ label: "报告", lines: report.split("\n").map(line => uiTheme.fg("muted", line)) });
		}

		return framedBlock(uiTheme, width => ({
			header,
			sections,
			state: "success",
			borderColor: "borderMuted",
			width,
		}));
	},

	mergeCallAndResult: true,
};
