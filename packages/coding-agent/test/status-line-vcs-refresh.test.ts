/**
 * Regression: StatusLineComponent's VCS segment was blank on the first (cold)
 * paint and only appeared after an unrelated re-render (e.g. flipping a
 * statusline setting and back). The async git-status and jj-label fetches
 * filled their caches but never called #onBranchChange, so the resolved value
 * had no way to reach the screen until something else forced a repaint. Worst
 * in a jj workspace, where there is no git branch so the PR / default-branch
 * lookups (which do fire #onBranchChange) never run.
 *
 * Contract: when an async VCS fetch resolves with a value, the component
 * requests a repaint via #onBranchChange. (Post-dispose suppression of the
 * same callback is covered by status-line-dispose-async-leak.test.ts.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { GitHeadState, GitRefHead, GitRepository } from "@oh-my-pi/pi-coding-agent/utils/git";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

type GitStatus = { staged: number; unstaged: number; untracked: number };

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "vcs-refresh test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

const fakeRefHead: GitRefHead = {
	kind: "ref",
	branchName: "main",
	ref: "refs/heads/main",
	commit: null,
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	headContent: "ref: refs/heads/main\n",
};

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

describe("StatusLineComponent repaints when an async VCS fetch resolves", () => {
	it("fires #onBranchChange when git status resolves on the cold paint", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(fakeRefHead);
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		const status = Promise.withResolvers<GitStatus | null>();
		vi.spyOn(git.status, "summary").mockReturnValue(status.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the git-status fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		status.resolve({ staged: 1, unstaged: 2, untracked: 3 });
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});

	it("fires #onBranchChange when the jj label resolves on the cold paint", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(null); // no git branch -> jj overlay
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise); // isolate the jj fire
		vi.spyOn(jj.repo, "rootSync").mockReturnValue("/fake/jj/root");
		const label = Promise.withResolvers<string | null>();
		vi.spyOn(jj.workingCopy, "label").mockReturnValue(label.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the jj-label fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		label.resolve("feature-x");
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});

	it("fires #onBranchChange when jj status resolves on the cold paint", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(null); // no git -> jj repo
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue("/fake/jj/root");
		vi.spyOn(jj.workingCopy, "label").mockReturnValue(Promise.withResolvers<string | null>().promise); // isolate the status fire
		const status = Promise.withResolvers<GitStatus | null>();
		vi.spyOn(jj.status, "summary").mockReturnValue(status.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the jj-status fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		status.resolve({ staged: 0, unstaged: 4, untracked: 1 });
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});
});
describe("StatusLineComponent reftable branch resolve honors mid-flight invalidation", () => {
	it("discards a stale resolve invalidated mid-flight, keeps the fresh one", async () => {
		// Force the reftable async-resolve path: #getCurrentBranch only spawns
		// git.head.resolve when the repo resolves as reftable.
		const fakeRepo = {
			commonDir: "/fake/.git",
			gitDir: "/fake/.git",
			gitEntryPath: "/fake/.git",
			headPath: "/fake/.git/HEAD",
			repoRoot: "/fake",
		} satisfies GitRepository;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		// Keep the sibling async fetches quiet so only the branch resolve drives
		// #onBranchChange: git.status stays in flight forever, jj is no repo here.
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);

		const refHead = (branchName: string): GitRefHead => ({
			...fakeRefHead,
			branchName,
			ref: `refs/heads/${branchName}`,
		});

		// Two controllable resolves: the stale one (R1) then the fresh one (R2).
		const r1 = Promise.withResolvers<GitHeadState | null>();
		const r2 = Promise.withResolvers<GitHeadState | null>();
		const resolveSpy = vi.spyOn(git.head, "resolve");
		resolveSpy.mockReturnValueOnce(r1.promise);
		resolveSpy.mockReturnValueOnce(r2.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		// Cold paint kicks the stale resolve (R1).
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(1);

		// A HEAD move fires the watcher: invalidateGitCaches bumps the
		// generation and releases the in-flight slot.
		component.invalidateGitCaches();

		// The repaint starts a fresh resolve (R2) for the same cwd.
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(2);

		// R1 (stale) lands first. Pre-fix it passed the in-flight-cwd guard
		// (R2 had re-set the slot), installed the stale branch, cleared the
		// marker, and caused R2 to be discarded — freezing the status line on
		// the pre-change branch.
		r1.resolve(refHead("stale-branch"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onBranchChange).not.toHaveBeenCalled();

		// R2 (fresh) lands and commits.
		r2.resolve(refHead("fresh-branch"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onBranchChange).toHaveBeenCalledTimes(1);

		// The committed value is the fresh branch, served from cache with no new
		// resolve, and the stale name never reaches the rendered segment.
		expect(git.head.resolve).toHaveBeenCalledTimes(2);
		const border = component.getTopBorder(80);
		expect(border.content).toContain("fresh-branch");
		expect(border.content).not.toContain("stale-branch");
		expect(git.head.resolve).toHaveBeenCalledTimes(2);

		component.dispose();
	});

	it("aborts an invalidated resolve and starts only one replacement resolve", async () => {
		const fakeRepo = {
			commonDir: "/fake/.git",
			gitDir: "/fake/.git",
			gitEntryPath: "/fake/.git",
			headPath: "/fake/.git/HEAD",
			repoRoot: "/fake",
		} satisfies GitRepository;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);

		const signals: AbortSignal[] = [];
		vi.spyOn(git.head, "resolve").mockImplementation((_cwd, signal) => {
			if (!signal) throw new Error("reftable resolve must receive an abort signal");
			signals.push(signal);
			const { promise, reject } = Promise.withResolvers<GitHeadState | null>();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(1);

		component.invalidateGitCaches();
		expect(signals[0]?.aborted).toBe(true);
		component.invalidateGitCaches();
		component.getTopBorder(80);
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(2);

		component.dispose();
		expect(signals[1]?.aborted).toBe(true);
		await Promise.resolve();
	});

	it("generic invalidate does not abort or restart a live reftable HEAD resolve", async () => {
		const fakeRepo = {
			commonDir: "/fake/.git",
			gitDir: "/fake/.git",
			gitEntryPath: "/fake/.git",
			headPath: "/fake/.git/HEAD",
			repoRoot: "/fake",
		} satisfies GitRepository;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);
		vi.spyOn(nodeFs, "watch").mockImplementation(() => {
			throw new Error("watch unavailable");
		});

		const signals: AbortSignal[] = [];
		const { promise, reject } = Promise.withResolvers<GitHeadState | null>();
		vi.spyOn(git.head, "resolve").mockImplementation((_cwd, signal) => {
			if (!signal) throw new Error("reftable resolve must receive an abort signal");
			signals.push(signal);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(vi.fn());
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(1);

		// Many generic invalidations (message events, model switches, theme
		// changes, …) must not abort the live resolve or fan out replacement
		// git subprocesses — the render path self-invalidates via cwd/context
		// cache-miss checks, so a generic paint only re-renders.
		for (let i = 0; i < 10; i++) {
			component.invalidate();
		}
		component.getTopBorder(80);
		component.getTopBorder(80);

		expect(signals[0]?.aborted).toBe(false);
		expect(git.head.resolve).toHaveBeenCalledTimes(1);

		// Disposal still aborts the in-flight resolve.
		component.dispose();
		expect(signals[0]?.aborted).toBe(true);
		await Promise.resolve();
	});

	it("polls a reftable branch after HEAD watcher installation fails", async () => {
		const fakeRepo = {
			commonDir: "/fake/.git",
			gitDir: "/fake/.git",
			gitEntryPath: "/fake/.git",
			headPath: "/fake/.git/HEAD",
			repoRoot: "/fake",
		} satisfies GitRepository;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);
		vi.spyOn(nodeFs, "watch").mockImplementation(() => {
			throw new Error("watch unavailable");
		});
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(git.head, "resolve")
			.mockResolvedValueOnce({ ...fakeRefHead, branchName: "before-change", ref: "refs/heads/before-change" })
			.mockResolvedValueOnce({ ...fakeRefHead, branchName: "after-change", ref: "refs/heads/after-change" });

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(vi.fn());
		component.getTopBorder(80);
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("before-change");
		expect(git.head.resolve).toHaveBeenCalledTimes(1);

		// No filesystem event arrives, but the next bounded poll observes the new HEAD.
		now += 5_001;
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(2);
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("after-change");
		component.dispose();
	});

	it("does not query an ancestor jj workspace while nested Git HEAD resolution is pending", async () => {
		const jjRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-jj-root-"));
		const nestedGitCwd = path.join(jjRootDir, "nested-ordinary-git");
		await fs.mkdir(nestedGitCwd);
		const fakeRepo = {
			commonDir: `${nestedGitCwd}/.git`,
			gitDir: `${nestedGitCwd}/.git`,
			gitEntryPath: `${nestedGitCwd}/.git`,
			headPath: `${nestedGitCwd}/.git/HEAD`,
			repoRoot: nestedGitCwd,
		} satisfies GitRepository;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		vi.spyOn(git.head, "resolve").mockReturnValue(Promise.withResolvers<GitHeadState | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const jjRoot = vi.spyOn(jj.repo, "rootSync").mockReturnValue("/workspace/jj-root");
		const jjLabel = vi.spyOn(jj.workingCopy, "label").mockReturnValue(Promise.resolve("ancestor-bookmark"));
		const jjStatus = vi
			.spyOn(jj.status, "summary")
			.mockReturnValue(Promise.resolve({ staged: 0, unstaged: 0, untracked: 0 }));
		setProjectDir(nestedGitCwd);

		try {
			const component = new StatusLineComponent(makeSession());
			component.updateSettings(gitSegment);
			component.getTopBorder(80);
			expect(git.head.resolve).toHaveBeenCalledTimes(1);
			expect(jjRoot).not.toHaveBeenCalled();
			expect(jjLabel).not.toHaveBeenCalled();
			expect(jjStatus).not.toHaveBeenCalled();
			component.dispose();
		} finally {
			setProjectDir(originalProjectDir);
			await fs.rm(jjRootDir, { recursive: true, force: true });
		}
	});

	it("does not query an ancestor jj workspace after nested Git HEAD resolution fails", async () => {
		const fakeRepo = {
			commonDir: "/nested/.git",
			gitDir: "/nested/.git",
			gitEntryPath: "/nested/.git",
			headPath: "/nested/.git/HEAD",
			repoRoot: "/nested",
		} satisfies GitRepository;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		vi.spyOn(git.head, "resolve").mockResolvedValue(null);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const jjRoot = vi.spyOn(jj.repo, "rootSync").mockReturnValue("/workspace/jj-root");

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.getTopBorder(80);
		await Promise.resolve();
		await Promise.resolve();
		component.getTopBorder(80);

		expect(git.head.resolve).toHaveBeenCalledTimes(1);
		expect(jjRoot).not.toHaveBeenCalled();
		component.dispose();
	});
});

describe("StatusLineComponent VCS watcher and jj request lifecycle", () => {
	const fakeRepo = {
		commonDir: "/fake/.git",
		gitDir: "/fake/.git",
		gitEntryPath: "/fake/.git",
		headPath: "/fake/.git/HEAD",
		repoRoot: "/fake",
	} satisfies GitRepository;

	it("retires an asynchronously failed watcher without an unhandled EventEmitter error", () => {
		const firstWatcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as nodeFs.FSWatcher;
		const failedWatcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as nodeFs.FSWatcher;
		const disposedWatcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as nodeFs.FSWatcher;
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fakeRepo);
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(false);
		vi.spyOn(git.head, "resolveSync")
			.mockReturnValueOnce({ ...fakeRefHead, branchName: "before-error", ref: "refs/heads/before-error" })
			.mockReturnValueOnce({ ...fakeRefHead, branchName: "after-error", ref: "refs/heads/after-error" });
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);
		vi.spyOn(nodeFs, "watch")
			.mockReturnValueOnce(firstWatcher)
			.mockReturnValueOnce(failedWatcher)
			.mockReturnValueOnce(disposedWatcher);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);
		component.getTopBorder(80);
		expect(firstWatcher.listenerCount("error")).toBe(1);

		// Replacement detaches the first listener before closing that watcher.
		component.updateSettings(gitSegment);
		expect(firstWatcher.listenerCount("error")).toBe(0);
		expect(firstWatcher.close).toHaveBeenCalledTimes(1);
		expect(failedWatcher.listenerCount("error")).toBe(1);

		// `error` without a listener throws synchronously. The component must own
		// the event, retire the watcher, and request the repaint that observes the
		// invalidated VCS cache.
		expect(() => failedWatcher.emit("error", new Error("watch failed"))).not.toThrow();
		expect(failedWatcher.listenerCount("error")).toBe(0);
		expect(failedWatcher.close).toHaveBeenCalledTimes(1);
		expect(onBranchChange).toHaveBeenCalledTimes(1);
		expect(component.getTopBorder(80).content).toContain("after-error");

		component.updateSettings(gitSegment);
		expect(disposedWatcher.listenerCount("error")).toBe(1);
		component.dispose();
		expect(disposedWatcher.listenerCount("error")).toBe(0);
		expect(disposedWatcher.close).toHaveBeenCalledTimes(1);
	});

	it("discovers a repository created after setup with bounded single-flight polling", async () => {
		let now = 1_000_000;
		const repositoryCreatedAt = now + 5_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(git.repo, "resolveSync").mockImplementation(() => (now >= repositoryCreatedAt ? fakeRepo : null));
		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(true);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);
		const head = Promise.withResolvers<GitHeadState | null>();
		vi.spyOn(git.head, "resolve").mockReturnValue(head.promise);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(vi.fn());
		component.getTopBorder(80);
		expect(git.head.resolve).not.toHaveBeenCalled();

		now += 1_000;
		component.getTopBorder(80);
		expect(git.head.resolve).not.toHaveBeenCalled();

		// The bounded discovery interval reaches the new repository. Repeated
		// paints while its reftable resolve is hung must reuse the one request.
		now += 4_001;
		component.getTopBorder(80);
		component.getTopBorder(80);
		expect(git.head.resolve).toHaveBeenCalledTimes(1);

		head.resolve({ ...fakeRefHead, branchName: "created-later", ref: "refs/heads/created-later" });
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("created-later");
		component.dispose();
	});

	it("aborts superseded jj branch and status queries without blocking their replacements", async () => {
		vi.spyOn(git.head, "resolveSync").mockReturnValue(null);
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue("/fake/jj/root");

		const labelRequests: Array<{ signal: AbortSignal; resolve: (value: string | null) => void }> = [];
		vi.spyOn(jj.workingCopy, "label").mockImplementation((_root, options) => {
			if (!options?.signal || options.timeoutMs !== jj.JJ_COMMAND_TIMEOUT_MS) {
				throw new Error("jj label requires the central bounded options");
			}
			const request = Promise.withResolvers<string | null>();
			options.signal.addEventListener("abort", () => request.resolve(null), { once: true });
			labelRequests.push({ signal: options.signal, resolve: request.resolve });
			return request.promise;
		});
		const statusRequests: Array<{ signal: AbortSignal; resolve: (value: GitStatus | null) => void }> = [];
		vi.spyOn(jj.status, "summary").mockImplementation((_root, options) => {
			if (!options?.signal || options.timeoutMs !== jj.JJ_COMMAND_TIMEOUT_MS) {
				throw new Error("jj status requires the central bounded options");
			}
			const request = Promise.withResolvers<GitStatus | null>();
			options.signal.addEventListener("abort", () => request.resolve(null), { once: true });
			statusRequests.push({ signal: options.signal, resolve: request.resolve });
			return request.promise;
		});

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.getTopBorder(80);
		expect(labelRequests).toHaveLength(1);
		expect(statusRequests).toHaveLength(1);

		component.invalidateGitCaches();
		expect(labelRequests[0]?.signal.aborted).toBe(true);
		expect(statusRequests[0]?.signal.aborted).toBe(true);
		component.getTopBorder(80);
		expect(labelRequests).toHaveLength(2);
		expect(statusRequests).toHaveLength(2);

		labelRequests[1]?.resolve("fresh-bookmark");
		statusRequests[1]?.resolve({ staged: 0, unstaged: 1, untracked: 0 });
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("fresh-bookmark");

		component.invalidateGitCaches();
		component.getTopBorder(80);
		expect(labelRequests).toHaveLength(3);
		expect(statusRequests).toHaveLength(3);
		component.dispose();
		expect(labelRequests[2]?.signal.aborted).toBe(true);
		expect(statusRequests[2]?.signal.aborted).toBe(true);
		await Promise.resolve();
	});
});

describe("StatusLineComponent applyCwdChange re-points watcher ownership", () => {
	let dirA: string;
	let dirB: string;
	let dirNoRepo: string;
	let repoA: GitRepository;
	let repoB: GitRepository;

	beforeAll(async () => {
		dirA = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-repoA-"));
		dirB = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-repoB-"));
		dirNoRepo = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-norepo-"));
		repoA = {
			commonDir: path.join(dirA, ".git"),
			gitDir: path.join(dirA, ".git"),
			gitEntryPath: path.join(dirA, ".git"),
			headPath: path.join(dirA, ".git", "HEAD"),
			repoRoot: dirA,
		};
		repoB = {
			commonDir: path.join(dirB, ".git"),
			gitDir: path.join(dirB, ".git"),
			gitEntryPath: path.join(dirB, ".git"),
			headPath: path.join(dirB, ".git", "HEAD"),
			repoRoot: dirB,
		};
	});

	afterAll(async () => {
		setProjectDir(originalProjectDir);
		await Promise.all([
			fs.rm(dirA, { recursive: true, force: true }),
			fs.rm(dirB, { recursive: true, force: true }),
			fs.rm(dirNoRepo, { recursive: true, force: true }),
		]);
	});

	// Test double for node:fs.FSWatcher — extends EventEmitter with just the
	// `close` method the component calls. FSWatcher has dozens of members we
	// never exercise, so a structural implementation would be pure ceremony.
	function createFakeWatcher(): nodeFs.FSWatcher {
		return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as nodeFs.FSWatcher;
	}

	it("retires the old watcher and re-points at the new repo on cwd change", () => {
		const watcherA = createFakeWatcher();
		const watcherB = createFakeWatcher();

		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(false);
		vi.spyOn(git.repo, "linkedWorktreeSync").mockReturnValue(null);
		vi.spyOn(git.repo, "resolveSync").mockImplementation((cwd: string) => {
			if (cwd === dirA) return repoA;
			if (cwd === dirB) return repoB;
			return null;
		});
		vi.spyOn(git.head, "resolveSync").mockImplementation((cwd: string) => {
			if (cwd === dirA) return { ...fakeRefHead, branchName: "branch-a", ref: "refs/heads/branch-a" };
			if (cwd === dirB) return { ...fakeRefHead, branchName: "branch-b", ref: "refs/heads/branch-b" };
			return null;
		});
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);
		const watchSpy = vi.spyOn(nodeFs, "watch").mockReturnValueOnce(watcherA).mockReturnValueOnce(watcherB);

		const onBranchChange = vi.fn();
		setProjectDir(dirA);
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);
		expect(component.getTopBorder(80).content).toContain("branch-a");

		// Move cwd to repo B — the SessionManager's cwd has already moved.
		setProjectDir(dirB);
		component.applyCwdChange();
		// applyCwdChange itself requests one repaint; clear it so subsequent
		// calls are attributable solely to watcher events.
		onBranchChange.mockClear();

		// Old watcher is retired: closed and its error listener detached.
		expect(watcherA.close).toHaveBeenCalledTimes(1);
		expect(watcherA.listenerCount("error")).toBe(0);
		// New watcher is live with an error listener attached.
		expect(watcherB.listenerCount("error")).toBe(1);

		// fs.watch is mocked to return EventEmitters without registering the
		// change callback, so extract it from the call args and attach it.
		const aCallArgs = watchSpy.mock.calls[0];
		const bCallArgs = watchSpy.mock.calls[1];
		const aListener = aCallArgs?.[1];
		const bListener = bCallArgs?.[1];
		expect(typeof aListener).toBe("function");
		expect(typeof bListener).toBe("function");
		if (typeof aListener === "function") watcherA.on("change", aListener as () => void);
		if (typeof bListener === "function") watcherB.on("change", bListener as () => void);

		// Stale change event from repo A's retired watcher must not invalidate
		// B's caches or request a repaint — the ownership guard rejects it.
		watcherA.emit("change");
		expect(onBranchChange).not.toHaveBeenCalled();

		// Fresh change event from repo B's watcher refreshes B.
		onBranchChange.mockClear();
		watcherB.emit("change");
		expect(onBranchChange).toHaveBeenCalledTimes(1);
		expect(component.getTopBorder(80).content).toContain("branch-b");

		// No watcher leak: dispose closes B, not A (A was already closed).
		component.dispose();
		expect(watcherB.close).toHaveBeenCalledTimes(1);
		expect(watcherB.listenerCount("error")).toBe(0);
		expect(watcherA.close).toHaveBeenCalledTimes(1);
	});

	it("falls back to bounded polling when the new cwd has no repository", () => {
		const watcherA = createFakeWatcher();

		vi.spyOn(git.repo, "isReftableSync").mockReturnValue(false);
		vi.spyOn(git.repo, "linkedWorktreeSync").mockReturnValue(null);
		vi.spyOn(git.repo, "resolveSync").mockImplementation((cwd: string) => {
			if (cwd === dirA) return repoA;
			return null;
		});
		vi.spyOn(git.head, "resolveSync").mockImplementation((cwd: string) => {
			if (cwd === dirA) return { ...fakeRefHead, branchName: "branch-a", ref: "refs/heads/branch-a" };
			return null;
		});
		vi.spyOn(git.branch, "default").mockReturnValue(Promise.withResolvers<string | null>().promise);
		vi.spyOn(git.status, "summary").mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(jj.repo, "rootSync").mockReturnValue(null);
		vi.spyOn(nodeFs, "watch").mockReturnValueOnce(watcherA);

		const onBranchChange = vi.fn();
		setProjectDir(dirA);
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);
		component.getTopBorder(80);

		// Move to a directory with no git repo — watcher unavailable fallback.
		setProjectDir(dirNoRepo);
		onBranchChange.mockClear();
		component.applyCwdChange();

		// Old watcher retired; no new watcher created (fs.watch not called again).
		expect(watcherA.close).toHaveBeenCalledTimes(1);
		expect(nodeFs.watch).toHaveBeenCalledTimes(1);
		// applyCwdChange still requests a repaint so the stale segment clears.
		expect(onBranchChange).toHaveBeenCalledTimes(1);

		// Rendering does not crash and the git segment is blank for no-repo.
		const border = component.getTopBorder(80);
		expect(border).toBeDefined();
		expect(border.content).not.toContain("branch-a");

		component.dispose();
	});
});
