import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression probe for https://github.com/can1357/oh-my-pi/issues/4863
//
// On ConPTY hosts (native Windows + WSL) a full paint over a large transcript
// is bounded by #truncateLargeConptyFrame: it keeps only the tail and replaces
// the older committed prefix with an "older lines hidden" marker. That bound is
// wanted for the *initial* session resume (issue #2115) where a multi-megabyte
// synchronized frame stalls conhost. But it also fired on the user-initiated
// Ctrl+O expand (resetDisplay), so pressing Ctrl+O to review the whole session
// dropped everything above the retained tail. The reporter hit this under WSL.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");
const WSL_DISTRO_NAME = process.env.WSL_DISTRO_NAME;
const TMUX = process.env.TMUX;

// A full paint clears the viewport with ED2 (`CSI 2 J`), or — when it also
// clears native scrollback — homes the cursor and emits ED3 (`CSI H CSI 3 J`)
// without blanking first. Match either so the probe tracks the paint intent,
// not one emitter's escape choice.
const isFullPaint = (write: string): boolean => write.includes("\x1b[2J") || write.includes("\x1b[H\x1b[3J");

class LargeContent implements Component {
	#lines: string[];

	constructor(lineCount: number) {
		this.#lines = [];
		for (let i = 0; i < lineCount; i++) {
			this.#lines.push(`row ${i.toString().padStart(5, "0")}: ${"x".repeat(100)}`);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rendered = new Array<string>(this.#lines.length);
		for (let i = 0; i < this.#lines.length; i++) rendered[i] = this.#lines[i]!.slice(0, width);
		return rendered;
	}
}

describe("issue #4863: Ctrl+O full-view expand truncates the session on ConPTY", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		if (WSL_DISTRO_NAME === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = WSL_DISTRO_NAME;
		if (TMUX === undefined) delete process.env.TMUX;
		else process.env.TMUX = TMUX;
		vi.restoreAllMocks();
	});

	it("does not drop older transcript rows on a user-driven resetDisplay under WSL", async () => {
		// Reporter's environment: WSL. isConPTYHosted() is true on linux when a
		// WSL marker is present (stdout still crosses into ConPTY at wslhost).
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		// ~8000 * ~110 bytes ≈ 880 KiB — over the 512 KiB ConPTY truncate threshold.
		tui.addChild(new LargeContent(8000));

		try {
			tui.start();
			await term.waitForRender();

			// The user presses Ctrl+O; the app calls resetDisplay() to replay the
			// whole transcript at its expanded heights.
			writes.length = 0;
			tui.resetDisplay();
			await term.waitForRender();

			const resetPaint = writes.find(isFullPaint);
			expect(resetPaint).toBeDefined();
			// The Ctrl+O replay must NOT hide the top of the session.
			expect(resetPaint).not.toContain("older lines hidden");
			expect(term.getScrollBuffer().some(line => line.includes("row 00000"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("still bounds the initial session-resume paint on ConPTY (issue #2115)", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeContent(8000));

		try {
			tui.start({ clearScrollback: true });
			await term.waitForRender();

			const resumePaint = writes.find(isFullPaint);
			expect(resumePaint).toBeDefined();
			// The first paint is a resume replay — it stays bounded.
			expect(resumePaint).toContain("older lines hidden");
			expect(Buffer.byteLength(resumePaint ?? "", "utf8")).toBeLessThan(128 * 1024);
		} finally {
			tui.stop();
		}
	});

	it("bounds a session replace after a resetDisplay update under WSL+tmux", async () => {
		// Under a multiplexer, resetDisplay() is an in-place update rather than
		// a full paint. Its one-shot unbounded intent must be consumed by that
		// update, not leak into the next /resume or handoff replacement.
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		process.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const term = new VirtualTerminal(80, 24, 20_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeContent(8000));

		try {
			tui.start();
			await term.waitForRender();

			// Ctrl+O/toggle reset: resizeRepaintsInPlace() makes this an update.
			writes.length = 0;
			tui.resetDisplay();
			await term.waitForRender();
			expect(writes.some(isFullPaint)).toBe(false);

			// Then simulate /resume: the later bulk replace must still be bounded.
			writes.length = 0;
			tui.requestRender(true, { clearScrollback: true });
			await term.waitForRender();

			const replacePaint = writes.find(isFullPaint);
			expect(replacePaint).toBeDefined();
			expect(replacePaint).toContain("older lines hidden");
			expect(Buffer.byteLength(replacePaint ?? "", "utf8")).toBeLessThan(128 * 1024);
		} finally {
			tui.stop();
		}
	});
});
