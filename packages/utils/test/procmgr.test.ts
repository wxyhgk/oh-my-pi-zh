import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "../src/dirs";
import { getShellConfig, resolveWindowsShell } from "../src/procmgr";

describe("getShellConfig", () => {
	it("directs invalid custom shell paths to the canonical config file", () => {
		const missingShell = path.join(os.tmpdir(), `omp-missing-shell-${process.pid}`, "bash");
		const configPath = path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
		expect(() => getShellConfig(missingShell)).toThrow(
			`Custom shell path not found: ${missingShell}\nPlease update shellPath in ${configPath}`,
		);
	});
});

describe("resolveWindowsShell", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeGitRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-git-root-"));
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, "bin"), { recursive: true });
		fs.writeFileSync(path.join(root, "bin", "bash.exe"), "");
		return root;
	}

	it("finds scoop's Git Bash via GIT_INSTALL_ROOT despite bash.exe missing from PATH", () => {
		// scoop's git manifest sets GIT_INSTALL_ROOT and shims sh.exe/git.exe but
		// never bash.exe, so PATH lookup alone misses the install.
		const root = makeGitRoot();
		expect(resolveWindowsShell({ GIT_INSTALL_ROOT: root })).toBe(path.join(root, "bin", "bash.exe"));
	});

	it("finds Git Bash in the default scoop app dir via USERPROFILE", () => {
		const profile = fs.mkdtempSync(path.join(os.tmpdir(), "omp-profile-"));
		tempDirs.push(profile);
		const root = path.join(profile, "scoop", "apps", "git", "current");
		fs.mkdirSync(path.join(root, "bin"), { recursive: true });
		fs.writeFileSync(path.join(root, "bin", "bash.exe"), "");
		expect(resolveWindowsShell({ USERPROFILE: profile })).toBe(path.join(root, "bin", "bash.exe"));
	});

	it("prefers a Git for Windows install root over the cmd.exe fallback", () => {
		const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "omp-programfiles-"));
		tempDirs.push(programFiles);
		const bash = path.join(programFiles, "Git", "bin", "bash.exe");
		fs.mkdirSync(path.dirname(bash), { recursive: true });
		fs.writeFileSync(bash, "");
		expect(resolveWindowsShell({ ProgramFiles: programFiles, ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toBe(bash);
	});

	// On a real Windows host bash.exe/sh.exe may resolve from PATH before the
	// cmd.exe fallback is reached, so the fallback contract is only
	// deterministic off-Windows.
	it.skipIf(process.platform === "win32")("falls back to cmd.exe instead of failing when no bash exists", () => {
		expect(resolveWindowsShell({})).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(resolveWindowsShell({ ComSpec: "D:\\win\\cmd.exe" })).toBe("D:\\win\\cmd.exe");
	});
});
