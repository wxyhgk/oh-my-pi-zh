import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	type CreateAgentSessionOptions,
	type CustomTool,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: type({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

const sdkCustomTool = {
	name: "sdk_custom_tool",
	label: "SDK Custom Tool",
	description: "SDK-provided custom tool used to verify activation boundaries.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text", text: "sdk custom" }] };
	},
} satisfies CustomTool;

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];

	// Built once and shared by every session. `ModelRegistry` eagerly loads all
	// bundled + cached models and `discoverAuthStorage` opens the auth DB — the
	// dominant (~50ms) slice of a cold boot, and identical for every test here.
	// Injecting it drops each per-test boot to the ~4ms of activation-specific work
	// these tests vary, and skips the background model refresh the SDK would
	// otherwise start when it builds its own registry.
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	// Shared options for every session. `rules: []` and `workspaceTree` short-circuit
	// the two slow startup scans (rule discovery + native workspace walk, ~100ms each)
	// that are irrelevant to tool activation: these tests assert only which tools are
	// registered/active and that tool names appear in the system prompt. The shared
	// `modelRegistry` is injected here; each call still returns fresh
	// `settings`/`sessionManager` instances to keep tests isolated.
	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}

		vi.restoreAllMocks();
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			// Discoverable extension tools mount as xd:// devices, not top-level active tools.
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_active_tool");
			expect(deviceNames).not.toContain("default_inactive_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("forwards built-in and external xd:// devices to Cursor provider contexts", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			model: cursorModel,
		});
		const externalMcpTool: CustomTool = {
			name: "mcp__fixture_report",
			label: "fixture/report",
			description: "Report a fixture result.",
			parameters: type({}),
			strict: true,
			mcpServerName: "fixture",
			mcpToolName: "report",
			async execute() {
				return { content: [{ type: "text", text: "reported" }] };
			},
		};

		try {
			await session.refreshMCPTools([externalMcpTool]);
			const deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			expect(deviceNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
			expect(session.getActiveToolNames()).not.toContain("mcp__fixture_report");

			const context = await session.agent.buildSideRequestContext([]);
			const providerToolNames = context.tools?.map(tool => tool.name);
			expect(providerToolNames).toEqual(expect.arrayContaining(["ast_edit", "mcp__fixture_report"]));
		} finally {
			await session.dispose();
		}
	});

	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_inactive_tool", "default_active_tool"]),
			);
			// No granted write tool → no xd:// transport: extension tools surface
			// top-level instead of mounting with an auto-granted write.
			expect(session.getActiveToolNames()).not.toContain("write");
			expect(session.getXdevToolEntries()).toEqual([]);
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("activates the yield tool when requireYieldTool is set and toolNames is explicit", async () => {
		// Regression for #1408: plan-mode subagents pass an explicit `toolNames` list
		// (e.g. `["read", "grep", "glob", "lsp", "web_search"]`). Without this
		// invariant, `yield` ended up registered but not active, and the model
		// could not satisfy the idle-reminder contract that demands a `yield` call.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			requireYieldTool: true,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	});

	it("normalizes legacy builtin toolNames before selecting the active SDK tools", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "search", "find"],
		});

		try {
			const activeToolNames = session.getActiveToolNames();

			expect(activeToolNames).toContain("read");
			expect(activeToolNames).toContain("grep");
			expect(activeToolNames).toContain("glob");
			expect(activeToolNames).not.toContain("search");
			expect(activeToolNames).not.toContain("find");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the write tool registered for plan mode even when no deferrable tool is requested", async () => {
		// Regression for #1428 (adapted to the xd://propose device): plan mode
		// submits its finalized plan by writing the chosen slug/title to
		// xd://propose, dispatched through the plan-proposal handler
		// (interactive-mode.ts: `setPlanProposalHandler`). With an explicit
		// read-only `toolNames` (e.g. `read`, `search`, `find`, `web_search`)
		// the registry has no `write` and no `deferrable` tool; dropping it would
		// silently activate plan mode with no way to submit the plan.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("write")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not force write into the registry when neither a deferrable tool nor plan mode needs it", async () => {
		const tempDir = makeTempDir();

		const settings = Settings.isolated();
		settings.set("plan.enabled", false);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("write")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not activate write merely because plan mode is available", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read"]);
			expect(session.getActiveToolNames()).not.toContain("write");
		} finally {
			await session.dispose();
		}
	});

	it("preserves write explicitly selected by a runtime caller", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read"],
		});

		try {
			await session.setActiveToolsByName(["read", "write"]);
			await session.refreshMCPTools([]);
			expect(session.getActiveToolNames()).toContain("write");
		} finally {
			await session.dispose();
		}
	});
	it("registers vibe tools only during explicit vibe activation and exposes parent Todo bookkeeping", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession(baseOptions(tempDir));
		const previousActiveToolNames = session.getActiveToolNames();

		try {
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}

			await session.activateVibeTools(["read", "todo"]);
			const todo = session.getToolByName("todo");
			if (!todo) throw new Error("Expected real Todo tool");
			expect(session.getActiveToolNames()).toContain("todo");
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeDefined();
				expect(session.getActiveToolNames()).toContain(name);
			}

			await todo.execute("vibe-todo-init", {
				op: "init",
				list: [{ phase: "Work", items: ["Worker change"] }],
			});
			await todo.execute("vibe-todo-done", { op: "done", task: "Worker change" });
			expect(session.getTodoPhases()).toMatchObject([
				{
					name: "Work",
					tasks: [{ content: "Worker change", status: "completed" }],
				},
			]);

			await session.deactivateVibeTools(previousActiveToolNames);
			for (const name of VIBE_TOOL_NAMES) {
				expect(session.getToolByName(name)).toBeUndefined();
			}
			expect(session.getActiveToolNames()).toEqual(previousActiveToolNames);
		} finally {
			await session.dispose();
		}
	});

	it("rehydrates completed parent Todo work from persisted session history", async () => {
		const tempDir = makeTempDir();
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			sessionManager,
		});

		try {
			await session.activateVibeTools(["read", "todo"]);
			const todo = session.getToolByName("todo");
			if (!todo) throw new Error("Expected real Todo tool");
			const init = await todo.execute("vibe-todo-init", {
				op: "init",
				list: [{ phase: "Worker flow", items: ["Reconcile worker result"] }],
			});
			const done = await todo.execute("vibe-todo-done", { op: "done", task: "Reconcile worker result" });
			for (const [toolCallId, result] of [
				["vibe-todo-init", init],
				["vibe-todo-done", done],
			] as const) {
				sessionManager.appendMessage({
					role: "toolResult",
					toolCallId,
					toolName: "todo",
					content: result.content,
					details: result.details,
					isError: result.isError === true,
					timestamp: Date.now(),
				});
			}
			await sessionManager.ensureOnDisk();
			const sessionFile = session.sessionFile;
			if (!sessionFile) throw new Error("Expected persisted session file");

			session.setTodoPhases([]);
			expect(session.getTodoPhases()).toEqual([]);
			expect(await session.switchSession(sessionFile)).toBe(true);
			expect(session.getTodoPhases()).toMatchObject([
				{
					name: "Worker flow",
					tasks: [{ content: "Reconcile worker result", status: "completed" }],
				},
			]);
		} finally {
			await session.dispose();
		}
	});

	it("does not register the xAI TTS tool unless enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
		});

		try {
			expect(session.getToolByName("tts")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers the xAI TTS tool when enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "speechgen.enabled": true }),
		});

		try {
			expect(session.getToolByName("tts")).toBeDefined();
			// tts is a discoverable custom tool → mounted as an xd:// device, not top-level.
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the stable MCP tool-name collision winner during SDK startup and warns", async () => {
		const tempDir = makeTempDir();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const createMcpTool = (serverName: string, label: string): CustomTool => ({
			name: "mcp__foo_bar_lookup",
			label,
			description: `Lookup from ${serverName}`,
			parameters: type({}),
			mcpServerName: serverName,
			mcpToolName: "lookup",
			async execute() {
				return { content: [{ type: "text", text: serverName }] };
			},
		});

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [createMcpTool("foo.bar", "foo.bar/lookup"), createMcpTool("foo_bar", "foo_bar/lookup")],
		});

		try {
			expect(session.getToolByName("mcp__foo_bar_lookup")?.label).toBe("foo.bar/lookup");
			expect(warn).toHaveBeenCalledWith("MCP 工具名冲突;保留稳定的胜者", {
				name: "mcp__foo_bar_lookup",
				keptServer: "foo.bar",
				keptTool: "lookup",
				ignoredServer: "foo_bar",
				ignoredTool: "lookup",
			});
		} finally {
			await session.dispose();
		}
	});

	it("keeps restricted host tool lists isolated from configured custom capabilities", async () => {
		const restrictedDir = makeTempDir();
		const normalDir = makeTempDir();
		const configuredSettings = () =>
			Settings.isolated({
				"providers.imageOrder": ["openai"],
				"generate_image.enabled": true,
				"speechgen.enabled": true,
				"memory.backend": "hindsight",
				"autolearn.enabled": true,
			});

		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const { session: restricted } = await createAgentSession({
			...baseOptions(restrictedDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "lsp", "hub"],
			requireYieldTool: true,
			restrictToolNames: true,
			enableMCP: true,
			mcpManager: inheritedManager,
			enableLsp: true,
			enableIrc: true,
		});

		try {
			expect(restricted.getAllToolNames()).toEqual(["read", "lsp", "yield"]);
			expect(restricted.getActiveToolNames()).toEqual(["read", "lsp", "yield"]);
			for (const name of [
				"generate_image",
				"tts",
				"recall",
				"retain",
				"reflect",
				"learn",
				"manage_skill",
				"default_active_tool",
				"default_inactive_tool",
				"sdk_custom_tool",
				"hub",
			]) {
				expect(restricted.getToolByName(name)).toBeUndefined();
			}
			expect(restricted.getXdevToolEntries()).toEqual([]);
			expect(restricted.systemPrompt.join("\n")).not.toContain("private-server");
			expect(restricted.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await restricted.dispose();
		}

		const { session: normal } = await createAgentSession({
			...baseOptions(normalDir),
			settings: configuredSettings(),
			extensions: [toolActivationExtension],
			customTools: [sdkCustomTool],
			toolNames: ["read", "generate_image"],
			requireYieldTool: true,
			restrictToolNames: false,
		});

		try {
			const activeToolNames = normal.getActiveToolNames();
			expect(activeToolNames).toEqual(
				expect.arrayContaining([
					"read",
					"yield",
					"generate_image",
					"learn",
					"manage_skill",
					"tts",
					"default_active_tool",
					"sdk_custom_tool",
				]),
			);
			// Without a granted write tool the session allocates no xd:// state;
			// SDK custom and extension capabilities surface top-level instead.
			expect(activeToolNames).not.toContain("write");
			expect(normal.getXdevToolEntries()).toEqual([]);
			expect(normal.getAllToolNames()).toEqual(
				expect.arrayContaining([
					"generate_image",
					"read",
					"yield",
					"tts",
					"default_active_tool",
					"sdk_custom_tool",
					"recall",
					"retain",
					"reflect",
				]),
			);
		} finally {
			await normal.dispose();
		}
	});

	it("permits only explicitly named SDK custom tools when a restricted caller opts in", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [sdkCustomTool],
			toolNames: ["read", "sdk_custom_tool"],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
		});

		try {
			expect(session.getAllToolNames()).toEqual(["read", "sdk_custom_tool"]);
			expect(session.getActiveToolNames()).toEqual(["read", "sdk_custom_tool"]);
			expect(session.getToolByName("sdk_custom_tool")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("renders report-issue guidance only for unrestricted sessions", async () => {
		const normalDir = makeTempDir();
		const restrictedDir = makeTempDir();
		const { session: normal } = await createAgentSession({
			...baseOptions(normalDir),
			settings: Settings.isolated({ "dev.autoqa": true }),
		});
		const { session: restricted } = await createAgentSession({
			...baseOptions(restrictedDir),
			settings: Settings.isolated({ "dev.autoqa": true }),
			toolNames: ["read"],
			restrictToolNames: true,
		});

		try {
			expect(normal.systemPrompt.join("\n")).toContain("xd://report_issue");
			expect(restricted.systemPrompt.join("\n")).not.toContain("xd://report_issue");
		} finally {
			await Promise.all([normal.dispose(), restricted.dispose()]);
		}
	});

	it("ignores an inherited MCP manager when MCP is disabled", async () => {
		const tempDir = makeTempDir();
		const inheritedManager = {
			getServerInstructions: () => new Map([["private-server", "must not reach restricted child"]]),
		} as unknown as MCPManager;

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			enableMCP: false,
			mcpManager: inheritedManager,
		});

		try {
			expect(session.systemPrompt.join("\n")).not.toContain("private-server");
			expect(session.systemPrompt.join("\n")).not.toContain("MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	});

	// A session created on another provider keeps its configured-mode `edit` in
	// the registry (only a Cursor-created session moves it out) and the tool
	// roster is built once, at creation — switching to Cursor later does not
	// rebuild it. These two cover both directions of that wiring: the granted
	// session must still reach a replace-mode instance for `pi_edit` (whose
	// `old_string`/`new_string` args do not validate against the default `hashline`
	// schema), and the restricted one must still be refused.
	//
	// The handlers are internal to the session; `streamFn` is where they are
	// handed to the provider, which is the externally observable seam.
	const captureCursorExecHandlers = async (session: AgentSession, cursorModel: Model): Promise<CursorExecHandlers> => {
		let handlers: CursorExecHandlers | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			// The session installs the concrete class; the provider option is
			// typed as the wire-level interface, whose `piEdit` answers a proto
			// result rather than the tool result the class returns.
			handlers = options?.cursorExecHandlers as CursorExecHandlers | undefined;
			throw new Error("captured");
		};
		vi.spyOn(session.agent, "streamFn").mockImplementation(streamFn);

		await session.setModel(cursorModel);
		// Not wrapped in a catch: `prompt` resolves even when the turn fails (the
		// loop records the stream error), so a rejection here is a genuine setup
		// failure and must surface rather than be mistaken for the capture.
		await session.prompt("hi");
		if (!handlers) throw new Error("no exec handlers reached the provider");
		return handlers;
	};

	// `setModel` and `prompt` both refuse a provider with no configured auth.
	// Granted on the suite's isolated storage rather than through the provider's
	// env var — an env mutation would outlive this file — and removed after,
	// since the storage is shared by every test here.
	const withProviderAuth = async (providers: string[], run: () => Promise<void>): Promise<void> => {
		for (const provider of providers) modelRegistry.authStorage.setRuntimeApiKey(provider, "test-key");
		try {
			await run();
		} finally {
			for (const provider of providers) modelRegistry.authStorage.removeRuntimeApiKey(provider);
		}
	};

	it("answers a native pi_edit after a session switches onto Cursor", async () => {
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession(baseOptions(tempDir));
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				const result = await handlers.piEdit({
					toolCallId: "sdk-switch-1",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);

				expect(result.isError).toBeFalsy();
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\ngamma\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("refuses a native pi_edit after a read-only session switches onto Cursor", async () => {
		// The bridge instance is constructed, not looked up, so building it for
		// a roster that was never granted `edit` would hand a read-only session
		// a mutating tool the native frames reach regardless of the advertised
		// catalog (issue #5680). Making the construction provider-independent
		// must not widen it.
		const tempDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["cursor"], async () => {
			const { session } = await createAgentSession({ ...baseOptions(tempDir), toolNames: ["read"] });
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				const result = await handlers.piEdit({
					toolCallId: "sdk-switch-2",
					args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
				} as never);

				expect(result.isError).toBe(true);
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("resolves bridge frame paths through the session's live cwd", async () => {
		// The bridge is built once, at session creation, while the session's cwd
		// moves under it (`/cd`, resume, branch restore). The path-confining
		// frames — the native `delete`, and a `download_path` resource read —
		// resolve a relative path against whichever cwd the bridge was handed, so
		// a startup snapshot means acting on the workspace the session has left
		// while reporting success for the path the server named.
		const tempDir = makeTempDir();
		const movedDir = makeTempDir();
		const cursorModel = getBundledModel("cursor", "composer-1.5");
		if (!cursorModel) throw new Error("expected bundled Cursor model");
		const staleTarget = path.join(tempDir, "obsolete.txt");
		const liveTarget = path.join(movedDir, "obsolete.txt");
		fs.writeFileSync(staleTarget, "preserve me");
		fs.writeFileSync(liveTarget, "remove me");

		await withProviderAuth(["cursor"], async () => {
			const sessionManager = SessionManager.inMemory();
			const { session } = await createAgentSession({ ...baseOptions(tempDir), sessionManager });
			try {
				const handlers = await captureCursorExecHandlers(session, cursorModel);
				await sessionManager.moveTo(movedDir);

				const result = await handlers.delete({ toolCallId: "sdk-cwd-1", path: "obsolete.txt" } as never);

				expect(result.isError).toBe(false);
				expect(fs.existsSync(liveTarget)).toBe(false);
				expect(fs.existsSync(staleTarget)).toBe(true);
			} finally {
				await session.dispose();
			}
		});
	});

	it("does not execute an unadvertised edit call through the fallback resolver", async () => {
		// One resolver serves two roles: the session's device resolver is passed
		// to the bridge as `getTool` AND installed as the agent loop's
		// `resolveFallbackTool`, which runs for ANY call the advertised set does
		// not contain. It must stay device-only: routing `edit` through it would
		// execute a replace-mode edit for a call the model was never offered —
		// a hallucinated one, or a tool the session deselected after startup.
		// `pi_edit` gets its instance from `getEditReplaceTool` instead.
		const tempDir = makeTempDir();
		const target = path.join(tempDir, "sample.txt");
		fs.writeFileSync(target, "alpha\nbeta\n");

		await withProviderAuth(["openai"], async () => {
			// Granted at startup, so an `edit` instance exists to leak, then
			// deselected — the exact state that makes the fallback dangerous.
			const { session } = await createAgentSession(baseOptions(tempDir));
			try {
				await session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "edit"));
				expect(session.getActiveToolNames()).not.toContain("edit");

				// A real mock provider, not a hand-rolled stream: the loop builds
				// the assistant message from the full event sequence, and an
				// incomplete one is dropped before tool dispatch ever runs.
				const toolCallId = "unadvertised-edit-1";
				const mock = createMockModel({
					responses: [
						{
							content: [
								{
									type: "toolCall",
									id: toolCallId,
									name: "edit",
									arguments: { path: target, old_string: "beta", new_string: "gamma" },
								},
							],
						},
						{ content: [{ type: "text", text: "done" }] },
					],
				});
				vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);

				await session.prompt("hi");

				// The surfaced result, not just the file: an unchanged file alone
				// would also pass if the fallback HAD resolved the tool and the
				// edit then failed validation or approval. Only "not found"
				// proves the resolver refused to hand one over.
				const result = session.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === toolCallId,
				);
				expect(result?.isError).toBe(true);
				expect(JSON.stringify(result?.content)).toContain("Tool edit not found");
				expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\n");
			} finally {
				await session.dispose();
			}
		});
	});

	it("runs advisor tools through the approval gate", async () => {
		// The advisor's tools are built straight from `BUILTIN_TOOLS`, outside
		// the registry loop that wraps everything else. Its own loop and its
		// Cursor exec bridge (`piWrite`/`piBash`) run those instances directly,
		// so an unwrapped one executes whatever it is handed regardless of the
		// user's `tools.approval.<tool>` policy — the gate lives in
		// `ExtensionToolWrapper`, not in either caller.
		const tempDir = makeTempDir();
		const target = path.join(tempDir, "advisor-write.txt");

		// An advisor only builds once a model resolves for it, and both the
		// explicit override and the `advisor` role chain resolve against
		// `modelRegistry.getAvailable()` — the models this machine holds auth
		// for. Grant the suite's isolated storage a key and name the model
		// outright, or the roster silently resolves to `no_model` wherever no
		// provider is configured (CI) while passing on a developer box whose
		// environment happens to carry provider keys.
		await withProviderAuth(["openai"], async () => {
			const { session } = await createAgentSession({
				...baseOptions(tempDir),
				settings: Settings.isolated({ "advisor.enabled": true, "tools.approval": { write: "deny" } }),
			});
			try {
				// The default advisor roster is read-only (read/grep/glob); the
				// reviewed hole needs one actually granted a mutating tool.
				session.applyAdvisorConfigs([{ name: "writer", tools: ["write"], model: "gpt-4o-mini" }], undefined);
				const advisor = session.getAdvisorAgent();
				if (!advisor) throw new Error("expected an advisor agent");
				const writeTool = advisor.state.tools?.find(tool => tool.name === "write");
				if (!writeTool) throw new Error("expected the advisor to hold a write tool");

				// The gate rejects rather than returning an error result — that throw
				// IS the refusal, and it only happens when the instance is wrapped.
				await expect(
					writeTool.execute("advisor-w1", { path: target, content: "written" }, undefined, undefined, {
						settings: session.settings,
					} as never),
				).rejects.toThrow(/已被用户策略阻止/);
				expect(fs.existsSync(target)).toBe(false);
			} finally {
				await session.dispose();
			}
		});
	});
});
