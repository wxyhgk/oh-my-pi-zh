/**
 * The `job` tool's snapshot contract: `list` and empty-poll results must never
 * come back as empty text, and they must surface running subagents that have
 * no backing job (irc-woken/revived agents, spawns owned by another agent) so
 * the tool's picture matches the UI's running-agent count. Regression for the
 * QA report "job list returned no status output despite known running
 * background jobs and subagents".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool } from "../src/tools/hub";

const managers: AsyncJobManager[] = [];

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	return manager;
}

function createToolSession(options: {
	manager?: AsyncJobManager;
	registry?: AgentRegistry;
	agentId?: string;
	lifecycle?: AgentLifecycleManager;
}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => (key === "async.pollWaitDuration" ? "5s" : undefined),
		},
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => options.agentId ?? null,
		asyncJobManager: options.manager,
		agentRegistry: options.registry,
		...(options.lifecycle ? { agentLifecycle: () => options.lifecycle } : {}),
	} as unknown as ToolSession;
}

function registerRunningSub(registry: AgentRegistry, id: string, parentId = "Main"): void {
	registry.register({ id, displayName: id, kind: "sub", parentId, session: null });
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

const neverResolves = () => new Promise<string>(() => {});

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.dispose({ timeoutMs: 200 });
	}
});

describe("hub jobs snapshot", () => {
	test("empty jobs snapshot reports 'no jobs' instead of empty output", async () => {
		const tool = new HubTool(createToolSession({ manager: createManager(), agentId: "Main" }));

		const result = await tool.execute("call", { op: "jobs" });

		expect(resultText(result)).toBe("没有后台 job。");
		expect((result.details as CoordinationDetails)?.jobs).toEqual([]);
	});

	test("list surfaces running subagents that have no backing job", async () => {
		const registry = new AgentRegistry();
		registerRunningSub(registry, "Worker");
		registerRunningSub(registry, "Idler");
		registry.setStatus("Idler", "idle");
		registry.register({ id: "advisor", displayName: "advisor", kind: "advisor", session: null });
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		const tool = new HubTool(createToolSession({ manager: createManager(), registry, agentId: "Main" }));

		const result = await tool.execute("call", { op: "jobs" });

		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["Worker"]);
		const text = resultText(result);
		expect(text).toContain("运行中的 Agent (1)");
		expect(text).toContain("Worker");
		expect(result.useless).toBeUndefined();
	});

	test("agents covered by the caller's running jobs are not double-listed", async () => {
		const manager = createManager();
		const registry = new AgentRegistry();
		// Task-style spawn: job id == agent id.
		manager.register("task", "AgentA", neverResolves, { id: "AgentA", agentId: "AgentA", ownerId: "Main" });
		registerRunningSub(registry, "AgentA");
		// Vibe-style turn job: job id differs from the agent id; linkage via agentId.
		manager.register("task", "vibe turn", neverResolves, { id: "vibe-1-t1", agentId: "vibe-1", ownerId: "Main" });
		registerRunningSub(registry, "vibe-1");
		// Woken via irc: running agent with no job at all.
		registerRunningSub(registry, "Loner");
		const tool = new HubTool(createToolSession({ manager, registry, agentId: "Main" }));

		const result = await tool.execute("call", { op: "jobs" });

		expect((result.details as CoordinationDetails)?.jobs?.map(job => job.id).sort()).toEqual(["AgentA", "vibe-1-t1"]);
		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["Loner"]);
		manager.cancel("AgentA");
		manager.cancel("vibe-1-t1");
	});

	test("a settled job in retention does not hide its re-woken agent", async () => {
		const manager = createManager();
		const registry = new AgentRegistry();
		manager.register("task", "AgentB", async () => "done", { id: "AgentB", agentId: "AgentB", ownerId: "Main" });
		await manager.waitForAll();
		// The agent was re-woken (e.g. via irc) after its job completed.
		registerRunningSub(registry, "AgentB");
		const tool = new HubTool(createToolSession({ manager, registry, agentId: "Main" }));

		const result = await tool.execute("call", { op: "jobs" });

		expect((result.details as CoordinationDetails)?.jobs?.find(job => job.id === "AgentB")?.status).toBe("completed");
		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["AgentB"]);
	});
});

describe("hub wait with no matching jobs", () => {
	test("bare wait with nothing running stays a useless no-op message", async () => {
		const tool = new HubTool(createToolSession({ manager: createManager(), agentId: "Main" }));

		const result = await tool.execute("call", { op: "wait" });

		expect(resultText(result)).toBe("没有正在运行的后台 job 可等待。");
		expect(result.useless).toBe(true);
	});

	test("bare wait reports running agents outside job control", async () => {
		const registry = new AgentRegistry();
		registerRunningSub(registry, "Worker");
		const tool = new HubTool(createToolSession({ manager: createManager(), registry }));

		const result = await tool.execute("call", { op: "wait" });

		const text = resultText(result);
		expect(text).toContain("没有正在运行的后台 job 可等待。");
		expect(text).toContain("Worker");
		expect((result.details as CoordinationDetails)?.agents?.map(agent => agent.id)).toEqual(["Worker"]);
		expect(result.useless).toBeUndefined();
	});

	test("waiting on an agent id that has no job explains the agent's state", async () => {
		const registry = new AgentRegistry();
		registerRunningSub(registry, "Worker");
		const tool = new HubTool(createToolSession({ manager: createManager(), registry, agentId: "Main" }));

		const result = await tool.execute("call", { op: "wait", ids: ["Worker"] });

		const text = resultText(result);
		expect(text).toContain("未找到与 ID 匹配的 job: Worker");
		expect(text).toContain("运行中的 Agent,但没有对应的 job");
		expect(text).toContain("history://Worker");
	});
});

describe("hub cancel of a non-job-backed agent registration (#6315)", () => {
	function fakeSession() {
		let aborts = 0;
		let disposes = 0;
		const session = {
			abort: async () => {
				aborts += 1;
			},
			dispose: async () => {
				disposes += 1;
			},
		};
		return { session, abortCalls: () => aborts, disposeCalls: () => disposes };
	}

	test("cancel kills an owned idle agent that has no backing job", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const fake = fakeSession();
		registry.register({
			id: "Zombie",
			displayName: "Zombie",
			kind: "sub",
			parentId: "Main",
			session: fake.session as never,
			status: "idle",
		});
		lifecycle.adopt("Zombie", { idleTtlMs: 0 });
		const tool = new HubTool(createToolSession({ manager: createManager(), registry, agentId: "Main", lifecycle }));

		const result = await tool.execute("call", { op: "cancel", ids: ["Zombie"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Zombie", status: "cancelled" }]);
		expect(resultText(result)).toContain("已取消 Agent Zombie");
		// The registration is gone: dropped from the registry and lifecycle.
		expect(registry.get("Zombie")).toBeUndefined();
		expect(lifecycle.has("Zombie")).toBe(false);
		expect(fake.disposeCalls()).toBe(1);
	});

	test("cancel aborts the in-flight turn of a running agent before releasing it", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const fake = fakeSession();
		registry.register({
			id: "Runner",
			displayName: "Runner",
			kind: "sub",
			parentId: "Main",
			session: fake.session as never,
			status: "running",
		});
		lifecycle.adopt("Runner", { idleTtlMs: 0 });
		const tool = new HubTool(createToolSession({ manager: createManager(), registry, agentId: "Main", lifecycle }));

		const result = await tool.execute("call", { op: "cancel", ids: ["Runner"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Runner", status: "cancelled" }]);
		expect(fake.abortCalls()).toBe(1);
		expect(fake.disposeCalls()).toBe(1);
		expect(registry.get("Runner")).toBeUndefined();
	});

	test("cancel refuses an agent spawned by someone else", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const fake = fakeSession();
		registry.register({
			id: "OtherKid",
			displayName: "OtherKid",
			kind: "sub",
			parentId: "SomeoneElse",
			session: fake.session as never,
			status: "idle",
		});
		const tool = new HubTool(createToolSession({ manager: createManager(), registry, agentId: "Main", lifecycle }));

		const result = await tool.execute("call", { op: "cancel", ids: ["OtherKid"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "OtherKid", status: "not_found" }]);
		expect(registry.get("OtherKid")).toBeDefined();
		expect(fake.disposeCalls()).toBe(0);
	});

	test("cancel of a truly unknown id still reports not_found", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const tool = new HubTool(createToolSession({ manager: createManager(), registry, agentId: "Main", lifecycle }));

		const result = await tool.execute("call", { op: "cancel", ids: ["Ghost"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Ghost", status: "not_found" }]);
		expect(resultText(result)).toContain("未找到后台 job: Ghost");
	});
	test("cancel kills the registration even while the settled job row is still retained", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const fake = fakeSession();
		const manager = createManager();
		// Job id == agent id for task spawns; the settled row survives ~5 min
		// after the budget abort while the keep-alive registration lives on.
		manager.register("task", "Zombie", async () => "done", { id: "Zombie", agentId: "Zombie", ownerId: "Main" });
		await manager.waitForAll();
		registry.register({
			id: "Zombie",
			displayName: "Zombie",
			kind: "sub",
			parentId: "Main",
			session: fake.session as never,
			status: "idle",
		});
		lifecycle.adopt("Zombie", { idleTtlMs: 0 });
		const tool = new HubTool(createToolSession({ manager, registry, agentId: "Main", lifecycle }));

		const result = await tool.execute("call", { op: "cancel", ids: ["Zombie"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([{ id: "Zombie", status: "cancelled" }]);
		expect(registry.get("Zombie")).toBeUndefined();
		expect(lifecycle.has("Zombie")).toBe(false);
		expect(fake.disposeCalls()).toBe(1);
	});

	test("cancel of a settled job with no lingering registration stays already_completed", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const manager = createManager();
		manager.register("task", "DoneJob", async () => "done", { id: "DoneJob", agentId: "DoneJob", ownerId: "Main" });
		await manager.waitForAll();
		const tool = new HubTool(createToolSession({ manager, registry, agentId: "Main", lifecycle }));

		const result = await tool.execute("call", { op: "cancel", ids: ["DoneJob"] });

		expect((result.details as CoordinationDetails)?.cancelled).toEqual([
			{ id: "DoneJob", status: "already_completed" },
		]);
		expect(resultText(result)).toContain("已完成");
	});
});
