import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function longError(n: number): string {
	return Array.from({ length: n }, (_, i) => `provider error detail line ${i}`).join("\n");
}

function makeErr(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("provider error expand", () => {
	it("caps a long error collapsed and reveals the full body when expanded", () => {
		const component = new AssistantMessageComponent(makeErr(longError(30)));

		const collapsed = Bun.stripANSI(component.render(120).join("\n"));
		const shown = collapsed.match(/provider error detail line \d+/g) ?? [];
		expect(shown.length).toBe(8);
		expect(collapsed).not.toContain("provider error detail line 29");
		expect(collapsed).toMatch(/\+22 更多行/);

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(120).join("\n"));
		const shownExpanded = expanded.match(/provider error detail line \d+/g) ?? [];
		expect(shownExpanded.length).toBe(30);
		expect(expanded).toContain("provider error detail line 0");
		expect(expanded).toContain("provider error detail line 29");
		expect(expanded).not.toMatch(/更多行/);

		component.setExpanded(false);
		const recollapsed = Bun.stripANSI(component.render(120).join("\n"));
		expect(recollapsed).not.toContain("provider error detail line 29");
	});

	it("reveals the full body inline when expanded while the error is pinned", () => {
		const component = new AssistantMessageComponent(makeErr(longError(30)));

		// The banner above the editor mirrors the error, so the inline block is
		// suppressed while pinned (EventController does this at message_end).
		component.setErrorPinned(true);
		const pinned = Bun.stripANSI(component.render(120).join("\n"));
		expect(pinned).not.toContain("provider error detail line 0");

		// Ctrl+O while pinned must still reach the full body inline.
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(120).join("\n"));
		const shown = expanded.match(/provider error detail line \d+/g) ?? [];
		expect(shown.length).toBe(30);
		expect(expanded).toContain("provider error detail line 29");

		// Collapsing again re-suppresses the pinned inline error.
		component.setExpanded(false);
		const recollapsed = Bun.stripANSI(component.render(120).join("\n"));
		expect(recollapsed).not.toContain("provider error detail line 0");
	});
});
