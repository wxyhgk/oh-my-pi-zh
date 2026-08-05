/**
 * `issue://` / `pr://` protocol handler tests.
 *
 * Every test isolates `OMP_GITHUB_CACHE_DB` to a temp file and resets the
 * cache + router singletons. `git.github.json` / `git.github.text` are spied
 * per-test and restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@wxyhgk/pi-coding-agent/internal-urls";
import { resetForTests as resetCacheForTests } from "@wxyhgk/pi-coding-agent/tools/github-cache";
import * as git from "@wxyhgk/pi-coding-agent/utils/git";
import { removeWithRetries } from "@wxyhgk/pi-utils";

let tempDir: string;
let originalEnv: string | undefined;

let originalGhToken: string | undefined;
beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pr-protocol-"));
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	originalGhToken = process.env.GH_TOKEN;
	process.env.GH_TOKEN = "test-token";
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
});

afterEach(async () => {
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	if (originalEnv === undefined) {
		delete process.env.OMP_GITHUB_CACHE_DB;
	} else {
		process.env.OMP_GITHUB_CACHE_DB = originalEnv;
	}
	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

function issuePayload(number: number, body: string, commentBodies: string[] = []) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		stateReason: null,
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/owner/example/issues/${number}`,
		labels: [],
		comments: commentBodies.map((cb, idx) => ({
			author: { login: `user${idx}` },
			body: cb,
			createdAt: "2026-04-01T11:00:00Z",
			url: `https://github.com/owner/example/issues/${number}#issuecomment-${idx + 1}`,
			isMinimized: false,
		})),
	};
}

interface PrPayloadReview {
	author: { login: string };
	body: string;
	commit: { oid: string };
	state: string;
	submittedAt: string;
}

function prPayload(number: number, body: string) {
	const reviews: PrPayloadReview[] = [];
	return {
		number,
		title: `PR #${number}`,
		state: "OPEN",
		isDraft: false,
		baseRefName: "main",
		headRefName: "feature/x",
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/owner/example/pull/${number}`,
		labels: [],
		files: [],
		reviews,
		comments: [],
	};
}

function requestedJsonFields(args: string[]): Set<string> {
	const jsonIndex = args.indexOf("--json");
	const fieldsArg = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
	return new Set((fieldsArg ?? "").split(",").filter(Boolean));
}

function prPayloadWithRequestedFields(args: string[], number: number, body: string) {
	const payload = prPayload(number, body);
	const fields = requestedJsonFields(args);
	if (fields.has("reviews")) {
		payload.reviews = [
			{
				author: { login: "approver" },
				body: "Approved from the formal review flow.",
				commit: { oid: "1234567890abcdef1234567890abcdef12345678" },
				state: "APPROVED",
				submittedAt: "2026-04-01T12:00:00Z",
			},
		];
	}
	return payload;
}

interface DiffFileSpec {
	name: string;
	adds?: number;
	dels?: number;
	mode?: "modified" | "added" | "deleted";
	oldName?: string;
	binary?: boolean;
}

function makePrDiff(files: DiffFileSpec[]): string {
	return files
		.map(f => {
			const oldPath = f.oldName ?? f.name;
			const lines: string[] = [`diff --git a/${oldPath} b/${f.name}`];
			if (f.mode === "added") lines.push("new file mode 100644");
			if (f.mode === "deleted") lines.push("deleted file mode 100644");
			if (f.oldName) {
				lines.push(`rename from ${oldPath}`, `rename to ${f.name}`);
			}
			lines.push("index 0000000..1111111 100644");
			lines.push(`--- a/${oldPath}`);
			lines.push(`+++ b/${f.name}`);
			if (f.binary) {
				lines.push(`Binary files a/${oldPath} and b/${f.name} differ`);
			} else {
				lines.push("@@ -1,1 +1,1 @@");
				for (let i = 0; i < (f.dels ?? 0); i += 1) lines.push(`-old line ${i}`);
				for (let i = 0; i < (f.adds ?? 0); i += 1) lines.push(`+new line ${i}`);
			}
			return lines.join("\n");
		})
		.join("\n");
}

describe("issue:// protocol handler", () => {
	it("resolves issue://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(42, "issue body", ["c1"]) as never);

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("issue://owner/example/42");

		expect(first.contentType).toBe("text/markdown");
		expect(first.url).toBe("issue://owner/example/42");
		expect(first.content).toContain("# Issue #42: Issue #42");
		expect(first.immutable).toBe(true);
		expect(first.notes?.[0]).toBe("已实时获取");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await router.resolve("issue://owner/example/42");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^缓存: /);
		// Same key, soft TTL hit — no additional gh invocation.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("marks soft-expired issue fallback content as stale when live refresh fails", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(43, "cached body") as never);
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 0,
			"github.cache.hardTtlSec": 86400,
		});

		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/example/43");
		await Bun.sleep(1);
		spy.mockImplementation(async () => {
			throw new Error("offline");
		});

		const resource = await router.resolve("issue://owner/example/43", { settings });
		expect(resource.content.startsWith("> 警告:GitHub 实时刷新失败")).toBe(true);
		expect(resource.notes?.[0]).toMatch(/^警告:正在显示.*缓存内容/);
		expect(resource.content).toContain("cached body");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("retries issue://owner/repo/<n> without stateReason when gh does not support it", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (requestedJsonFields(args).has("stateReason")) {
				throw new Error('Unknown JSON field: "stateReason"');
			}
			return issuePayload(42, "issue body") as never;
		});

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("issue://owner/example/42");

		expect(resource.content).toContain("# Issue #42: Issue #42");
		expect(resource.content).not.toContain("状态原因");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[]).has("stateReason")).toBe(true);
		expect(requestedJsonFields(spy.mock.calls[1]?.[1] as string[]).has("stateReason")).toBe(false);
	});

	it("?comments=0 selects a separate cache row with comments suppressed", async () => {
		const spy = vi
			.spyOn(git.github, "json")
			.mockResolvedValue(issuePayload(9, "body9", ["visible comment"]) as never);

		const router = InternalUrlRouter.instance();
		const withComments = await router.resolve("issue://owner/example/9");
		const without = await router.resolve("issue://owner/example/9?comments=0");

		// Two distinct keys → two underlying fetches.
		expect(spy).toHaveBeenCalledTimes(2);
		expect(withComments.content).toContain("visible comment");
		expect(without.content).not.toContain("visible comment");
		// Note metadata reflects the toggle on the comments-off variant.
		expect(without.notes).toContain("评论已禁用");
	});

	it("rejects invalid issue:// URLs with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		// 4-or-more segments fall through to the catch-all "Invalid …" error.
		await expect(router.resolve("issue://owner/example/foo/bar")).rejects.toThrow(/无效的 issue:\/\/ URL/);
		// Non-numeric single segment fails the number check.
		await expect(router.resolve("issue://abc")).rejects.toThrow(/无效的 issue:\/\/ 编号/);
	});
});

describe("pr:// protocol handler", () => {
	it("resolves pr://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/77/comments")) {
				return [] as never;
			}
			return prPayload(77, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("pr://owner/example/77");

		expect(first.contentType).toBe("text/markdown");
		expect(first.content).toContain("# Pull Request #77: PR #77");
		expect(first.immutable).toBe(true);
		expect(first.notes).toContain("差异:pr://owner/example/77/diff");
		// First call hits gh twice (view JSON + review-comments page).
		expect(spy).toHaveBeenCalledTimes(2);

		const second = await router.resolve("pr://owner/example/77");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^缓存: /);
		// Second call is a soft-TTL hit — no further gh invocations.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("requests and renders formal reviews when comments are enabled", async () => {
		vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/78/comments")) {
				return [] as never;
			}
			return prPayloadWithRequestedFields(args, 78, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/78");

		expect(resource.content).toContain("## 审查 (1)");
		expect(resource.content).toContain("### @approver - 2026-04-01T12:00:00Z [APPROVED]");
		expect(resource.content).toContain("Approved from the formal review flow.");
	});

	it("rejects invalid pr:// URLs with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner/example/foo/bar")).rejects.toThrow(/无效的 pr:\/\/ URL/);
		await expect(router.resolve("pr://owner/example/abc")).rejects.toThrow(/无效的 pr:\/\/ 编号/);
	});

	it("rejects empty / dot / dotdot path segments", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner//77")).rejects.toThrow(/无效的 pr:\/\/ URL:路径段为空或不安全/);
		await expect(router.resolve("pr://owner/repo/77/diff//2")).rejects.toThrow(
			/无效的 pr:\/\/ URL:路径段为空或不安全/,
		);
		await expect(router.resolve("pr://owner/../77/diff")).rejects.toThrow(/无效的 pr:\/\/ URL:路径段为空或不安全/);
		await expect(router.resolve("issue://owner/./repo/1")).rejects.toThrow(
			/无效的 issue:\/\/ URL:路径段为空或不安全/,
		);
	});
});

describe("pr://.../diff family", () => {
	const diffText = makePrDiff([
		{ name: "src/one.ts", adds: 3, dels: 1 },
		{ name: "src/two.ts", adds: 2, dels: 0, mode: "added" },
	]);

	it("pr://owner/repo/<n>/diff lists files with per-file hint URLs", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# 拉取请求差异:owner/example#77(2 个文件)");
		expect(resource.content).toContain("1. src/one.ts  +3 -1  [modified]");
		expect(resource.content).toContain("pr://owner/example/77/diff/1");
		expect(resource.content).toContain("2. src/two.ts  +2 -0  [added]");
		expect(resource.content).toContain("pr://owner/example/77/diff/2");
		expect(resource.notes?.[0]).toBe("已实时获取");
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("pr://owner/repo/<n>/diff renders an empty-file body when the PR has no changes", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue("");

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff");
		expect(resource.content).toContain("# 拉取请求差异:owner/example#77(0 个文件)");
		expect(resource.content).toContain("_无文件变更。_");
	});

	it("pr://owner/repo/<n>/diff/all returns the verbatim unified diff as text/plain", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff/all");
		expect(resource.contentType).toBe("text/plain");
		expect(resource.content).toBe(diffText);
	});

	it("pr://owner/repo/<n>/diff/<i> slices the i-th file (1-indexed) as text/plain", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("pr://owner/example/77/diff/1");
		expect(first.contentType).toBe("text/plain");
		expect(first.content.startsWith("diff --git a/src/one.ts b/src/one.ts")).toBe(true);
		expect(first.content).not.toContain("src/two.ts");
		expect(first.notes).toEqual(
			expect.arrayContaining(["正在显示文件 1/2:src/one.ts", "读取全部:pr://owner/example/77/diff/all"]),
		);

		const second = await router.resolve("pr://owner/example/77/diff/2");
		expect(second.content.startsWith("diff --git a/src/two.ts b/src/two.ts")).toBe(true);
		expect(second.content).not.toContain("src/one.ts");
	});

	it("rejects out-of-range and non-decimal diff indices with friendly errors", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner/example/77/diff/9")).rejects.toThrow(/超出范围/);
		await expect(router.resolve("pr://owner/example/77/diff/foo")).rejects.toThrow(/无效的 pr:\/\/ diff 子路径/);
	});

	it("shares one `gh pr diff` invocation across /diff, /diff/all, and /diff/<i> reads", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		await router.resolve("pr://owner/example/77/diff");
		await router.resolve("pr://owner/example/77/diff/all");
		await router.resolve("pr://owner/example/77/diff/1");
		// One row services all three variants — `gh pr diff` runs once.
		expect(textSpy).toHaveBeenCalledTimes(1);
	});
});

describe("issue://.../diff rejection", () => {
	it("issue://owner/example/9/diff rejects with 'Invalid issue:// URL'", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://owner/example/9/diff")).rejects.toThrow(/无效的 issue:\/\/ URL/);
	});

	it("issue://<N>/diff short form rejects with the same 'no diff' error (not a repo lookup)", async () => {
		// Regression: previously fell through to the `host && parts.length === 1`
		// branch and was misparsed as a repo named `<N>/diff`, producing a
		// confusing GraphQL "Could not resolve to a Repository" error instead.
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://9/diff")).rejects.toThrow(/Issue 视图没有 diff/);
		await expect(router.resolve("issue://9/diff/all")).rejects.toThrow(/Issue 视图没有 diff/);
		await expect(router.resolve("issue://9/diff/3")).rejects.toThrow(/Issue 视图没有 diff/);
	});
});

describe("issue:// / pr:// listing", () => {
	it("issue://owner/repo issues a live `gh issue list` and renders entries", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				number: 1,
				title: "Hello",
				state: "OPEN",
				author: { login: "alice" },
				labels: [{ name: "bug" }],
				createdAt: "2026-04-01T08:00:00Z",
				updatedAt: "2026-04-01T09:00:00Z",
				url: "https://github.com/owner/example/issues/1",
			},
			{
				number: 2,
				title: "Second",
				state: "OPEN",
				author: { login: "bob" },
				labels: [],
				createdAt: "2026-04-02T08:00:00Z",
				updatedAt: "2026-04-02T09:00:00Z",
				url: "https://github.com/owner/example/issues/2",
			},
		] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("issue://owner/example");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("owner/example 中的 Issue");
		expect(resource.content).toContain("#1");
		expect(resource.content).toContain("Hello");
		expect(resource.content).toContain("标签:bug");
		expect(resource.content).toContain("issue://owner/example/1");
		expect(resource.notes?.[0]).toContain("owner/example 的实时列表");

		expect(spy).toHaveBeenCalledTimes(1);
		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args[0]).toBe("issue");
		expect(args[1]).toBe("list");
		expect(args).toEqual(expect.arrayContaining(["--repo", "owner/example"]));
		expect(args).toEqual(expect.arrayContaining(["--state", "open"]));
		expect(requestedJsonFields(args).has("stateReason")).toBe(false);
	});

	it("pr://owner/repo passes state and limit query params through to gh", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example?state=merged&limit=5&author=alice&label=bug");

		expect(resource.content).toContain("# owner/example 中的拉取请求(merged,最多 5 条)");
		expect(resource.content).toContain("_无匹配。_");

		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(expect.arrayContaining(["--state", "merged"]));
		expect(args).toEqual(expect.arrayContaining(["--limit", "5"]));
		expect(args).toEqual(expect.arrayContaining(["--author", "alice"]));
		expect(args).toEqual(expect.arrayContaining(["--label", "bug"]));
	});

	it("invalid state errors instead of silently falling back to 'open'", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://owner/example?state=banana")).rejects.toThrow(
			/无效的 issue:\/\/ 列表状态 'banana'/,
		);
		await expect(router.resolve("pr://owner/example?limit=abc")).rejects.toThrow(/无效的 pr:\/\/ 列表限制 'abc'/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("treats `diff` as a repository name in repo-scoped listing URLs", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/diff");
		await router.resolve("pr://owner/diff");

		const issueArgs = spy.mock.calls[0]?.[1] as string[];
		const prArgs = spy.mock.calls[1]?.[1] as string[];
		expect(issueArgs.slice(0, 2)).toEqual(["issue", "list"]);
		expect(prArgs.slice(0, 2)).toEqual(["pr", "list"]);
		expect(issueArgs).toEqual(expect.arrayContaining(["--repo", "owner/diff"]));
		expect(prArgs).toEqual(expect.arrayContaining(["--repo", "owner/diff"]));
	});

	it("issue:// (no repo, no session) surfaces a friendly resolution error", async () => {
		// resolveDefaultRepoMemoized calls `gh repo view`; intercept it.
		vi.spyOn(git.github, "text").mockRejectedValue(new Error("not a git repository"));
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://")).rejects.toThrow(/无法从当前会话解析默认仓库/);
	});
});

describe("cross-handler cache sharing", () => {
	it("identical markdown is served whether the protocol handler or a second handler call resolves it", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(101, "shared body") as never);

		const router = InternalUrlRouter.instance();
		const r1 = await router.resolve("issue://owner/example/101");
		const r2 = await router.resolve("issue://owner/example/101");
		expect(r2.content).toBe(r1.content);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
