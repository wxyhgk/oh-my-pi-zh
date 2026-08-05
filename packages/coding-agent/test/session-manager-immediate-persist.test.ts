import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { parseJsonlLenient, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function toolResultMessage(toolCallId: string, toolName: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function readJsonl(file: string): Array<Record<string, unknown>> {
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type !== "title");
}

function messageRole(entry: Record<string, unknown>): string | undefined {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	if (!("role" in message) || typeof message.role !== "string") return undefined;
	return message.role;
}

function messageContent(entry: Record<string, unknown>): unknown {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	if (!("content" in message)) return undefined;
	return message.content;
}

function entryKind(entry: Record<string, unknown>): string {
	if (entry.type === "message") return messageRole(entry) ?? "message";
	if (entry.type === "custom") {
		return `custom:${typeof entry.customType === "string" ? entry.customType : ""}`;
	}
	return typeof entry.type === "string" ? entry.type : "unknown";
}

describe("SessionManager JSONL software-crash durability", () => {
	it("makes completed entries visible on disk without a microtask or flush", () => {
		const cwd = makeTempDir("@pi-immediate-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		expect(fs.existsSync(sessionFile)).toBe(false);

		// First assistant materializes the file via the synchronous rewrite path.
		manager.appendMessage(assistantMessage("hello"));
		expect(fs.existsSync(sessionFile)).toBe(true);

		let entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(3);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageRole(entries[2] ?? {})).toBe("assistant");

		// Hot-path appends must land in the OS page cache before the call returns.
		// A software crash (SIGKILL / OOM / hard abort) after append and before the
		// next event-loop turn must not drop them.
		manager.appendMessage({ role: "user", content: "written immediately", timestamp: Date.now() });
		entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(4);
		expect(messageRole(entries[3] ?? {})).toBe("user");
		expect(messageContent(entries[3] ?? {})).toBe("written immediately");

		manager.appendMessage(assistantMessage("second turn"));
		manager.appendCustomEntry("tool_execution_start", {
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "echo hi" },
		});
		manager.appendMessage(toolResultMessage("call-1", "bash", "hi"));

		entries = readJsonl(sessionFile);
		expect(entries.map(entryKind)).toEqual([
			"session",
			"user",
			"assistant",
			"user",
			"assistant",
			"custom:tool_execution_start",
			"toolResult",
		]);
	});

	it("reopens post-checkpoint user/assistant/tool events after a crash-equivalent snapshot", async () => {
		const cwd = makeTempDir("@pi-crash-reopen-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		// Durable checkpoint: materialize, then snapshot bytes.
		manager.appendMessage({ role: "user", content: "checkpoint user", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("checkpoint assistant"));
		const checkpointBytes = fs.readFileSync(sessionFile);
		const checkpointKinds = parseJsonlLenient<Record<string, unknown>>(checkpointBytes.toString("utf8"))
			.filter(entry => entry.type !== "title")
			.map(entryKind);
		expect(checkpointKinds).toEqual(["session", "user", "assistant"]);

		// Completed events after the checkpoint — no flushSync, no await, no close.
		manager.appendMessage({ role: "user", content: "post-checkpoint user", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("post-checkpoint assistant"));
		manager.appendCustomEntry("tool_execution_start", {
			toolCallId: "call-post",
			toolName: "read",
			args: { path: "README.md" },
		});
		manager.appendMessage(toolResultMessage("call-post", "read", "# readme"));

		// Crash equivalent: only bytes already on disk survive. Copy without yielding
		// to microtasks and reopen from that snapshot in a fresh manager.
		const crashPath = path.join(cwd, "crashed-session.jsonl");
		fs.writeFileSync(crashPath, fs.readFileSync(sessionFile));

		const reopened = await SessionManager.open(crashPath);
		const reopenedKinds = reopened.getEntries().map(entry => {
			if (entry.type === "message") return entry.message.role;
			if (entry.type === "custom") return `custom:${entry.customType}`;
			return entry.type;
		});
		expect(reopenedKinds).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"custom:tool_execution_start",
			"toolResult",
		]);

		const postUser = reopened
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "post-checkpoint user",
			);
		expect(postUser).toBeDefined();
		const toolResult = reopened
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "call-post",
			);
		expect(toolResult).toBeDefined();
	});

	it("keeps pre-assistant sessions out of history during shutdown", async () => {
		const cwd = makeTempDir("@pi-empty-session-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.flushSync();
		await manager.close();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);

		manager.appendMessage({ role: "user", content: "queued before assistant", timestamp: Date.now() });
		manager.flushSync();

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(await SessionManager.list(cwd, sessionDir)).toHaveLength(0);
	});

	it("lets explicit rewrites materialize pre-assistant entries", async () => {
		const cwd = makeTempDir("@pi-explicit-rewrite-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendMessage({ role: "user", content: "persist me", timestamp: Date.now() });
		await manager.rewriteEntries();

		expect(fs.existsSync(sessionFile)).toBe(true);
		const entries = readJsonl(sessionFile);
		expect(entries).toHaveLength(2);
		expect(messageRole(entries[1] ?? {})).toBe("user");
		expect(messageContent(entries[1] ?? {})).toBe("persist me");
	});

	it("makes fenced appends durable while an atomic rewrite is paused", async () => {
		// H1: in-place atomic fence used to mark entries dirty and return without
		// writing. A crash before the paused publish resumed lost every fenced
		// completed event. Superseding with #rewriteSynchronously must put them
		// on disk before append returns, and the abandoned atomic must not clobber.
		class PausedRewriteStorage extends MemorySessionStorage {
			readonly rewriteStarted = Promise.withResolvers<void>();
			readonly allowRewrite = Promise.withResolvers<void>();
			guardRejections = 0;

			override async writeTextAtomic(
				filePath: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				this.rewriteStarted.resolve();
				await this.allowRewrite.promise;
				if (options?.commitGuard && !options.commitGuard()) {
					this.guardRejections++;
					return;
				}
				this.writeTextSync(filePath, content);
			}
		}

		const storage = new PausedRewriteStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		manager.appendMessage(assistantMessage("seed"));
		await manager.flush();
		manager.appendMessage({ role: "user", content: "checkpoint", timestamp: Date.now() });
		await manager.flush();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const rewrite = manager.rewriteEntries();
		await storage.rewriteStarted.promise;

		manager.appendMessage({ role: "user", content: "fenced-user", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("fenced-assistant"));
		manager.appendCustomEntry("tool_execution_start", {
			toolCallId: "fenced-call",
			toolName: "bash",
		});
		manager.appendMessage(toolResultMessage("fenced-call", "bash", "hi"));

		// Crash-equivalent while the atomic is still paused: only storage bytes survive.
		const crashKinds = parseJsonlLenient<Record<string, unknown>>(await storage.readText(sessionFile))
			.filter(entry => entry.type !== "title")
			.map(entryKind);
		expect(crashKinds).toEqual([
			"session",
			"assistant",
			"user",
			"user",
			"assistant",
			"custom:tool_execution_start",
			"toolResult",
		]);

		storage.allowRewrite.resolve();
		await rewrite;
		await manager.flush();

		const afterKinds = parseJsonlLenient<Record<string, unknown>>(await storage.readText(sessionFile))
			.filter(entry => entry.type !== "title")
			.map(entryKind);
		// Fenced events remain after the paused atomic settles (commitGuard may
		// reject a stale body, or a superseding rewrite already owns the file).
		expect(afterKinds).toEqual(crashKinds);
	});

	it("latches the first hot-path write failure before append returns", () => {
		// H2: async append + discarded Promise meant ENOSPC/EIO only latched after a
		// later flush/append. appendSync must latch `#diskFailure` on the first call
		// without throwing through unguarded turn-loop callers.
		const cwd = makeTempDir("@pi-write-fail-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		manager.appendMessage(assistantMessage("seed"));
		manager.appendMessage({ role: "user", content: "ok-user", timestamp: Date.now() });

		let failWrites = true;
		const origWrite = fs.writeSync.bind(fs) as typeof fs.writeSync;
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
			if (failWrites) {
				const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
				err.code = "ENOSPC";
				throw err;
			}
			return origWrite(...args);
		}) as typeof fs.writeSync);

		try {
			let threw = false;
			try {
				manager.appendMessage({ role: "user", content: "should-fail-user", timestamp: Date.now() });
			} catch {
				threw = true;
			}
			// Unguarded turn-loop contract: appendMessage itself must not throw.
			expect(threw).toBe(false);

			// Failure is latched before return — flushSync / next append surface it.
			expect(() => manager.flushSync()).toThrow("ENOSPC");
			expect(() => manager.appendMessage({ role: "user", content: "next-user", timestamp: Date.now() })).toThrow(
				"ENOSPC",
			);

			const users = parseJsonlLenient<Record<string, unknown>>(fs.readFileSync(sessionFile, "utf8"))
				.filter(entry => entry.type === "message" && messageRole(entry) === "user")
				.map(entry => messageContent(entry));
			expect(users).toEqual(["ok-user"]);
		} finally {
			failWrites = false;
			writeSpy.mockRestore();
		}
	});
});
