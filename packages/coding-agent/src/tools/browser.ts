import { type } from "@wxyhgk/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@wxyhgk/pi-agent-core";
import type { ToolExample } from "@wxyhgk/pi-ai";
import { prompt, untilAborted } from "@wxyhgk/pi-utils";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "../session/streaming-output";
import { truncateForPrompt } from "./approval";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import {
	acquireBrowser,
	type BrowserHandle,
	type BrowserKind,
	type BrowserKindTag,
	holdBrowser,
	releaseBrowser,
} from "./browser/registry";
import { resolveRelayKind } from "./browser/relay/kind";
import type { Observation, ScreenshotResult } from "./browser/tab-protocol";
import {
	type AcquireTabResult,
	acquireTab,
	dropHeadlessTabs,
	getTab,
	releaseAllTabs,
	releaseTab,
	runInTab,
} from "./browser/tab-supervisor";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export {
	type AriaSnapshotOptions,
	buildAriaSnapshotScript,
	parseAriaRefSelector,
} from "./browser/aria/aria-snapshot";
export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export { DEFAULT_RELAY_URL, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";

const appSchema = type({
	"path?": type("string").describe("要启动的二进制文件路径"),
	"cdp_url?": type("string").describe("现有的 cdp 端点"),
	"relay?": type("boolean").describe("通过 omp 浏览器中继驱动用户自己的标签页"),
	"args?": type("string[]").describe("额外的 cli 参数"),
	"target?": type("string").describe("用于选择窗口的子串"),
});

const browserSchema = type({
	action: type("'open' | 'close' | 'run'").describe("操作"),
	"name?": type("string").describe("标签页 id(默认 'main')"),
	"url?": type("string").describe("要打开的 url"),
	"app?": appSchema,
	"viewport?": {
		width: "number",
		height: "number",
		"scale?": "number",
	},
	"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'").describe("导航等待条件"),
	"dialogs?": type("'accept' | 'dismiss'").describe("自动处理对话框"),
	"code?": type("string").describe("要在标签页中运行的 js 代码"),
	"timeout?": type("number").describe("超时秒数"),
	"all?": type("boolean").describe("关闭所有标签页"),
	"kill?": type("boolean").describe("同时终止已启动应用的浏览器进程"),
});

/** Input schema for the browser tool. */
export type BrowserParams = typeof browserSchema.infer;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	result?: string;
	meta?: OutputMeta;
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe };
	}
	const relayUrl = session.settings.get("browser.relayUrl") as string | undefined;
	// Explicit app.relay wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch (a relay that is down would otherwise brick the tool).
	if (app?.relay) {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl });
		if (relayKind) return relayKind;
	}
	// Relay before cdpUrl among settings: enabling the opt-out-by-default relay
	// is a deliberate mode selection, while cdpUrl is a standing fallback
	// endpoint. A configured endpoint is a default, not an override: explicit
	// app options win.
	if (app?.relay !== false) {
		const relayKind = resolveRelayKind({
			settingEnabled: session.settings.get("browser.relay") as boolean | undefined,
			url: relayUrl,
		});
		if (relayKind) return relayKind;
	}
	const configuredCdpUrl = (session.settings.get("browser.cdpUrl") as string | undefined)?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: session.settings.get("browser.cmux") as boolean | undefined,
	});
	if (cmuxKind) {
		return cmuxKind;
	}
	const headless = session.settings.get("browser.headless") as boolean;
	return { kind: "headless", headless };
}

/**
 * Browser tool: stateful, multi-tab. Three actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<BrowserParams>;
		const lines = [`操作: ${typeof params.action === "string" ? params.action : "(缺失)"}`];
		const tabName = typeof params.name === "string" ? params.name : DEFAULT_TAB_NAME;
		lines.push(`标签页: ${truncateForPrompt(tabName)}`);
		if (typeof params.url === "string" && params.url.length > 0) {
			lines.push(`URL: ${truncateForPrompt(params.url)}`);
		}
		if (typeof params.code === "string" && params.code.length > 0) {
			lines.push(`代码:\n${truncateForPrompt(params.code)}`);
		}
		return lines;
	};
	readonly label = "浏览器";
	readonly loadMode = "discoverable";
	readonly summary = "控制无头浏览器导航并与网页交互";
	readonly parameters = browserSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof browserSchema.infer>[] = [
		{
			caption: "打开标签页",
			call: { action: "open", name: "docs", url: "https://example.com" },
		},
		{
			caption: "在打开的标签页中读取结构化页面数据",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); display(obs); return obs.elements.length;",
			},
		},
		{
			caption: "按 id 点击观察到的元素",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();",
			},
		},
		{
			caption: "通过选择器填写并提交表单",
			call: {
				action: "run",
				name: "docs",
				code: "await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');",
			},
		},
		{
			caption: "截图并返回其保存路径",
			call: {
				action: "run",
				name: "docs",
				code: "return await tab.screenshot();",
			},
		},
		{
			caption: "附加到现有的 Electron 应用",
			call: {
				action: "open",
				name: "cursor",
				app: { path: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
			},
		},
		{
			caption: "关闭所有标签页并终止已启动应用的进程",
			call: { action: "close", all: true, kill: true },
		},
	];

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(browserDescription, {});
		return this.#description;
	}

	/** Restart browser to apply mode changes (e.g. headless toggle). Drops only headless browsers. */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout, this.session.settings.get("tools.maxTimeout"));
			const timeoutMs = timeoutSeconds * 1000;
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };

			switch (params.action) {
				case "open":
					return await this.#open(name, params, details, timeoutMs, signal);
				case "close":
					return await this.#close(name, params, details, timeoutMs, signal);
				case "run":
					return await this.#run(name, params, details, timeoutMs, signal);
				default:
					throw new ToolError(`不支持的操作: ${(params as BrowserParams).action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kind = resolveBrowserKind(params, this.session);
		details.browser = kind.kind;

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`标签页 ${JSON.stringify(name)} 绑定到了不同的浏览器(${describeKind(existing.browser.kind)})。请先关闭它。`,
			);
		}

		// The requested timeout must cover the *entire* open — browser
		// acquisition (CDP discovery/connect), queued tab acquisition, worker
		// creation, and navigation — not only `acquireTab`. Compose one deadline
		// from the caller signal and `params.timeout` and thread it through both
		// stages so a stalled acquisition rejects at the requested boundary.
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const openSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const browser = await untilAborted(openSignal, () =>
				acquireBrowser(kind, {
					cwd: this.session.cwd,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					appArgs: params.app?.args,
					signal: openSignal,
				}),
			);

			// Hold one open-acquisition lease across the whole tab acquisition.
			// A freshly-created browser sits in the registry at refCount 0 until a
			// tab takes a hold; without this lease an abort/timeout mid-acquisition
			// (or a sibling open of a different tab name on the same browser that
			// fails) could dispose it out from under this operation. The lease is
			// released exactly once — the success and failure paths are mutually
			// exclusive — transferring ownership to the published tab on success or
			// rolling the fresh browser back on failure.
			holdBrowser(browser);
			let result: AcquireTabResult;
			try {
				result = await untilAborted(openSignal, () =>
					acquireTab(name, browser, {
						url: params.url,
						waitUntil: params.wait_until,
						viewport: params.viewport
							? {
									width: params.viewport.width,
									height: params.viewport.height,
									deviceScaleFactor: params.viewport.scale,
								}
							: undefined,
						target: params.app?.target,
						timeoutMs,
						dialogs: params.dialogs,
						signal: openSignal,
						ownerSessionId: this.session.getSessionId?.() ?? undefined,
					}),
				);
			} catch (error) {
				await releaseBrowser(browser, { kill: false });
				throw error;
			}
			await releaseBrowser(browser, { kill: false });

			const tab = result.tab;
			const url = tab.info.url;
			const title = tab.info.title ?? "";
			details.url = url;
			details.viewport = tab.info.viewport;
			const verb = result.created ? "已打开" : "已复用";
			const lines = [
				`${verb}标签页 ${JSON.stringify(name)},浏览器: ${describeBrowser(browser)}`,
				`URL: ${url}`,
				title ? `标题: ${title}` : null,
			].filter((l): l is string => typeof l === "string");
			details.result = lines.join("\n");
			return toolResult(details).text(lines.join("\n")).done();
		} catch (error) {
			// Caller cancellation stays a ToolAbortError; the requested timeout
			// becomes a timeout ToolError; anything else passes through unchanged.
			if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
			if (timeoutSignal.aborted) throw new ToolError(`浏览器打开超时:已等待 ${timeoutMs} 毫秒`);
			throw error;
		}
	}

	async #close(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kill = !!params.kill;
		if (params.all) {
			const count = await untilAborted(signal, () => releaseAllTabs({ kill, timeoutMs }));
			details.result = `已关闭 ${count} 个标签页`;
			return toolResult(details).text(details.result).done();
		}
		const closed = await untilAborted(signal, () => releaseTab(name, { kill, timeoutMs }));
		details.result = closed ? `已关闭标签页 ${JSON.stringify(name)}` : `不存在名为 ${JSON.stringify(name)} 的标签页`;
		return toolResult(details).text(details.result).done();
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("缺少 action 'run' 必需的参数 'code'。");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		const { displays, returnValue, screenshots } = await runInTab(name, {
			code: params.code,
			timeoutMs,
			signal,
			session: this.session,
		});

		if (screenshots.length) details.screenshots = screenshots;

		const content = [...displays];
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `已在标签页 ${JSON.stringify(name)} 上运行代码` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		// Final defense at the tool-result boundary: a single run can display
		// tens of KB (large JSON returns, dumped observations). Cap the combined
		// text inline; the full text stays recoverable via the artifact footer
		// when allocation succeeds.
		const cappedText = await enforceInlineByteCap(textOnly, {
			saveArtifact: full => saveBrowserOutputArtifact(this.session, full),
		});
		details.result = cappedText;
		if (cappedText !== textOnly) {
			const nonText = content.filter(c => c.type !== "text");
			return toolResult(details)
				.content([...nonText, { type: "text", text: cappedText }])
				.done();
		}
		return toolResult(details).content(content).done();
	}
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
async function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("browser-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

function describeBrowser(handle: BrowserHandle): string {
	if (!("browser" in handle)) {
		return `cmux 浏览器(${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return `无头浏览器(${handle.kind.headless ? "隐藏" : "可见"}${handle.sharedDaemon ? ", 共享" : ""})`;
		case "spawned":
			return `已启动 ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `已连接 ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
		case "relay":
			return `中继 ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `无头 ${kind.headless ? "隐藏" : "可见"}`;
		case "spawned":
			return `已启动:${kind.path}`;
		case "connected":
			return `已连接:${kind.cdpUrl}`;
		case "relay":
			return `中继:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "relay" && b.kind === "relay") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "cmux" && b.kind === "cmux") return a.socketPath === b.socketPath;
	return false;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
