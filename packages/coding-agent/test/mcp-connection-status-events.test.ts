import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("emits connecting, connected, and failed updates for startup status", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const success: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const invalid: MCPServerConfig = { type: "stdio", command: "" };

		try {
			const result = await manager.connectServers({ alpha: success, broken: invalid }, {}, event =>
				events.push(event),
			);

			expect(result.connectedServers).toContain("alpha");
			expect(result.errors.get("broken")).toBe('服务器 "broken":stdio 服务器需要 "command" 字段');
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["alpha", "broken"] },
				{ type: "failed", serverName: "broken", error: '服务器 "broken":stdio 服务器需要 "command" 字段' },
				{ type: "connected", serverName: "alpha" },
			]);
		} finally {
			await manager.disconnectAll();
		}
	});
});
