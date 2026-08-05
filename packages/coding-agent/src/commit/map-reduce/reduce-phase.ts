import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import reduceSystemPrompt from "../../commit/prompts/reduce-system.md" with { type: "text" };
import reduceUserPrompt from "../../commit/prompts/reduce-user.md" with { type: "text" };
import type { ConventionalAnalysis, FileObservation } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { createConventionalAnalysisTool, parseConventionalAnalysisResponse } from "../shared-llm";

const ReduceTool = createConventionalAnalysisTool("将文件观察结果综合为约定式提交分析。");

export interface ReducePhaseInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	observations: FileObservation[];
	stat: string;
	scopeCandidates: string;
	typesDescription?: string;
}

export async function runReducePhase({
	model,
	apiKey,
	thinkingLevel,
	observations,
	stat,
	scopeCandidates,
	typesDescription,
}: ReducePhaseInput): Promise<ConventionalAnalysis> {
	const userContent = prompt.render(reduceUserPrompt, {
		types_description: typesDescription,
		observations: observations.flatMap(obs => obs.observations.map(line => `- ${obs.file}: ${line}`)).join("\n"),
		stat,
		scope_candidates: scopeCandidates,
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: [prompt.render(reduceSystemPrompt)],
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [ReduceTool],
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel) },
	);

	return parseConventionalAnalysisResponse(response, ReduceTool);
}
