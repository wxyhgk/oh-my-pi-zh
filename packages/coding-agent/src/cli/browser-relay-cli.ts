/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import { probeRelayServer } from "../tools/browser/relay/daemon";
import backgroundJs from "../tools/browser/relay/extension-assets/background.js.txt" with { type: "text" };
import manifestJson from "../tools/browser/relay/extension-assets/manifest.json.txt" with { type: "text" };
import optionsHtml from "../tools/browser/relay/extension-assets/options.html.txt" with { type: "text" };
import optionsJs from "../tools/browser/relay/extension-assets/options.js.txt" with { type: "text" };
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";

export const BROWSER_RELAY_ACTIONS = ["serve", "install"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
}

const EXTENSION_FILES: Record<string, string> = {
	"background.js": backgroundJs,
	"manifest.json": manifestJson,
	"options.html": optionsHtml,
	"options.js": optionsJs,
};

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (args.action === "install") {
		await runInstall(args.dir);
		return;
	}
	await runServe(args);
}

async function runInstall(dirOverride: string | undefined): Promise<void> {
	const dir = dirOverride ? path.resolve(dirOverride) : path.join(getBrowserRelayDir(), "extension");
	for (const name in EXTENSION_FILES) {
		await Bun.write(path.join(dir, name), EXTENSION_FILES[name]!);
	}
	console.log(`已将 OMP Browser Relay 扩展安装到 ${dir}`);
	console.log("");
	console.log("在 Chrome 中完成设置:");
	console.log("  1. 打开 chrome://extensions 并启用开发者模式。");
	console.log(`  2. 点击“加载已解压的扩展程序”并选择:${dir}`);
	console.log("  3. 启用该模式:omp-zh config set browser.relay true");
	console.log("");
	console.log("omp 会在浏览器工具需要时自动启动 relay;");
	console.log("只有在使用 --token 或 --no-group 时才需要手动运行 `omp-zh browser-relay`。");
	console.log("扩展徽章在连接到 relay 后会显示 “on”。");
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	let relay: RelayServer;
	try {
		relay = startRelayServer({ port: args.port, token: args.token, group: args.group !== false, log });
	} catch (err) {
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
				console.log(`omp browser relay 已在 http://127.0.0.1:${args.port} 运行;无需操作。`);
				return;
			}
			console.error(`端口 ${args.port} 被非 omp browser relay 的程序占用。`);
			process.exit(1);
		}
		throw err;
	}

	console.log(`omp browser relay 正在监听 http://127.0.0.1:${args.port}`);
	console.log(`  扩展端点  ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`);
	if (args.port === DEFAULT_RELAY_PORT) {
		console.log("  启用方式         omp-zh config set browser.relay true");
	} else {
		console.log(
			`  启用方式         omp-zh config set browser.relay true && omp-zh config set browser.relayUrl http://127.0.0.1:${args.port}`,
		);
	}
	console.log("正在等待 OMP Browser Relay 扩展连接(omp-zh browser-relay install)...");

	let announced = false;
	const readiness = setInterval(() => {
		if (relay.bridge.ready && !announced) {
			announced = true;
			console.log("扩展已连接。omp 浏览器工具现在可以操控你的标签页了。");
		} else if (!relay.bridge.ready && announced) {
			announced = false;
			console.log("扩展已断开;正在等待重新连接...");
		}
	}, 500);

	const shutdown = () => {
		clearInterval(readiness);
		relay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}
