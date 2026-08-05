/**
 * Contracts: /vibe mode toggle on InteractiveMode.
 *
 * 1. Vibe tools do not exist in the session registry before the mode is entered.
 * 2. Entering registers and activates exactly `read`, parent-owned `todo`, plus
 *    the vibe tools.
 * 3. Exiting unregisters the vibe tools and restores the pre-vibe active toolset
 *    exactly, including the legitimate empty set.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function vibeModeEntryCount(manager: SessionManager): number {
	return manager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === "vibe").length;
}

class ExitFaultStorage extends FileSessionStorage {
	failNextAtomicWrite = false;
	#readGate:
		| {
				filePath: string;
				started: ReturnType<typeof Promise.withResolvers<void>>;
				release: ReturnType<typeof Promise.withResolvers<void>>;
		  }
		| undefined;

	gateNextRead(filePath: string): { started: Promise<void>; release: () => void } {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#readGate = { filePath, started, release };
		return { started: started.promise, release: release.resolve };
	}

	override async readTextSlices(
		filePath: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[string, string]> {
		const gate = this.#readGate;
		if (gate?.filePath === filePath) {
			this.#readGate = undefined;
			gate.started.resolve();
			await gate.release.promise;
		}
		return super.readTextSlices(filePath, prefixBytes, suffixBytes);
	}

	override async writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failNextAtomicWrite) {
			this.failNextAtomicWrite = false;
			throw Object.assign(new Error("journal atomic publish failed"), { code: "ENOSPC" });
		}
		await super.writeTextAtomic(filePath, content, options);
	}
}

describe("InteractiveMode vibe mode toggle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;
	let storage: ExitFaultStorage;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-vibe-toggle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		const registryTools = [stubTool("read"), stubTool("todo")];
		storage = new ExitFaultStorage();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path(), storage),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			builtInToolNames: registryTools.map(tool => tool.name),
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		VibeSessionRegistry.resetGlobalForTests();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("preserves the parent Todo tool and restores the exact pre-vibe toolset on exit", async () => {
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "todo"]);
		expect(session.getActiveToolNames()).toEqual([]);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		const inMode = session.getActiveToolNames();
		expect(inMode).toContain("read");
		expect(inMode).toContain("todo");
		for (const name of VIBE_TOOL_NAMES) {
			expect(inMode).toContain(name);
		}
		expect(inMode.toSorted()).toEqual(["read", "todo", ...VIBE_TOOL_NAMES].toSorted());
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "todo", ...VIBE_TOOL_NAMES].toSorted());

		const sendCustomMessage = vi.spyOn(session, "sendCustomMessage");
		await session.sendVibeModeContext({ deliverAs: "steer" });
		const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
		const content = typeof message.content === "string" ? message.content : "";
		expect(message.customType).toBe("vibe-mode-context");
		expect(content).toContain("`todo`");

		// Toggle off: the empty previous toolset must come back — only the
		// ephemeral vibe tools must leave the registry.
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "todo"]);
	});

	it("keeps a same-named non-built-in Todo tool unavailable in Vibe mode", async () => {
		const model = session.model;
		if (!model) throw new Error("Expected active model");
		const foreignTodoSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(["read", "todo"].map(name => [name, stubTool(name)])),
			builtInToolNames: ["read"],
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		const foreignTodoMode = new InteractiveMode(
			foreignTodoSession,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new EventBus(),
		);

		try {
			await foreignTodoMode.handleVibeModeCommand();
			expect(foreignTodoSession.getActiveToolNames().toSorted()).toEqual(["read", ...VIBE_TOOL_NAMES].toSorted());

			const sendCustomMessage = vi.spyOn(foreignTodoSession, "sendCustomMessage");
			await foreignTodoSession.sendVibeModeContext({ deliverAs: "steer" });
			const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
			const content = typeof message.content === "string" ? message.content : "";
			expect(content).not.toContain("`todo`");
			expect(content).not.toContain("parent session's list");

			await foreignTodoMode.handleVibeModeCommand();
			expect(foreignTodoSession.getActiveToolNames()).toEqual([]);
			expect(foreignTodoSession.getAllToolNames().toSorted()).toEqual(["read", "todo"]);
		} finally {
			foreignTodoMode.stop();
			await foreignTodoSession.dispose();
		}
	});

	it("preserves workers, Todo access, and mode metadata on a same-session reload", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const registry = VibeSessionRegistry.global();
		const suspend = vi.spyOn(registry, "suspendScope");
		const terminate = vi.spyOn(registry, "killAll");

		const readGate = storage.gateNextRead(sessionFile);
		const switching = session.switchSession(sessionFile);
		await readGate.started;
		const suspendCallsBeforeRead = suspend.mock.calls.length;
		readGate.release();
		expect(suspendCallsBeforeRead).toBe(1);
		expect(await switching).toBe(true);

		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "todo", ...VIBE_TOOL_NAMES]));
		const sendCustomMessage = vi.spyOn(session, "sendCustomMessage");
		await session.sendVibeModeContext({ deliverAs: "steer" });
		const message = normalizeCustomMessagePayload(sendCustomMessage.mock.calls[0]?.[0]);
		const content = typeof message.content === "string" ? message.content : "";
		expect(content).toContain("`todo`");
		expect(content).toContain("父会话的列表");
		expect(suspend).toHaveBeenCalledTimes(1);
		expect(terminate).not.toHaveBeenCalled();
		expect(vibeModeEntryCount(session.sessionManager)).toBe(1);
	});

	it("passes the session's active model into vibe rehydration on resume", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const expectedModel = session.model;
		if (!expectedModel) throw new Error("Expected an active session model");
		const registry = VibeSessionRegistry.global();
		let rehydrateCalled = false;
		let activeModelDuringRehydrate: string | undefined;
		vi.spyOn(registry, "rehydrate").mockImplementation(async parent => {
			rehydrateCalled = true;
			activeModelDuringRehydrate = parent.getActiveModelString?.();
			return 0;
		});

		expect(await session.switchSession(sessionFile)).toBe(true);

		// Rehydration must resolve workers against the reopened session's active
		// model (so the `good`/pi/task worker tracks it), not the settings default.
		expect(rehydrateCalled).toBe(true);
		expect(activeModelDuringRehydrate).toBe(`${expectedModel.provider}/${expectedModel.id}`);
	});

	it("suspends the old scope without tombstones when switching to another vibe parent", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const originalSessionId = session.sessionManager.getSessionId();
		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendModeChange("vibe");
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();
		const registry = VibeSessionRegistry.global();
		const suspend = vi.spyOn(registry, "suspendScope");
		const terminate = vi.spyOn(registry, "killAll");

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(mode.vibeModeEnabled).toBe(true);
		expect(suspend).toHaveBeenCalledTimes(1);
		expect(suspend.mock.calls[0]?.[0]).toMatchObject({ parentSessionId: originalSessionId });
		expect(terminate).not.toHaveBeenCalled();
		expect(vibeModeEntryCount(session.sessionManager)).toBe(1);
	});

	it("does not clobber the target's active tools with the source snapshot when switching out of vibe", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		// Pre-vibe snapshot on the source session is empty; entering vibe activates
		// read, parent-owned todo, and the vibe tools.
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getActiveToolNames()).toContain("read");

		// Target is a distinct, non-vibe session.
		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendModeChange("none");
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(mode.vibeModeEnabled).toBe(false);
		// The transient vibe tools are gone, but the genuinely-active `read` and
		// parent-owned `todo` tools must survive — the source's empty pre-vibe
		// snapshot must not wipe them.
		expect(session.getActiveToolNames()).toEqual(["read", "todo"]);
		for (const name of VIBE_TOOL_NAMES) {
			expect(session.getActiveToolNames()).not.toContain(name);
		}
	});

	it("rejects new, drop, fork, and move transitions at the AgentSession boundary while vibe is active", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");

		await expect(session.newSession()).rejects.toThrow("请先退出 vibe 模式");
		await expect(session.newSession({ drop: true })).rejects.toThrow("请先退出 vibe 模式");
		await expect(session.fork()).rejects.toThrow("请先退出 vibe 模式");
		await expect(session.moveSession(path.join(tempDir.path(), "other-project"))).rejects.toThrow(
			"请先退出 vibe 模式",
		);
		expect(session.sessionFile).toBe(sessionFile);
		expect(session.sessionManager.getCwd()).toBe(tempDir.path());
		expect(mode.vibeModeEnabled).toBe(true);
	});

	it("warns instead of rejecting for interactive session transitions while vibe is active", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const warning = vi.spyOn(mode, "showWarning");

		await expect(mode.handleClearCommand()).resolves.toBeUndefined();
		await expect(mode.handleDropCommand()).resolves.toBeUndefined();
		await expect(mode.handleForkCommand()).resolves.toBeUndefined();
		await expect(mode.handleMoveCommand(path.join(tempDir.path(), "other-project"))).resolves.toBeUndefined();

		expect(warning).toHaveBeenCalledTimes(4);
		expect(warning).toHaveBeenCalledWith("请先退出 Vibe 模式。");
		expect(session.sessionFile).toBe(sessionFile);
		expect(mode.vibeModeEnabled).toBe(true);
	});

	it("keeps vibe mode and tools active after a real storage failure, then allows a retry", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		const activeTools = session.getActiveToolNames();
		storage.failNextAtomicWrite = true;

		const exitError = await mode.handleVibeModeCommand().catch(error => error);
		expect(exitError).toBeInstanceOf(Error);
		expect(String(exitError)).toContain("journal atomic publish failed");

		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getVibeModeState()).toEqual({ enabled: true });
		expect(session.getActiveToolNames()).toEqual(activeTools);
		expect(vibeModeEntryCount(session.sessionManager)).toBe(1);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
	});
});
