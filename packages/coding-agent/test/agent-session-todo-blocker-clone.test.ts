import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage: `AgentSession.#cloneTodoPhases` used to clone only
 * `{ content, status }`, dropping the `blocker` note on every set/get. That made
 * a blocker reason vanish on the first `todo view` or any later op even though it
 * appeared in the immediate tool result. The contract: a blocked task's reason
 * survives a `setTodoPhases` → `getTodoPhases` round-trip (the same clone every
 * storage read/write goes through).
 */
describe("AgentSession todo blocker clone", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-todo-blocker-clone-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true, "todo.reminders": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("preserves a blocker reason across a setTodoPhases/getTodoPhases round-trip", () => {
		session.setTodoPhases([
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "blocked", blocker: "waiting on sign-off" },
					{ content: "b", status: "pending" },
				],
			},
		]);

		const roundTripped = session.getTodoPhases();
		const blocked = roundTripped[0]?.tasks.find(task => task.content === "a");
		expect(blocked?.status).toBe("blocked");
		expect(blocked?.blocker).toBe("waiting on sign-off");
		// A task with no blocker must not gain one through the clone.
		const open = roundTripped[0]?.tasks.find(task => task.content === "b");
		expect(open?.blocker).toBeUndefined();
	});
});
