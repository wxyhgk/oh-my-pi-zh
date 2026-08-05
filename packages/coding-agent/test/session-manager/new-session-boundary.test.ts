import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

describe("SessionManager.continueRecent /new boundary", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%new-boundary-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-new-boundary-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("does not resume the pre-/new transcript when the new session produced no output", async () => {
		// Persisted old session with recognizable context (assistant output → file on disk).
		const old = SessionManager.create(cwd);
		old.appendMessage({ role: "user", content: "pre-new work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted old session file");
		await old.close();

		// Resume it, then hit an explicit `/new` boundary and exit before any
		// assistant output — the new session's JSONL is never materialized (lazy).
		const resumed = await SessionManager.continueRecent(cwd);
		expect(JSON.stringify(resumed.getEntries())).toContain("pre-new work");
		await resumed.newSession();
		const freshFile = resumed.getSessionFile();
		if (!freshFile) throw new Error("Expected a fresh session file path");
		expect(path.resolve(freshFile)).not.toBe(path.resolve(oldFile));
		expect(fs.existsSync(freshFile)).toBe(false); // lazy: not yet on disk
		await resumed.close();

		// Relaunch with auto-resume: must NOT fall back to the pre-/new transcript.
		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			const dump = JSON.stringify(relaunched.getEntries());
			expect(dump).not.toContain("pre-new work");
			expect(relaunched.getEntries()).toHaveLength(0);
			// Reopens the fresh session established by `/new`, not the old file.
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(oldFile));
		} finally {
			await relaunched.close();
		}
	});

	it("still falls back to the most-recent session for a genuinely stale breadcrumb", async () => {
		// A normal persisted session (survives).
		const first = SessionManager.create(cwd);
		first.appendMessage({ role: "user", content: "first session", timestamp: 1 });
		first.appendMessage(makeAssistantMessage());
		await first.flush();
		await first.close();

		// A distinct second session becomes the terminal's breadcrumb target and
		// materializes on disk (re-stamped non-fresh), then is externally deleted.
		const second = SessionManager.create(cwd);
		second.appendMessage({ role: "user", content: "second session", timestamp: 1 });
		second.appendMessage(makeAssistantMessage());
		await second.flush();
		const secondFile = second.getSessionFile();
		if (!secondFile) throw new Error("Expected persisted second session file");
		await second.close();
		await fsp.rm(secondFile, { force: true });

		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			// Materialized-then-deleted target (non-fresh) → fall back to the
			// most-recent surviving session, not a fresh empty one.
			expect(JSON.stringify(relaunched.getEntries())).toContain("first session");
		} finally {
			await relaunched.close();
		}
	});
});
