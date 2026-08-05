import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { CommandController } from "@wxyhgk/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@wxyhgk/pi-coding-agent/modes/types";

function createMemoryContext(backend: string) {
	const showWarning = vi.fn();
	const ctx = {
		settings: Settings.isolated({ "memory.backend": backend }),
		sessionManager: { getCwd: () => "/tmp/project" },
		session: undefined,
		showWarning,
	} as unknown as InteractiveModeContext;
	return { ctx, showWarning };
}

describe("CommandController /memory stats and /memory diagnose", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory stats", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory stats");

		expect(showWarning).toHaveBeenCalledWith("记忆后端已关闭——没有可显示的内容。");
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory diagnose", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory diagnose");

		expect(showWarning).toHaveBeenCalledWith("记忆后端已关闭——没有可显示的内容。");
	});

	it("still names the backend when a real backend simply has no stats hook", async () => {
		const { ctx, showWarning } = createMemoryContext("local");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory stats");

		expect(showWarning).toHaveBeenCalledWith("记忆统计不适用于 local 后端。");
	});
});
