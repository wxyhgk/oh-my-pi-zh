// Gallery fixtures for the web tools (web_search, browser).
import type { GalleryFixture } from "./types";

export const webFixtures: Record<string, GalleryFixture> = {
	web_search: {
		label: "Web Search",
		// Streaming: query still being typed, no recency/limit yet.
		streamingArgs: { query: "bun vs node performance" },
		args: {
			query: "Bun vs Node.js performance benchmarks 2026",
			recency: "month",
			limit: 4,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"得益于 JavaScriptCore 引擎和原生 Zig 运行时,Bun 在原始 HTTP 吞吐量和冷启动",
						"时间上继续优于 Node.js;而 Node.js 在生态成熟度和长期稳定性上仍保持优势。",
						"对于脚本密集型工作流,Bun 更快的启动速度是决定性因素。",
					].join("\n"),
				},
			],
			details: {
				response: {
					provider: "perplexity",
					model: "sonar-pro",
					authMode: "api_key",
					requestId: "req_a1b2c3d4e5f6",
					answer: [
						"得益于 JavaScriptCore 引擎和原生 Zig 运行时,Bun 在原始 HTTP 吞吐量和冷启动",
						"时间上继续优于 Node.js;而 Node.js 在生态成熟度和长期稳定性上仍保持优势。",
						"对于脚本密集型工作流,Bun 更快的启动速度是决定性因素。",
					].join("\n"),
					searchQueries: ["bun vs node.js performance benchmarks 2026", "bun http throughput vs node"],
					sources: [
						{
							title: "Bun 1.2 Benchmarks: HTTP, SQLite, and Startup Time",
							url: "https://bun.sh/blog/bun-v1.2-benchmarks",
							snippet:
								"在简单的 HTTP 服务器上,Bun 每秒处理的请求数大约是 Node.js 的 2.5 倍,并且启动时间不到 10ms。",
							ageSeconds: 86400 * 12,
							author: "The Bun Team",
						},
						{
							title: "Node.js vs Bun: A 2026 Performance Deep Dive",
							url: "https://blog.platformatic.dev/nodejs-vs-bun-2026",
							snippet: "在 CPU 密集型工作负载上差距缩小,但 Bun 更快的模块解析让冷启动仍然领先。",
							ageSeconds: 86400 * 3,
							author: "Matteo Collina",
						},
						{
							title: "Real-world API latency: Bun, Deno, and Node compared",
							url: "https://www.theregister.com/2026/05/18/js_runtime_latency/",
							snippet: "在持续负载下 p99 延迟趋同,表明运行时选择对稳态服务的影响较小。",
							ageSeconds: 86400 * 19,
						},
						{
							title: "Why we migrated our CLI tooling from Node to Bun",
							url: "https://engineering.example.com/posts/bun-cli-migration",
							snippet: "启动时间从 180ms 降至 22ms,每次开发者命令调用都节省了数秒。",
							ageSeconds: 86400 * 27,
							author: "Dana Whitfield",
						},
					],
					citations: [
						{
							url: "https://bun.sh/blog/bun-v1.2-benchmarks",
							title: "Bun 1.2 Benchmarks",
							citedText: "Bun 每秒处理的请求数大约是 Node.js 的 2.5 倍",
						},
					],
					usage: {
						inputTokens: 312,
						outputTokens: 248,
						totalTokens: 560,
						searchRequests: 2,
					},
				},
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "网络搜索失败:提供商返回 HTTP 429(已限流)。" }],
			details: {
				response: {
					provider: "perplexity",
					sources: [],
				},
				error: "提供商返回 HTTP 429(已限流)。请在 30 秒后重试。",
			},
		},
	},

	browser: {
		label: "Browser",
		// Streaming: code body still arriving for a `run` action.
		streamingArgs: {
			action: "run",
			name: "docs",
			code: "const obs = await tab.observe();\n",
		},
		args: {
			action: "run",
			name: "docs",
			code: [
				"const obs = await tab.observe();",
				"const heading = obs.elements.find(e => e.role === 'heading');",
				"display({ url: obs.url, title: obs.title, headings: obs.elements.filter(e => e.role === 'heading').length });",
				"return heading?.name ?? 'no heading found';",
			].join("\n"),
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						'{ url: "https://bun.sh/docs", title: "Bun Documentation", headings: 14 }',
						'"Get started with Bun"',
					].join("\n"),
				},
			],
			details: {
				action: "run",
				name: "docs",
				url: "https://bun.sh/docs",
				browser: "headless",
				viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
				result: '"Get started with Bun"',
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: [
						"TimeoutError: waiting for selector `aria/Sign in` failed: timeout 30000ms exceeded",
						"    at Tab.waitFor (browser/tab.ts:212:13)",
						"    at run (eval:3:7)",
					].join("\n"),
				},
			],
			details: {
				action: "run",
				name: "docs",
				url: "https://bun.sh/docs",
				browser: "headless",
			},
		},
	},
};
