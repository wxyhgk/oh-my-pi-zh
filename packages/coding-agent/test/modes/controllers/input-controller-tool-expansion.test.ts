import { describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("InputController tool output expansion", () => {
	it("expands children and forces a full display reset to bypass frozen snapshots", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const requestRender = vi.fn();
		const resetDisplay = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			ui: { requestRender, resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		// resetDisplay() is the only path that retires the transcript's frozen
		// block snapshots and re-emits the whole transcript at its new heights.
		// A plain requestRender would replay the stale (collapsed) snapshots.
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not expand hidden tool activity and explains why", () => {
		const expandable = { setExpanded: vi.fn() };
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: true,
			toolOutputExpanded: false,
			chatContainer: { children: [expandable] },
			keybindings: { getDisplayString: vi.fn(() => "Alt+H") },
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(false);
		expect(expandable.setExpanded).not.toHaveBeenCalled();
		expect(resetDisplay).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Alt+H"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("/settings"));
	});
});

describe("InputController tool activity visibility", () => {
	it("persists the toggle, preserves transient children, and reveals tools collapsed", () => {
		const pendingUserMessage = { kind: "pending-user" };
		const loadingIndicator = { kind: "loading" };
		const assistant = new AssistantMessageComponent();
		const setToolResultImagesVisible = vi.spyOn(assistant, "setToolResultImagesVisible");
		const children = [pendingUserMessage, assistant, loadingIndicator];
		const clear = vi.fn();
		const addChild = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const set = vi.fn();
		const clearInlineImages = vi.fn();
		const resetDisplay = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			hideToolActivity: false,
			toolOutputExpanded: true,
			settings: { set },
			chatContainer: { children, clear, addChild },
			rebuildChatFromMessages,
			showStatus,
			ui: { clearInlineImages, resetDisplay },
		};
		const controller = new InputController(ctx as unknown as InteractiveModeContext) as unknown as InputController & {
			toggleToolActivityVisibility(): void;
		};

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(true);
		expect(set).toHaveBeenLastCalledWith("display.hideToolActivity", true);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(resetDisplay.mock.invocationCallOrder[0]);
		expect(showStatus).toHaveBeenLastCalledWith("工具活动:已隐藏");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(false);

		controller.toggleToolActivityVisibility();

		expect(ctx.hideToolActivity).toBe(false);
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(set).toHaveBeenLastCalledWith("display.hideToolActivity", false);
		expect(ctx.chatContainer.children).toEqual(children);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(clearInlineImages).toHaveBeenCalledTimes(1);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
		expect(showStatus).toHaveBeenLastCalledWith("工具活动:可见");
		expect(setToolResultImagesVisible).toHaveBeenLastCalledWith(true);
	});
});
