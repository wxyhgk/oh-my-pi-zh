/**
 * Regression tests for issue #6365: `BrowserTool.#open` must apply the
 * requested `timeout` to the *entire* open lifecycle (browser acquisition +
 * tab acquisition), and must hold one explicit browser lease across tab
 * acquisition so a refCount:0 browser is never orphaned by an abort/timeout
 * nor disposed out from under a concurrent open of a different tab name.
 *
 * The tool resolves the cmux backend (`CMUX_SOCKET_PATH` + settings), so
 * `CmuxSocketClient.prototype` is spied and no real socket / Chromium is used.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { BrowserTool } from "@wxyhgk/pi-coding-agent/tools/browser";
import { CmuxSocketClient } from "@wxyhgk/pi-coding-agent/tools/browser/cmux/socket-client";
import { getBrowsersMapForTest } from "@wxyhgk/pi-coding-agent/tools/browser/registry";
import { getTabsMapForTest, releaseTab } from "@wxyhgk/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@wxyhgk/pi-coding-agent/tools/index";
import { ToolAbortError, ToolError } from "@wxyhgk/pi-coding-agent/tools/tool-errors";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: {
			get: (key: string) => (key === "browser.cmux" ? true : key === "tools.maxTimeout" ? 0 : undefined),
		},
		getSessionId: () => "session-open-lease",
	} as unknown as ToolSession;
}

async function drainAllTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

let prevSocketPath: string | undefined;

beforeEach(() => {
	prevSocketPath = process.env.CMUX_SOCKET_PATH;
	// Unique per test so the module-global browsers map (keyed by socket path)
	// never carries a handle across tests.
	process.env.CMUX_SOCKET_PATH = `/tmp/omp-open-lease-${process.pid}-${Math.random().toString(36).slice(2)}.sock`;
});

afterEach(async () => {
	vi.useRealTimers();
	await drainAllTabs().catch(() => undefined);
	vi.restoreAllMocks();
	if (prevSocketPath === undefined) delete process.env.CMUX_SOCKET_PATH;
	else process.env.CMUX_SOCKET_PATH = prevSocketPath;
});

describe("browser open — requested timeout bounds the whole acquisition (#6365)", () => {
	it("rejects with a timeout ToolError when browser acquisition stays pending past the deadline", async () => {
		vi.useFakeTimers();
		const connectGate = Promise.withResolvers<void>();
		spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			await connectGate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		const tool = new BrowserTool(makeSession());
		const open = tool.execute("call-timeout", { action: "open", name: "late", timeout: 1 });
		const settled = open.then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err }),
		);

		// The requested 1s deadline elapses while `acquireBrowser` is still
		// blocked on the (never-resolving) socket connect. Bun's fake timers fire
		// `AbortSignal.timeout` synchronously on advance; awaiting `settled` below
		// flushes the rejection.
		vi.advanceTimersByTime(1000);

		const outcome = await settled;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		// The requested action timeout surfaces as a timeout ToolError — never a
		// ToolAbortError (that is reserved for caller cancellation).
		expect(outcome.err).toBeInstanceOf(ToolError);
		expect(outcome.err).not.toBeInstanceOf(ToolAbortError);
		expect((outcome.err as Error).message).toMatch(/打开超时/);

		// Let the orphan launch resolve; the aborted deadline must dispose it so
		// no refCount:0 browser survives in the registry.
		connectGate.resolve();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(getBrowsersMapForTest().size).toBe(0);
	});
});

describe("browser open — caller cancellation rolls back the fresh browser (#6365)", () => {
	it("aborting before tab publication rejects with ToolAbortError and leaves both maps empty", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const openSplitGate = Promise.withResolvers<void>();
		const surfaceClosed: string[] = [];
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					await openSplitGate.promise;
					return { surface_id: "surface-abort", url: "about:blank" };
				}
				if (method === "surface.close") {
					surfaceClosed.push(String(params.surface_id));
					return {};
				}
				return {};
			},
		);

		const tool = new BrowserTool(makeSession());
		const controller = new AbortController();
		const open = tool.execute("call-abort", { action: "open", name: "fresh", timeout: 30 }, controller.signal);
		const settled = open.then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err }),
		);

		// Browser acquisition has resolved; tab acquisition is parked in
		// `open_split`. Cancel here — before any tab is published.
		await Promise.resolve();
		controller.abort();

		const outcome = await settled;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.err).toBeInstanceOf(ToolAbortError);

		// The open-acquisition lease rollback disposes the fresh browser exactly
		// once and leaves nothing owned solely by the failed open.
		expect(getTabsMapForTest().has("fresh")).toBe(false);
		expect(getBrowsersMapForTest().size).toBe(0);
		expect(closeSpy).toHaveBeenCalledTimes(1);

		// Let the orphaned acquisition unwind so it does not leak past the test.
		openSplitGate.resolve();
		await Promise.resolve();
	});
});

describe("browser open — concurrent different-name acquisitions each own a lease (#6365)", () => {
	it("aborting one open releases only its lease; the survivor keeps the browser and one tab", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const openGate = Promise.withResolvers<void>();
		let splitCount = 0;
		const aEntered = Promise.withResolvers<void>();
		const bEntered = Promise.withResolvers<void>();
		const surfaceClosed: string[] = [];
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					const id = `surface-${++splitCount}`;
					(splitCount === 1 ? aEntered : bEntered).resolve();
					await openGate.promise;
					return { surface_id: id, url: "about:blank" };
				}
				if (method === "surface.close") {
					surfaceClosed.push(String(params.surface_id));
					return {};
				}
				return {};
			},
		);

		const tool = new BrowserTool(makeSession());

		// Open A first and wait until it is parked inside `open_split` — proof it
		// acquired the shared browser and took its open-acquisition lease.
		const controllerA = new AbortController();
		const openA = tool.execute("call-a", { action: "open", name: "tab-a", timeout: 30 }, controllerA.signal);
		const settledA = openA.then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err }),
		);
		await aEntered.promise;
		expect(getBrowsersMapForTest().size).toBe(1);

		// Open B against the SAME browser (different tab name). It reuses the
		// registry handle and takes its own lease; both are now parked.
		const openB = tool.execute("call-b", { action: "open", name: "tab-b", timeout: 30 });
		await bEntered.promise;

		// Abort A while both are queued; releasing A's lease must not dispose the
		// browser B still needs.
		controllerA.abort();
		const outcomeA = await settledA;
		expect(outcomeA.ok).toBe(false);
		if (outcomeA.ok) throw new Error("unreachable");
		expect(outcomeA.err).toBeInstanceOf(ToolAbortError);

		// Release the gate so B publishes its tab.
		openGate.resolve();
		const resultB = await openB;
		expect(resultB.content.some(part => part.type === "text" && /已打开标签页 "tab-b"/.test(part.text ?? ""))).toBe(
			true,
		);

		// B's browser survived A's rollback: still present, never closed, exactly
		// one published tab. A's rollback closed only its own orphan surface.
		expect(getBrowsersMapForTest().size).toBe(1);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(getTabsMapForTest().has("tab-b")).toBe(true);
		expect(getTabsMapForTest().has("tab-a")).toBe(false);
		expect(getTabsMapForTest().size).toBe(1);
		expect(surfaceClosed).toEqual(["surface-1"]);
	});
});
