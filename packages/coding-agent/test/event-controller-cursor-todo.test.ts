import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

interface Fixture {
	ctx: InteractiveModeContext;
	controller: EventController;
	showWarning: Mock<InteractiveModeContext["showWarning"]>;
	/** Components the controller committed to the transcript, in order. */
	blocks: unknown[];
}

function createFixture(): Fixture {
	const showWarning = vi.fn();
	const blocks: unknown[] = [];
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn() },
		session: { isAborting: false },
		settings: { get: () => false },
		updateEditorTopBorder: vi.fn(),
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		noteDisplayableThinkingContent: () => false,
		effectiveHideThinkingBlock: false,
		// A live streaming component: the streamed toolCall block path
		// (`#handleMessageUpdate`) only runs while one exists.
		streamingComponent: { setHideThinkingBlock: vi.fn(), markTranscriptBlockFinalized: vi.fn() },
		streamingMessage: undefined,
		viewSession: { isStreaming: false, getToolByName: () => undefined },
		sessionManager: { getCwd: () => "/tmp" },
		chatContainer: {
			addChild: (block: unknown) => blocks.push(block),
			removeChild: vi.fn(),
			isBlockUncommitted: () => false,
		},
		toolOutputExpanded: false,
		setTodos: vi.fn(),
		present: vi.fn(),
		showWarning,
	} as unknown as InteractiveModeContext;
	return { ctx, controller: new EventController(ctx), showWarning, blocks };
}

/** A cumulative `message_update` whose content carries the streamed todo toolCall block. */
function streamedTodoBlock(toolCallId: string): Extract<AgentSessionEvent, { type: "message_update" }> {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_start" },
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "todo", arguments: { todos: [] } }],
		},
	} as unknown as Extract<AgentSessionEvent, { type: "message_update" }>;
}

function todoEnd(
	toolCallId: string,
	phases: { name: string; tasks: { content: string; status: string }[] }[],
): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "todo",
		isError: false,
		result: { content: [{ type: "text", text: "" }], details: { phases } },
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

function todoFailure(text: string): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId: "todo-1",
		toolName: "todo",
		isError: true,
		result: { content: [{ type: "text", text }] },
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

describe("EventController + Cursor todo bridge", () => {
	it("sanitizes provider error text before it reaches the status line", async () => {
		// The bridge forwards the server's error string verbatim, so this text is
		// untrusted terminal input. Raw tabs punch holes in the single-line status
		// area and an unbounded string overflows it.
		const f = createFixture();

		await f.controller.handleEvent(
			todoFailure(`\u001b[31mrejected:\u001b[0m\tid 4\r\n\tconflicts with ${"x".repeat(400)}`),
		);

		expect(f.showWarning).toHaveBeenCalledTimes(1);
		const message = f.showWarning.mock.calls[0]![0] as string;
		expect(message).not.toContain("\t");
		expect(message).not.toContain("\n");
		// ANSI and other C0/C1 controls reach the terminal verbatim through
		// `Text` and can repaint outside the row, so they must be gone too.
		expect(message).not.toContain("\u001b");
		expect(message).not.toContain("\r");
		// The prefix is ours and fixed; only the untrusted tail is bounded.
		expect(message.startsWith("待办更新失败:")).toBe(true);
		expect(Bun.stringWidth(message.slice("待办更新失败:".length))).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});

	it("keeps the standalone hint when the failure carries no text", async () => {
		// Without a detail the warning must still say the panel may be stale —
		// dropping to a bare "Todo update failed" hides that local state diverged.
		const f = createFixture();

		await f.controller.handleEvent(todoFailure(""));

		expect(f.showWarning).toHaveBeenCalledWith("待办更新失败。在待办成功前,进度可能已过期。");
	});

	it("settles a card whose completion arrived before the streamed block created it", async () => {
		// The Cursor bridge's `tool_execution_end` is a synchronous callback fired
		// mid-parse, while the `toolcall_start` for the same call is queued on
		// `AssistantMessageEventStream` and delivered a microtask later. When the
		// server packs start and completion into one HTTP/2 chunk, the controller
		// sees the completion FIRST — with nothing in `pendingTools` to settle.
		// Dropping it stranded the card the streamed block creates moments later,
		// animating for the rest of the session.
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));
		// Completion held: nothing rendered yet, nothing pending.
		expect(f.blocks).toHaveLength(0);
		expect(f.ctx.pendingTools.size).toBe(0);

		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));

		// Exactly one card, created by the stream and immediately settled by the
		// held completion — not left pending.
		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		// The mirror still ran: settling must not cost the panel refresh.
		expect(f.ctx.setTodos).toHaveBeenCalledWith(phases);
	});

	it("fires the failure warning exactly once when a failed completion is replayed", async () => {
		// The held completion is replayed through the full end handler to settle
		// the late-created card. Its user-facing side effects (failure warning,
		// panel refresh) already ran on first arrival — the replay must only
		// settle the component, not repeat them.
		const f = createFixture();

		await f.controller.handleEvent(todoFailure("boom"));
		expect(f.showWarning).toHaveBeenCalledTimes(1);

		await f.controller.handleEvent(streamedTodoBlock("todo-1"));

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		expect(f.showWarning).toHaveBeenCalledTimes(1);
	});

	it("refreshes the panel exactly once when a successful completion is replayed", async () => {
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));

		expect(f.ctx.setTodos).toHaveBeenCalledTimes(1);
	});

	it("does not recreate the card on later cumulative stream updates", async () => {
		// `message_update` is cumulative: every subsequent update re-lists the
		// same toolCall block. After the orphaned completion settles the card
		// (removing it from `pendingTools`), a replayed block must not pass the
		// creation guard and spawn a second, forever-pending card.
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));
		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
	});

	it("still settles normally when the start precedes the completion", async () => {
		// The common ordering (start delivered first) must keep working: the
		// orphan path only exists for the packed-chunk race.
		const f = createFixture();
		const phases = [{ name: "Tasks", tasks: [{ content: "step one", status: "completed" }] }];

		await f.controller.handleEvent(streamedTodoBlock("cursor-call-1"));
		expect(f.ctx.pendingTools.size).toBe(1);

		await f.controller.handleEvent(todoEnd("cursor-call-1", phases));

		expect(f.blocks).toHaveLength(1);
		expect(f.ctx.pendingTools.size).toBe(0);
		expect(f.ctx.setTodos).toHaveBeenCalledWith(phases);
	});
});
