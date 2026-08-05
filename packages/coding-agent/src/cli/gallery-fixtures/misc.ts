/** Gallery fixtures for the ask / ssh / github / inspect_image tools. */
import type { GalleryFixture } from "./types";

export const miscFixtures: Record<string, GalleryFixture> = {
	ask: {
		label: "Ask",
		streamingArgs: {
			questions: [
				{
					id: "db",
					question: "新服务应该使用哪个数据库?",
					options: [{ label: "Postgres" }],
				},
			],
		},
		args: {
			questions: [
				{
					id: "db",
					question: "新服务应该使用哪个数据库?",
					options: [
						{ label: "Postgres", description: "关系型,强一致性,支持 JSONB" },
						{ label: "SQLite", description: "嵌入式,零运维,适合单节点" },
						{ label: "MongoDB", description: "文档存储,灵活的 schema" },
					],
					recommended: 0,
				},
				{
					id: "features",
					question: "v1 应该包含哪些认证流程?",
					options: [
						{ label: "邮箱 + 密码" },
						{ label: "OAuth(Google、GitHub)" },
						{ label: "魔法链接" },
						{ label: "SAML SSO", description: "企业级;可以推迟" },
					],
					multi: true,
				},
			],
		},
		result: {
			content: [
				{
					type: "text",
					text: "db: Postgres\nfeatures: 邮箱 + 密码, OAuth(Google、GitHub)",
				},
			],
			details: {
				results: [
					{
						id: "db",
						question: "新服务应该使用哪个数据库?",
						options: ["Postgres", "SQLite", "MongoDB"],
						multi: false,
						selectedOptions: ["Postgres"],
					},
					{
						id: "features",
						question: "v1 应该包含哪些认证流程?",
						options: ["邮箱 + 密码", "OAuth(Google、GitHub)", "魔法链接", "SAML SSO"],
						multi: true,
						selectedOptions: ["邮箱 + 密码", "OAuth(Google、GitHub)"],
					},
				],
			},
		},
		errorResult: {
			content: [{ type: "text", text: "用户未作答前取消了提示" }],
			isError: true,
		},
	},

	github: {
		label: "GitHub",
		streamingArgs: {
			op: "search_prs",
			query: "is:open author:@me",
		},
		args: {
			op: "search_prs",
			query: "is:open review-requested:@me sort:updated",
			repo: "oh-my-pi/pi",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"#1842  feat(tui): virtualized scrollback for tool output     openyou · 2h ago   +312 -47",
						"#1839  fix(agent): retry stream on transient 529             dvir   · 5h ago   +18 -4",
						"#1830  refactor(edit): unify hashline + ast_edit previews    mira   · 1d ago   +540 -210",
						"#1817  docs: document gallery fixtures contract             leo    · 2d ago   +96 -0",
						"",
						"4 个等待你评审的打开的拉取请求",
					].join("\n"),
				},
			],
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "gh:无法解析名为 'oh-my-pi/pi' 的仓库。(HTTP 404)",
				},
			],
			isError: true,
		},
	},

	inspect_image: {
		label: "Inspect Image",
		streamingArgs: {
			path: "docs/assets/dashboard-mock.png",
		},
		args: {
			path: "docs/assets/dashboard-mock.png",
			question: "What chart types are shown and roughly what layout does the dashboard use?",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"该仪表盘采用深色背景上的双栏布局。",
						"顶部一行:四个 KPI 卡片(收入、活跃用户、流失率、MRR),带迷你趋势图。",
						"左栏:过去约 3 个月的每周会话堆叠面积图。",
						"右栏:对前 6 大引荐来源进行排名的水平条形图。",
						"底部:带状态标记的分页近期交易表格。",
					].join("\n"),
				},
			],
			details: {
				model: "claude-opus-4",
				imagePath: "docs/assets/dashboard-mock.png",
				mimeType: "image/png",
			},
		},
		errorResult: {
			content: [{ type: "text", text: "找不到图片:docs/assets/dashboard-mock.png" }],
			isError: true,
			details: {
				model: "claude-opus-4",
				imagePath: "docs/assets/dashboard-mock.png",
				mimeType: "image/png",
			},
		},
	},

	// Built-in tool with no dedicated renderer — exercises the generic fallback
	// (`#formatToolExecution`) path so its padded, state-tinted block is QA'd.
	report_tool_issue: {
		label: "上报工具问题",
		streamingArgs: { tool: "lsp" },
		args: {
			tool: "lsp",
			report: "对具有 12 处引用的导出符号执行重命名没有产生任何编辑",
		},
		result: { content: [{ type: "text", text: "已记录,谢谢!" }] },
		errorResult: {
			content: [{ type: "text", text: "无法记录该报告:问题跟踪器不可达" }],
			isError: true,
		},
	},

	// Stand-in for a custom/extension tool that ships no renderer — same generic
	// fallback path most MCP/extension tools take.
	custom: {
		label: "自定义工具",
		streamingArgs: { query: "weather" },
		args: { query: "weather in Tokyo", units: "metric" },
		result: { content: [{ type: "text", text: "Tokyo: 22°C, partly cloudy, humidity 64%." }] },
		errorResult: {
			content: [{ type: "text", text: "上游提供商返回了 503 Service Unavailable" }],
			isError: true,
		},
	},
};
