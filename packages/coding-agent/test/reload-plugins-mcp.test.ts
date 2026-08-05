/**
 * Regression: `/reload-plugins` is documented to reload MCP, so the TUI handler
 * must reconnect servers and rebind the session's MCP tool registry — not just
 * reset skill/command/capability caches. Before the fix it silently skipped
 * MCP, leaving `.mcp.json` edits inactive until process restart (#7189).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

function createFakeCtx(cwd: string, settingsValues: Record<string, unknown> = {}) {
	const mcpTools = [{ name: "mcp__srv_do" }];
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => ({ errors: new Map<string, string>() })),
		getTools: vi.fn(() => mcpTools),
	};
	const session = {
		refreshMCPTools: vi.fn(async (_tools: unknown) => {}),
		setMCPPromptCommands: vi.fn((_commands: unknown) => {}),
	};
	const ctx = {
		mcpManager,
		session,
		sessionManager: { getCwd: () => cwd },
		settings: { get: (key: string): unknown => settingsValues[key] },
		refreshSkillState: vi.fn(async () => {}),
		refreshSlashCommandState: vi.fn(async () => {}),
		showStatus: vi.fn(() => {}),
		editor: { setText: vi.fn(() => {}) },
	} as never as InteractiveModeContext;
	return { ctx, mcpManager, session, mcpTools };
}

describe("/reload-plugins MCP reconnect (#7189)", () => {
	let projectDir = "";

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reload-plugins-mcp-"));
		setProjectDir(projectDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		await removeWithRetries(projectDir);
	});

	test("reconnects MCP servers, rebinds tools, and clears stale prompt commands", async () => {
		const { ctx, mcpManager, session, mcpTools } = createFakeCtx(projectDir);
		const runtime: TuiSlashCommandRuntime = { ctx };

		const result = await executeBuiltinSlashCommand("/reload-plugins", runtime);
		expect(result).toBe(true);
		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(session.refreshMCPTools).toHaveBeenCalledTimes(1);
		expect(session.refreshMCPTools).toHaveBeenCalledWith(mcpTools);
		expect(session.setMCPPromptCommands).toHaveBeenCalledTimes(1);
		expect(session.setMCPPromptCommands).toHaveBeenCalledWith([]);
	});

	test("honors mcp.enableProjectConfig=false so opted-out project servers are not started on reload", async () => {
		const { ctx, mcpManager } = createFakeCtx(projectDir, { "mcp.enableProjectConfig": false });
		const runtime: TuiSlashCommandRuntime = { ctx };

		await executeBuiltinSlashCommand("/reload-plugins", runtime);

		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledWith(
			expect.objectContaining({ enableProjectConfig: false }),
		);
	});
});
