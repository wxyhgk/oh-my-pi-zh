import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@wxyhgk/pi-agent-core";
import type { UsageReport } from "@wxyhgk/pi-ai";
import { ModelRegistry } from "@wxyhgk/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { InteractiveMode } from "@wxyhgk/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@wxyhgk/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@wxyhgk/pi-coding-agent/session/agent-session";
import { AgentSession } from "@wxyhgk/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@wxyhgk/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@wxyhgk/pi-coding-agent/session/history-storage";
import { SessionManager } from "@wxyhgk/pi-coding-agent/session/session-manager";
import { Text } from "@wxyhgk/pi-tui";
import { TempDir } from "@wxyhgk/pi-utils";

const usageReports: UsageReport[] = [
	{
		provider: "openai-codex",
		fetchedAt: 1_700_000_000_000,
		limits: [
			{
				id: "codex-weekly",
				label: "Weekly",
				scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
				window: { id: "weekly", label: "weekly" },
				amount: { remainingFraction: 0.25, unit: "requests" },
				status: "ok",
			},
		],
		metadata: { email: "user@example.com" },
	},
];

describe("issue #6767 /usage output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-6767-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("defers the usage panel until the active turn ends, mounting it once", async () => {
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);

		await mode.handleUsageCommand(usageReports);

		// Mid-stream: the finalized panel must NOT mount above the growing live
		// block (that is what duplicates in native scrollback — issue #6767).
		expect(mode.chatContainer.children).toEqual([streamedReply]);

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		// streamedReply + the deferred usage panel (Spacer + Text).
		expect(mode.chatContainer.children).toHaveLength(3);
		const transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript.match(/用量 \(/g)).toHaveLength(1);
	});
});
