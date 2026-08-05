import { describe, expect, it } from "bun:test";
import { prompt } from "@wxyhgk/pi-utils";
import planModeActivePrompt from "../../src/prompts/system/plan-mode-active.md" with { type: "text" };

const BASE = {
	planFilePath: "local://old-feature-plan.md",
	askToolName: "ask",
	writeToolName: "write",
	editToolName: "edit",
	isHashlineEditMode: false,
	iterative: false,
} as const;

function render(overrides: { reentry: boolean; planExists: boolean }): string {
	return prompt.render(planModeActivePrompt, { ...BASE, ...overrides });
}

describe("plan-mode re-entry prompt", () => {
	it("只会在重新进入时输出重新进入段落", () => {
		expect(render({ reentry: false, planExists: true })).not.toContain("## 重新进入");
		expect(render({ reentry: true, planExists: true })).toContain("## 重新进入");
	});
});
