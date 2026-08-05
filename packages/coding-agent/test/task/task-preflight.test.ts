import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@wxyhgk/pi-coding-agent/async/job-manager";
import { Settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@wxyhgk/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@wxyhgk/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@wxyhgk/pi-coding-agent/task";
import * as discoveryModule from "@wxyhgk/pi-coding-agent/task/discovery";
import * as executorModule from "@wxyhgk/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@wxyhgk/pi-coding-agent/task/types";
import type { ToolSession } from "@wxyhgk/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: {
	manager: AsyncJobManager;
	settings?: Record<string, unknown>;
	spawns?: string | boolean;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, ...options.settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function resultFor(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agents: AgentDefinition[] = [taskAgent]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

describe("task async preflight", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function manager(): AsyncJobManager {
		const result = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(result);
		return result;
	}

	it.each([
		{
			name: "Unknown",
			params: { agent: "missing", name: "Unknown", task: "Work." },
			expectation: '未知 Agent "missing"',
		},
		{
			name: "Disabled",
			params: { agent: "task", name: "Disabled", task: "Work." },
			settings: { "task.disabledAgents": ["task"] },
			expectation: 'Agent "task" 已在设置中禁用',
		},
		{
			name: "Disallowed",
			params: { agent: "task", name: "Disallowed", task: "Work." },
			spawns: "scout",
			expectation: "无法派生 'task'",
		},
	])(
		"returns $name policy errors before registering an async job",
		async ({ name, params, settings, spawns, expectation }) => {
			mockDiscovery();
			const jobs = manager();
			const tool = await TaskTool.create(createSession({ manager: jobs, settings, spawns }));

			const result = await tool.execute("preflight", params as TaskParams);

			expect(textOf(result)).toContain(expectation);
			expect(jobs.getJob(name)).toBeUndefined();
		},
	);

	it("rejects an invalid async batch atomically before dispatching any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(createSession({ manager: jobs, settings: { "task.batch": true } }));

		const result = await tool.execute("mixed-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "AlsoInvalid", agent: "also-missing", task: "Do more invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		const text = textOf(result);
		expect(text).toContain('任务 Invalid 预检失败:未知 Agent "missing"');
		expect(text).toContain('任务 AlsoInvalid 预检失败:未知 Agent "also-missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("AlsoInvalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});

	it("rejects an invalid synchronous batch before running any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(
			createSession({ manager: jobs, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("sync-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		expect(textOf(result)).toContain('任务 Invalid 预检失败:未知 Agent "missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});
});
