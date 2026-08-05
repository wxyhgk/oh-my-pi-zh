import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	enableAutoTheme,
	getCurrentThemeName,
	getThemeEpoch,
	initTheme,
	previewTheme,
	setTheme,
	stopThemeWatcher,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TUI } from "@oh-my-pi/pi-tui";
import type { TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const MULTIPLEXER_ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "TERM"] as const;

class AppearanceVirtualTerminal extends VirtualTerminal {
	#appearance?: TerminalAppearance;
	#appearanceChangeCallbacks = new Set<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	>();
	#appearanceReportCallbacks = new Set<
		(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void
	>();
	#nextAppearanceRequestToken = 0;
	appearanceOnRefresh?: TerminalAppearance;
	returnRefreshToken = true;
	deferRefreshReport = true;
	override get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	override onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		this.#appearanceChangeCallbacks.add(callback);
		return () => this.#appearanceChangeCallbacks.delete(callback);
	}

	onAppearanceReport(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): () => void {
		this.#appearanceReportCallbacks.add(callback);
		return () => this.#appearanceReportCallbacks.delete(callback);
	}

	refreshAppearance(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void {
		const token = requestToken ?? ++this.#nextAppearanceRequestToken;
		if (token > this.#nextAppearanceRequestToken) {
			this.#nextAppearanceRequestToken = token;
		}
		const appearance = this.appearanceOnRefresh;
		if (appearance !== undefined) {
			const emit = () => this.emitAppearanceReport(appearance, this.returnRefreshToken ? token : undefined);
			if (this.deferRefreshReport) {
				queueMicrotask(emit);
			} else {
				emit();
			}
		}
		return this.returnRefreshToken ? token : undefined;
	}

	emitAppearanceReport(appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken): void {
		for (const callback of this.#appearanceReportCallbacks) callback(appearance, requestToken);
		if (appearance === this.#appearance) return;
		this.#appearance = appearance;
		for (const callback of this.#appearanceChangeCallbacks) callback(appearance, requestToken);
	}
}

async function waitForThemeEpochToAdvance(previousEpoch: number): Promise<void> {
	for (let attempts = 0; attempts < 1_000; attempts++) {
		if (getThemeEpoch() > previousEpoch) return;
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
	throw new Error(`Theme epoch did not advance from ${previousEpoch}`);
}

let originalMultiplexerEnv: Partial<Record<(typeof MULTIPLEXER_ENV_KEYS)[number], string | undefined>>;
describe("InteractiveMode theme scrollback refresh", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: AppearanceVirtualTerminal;

	beforeEach(async () => {
		originalMultiplexerEnv = {};
		for (const key of MULTIPLEXER_ENV_KEYS) {
			originalMultiplexerEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-theme-scrollback-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		await initTheme();
		await setTheme("dark");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		terminal = new AppearanceVirtualTerminal(100, 20);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		stopThemeWatcher();
		await setTheme("dark");
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		for (const key of MULTIPLEXER_ENV_KEYS) {
			const value = originalMultiplexerEnv[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("emits a full scrollback replay when the active theme changes", async () => {
		await terminal.waitForRender();
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await setTheme("light");
		await terminal.waitForRender();

		expect(writes.join("")).toContain("\x1b[3J");
	});

	it("preserves the viewport on automatic appearance changes until Alt+L requests a full replay", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		const epoch = getThemeEpoch();
		terminal.emitAppearanceReport("light");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("light");

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");

		writes.length = 0;
		terminal.sendInput("\x1bl");
		await terminal.waitForRender();

		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("")).toContain("\x1b[3J");
	});
	it("keeps a queued Alt+L token correlated across an unrelated automatic report", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "light";

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		// A queued automatic response may arrive before the explicit probe. It must
		// neither consume the Alt+L correlation nor classify its own change as the
		// explicit response.
		terminal.emitAppearanceReport("dark");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 2);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(3);
	});

	it("replays with the new palette when an automatic response wins the queued Alt+L race", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "light";

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		terminal.emitAppearanceReport("light");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();
		await Promise.resolve();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 2);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(3);
	});

	it("owns a synchronous refresh response before invoking the terminal", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "light";
		terminal.deferRefreshReport = false;

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 2);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(3);
	});

	it("consumes an unchanged Alt+L appearance report before a later automatic change", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.appearanceOnRefresh = "dark";

		terminal.sendInput("\x1bl");
		await terminal.waitForRender();
		await Promise.resolve();

		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(2);

		const epoch = getThemeEpoch();
		terminal.emitAppearanceReport("light");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(2);
	});

	it("does not arm a committed replay when a custom terminal returns no token", async () => {
		terminal.emitAppearanceReport("dark");
		enableAutoTheme();
		await terminal.waitForRender();
		expect(getCurrentThemeName()).toBe("dark");

		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		terminal.returnRefreshToken = false;
		terminal.appearanceOnRefresh = "light";

		const epoch = getThemeEpoch();
		terminal.sendInput("\x1bl");
		await waitForThemeEpochToAdvance(epoch);
		await terminal.waitForRender();

		expect(getCurrentThemeName()).toBe("light");
		expect(mode.ui.fullRedraws).toBe(fullRedraws + 1);
		expect(writes.join("").split("\x1b[3J")).toHaveLength(2);
	});

	it("keeps theme previews as non-destructive viewport repaints", async () => {
		await terminal.waitForRender();
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await previewTheme("light");
		await terminal.waitForRender();

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");
	});

	it("emits a full scrollback replay when a previewed theme is committed", async () => {
		await terminal.waitForRender();
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await previewTheme("light", { ephemeral: false });
		await terminal.waitForRender();

		expect(writes.join("")).toContain("\x1b[3J");
	});

	it("keeps auto-theme previews as non-destructive viewport repaints", async () => {
		await terminal.waitForRender();
		const originalColorFgBg = Bun.env.COLORFGBG;
		Bun.env.COLORFGBG = "0;15";
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		try {
			enableAutoTheme({ ephemeral: true });
			await terminal.waitForRender();
		} finally {
			if (originalColorFgBg === undefined) {
				delete Bun.env.COLORFGBG;
			} else {
				Bun.env.COLORFGBG = originalColorFgBg;
			}
		}

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");
	});

	it("keeps theme changes as viewport repaints inside terminal multiplexers", async () => {
		await terminal.waitForRender();
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await setTheme("light");
		await terminal.waitForRender();

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");
	});
});
