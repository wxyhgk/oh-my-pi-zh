import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { CLI_THINKING_LEVELS } from "../cli/thinking-levels";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";

export const launchHelp = {
	description: "AI 编程助手",
	hidden: true,
	args: {
		messages: Args.string({
			description: "要发送的消息（用 @ 前缀引用文件）",
			required: false,
			multiple: true,
		}),
	},
	flags: {
		model: Flags.string({
			description: '使用的模型（模糊匹配："opus"、"gpt-5.2" 或 "openai/gpt-5.2"）',
		}),
		smol: Flags.string({ description: "用于轻量任务的 Smol/快速模型（或 PI_SMOL_MODEL 环境变量）" }),
		slow: Flags.string({ description: "用于深入分析的慢速/推理模型（或 PI_SLOW_MODEL 环境变量）" }),
		plan: Flags.string({ description: "用于架构规划的规划模型（或 PI_PLAN_MODEL 环境变量）" }),
		prewalk: Flags.boolean({
			description:
				"在计划的待办列表生成后，于第一次编辑/写入时将活动模型切换为快速/廉价模型（默认关闭；参见 prewalk.enabled）",
		}),
		"no-prewalk": Flags.boolean({ description: "即使设置了 prewalk.enabled 也禁用 prewalk" }),
		"prewalk-into": Flags.string({ description: 'prewalk 的目标模型（默认为 "smol" 角色）' }),
		"plan-yolo": Flags.boolean({
			description:
				"启动时强制只读计划模式，在模型的第一次 resolve 调用时自动批准计划，然后切换到 --plan-yolo-into 指定的模型来实施",
		}),
		"plan-yolo-into": Flags.string({ description: 'plan-yolo 执行的目标模型（默认为 "smol" 角色）' }),
		provider: Flags.string({ description: "要使用的提供商（旧参数；推荐使用 --model）" }),
		"api-key": Flags.string({ description: "API 密钥（默认使用环境变量）" }),
		"system-prompt": Flags.string({ description: "系统提示词（默认：编程助手提示词）" }),
		"append-system-prompt": Flags.string({ description: "将文本或文件内容附加到系统提示词" }),
		"allow-home": Flags.boolean({ description: "允许在 ~ 目录启动，不自动切换到临时目录" }),
		profile: Flags.string({ description: "使用隔离的配置文件来管理认证、会话、设置和缓存" }),
		alias: Flags.string({ description: "为所选配置文件创建 shell 快捷方式并退出" }),
		cwd: Flags.string({ description: "启动目录（覆盖启动时的 cwd）" }),
		mode: Flags.string({
			description: "输出模式：text（默认）、json、rpc 或 rpc-ui",
			options: ["text", "json", "rpc", "acp", "rpc-ui"],
		}),
		config: Flags.string({
			description: "为此运行加载额外的 config.yml 风格覆盖层（可重复）",
			multiple: true,
		}),
		"add-dir": Flags.string({
			description: "在工作目录之外添加一个工作区目录（可重复）",
			multiple: true,
		}),
		print: Flags.boolean({ char: "p", description: "非交互模式：处理提示词后退出" }),
		continue: Flags.boolean({ char: "c", description: "继续上一个会话" }),
		resume: Flags.string({ char: "r", description: "恢复会话（按 ID 前缀、路径，省略时使用选择器）" }),
		"from-claude": Flags.boolean({ description: "将 Claude Code 会话导入 OMP" }),
		"from-codex": Flags.boolean({ description: "将 Codex 会话导入 OMP" }),
		"session-dir": Flags.string({ description: "会话存储与查找目录" }),
		"no-session": Flags.boolean({ description: "不保存会话（临时）" }),
		models: Flags.string({ description: "用于 Ctrl+P 循环切换的逗号分隔模型模式" }),
		"no-tools": Flags.boolean({ description: "禁用所有内置工具" }),
		"no-lsp": Flags.boolean({ description: "禁用 LSP 工具、格式化和诊断" }),
		"no-pty": Flags.boolean({ description: "禁用基于 PTY 的交互式 bash 执行" }),
		tools: Flags.string({ description: "要启用的工具列表（逗号分隔；默认：全部）" }),
		thinking: Flags.string({
			description: `设置思考级别：${CLI_THINKING_LEVELS.join(", ")}`,
			options: [...CLI_THINKING_LEVELS],
		}),
		"service-tier": Flags.string({
			description: "本次会话的 OpenAI 服务层级（none 表示省略 service_tier）",
			options: [...SERVICE_TIER_OPENAI_VALUES],
		}),
		"hide-thinking": Flags.boolean({
			description: "在 TUI 输出中隐藏思考块（仅影响显示，不会禁用模型思考）",
		}),
		advisor: Flags.boolean({
			description: "启用 advisor 运行时（被动审核每一轮并注入建议）",
		}),
		hook: Flags.string({ description: "加载 hook/扩展文件（可多次使用）", multiple: true }),
		extension: Flags.string({
			char: "e",
			description: "加载扩展文件（可多次使用）",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "禁用扩展发现（显式的 -e 路径仍然有效）",
		}),
		"no-skills": Flags.boolean({ description: "禁用技能发现与加载" }),
		skills: Flags.string({ description: "用于筛选技能的逗号分隔 glob 模式（例如 git-*,docker）" }),
		"no-rules": Flags.boolean({ description: "禁用规则发现与加载" }),
		export: Flags.string({ description: "将会话文件导出为 HTML 并退出" }),
		"no-title": Flags.boolean({ description: "禁用标题自动生成" }),
		"print-thoughts": Flags.boolean({ description: "在 print 模式的文本输出中包含思考块" }),
		"max-time": Flags.string({ description: "在此持续时间后停止会话（例如 600、10m、1h）" }),
		"auto-approve": Flags.boolean({
			aliases: ["yolo"],
			description: "自动批准所有工具调用（跳过批准提示）",
		}),
		"approval-mode": Flags.string({
			options: ["always-ask", "write", "yolo"],
			description: "覆盖本次会话的 tools.approvalMode（always-ask|write|yolo）",
		}),
	},
	examples: [
		`# 交互模式\n  ${APP_NAME}`,
		`# 交互模式 + 初始提示词\n  ${APP_NAME} "List all .ts files in src/"`,
		`# 在初始消息中包含文件\n  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		`# 非交互模式（处理后退出）\n  ${APP_NAME} -p "List all .ts files in src/"`,
		`# 继续上一个会话\n  ${APP_NAME} --continue "What did we discuss?"`,
		`# 为工作配置文件创建 shell 快捷方式\n  ${APP_NAME} --profile work --alias omp-work`,
		`# 使用不同的模型（模糊匹配）\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# 将模型循环切换限制为特定模型\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# 将会话文件导出为 HTML\n  ${APP_NAME} --export ~/.omp/agent/sessions/--path--/session.jsonl`,
	],
} satisfies CommandMetadata;
