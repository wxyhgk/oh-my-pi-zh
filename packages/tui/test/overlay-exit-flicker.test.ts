import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, type RenderScheduler, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// A terminal that re-reports its size when the alternate screen buffer toggles
// (Warp does this; some Linux terminals do too) turns every fullscreen-overlay
// exit into a spurious height-only resize. Before #6511 that drove a destructive
// ED3 geometry rebuild — visible as a flicker when leaving /settings or /models
// — and the size revert that follows flashed a second one. The alt-toggle echo
// is now auto-detected and routed through the in-place repaint path.

const ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	CMUX_WORKSPACE_ID: undefined,
	CMUX_SURFACE_ID: undefined,
	CMUX_REMOTE_TRANSPORT: undefined,
	TERM_PROGRAM: undefined,
	PI_TUI_RESIZE_IN_PLACE: undefined,
};

async function withEnv(patch: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		if (patch[key] === undefined) delete Bun.env[key];
		else Bun.env[key] = patch[key];
	}
	try {
		await run();
	} finally {
		for (const key in saved) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
	}
}

class Scheduler implements RenderScheduler {
	#time = 0;
	#immediates: (() => void)[] = [];
	#renders = new Map<number, () => void>();
	#nextId = 0;
	now(): number {
		this.#time += 20;
		return this.#time;
	}
	scheduleImmediate(callback: () => void): void {
		this.#immediates.push(callback);
	}
	scheduleRender(callback: () => void): RenderTimer {
		const id = this.#nextId++;
		this.#renders.set(id, callback);
		return { cancel: () => this.#renders.delete(id) };
	}
	async flushAll(term: VirtualTerminal): Promise<void> {
		let rounds = 0;
		while (this.#immediates.length > 0 || this.#renders.size > 0) {
			if (++rounds > 100) throw new Error("did not settle");
			const immediates = this.#immediates;
			this.#immediates = [];
			for (const cb of immediates) cb();
			if (this.#immediates.length > 0) continue;
			const renders = [...this.#renders.values()];
			this.#renders.clear();
			for (const cb of renders) cb();
		}
		await term.flush();
	}
}

class Transcript implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return Array.from({ length: 30 }, (_v, i) => `line-${i}`.slice(0, width));
	}
}

class Modal implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return ["MODAL".slice(0, width)];
	}
}

describe("fullscreen overlay exit on alt-toggle-size terminals (#6511)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("auto-detects alt-toggle size echoes while respecting the explicit opt-out", async () => {
		await withEnv(ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const scheduler = new Scheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(new Transcript());
			try {
				tui.start();
				await scheduler.flushAll(term);

				const overlay = tui.showOverlay(new Modal(), { fullscreen: true });
				await scheduler.flushAll(term);

				const writes: string[] = [];
				const realWrite = term.write.bind(term);
				vi.spyOn(term, "write").mockImplementation((data: string) => {
					writes.push(data);
					realWrite(data);
				});

				// Entering the alt buffer echoed a height one row shorter; leaving the
				// overlay is seen while that echoed size is still in effect.
				term.resize(40, 9);
				await scheduler.flushAll(term);
				overlay.hide();
				await scheduler.flushAll(term);

				const exitWrites = writes.length;
				expect(writes.join("")).not.toContain("\x1b[3J");
				expect(term.getViewport().at(-1)?.trimEnd()).toBe("line-29");

				// The revert SIGWINCH back to the normal-buffer size must also stay
				// in place — otherwise the flicker just moves to the revert frame.
				term.resize(40, 10);
				await scheduler.flushAll(term);
				expect(writes.slice(exitWrites).join("")).not.toContain("\x1b[3J");
				expect(term.getViewport().at(-1)?.trimEnd()).toBe("line-29");

				// The explicit opt-out must win even after runtime auto-detection.
				// A later width drag therefore borrows the alt buffer and performs
				// its authoritative ED3 rewrap at settle.
				Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
				const optOutWrites = writes.length;
				term.resize(50, 10);
				await scheduler.flushAll(term);
				const optOut = writes.slice(optOutWrites).join("");
				expect(optOut).toContain("\x1b[?1049h");
				expect(optOut).toContain("\x1b[3J");
			} finally {
				tui.stop();
			}
		});
	});
});
