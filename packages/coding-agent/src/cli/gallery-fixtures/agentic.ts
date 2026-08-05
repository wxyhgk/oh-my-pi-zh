// Gallery fixtures for the agentic orchestration tools (task, hub, goal).
import type { Usage } from "@wxyhgk/pi-ai";
import type { TaskToolDetails } from "../../task/types";
import type { HubDetails } from "../../tools/hub";
import type { GalleryFixture } from "./types";

/** Message/activity timestamps are offsets from load time so gallery ages stay plausible. */
const FIXTURE_NOW = Date.now();

/** Plausible cumulative usage for a fixture subagent run. */
const fixtureUsage = (tokens: { input: number; output: number }, costTotal: number): Usage => ({
	input: tokens.input,
	output: tokens.output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: tokens.input + tokens.output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
});

export const agenticFixtures: Record<string, GalleryFixture> = {
	task: {
		label: "Task",
		customRendered: true,
		// Streaming: agent chosen, assignment still landing.
		streamingArgs: {
			agent: "task",
			id: "AuthLoader",
			description: "Load auth middleware",
			assignment: "Read packages/server/src/auth/*.ts and summarize the session-cookie",
		},
		args: {
			agent: "task",
			id: "AuthLoader",
			description: "Load auth middleware",
			assignment:
				"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
		},
		result: {
			content: [
				{
					type: "text",
					text: "Agent AuthLoader 已完成。",
				},
			],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 48_200,
				usage: fixtureUsage({ input: 52_600, output: 8_800 }, 0.12),
				progress: [
					{
						index: 0,
						id: "AuthLoader",
						agent: "task",
						agentSource: "bundled",
						status: "completed",
						task: "Read packages/server/src/auth/session.ts and middleware.ts",
						description: "Load auth middleware",
						lastIntent: "Documenting session-cookie flow",
						recentTools: [
							{ tool: "read", args: "packages/server/src/auth/session.ts", endMs: 1_749_200_040_000 },
							{ tool: "read", args: "packages/server/src/auth/middleware.ts", endMs: 1_749_200_052_000 },
						],
						recentOutput: ["会话校验在 middleware.ts:42 通过 verifySessionCookie() 进行。"],
						toolCount: 9,
						requests: 6,
						tokens: 61_400,
						contextTokens: 23_100,
						contextWindow: 200_000,
						cost: 0.12,
						durationMs: 41_900,
						resolvedModel: "anthropic/claude-sonnet",
					},
				],
				results: [
					{
						index: 0,
						id: "AuthLoader",
						agent: "task",
						agentSource: "bundled",
						description: "Load auth middleware",
						task: "Read packages/server/src/auth/session.ts and middleware.ts",
						assignment:
							"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
						exitCode: 0,
						output: [
							"会话校验在 middleware.ts:42 通过 verifySessionCookie() 进行。",
							"Cookie 使用 HMAC 签名(SHA-256)并对照会话存储进行校验。",
							"session.ts:88 处有 TODO——滑动过期刷新还是桩实现。",
						].join("\n"),
						stderr: "",
						truncated: false,
						durationMs: 41_900,
						tokens: 61_400,
						requests: 6,
						contextTokens: 23_100,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: fixtureUsage({ input: 52_600, output: 8_800 }, 0.12),
						outputMeta: { lineCount: 3, charCount: 214 },
					},
				],
			} satisfies TaskToolDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Agent RateLimiter 失败。",
				},
			],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 9_800,
				usage: fixtureUsage({ input: 10_900, output: 1_400 }, 0.1),
				results: [
					{
						index: 0,
						id: "RateLimiter",
						agent: "task",
						agentSource: "bundled",
						description: "Audit rate limiter",
						task: "Inspect packages/server/src/auth/rate-limit.ts",
						assignment:
							"Inspect packages/server/src/auth/rate-limit.ts. Confirm the 429 path sets Retry-After and report gaps.",
						exitCode: 1,
						output: "",
						stderr: "ENOENT: packages/server/src/auth/rate-limit.ts",
						truncated: false,
						durationMs: 9_800,
						tokens: 12_300,
						requests: 3,
						contextTokens: 6_400,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: fixtureUsage({ input: 10_900, output: 1_400 }, 0.1),
						error: "子 Agent 以退出码 1 结束:目标文件 packages/server/src/auth/rate-limit.ts 不存在。",
						outputMeta: { lineCount: 0, charCount: 0 },
					},
				],
			} satisfies TaskToolDetails,
		},
	},

	hub_send: {
		label: "Hub 发送",
		renderer: "hub",
		// Streaming: recipient known; the message body still arriving.
		streamingArgs: { op: "send", to: "AuthLoader", message: "Are you still touching" },
		args: {
			op: "send",
			to: "AuthLoader",
			message: "Are you still touching src/server/auth.ts? I need to add a 401 path.",
			await: true,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"已投递给 1 个对等 Agent:",
						"- AuthLoader:已唤醒",
						"",
						"AuthLoader 的回复:",
						"auth.ts 已处理完——请继续,只需在我的 session-store 重命名之上 rebase。",
					].join("\n"),
				},
			],
			details: {
				op: "send",
				from: "Main",
				to: "AuthLoader",
				receipts: [{ to: "AuthLoader", outcome: "revived" }],
				waited: {
					id: "7181122334455667789",
					from: "AuthLoader",
					to: "Main",
					body: "auth.ts 已处理完——请继续,只需在我的 session-store 重命名之上 rebase。",
					ts: FIXTURE_NOW - 5_000,
					replyTo: "7181122334455667788",
				},
			} satisfies HubDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: '没有对等 Agent 收到该消息。\n- RateLimiter:失败——未知的 Agent "RateLimiter"',
				},
			],
			details: {
				op: "send",
				from: "Main",
				to: "RateLimiter",
				receipts: [{ to: "RateLimiter", outcome: "failed", error: '未知的 Agent "RateLimiter"' }],
			} satisfies HubDetails,
		},
	},

	hub_wait: {
		label: "Hub 等待",
		customRendered: true,
		renderer: "hub",
		streamingArgs: { op: "wait", from: "AuthLoader" },
		args: { op: "wait", from: "AuthLoader", timeoutMs: 60_000 },
		result: {
			content: [
				{
					type: "text",
					text: "[7181122334455667790] AuthLoader:session-store 重命名已合并;auth.ts 归你了。",
				},
			],
			details: {
				op: "wait",
				from: "Main",
				waited: {
					id: "7181122334455667790",
					from: "AuthLoader",
					to: "Main",
					body: "session-store 重命名已合并;auth.ts 归你了。",
					ts: FIXTURE_NOW - 30_000,
				},
			} satisfies HubDetails,
		},
	},

	hub_inbox: {
		label: "Hub 收件箱",
		customRendered: true,
		renderer: "hub",
		streamingArgs: { op: "inbox" },
		args: { op: "inbox", peek: true },
		result: {
			content: [
				{
					type: "text",
					text: [
						"2 条未读消息:",
						"- [7181122334455667791] AuthLoader:hub 表读取 unreadCount——总线落地时 ping 我。",
						"- [7181122334455667792] RateLimiter(回复 7181122334455667791):总线已进入;回执携带结果。",
					].join("\n"),
				},
			],
			details: {
				op: "inbox",
				from: "Main",
				inbox: [
					{
						id: "7181122334455667791",
						from: "AuthLoader",
						to: "Main",
						body: "hub 表读取 unreadCount——总线落地时 ping 我。",
						ts: FIXTURE_NOW - 4 * 60_000,
					},
					{
						id: "7181122334455667792",
						from: "RateLimiter",
						to: "Main",
						body: "总线已进入;回执携带结果。",
						ts: FIXTURE_NOW - 60_000,
						replyTo: "7181122334455667791",
					},
				],
			} satisfies HubDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "IRC 收件箱失败:消息存储不可用。" }],
			details: { op: "inbox" } satisfies HubDetails,
		},
	},

	hub_list: {
		label: "Hub 对等",
		customRendered: true,
		renderer: "hub",
		streamingArgs: { op: "list" },
		args: { op: "list" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"2 个对等 Agent:",
						"- AuthLoader [task · sub · 空闲] — 父级 Main,2 分钟前活跃",
						"- RateLimiter [task · sub · 已暂停] — 未读 2,父级 Main,12 分钟前活跃",
						"",
						"当你给已暂停的 Agent 发消息时,它们会被自动唤醒。",
					].join("\n"),
				},
			],
			details: {
				op: "list",
				from: "Main",
				peers: [
					{
						id: "AuthLoader",
						displayName: "task",
						kind: "sub",
						status: "idle",
						parentId: "Main",
						unread: 0,
						lastActivity: FIXTURE_NOW - 2 * 60_000,
					},
					{
						id: "RateLimiter",
						displayName: "task",
						kind: "sub",
						status: "parked",
						parentId: "Main",
						unread: 2,
						lastActivity: FIXTURE_NOW - 12 * 60_000,
					},
				],
			} satisfies HubDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "IRC 列表失败:Agent 中心不可用。" }],
			details: { op: "list" } satisfies HubDetails,
		},
	},

	goal: {
		label: "Goal",
		// Streaming: op is "create"; objective text still being typed.
		streamingArgs: { op: "create", objective: "Ship the auth hardening" },
		args: {
			op: "create",
			objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
			token_budget: 500_000,
		},
		result: {
			content: [
				{
					type: "text",
					text: "目标已设定。正在推进:完成认证加固工作。",
				},
			],
			details: {
				op: "create",
				remainingTokens: 451_800,
				completionBudgetReport: null,
				goal: {
					id: "goal_8f2a",
					objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
					status: "active",
					tokenBudget: 500_000,
					tokensUsed: 48_200,
					timeUsedSeconds: 312,
					createdAt: 1_749_200_000_000,
					updatedAt: 1_749_200_312_000,
				},
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Goal 工具失败:op=create 时必须提供 objective。" }],
			details: { op: "create" },
		},
	},

	hub_jobs: {
		label: "Hub 任务",
		renderer: "hub",
		// Streaming: waiting on a single job id; the second id is still arriving.
		streamingArgs: { op: "wait", ids: ["job_a1"] },
		args: { op: "wait", ids: ["job_a1", "job_b2", "job_c3"] },
		result: {
			content: [{ type: "text", text: "3 个任务已完成。" }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_a1",
						type: "bash",
						status: "completed",
						label: "bun test packages/server/test/auth.test.ts",
						durationMs: 18_400,
						resultText: "42 通过,0 失败(18.4s)",
					},
					{
						id: "job_b2",
						type: "task",
						status: "completed",
						label: "将限流器迁移到滑动窗口",
						durationMs: 96_700,
						resultText: "将 rate-limit.ts 重写为令牌桶;增加了按账户的密钥。",
					},
					{
						id: "job_c3",
						type: "bash",
						status: "failed",
						label: "bunx biome check packages/server/src/auth",
						durationMs: 4_100,
						errorText: "biome:tokens.ts 中有 2 个错误——noUnusedVariables、useConst",
					},
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "1 个任务失败。" }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_d4",
						type: "task",
						status: "failed",
						label: "将会话存储重构为 Redis",
						durationMs: 52_300,
						errorText: "子 Agent 以退出码 1 结束:缺少 Redis 连接字符串。",
					},
				],
			},
		},
	},
};
