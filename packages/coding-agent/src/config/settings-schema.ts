import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { DEFAULT_SHARE_URL } from "@oh-my-pi/pi-wire";
import { SHAPE_VARIANT_NAMES } from "@oh-my-pi/snapcompact";
import { DEFAULT_RELAY_URL } from "../collab/protocol";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS, LIVE_VOICE_VALUES } from "../live/voices";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS, STT_MODEL_VALUES } from "../stt/models";
import { STT_SUBMIT_TRIGGER_OPTIONS, STT_SUBMIT_TRIGGER_VALUES } from "../stt/submit-trigger";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata, getThinkingLevelMetadata } from "../thinking";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../tiny/dtype";
import {
	AUTO_THINKING_MODEL_OPTIONS,
	AUTO_THINKING_MODEL_VALUES,
	ONLINE_AUTO_THINKING_MODEL_KEY,
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_MEMORY_MODEL_OPTIONS,
	TINY_MEMORY_MODEL_VALUES,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "../tiny/models";
import { IMAGE_PROVIDER_CHOICES, type ImageProvider } from "../tools/image-providers";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODEL_OPTIONS,
	TTS_LOCAL_MODEL_VALUES,
	TTS_LOCAL_VOICE_OPTIONS,
	TTS_LOCAL_VOICE_VALUES,
} from "../tts/models";
import { EDIT_MODES } from "../utils/edit-mode";
import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	SEARCH_PROVIDER_CHOICES,
	type SearchProviderId,
} from "../web/search/types";
import {
	SERVICE_TIER_ANTHROPIC_OPTIONS,
	SERVICE_TIER_ANTHROPIC_VALUES,
	SERVICE_TIER_GOOGLE_OPTIONS,
	SERVICE_TIER_GOOGLE_VALUES,
	SERVICE_TIER_INHERIT_OPTIONS,
	SERVICE_TIER_INHERIT_SETTING_VALUES,
	SERVICE_TIER_OPENAI_OPTIONS,
	SERVICE_TIER_OPENAI_VALUES,
} from "./service-tier";

/** Unified settings schema - single source of truth for all settings.
 *
 * Each setting is defined once here with:
 * - Type and default value
 * - Optional UI metadata (label, description, tab, group)
 *
 * UI metadata places the setting in the settings panel: `tab` picks the
 * panel tab, `group` the titled section within it (registered in
 * TAB_GROUPS). Sections render in TAB_GROUPS order; settings within a
 * section keep declaration order.
 *
 * The Settings singleton provides type-safe path-based access:
 *   settings.get("compaction.enabled")  // => boolean
 *   settings.set("theme.dark", "titanium")  // sync, saves in background
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type ModelRoleStorage = "global" | "project";

export type SettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers";

/** Tab display metadata - icon is resolved via theme.symbol() */
export type TabMetadata = { label: string; icon: `tab.${string}` };

/** Ordered list of tabs for UI rendering */
export const SETTING_TABS: SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"context",
	"memory",
	"files",
	"shell",
	"tools",
	"tasks",
	"providers",
];

/** Tab display metadata - icon is a symbol key from theme.ts (tab.*) */
export const TAB_METADATA: Record<SettingTab, { label: string; icon: `tab.${string}` }> = {
	appearance: { label: "外观", icon: "tab.appearance" },
	model: { label: "模型", icon: "tab.model" },
	interaction: { label: "交互", icon: "tab.interaction" },
	context: { label: "上下文", icon: "tab.context" },
	memory: { label: "记忆", icon: "tab.memory" },
	files: { label: "文件", icon: "tab.files" },
	shell: { label: "Shell", icon: "tab.shell" },
	tools: { label: "工具", icon: "tab.tools" },
	tasks: { label: "任务", icon: "tab.tasks" },
	providers: { label: "提供商", icon: "tab.providers" },
};

/**
 * Ordered section groups per tab. Settings declare their section via `ui.group`;
 * the settings UI renders groups in this order with a heading row between them.
 * Ungrouped settings render first, before any section heading.
 */
export const TAB_GROUPS: Record<SettingTab, readonly string[]> = {
	appearance: ["Theme", "Status Line", "Display", "Images"],
	model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
	interaction: [
		"Input",
		"Approvals",
		"Notifications",
		"Speech",
		"Collab",
		"Magic Keywords",
		"Startup & Updates",
		"Power (macOS)",
		"Agent",
		"Git",
	],
	context: ["General", "Compaction", "Rules (TTSR)", "Experimental"],
	memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight"],
	files: ["Editing", "Reading", "Read Summaries", "LSP"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Grep & Browser",
		"Computer",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Developer",
	],
	tasks: ["Modes", "Subagents", "Isolation", "Commands & Skills"],
	providers: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write"
	| "cache_hit"
	| "session_name"
	| "usage"
	| "collab";

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;
	/** Section within the tab; must be listed in TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	label: string;
	description: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	/** Submenu options. When omitted, the enum renders as an inline toggle derived from `values`. */
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	/** Submenu options. Without options, a numeric setting has no UI representation (intentional hide). */
	options?: ReadonlyArray<SubmenuOption>;
}

interface UiString extends UiBase {
	/** Mask the value in both the settings row and text editor. */
	secret?: boolean;
	/**
	 * Submenu options.
	 *  - Array  → submenu with these choices.
	 *  - "runtime" → submenu populated by the runtime layer (theme registry, etc.).
	 *  - Omitted → renders as a free text input.
	 */
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

interface UiArray extends UiBase {
	/** Membership choices. Without options, an array setting has no UI representation (config-file only). */
	options?: ReadonlyArray<SubmenuOption>;
	/** Selection order is meaningful; the editor renders positions and supports reordering. */
	ordered?: boolean;
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
	secret?: boolean;
	ordered?: boolean;
};

/**
 * Marks a setting whose value is a credential.
 *
 * Lives at the top level rather than inside `ui` so it can also describe a
 * setting the settings panel never shows and therefore cannot carry
 * `ui.secret`. Read it through `isCredential`, which is the single accessor
 * both the CLI and the settings panel consult.
 */
interface CredentialMarker {
	credential?: true;
}

interface BooleanDef extends CredentialMarker {
	type: "boolean";
	default: boolean | undefined;
	ui?: UiBoolean;
}

interface StringDef extends CredentialMarker {
	type: "string";
	default: string | undefined;
	ui?: UiString;
}

interface NumberDef extends CredentialMarker {
	type: "number";
	default: number | undefined;
	ui?: UiNumber;
}

interface EnumDef<T extends readonly string[]> extends CredentialMarker {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiEnum<T>;
}

interface ArrayDef<T> extends CredentialMarker {
	type: "array";
	default: T[];
	ui?: UiArray;
}

interface RecordDef<T> extends CredentialMarker {
	type: "record";
	default: Record<string, T>;
	ui?: UiBase;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS: string[] = ["hub"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "glob",
		message: "Use the `glob` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched. Allowed device sinks are consumed while looking for later
		// real file redirects because the write tool cannot replace shell
		// output/discard targets.
		pattern:
			"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
	{
		pattern: "^\\s*nohup\\s+|(?<!&)\\&\\s*$",
		tool: "hub",
		message:
			'Use the `hub` tool (`op:"start"`) instead of nohup or background shell syntax so the process stays observable and managed.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))",
		tool: "hub",
		message:
			'Use the `hub` tool (`op:"start"`) for services, watchers, and debuggers so other omp instances can observe and control them.',
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)",
		tool: "hub",
		message: 'Use the `hub` tool (`op:"start"`) for watch mode so its output, input, and lifecycle stay managed.',
	},
];

export const SETTINGS_SCHEMA = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	setupVersion: { type: "number", default: 0 },

	// Auth broker — credentials proxied through a remote `omp auth-broker serve`
	// host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	// Env (`OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`) takes precedence so
	// per-machine overrides remain trivial.
	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined, credential: true },

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "自动恢复",
			description: "自动恢复当前目录中最近的会话",
		},
	},

	// macOS power assertions (caffeinate flags). No-op on other platforms.
	"power.sleepPrevention": {
		type: "enum",
		values: ["off", "idle", "display", "system"] as const,
		default: "idle",
		ui: {
			tab: "interaction",
			group: "Power (macOS)",
			label: "阻止睡眠",
			description:
				"在活动会话期间阻止 macOS 休眠。每个级别都是累积的 — 会加上所有更低级别的标志。",
			options: [
				{
					value: "off",
					label: "关闭",
					description: "不阻止任何休眠",
				},
				{
					value: "idle",
					label: "阻止空闲睡眠",
					description: "会话打开期间保持系统唤醒(caffeinate -i)",
				},
				{
					value: "display",
					label: "阻止显示器睡眠",
					description: "同时防止显示器空闲休眠(caffeinate -i -d)",
				},
				{
					value: "system",
					label: "阻止系统睡眠",
					description: "同时阻止接通电源时的所有系统休眠,并将用户标记为活跃(caffeinate -i -d -s -u)",
				},
			],
		},
	},
	"advisor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "启用 Advisor",
			description:
				"配对第二个模型(分配给 'advisor' 角色),被动审查每一轮并注入备注。",
		},
	},
	"prewalk.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Prewalk",
			label: "启用 Prewalk",
			description:
				"在活动模型上启动,然后在计划提示的任务列表出现后的第一次编辑/写入时切换到快速/廉价模型(默认 'smol' 角色) — 强模型负责规划、提交任务并开始实现,然后交接。可通过 --prewalk / --no-prewalk 按会话覆盖。",
		},
	},
	"advisor.subagents": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "子代理 Advisor",
			description: "同时为派生的 task/eval 子代理启用 Advisor。",
			condition: "advisorEnabled",
		},
	},
	"advisor.syncBacklog": {
		type: "enum",
		values: ["off", "1", "3", "5"] as const,
		default: "off",
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor 同步积压",
			description:
				"如果 Advisor 落后这么多轮,主 Agent 最多暂停 30 秒。Off 禁用追赶延迟。",
			condition: "advisorEnabled",
		},
	},
	"advisor.immuneTurns": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			group: "Advisor",
			label: "Advisor 免疫轮次",
			description:
				"在 Advisor 的问题或阻塞项打断后,接下来的这么多主轮次内,其余问题/阻塞项以非打断方式传递。",
			options: [
				{ value: "0", label: "0 轮", description: "允许每个问题/阻塞项打断。" },
				{ value: "1", label: "1 轮" },
				{ value: "2", label: "2 轮" },
				{ value: "3", label: "3 轮", description: "默认。" },
				{ value: "4", label: "4 轮" },
				{ value: "5", label: "5 轮" },
			],
			condition: "advisorEnabled",
		},
	},
	shellPath: { type: "string", default: undefined },
	"git.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Git",
			label: "启用 Git 集成",
			description: "在 TUI 中显示 git 分支、状态和 PR 信息,并监控仓库元数据。",
		},
	},

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	"providers.maxInFlightRequests": {
		type: "record",
		default: EMPTY_NUMBER_RECORD,
		ui: {
			tab: "providers",
			group: "Services",
			label: "最大并发请求数",
			description:
				'每个提供商 id(例如 "openai" 或 "anthropic")的最大并发 LLM 请求数,在共享此配置根的本地 OMP 进程间共享。未列出的提供商无限制。',
		},
	},

	disabledExtensions: { type: "array", default: EMPTY_STRING_ARRAY },

	modelRoleStorage: {
		type: "enum",
		values: ["global", "project"] as const,
		default: "global",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "模型角色存储位置",
			description: "模型选择器的角色分配保存在哪里",
			options: [
				{
					value: "global",
					label: "全局",
					description: "将角色模型保存在当前活动配置文件中(当前行为)",
				},
				{
					value: "project",
					label: "按项目",
					description: "将项目角色模型保存在 .omp/config.yml;缺失的项目角色使用全局默认",
				},
			],
		},
	},

	modelRoles: { type: "record", default: EMPTY_STRING_RECORD },

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },

	// ────────────────────────────────────────────────────────────────────────
	// Appearance
	// ────────────────────────────────────────────────────────────────────────

	// Theme
	"theme.dark": {
		type: "string",
		default: "titanium",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "深色主题",
			description: "终端为深色背景时使用的主题",
			options: "runtime",
		},
	},

	"theme.light": {
		type: "string",
		default: "light",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "浅色主题",
			description: "终端为浅色背景时使用的主题",
			options: "runtime",
		},
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "符号预设",
			description: "图标和符号的字形集(Unicode、Nerd Font 或 ASCII)",
			options: [
				{ value: "unicode", label: "Unicode", description: "标准符号(默认)" },
				{ value: "nerd", label: "Nerd Font", description: "需要 Nerd Font" },
				{ value: "ascii", label: "ASCII", description: "最大兼容性" },
			],
		},
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "色盲模式",
			description: "差异新增使用蓝色而非绿色",
		},
	},

	// Status line
	"statusLine.preset": {
		type: "enum",
		values: ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const,
		default: "default",
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "状态栏预设",
			description: "预构建的状态栏配置",
			options: [
				{ value: "default", label: "默认", description: "模型、路径、git、上下文、token、费用" },
				{ value: "minimal", label: "极简", description: "仅路径和 git" },
				{ value: "compact", label: "紧凑", description: "模型、git、费用、上下文" },
				{ value: "full", label: "完整", description: "包含时间在内的所有片段" },
				{ value: "nerd", label: "Nerd", description: "使用 Nerd Font 图标的最大信息量" },
				{ value: "ascii", label: "ASCII", description: "无特殊字符" },
				{ value: "custom", label: "自定义", description: "用户自定义片段" },
			],
		},
	},

	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		default: "powerline-thin",
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "状态栏分隔符",
			description: "片段之间分隔符的样式",
			options: [
				{ value: "powerline", label: "Powerline", description: "实心箭头(Nerd Font)" },
				{ value: "powerline-thin", label: "细箭头", description: "细箭头(Nerd Font)" },
				{ value: "slash", label: "斜线", description: "正斜线" },
				{ value: "pipe", label: "竖线", description: "竖线" },
				{ value: "block", label: "方块", description: "实心方块" },
				{ value: "none", label: "无", description: "仅空格" },
				{ value: "ascii", label: "ASCII", description: "大于号" },
			],
		},
	},

	"statusLine.sessionAccent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "会话强调色",
			description: "为编辑器边框和状态栏间隙使用会话名颜色",
		},
	},

	"statusLine.transparent": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "透明状态栏",
			description:
				"状态栏使用终端默认背景,而非主题的 `statusLineBg`。Powerline 端帽被丢弃,因为它们需要对比填充来衔接周围终端。",
		},
	},
	"statusLine.compactThinkingLevel": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "紧凑思考级别",
			description:
				"在模型名上以单个图标显示思考级别,而非单独的 ` · <level>` 后缀。",
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "产物溢出阈值 (KB)",
			description: "超过此大小的工具输出保存为产物;尾部保留在行内",
			options: [
				{ value: "1", label: "1 KB", description: "约 250 token" },
				{ value: "2.5", label: "2.5 KB", description: "约 625 token" },
				{ value: "5", label: "5 KB", description: "约 1.25K token" },
				{ value: "10", label: "10 KB", description: "约 2.5K token" },
				{ value: "20", label: "20 KB", description: "约 5K token" },
				{ value: "30", label: "30 KB", description: "约 7.5K token" },
				{ value: "50", label: "50 KB", description: "默认;约 12.5K token" },
				{ value: "75", label: "75 KB", description: "约 19K token" },
				{ value: "100", label: "100 KB", description: "约 25K token" },
				{ value: "200", label: "200 KB", description: "约 50K token" },
				{ value: "500", label: "500 KB", description: "约 125K token" },
				{ value: "1000", label: "1 MB", description: "约 250K token" },
			],
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "产物尾部保留大小 (KB)",
			description: "输出溢出为产物时保留在行内的尾部内容量",
			options: [
				{ value: "1", label: "1 KB", description: "约 250 token" },
				{ value: "2.5", label: "2.5 KB", description: "约 625 token" },
				{ value: "5", label: "5 KB", description: "约 1.25K token" },
				{ value: "10", label: "10 KB", description: "约 2.5K token" },
				{ value: "20", label: "20 KB", description: "默认;约 5K token" },
				{ value: "50", label: "50 KB", description: "约 12.5K token" },
				{ value: "100", label: "100 KB", description: "约 25K token" },
				{ value: "200", label: "200 KB", description: "约 50K token" },
			],
		},
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "产物头部保留大小 (KB)",
			description:
				"输出溢出为产物时,与尾部一起保留在行内的头部内容量(中间省略)。0 表示禁用 — 仅保留尾部。",
			options: [
				{ value: "0", label: "0 KB", description: "已禁用;仅保留尾部截断" },
				{ value: "1", label: "1 KB", description: "约 250 token" },
				{ value: "2.5", label: "2.5 KB", description: "约 625 token" },
				{ value: "5", label: "5 KB", description: "约 1.25K token" },
				{ value: "10", label: "10 KB", description: "约 2.5K token" },
				{ value: "20", label: "20 KB", description: "默认;约 5K token" },
				{ value: "50", label: "50 KB", description: "约 12.5K token" },
				{ value: "100", label: "100 KB", description: "约 25K token" },
				{ value: "200", label: "200 KB", description: "约 50K token" },
			],
		},
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "输出列数上限",
			description:
				"流式工具输出(bash、python、js eval)和 `read` 的每行字节上限。超过此宽度的行以省略号截断;到下一个换行符为止的剩余字节被丢弃。0 禁用。",
			options: [
				{ value: "0", label: "关闭", description: "无每行上限" },
				{ value: "256", label: "256", description: "紧凑" },
				{ value: "512", label: "512" },
				{ value: "768", label: "768", description: "默认" },
				{ value: "1024", label: "1024" },
				{ value: "2048", label: "2048" },
				{ value: "4096", label: "4096", description: "宽松" },
			],
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "产物尾部行数",
			description: "输出溢出为产物时保留在行内的尾部内容最大行数",
			options: [
				{ value: "50", label: "50 行", description: "约 250 token" },
				{ value: "100", label: "100 行", description: "约 500 token" },
				{ value: "250", label: "250 行", description: "约 1.25K token" },
				{ value: "500", label: "500 行", description: "默认;约 2.5K token" },
				{ value: "1000", label: "1000 行", description: "约 5K token" },
				{ value: "2000", label: "2000 行", description: "约 10K token" },
				{ value: "5000", label: "5000 行", description: "约 25K token" },
			],
		},
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "显示钩子状态",
			description: "在状态栏下方显示钩子状态消息",
		},
	},

	"statusLine.leftSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.rightSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },

	// Images and terminal
	"terminal.showImages": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "内联显示图片",
			description: "在终端内联渲染图片",
			condition: "hasImageProtocol",
		},
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "自动调整图片大小",
			description: "将大图缩放到最大 2000x2000,以获得更好的模型兼容性",
		},
	},

	"images.blockImages": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Images",
			label: "阻止图片",
			description: "阻止图片发送给 LLM 提供商",
		},
	},

	"images.describeForTextModels": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Vision",
			label: "为文本模型描述图片",
			description:
				"当图片附加到不支持视觉的模型时,将其保存到 local:// 下,并注入来自具备视觉能力模型的描述,而不是丢弃它",
		},
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
		description:
			"内联图片的最大宽度(终端列数,默认 100)。设为 0 则无限制(仅受终端宽度约束)。",
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
		description:
			"内联图片的最大高度(终端行数,默认 20)。设为 0 则仅使用基于视口的限制(终端高度的 60%)。",
	},

	"tui.maxInlineImages": {
		type: "number",
		default: 8,
		description:
			"作为活动终端图形保留的内联图片最大数量(默认 8)。超过限制后,较早的图片通过完整重绘回退为文本占位符。设为 0 则保留所有图片(无限制)。",
	},

	"terminal.showProgress": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "原生终端进度",
			description: "Agent 或上下文维护运行时发出 OSC 9;4 不确定进度",
		},
	},

	"tui.textSizing": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "大标题 (Kitty)",
			description:
				"使用 Kitty 的 OSC 66 文本尺寸协议以 2 倍尺寸渲染 Markdown H1 标题。仅在 Kitty 终端上生效;其他环境忽略。默认关闭。",
		},
	},

	"tui.renderMermaid": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "渲染 Mermaid 图表",
			description: "将 Mermaid 围栏代码块渲染为 ASCII 图表",
		},
	},

	"tui.codexResetFireworks": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Codex 重置烟花",
			description:
				"以占据顶部三分之一区域的烟花覆盖层庆祝计划外的 Codex 周用量重置和新存入的已保存重置,覆盖层持续到按下 Escape",
		},
	},

	"tui.titleState": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "终端标题运行状态",
			description:
				"在终端标题的分隔符中显示 Agent 运行状态 — 工作时为动画旋转指示器(Windows 上为静态 ':' ),轮到你是 '>',Agent 等待你时是 '!'",
		},
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "终端超链接",
			description:
				"将路径和 URL 包裹在 OSC 8 超链接中,实现终端原生的点击打开(auto:检测支持;off:从不;always:无条件)",
		},
	},
	"tui.tight": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "紧凑布局",
			description: "移除终端输出左右两侧的 1 字符水平内边距",
		},
	},
	"tui.scrollbackRebuild": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "重写回滚缓冲区",
			description:
				"当一个块的最终形态取代其实时预览时,擦除并重放终端回滚缓冲。关闭时(默认),过期的预览副本保留在历史中,最终内容追加在下方。",
		},
	},

	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "闪烁动画",
			description: "工作/加载消息的动画样式",
			options: [
				{ value: "classic", label: "经典", description: "柔和余弦波扫过文本" },
				{ value: "kitt", label: "KITT 扫描灯", description: "Knight Rider 1982 红灯左右弹跳" },
				{ value: "disabled", label: "已禁用", description: "无动画;静态弱化文本" },
			],
		},
	},

	"display.smoothStreaming": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "平滑流式显示",
			description: "分块到达时平滑显示助手文本和流式工具输入",
		},
	},

	"display.hideToolActivity": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "隐藏工具活动",
			description: "从记录中隐藏模型发起的工具调用及其结果",
		},
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "显示 token 用量",
			description: "在助手消息上显示每轮 token 用量",
		},
	},

	"display.cacheMissMarker": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "缓存未命中标记",
			description: "在请求未命中提示词缓存的助手轮次上方显示分隔线",
		},
	},

	"display.collapseCompacted": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "折叠压缩后的历史",
			description:
				"在实时记录中,将压缩前的历史折叠到摘要分隔线之后;关闭则在每个压缩点保留完整记录并带分隔线",
		},
	},

	showHardwareCursor: {
		type: "boolean",
		default: true, // will be computed based on platform if undefined
		ui: {
			tab: "appearance",
			group: "Display",
			label: "显示硬件光标",
			description: "为 IME 支持显示终端光标",
		},
	},

	"tui.imeSafeCursor": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "输入法安全提示布局",
			description: "将提示符的下边框移到单独一行,使 macOS IME 预编辑无法将其挤开",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	defaultThinkingLevel: {
		type: "enum",
		values: [...THINKING_EFFORTS, AUTO_THINKING],
		default: "high",
		ui: {
			tab: "model",
			group: "Thinking",
			label: "思考级别",
			description: "支持思考的模型的推理深度",
			options: [
				getConfiguredThinkingLevelMetadata(AUTO_THINKING),
				...THINKING_EFFORTS.map(getThinkingLevelMetadata),
			],
		},
	},

	hideThinkingBlock: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "隐藏思考块",
			description: "隐藏助手回复中的思考块",
		},
	},
	proseOnlyThinking: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "仅散文思考",
			description: "从思考摘要中省略代码块,并用省略号替换",
		},
	},

	omitThinking: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "省略思考摘要",
			description:
				"指示上游提供商完全省略回复中的思考摘要(在支持的情况下)",
		},
	},

	"model.loopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "循环保护",
			description: "启用模型推理与散文的自动流循环检测",
		},
	},

	"model.loopGuard.checkAssistantContent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "循环保护扫描散文",
			description: "除思考日志外,也对助手散文消息应用循环保护",
		},
	},

	"model.loopGuard.toolCallReminder": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "循环保护工具调用提醒",
			description:
				"当 Gemini 推理流连续发出多个规划头而未调用工具时,中断它并注入提醒,要求发出工具调用(需要循环保护)",
		},
	},

	"model.toolCallLoopGuard.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "工具调用循环保护",
			description: "检测跨轮次的连续相同工具调用并注入纠正性引导",
		},
	},

	"model.toolCallLoopGuard.threshold": {
		type: "number",
		default: 5,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "工具调用循环阈值",
			description: "注入纠正性引导前所需的连续相同工具调用次数",
		},
	},

	"model.toolCallLoopGuard.exemptTools": {
		type: "array",
		default: DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "工具调用循环豁免工具",
			description: "可连续重复而不会触发跨轮循环保护的工具名",
		},
	},

	inlineToolDescriptors: {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "内联工具描述",
			description:
				"在系统提示词中渲染完整工具描述符,并从提供商工具 schema 中剥离顶层/嵌套描述,使描述文本只发送一次。Auto 对 Gemini 模型启用,其他情况禁用",
			options: [
				{
					value: "auto",
					label: "自动",
					description: "为 Gemini 模型内联描述符;其他情况保留在工具 schema 中",
				},
				{ value: "on", label: "开启", description: "始终在系统提示词中内联描述符" },
				{ value: "off", label: "关闭", description: "仅将描述符保留在提供商工具 schema 中" },
			],
		},
	},

	includeModelInPrompt: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "在提示词中包含模型",
			description: "在系统提示词中展示当前模型标识符,让 Agent 知道自己是哪个模型",
		},
	},

	includeWorkspaceTree: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Prompt",
			label: "在提示词中包含工作区树",
			description:
				"在系统提示词中渲染工作区目录树。警告:文件被修改时,这会破坏跨会话的提示词缓存。",
		},
	},

	"workspace.additionalDirectories": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: "General",
			label: "附加工作区目录",
			description:
				"添加到每个会话作为附加根目录的额外工作区目录(多根工作区)。可通过 /add-dir 和 /remove-dir 实时管理。路径相对于 cwd 解析;建议使用绝对路径。Agent 会被告知这些根目录存在,并可对其 read/grep/glob。",
		},
	},

	personality: {
		type: "enum",
		values: ["default", "friendly", "pragmatic", "none"] as const,
		default: "default",
		ui: {
			tab: "model",
			group: "Prompt",
			label: "个性",
			description: "渲染进系统提示词个性块中的沟通风格",
			options: [
				{
					value: "default",
					label: "默认",
					description: "简洁、证据优先的工程师;密集、面向行动的回复",
				},
				{
					value: "friendly",
					label: "友好",
					description: "热情、鼓励的协作者,注重势头与士气",
				},
				{
					value: "pragmatic",
					label: "务实",
					description: "直接、高效的工程师,注重清晰与严谨",
				},
				{ value: "none", label: "无", description: "完全省略个性块" },
			],
		},
	},

	// Sampling
	temperature: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "温度",
			description: "采样温度 (0 = 确定性,1 = 创造性,-1 = 提供商默认)",
			options: [
				{ value: "-1", label: "默认", description: "使用提供商默认值" },
				{ value: "0", label: "0", description: "确定性" },
				{ value: "0.2", label: "0.2", description: "聚焦" },
				{ value: "0.5", label: "0.5", description: "均衡" },
				{ value: "0.7", label: "0.7", description: "创造性" },
				{ value: "1", label: "1", description: "最大多样性" },
			],
		},
	},

	topP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top P",
			description: "核采样截断 (0-1,-1 = 提供商默认)",
			options: [
				{ value: "-1", label: "默认", description: "使用提供商默认值" },
				{ value: "0.1", label: "0.1", description: "非常聚焦" },
				{ value: "0.3", label: "0.3", description: "聚焦" },
				{ value: "0.5", label: "0.5", description: "均衡" },
				{ value: "0.9", label: "0.9", description: "宽泛" },
				{ value: "1", label: "1", description: "无核采样过滤" },
			],
		},
	},

	topK: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Top K",
			description: "从 top-K token 中采样 (-1 = 提供商默认)",
			options: [
				{ value: "-1", label: "默认", description: "使用提供商默认值" },
				{ value: "1", label: "1", description: "贪心 top token" },
				{ value: "20", label: "20", description: "聚焦" },
				{ value: "40", label: "40", description: "均衡" },
				{ value: "100", label: "100", description: "宽泛" },
			],
		},
	},

	minP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "Min P",
			description: "最小概率阈值 (0-1,-1 = 提供商默认)",
			options: [
				{ value: "-1", label: "默认", description: "使用提供商默认值" },
				{ value: "0.01", label: "0.01", description: "非常宽松" },
				{ value: "0.05", label: "0.05", description: "均衡" },
				{ value: "0.1", label: "0.1", description: "严格" },
			],
		},
	},

	presencePenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "存在惩罚",
			description: "引入已存在 token 的惩罚 (-1 = 提供商默认)",
			options: [
				{ value: "-1", label: "默认", description: "使用提供商默认值" },
				{ value: "0", label: "0", description: "无惩罚" },
				{ value: "0.5", label: "0.5", description: "轻度新颖性" },
				{ value: "1", label: "1", description: "鼓励新颖性" },
				{ value: "2", label: "2", description: "强烈新颖性" },
			],
		},
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			group: "Sampling",
			label: "重复惩罚",
			description: "重复 token 的惩罚 (-1 = 提供商默认)",
			options: [
				{ value: "-1", label: "默认", description: "使用提供商默认值" },
				{ value: "0.8", label: "0.8", description: "允许重复" },
				{ value: "1", label: "1", description: "无惩罚" },
				{ value: "1.1", label: "1.1", description: "轻度惩罚" },
				{ value: "1.2", label: "1.2", description: "均衡" },
				{ value: "1.5", label: "1.5", description: "强烈惩罚" },
			],
		},
	},

	textVerbosity: {
		type: "enum",
		values: ["low", "medium", "high"] as const,
		default: "medium",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "文本详细程度",
			description: "OpenAI Responses 和 Codex 回复详细程度(低、中或高)",
			options: [
				{ value: "low", label: "低", description: "偏好简洁回复" },
				{ value: "medium", label: "中", description: "兼顾简洁与详细(默认)" },
				{ value: "high", label: "高", description: "偏好详细回复" },
			],
		},
	},

	"tier.openai": {
		type: "enum",
		values: SERVICE_TIER_OPENAI_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "服务等级 — OpenAI",
			description:
				"OpenAI / OpenAI-Codex 请求及经 OpenRouter 路由的 OpenAI 系模型的处理等级(none = 省略)。以 `service_tier` 发送。",
			options: SERVICE_TIER_OPENAI_OPTIONS,
		},
	},

	"tier.anthropic": {
		type: "enum",
		values: SERVICE_TIER_ANTHROPIC_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "服务等级 — Anthropic",
			description:
				'Claude 请求的处理等级。`priority` 在受支持的直接 Anthropic 模型上实现快速模式(`speed: "fast"`);在 Bedrock/Vertex Claude 及通过 OpenRouter 时被忽略。',
			options: SERVICE_TIER_ANTHROPIC_OPTIONS,
		},
	},

	"tier.google": {
		type: "enum",
		values: SERVICE_TIER_GOOGLE_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "服务等级 — Google",
			description:
				"Gemini(Google AI Studio + Vertex)请求及经 OpenRouter 路由的 Google 系模型的处理等级(none = 省略)。作为顶层 `serviceTier` 字段发送。",
			options: SERVICE_TIER_GOOGLE_OPTIONS,
		},
	},

	"tier.subagent": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "inherit",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "服务等级 — 子代理",
			description:
				"派生 task/eval 子代理的服务等级。Inherit = 匹配主 Agent 实时的按族等级(跟随 /fast);选择一个值则应用于子代理模型所属的任何族。",
			options: SERVICE_TIER_INHERIT_OPTIONS,
		},
	},

	"tier.advisor": {
		type: "enum",
		values: SERVICE_TIER_INHERIT_SETTING_VALUES,
		default: "none",
		ui: {
			tab: "model",
			group: "Sampling",
			label: "服务等级 — Advisor",
			description:
				"Advisor 模型的服务等级。None = 标准处理;Inherit = 匹配主 Agent 实时的按族等级;选择一个值则应用于 Advisor 模型所属的族。",
			options: SERVICE_TIER_INHERIT_OPTIONS,
			condition: "advisorEnabled",
		},
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "重试次数",
			description: "API 错误时的最大重试次数",
			options: [
				{ value: "1", label: "1 次重试" },
				{ value: "2", label: "2 次重试" },
				{ value: "3", label: "3 次重试" },
				{ value: "5", label: "5 次重试" },
				{ value: "10", label: "10 次重试" },
			],
		},
	},

	"retry.baseDelayMs": { type: "number", default: 500 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "最大重试延迟",
			description:
				"重试之间的最大等待时间(毫秒)。当提供商要求等待超过此时间且没有凭证或模型回退成功时,请求快速失败而非长时间睡眠(例如 3 小时的 Anthropic 速率限制窗口)。",
		},
	},
	"retry.modelFallback": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "重试模型回退",
			description: "允许重试恢复切换到已配置的回退模型",
		},
	},
	"retry.usageAwareFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "用量感知回退",
			description:
				"使用可靠的 coding-plan 配额报告,在达到硬用量上限前优先选择同提供商的账户,然后是已配置的回退模型。普通的已配置 API 密钥被排除。",
		},
	},
	"retry.usageReservePct": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "保留余量",
			description:
				"当剩余百分比低于此值时,将 coding-plan 模型视为接近上限。未知或未映射的用量保持主模型不变。",
			condition: "usageAwareFallbackEnabled",
			options: [
				{ value: "5", label: "5%", description: "仅在几乎用尽时启用" },
				{ value: "10", label: "10%", description: "均衡的安全余量" },
				{ value: "15", label: "15%", description: "保守" },
				{ value: "20", label: "20%", description: "早期保护" },
				{ value: "25", label: "25%", description: "非常保守" },
			],
		},
	},
	"retry.usageReservePolicy": {
		type: "enum",
		values: ["confirm", "auto", "fail-closed"] as const,
		default: "confirm",
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "保留策略",
			description: "当同一提供商的所有 coding-plan 账户都在保留余量内时该怎么办。",
			condition: "usageAwareFallbackEnabled",
			options: [
				{
					value: "confirm",
					label: "交互式确认",
					description: "保持交互会话在主模型上直到确认;后台 Agent 自动回退",
				},
				{
					value: "auto",
					label: "自动回退",
					description: "始终选择下一个符合条件的已配置回退",
				},
				{
					value: "fail-closed",
					label: "拒绝放行",
					description: "不消耗保留额度,也不选择回退",
				},
			],
		},
	},
	"retry.fallbackChains": {
		type: "record",
		default: {} as Record<string, string[]>,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "重试回退链",
			description:
				'JSON 对象,将模型角色、模型选择器("provider/model-id")或提供商通配符("provider/*")映射到有序的回退选择器,例如 {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}。模型导向的键在对应模型/提供商激活时生效,与角色无关;"provider/*" 条目保留失败模型的 id 并更换提供商。带 id 前缀的通配符("openrouter/google/*")会重新为失败模型的裸 id 加前缀(google-antigravity/gemini-x -> openrouter/google/gemini-x),用作键时仅匹配该提供商前缀下的 id。',
		},
	},
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "回退还原策略",
			description: "回退后何时返回主模型",
			options: [
				{
					value: "cooldown-expiry",
					label: "冷却期结束",
					description: "抑制窗口结束后返回主模型",
				},
				{ value: "never", label: "从不", description: "保持使用回退模型,直到手动更改" },
			],
		},
	},

	"providers.anthropic.serverSideFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			group: "Retry & Fallback",
			label: "Anthropic 服务端回退 (Fable 5)",
			description:
				"当 Claude Fable 5 / Mythos 5 请求被 Anthropic 的安全分类器阻止时,在 Claude Opus 4.8 上于服务端重试(Anthropic `server-side-fallback-2026-06-01` beta)。选择加入 — 保持关闭可为每个请求保留回退前的行为。",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Interaction
	// ────────────────────────────────────────────────────────────────────────

	// Conversation flow
	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "转向模式",
			description: "Agent 工作时如何处理排队消息",
		},
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "后续消息模式",
			description: "一轮完成后如何排空后续消息",
		},
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "中断模式",
			description: "转向消息何时中断工具执行",
		},
	},

	"loop.mode": {
		type: "enum",
		values: ["prompt", "compact", "reset"] as const,
		default: "prompt",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "循环模式",
			description: "重新提交提示词前,/loop 迭代之间发生什么",
			options: [
				{
					value: "prompt",
					label: "提示词",
					description: "将提示词作为后续消息重新提交(当前行为)",
				},
				{
					value: "compact",
					label: "紧凑",
					description: "压缩会话上下文,然后重新提交提示词",
				},
				{ value: "reset", label: "重置", description: "开始新会话,然后重新提交提示词" },
			],
		},
	},

	// Input and startup
	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "tree",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "双击 Esc 行为",
			description: "编辑器为空时按两次 Esc 触发的操作",
		},
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "会话树筛选",
			description: "打开会话树时的默认筛选模式",
		},
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 5,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "自动补全项数",
			description: "自动补全下拉菜单的最大可见项数 (3-20)",
			options: [
				{ value: "3", label: "3 项" },
				{ value: "5", label: "5 项" },
				{ value: "7", label: "7 项" },
				{ value: "10", label: "10 项" },
				{ value: "15", label: "15 项" },
				{ value: "20", label: "20 项" },
			],
		},
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Emoji 自动补全",
			description: "根据 `:name:` 短代码建议 emoji,并展开 `:D` 或 `:-)` 等文本表情",
		},
	},

	"paste.largeMenuThreshold": {
		type: "number",
		default: 100,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "大粘贴菜单",
			description:
				"当粘贴内容达到这么多行时,提供菜单:用代码块包裹、用 XML 标签包裹,或保存到文件。0 禁用该菜单(大粘贴仍折叠为 [Paste] 标记)。",
			options: [
				{ value: "0", label: "关闭" },
				{ value: "100", label: "100 行" },
				{ value: "250", label: "250 行" },
				{ value: "500", label: "500 行" },
				{ value: "1000", label: "1000 行" },
			],
		},
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "静默启动",
			description: "跳过欢迎界面和启动状态消息",
		},
	},

	"startup.showSplash": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "显示启动画面",
			description:
				"在正常交互式启动时显示完整的动画设置启动画面,而不重新运行设置。静默启动仍会抑制它。",
		},
	},

	"startup.setupWizard": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "设置向导",
			description: "每个设置版本显示一次新增的引导步骤",
		},
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "检查更新",
			description: "启动时检查 omp 更新",
		},
	},

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "notify",
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "市场自动更新",
			description: "启动时检查插件更新",
			options: [
				{ value: "off", label: "关闭", description: "不检查插件更新" },
				{ value: "notify", label: "通知", description: "启动时检查,有更新时通知" },
				{ value: "auto", label: "自动", description: "启动时检查并自动安装更新" },
			],
		},
	},

	"startup.changelogMode": {
		type: "enum",
		values: ["summary", "expanded", "hidden"] as const,
		default: "summary",
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "启动变更日志",
			description: "选择更新说明以摘要、完整详情开始,或保持隐藏",
			options: [
				{
					value: "summary",
					label: "摘要",
					description: "显示发布与变更数量,并提示 /changelog",
				},
				{
					value: "expanded",
					label: "展开",
					description: "完整显示最近的发布说明",
				},
				{
					value: "hidden",
					label: "隐藏",
					description: "启动时不显示发布说明",
				},
			],
		},
	},

	"magicKeywords.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "魔法关键词",
			description: "为独立的 ultrathink、orchestrate 和 workflowz 关键词启用隐藏提示",
		},
	},

	"magicKeywords.ultrathink": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Ultrathink 关键词",
			description: "允许独立的 ultrathink 请求最大自动思考并附加其隐藏提示",
		},
	},

	"magicKeywords.orchestrate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Orchestrate 关键词",
			description: "允许独立的 orchestrate 附加其隐藏的多 Agent 编排提示",
		},
	},

	"magicKeywords.workflow": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Workflow 关键词",
			description: "允许独立的 workflowz 附加其隐藏的 eval 工作流提示",
		},
	},

	// Notifications
	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "完成通知",
			description: "Agent 完成一轮时通知",
		},
	},

	"error.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "off",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "错误通知",
			description: "Agent 因错误停止时通知",
		},
	},

	"ask.timeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "询问超时",
			description: "经过这么多秒后自动选择推荐的 ask 选项(0 表示禁用)",
			options: [
				{ value: "0", label: "已禁用" },
				{ value: "15", label: "15 秒" },
				{ value: "30", label: "30 秒" },
				{ value: "60", label: "60 秒" },
				{ value: "120", label: "120 秒" },
			],
		},
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "询问通知",
			description: "ask 工具等待输入时通知",
		},
	},

	"recap.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "空闲回顾",
			description: "终端空闲后,生成一份简要 LLM 回顾,说明当前进展",
		},
	},

	"recap.idleSeconds": {
		type: "number",
		default: 240,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "空闲回顾延迟",
			description: "空闲后显示回顾前等待的秒数",
			options: [
				{ value: "60", label: "1 分钟" },
				{ value: "120", label: "2 分钟" },
				{ value: "240", label: "4 分钟" },
				{ value: "300", label: "5 分钟" },
				{ value: "600", label: "10 分钟" },
			],
		},
	},

	// Collab
	"collab.relayUrl": {
		type: "string",
		default: DEFAULT_RELAY_URL,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "中继 URL",
			description: "/collab 使用的中继 (wss://host[:port])",
		},
	},

	"collab.webUrl": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Web UI URL",
			description:
				"/collab 链接使用的浏览器 UI;留空则从 collab.relayUrl 推导;显式 http:// 仅限 localhost",
		},
	},

	"collab.displayName": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "显示名称",
			description: "向其他协作参与者显示的名称(默认:OS 用户名)",
		},
	},

	"share.serverUrl": {
		type: "string",
		default: DEFAULT_SHARE_URL,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "分享服务器",
			description:
				"/share 使用的分享查看器/上传基础地址(加密 blob 上传+查看器;链接为 <base>/<id>#<key>)",
		},
	},

	"share.store": {
		type: "enum",
		values: ["blob", "gist"] as const,
		default: "blob",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "分享存储",
			description: "/share 将加密会话 blob 上传到哪里",
			options: [
				{
					value: "blob",
					label: "加密 Blob",
					description: "上传到分享服务器(无需 GitHub 账户;避开 gist API 速率限制)",
				},
				{
					value: "gist",
					label: "GitHub Gist",
					description: "推送到私有 gist(需要已认证的 gh),回退到分享服务器",
				},
			],
		},
	},

	"share.redactSecrets": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "分享密钥脱敏",
			description: "上传前对 /share 快照运行密钥混淆器(使用 secrets.* 配置)",
		},
	},

	// Speech-to-text
	"stt.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "语音转文字",
			description: "启用通过麦克风的语音转文字输入",
		},
	},

	"stt.language": {
		type: "string",
		default: "en",
	},

	"stt.modelName": {
		type: "enum",
		values: STT_MODEL_VALUES,
		default: DEFAULT_STT_MODEL_KEY,
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "语音模型",
			description:
				"本地设备端语音模型。Parakeet TDT v3 (sherpa-onnx) 是当前最优默认;Whisper base/small/large-v3-turbo 各档(transformers.js)以大小为代价换取多语言覆盖。首次使用时下载。",
			options: STT_MODEL_OPTIONS,
		},
	},
	"stt.submitTrigger": {
		type: "enum",
		values: STT_SUBMIT_TRIGGER_VALUES,
		default: "never",
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "语音转文字提交触发",
			description:
				"选择语音听写自动提交的时机:从不、松手(2 个词以上)、松手且句子完整,或当我说“提交”。",
			options: STT_SUBMIT_TRIGGER_OPTIONS,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Context
	// ────────────────────────────────────────────────────────────────────────

	// Context promotion
	"contextPromotion.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "自动提升上下文",
			description: "上下文溢出时提升到更大上下文的模型,而非压缩",
		},
	},

	// Compaction
	"compaction.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "自动压缩",
			description: "上下文过大时自动压缩",
		},
	},

	"compaction.midTurnEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "轮次中压缩",
			description: "在下一次提供商请求前,于安全的轮次中工具循环边界检查阈值",
		},
	},

	"compaction.strategy": {
		type: "enum",
		values: ["context-full", "handoff", "shake", "snapcompact", "off"] as const,
		default: "snapcompact",
		ui: {
			tab: "context",
			group: "Compaction",
			label: "压缩策略",
			description:
				"选择就地 context-full 维护、自动交接、外科式 shake(丢弃重型内容)、snapcompact(将历史归档为高密度图片),或禁用自动维护(off)",
			options: [
				{
					value: "context-full",
					label: "上下文占满",
					description: "就地总结并保留当前会话",
				},
				{ value: "handoff", label: "交接", description: "生成交接文档并在新会话中继续" },
				{
					value: "shake",
					label: "Shake",
					description: "就地丢弃重型内容(工具结果+大块内容);可通过产物恢复",
				},
				{
					value: "snapcompact",
					label: "Snapcompact",
					description: "将历史归档为模型可读回的高密度位图;无需 LLM 调用",
				},
				{
					value: "off",
					label: "关闭",
					description: "禁用自动上下文维护(与关闭自动压缩行为相同)",
				},
			],
		},
	},

	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "压缩阈值",
			description: "上下文维护的百分比阈值;设为默认以使用基于保留空间的传统行为",
			options: [
				{ value: "default", label: "默认", description: "基于保留空间的传统阈值" },
				{ value: "10", label: "10%", description: "极早维护" },
				{ value: "20", label: "20%", description: "很早维护" },
				{ value: "30", label: "30%", description: "早期维护" },
				{ value: "40", label: "40%", description: "适度提前维护" },
				{ value: "50", label: "50%", description: "中点" },
				{ value: "60", label: "60%", description: "适中的上下文用量" },
				{ value: "70", label: "70%", description: "均衡" },
				{ value: "75", label: "75%", description: "略激进" },
				{ value: "80", label: "80%", description: "典型阈值" },
				{ value: "85", label: "85%", description: "激进的上下文用量" },
				{ value: "90", label: "90%", description: "非常激进" },
				{ value: "95", label: "95%", description: "接近上下文上限" },
			],
		},
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "压缩 token 上限",
			description: "上下文维护的固定 token 上限;设置后覆盖百分比",
			options: [
				{ value: "default", label: "默认", description: "使用基于百分比的阈值" },
				{ value: "25000", label: "25K token", description: "200K 窗口的四分之一" },
				{ value: "50000", label: "50K token", description: "200K 窗口的一半" },
				{ value: "100000", label: "100K token", description: "200K 窗口的一半" },
				{ value: "150000", label: "150K token", description: "200K 窗口的四分之三" },
				{ value: "200000", label: "200K token", description: "完整标准上下文窗口" },
				{ value: "300000", label: "300K token", description: "大上下文窗口" },
				{ value: "500000", label: "500K token", description: "非常大的上下文窗口" },
			],
		},
	},

	"compaction.handoffSaveToDisk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "保存交接文档",
			description: "为自动交接流程将生成的交接文档保存为 markdown 文件",
		},
	},

	"compaction.remoteEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "远程压缩",
			description: "可用时使用远程压缩端点,而非本地总结",
		},
	},

	"compaction.remoteStreamingV2Enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "远程压缩 V2",
			description: "为兼容的远程压缩模型使用 Responses 流式压缩",
		},
	},

	// No default: an unset reserve tells the compaction layer the user never
	// chose one, so small-window recovery may swap in the proportional reserve
	// (see resolveBudgetReserveTokens). A materialized 16384 here would make
	// every session look explicitly configured.
	"compaction.reserveTokens": { type: "number", default: undefined },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	"compaction.v2RetainedMessageBudget": { type: "number", default: 64000 },

	// Idle compaction
	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "空闲压缩",
			description: "空闲时若 token 数超过阈值则压缩上下文",
		},
	},

	"compaction.idleThresholdTokens": {
		type: "number",
		default: 200000,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "空闲压缩阈值",
			description: "空闲压缩触发的 token 数阈值",
			options: [
				{ value: "100000", label: "100K token" },
				{ value: "200000", label: "200K token" },
				{ value: "300000", label: "300K token" },
				{ value: "400000", label: "400K token" },
				{ value: "500000", label: "500K token" },
				{ value: "600000", label: "600K token" },
				{ value: "700000", label: "700K token" },
				{ value: "800000", label: "800K token" },
				{ value: "900000", label: "900K token" },
			],
		},
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "空闲压缩延迟",
			description: "空闲后压缩前等待的秒数",
			options: [
				{ value: "60", label: "1 分钟" },
				{ value: "120", label: "2 分钟" },
				{ value: "300", label: "5 分钟" },
				{ value: "600", label: "10 分钟" },
				{ value: "1800", label: "30 分钟" },
				{ value: "3600", label: "1 小时" },
			],
		},
	},

	"compaction.supersedeReads": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "淘汰过期读取",
			description: "同一文件再次被读取时修剪较旧的读取结果(缓存感知,每轮运行)",
		},
	},

	"compaction.dropUseless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "省略无事件结果",
			description:
				"消费后修剪被标记为上下文无用的工具结果(无匹配、超时等待)(缓存感知)",
		},
	},

	// Experimental: snapcompact inline imaging (transient, per-request; never persisted)
	"snapcompact.systemPrompt": {
		type: "enum",
		values: ["none", "agents-md", "all"] as const,
		default: "none",
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Snapcompact 系统提示词",
			description:
				"实验性:将选定的系统提示词文本渲染为高密度 PNG 图片并附加到第一条用户消息(仅限视觉模型)。节省 token;但被成像的文本失去提示词缓存。",
			options: [
				{ value: "none", label: "无", description: "将系统提示词保留为文本。" },
				{
					value: "agents-md",
					label: "AGENTS.md",
					description: "仅在节省 token 时,将已加载上下文文件的指令移动到图片。",
				},
				{
					value: "all",
					label: "全部",
					description: "在节省 token 时,将完整系统提示词移动到图片。",
				},
			],
		},
	},

	"snapcompact.toolResults": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Snapcompact 工具结果",
			description:
				"实验性:将大量历史工具结果渲染为高密度 PNG 图片而非文本(仅限视觉模型)。可节省累积 read/search 输出的 token。",
		},
	},

	"tools.format": {
		type: "enum",
		values: [
			"auto",
			"native",
			"glm",
			"hermes",
			"kimi",
			"xml",
			"anthropic",
			"deepseek",
			"harmony",
			"qwen3",
			"gemini",
			"gemma",
			"minimax",
		] as const,
		default: "auto",
		ui: {
			tab: "context",
			group: "Experimental",
			label: "工具调用模式",
			description:
				"控制工具如何暴露给模型。Auto 使用提供商原生工具调用,除非所选模型被标记为不支持,此时回退到 GLM 自有方言。Native 强制使用提供商原生工具;其他值强制使用指定的自有方言。会话开始时生效。",
			options: [
				{
					value: "auto",
					label: "自动",
					description: "使用原生工具调用,除非已知模型不支持。",
				},
				{ value: "native", label: "原生", description: "使用提供商原生工具调用。" },
				{ value: "glm", label: "GLM", description: "使用 GLM 风格带内工具调用。" },
				{ value: "hermes", label: "Hermes", description: "使用 Hermes 风格带内工具调用。" },
				{ value: "kimi", label: "Kimi", description: "使用 Kimi 风格带内工具调用。" },
				{ value: "xml", label: "XML", description: "使用通用 XML 带内工具调用。" },
				{ value: "anthropic", label: "Anthropic", description: "使用 Anthropic 风格带内工具调用。" },
				{ value: "deepseek", label: "DeepSeek", description: "使用 DeepSeek 风格带内工具调用。" },
				{ value: "harmony", label: "Harmony", description: "使用 Harmony 风格带内工具调用。" },
				{ value: "qwen3", label: "Qwen3", description: "使用 Qwen3 自有方言。" },
				{ value: "gemini", label: "Gemini", description: "使用 Gemini 自有方言。" },
				{ value: "gemma", label: "Gemma", description: "使用 Gemma 自有方言。" },
				{ value: "minimax", label: "MiniMax", description: "使用 MiniMax 自有方言。" },
			],
		},
	},

	"snapcompact.shape": {
		type: "enum",
		values: ["auto", ...SHAPE_VARIANT_NAMES] as const,
		default: "auto",
		ui: {
			tab: "context",
			group: "Experimental",
			label: "Snapcompact 形状",
			description:
				"snapcompact 打印文本所用的画框形状(压缩归档和内联成像)。Auto 为当前模型选择调优过的形状。",
			options: [
				{
					value: "auto",
					label: "自动",
					description: "选择为当前模型调优的形状,回退到其提供商家族。",
				},
				{
					value: "8x8r-bw",
					label: "8x8 重复,黑色",
					description:
						"unscii 方形单元格,黑色墨水,每行打印两次,副本位于淡色高亮带上。",
				},
				{
					value: "8x8r-sent",
					label: "8x8 重复,句子色相",
					description: "重复网格,墨水在句子边界循环六种色相。",
				},
				{
					value: "8x8u-bw",
					label: "8x8,黑色",
					description: "普通 unscii 方形单元格,单次打印行,黑色墨水。",
				},
				{
					value: "8x8u-sent",
					label: "8x8,句子色相",
					description: "普通 unscii 方形单元格,句子色相墨水。",
				},
				{
					value: "6x6u-bw",
					label: "6x6 密集,黑色",
					description: "unscii 压缩到 6x6 — 最密集的可读单元格,帧数最少 — 黑色墨水。",
				},
				{
					value: "6x6u-sent",
					label: "6x6 密集,句子色相",
					description: "最密集的单元格,带句子色相墨水。",
				},
				{
					value: "5x8-bw",
					label: "5x8 传统,黑色",
					description: "2576px 画布上的原始 X.org 5x8 字形,黑色墨水。",
				},
				{
					value: "5x8-sent",
					label: "5x8 传统,句子色相",
					description: "原始 snapcompact 形状(形状表之前的会话以此渲染)。",
				},
				{
					value: "6x12-dim",
					label: "6x12,停用词变暗",
					description: "X.org 6x12 字形,黑色墨水,功能词变暗为灰色。",
				},
				{
					value: "8x13-bw",
					label: "8x13,黑色",
					description: "X.org 8x13 字形,黑色墨水。",
				},
				{
					value: "8on16-bw",
					label: "8x13,16px 间距,黑色",
					description: "8x13 字形位于 8x16 单元格(额外行距),黑色墨水。",
				},
				{
					value: "8on22-bw",
					label: "8x13,22px 间距(带行距),黑色",
					description:
						"8x22 单元格上的 8x13 字形 — 额外行距,避免行拥挤。OpenAI/Google 的默认。",
				},
				{
					value: "11on16-bw",
					label: "8x13,11px 字距(带字距),黑色",
					description:
						"11x16 单元格上的 8x13 字形 — 额外字距,避免字符粘连。Anthropic 的默认。",
				},
				{
					value: "silver16-bw",
					label: "Silver 16,CJK",
					description: "用于 CJK 及其他非拉丁文本的嵌入式 Silver TrueType 字体,16px 网格。",
				},
				{
					value: "doc-8on16-bw",
					label: "Doc 8on16,黑色",
					description: "16px 间距上两栏自动换行的报纸式 8x13 字形,黑色墨水。",
				},
				{
					value: "doc-8on16-sent",
					label: "Doc 8on16,句子色相",
					description: "双栏文档布局,句子色相墨水。",
				},
				{
					value: "doc-8on16-sent-dim",
					label: "Doc 8on16,句子色相+停用词变暗",
					description: "双栏文档布局,句子色相墨水,功能词变暗为灰色。",
				},
			],
		},
	},

	// Branch summaries
	"branchSummary.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			group: "General",
			label: "分支摘要",
			description: "离开分支时提示总结",
		},
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	// Memories
	// Legacy local-memory enable flag kept only for back-compat migration.
	// Hidden from UI — users should use `memory.backend` instead.
	"memories.enabled": {
		type: "boolean",
		default: false,
	},

	"memories.maxRolloutsPerStartup": { type: "number", default: 64 },

	"memories.maxRolloutAgeDays": { type: "number", default: 30 },

	"memories.minRolloutIdleHours": { type: "number", default: 12 },

	"memories.threadScanLimit": { type: "number", default: 300 },

	"memories.maxRawMemoriesForGlobal": { type: "number", default: 200 },

	"memories.stage1Concurrency": { type: "number", default: 8 },

	"memories.stage1LeaseSeconds": { type: "number", default: 120 },

	"memories.stage1RetryDelaySeconds": { type: "number", default: 120 },

	"memories.phase2LeaseSeconds": { type: "number", default: 180 },

	"memories.phase2RetryDelaySeconds": { type: "number", default: 180 },

	"memories.phase2HeartbeatSeconds": { type: "number", default: 30 },

	"memories.rolloutPayloadPercent": { type: "number", default: 0.7 },

	"memories.phase1InputTokenLimit": { type: "number", default: 4000 },

	"memories.fallbackTokenLimit": { type: "number", default: 16000 },

	"memories.summaryInjectionTokenLimit": { type: "number", default: 5000 },

	// Memory backend selector — picks between local memories pipeline,
	// Mnemopi local SQLite, Hindsight remote memory, or off. The legacy
	// `memories.enabled` flag is migration input only; see config/settings.ts.
	"memory.backend": {
		type: "enum",
		values: ["off", "local", "hindsight", "mnemopi"] as const,
		default: "off",
		ui: {
			tab: "memory",
			group: "General",
			label: "记忆后端",
			description: "关闭、本地摘要管线、Mnemopi SQLite 或 Hindsight 远程记忆",
			options: [
				{ value: "off", label: "关闭", description: "不运行任何记忆子系统" },
				{ value: "local", label: "本地", description: "本地滚动摘要管线(memory_summary.md)" },
				{ value: "hindsight", label: "Hindsight", description: "向量化 Hindsight 远程记忆服务" },
				{
					value: "mnemopi",
					label: "Mnemopi",
					description: "本地 SQLite 回忆/保留后端,可选嵌入",
				},
			],
		},
	},

	// Auto-Learn (experimental): post-stop nudge to capture lessons to memory
	// and mint/enhance isolated managed skills under ~/.omp/agent/managed-skills.
	// Master flag is default-off → zero footprint; sub-flags gate behaviour.
	"autolearn.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Auto-Learn",
			label: "自动学习(实验性)",
			description:
				"Agent 停止后,引导它将经验教训存入记忆,并创建/增强隔离的受管技能",
		},
	},
	"autolearn.autoContinue": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Auto-Learn",
			label: "停止时自动运行捕获",
			description:
				"开启时,在停止时自动运行一次私有捕获轮次(消耗额外 token)。关闭时,仅保留常驻的自动学习指引。",
			condition: "autolearnActive",
		},
	},
	// Config-file-only knob (numbers without `options` are hidden from the UI).
	"autolearn.minToolCalls": { type: "number", default: 5 },

	// Mnemopi local SQLite memory backend.
	"mnemopi.dbPath": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 数据库路径",
			description: "可选 SQLite 数据库路径。默认为 Agent 记忆目录。",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.bank": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 记忆库",
			description: "可选共享记忆库基础名。按项目模式从中派生项目本地记忆库。",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 作用域",
			description:
				"global = 一个共享记忆库;per-project = 每个 cwd 一个隔离记忆库;per-project-tagged = 项目本地写入加全局回忆可见性",
			options: [
				{
					value: "global",
					label: "全局",
					description: "每个项目共用一个 Mnemopi 记忆库",
				},
				{
					value: "per-project",
					label: "按项目",
					description: "按 cwd 基名划分的项目本地 Mnemopi 记忆库",
				},
				{
					value: "per-project-tagged",
					label: "按项目(带标签)",
					description: "写入项目本地记忆库,但合并项目+共享回忆结果",
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingVariant": {
		type: "enum",
		values: ["en", "multilingual"] as const,
		default: "en",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "嵌入变体",
			description:
				"本地嵌入模型家族。en = 更强的英文模型;multilingual = 跨语言模型。更改后会在下次启动时重建现有记忆嵌入。",
			options: [
				{
					value: "en",
					label: "英文(bge-base-en-v1.5)",
					description: "BAAI/bge-base-en-v1.5 (768d),仅英文",
				},
				{
					value: "multilingual",
					label: "多语言(multilingual-e5-large)",
					description: "intfloat/multilingual-e5-large (1024d),跨语言回忆",
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 自动回忆",
			description: "将本地记忆回忆到每个会话的第一轮",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 自动保留",
			description: "将完成的对话轮次保留到本地 Mnemopi 记忆",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.polyphonicRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 多声部回忆",
			description: "启用 4 声道回忆(向量、图谱、事实、时间),使用互惠排名融合",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.enhancedRecall": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 增强回忆",
			description: "为重复和相似的回忆查询启用分层查询结果缓存",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.proactiveLinking": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 主动链接",
			description:
				"在存储新记忆时将其摄入情景图谱,链接到相关实体和记忆",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.noEmbeddings": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 禁用嵌入",
			description: "强制确定性的仅 FTS 回忆,而非向量嵌入",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 嵌入模型",
			description:
				"高级:显式指定嵌入模型 id,覆盖变体设置。留空以使用 mnemopi.embeddingVariant。",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 嵌入 API URL",
			description: "传递给 Mnemopi 的可选 OpenAI 兼容嵌入端点",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiKey": {
		type: "string",
		credential: true,
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi 嵌入 API 密钥",
			description: "传递给 Mnemopi 的可选嵌入 API 密钥",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmMode": {
		type: "enum",
		values: ["none", "smol", "remote"] as const,
		default: "smol",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM 模式",
			description:
				"不使用 LLM,使用在线微型模型(/models 中的 TINY 角色,否则 @smol),或远程 OpenAI 兼容端点",
			condition: "mnemopiActive",
			options: [
				{ value: "none", label: "无", description: "禁用 Mnemopi 基于 LLM 的抽取" },
				{
					value: "smol",
					label: "在线(tiny)",
					description: "使用在线微型模型(/models 中的 TINY 角色,否则 @smol)",
				},
				{ value: "remote", label: "远程", description: "使用下方 Mnemopi 远程 LLM 设置" },
			],
		},
	},
	"mnemopi.llmBaseUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM 基础 URL",
			description: "Mnemopi 远程模式的可选 OpenAI 兼容 LLM 端点",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmApiKey": {
		type: "string",
		credential: true,
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM API 密钥",
			description: "Mnemopi 远程模式的可选 LLM API 密钥",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM 模型",
			description: "Mnemopi 远程模式的可选 LLM 模型名",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.retainEveryNTurns": { type: "number", default: 4 },
	"mnemopi.recallLimit": { type: "number", default: 8 },
	"mnemopi.recallContextTurns": { type: "number", default: 3 },
	"mnemopi.recallMaxQueryChars": { type: "number", default: 4000 },
	"mnemopi.injectionTokenLimit": { type: "number", default: 5000 },
	"mnemopi.debug": { type: "boolean", default: false },

	// Hindsight (https://hindsight.vectorize.io)
	"hindsight.apiUrl": {
		type: "string",
		default: "http://localhost:8888",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight API URL",
			description: "Hindsight 服务器 URL(云或自托管)",
			condition: "hindsightActive",
		},
	},

	"hindsight.apiToken": {
		type: "string",
		credential: true,
		default: undefined,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight API 令牌",
			description: "用于需要认证的 Hindsight 服务器的 Bearer token",
			condition: "hindsightActive",
		},
	},

	"hindsight.bankId": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight 记忆库 ID",
			description: "记忆库标识符(默认:项目名)",
			condition: "hindsightActive",
		},
	},

	"hindsight.bankIdPrefix": { type: "string", default: undefined },
	"hindsight.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project-tagged",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight 作用域",
			description:
				"global = 一个共享记忆库;per-project = 每个 cwd 一个隔离记忆库;per-project-tagged = 带项目标签的共享记忆库,回忆时全局+项目记忆合并",
			options: [
				{
					value: "global",
					label: "全局",
					description: "共用一个记忆库 — 每个项目看到相同的记忆",
				},
				{
					value: "per-project",
					label: "按项目",
					description: "按 cwd 基名隔离记忆库 — 各项目无法看到彼此的记忆",
				},
				{
					value: "per-project-tagged",
					label: "按项目(带标签)",
					description:
						"共享记忆库,保留项带 project:<cwd> 标签。回忆时项目与未打标签的全局记忆一起呈现",
				},
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.bankMission": { type: "string", default: undefined },
	"hindsight.retainMission": { type: "string", default: undefined },

	"hindsight.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight 自动回忆",
			description: "在每个会话的第一轮回忆记忆",
			condition: "hindsightActive",
		},
	},
	"hindsight.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight 自动保留",
			description: "每 N 轮及会话边界保留记录",
			condition: "hindsightActive",
		},
	},

	"hindsight.retainMode": {
		type: "enum",
		values: ["full-session", "last-turn"] as const,
		default: "full-session",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight 保留模式",
			description: "full-session = 每会话 upsert 一份文档,last-turn = 分块",
			options: [
				{
					value: "full-session",
					label: "完整会话",
					description: "每个会话 upsert 一份文档(推荐)",
				},
				{ value: "last-turn", label: "仅上一轮", description: "按轮次边界切分的分块保留" },
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.retainEveryNTurns": { type: "number", default: 3 },
	"hindsight.retainOverlapTurns": { type: "number", default: 2 },
	"hindsight.retainContext": { type: "string", default: "omp" },

	"hindsight.recallBudget": {
		type: "enum",
		values: ["low", "mid", "high"] as const,
		default: "mid",
	},
	"hindsight.recallMaxTokens": { type: "number", default: 1024 },
	"hindsight.recallContextTurns": { type: "number", default: 1 },
	"hindsight.recallMaxQueryChars": { type: "number", default: 800 },
	"hindsight.recallTypes": { type: "array", default: HINDSIGHT_RECALL_TYPES_DEFAULT },

	"hindsight.debug": { type: "boolean", default: false },

	"hindsight.requestTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.reflectTimeoutMs": { type: "number", default: 120_000 },
	"hindsight.recallTimeoutMs": { type: "number", default: 30_000 },
	"hindsight.retainTimeoutMs": { type: "number", default: 60_000 },

	"hindsight.mentalModelsEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight 心智模型",
			description:
				"启动时将精选的 reflect 摘要(心智模型)读入开发者指令。只读取记忆库上已有的模型 — 不写入。配合 hindsight.mentalModelAutoSeed 可同时自动创建内置种子集。",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelAutoSeed": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight 心智模型自动播种",
			description:
				"会话开始时,在记忆库上创建尚不存在的内置心智模型(project-conventions、project-decisions、user-preferences)。",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelRefreshIntervalMs": { type: "number", default: 5 * 60 * 1000 },
	"hindsight.mentalModelMaxRenderChars": { type: "number", default: 16_000 },

	// TTSR
	"ttsr.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR",
			description: "输出匹配规则模式时在流中中断 Agent(Time-Traveling Stream Rules)",
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR 上下文模式",
			description: "TTSR 触发时如何处理部分输出",
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR 中断模式",
			description: "何时在流中中断,而非完成后注入警告",
			options: [
				{ value: "always", label: "总是", description: "在散文和工具流上中断" },
				{ value: "prose-only", label: "仅散文", description: "仅在回复/思考匹配时中断" },
				{ value: "tool-only", label: "仅工具", description: "仅在工具调用参数匹配时中断" },
				{ value: "never", label: "从不", description: "从不中断;完成后注入警告" },
			],
		},
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR 重复模式",
			description: "规则如何重复:每会话一次或消息间隔之后",
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "TTSR 重复间隔",
			description: "规则可再次触发前的消息数",
			options: [
				{ value: "5", label: "5 条消息" },
				{ value: "10", label: "10 条消息" },
				{ value: "15", label: "15 条消息" },
				{ value: "20", label: "20 条消息" },
				{ value: "30", label: "30 条消息" },
			],
		},
	},

	"ttsr.builtinRules": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "内置规则",
			description: "加载 Agent 自带的默认规则(可通过 ttsr.disabledRules 单独覆盖)",
		},
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			group: "Rules (TTSR)",
			label: "禁用的规则",
			description: "完全忽略的规则名(适用于内置默认规则和你自己的规则)",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Editing
	// ────────────────────────────────────────────────────────────────────────

	// Edit tool
	"edit.mode": {
		type: "enum",
		values: EDIT_MODES,
		default: "hashline",
		ui: {
			tab: "files",
			group: "Editing",
			label: "编辑模式",
			description: "选择编辑工具变体(replace、patch、hashline 或 apply_patch)",
		},
	},

	"edit.fuzzyMatch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Editing",
			label: "模糊匹配",
			description: "接受仅存在空白差异的高置信度模糊匹配",
		},
	},

	"edit.fuzzyThreshold": {
		type: "number",
		default: 0.95,
		ui: {
			tab: "files",
			group: "Editing",
			label: "模糊匹配阈值",
			description: "接受模糊匹配的相似度阈值 (0-1)",
			options: [
				{ value: "0.85", label: "0.85", description: "宽松" },
				{ value: "0.90", label: "0.90", description: "适中" },
				{ value: "0.95", label: "0.95", description: "默认" },
				{ value: "0.98", label: "0.98", description: "严格" },
			],
		},
	},

	"edit.streamingAbort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Editing",
			label: "预览失败时中止",
			description: "补丁预览失败时中止流式编辑工具调用",
		},
	},

	"edit.blockAutoGenerated": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Editing",
			label: "阻止自动生成的文件",
			description: "阻止编辑看似自动生成的文件(protoc、sqlc、swagger 等)",
		},
	},

	"edit.enforceSeenLines": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Editing",
			label: "强制已见行保护",
			description: "拒绝以先前 read/search 从未完整显示的行作为锚点的编辑",
		},
	},

	readLineNumbers: {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "行号",
			description: "默认在 read 工具输出前加行号",
		},
	},

	"read.defaultLimit": {
		type: "number",
		default: 300,
		ui: {
			tab: "files",
			group: "Reading",
			label: "默认读取限制",
			description: "Agent 调用 read 且未指定限制时返回的默认行数",
			options: [
				{ value: "200", label: "200 行" },
				{ value: "300", label: "300 行" },
				{ value: "500", label: "500 行" },
				{ value: "1000", label: "1000 行" },
				{ value: "5000", label: "5000 行" },
			],
		},
	},

	"read.renderMarkdown": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "Markdown 预览",
			description: "将 Markdown 读取结果渲染为格式化的终端 Markdown 预览,而非原始源码",
		},
	},

	"read.summarize.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "读取摘要",
			description: "read 未指定明确选择器调用时返回结构化代码摘要",
		},
	},

	"read.summarize.prose": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "散文摘要",
			description: "为 Markdown 和纯文本读取返回结构化摘要",
		},
	},

	"read.summarize.minBodyLines": {
		type: "number",
		default: 4,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "读取摘要正文行数",
			description: "读取摘要折叠多行正文或字面量前的最小长度",
		},
	},

	"read.summarize.minCommentLines": {
		type: "number",
		default: 6,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "读取摘要注释行数",
			description: "读取摘要折叠多行块注释前的最小长度",
		},
	},

	"read.summarize.minTotalLines": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "读取摘要最小文件长度",
			description: "总行数较少的文件被原样读取,而非结构化摘要",
		},
	},

	"read.summarize.unfoldUntil": {
		type: "number",
		default: 50,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "读取摘要展开目标",
			description:
				"BFS 展开可省略片段,直到摘要至少达到这么多可见行。0 仅保留最外层的省略。",
		},
	},

	"read.summarize.unfoldLimit": {
		type: "number",
		default: 100,
		ui: {
			tab: "files",
			group: "Read Summaries",
			label: "读取摘要展开上限",
			description:
				"BFS 展开时摘要大小的硬上限。展开后行数会超过此值的片段被跳过(该片段保持折叠),继续展开其余片段。",
		},
	},

	"read.toolResultPreview": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "Reading",
			label: "内联读取预览",
			description: "将 read 工具结果在记录中内联渲染,而非摘要行",
		},
	},

	// LSP
	"lsp.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "LSP",
			description: "启用 lsp 工具获取代码智能(定义、引用、诊断、重命名)",
		},
	},

	"lsp.lazy": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "延迟 LSP 启动",
			description:
				"在首次使用(lsp 工具或编辑匹配的文件类型)时启动语言服务器,而非在会话启动时",
		},
	},

	"lsp.shared": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "共享语言服务器",
			description:
				"通过守护进程代理在多个 omp 实例间共享每个项目一个语言服务器(不可用时回退为私有服务器)",
		},
	},

	"lsp.formatOnWrite": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "LSP",
			label: "写入时格式化",
			description: "写入后使用 LSP 自动格式化代码文件",
		},
	},

	"lsp.diagnosticsOnWrite": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "写入时诊断",
			description: "写入代码文件后返回 LSP 诊断",
		},
	},

	"lsp.diagnosticsOnEdit": {
		type: "boolean",
		default: false,
		ui: {
			tab: "files",
			group: "LSP",
			label: "编辑时诊断",
			description: "编辑代码文件后返回 LSP 诊断",
		},
	},

	"lsp.diagnosticsDeduplicate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "files",
			group: "LSP",
			label: "诊断去重",
			description: "抑制已为该文件显示过的编辑后 LSP 诊断;仅呈现新增或变化的诊断",
		},
	},

	"bash.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash",
			description: "启用 bash 工具执行 shell 命令",
		},
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash 自动后台化",
			description: "自动将长时间运行的 bash 命令转入后台,稍后交付结果",
		},
	},
	"bash.patterns": {
		type: "array",
		default: [],
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash 审批规则",
			description:
				"有序的 bash 命令审批规则。每项包含 match 和 approval 字段;仅支持 '*' 通配符。",
		},
	},

	// Bash interceptor
	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Bash 拦截器",
			description: "拦截拥有专用工具的 shell 命令",
		},
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

	"bash.direnv": {
		type: "enum",
		values: ["auto", "off"] as const,
		default: "auto",
		ui: {
			tab: "shell",
			group: "Bash",
			label: "direnv 自动加载",
			description:
				"将仓库的 direnv/devenv `.envrc` 自动加载到 bash 会话,无需手动 `direnv exec` 即可获得 devenv 工具和环境变量。遵循 direnv 的允许列表:未 `direnv allow` 的 `.envrc` 绝不执行",
		},
	},
	"bash.direnvLoadTimeoutMs": {
		type: "number",
		default: 30_000,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "direnv 加载超时 (ms)",
			description:
				"等待首次 `direnv export` 的最大时长(冷启动的 devenv shell 可能很慢);超时后会话在不带 direnv 环境的情况下运行",
		},
	},
	// Shell output minimizer
	"shellMinimizer.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Shell 输出压缩器",
			description: "在返回给 Agent 之前压缩冗长的 shell 输出(git、npm、cargo 等)",
		},
	},
	"shellMinimizer.settingsPath": {
		type: "string",
		default: undefined,
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
	},
	"shellMinimizer.sourceOutlineLevel": {
		type: "enum",
		values: ["default", "aggressive"] as const,
		default: "default",
		ui: {
			tab: "shell",
			group: "Bash",
			label: "Shell 压缩器源码大纲",
			description: "cat/read 源码文件的源码大纲模式:default 或 aggressive",
		},
	},
	"shellMinimizer.legacyFilters": {
		type: "boolean",
		default: undefined,
	},

	// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
	"eval.py": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Python 计算后端",
			description: "允许 eval 工具将 Python 单元派发到 IPython 内核",
		},
	},

	"eval.js": {
		type: "boolean",
		default: true,
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "JavaScript 计算后端",
			description: "允许 eval 工具将 JavaScript 单元派发到进程内运行时",
		},
	},

	"eval.rb": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Ruby 计算后端",
			description: "允许 eval 工具将 Ruby 单元派发到持久化 Ruby 内核",
		},
	},

	"eval.jl": {
		type: "boolean",
		default: false,
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Julia 计算后端",
			description: "允许 eval 工具将 Julia 单元派发到持久化 Julia 内核",
		},
	},

	// Runtime knobs (consumed by eval backends and the /python slash command)
	"python.kernelMode": {
		type: "enum",
		values: ["session", "per-call"] as const,
		default: "session",
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Python 内核模式",
			description: "在多次 eval 调用间保持 IPython 内核存活,或每次都重新启动",
		},
	},
	"python.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Python 解释器",
			description:
				"指向确切 Python 可执行文件的可选路径。设置后,自动 Python 运行时发现将被跳过。",
		},
	},
	"ruby.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Ruby 解释器",
			description:
				"指向确切 Ruby 可执行文件的可选路径。设置后,自动 Ruby 运行时发现将被跳过。",
		},
	},
	"julia.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "shell",
			group: "Eval & Runtimes",
			label: "Julia 解释器",
			description:
				"指向确切 Julia 可执行文件的可选路径。设置后,自动 Julia 运行时发现将被跳过。",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Tool approval policies
	"tools.approval": {
		type: "record",
		default: {},
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "工具审批策略",
			description:
				"逐工具审批策略。设为 'allow' 自动批准、'prompt' 要求确认、'deny' 阻止。覆盖项在每种审批模式下都生效。",
		},
	},

	// Default tool approval mode (interaction tab, but governs the tool wrapper).
	//   "always-ask" — auto-approves read-tier tools only; prompts for write/exec.
	//   "write"      — auto-approves read and write-tier tools; prompts for exec.
	//   "yolo"       — auto-approves every tier.
	"tools.approvalMode": {
		type: "enum",
		values: ["always-ask", "write", "yolo"] as const,
		default: "yolo",
		ui: {
			tab: "interaction",
			group: "Approvals",
			label: "工具审批",
			description:
				"工具调用的默认批准行为。'总是询问' 仅自动批准只读工具。'写入' 自动批准读取和工作区写入工具。'Yolo' 自动批准所有层级;用户策略仍可提示或阻止。",
			options: [
				{
					value: "always-ask",
					label: "总是询问",
					description: "自动批准只读工具;写入和执行工具需要确认。",
				},
				{
					value: "write",
					label: "写入",
					description:
						"自动批准只读和写入工具;bash、eval、browser、task 等执行工具需要确认。",
				},
				{
					value: "yolo",
					label: "Yolo",
					description:
						"自动批准读取、写入和执行工具。用户策略仍可要求确认或阻止调用。",
				},
			],
		},
	},

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "任务列表",
			description: "启用 todo 工具进行任务跟踪",
		},
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "任务提醒",
			description: "提醒 Agent 在停止前完成任务",
		},
	},

	"todo.remindersMax": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "任务提醒上限",
			description: "放弃前任务提醒的最大次数",
			options: [
				{ value: "1", label: "1 次提醒" },
				{ value: "2", label: "2 次提醒" },
				{ value: "3", label: "3 次提醒" },
				{ value: "5", label: "5 次提醒" },
			],
		},
	},

	"todo.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tools",
			group: "Todos",
			label: "自动创建任务列表",
			description: "第一条消息后推动自动创建任务列表的力度",
			options: [
				{ value: "default", label: "默认", description: "由模型决定;不自动创建任务列表" },
				{
					value: "preferred",
					label: "优先",
					description: "在第一条消息上建议任务列表(提醒,非强制)",
				},
				{ value: "always", label: "总是", description: "在第一条消息上强制生成完整的任务列表" },
			],
		},
	},

	// Grep, glob, and AST tools
	"glob.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Glob",
			description: "启用 glob 工具进行基于 glob 的文件查找",
		},
	},

	"grep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Grep",
			description: "启用 grep 工具进行正则内容搜索",
		},
	},

	"grep.contextBefore": {
		type: "number",
		default: 1,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Grep 前文上下文",
			description: "每个 grep 匹配前的上下文行数",
			options: [
				{ value: "0", label: "0 行" },
				{ value: "1", label: "1 行" },
				{ value: "2", label: "2 行" },
				{ value: "3", label: "3 行" },
				{ value: "5", label: "5 行" },
			],
		},
	},

	"grep.contextAfter": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "Grep 后文上下文",
			description: "每个 grep 匹配后的上下文行数",
			options: [
				{ value: "0", label: "0 行" },
				{ value: "1", label: "1 行" },
				{ value: "2", label: "2 行" },
				{ value: "3", label: "3 行" },
				{ value: "5", label: "5 行" },
				{ value: "10", label: "10 行" },
			],
		},
	},

	"astGrep.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "AST Grep",
			description: "启用 ast_grep 工具进行结构化 AST 搜索",
		},
	},

	"astEdit.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "AST Edit",
			description: "启用 ast_edit 工具进行结构化 AST 重写",
		},
	},

	// Optional tools

	"debug.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Debug",
			description: "启用 debug 工具进行基于 DAP 的调试",
		},
	},

	"launch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Launch",
			description: "启用 launch 工具监督共享的长时间运行项目进程",
		},
	},

	"speechgen.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "语音生成",
			description: "启用 tts 工具进行设备端(Kokoro)或 xAI Grok Voice 语音文件合成",
		},
	},
	"generate_image.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "生成图片",
			description:
				"启用 generate_image 工具(文生图与图片编辑)。tools.xdev 开启时作为 xd:// 设备暴露。",
		},
	},

	// Legacy boolean kept only for back-compat migration to `inspect_image.mode`
	// (see config/settings.ts). Hidden from UI.
	"inspect_image.enabled": {
		type: "boolean",
		default: false,
	},

	"inspect_image.mode": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "检查图片",
			description:
				"控制 inspect_image 工具,它将图像理解委托给具备视觉能力的模型。'auto' 仅当当前模型缺少原生图像输入时暴露;'on' 始终暴露;'off' 永不暴露。",
			options: [
				{ value: "auto", label: "自动(仅无视觉模型时)" },
				{ value: "on", label: "开启" },
				{ value: "off", label: "关闭" },
			],
		},
	},

	"computer.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "计算机",
			description: "启用可脚本化的主机桌面控制工具(截图、输入、辅助功能)",
		},
	},

	"computer.display": {
		type: "string",
		default: "all",
		ui: {
			tab: "tools",
			group: "Computer",
			label: "计算机显示器",
			description: "合成所有显示器,或选择原生显示器 id",
		},
	},

	"computer.maxWidth": {
		type: "number",
		default: 3840,
		ui: {
			tab: "tools",
			group: "Computer",
			label: "计算机截图宽度",
			description: "最大合成截图宽度(像素)",
		},
	},

	"computer.maxHeight": {
		type: "number",
		default: 2400,
		ui: {
			tab: "tools",
			group: "Computer",
			label: "计算机截图高度",
			description: "最大合成截图高度(像素)",
		},
	},

	"inspect_image.timeoutMs": {
		type: "number",
		default: 300_000,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "检查图片超时",
			description:
				"inspect_image 视觉模型调用的每次请求超时(毫秒)。停滞的提供商会以超时错误快速失败,而不是阻塞直到手动中止。设为 0 禁用超时。",
			options: [
				{ value: "0", label: "已禁用" },
				{ value: "60000", label: "1 分钟" },
				{ value: "120000", label: "2 分钟" },
				{ value: "180000", label: "3 分钟" },
				{ value: "300000", label: "5 分钟" },
			],
		},
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "检查点/回退",
			description: "启用 checkpoint 和 rewind 工具进行上下文检查点",
		},
	},

	// Fetching and browser
	"fetch.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "读取 URL",
			description: "允许 read 工具获取并处理 URL",
		},
	},

	"vault.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Obsidian 仓库",
			description:
				"启用 vault:// 内部 URL,通过 Obsidian CLI 读取和编辑 Obsidian 仓库内容。禁用后,vault:// 解析被拒绝,且 vault:// 条目从系统提示词中省略。",
		},
	},

	"github.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "GitHub CLI",
			description:
				"启用 github 工具(基于 op 派发仓库、issue、拉取请求、差异、搜索、检出、推送和 Actions 监听工作流)",
		},
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub 视图缓存",
			description: "将渲染后的 issue/PR 视图输出缓存在 ~/.omp/cache/github-cache.db,重复读取零成本",
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub 缓存软 TTL",
			description:
				"在此窗口内,缓存的 issue/PR 视图行直接返回(秒;默认 5 分钟)",
		},
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
		ui: {
			tab: "tools",
			group: "GitHub",
			label: "GitHub 缓存硬 TTL",
			description:
				"超过软 TTL 后,缓存行被返回并在后台刷新;超过硬 TTL 后被丢弃(秒;默认 7 天)",
		},
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "网络搜索",
			description: "启用 web_search 工具获取实时网络结果",
		},
	},

	"security.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Security",
			description:
				"启用 OMP 原生的安全扫描规划、执行,以及只读的 security:// 资源命名空间",
		},
	},

	"ask.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Ask",
			description: "启用 ask 工具进行交互式用户提问",
		},
	},

	"browser.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Available Tools",
			label: "Browser",
			description: "启用 browser 工具进行脚本化 Chromium 自动化(puppeteer)",
		},
	},

	"browser.cdpUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "浏览器 CDP URL",
			description:
				"默认的 HTTP CDP 发现端点(例如 http://127.0.0.1:9222),用于附加到现有浏览器而非启动新浏览器。工具调用上显式的 app.cdp_url 或 app.path 优先。",
		},
	},

	"browser.relay": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "浏览器中继",
			description:
				"通过 omp 浏览器中继驱动你自己的 Chrome 标签页。安装一次扩展(`omp-zh browser-relay install`);browser 工具需要时中继服务器自动启动。优先于浏览器 CDP URL;设置 PI_BROWSER_RELAY=0 或 PI_BROWSER_RELAY=1 可覆盖。",
		},
	},

	"browser.relayUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "浏览器中继 URL",
			description: "omp 浏览器中继端点(默认 http://127.0.0.1:9224)。",
		},
	},

	"browser.headless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "无头浏览器",
			description: "以无头模式启动浏览器(关闭以显示浏览器 UI)",
		},
	},

	"browser.cmux": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "cmux 浏览器",
			description:
				"有 cmux socket 可用时,使用 cmux WKWebView 表面进行浏览器自动化。设置 PI_BROWSER_CMUX=0 或 PI_BROWSER_CMUX=1 可覆盖。",
		},
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			group: "Grep & Browser",
			label: "截图目录",
			description:
				"保存截图的目录。未设置时截图保存到临时文件。支持 ~。示例:~/Downloads、~/Desktop、/sdcard/Download (Android)",
		},
	},

	// Tool execution
	"tools.intentTracing": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "意图追踪",
			description: "执行前要求 Agent 描述每个工具调用的意图",
		},
	},
	"tools.abortOnFabricatedResult": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "伪造工具结果时中止",
			description:
				"使用带内工具调用时,当模型在轮次中途开始臆造工具结果时立即停止。关闭则让模型完成生成,并丢弃臆造的后续内容。",
		},
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "最大工具超时",
			description: "Agent 可为任何工具设置的最大超时秒数 (0 = 无限制)",
			options: [
				{ value: "0", label: "不限" },
				{ value: "30", label: "30 秒" },
				{ value: "60", label: "60 秒" },
				{ value: "120", label: "120 秒" },
				{ value: "300", label: "5 分钟" },
				{ value: "600", label: "10 分钟" },
			],
		},
	},

	// Async jobs
	"async.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "异步执行",
			description: "启用异步 bash 命令和后台任务执行",
		},
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m", "smart"] as const,
		default: "smart",
		ui: {
			tab: "tools",
			group: "Execution",
			label: "最大轮询时间",
			description:
				"`hub` 等待在返回当前状态前监视后台作业的时长。固定值每次都等待完全相同的时间。`smart` 自适应:从 5s 开始,每次连续等待都会延长(最长 5m),停止等待约一分钟后重置为 5s。",
			options: [
				{ value: "5s", label: "5 秒" },
				{ value: "10s", label: "10 秒" },
				{ value: "30s", label: "30 秒" },
				{ value: "1m", label: "1 分钟" },
				{ value: "5m", label: "5 分钟" },
				{ value: "smart", label: "智能", description: "默认 — 自适应 5s→5m,停止轮询时重置" },
			],
		},
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
		ui: {
			tab: "tools",
			group: "Execution",
			label: "IRC 超时",
			description:
				"hub 消息等待(以及 send await:true)的默认超时(毫秒);0 禁用超时",
			options: [
				{ value: "0", label: "已禁用" },
				{ value: "30000", label: "30 秒" },
				{ value: "60000", label: "1 分钟" },
				{ value: "120000", label: "2 分钟" },
				{ value: "300000", label: "5 分钟" },
			],
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	"tools.xdev": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// 工具",
			description:
				"将很少使用(可发现)的工具挂载到 xd:// 设备 URL 下,通过 read/write 驱动,而不是在每次请求中携带它们的 schema。未授予 write 工具的会话跳过挂载,并在顶层暴露所有工具。关闭后所有已启用工具都在顶层暴露。",
		},
	},

	"tools.xdevDocs": {
		type: "enum",
		values: ["inline", "builtins", "catalog"] as const,
		default: "builtins",
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// 提示词文档",
			description:
				"选择哪些已挂载设备的文档和 schema 内联进系统提示词。Built-ins 保持核心工具内联,而 MCP 和扩展工具按需获取。",
			options: [
				{ value: "inline", label: "全部设备", description: "内联每个已挂载设备的文档和 schema。" },
				{
					value: "builtins",
					label: "仅内置",
					description: "内联内置文档;按需获取 MCP 和扩展文档。",
				},
				{ value: "catalog", label: "仅目录", description: "列出每个设备;按需获取所有文档。" },
			],
		},
	},

	"tools.xdevInlineDevices": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "xd:// 内联设备",
			description:
				"当 xd:// 提示词文档为仅内置时,内联名称匹配这些 glob 模式的动态设备(例如 mcp__context_mode_*)。仅目录时忽略此设置。",
		},
	},

	// MCP
	"mcp.enableProjectConfig": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP 项目配置",
			description: "从项目根目录加载 .mcp.json/mcp.json",
		},
	},

	"mcp.renderMarkdownResults": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP Markdown 结果",
			description: "将非 JSON 的 MCP 文本结果在记录中渲染为 Markdown",
		},
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP 更新注入",
			description: "将 MCP 资源更新注入 Agent 对话",
		},
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: "Discovery & MCP",
			label: "MCP 通知防抖",
			description:
				"在将 MCP 资源更新注入对话前的防抖窗口(毫秒)",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tasks
	// ────────────────────────────────────────────────────────────────────────

	// Plan mode
	"plan.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "计划模式",
			description: "启用计划模式,在执行前进行只读探索与规划",
		},
	},

	"plan.defaultOnStartup": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "以计划模式启动",
			description: "每个新会话开始时自动进入计划模式",
			condition: "planModeEnabled",
		},
	},

	"goal.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "目标模式",
			description: "启用每会话目标模式和隐藏的目标工具",
		},
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "页脚显示目标状态",
			description: "在状态栏的目标指示旁显示 token 预算",
		},
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "目标延续模式",
			description: "允许活跃目标在轮次间自动继续的运行模式",
		},
	},

	"title.refreshOnReplan": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Modes",
			label: "重新规划时刷新标题",
			description: "todo 初始化重新规划后刷新生成的会话标题,除非标题由用户设置",
		},
	},

	// Delegation
	"task.isolation.mode": {
		type: "enum",
		values: [
			"none",
			"auto",
			"apfs",
			"btrfs",
			"zfs",
			"reflink",
			"overlayfs",
			"projfs",
			"block-clone",
			"rcopy",
		] as const,
		default: "none",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "隔离模式",
			description:
				'子代理的隔离后端。"auto" 让原生 PAL 选择最佳可用后端(支持 CoW 的文件系统,然后是 overlayfs/ProjFS,再是 git worktree / 递归复制回退)。',
			options: [
				{ value: "none", label: "无", description: "无隔离" },
				{ value: "auto", label: "自动", description: "让 PAL 选择最佳可用后端" },
				{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
				{ value: "btrfs", label: "btrfs", description: "btrfs 子卷快照" },
				{ value: "zfs", label: "ZFS", description: "ZFS 快照 + 克隆" },
				{ value: "reflink", label: "Reflink", description: "Linux FICLONE 逐文件 reflink" },
				{
					value: "overlayfs",
					label: "Overlayfs",
					description: "Linux 内核 overlay(或 fuse-overlayfs 回退)",
				},
				{ value: "projfs", label: "ProjFS", description: "Windows Projected File System" },
				{
					value: "block-clone",
					label: "块克隆",
					description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
				},
				{
					value: "rcopy",
					label: "递归复制",
					description: "可用时使用 git worktree,否则递归复制",
				},
			],
		},
	},

	"task.isolation.apply": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "应用隔离更改",
			description:
				"自动将成功的隔离任务更改应用到父工作区;关闭以保留补丁或分支产物",
		},
	},

	"task.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "隔离合并策略",
			description: "隔离任务变更如何集成(补丁应用或分支合并)",
			options: [
				{ value: "patch", label: "补丁", description: "合并差异并执行 git apply" },
				{ value: "branch", label: "分支", description: "每个任务一次提交,使用 --no-ff 合并" },
			],
		},
	},

	"task.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "隔离提交风格",
			description: "嵌套仓库变更的提交信息风格(通用或 AI 生成)",
			options: [
				{ value: "generic", label: "通用", description: "静态提交信息" },
				{ value: "ai", label: "AI", description: "根据差异由 AI 生成提交信息" },
			],
		},
	},

	"worktree.base": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tasks",
			group: "Isolation",
			label: "工作树基础目录",
			description:
				"Agent 管理工作树的基础目录 — task 隔离副本、`github` PR 检出和 `omp-zh worktree` 清理都在这里。未设置时使用 ~/.omp/wt。必须是绝对路径或以 ~ 开头的路径;相对路径会被忽略。OMP_WORKTREE_DIR 环境变量可覆盖此项。",
		},
	},

	"task.eager": {
		type: "enum",
		values: ["default", "preferred", "always"] as const,
		default: "default",
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "优先任务委派",
			description: "推动向子代理委派工作的力度",
			options: [
				{ value: "default", label: "默认", description: "由模型决定何时委派" },
				{ value: "preferred", label: "优先", description: "在系统提示词中加入委派指引" },
				{ value: "always", label: "总是", description: "提示词指引外加首轮委派提醒" },
			],
		},
	},

	"task.batch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "批量任务调用",
			description:
				"将 task 工具切换为批量形态:一次调用携带 { context, tasks[] } — 每项一个子代理,支持可选的逐项 agent(默认会话派生策略 agent)、逐项隔离,以及前置到每个任务的必要共享上下文。async.enabled=true 时,每次派生作为独立后台 Agent 运行,遵循常规空闲/暂停生命周期;否则调用阻塞等待合并结果。关闭以恢复扁平的单派生 schema。",
		},
	},

	"task.enableEffort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "每次任务力度",
			description:
				"在 task 派生时暴露可选的 effort 参数,允许调用方覆盖每个子代理的思考级别",
		},
	},

	"task.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "最大并发任务数",
			description: "并发运行的子代理最大数量",
			options: [
				{ value: "0", label: "不限" },
				{ value: "1", label: "1 个任务" },
				{ value: "2", label: "2 个任务" },
				{ value: "4", label: "4 个任务" },
				{ value: "8", label: "8 个任务" },
				{ value: "16", label: "16 个任务" },
				{ value: "32", label: "32 个任务" },
				{ value: "64", label: "64 个任务" },
			],
		},
	},

	"task.enableLsp": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "子代理中的 LSP",
			description:
				"允许通过 task 工具派生的子代理使用 lsp 工具。默认关闭以降低子代理成本;当感知 LSP 的委派值得额外 token 时启用。",
		},
	},

	"task.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "最大任务递归深度",
			description: "子代理可以再派生自己的子代理的深度层级",
			options: [
				{ value: "-1", label: "不限" },
				{ value: "0", label: "无" },
				{ value: "1", label: "单层" },
				{ value: "2", label: "两层" },
				{ value: "3", label: "三层" },
			],
		},
	},

	"task.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "最大子代理运行时间",
			description:
				"每个子代理的硬性墙钟时限(毫秒)。0 表示禁用。对逃过推理层看门狗的提供商侧流挂起提供纵深防御;触发带 'timed out' 原因的常规子代理中止。",
			options: [
				{ value: "0", label: "不限", description: "默认" },
				{ value: "300000", label: "5 分钟" },
				{ value: "900000", label: "15 分钟" },
				{ value: "1800000", label: "30 分钟" },
				{ value: "3600000", label: "1 小时" },
			],
		},
	},

	"task.agentIdleTtlMs": {
		type: "number",
		default: 420_000,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "Agent 空闲 TTL",
			description:
				"空闲子代理在被暂停到磁盘前在内存中保持活跃的时长(毫秒)。已暂停的 Agent 在收到消息或恢复时自动唤醒。0 保持空闲 Agent 活跃直到退出。",
		},
	},

	"task.softRequestBudget": {
		type: "number",
		default: 200,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "子代理软请求预算",
			description:
				"每个子代理的软请求预算(每次运行的助手请求数)。超过后注入收尾引导通知(见 task.softRequestBudgetNotice);达到预算的 1.5 倍时运行被强制停止,Agent 必须提交其部分结果。0 禁用该防护。内置 scout/sonic Agent 有更低的固定预算上限,因此低于该上限的值对它们仍然适用。",
			options: [
				{ value: "0", label: "已禁用" },
				{ value: "90", label: "90 次请求" },
				{ value: "150", label: "150 次请求" },
				{ value: "200", label: "200 次请求", description: "默认" },
			],
		},
	},

	"task.softRequestBudgetNotice": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "软请求预算通知",
			description:
				"当子代理超过其软请求预算时注入一条收尾引导通知,要求它在 1.5 倍强制结束之前收尾。",
		},
	},

	"task.maxEffort": {
		type: "enum",
		values: THINKING_EFFORTS,
		default: "max",
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "每次生成最大力度",
			description:
				"task 工具每次派生 effort 提示允许的最大推理力度。较低的值可防止调用方将子代理提升到此上限以上;默认保留模型的完整范围。",
			options: THINKING_EFFORTS.map(getThinkingLevelMetadata),
		},
	},

	"task.disabledAgents": {
		type: "array",
		default: [] as string[],
	},

	"task.agentModelOverrides": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"task.agentPrewalk": {
		type: "record",
		default: {} as Record<string, string>,
	},
	"task.prewalk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			group: "Subagents",
			label: "通用任务 Prewalk",
			description:
				"为内置的通用 `task` 子代理启用 prewalk:它先在解析出的模型上启动、规划并开始实现,然后在第一次编辑/写入时移交给 'smol' 角色。逐 Agent 覆盖(task.agentPrewalk,在 /agents 中用 P 切换)和用户 Agent 的 `prewalk` frontmatter 无论此开关如何都生效。",
		},
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
		ui: {
			tab: "tools",
			group: "Todos",
			label: "任务自动清除延迟",
			description: "已完成或放弃的任务从任务组件移除前的延迟",
			options: [
				{ value: "0", label: "立即" },
				{ value: "60", label: "1 分钟", description: "默认" },
				{ value: "300", label: "5 分钟" },
				{ value: "900", label: "15 分钟" },
				{ value: "1800", label: "30 分钟" },
				{ value: "3600", label: "1 小时" },
				{ value: "-1", label: "从不" },
			],
		},
	},

	"task.showResolvedModelBadge": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "显示解析后的模型徽章",
			description: "在任务组件状态栏中显示每个子代理实际使用的模型 ID",
		},
	},

	// Skills
	"skills.enabled": { type: "boolean", default: true },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "技能命令",
			description: "将技能注册为 /skill:name 命令",
		},
	},

	"skills.enableCodexUser": { type: "boolean", default: true },

	"skills.enableClaudeUser": { type: "boolean", default: true },

	"skills.enableClaudeProject": { type: "boolean", default: true },

	"skills.enablePiUser": { type: "boolean", default: true },

	"skills.enablePiProject": { type: "boolean", default: true },

	"skills.enableAgentsUser": { type: "boolean", default: true },

	"skills.enableAgentsProject": { type: "boolean", default: true },

	"skills.customDirectories": { type: "array", default: [] as string[] },

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

	// Commands
	"commands.enableClaudeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude 用户命令",
			description: "从 ~/.claude/commands/ 加载命令",
		},
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "Claude 项目命令",
			description: "从 .claude/commands/ 加载命令",
		},
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode 用户命令",
			description: "从 ~/.config/opencode/commands/ 加载命令",
		},
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			group: "Commands & Skills",
			label: "OpenCode 项目命令",
			description: "从 .opencode/commands/ 加载命令",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Providers
	// ────────────────────────────────────────────────────────────────────────

	// Secret handling
	"secrets.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Privacy",
			label: "隐藏密钥",
			description: "发送给 AI 提供商前混淆已配置的密钥,并脱敏形似凭证的 token",
		},
	},

	// Provider selection
	"providers.ollama-cloud.maxConcurrency": {
		type: "number",
		default: 3,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Ollama Cloud 最大并发",
			description:
				"每个进程的最大并发 Ollama Cloud 子代理运行数;0 禁用该提供商特定限制",
		},
	},
	"providers.webSearchOrder": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "网络搜索提供商顺序",
			description:
				"web_search 工具的优先提供商;未列出的提供商之后保留其默认顺序",
			options: SEARCH_PROVIDER_CHOICES,
			ordered: true,
		},
	},
	"providers.webSearchExclude": {
		type: "array",
		default: [] as SearchProviderId[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "排除的网络搜索提供商",
			description: "web_search 绝不使用的提供商,即使作为回退",
			options: SEARCH_PROVIDER_CHOICES,
		},
	},
	"providers.webSearchTimeoutSeconds": {
		type: "number",
		default: DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
		ui: {
			tab: "providers",
			group: "Services",
			label: "网络搜索超时",
			description: `web_search 前进到下一个回退前,每个提供商搜索传输的硬超时(秒,最大 ${MAX_WEB_SEARCH_TIMEOUT_SECONDS})`,
			options: [
				{ value: "30", label: "30 秒" },
				{ value: "60", label: "1 分钟" },
				{ value: "120", label: "2 分钟" },
				{ value: "180", label: "3 分钟" },
				{ value: "300", label: "5 分钟" },
			],
		},
	},
	"providers.webSearchGeminiModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Gemini web_search 模型",
			description: "Gemini Google Search grounding 的模型 ID。默认为 gemini-2.5-flash。",
		},
	},
	"providers.antigravityEndpoint": {
		type: "enum",
		values: ["auto", "production", "sandbox"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "Antigravity 端点模式",
			description: "google-antigravity 提供商(chat、search、image、discovery)的端点路由策略",
			options: [
				{
					value: "auto",
					label: "自动",
					description: "尝试生产端点,5xx/429 时故障转移到沙箱",
				},
				{
					value: "production",
					label: "仅生产环境",
					description: "仅强制生产端点",
				},
				{
					value: "sandbox",
					label: "仅沙箱",
					description: "仅强制沙箱端点",
				},
			],
		},
	},
	"providers.imageOrder": {
		type: "array",
		default: [] as ImageProvider[],
		ui: {
			tab: "providers",
			group: "Services",
			label: "图片提供商顺序",
			description:
				"图片生成的优先提供商;未列出的提供商遵循当前会话提供商和内置顺序",
			options: IMAGE_PROVIDER_CHOICES,
			ordered: true,
		},
	},
	"providers.fireworksTier": {
		type: "enum",
		values: ["standard", "priority"] as const,
		default: "standard",
		ui: {
			tab: "providers",
			group: "Fireworks",
			label: "Fireworks 等级",
			description:
				'Fireworks 请求的服务路径。Priority 发送 `service_tier: "priority"`,在高峰流量期间以更高价格换取更高可靠性;Standard 省略它。Fast(`-fast`)模型忽略此项 — Fast 有自己独立的服务路径。',
			options: [
				{ value: "standard", label: "标准", description: "默认服务路径(不带 service_tier)" },
				{
					value: "priority",
					label: "优先",
					description: "优先服务路径:更高可靠性,每 token 定价更高",
				},
			],
		},
	},
	"live.voice": {
		type: "enum",
		values: LIVE_VOICE_VALUES,
		default: DEFAULT_LIVE_VOICE,
		ui: {
			tab: "providers",
			group: "Services",
			label: "实时语音",
			description: "Codex 支持的实时语音会话使用的音色",
			options: LIVE_VOICE_OPTIONS,
		},
	},
	"providers.tts": {
		type: "enum",
		values: ["auto", "local", "xai"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "文本转语音提供商",
			description: "tts 工具的后端:本地设备端神经 TTS (Kokoro-82M) 或 xAI Grok Voice",
			options: [
				{
					value: "auto",
					label: "自动",
					description: "优先本地设备端 TTS;存在凭证时将 .mp3 输出路由到 xAI",
				},
				{ value: "local", label: "本地", description: "设备端神经 TTS (Kokoro-82M);输出为 WAV/PCM16" },
				{
					value: "xai",
					label: "xAI Grok Voice",
					description: "需要 xAI Grok OAuth 或 XAI_API_KEY;MP3 或 WAV",
				},
			],
		},
	},
	"tts.localModel": {
		type: "enum",
		values: TTS_LOCAL_MODEL_VALUES,
		default: DEFAULT_TTS_LOCAL_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Services",
			label: "本地 TTS 模型",
			description: "本地 TTS 后端使用的设备端神经 TTS 模型 (Kokoro-82M)",
			options: TTS_LOCAL_MODEL_OPTIONS,
		},
	},
	"tts.localVoice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: "Services",
			label: "本地 TTS 音色",
			description: "本地 TTS 后端使用的 Kokoro 音色(美式/英式,女声/男声)",
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"speech.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "语音朗读",
			description: "流式输出时通过扬声器朗读助手输出",
		},
	},
	"speech.mode": {
		type: "enum",
		values: ["all", "assistant", "yield"] as const,
		default: "assistant",
		ui: {
			tab: "providers",
			group: "Services",
			label: "语音朗读模式",
			description:
				"朗读什么:all = 助手消息+思考;assistant = 仅消息;yield = 仅轮次结束时的最终消息",
			options: [
				{ value: "all", label: "全部(消息+思考)" },
				{ value: "assistant", label: "仅助手消息" },
				{ value: "yield", label: "仅最终消息" },
			],
		},
	},
	"speech.enhanced": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "增强语音改写",
			description:
				"合成前用 tiny/smol 模型将助手输出改写成自然的口语化散文(描述代码、去掉链接和 markdown)。失败时回退为机械清理",
		},
	},
	"speech.voice": {
		type: "enum",
		values: TTS_LOCAL_VOICE_VALUES,
		default: DEFAULT_TTS_VOICE,
		ui: {
			tab: "providers",
			group: "Services",
			label: "语音朗读音色",
			description: "朗读助手输出时使用的 Kokoro 音色",
			options: TTS_LOCAL_VOICE_OPTIONS,
		},
	},
	"providers.tinyModel": {
		type: "enum",
		values: TINY_TITLE_MODEL_VALUES,
		default: ONLINE_TINY_TITLE_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "微型模型",
			description:
				"会话标题模型:默认在线(TINY 角色,来自 /models,否则 @smol),或本地设备端模型",
			options: TINY_TITLE_MODEL_OPTIONS,
		},
	},
	"providers.tinyModelDevice": {
		type: "enum",
		values: TINY_MODEL_DEVICE_SETTING_VALUES,
		default: TINY_MODEL_DEVICE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "微型模型设备",
			description:
				"本地微型模型(标题+记忆)的 ONNX 执行提供商。默认使用仅 CPU 推理。PI_TINY_DEVICE 环境变量可覆盖此项。",
			options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
		},
	},
	"providers.tinyModelDtype": {
		type: "enum",
		values: TINY_MODEL_DTYPE_SETTING_VALUES,
		default: TINY_MODEL_DTYPE_DEFAULT,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "微型模型精度",
			description:
				"本地微型模型的 ONNX 量化/精度。默认使用各模型自带的 dtype (q4);精度越低越快,越高越保真。PI_TINY_DTYPE 环境变量可覆盖此项。",
			options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
		},
	},
	"providers.memoryModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "memory",
			group: "General",
			label: "记忆模型",
			description:
				"用于事实抽取+整合的 Mnemopi LLM:默认在线(TINY 角色,来自 /models,否则为 smol/remote),或本地设备端模型",
			condition: "mnemopiActive",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.autoThinkingModel": {
		type: "enum",
		values: AUTO_THINKING_MODEL_VALUES,
		default: ONLINE_AUTO_THINKING_MODEL_KEY,
		ui: {
			tab: "model",
			group: "Thinking",
			label: "自动思考模型",
			description:
				"`auto` 思考级别的难度分类器:默认在线(TINY 角色,来自 /models,否则为 smol),或本地设备端模型",
			condition: "autoThinkingActive",
			options: AUTO_THINKING_MODEL_OPTIONS,
		},
	},
	"providers.autoThinkingMaxEffort": {
		type: "enum",
		values: ["xhigh", "max"] as const,
		default: "xhigh",
		ui: {
			tab: "model",
			group: "Thinking",
			label: "自动思考上限",
			description:
				"`auto` 分类器可解析到的最高力度。`xhigh` 让分类器停在最高档之下,因此只有显式的 `ultrathink` 才能达到 `max`;`max` 允许分类器判定为例外的轮次在支持该档位的模型上计费最高档。",
			condition: "autoThinkingActive",
			options: [
				{ value: "xhigh", label: "xhigh", description: "分类器在 xhigh 处停止(默认)" },
				{ value: "max", label: "max", description: "分类器可在模型支持时解析为 max" },
			],
		},
	},
	"features.unexpectedStopDetection": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Agent",
			label: "检测意外停止",
			description:
				"使用一个小模型检测助手说会继续但未调用工具就停止的情况;自动提示它继续。",
		},
	},
	"providers.unexpectedStopModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "providers",
			group: "Tiny Model",
			label: "意外停止检测模型",
			description:
				"意外停止检测的分类器:默认在线(TINY 角色,来自 /models,否则为 smol),或本地设备端模型。",
			condition: "unexpectedStopDetection",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["auto", "openai", "anthropic"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "Kimi API 格式",
			description: "Kimi Code 提供商的 API 格式(auto 跟随模型实时元数据)",
			options: [
				{ value: "auto", label: "自动", description: "使用模型服务器声明的协议" },
				{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
				{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
			],
		},
	},

	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenAI WebSocket",
			description: "OpenAI Codex 模型的 websocket 策略(auto 使用模型默认,on 强制,off 禁用)",
			options: [
				{ value: "auto", label: "自动", description: "使用模型/提供商的默认 websocket 行为" },
				{ value: "off", label: "关闭", description: "为 OpenAI Codex 模型禁用 websocket" },
				{ value: "on", label: "开启", description: "为 OpenAI Codex 模型强制启用 websocket" },
			],
		},
	},

	"providers.streamFirstEventTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: "Timeouts",
			label: "流式首个事件超时",
			description:
				"等待模型流首个事件的秒数;-1 使用提供商/环境默认值,0 禁用看门狗",
			options: [
				{ value: "-1", label: "自动", description: "使用提供商默认值和 PI_* 超时环境变量" },
				{ value: "0", label: "关闭", description: "禁用首个事件超时" },
				{ value: "300", label: "5 分钟" },
				{ value: "600", label: "10 分钟" },
				{ value: "1800", label: "30 分钟" },
			],
		},
	},

	"providers.streamIdleTimeoutSeconds": {
		type: "number",
		default: -1,
		ui: {
			tab: "providers",
			group: "Timeouts",
			label: "流式空闲超时",
			description:
				"模型流在事件之间可保持静默的秒数;-1 使用提供商/环境默认值,0 禁用看门狗",
			options: [
				{ value: "-1", label: "自动", description: "使用提供商默认值和 PI_* 超时环境变量" },
				{ value: "0", label: "关闭", description: "禁用空闲超时" },
				{ value: "300", label: "5 分钟" },
				{ value: "600", label: "10 分钟" },
				{ value: "1800", label: "30 分钟" },
			],
		},
	},

	"providers.openrouterVariant": {
		type: "enum",
		values: ["default", "nitro", "floor", "online", "exacto"] as const,
		default: "default",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "OpenRouter 路由",
			description:
				"附加到 OpenRouter 模型 ID 的默认路由变体后缀(选择器已指定变体时覆盖)",
			options: [
				{ value: "default", label: "默认", description: "无后缀;使用 OpenRouter 默认路由" },
				{ value: "nitro", label: ":nitro", description: "优先吞吐量 / 最低延迟" },
				{ value: "floor", label: ":floor", description: "优先最便宜的可用提供商" },
				{ value: "online", label: ":online", description: "启用 OpenRouter 的 web-search 插件" },
				{
					value: "exacto",
					label: ":exacto",
					description: "精选的高质量提供商(仅对特定模型定义)",
				},
			],
		},
	},
	"providers.fetch": {
		type: "enum",
		values: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Services",
			label: "抓取提供商",
			description: "fetch/read URL 工具的阅读器后端优先级",
			options: [
				{
					value: "auto",
					label: "自动",
					description: "优先级:native > trafilatura > lynx > parallel > jina",
				},
				{ value: "native", label: "原生", description: "进程内 HTML→Markdown 转换器(始终可用)" },
				{ value: "trafilatura", label: "Trafilatura", description: "通过 uv/pip 自动安装" },
				{ value: "lynx", label: "Lynx", description: "需要 lynx 系统包" },
				{ value: "parallel", label: "Parallel", description: "需要 PARALLEL_API_KEY" },
				{ value: "jina", label: "Jina", description: "使用 r.jina.ai 阅读器(JINA_API_KEY 可选)" },
			],
		},
	},
	// Codex saved rate-limit resets (auto-redeem)
	"codexResets.autoRedeem": {
		type: "enum",
		values: ["unset", "yes", "no"] as const,
		default: "unset" as const,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex 自动兑换已保存重置",
			description:
				"自动消耗已保存的 Codex 速率限制重置:当一轮卡住且没有其他账户可接管时,恢复被耗尽的 5h 或周窗口阻塞的账户,并抢救即将过期的额度。unset 在首次消耗前询问,yes 无需提示直接消耗,no 禁用两项检查。",
			options: [
				{
					value: "unset",
					label: "未设置",
					description: "先检查资格,再在消耗第一个已保存重置前询问。",
				},
				{ value: "yes", label: "是", description: "无需提示即可消耗符合条件的已保存重置。" },
				{ value: "no", label: "否", description: "不运行已保存重置的自动兑换检查。" },
			],
		},
	},
	"codexResets.minBlockedMinutes": {
		type: "number",
		default: 60,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex 自动兑换最小阻塞",
			description:
				"仅在自然解封 — 已耗尽的 5h/周窗口中最新的重置 — 至少还有这么多分钟时自动兑换(不要为省一次短等待而消耗稀缺额度)。调高(例如 360)可忽略仅 5h 的阻塞。",
		},
	},
	"codexResets.keepCredits": {
		type: "number",
		default: 0,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex 自动兑换保留",
			description:
				"自动消耗时绝不低于这个已保存重置数(0 = 最后一个额度也可能被自动消耗)。即将过期的额度豁免 — 保留的额度若过期则毫无保留价值。",
		},
	},
	"codexResets.salvageHorizonHours": {
		type: "number",
		default: 12,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Codex 重置抢救时限",
			description:
				"当已保存的 Codex 重置将在这么多小时内过期,且任一聊天窗口(5h 或周)有可恢复的有效用量时,自动消耗该重置(0 禁用过期抢救)。",
		},
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			group: "Protocol",
			label: "只追加上下文",
			description:
				"缓存系统提示词+工具规格,并保持只追加的消息日志,使提供商前缀缓存(DeepSeek、Xiaomi/SGLang、Anthropic)以最大命中率工作。Auto 为已知前缀缓存提供商启用。",
			options: [
				{ value: "auto", label: "自动", description: "为已知前缀缓存提供商启用(推荐)" },
				{ value: "on", label: "开启", description: "始终启用只追加上下文" },
				{ value: "off", label: "关闭", description: "禁用只追加上下文" },
			],
		},
	},

	// Exa
	"exa.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "providers", group: "Services", label: "Exa", description: "所有 Exa 搜索工具的总开关" },
	},

	"exa.enableSearch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa 搜索",
			description: "启用 Exa 基础搜索、深度搜索、代码搜索和抓取工具",
		},
	},

	"exa.searchDelayMs": {
		type: "number",
		default: 1_000,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa 搜索延迟",
			description: "Exa 网络搜索请求之间的最小延迟(毫秒);设为 0 禁用节流",
		},
	},

	"exa.enableResearcher": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa 研究员",
			description: "启用 Exa 研究员工具进行 AI 深度研究",
		},
	},

	"exa.enableWebsets": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Services",
			label: "Exa 数据集",
			description: "启用 Exa 数据集管理与增强工具",
		},
	},

	// SearXNG
	"searxng.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			group: "Services",
			label: "SearXNG 端点",
			description: "用于网络搜索的自托管 SearXNG 实例的基础 URL",
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
		credential: true,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.engines": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"dev.autoqa": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "自动 QA",
			description:
				"自动化工具问题上报 (xd://report_issue)。默认开启;首次上报会征求同意,拒绝后将禁用上报,直到显式重新启用",
		},
	},

	"dev.autoqaPush.endpoint": {
		type: "string",
		default: "https://qa.omp.sh/v1/grievances" as const,
		ui: {
			tab: "tools",
			group: "Developer",
			label: "自动 QA 推送端点",
			description: "接收 Auto QA JSON 报告的完整 URL(默认 https://qa.omp.sh/v1/grievances)",
		},
	},

	"dev.autoqaPush.token": {
		type: "string",
		default: undefined,
		credential: true,
	},

	/**
	 * User decision on sharing automatic `report_tool_issue` grievances.
	 *
	 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
	 *                  pops a consent dialog and persists the answer here.
	 *   - `"granted"` — record and (when push is configured) ship grievances.
	 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
	 *
	 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via the
	 * process-global consent handler registered by `InteractiveMode`.
	 *
	 * @default "unset"
	 */
	"dev.autoqaConsent": {
		type: "enum",
		values: ["unset", "granted", "denied"] as const,
		default: "unset" as const,
	},

	"gc.blobs": { type: "boolean", default: true },

	"gc.archive": { type: "boolean", default: true },

	"gc.wal": { type: "boolean", default: true },

	"gc.coldArchiveAfterDays": { type: "number", default: 30 },

	"gc.retainNewestGlobal": { type: "number", default: 20 },

	"gc.retainNewestPerCwd": { type: "number", default: 10 },

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },

	"thinkingBudgets.max": { type: "number", default: 32768 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

/** All valid setting paths */
export type SettingPath = keyof Schema;

/** Infer the value type for a setting path */
export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: Schema[P] extends { type: "boolean" }
		? boolean
		: Schema[P] extends { type: "string" }
			? string | undefined
			: Schema[P] extends { type: "number"; default: undefined }
				? number | undefined
				: Schema[P] extends { type: "number" }
					? number
					: Schema[P] extends { type: "enum"; values: infer V }
						? V extends readonly string[]
							? V[number]
							: never
						: Schema[P] extends { type: "array"; default: infer D }
							? D
							: Schema[P] extends { type: "record"; default: infer D }
								? D
								: never;

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

/** Check if a path has UI metadata (should appear in settings panel) */
export function hasUi(path: SettingPath): boolean {
	return "ui" in SETTINGS_SCHEMA[path];
}

/**
 * Whether a setting holds a credential and must never be printed or exported
 * without an explicit request. Drives both CLI redaction and settings-panel
 * masking, so the two cannot disagree.
 */
export function isCredential(path: SettingPath): boolean {
	const def = SETTINGS_SCHEMA[path];
	if ("credential" in def && def.credential === true) return true;
	// `ui.secret` predates this marker and still means "never display". Reading
	// both here keeps ONE accessor, so the two spellings cannot produce
	// different behaviour on different surfaces.
	return getUi(path)?.secret === true;
}

/** Get UI metadata for a path (undefined if no UI) */
export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

/** Get all paths for a specific tab */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingDef["type"] {
	return SETTINGS_SCHEMA[path].type;
}

/** Get enum values for an enum setting */
export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived Types from Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Status line preset - derived from schema */
export type StatusLinePreset = SettingValue<"statusLine.preset">;

/** Status line separator style - derived from schema */
export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

/** Tree selector filter mode - derived from schema */
export type TreeFilterMode = SettingValue<"treeFilterMode">;

/** Personality preset - derived from schema */
export type Personality = SettingValue<"personality">;

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings {
	enabled: boolean;
	strategy: "context-full" | "handoff" | "shake" | "snapcompact" | "off";
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens: number | undefined;
	keepRecentTokens: number;
	midTurnEnabled: boolean;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
	remoteEnabled: boolean;
	remoteEndpoint: string | undefined;
	remoteStreamingV2Enabled: boolean;
	v2RetainedMessageBudget: number;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
	supersedeReads: boolean;
	dropUseless: boolean;
}

export interface RecapSettings {
	enabled: boolean;
	idleSeconds: number;
}

export interface TitleSettings {
	refreshOnReplan: boolean;
}

export interface ContextPromotionSettings {
	enabled: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	modelFallback: boolean;
	usageAwareFallback: boolean;
	usageReservePct: number;
	usageReservePolicy: "confirm" | "auto" | "fail-closed";
}

export interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	enabled?: boolean;
	enableSkillCommands?: boolean;
	enableCodexUser?: boolean;
	enableClaudeUser?: boolean;
	enableClaudeProject?: boolean;
	enablePiUser?: boolean;
	enablePiProject?: boolean;
	enableAgentsUser?: boolean;
	enableAgentsProject?: boolean;
	customDirectories?: string[];
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
}

export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	builtinRules?: boolean;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	disabledRules?: string[];
}

export interface ExaSettings {
	enabled: boolean;
	enableSearch: boolean;
	searchDelayMs: number;
	enableResearcher: boolean;
	enableWebsets: boolean;
}

export interface StatusLineSettings {
	preset: StatusLinePreset;
	separator: StatusLineSeparatorStyle;
	showHookStatus: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

export interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
	max: number;
}

export interface SttSettings {
	enabled: boolean;
	language: string | undefined;
	modelName: string;
	streaming: boolean;
}

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}
export type CodexAutoRedeemMode = "unset" | "yes" | "no";

export interface CodexResetsSettings {
	autoRedeem: CodexAutoRedeemMode;
	minBlockedMinutes: number;
	keepCredits: number;
	salvageHorizonHours: number;
}

export interface GcSettings {
	blobs: boolean;
	archive: boolean;
	wal: boolean;
	coldArchiveAfterDays: number;
	retainNewestGlobal: number;
	retainNewestPerCwd: number;
}

/** Map group prefix -> typed settings interface */
export interface GroupTypeMap {
	compaction: CompactionSettings;
	recap: RecapSettings;
	title: TitleSettings;
	contextPromotion: ContextPromotionSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	stt: SttSettings;
	modelRoles: Record<string, string>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
	codexResets: CodexResetsSettings;
	gc: GcSettings;
}

export type GroupPrefix = keyof GroupTypeMap;
