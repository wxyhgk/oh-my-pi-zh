import { afterEach, describe, expect, it, vi } from "bun:test";
import * as git from "@wxyhgk/pi-coding-agent/utils/git";

// Regression coverage for #6169: when `git` is not on PATH, `Bun.spawn`/
// `Bun.spawnSync` throw synchronously with `code: "ENOENT"` (`uv_spawn 'git'`)
// rather than resolving to a non-zero exit. The read-only git helpers only
// inspect the result's exit code, so an unguarded spawn escaped as an unhandled
// rejection and crashed the process. The helpers must now degrade to their
// "no result" value instead.

function throwSpawnEnoent(): never {
	const err = new Error('Executable not found in $PATH: "git"');
	(err as NodeJS.ErrnoException).code = "ENOENT";
	throw err;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("git helpers with git binary absent (#6169)", () => {
	it("status.summary degrades to null instead of throwing ENOENT", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(throwSpawnEnoent);
		// A path that is not inside a git repo forces the subprocess fallback.
		expect(await git.status.summary("/")).toBeNull();
	});

	it("diff.has surfaces a clean GitCommandError instead of a raw ENOENT rejection", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(throwSpawnEnoent);
		// `has` must tell exit 0 (no diff) from exit 1 (diff), so a missing binary
		// (exit 127) cannot collapse to a boolean — but it surfaces as the tidy
		// "git is not installed." error rather than the raw uv_spawn ENOENT crash.
		await expect(git.diff.has("/")).rejects.toThrow("未安装 git。");
	});

	it("does not blame the git binary when the cwd is what is missing", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(throwSpawnEnoent);
		// A deleted cwd also makes spawn throw ENOENT; the error must name the
		// directory, not falsely claim git is uninstalled.
		await expect(git.diff.has("/nonexistent-omp-eval-dir")).rejects.toThrow(
			"工作目录不存在: /nonexistent-omp-eval-dir",
		);
	});

	it("repo.root degrades to null instead of throwing ENOENT", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(throwSpawnEnoent);
		expect(await git.repo.root("/")).toBeNull();
	});

	it("re-raises non-ENOENT spawn failures", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			const err = new Error("EACCES: permission denied");
			(err as NodeJS.ErrnoException).code = "EACCES";
			throw err;
		});
		await expect(git.status.summary("/")).rejects.toThrow("EACCES");
	});
});
