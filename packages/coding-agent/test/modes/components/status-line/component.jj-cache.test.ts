import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { Settings, settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "../../../../src/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "../../../../src/modes/theme/theme";
import type { AgentSession } from "../../../../src/session/agent-session";
import * as git from "../../../../src/utils/git";
import * as jj from "../../../../src/utils/jj";

// Minimal session the git-only status line render path touches: state.messages
// (token-rate scan), model window, streaming flag, and the async-job snapshot.
// The `git` segment reads none of these — they only keep #buildStatusLine from
// throwing while it renders the single segment under test.
function makeSession(): AgentSession {
	const model = { contextWindow: 128000 } as const;
	return {
		state: { messages: [], model },
		messages: [],
		model,
		isStreaming: false,
		sessionFile: undefined,
		getAsyncJobSnapshot: () => null,
		getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
	} as unknown as AgentSession;
}

// Drain the microtask queue so the fire-and-forget async jj lookups started by a
// render() have applied their result to the cache. No real timers: only
// already-resolved promises are awaited, so this stays deterministic.
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

// Strip SGR/OSC escapes so assertions match on the visible branch label text.
function visible(s: string): string {
	return s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

const WIDTH = 200;

let spies: Array<{ mockRestore(): void }> = [];
let tmpA: string;
let tmpB: string;
let originalProjectDir: string;
const ROOT_A = "/virtual/jj-root-a";
const ROOT_B = "/virtual/jj-root-b";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
	// Render only the git segment: shrinks the render surface to the code under
	// test and keeps the fake session tiny. Constructor snapshots these, so they
	// must be set before any `new StatusLineComponent`.
	settings.override("statusLine.preset", "custom");
	settings.override("statusLine.leftSegments", ["git"]);
	settings.override("statusLine.rightSegments", []);
	originalProjectDir = getProjectDir();
	tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "jjcache-a-"));
	tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "jjcache-b-"));
});

afterAll(() => {
	settings.clearOverride("statusLine.preset");
	settings.clearOverride("statusLine.leftSegments");
	settings.clearOverride("statusLine.rightSegments");
	setProjectDir(originalProjectDir);
	fs.rmSync(tmpA, { recursive: true, force: true });
	fs.rmSync(tmpB, { recursive: true, force: true });
});

beforeEach(() => {
	// Force the jj fallback branch in #buildSegmentContext: git HEAD resolves to
	// null (so gitBranch === null triggers #getJjBranch), and no repo/worktree is
	// detected (so effectiveGitCwd stays the raw project dir we control).
	spies = [
		spyOn(git.head, "resolveSync").mockReturnValue(null),
		spyOn(git.repo, "resolveSync").mockReturnValue(null),
		spyOn(git.repo, "linkedWorktreeSync").mockReturnValue(null),
		// jj status: return a clean summary so #getJjStatus never falls through to
		// the real `git status` subprocess. Keeps the git segment's status empty so
		// the visible content is exactly the branch label.
		spyOn(jj.status, "summary").mockResolvedValue({ staged: 0, unstaged: 0, untracked: 0 }),
		// Map each controlled project dir to a stable virtual jj root.
		spyOn(jj.repo, "rootSync").mockImplementation(cwd => {
			if (cwd === tmpA) return ROOT_A;
			if (cwd === tmpB) return ROOT_B;
			return null;
		}),
	];
	setProjectDir(tmpA);
});

afterEach(() => {
	for (const s of spies) s.mockRestore();
	spies = [];
});

describe("StatusLineComponent jj cache coherence", () => {
	it("invalidateGitCaches() drops the throttled jj branch cache within its TTL and refetches", async () => {
		// A live jj bookmark label; a second query for the SAME root returns a new
		// label, simulating a colocated bookmark/HEAD move mid-TTL.
		const branchSpy = spyOn(jj.workingCopy, "label").mockResolvedValue("bookmark-v1");
		spies.push(branchSpy);

		const statusLine = new StatusLineComponent(makeSession());

		// First render kicks off the async lookup (returns the empty cache); after
		// it resolves, a second render paints the fetched label.
		statusLine.getTopBorder(WIDTH);
		await flushMicrotasks();
		expect(visible(statusLine.getTopBorder(WIDTH).content)).toContain("bookmark-v1");
		expect(branchSpy).toHaveBeenCalledTimes(1);

		// Move the bookmark: a plain render within the 5s TTL must keep serving the
		// cached label without a refetch (guards that the TTL is real, so the next
		// assertion proves invalidateGitCaches() — not TTL expiry — forces the refresh).
		branchSpy.mockResolvedValue("bookmark-v2");
		const throttled = visible(statusLine.getTopBorder(WIDTH).content);
		await flushMicrotasks();
		expect(throttled).toContain("bookmark-v1");
		expect(branchSpy).toHaveBeenCalledTimes(1);

		// A HEAD/bookmark change must explicitly reset the jj caches so the next
		// render refetches despite being inside the TTL and paints the new label.
		statusLine.invalidateGitCaches();
		statusLine.getTopBorder(WIDTH);
		await flushMicrotasks();
		expect(branchSpy).toHaveBeenCalledTimes(2);
		expect(visible(statusLine.getTopBorder(WIDTH).content)).toContain("bookmark-v2");
		expect(visible(statusLine.getTopBorder(WIDTH).content)).not.toContain("bookmark-v1");
	});

	it("a jj lookup that resolves after the root changed never lands in the new root's cache", async () => {
		// Root A's query hangs on a deferred so it is still in flight when we
		// switch repos; root B resolves with its own label.
		const deferredA = Promise.withResolvers<string | null>();
		const branchSpy = spyOn(jj.workingCopy, "label").mockImplementation(async root => {
			if (root === ROOT_A) return deferredA.promise;
			if (root === ROOT_B) return "branch-B";
			return null;
		});
		spies.push(branchSpy);

		const statusLine = new StatusLineComponent(makeSession());

		// Render in repo A: starts the (hanging) lookup for ROOT_A. Nothing painted
		// yet — the cache is empty and the query is unresolved.
		expect(visible(statusLine.getTopBorder(WIDTH).content)).not.toContain("branch-A-STALE");
		expect(branchSpy).toHaveBeenCalledTimes(1);

		// Switch to repo B mid-flight. The cwd-change caller explicitly resets the
		// VCS caches, aborting ROOT_A's in-flight query and clearing the slot so
		// B's lookup can start immediately on the next render.
		setProjectDir(tmpB);
		statusLine.invalidateGitCaches();
		statusLine.getTopBorder(WIDTH);
		await flushMicrotasks();
		expect(branchSpy).toHaveBeenCalledTimes(2);

		// Let ROOT_A's slow query finish, then drain its continuation. The
		// generation guard must DROP it, so A's label never becomes B's cached
		// branch and its completion cannot advance B's throttle (leaving B free
		// to refetch) — the finding-2/4 contract.
		deferredA.resolve("branch-A-STALE");
		await flushMicrotasks();

		// The very next render paints synchronously from the current cache BEFORE
		// any new fetch resolves. This is the only window the transient stale is
		// observable: with the fix the cache is empty here (A's result was
		// dropped), so this render both refuses to paint A's label AND is free to
		// launch B's refetch. Without the fix, A's stale label is already sitting
		// in B's cache and paints here.
		const paintedImmediate = visible(statusLine.getTopBorder(WIDTH).content);
		expect(paintedImmediate).not.toContain("branch-A-STALE");

		// Steady state: B's (now unthrottled) refetch resolves and paints B's real
		// label — confirming the switch left B's cache coherent, not poisoned.
		await flushMicrotasks();
		expect(visible(statusLine.getTopBorder(WIDTH).content)).toContain("branch-B");
	});

	it("a jj lookup that resolves after a same-root invalidation never lands as stale", async () => {
		// The finding-6 race: a HEAD/bookmark move invalidates the caches while a
		// branch query for the SAME root is still in flight. #invalidateGitCaches
		// resets #jjRoot, but the next render re-resolves it to the identical root
		// string — so a guard keyed only on root equality would accept the
		// pre-invalidation result. The generation token must reject it.
		const deferred = Promise.withResolvers<string | null>();
		let call = 0;
		const branchSpy = spyOn(jj.workingCopy, "label").mockImplementation(async () => {
			call++;
			// First query (pre-invalidation) hangs; later queries return the fresh label.
			return call === 1 ? deferred.promise : "bookmark-fresh";
		});
		spies.push(branchSpy);

		const statusLine = new StatusLineComponent(makeSession());

		// Render in ROOT_A: starts the (hanging) first lookup. Nothing cached yet.
		statusLine.getTopBorder(WIDTH);
		await flushMicrotasks();
		expect(branchSpy).toHaveBeenCalledTimes(1);

		// A HEAD/bookmark move fires the watcher → invalidateGitCaches(). The cwd is
		// unchanged, so the next #jjRootFor re-resolves #jjRoot to the SAME ROOT_A.
		statusLine.invalidateGitCaches();
		statusLine.getTopBorder(WIDTH);
		await flushMicrotasks();

		// The stale first query now resolves. The generation captured at its launch
		// no longer matches (invalidate bumped it), so its label must be dropped —
		// never cached, and the throttle must NOT be advanced on it.
		deferred.resolve("bookmark-stale");
		await flushMicrotasks();
		const paintedImmediate = visible(statusLine.getTopBorder(WIDTH).content);
		expect(paintedImmediate).not.toContain("bookmark-stale");

		// Because the stale result did not advance the throttle, the post-invalidate
		// cache is free to refetch and paint the fresh label.
		await flushMicrotasks();
		expect(visible(statusLine.getTopBorder(WIDTH).content)).toContain("bookmark-fresh");
		expect(branchSpy).toHaveBeenCalledTimes(2);
	});
});
