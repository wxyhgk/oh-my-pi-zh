import { type } from "@wxyhgk/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@wxyhgk/pi-agent-core";
import { prompt } from "@wxyhgk/pi-utils";
import checkpointDescription from "../prompts/tools/checkpoint.md" with { type: "text" };
import rewindDescription from "../prompts/tools/rewind.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
}

export interface CompletedRewindState {
	/** Report retained after a successful rewind. */
	report: string;
	/** Timestamp for the checkpoint that was rewound. */
	startedAt: string;
	/** Timestamp when the rewind completed. */
	rewoundAt: string;
}

const checkpointSchema = type({
	goal: type("string").describe("调查目标"),
});

type CheckpointParams = typeof checkpointSchema.infer;

const rewindSchema = type({
	report: type("string").describe("调查结果"),
});

type RewindParams = typeof rewindSchema.infer;

export interface CheckpointToolDetails {
	goal: string;
	startedAt: string;
	meta?: OutputMeta;
}

export interface RewindToolDetails {
	report: string;
	rewound: boolean;
	meta?: OutputMeta;
}

export class CheckpointTool implements AgentTool<typeof checkpointSchema, CheckpointToolDetails> {
	readonly name = "checkpoint";
	readonly approval = "read" as const;
	readonly label = "检查点";
	readonly summary = "创建基于 git 的检查点以保存和恢复会话状态";
	readonly description: string;
	readonly parameters = checkpointSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<CheckpointParams>) => (args.goal ? `检查点: ${args.goal}` : "检查点");

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(checkpointDescription);
	}

	static createIf(session: ToolSession): CheckpointTool | null {
		return new CheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckpointToolDetails>> {
		if (this.session.getCheckpointState?.()) {
			throw new ToolError("检查点已处于活动状态。");
		}
		const startedAt = new Date().toISOString();
		return toolResult<CheckpointToolDetails>({ goal: params.goal, startedAt })
			.text(
				[
					"检查点已创建。",
					`目标: ${params.goal}`,
					"运行调查后,使用简明的报告调用 rewind。",
				].join("\n"),
			)
			.done();
	}
}

export class RewindTool implements AgentTool<typeof rewindSchema, RewindToolDetails> {
	readonly name = "rewind";
	readonly approval = "read" as const;
	readonly label = "回退";
	readonly summary = "回退到之前创建的检查点";
	readonly description: string;
	readonly parameters = rewindSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (): string => "回退中";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(rewindDescription);
	}

	static createIf(session: ToolSession): RewindTool | null {
		return new RewindTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RewindParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RewindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RewindToolDetails>> {
		if (!this.session.getCheckpointState?.()) {
			if (this.session.getLastCompletedRewind?.()) {
				throw new ToolError(
					"检查点已完成;请直接使用保留的回退报告,而不是再次调用 rewind。",
				);
			}
			throw new ToolError("没有活动中的检查点。调用 rewind 前请先创建检查点。");
		}
		const report = params.report.trim();
		if (report.length === 0) {
			throw new ToolError("报告不能为空。");
		}
		return toolResult<RewindToolDetails>({ report, rewound: true })
			.text(["已请求回退。", "已捕获报告用于上下文替换。"].join("\n"))
			.done();
	}
}
