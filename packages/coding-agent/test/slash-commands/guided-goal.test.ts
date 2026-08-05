import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(handler: () => Promise<void>) {
	const handleGuidedGoalCommand = vi.fn(handler);
	const setText = vi.fn();
	return {
		handleGuidedGoalCommand,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleGuidedGoalCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/guided-goal slash command", () => {
	it("clears the slash draft before the interview turn resolves", async () => {
		// The handler blocks for the whole kickoff turn (session.prompt resolves
		// only when the agent finishes asking its first question). Hold it open
		// to simulate that window.
		const { promise, resolve } = Promise.withResolvers<void>();
		const harness = createRuntime(() => promise);

		const dispatched = executeBuiltinSlashCommand("/guided-goal ship the release", harness.runtime);

		// The command text must be gone before the turn resolves, so an answer
		// typed while the first question streams is never wiped.
		expect(harness.setText).toHaveBeenCalledWith("");
		harness.setText.mockClear();

		resolve();
		expect(await dispatched).toBe(true);
		expect(harness.setText).not.toHaveBeenCalled();
		expect(harness.handleGuidedGoalCommand).toHaveBeenCalledWith("ship the release");
	});

	it("passes no objective for a bare invocation", async () => {
		const harness = createRuntime(async () => {});

		const handled = await executeBuiltinSlashCommand("/guided-goal   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleGuidedGoalCommand).toHaveBeenCalledWith(undefined);
	});
});
