import * as path from "node:path";
import { isCompiledBinary, logger, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser, CDPSession } from "puppeteer-core";
import { ToolAbortError, ToolError } from "../tool-errors";
import { findFreeCdpPort, findReusableCdp, gracefulKillTreeOnce, killExistingByPath, waitForCdp } from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import {
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	launchHeadlessBrowser,
	loadPuppeteer,
	removeUserDataDir,
	type UserAgentOverride,
} from "./launch";
import { ensureRelayDaemon, isLoopbackRelayUrl } from "./relay/daemon";
import type { RelayKind } from "./relay/kind";
import { ensureSharedBrowser } from "./shared-daemon";

export type PuppeteerBrowserKind =
	| { kind: "headless"; headless: boolean }
	| { kind: "spawned"; path: string }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;

export type BrowserKind = PuppeteerBrowserKind | CmuxKind;

export type BrowserKindTag = BrowserKind["kind"];

/**
 * Upper bound on `browser.close()` for headless Chromium. Puppeteer waits for
 * the process to fully exit; a wedged Chromium would otherwise hang cleanup
 * forever (issue #5260), so we cap the wait and force-kill on timeout.
 */
const HEADLESS_CLOSE_TIMEOUT_MS = 5_000;
/**
 * How long a relay open waits for the extension handshake (503 → 200). A
 * reaped extension service worker is revived by its 30s keepalive alarm, so
 * the wait must cover one full alarm period plus the dial.
 */
const RELAY_EXTENSION_WAIT_MS = 35_000;

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
	kind: PuppeteerBrowserKind;
	browser: Browser;
	cdpUrl?: string;
	pid?: number;
	/** OMP-owned temp Chromium profile directory removed on dispose (process-local headless launches). */
	userDataDir?: string;
	/** Broker daemon backing this handle; dispose disconnects instead of closing, kill routes to the broker. */
	sharedDaemon?: { name: string; projectDir: string };
	subprocess?: Subprocess;
	stealth: { browserSession: CDPSession | null; override: UserAgentOverride | null };
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = PuppeteerBrowserHandle | CmuxBrowserHandle;

/** Controls bounded browser-handle teardown and identifies the owning resource in timeout diagnostics. */
export interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();
/** In-flight opens by browser key, so concurrent acquisitions share one launch instead of storming Chromium. */
const pendingOpens = new Map<string, Promise<BrowserHandle>>();

function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	appArgs?: string[];
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if ("client" in existing) return existing;
			if (existing.browser.connected) return existing;
			browsers.delete(key);
			await disposeBrowserHandle(existing, { kill: false });
			continue;
		}
		// Short-circuit before launching: the tool wrapper's `untilAborted` only
		// rejects its outer promise on abort; without this check `openBrowserHandle`
		// would still fire and its result would land in `browsers` below.
		if (opts.signal?.aborted) throw new ToolAbortError("浏览器打开已中止");

		// Single-flight per key: a concurrent caller already opening this browser
		// wins; everyone else waits and re-reads the registry. Without this, N
		// simultaneous opens each launch a Chromium and the last write wins,
		// leaking the rest as unreferenced process trees.
		const pending = pendingOpens.get(key);
		if (pending) {
			await pending.catch(() => undefined);
			continue;
		}
		const open = openBrowserHandle(kind, opts).finally(() => pendingOpens.delete(key));
		pendingOpens.set(key, open);
		const handle = await open;
		// The launch may resolve AFTER the caller has already aborted (the outer
		// `untilAborted` rejects immediately on abort but does not cancel the
		// inner promise, and `launchHeadlessBrowser` does not accept a signal).
		// Without this branch the completed handle sits in `browsers` at
		// refCount:0 forever — no tab ever takes a hold, `releaseBrowser` never
		// fires, and `releaseAllTabs` walks `tabs`, not `browsers`, so the
		// orphaned Chromium/app process / puppeteer handle survives to process
		// exit. (Issue #3963.)
		if (opts.signal?.aborted) {
			await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(err => {
				logger.debug("中止后清理孤立浏览器失败", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			throw new ToolAbortError("浏览器打开已中止");
		}
		browsers.set(key, handle);
		return handle;
	}
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpUrl = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpUrl)) {
		throw new ToolError(
			"browser app.cdp_url 必须是 HTTP CDP 发现端点(例如 http://127.0.0.1:9222),而不是 ws:// 浏览器 WebSocket URL。",
		);
	}
	return cdpUrl;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return {
			key: browserKey(kind),
			kind,
			client,
			surface: kind.surface,
			refCount: 0,
		};
	}
	if (kind.kind === "headless") {
		// Every real omp process (session, subagent, worker — anything with a CLI
		// worker host) MUST go through the project-shared broker-owned Chromium:
		// per-process launches are what produced launch storms and orphaned
		// process trees. The process-local launch survives only for hosts that
		// cannot spawn the broker (bun test, SDK embedding without a CLI entry).
		if (isCompiledBinary() || workerHostEntry() !== null) {
			return await openSharedHeadlessHandle(kind, opts);
		}
		const { browser, userDataDir } = await launchHeadlessBrowser({
			headless: kind.headless,
			viewport: opts.viewport,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			userDataDir,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "relay") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		// Loopback relays are owned by a machine-global broker and auto-started
		// on demand (the extension dials in on its own). Hosts without a CLI
		// worker entry (bun test, SDK embedding) never spawn brokers. Remote
		// relay URLs must already be serving.
		let autoStarted = false;
		if (isLoopbackRelayUrl(cdpUrl) && (isCompiledBinary() || workerHostEntry() !== null)) {
			autoStarted = await ensureRelayDaemon({ cdpUrl, signal: opts.signal });
		}
		// The relay answers /json/version with 503 until its extension dials in.
		// A freshly revived extension service worker can take up to ~30s (its
		// keepalive alarm) to reconnect, so give the handshake that long.
		try {
			await waitForCdp(cdpUrl, RELAY_EXTENSION_WAIT_MS, opts.signal);
		} catch (err) {
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(
				autoStarted
					? `omp browser relay 正在 ${cdpUrl} 提供服务,但其扩展从未连接。请运行 \`omp-zh browser-relay install\` 安装扩展,并检查工具栏徽章是否显示 "on"。`
					: `无法在 ${cdpUrl} 连接 omp browser relay。请运行 \`omp-zh browser-relay\` 启动它(或检查端点),并确保 Chrome 中已加载 OMP Browser Relay 扩展。`,
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path 必须是绝对路径(当前为 ${JSON.stringify(exe)})。请传入 Foo.app/Contents/MacOS/ 内的可执行文件,而不是 .app 应用包。`,
		);
	}
	const reused = await findReusableCdp(exe, opts.signal);
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("连接时复用现有 CDP 端点", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const killed = await killExistingByPath(exe, opts.signal);
		if (killed > 0) logger.debug("连接前已结束现有实例", { exe, killed });
		const port = await findFreeCdpPort();
		const launchArgs = [...(opts.appArgs ?? []), `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`在 ${cdpUrl} 上连接 ${path.basename(exe)} 失败:${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`已连接到 ${cdpUrl},但 puppeteer.connect 失败:${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		// Only evict if the registry still points at THIS handle. After a disconnect,
		// `acquireBrowser` may have already replaced the entry with a fresh live handle
		// under the same key; deleting blindly would orphan that new browser.
		if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
		await disposeBrowserHandle(handle, opts);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (handle.kind.kind === "headless") {
		if (handle.sharedDaemon) {
			// The broker owns the Chromium; this process only drops its CDP
			// connection. `kill` is scoped to spawned-app browsers — stopping the
			// shared daemon here would tear down every other session's tabs. The
			// daemon dies with the last omp client in the project (broker idle
			// teardown), or via an explicit hub stop.
			if (handle.browser.connected) {
				try {
					handle.browser.disconnect();
				} catch (err) {
					logger.debug("断开共享浏览器连接失败", { error: (err as Error).message });
				}
			}
			return;
		}
		if (handle.browser.connected) {
			// Puppeteer's `browser.close()` resolves only once the Chromium
			// process fully exits. A wedged Chromium (a known Windows failure
			// mode) leaves this await pending forever, freezing `releaseTab` in
			// the "Closing tab" phase (issue #5260). Bound it, then SIGKILL the
			// process tree so cleanup always completes.
			const proc = handle.browser.process();
			try {
				await withTimeout(handle.browser.close(), HEADLESS_CLOSE_TIMEOUT_MS, "关闭无头浏览器超时");
			} catch (err) {
				logger.debug("关闭无头浏览器失败,正在强制结束", { error: (err as Error).message });
				if (proc?.pid !== undefined) await gracefulKillTreeOnce(proc.pid).catch(() => undefined);
			}
		}
		// OMP owns the profile directory (puppeteer's temp cleanup is disabled by
		// our explicit --user-data-dir), so remove it now the process tree has
		// exited. Tolerant of the Windows lock-held window (issue #7058).
		if (handle.userDataDir) await removeUserDataDir(handle.userDataDir);
		return;
	}
	// Connected and relay browsers belong to the user: drop our CDP link, never kill.
	if (handle.kind.kind === "connected" || handle.kind.kind === "relay") {
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("断开远程浏览器连接失败", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug("断开已启动浏览器连接失败", { error: (err as Error).message });
		}
	}
	if (opts.kill && handle.pid !== undefined) await gracefulKillTreeOnce(handle.pid);
}

/**
 * Attach to the project-shared broker-owned Chromium. Failures surface as
 * `ToolError` — a CLI-host process never silently falls back to a private
 * Chromium, so a broken broker cannot quietly recreate per-process launch
 * storms.
 */
async function openSharedHeadlessHandle(
	kind: Extract<PuppeteerBrowserKind, { kind: "headless" }>,
	opts: AcquireBrowserOptions,
): Promise<PuppeteerBrowserHandle> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	try {
		const shared = await ensureSharedBrowser({
			projectDir: opts.cwd,
			headless: kind.headless,
			viewport: vp,
			signal: opts.signal,
		});
		if (!shared) {
			throw new ToolError(
				"共享浏览器守护进程不可用(代理启动或 Chromium 启动失败);请通过 `hub ps` 查看 omp.browser.* 守护进程,并到 ~/.omp/logs 查看详情",
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserWSEndpoint: shared.wsEndpoint,
			defaultViewport: kind.headless
				? {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
					}
				: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			sharedDaemon: { name: shared.daemonName, projectDir: shared.projectDir },
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	} catch (err) {
		if (err instanceof ToolAbortError || err instanceof ToolError) throw err;
		if (opts.signal?.aborted) throw new ToolAbortError("浏览器打开已中止");
		throw new ToolError(`共享浏览器连接失败:${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Test-only accessor for the module-global browsers map. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}
