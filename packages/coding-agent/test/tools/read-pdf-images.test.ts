/**
 * PDF image extraction: markit emits inert `<!-- image: <id> ... -->`
 * placeholders for embedded PDF images. The read tool rewrites those into
 * browsable `read <pdf>:<id>.png` handles, and serves the actual PNG when that
 * handle is read — extracting via markit's `imageDir` into a session-artifact
 * cache. These lock the rewrite, the member extraction, member validation, and
 * the caching contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool, type ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as markit from "@oh-my-pi/pi-coding-agent/utils/markit";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// 1x1 transparent PNG — small enough to pass through image loading untouched.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "images.autoResize": false }),
	} as unknown as ToolSession;
}

/** Spy on markit so PDF "extraction" writes the given members into imageDir. */
function mockExtraction(members: Record<string, Buffer> = { "p11-img0.png": TINY_PNG }) {
	return vi.spyOn(markit, "convertFileWithMarkit").mockImplementation(async (_filePath: string, _signal, options) => {
		if (options?.imageDir) {
			fs.mkdirSync(options.imageDir, { recursive: true });
			for (const name in members) {
				fs.writeFileSync(path.join(options.imageDir, name), members[name]!);
			}
		}
		return { ok: true, content: "" };
	});
}

function imageBytes(result: AgentToolResult<ReadToolDetails>): Buffer {
	const image = result.content.find(content => content.type === "image");
	if (image?.type !== "image") throw new Error("Expected an image result");
	return Buffer.from(image.data, "base64");
}

function mockBlockedExtraction() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const spy = vi.spyOn(markit, "convertFileWithMarkit").mockImplementation(async (_sourcePath, signal, options) => {
		entered.resolve();
		await release.promise;
		signal?.throwIfAborted();
		if (options?.imageDir) {
			fs.mkdirSync(options.imageDir, { recursive: true });
			fs.writeFileSync(path.join(options.imageDir, "p11-img0.png"), TINY_PNG);
		}
		return { ok: true, content: "" };
	});
	return { entered, release, spy };
}

/**
 * Resolves once `count` callers are attached as waiters on the shared PDF
 * extraction. Waiter attachment is the only `untilAborted` call that receives
 * a promise (source snapshots pass thunks), so counting promise arguments
 * observes it. The abort tests need this barrier: aborting a caller while it
 * is the sole waiter tears the extraction down and deadlocks against the
 * blocked conversion mock.
 */
function extractionWaitersAttached(count: number): Promise<void> {
	const attached = Promise.withResolvers<void>();
	const original = piUtils.untilAborted;
	let seen = 0;
	vi.spyOn(piUtils, "untilAborted").mockImplementation((signal, pr) => {
		if (typeof pr !== "function" && ++seen === count) attached.resolve();
		return original(signal, pr);
	});
	return attached.promise;
}

describe("read PDF image extraction", () => {
	let testDir: string;
	let pdfPath: string;
	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-pdf-img-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		pdfPath = path.join(testDir, "doc.pdf");
		fs.writeFileSync(pdfPath, "%PDF-stub");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("rewrites image placeholders into browse handles on a full read", async () => {
		const converted = [
			"Heading",
			"",
			"<!-- image: p11-img0 (page 11, 199x124pt) -->",
			"",
			"<!-- image: p11-img1 (page 11, 199x54pt) -->",
			"",
			"Footer",
		].join("\n");
		vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({ ok: true, content: converted });

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: pdfPath });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).not.toContain("<!-- image:");
		expect(text).toContain(`read \`${pdfPath}:p11-img0.png\``);
		expect(text).toContain(`read \`${pdfPath}:p11-img1.png\``);
		// Page/size metadata is preserved in the handle text.
		expect(text).toContain("page 11, 199x124pt");
	});

	it("rewrites placeholders inside a line-range view", async () => {
		const lines = Array.from({ length: 20 }, (_, i) => `pdf line ${i + 1}`);
		lines[9] = "<!-- image: p3-img0 (page 3, 100x50pt) -->"; // line 10
		vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({ ok: true, content: lines.join("\n") });

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: `${pdfPath}:8-12` });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).not.toContain("<!-- image:");
		expect(text).toContain(`read \`${pdfPath}:p3-img0.png\``);
	});

	it("extracts a PDF image member as an inline image block", async () => {
		const spy = mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain("已读取图片文件");
		// Extraction was driven through markit with an imageDir target.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[2]?.imageDir).toBeTruthy();
	});

	it("reuses the extraction cache across member reads", async () => {
		const spy = mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		// Second read is served from the `.extracted` cache, not re-converted.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("re-extracts image members after same-path PDF replacement", async () => {
		const sourceA = Buffer.from("%PDF-source-a");
		const sourceB = Buffer.from("%PDF-source-b");
		fs.writeFileSync(pdfPath, sourceA);
		const spy = vi.spyOn(markit, "convertFileWithMarkit").mockImplementation(async (sourcePath, _signal, options) => {
			if (options?.imageDir) {
				fs.mkdirSync(options.imageDir, { recursive: true });
				fs.writeFileSync(
					path.join(options.imageDir, "p11-img0.png"),
					Buffer.concat([TINY_PNG, fs.readFileSync(sourcePath)]),
				);
			}
			return { ok: true, content: "" };
		});
		const tool = new ReadTool(makeSession(testDir));

		const originalStat = fs.statSync(pdfPath);
		const first = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		fs.writeFileSync(pdfPath, sourceB);
		fs.utimesSync(pdfPath, originalStat.atime, originalStat.mtime);
		const second = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });

		expect(imageBytes(first).subarray(TINY_PNG.length)).toEqual(sourceA);
		expect(imageBytes(second).subarray(TINY_PNG.length)).toEqual(sourceB);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("converts an immutable snapshot when the source changes during extraction", async () => {
		const sourceA = Buffer.from("%PDF-source-a");
		const sourceB = Buffer.from("%PDF-source-b");
		fs.writeFileSync(pdfPath, sourceA);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(markit, "convertFileWithMarkit").mockImplementation(async (sourcePath, _signal, options) => {
			entered.resolve();
			await release.promise;
			if (options?.imageDir) {
				fs.mkdirSync(options.imageDir, { recursive: true });
				fs.writeFileSync(
					path.join(options.imageDir, "p11-img0.png"),
					Buffer.concat([TINY_PNG, fs.readFileSync(sourcePath)]),
				);
			}
			return { ok: true, content: "" };
		});
		const pending = new ReadTool(makeSession(testDir)).execute("call", { path: `${pdfPath}:p11-img0.png` });

		await entered.promise;
		fs.writeFileSync(pdfPath, sourceB);
		release.resolve();
		const result = await pending;

		expect(imageBytes(result).subarray(TINY_PNG.length)).toEqual(sourceA);
	});

	it("coalesces concurrent cold image extraction", async () => {
		const { entered, release, spy } = mockBlockedExtraction();
		const tool = new ReadTool(makeSession(testDir));
		const first = tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		const second = tool.execute("call", { path: `${pdfPath}:p11-img0.png` });

		await entered.promise;
		const conversionCount = spy.mock.calls.length;
		release.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(conversionCount).toBe(1);
		expect(imageBytes(firstResult)).toEqual(imageBytes(secondResult));
	});

	it("keeps shared extraction running when its owner aborts", async () => {
		const { entered, release, spy } = mockBlockedExtraction();
		const bothAttached = extractionWaitersAttached(2);
		const tool = new ReadTool(makeSession(testDir));
		const ownerController = new AbortController();
		const owner = tool.execute("call", { path: `${pdfPath}:p11-img0.png` }, ownerController.signal);
		await entered.promise;
		const joiner = tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		await bothAttached;

		ownerController.abort();
		await expect(owner).rejects.toThrow(/Aborted|Cancelled/);
		release.resolve();
		const result = await joiner;

		expect(result.content.some(content => content.type === "image")).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("keeps shared extraction running when a joiner aborts", async () => {
		const { entered, release, spy } = mockBlockedExtraction();
		const bothAttached = extractionWaitersAttached(2);
		const tool = new ReadTool(makeSession(testDir));
		const joinerController = new AbortController();
		const owner = tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		await entered.promise;
		const joiner = tool.execute("call", { path: `${pdfPath}:p11-img0.png` }, joinerController.signal);
		await bothAttached;

		joinerController.abort();
		await expect(joiner).rejects.toThrow(/Aborted|Cancelled/);
		release.resolve();
		const result = await owner;

		expect(result.content.some(content => content.type === "image")).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("cleans temporary extraction state when the only caller aborts", async () => {
		const entered = Promise.withResolvers<void>();
		let snapshotPath: string | undefined;
		let stagingDir: string | undefined;
		vi.spyOn(markit, "convertFileWithMarkit").mockImplementation(async (sourcePath, signal, options) => {
			snapshotPath = sourcePath;
			stagingDir = options?.imageDir;
			entered.resolve();
			const aborted = Promise.withResolvers<void>();
			const onAbort = () => aborted.resolve();
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			await aborted.promise;
			signal?.removeEventListener("abort", onAbort);
			signal?.throwIfAborted();
			return { ok: true, content: "" };
		});
		const controller = new AbortController();
		const pending = new ReadTool(makeSession(testDir)).execute(
			"call",
			{ path: `${pdfPath}:p11-img0.png` },
			controller.signal,
		);

		await entered.promise;
		controller.abort();
		await expect(pending).rejects.toThrow(/Aborted|Cancelled/);
		if (!snapshotPath || !stagingDir) throw new Error("Expected extraction paths");

		expect(fs.existsSync(path.dirname(snapshotPath))).toBe(false);
		expect(fs.existsSync(stagingDir)).toBe(false);
	});

	it("does not let a failed generation delete a replacement generation", async () => {
		const sourceA = Buffer.from("%PDF-source-a");
		const sourceB = Buffer.from("%PDF-source-b");
		fs.writeFileSync(pdfPath, sourceA);
		const firstEntered = Promise.withResolvers<void>();
		const failFirst = Promise.withResolvers<void>();
		const spy = vi.spyOn(markit, "convertFileWithMarkit").mockImplementation(async (sourcePath, _signal, options) => {
			const source = fs.readFileSync(sourcePath);
			if (source.equals(sourceA)) {
				firstEntered.resolve();
				await failFirst.promise;
				return { ok: false, content: "", error: "generation A failed" };
			}
			if (options?.imageDir) {
				fs.mkdirSync(options.imageDir, { recursive: true });
				fs.writeFileSync(path.join(options.imageDir, "p11-img0.png"), Buffer.concat([TINY_PNG, source]));
			}
			return { ok: true, content: "" };
		});
		const tool = new ReadTool(makeSession(testDir));
		const first = tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		await firstEntered.promise;
		fs.writeFileSync(pdfPath, sourceB);

		const replacement = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		failFirst.resolve();
		await expect(first).rejects.toThrow(/无法从 PDF 提取图片/);
		const cachedReplacement = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });

		expect(imageBytes(replacement).subarray(TINY_PNG.length)).toEqual(sourceB);
		expect(imageBytes(cachedReplacement)).toEqual(imageBytes(replacement));
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("isolates equal-content PDFs with the same basename in different directories", async () => {
		const otherDir = path.join(testDir, "other");
		const otherPdfPath = path.join(otherDir, path.basename(pdfPath));
		fs.mkdirSync(otherDir, { recursive: true });
		fs.writeFileSync(otherPdfPath, fs.readFileSync(pdfPath));
		let conversion = 0;
		const spy = vi
			.spyOn(markit, "convertFileWithMarkit")
			.mockImplementation(async (_sourcePath, _signal, options) => {
				conversion++;
				if (options?.imageDir) {
					fs.mkdirSync(options.imageDir, { recursive: true });
					fs.writeFileSync(
						path.join(options.imageDir, "p11-img0.png"),
						Buffer.concat([TINY_PNG, Buffer.from(String(conversion))]),
					);
				}
				return { ok: true, content: "" };
			});
		const tool = new ReadTool(makeSession(testDir));

		const first = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		const second = await tool.execute("call", { path: `${otherPdfPath}:p11-img0.png` });

		expect(imageBytes(first).subarray(TINY_PNG.length).toString()).toBe("1");
		expect(imageBytes(second).subarray(TINY_PNG.length).toString()).toBe("2");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("supports PDF basenames at the filesystem component limit", async () => {
		const longPdfPath = path.join(testDir, `${"a".repeat(250)}.pdf`);
		fs.writeFileSync(longPdfPath, "%PDF-stub");
		mockExtraction();

		const result = await new ReadTool(makeSession(testDir)).execute("call", {
			path: `${longPdfPath}:p11-img0.png`,
		});

		expect(result.content.some(content => content.type === "image")).toBe(true);
	});

	it("errors with the available members for an unknown member", async () => {
		mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		await expect(tool.execute("call", { path: `${pdfPath}:does-not-exist.png` })).rejects.toThrow(
			/未找到 PDF 图片成员.*p11-img0\.png/s,
		);
	});

	it("rejects member traversal attempts", async () => {
		mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		// `../../escape.png` matches the image-member shape but is not a known
		// basename, so it must be refused rather than joined into the cache path.
		await expect(tool.execute("call", { path: `${pdfPath}:../../escape.png` })).rejects.toThrow(
			/未找到 PDF 图片成员/,
		);
	});

	it("lists extractable members for a trailing-colon read", async () => {
		mockExtraction({ "p1-img0.png": TINY_PNG, "p2-img0.png": TINY_PNG });
		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: `${pdfPath}:` });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain(`读取 \`${pdfPath}:p1-img0.png\``);
		expect(text).toContain(`读取 \`${pdfPath}:p2-img0.png\``);
	});

	it("does not cache a failed conversion", async () => {
		let failedSnapshotPath: string | undefined;
		let failedImageDir: string | undefined;
		const spy = vi.spyOn(markit, "convertFileWithMarkit");
		spy.mockImplementationOnce(async (sourcePath, _signal, options) => {
			failedSnapshotPath = sourcePath;
			failedImageDir = options?.imageDir;
			return { ok: false, content: "", error: "boom" };
		});
		const tool = new ReadTool(makeSession(testDir));
		await expect(tool.execute("call", { path: `${pdfPath}:p11-img0.png` })).rejects.toThrow(/无法从 PDF 提取图片/);
		if (!failedSnapshotPath || !failedImageDir) throw new Error("Expected failed extraction paths");
		expect(fs.existsSync(path.dirname(failedSnapshotPath))).toBe(false);
		expect(fs.existsSync(path.join(failedImageDir, ".extracted"))).toBe(false);

		spy.mockImplementationOnce(async (_filePath: string, _signal, options) => {
			if (options?.imageDir) {
				fs.mkdirSync(options.imageDir, { recursive: true });
				fs.writeFileSync(path.join(options.imageDir, "p11-img0.png"), TINY_PNG);
			}
			return { ok: true, content: "" };
		});
		const result = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		expect(result.content.some(c => c.type === "image")).toBe(true);
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
