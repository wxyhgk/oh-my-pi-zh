import { describe, expect, test } from "bun:test";
import { pickElectronTarget, shouldPreserveConnectedBrowserFocus } from "@wxyhgk/pi-coding-agent/tools/browser/attach";
import {
	acquireBrowser,
	type BrowserHandle,
	normalizeConnectedCdpUrl,
	releaseBrowser,
} from "@wxyhgk/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab } from "@wxyhgk/pi-coding-agent/tools/browser/tab-supervisor";
import type { Browser, Page, Target } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

interface FakePageOptions {
	url: string;
	title: string;
	visible?: boolean;
}

function fakePage(options: FakePageOptions): Page {
	return {
		url: () => options.url,
		title: async () => options.title,
		evaluate: async () => options.visible === true,
	} as unknown as Page;
}

function fakeTarget(type: string, page: Page | null): Target {
	return {
		type: () => type,
		page: async () => page,
	} as unknown as Target;
}

describe("pickElectronTarget", () => {
	test("uses discovered CDP page targets when browser.pages is empty", async () => {
		const page = fakePage({ url: "https://www.google.com/", title: "Google" });
		let pagesCalled = false;
		const browser = {
			targets: () => [fakeTarget("browser", null), fakeTarget("page", page)],
			pages: async () => {
				pagesCalled = true;
				return [];
			},
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "google" })).resolves.toBe(page);
		expect(pagesCalled).toBe(false);
	});

	test("falls back to browser.pages when discovered targets have no usable page", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = {
			targets: () => [fakeTarget("browser", null), fakeTarget("service_worker", null)],
			pages: async () => [page],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser)).resolves.toBe(page);
	});

	test("reports available pages when the matcher misses", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = {
			targets: () => [fakeTarget("page", page)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "missing" })).rejects.toThrow(
			'没有与 "missing" 匹配的页面目标。可用页面:\n- Example  https://example.com/',
		);
	});

	test("prefers the foreground tab when asked to, without disturbing default order", async () => {
		const background = fakePage({ url: "https://example.com/", title: "Example" });
		const foreground = fakePage({ url: "https://example.org/", title: "Example Org", visible: true });
		const browser = {
			targets: () => [fakeTarget("page", background), fakeTarget("page", foreground)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { preferVisible: true })).resolves.toBe(foreground);
		await expect(pickElectronTarget(browser)).resolves.toBe(background);
	});

	test("falls back to the first usable tab when no tab reports itself visible", async () => {
		const first = fakePage({ url: "https://example.com/", title: "Example" });
		const second = fakePage({ url: "https://example.org/", title: "Example Org" });
		const browser = {
			targets: () => [fakeTarget("page", first), fakeTarget("page", second)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { preferVisible: true })).resolves.toBe(first);
	});

	test("preserves connected-browser focus only for automatic target selection", () => {
		expect(shouldPreserveConnectedBrowserFocus()).toBe(true);
		expect(shouldPreserveConnectedBrowserFocus("example.com")).toBe(false);
	});

	test("rejects websocket cdp_url values with an actionable diagnostic", () => {
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/id")).toThrow(
			"browser app.cdp_url 必须是 HTTP CDP 发现端点",
		);
		expect(normalizeConnectedCdpUrl("http://127.0.0.1:9222/")).toBe("http://127.0.0.1:9222");
	});

	// Launches real headless Chromium; skipped where Chrome's system libraries are absent.
	test.skipIf(!CHROMIUM_AVAILABLE)(
		"navigates a fresh attached tab to the requested URL",
		async () => {
			const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
			const endpoint = new URL(launched.browser.wsEndpoint());
			let attached: BrowserHandle | undefined;
			let opened = false;
			const tabName = `attach-navigation-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const requested = "data:text/html,<title>attached-navigation-target</title>";

			try {
				attached = await acquireBrowser(
					{ kind: "connected", cdpUrl: `http://${endpoint.host}` },
					{ cwd: process.cwd() },
				);
				const { tab } = await acquireTab(tabName, attached, {
					url: requested,
					waitUntil: "domcontentloaded",
					timeoutMs: 10_000,
				});
				opened = true;

				expect(tab.info.url).toBe(requested);
			} finally {
				if (opened) await releaseTab(tabName, { kill: false });
				else if (attached) await releaseBrowser(attached, { kill: false });
				await releaseBrowser(launched, { kill: true });
			}
		},
		30_000,
	);

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"does not retry an attached navigation failure as worker startup",
		async () => {
			let requestCount = 0;
			const server = Bun.serve({
				port: 0,
				fetch: () => {
					requestCount++;
					return new Promise<Response>(() => {});
				},
			});
			const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
			const endpoint = new URL(launched.browser.wsEndpoint());
			let attached: BrowserHandle | undefined;

			let attempted = false;
			try {
				attached = await acquireBrowser(
					{ kind: "connected", cdpUrl: `http://${endpoint.host}` },
					{ cwd: process.cwd() },
				);
				attempted = true;
				await expect(
					acquireTab(`attach-failure-${process.pid}-${Math.random().toString(36).slice(2)}`, attached, {
						url: `http://127.0.0.1:${server.port}/hang`,
						waitUntil: "domcontentloaded",
						timeoutMs: 100,
					}),
				).rejects.toThrow(/Navigation timeout/i);
				expect(requestCount).toBe(1);
			} finally {
				if (attached && !attempted) await releaseBrowser(attached, { kill: false });
				await releaseBrowser(launched, { kill: true });
				await server.stop(true);
			}
		},
		30_000,
	);
});
