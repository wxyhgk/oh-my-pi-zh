import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

describe("jj workspace detection", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		jj.repo.clearRootCache();
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = undefined;
		}
	});

	async function createTempDir(): Promise<string> {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-utils-"));
		return tmpDir;
	}

	it("finds JJ workspace metadata from a nested cwd", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "packages", "coding-agent");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(jj.repo.rootSync(nested)).toBe(dir);
		expect(await jj.repo.root(nested)).toBe(dir);
		expect(await jj.repo.is(nested)).toBe(true);
	});

	it("caches each requested cwd to its resolved workspace root", async () => {
		const dir = await createTempDir();
		const nested = path.join(dir, "src", "feature");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(nested, { recursive: true });

		expect(jj.repo.rootSync(nested)).toBe(dir);
		expect(await jj.repo.root(nested)).toBe(dir);
		await removeWithRetries(path.join(dir, ".jj"));

		expect(await jj.repo.root(nested)).toBe(dir);
		expect(await jj.repo.root(path.join(dir, "src"))).toBeNull();
	});

	it("does not treat a bare .jj directory as a workspace", async () => {
		const dir = await createTempDir();
		await fs.mkdir(path.join(dir, ".jj"), { recursive: true });

		expect(jj.repo.rootSync(dir)).toBeNull();
		expect(await jj.repo.root(dir)).toBeNull();
		expect(await jj.repo.is(dir)).toBe(false);
	});

	it("detects a non-default workspace whose .jj/repo is a file", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		// Default workspace: `.jj/repo/` is a directory containing the store.
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		// `jj workspace add` workspace: `.jj/repo` is a FILE pointing — relative to
		// `.jj` — at the shared repo dir of the default workspace.
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		expect(jj.repo.rootSync(secondary)).toBe(secondary);
		expect(await jj.repo.is(secondary)).toBe(true);
		expect(await jj.repo.root(secondary)).toBe(secondary);
	});

	it("resolves storeDir to the shared store for a non-default workspace", async () => {
		const dir = await createTempDir();
		const secondary = path.join(dir, "ws2");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await fs.mkdir(path.join(secondary, ".jj", "working_copy"), { recursive: true });
		await fs.writeFile(path.join(secondary, ".jj", "repo"), path.join("..", "..", ".jj", "repo"));

		const resolved = await jj.repo.resolve(secondary);
		expect(resolved?.repoRoot).toBe(secondary);
		expect(resolved?.storeDir).toBe(path.join(dir, ".jj", "repo", "store"));
	});
});

describe("isPureJjRepo", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		jj.repo.clearRootCache();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function initGit(dir: string): Promise<void> {
		const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
		const exit = async (args: string[]) => {
			const proc = Bun.spawn(["git", "-C", dir, ...args], { env, stdout: "ignore", stderr: "pipe" });
			const code = await proc.exited;
			if (code !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
			}
		};
		await exit(["init", "-q", "-b", "main"]);
		await exit(["config", "user.email", "test@example.com"]);
		await exit(["config", "user.name", "Test"]);
	}

	it("flags a pure jj workspace (no colocated git)", async () => {
		const dir = await createTempDir("omp-jj-pure-");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		expect(await jj.isPureJjRepo(dir)).toBe(true);
	});

	it("treats a colocated jj-git workspace as non-pure", async () => {
		const dir = await createTempDir("omp-jj-colocated-");
		await fs.mkdir(path.join(dir, ".jj", "repo", "store"), { recursive: true });
		await initGit(dir);
		expect(await jj.isPureJjRepo(dir)).toBe(false);
	});

	it("returns false for a plain git checkout (no jj metadata)", async () => {
		const dir = await createTempDir("omp-jj-plaingit-");
		await initGit(dir);
		expect(await jj.isPureJjRepo(dir)).toBe(false);
	});

	it("returns false when neither jj nor git metadata is present", async () => {
		const dir = await createTempDir("omp-jj-empty-");
		expect(await jj.isPureJjRepo(dir)).toBe(false);
	});

	it("flags a jj workspace nested inside an unrelated git checkout as pure", async () => {
		const outer = await createTempDir("omp-jj-nested-outer-");
		await initGit(outer);
		const inner = path.join(outer, "nested");
		await fs.mkdir(path.join(inner, ".jj", "repo", "store"), { recursive: true });
		// The inner directory is its own jj workspace; the surrounding git
		// checkout would mutate state outside jj's model.
		expect(await jj.isPureJjRepo(inner)).toBe(true);
	});

	it("treats a nested git checkout under an outer jj workspace as non-pure", async () => {
		// `git.repo.root(inner)` returns the inner .git, so Git automation
		// targets the nested checkout safely and never touches the surrounding
		// jj tree — the inner git wins.
		const outer = await createTempDir("omp-jj-nested-jj-outer-");
		await fs.mkdir(path.join(outer, ".jj", "repo", "store"), { recursive: true });
		const inner = path.join(outer, "vendor");
		await fs.mkdir(inner, { recursive: true });
		await initGit(inner);
		expect(await jj.isPureJjRepo(inner)).toBe(false);
	});
});

describe("jj working-copy label", () => {
	it("uses the nearest bookmark, then falls back to the current change ID", () => {
		expect(jj.workingCopy.parseLabel("kvisqosn|on-branch\nqlnsqysu|ancestor\n")).toBe("on-branch");
		expect(jj.workingCopy.parseLabel("kvisqosn|\nqlnsqysu|ancestor\n")).toBe("ancestor");
		expect(jj.workingCopy.parseLabel("kvisqosn|\n")).toBe("kvisqosn");
	});

	it("returns null for empty output", () => {
		expect(jj.workingCopy.parseLabel("  \n\t ")).toBeNull();
	});
});

describe("jj status", () => {
	it("maps added files to untracked and all other changes to unstaged", () => {
		expect(jj.status.parse("M a.ts\nA b.ts\nA c.ts\nD d.ts\nM e.ts\n")).toEqual({
			staged: 0,
			unstaged: 3,
			untracked: 2,
		});
	});

	it("reports a clean working copy as all zeros", () => {
		expect(jj.status.parse("")).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
	});
});

describe("jj subprocess deadlines", () => {
	type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
		Bun.SpawnOptions.Writable,
		Bun.SpawnOptions.Readable,
		Bun.SpawnOptions.Readable
	>;
	const calls: SpawnOptions[] = [];

	afterEach(() => {
		calls.length = 0;
		vi.restoreAllMocks();
	});

	function textStream(text = ""): ReadableStream<Uint8Array> {
		const body = new Response(text).body;
		if (!body) throw new Error("missing response body");
		return body;
	}

	function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		calls.push(Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : first);
		return {
			pid: 12345,
			stdout: textStream(),
			stderr: textStream(),
			exited: Promise.resolve(0),
		} as Subprocess;
	}

	it("combines caller cancellation with a finite subprocess deadline", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
		const controller = new AbortController();

		await jj.workingCopy.label("/fake", { signal: controller.signal, timeoutMs: 1 });
		const signal = calls[0]?.signal;
		expect(signal).toBeDefined();
		expect(signal).not.toBe(controller.signal);
		expect(signal?.aborted).toBe(false);

		controller.abort();
		expect(signal?.aborted).toBe(true);
	});

	it("aborts the spawned process signal at its explicit deadline", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);

		await jj.status.summary("/fake", { timeoutMs: 1 });
		const signal = calls[0]?.signal;
		expect(signal?.aborted).toBe(false);
		await Bun.sleep(10);
		expect(signal?.aborted).toBe(true);
	});
});
