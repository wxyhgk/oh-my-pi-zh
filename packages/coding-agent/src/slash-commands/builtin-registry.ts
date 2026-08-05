import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@wxyhgk/pi-ai/oauth";
import { type AutocompleteItem, Spacer } from "@wxyhgk/pi-tui";
import { APP_NAME, getMCPConfigPath, getProjectDir, logger, setProjectDir } from "@wxyhgk/pi-utils";
import { reset as resetCapabilities } from "../capability";
import { COLLAB_GUEST_ALLOWED_COMMANDS, CollabGuestLink } from "../collab/guest";
import { CollabHost } from "../collab/host";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import type { SettingPath, SettingValue } from "../config/settings";
import { settings } from "../config/settings";
import {
	clearPluginRootsAndCaches,
	resolveActiveProjectRegistryPath,
	resolveOrDefaultProjectRegistryPath,
} from "../discovery/helpers.js";
import { parseExportArgs } from "../export/html/args";
import { shareSession } from "../export/share";
import { PluginManager } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace";
import { readMCPConfigFile } from "../mcp/config-writer";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import { runPauseScreen } from "../modes/components/pause-screen";
import { collectMcpServerNames, MCPCommandController } from "../modes/controllers/mcp-command-controller";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import { theme } from "../modes/theme/theme";
import type { InteractiveModeContext } from "../modes/types";
import { extractLastCodeBlock, extractLastCommand } from "../modes/utils/copy-targets";
import type { AgentSession, FreshSessionResult } from "../session/agent-session";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { resolveResumableSession } from "../session/session-listing";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import type { ComputerTool } from "../tools/computer";
import { computerExposureMode } from "../tools/computer/exposure";
import { expandTilde, resolveToCwd } from "../tools/path-utils";
import { urlHyperlinkAlways } from "../tui";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../utils/changelog";
import { copyToClipboard } from "../utils/clipboard";
import type { InspectImageMode } from "../utils/inspect-image-mode";
import { CollabQrCodeComponent } from "./helpers/collab-qrcode";
import { buildContextReportText } from "./helpers/context-report";
import { formatDuration } from "./helpers/format";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { handleMcpAcp } from "./helpers/mcp";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import { describeRedeemOutcome, type ResetUsageAccount, toResetUsageAccounts } from "./helpers/reset-usage";
import { handleSecurityCommand } from "./helpers/security";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import { handleSshAcp } from "./helpers/ssh";
import { launchStatsDashboard, parseStatsDashboardArgs } from "./helpers/stats-dashboard";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/** `/fast status` label for the active model: "on" when its family is priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "开" : "关";
}

/** Detailed, session-effective `/computer status` diagnostics. */
async function formatComputerUseStatus(session: AgentSession): Promise<string> {
	const enabled = session.settings.get("computer.enabled");
	const active = session.getEnabledToolNames().includes("computer");
	const model = session.model;
	const modelName = model ? formatModelString(model) : "无";
	const exposure = !enabled
		? "未暴露(已禁用)"
		: !active
			? "未暴露(工具未激活)"
			: computerExposureMode(model);
	const configured = {
		display: session.settings.get("computer.display"),
		maxWidth: session.settings.get("computer.maxWidth"),
		maxHeight: session.settings.get("computer.maxHeight"),
	};
	const computerTool = active
		? (session.getToolByName("computer") as Pick<ComputerTool, "capabilities"> | undefined)
		: undefined;
	const capabilities = await computerTool?.capabilities();
	const capabilityStatus = capabilities
		? [
				`backend=${capabilities.backend}${capabilities.displayServer ? `/${capabilities.displayServer}` : ""}`,
				`capture=${capabilities.capture} (${capabilities.capturePermission})`,
				`input=${capabilities.input} (${capabilities.inputPermission})`,
				`ax=${capabilities.ax} (${capabilities.axPermission})`,
				`backgroundWindowInput=${capabilities.backgroundWindowInput}`,
				`deliveryModes=${capabilities.deliveryModes.join(",") || "无"}`,
			].join(", ")
		: "会话未启动";
	return [
		`计算机使用:${enabled ? "已启用" : "已禁用"}`,
		`工具:${active ? "激活" : "未激活"}`,
		`暴露:${exposure}`,
		`模型:${modelName}`,
		`已配置:display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
		`能力:${capabilityStatus}`,
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle: flip the active tool slate first
 * (so a failed enable never leaves a stale settings override), then record the
 * runtime override — never `settings.set`, which would persist to settings.json.
 * Returns the operator feedback line.
 */
async function applyComputerUseToggle(session: AgentSession, enable: boolean): Promise<string> {
	const applied = await session.setComputerToolEnabled(enable);
	if (enable && !applied) {
		return "当前会话不支持计算机使用。";
	}
	session.settings.override("computer.enabled", enable);
	return enable
		? `当前会话已启用计算机使用。${await formatComputerUseStatus(session)}`
		: "当前会话已禁用计算机使用。";
}

/** Session-effective `/vision status` line. */
function formatVisionStatus(session: AgentSession): string {
	const { mode, active, model } = session.inspectImageState();
	const override = session.getInspectImageModeOverride();
	const modelObj = session.model;
	const capability = modelObj
		? modelObj.input.includes("image")
			? "原生图像输入"
			: "无原生图像输入"
		: "无活动模型";
	return [
		`inspect_image: ${active ? "激活" : "未激活"}`,
		`模式:${mode}${override ? "(会话覆盖)" : ""}`,
		...(override ? [`已配置:${session.settings.get("inspect_image.mode")}`] : []),
		`模型:${model ?? "无"}(${capability})`,
	].join(" · ");
}

/** Applies a `/vision` mode for this session and returns the operator feedback line. */
async function applyVisionMode(session: AgentSession, mode: InspectImageMode): Promise<string> {
	const applied = await session.setInspectImageMode(mode);
	if (!applied) {
		return "当前会话无法使用 inspect_image。";
	}
	return `视觉模式:${mode}。${formatVisionStatus(session)}`;
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

/** Scheme-less display form of a browser deep link: accent + underline, OSC-8 linked to the full URL. */
function collabWebLinkClickable(webLink: string): string {
	const display = theme.fg("accent", `\x1b[4m${webLink.replace(/^https?:\/\//, "")}\x1b[24m`);
	return urlHyperlinkAlways(webLink, display);
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		theme.fg("success", heading),
		` ${bullet} ${theme.fg("muted", view ? "从另一个终端观看:" : "从另一个终端加入:")} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", "或任意浏览器:")} ${collabWebLinkClickable(webLink)}`,
		theme.fg(
			"dim",
			view
				? "持有此链接的任何人可以观看会话,但无法向 Agent 发送提示。"
				: "持有此链接的任何人可以阅读会话并向 Agent 发送提示。只读链接:/collab view",
		),
	].join("\n");
}

function showCollabQrCode(ctx: InteractiveModeContext, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(`渲染协作二维码失败:${errorMessage(err)}`);
	}
}

function showCollabLink(ctx: InteractiveModeContext, host: CollabHost, heading: string, view = false): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = "提供商状态";
	return `已启动全新提供商会话(已清理 ${result.closedProviderSessions} 个${stateLabel})。`;
}

const shutdownHandlerTui = (_command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`无法加载已保存的重置额度:${errorMessage(error)}`);
		return;
	}
	if (accounts.length === 0) {
		await output("未找到 Codex 账户。请使用 /login 添加一个。");
		return;
	}
	const targetArg = arg.trim();
	if (!targetArg) {
		const lines = ["已保存的 Codex 限速重置:"];
		for (const account of accounts) {
			const detail = account.error ? `不可用(${account.error})` : `${account.availableCount} 个可用`;
			lines.push(`- ${account.label}:${detail}${account.active ? "(当前)" : ""}`);
		}
		lines.push("", "使用 `/usage reset <account email>` 或 `/usage reset active` 消耗一个。");
		await output(lines.join("\n"));
		return;
	}
	const wanted = targetArg.toLowerCase();
	const target =
		wanted === "active"
			? accounts.find(account => account.active)
			: accounts.find(
					account =>
						account.label.toLowerCase() === wanted ||
						account.target.email?.toLowerCase() === wanted ||
						account.target.accountId?.toLowerCase() === wanted,
				);
	if (!target) {
		await output(`没有与 "${targetArg}" 匹配的 Codex 账户。`);
		return;
	}
	if (target.availableCount <= 0) {
		await output(`${target.label}:无已保存的重置可消耗。`);
		return;
	}
	const outcome = await session.redeemResetCredit(target.target);
	await output(describeRedeemOutcome(outcome, target.label));
}

async function handleSessionPinCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	if (session.isStreaming) {
		await output("会话流式输出期间无法固定账户。");
		return;
	}
	let accountList: SessionOAuthAccountList | undefined;
	try {
		accountList = await session.listCurrentProviderOAuthAccounts();
	} catch (error) {
		await output(`无法加载提供商账户:${errorMessage(error)}`);
		return;
	}
	if (!accountList) {
		await output("请先选择模型,再固定提供商账户。");
		return;
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
	const providerName = provider?.name ?? accountList.provider;
	const accounts = toSessionPinAccounts(accountList.accounts);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.describeCredentialSource(
			accountList.provider,
			session.sessionId,
		);
		await output(
			source
				? `${providerName} 没有已存储的 OAuth 账户。当前认证来自 ${source}。`
				: `${providerName} 没有已存储的 OAuth 账户。请使用 /login 添加一个。`,
		);
		return;
	}

	const selector = arg.trim();
	if (!selector) {
		const lines = [`${providerName} 的 OAuth 账户:`];
		for (const account of accounts) {
			lines.push(`${account.position + 1}. ${account.label}${account.active ? "(当前)" : ""}`);
		}
		lines.push("", "使用 `/session pin <number|email|account id>` 固定一个。");
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(`没有与 "${selector}" 匹配的 ${providerName} 账户。`);
		return;
	}
	if (matches.length > 1) {
		await output(
			`"${selector}" 匹配到多个 ${providerName} 账户:${matches
				.map(account => `${account.position + 1}. ${account.label}`)
				.join(", ")}。请使用账户编号。`,
		);
		return;
	}
	const account = matches[0];
	if (!account || !session.pinCurrentProviderOAuthAccount(account.credentialId)) {
		await output(`${account?.label ?? selector} 不再可用于固定。`);
		return;
	}
	await output(`已为 ${providerName} 将 ${account.label} 固定到本会话。`);
}

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	return { error: `未知的 /shake 模式 "${verb}"。请使用 elide 或 images。` };
}

/** Format the session's workspace directories (cwd + additional) for display. */
function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = ["工作区目录:", `  ${cwd}(工作目录)`, ...additional.map(d => `  ${d}`)];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		description: "规划、运行、检查、导入和比较 OMP 原生安全扫描",
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "创建不可变的安全扫描计划" },
			{ name: "scan", description: "启动已规划或新规划的原生扫描" },
			{ name: "status", description: "显示原生扫描操作状态" },
			{ name: "cancel", description: "取消正在运行的原生扫描" },
			{ name: "scans", description: "列出已存储的项目安全扫描" },
			{ name: "show", description: "渲染扫描或 security:// 资源" },
			{ name: "import", description: "导入 SARIF 或 Codex Security 包" },
			{ name: "export", description: "导出标准包、SARIF 或报告" },
			{ name: "validate", description: "使用 OMP 原生工具验证一条发现" },
			{ name: "compare", description: "比较两次扫描之间的发现血缘" },
			{ name: "disposition", description: "设置带理由的发现处置" },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		description: "打开设置菜单",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		description: "打开提供商设置",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "配置登录和网络搜索提供商" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`用法:/${command.name} [providers]`);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		description: "切换计划模式(Agent 先规划再执行)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled" as SettingPath)) return "计划:已在设置中禁用";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `计划:开${planFile ? `(${path.basename(planFile)})` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "计划:目标模式下不可用";
			return "计划:关";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handlePlanModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan-review",
		description: "重新打开最新计划的计划审阅(仅计划模式)",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled ? "计划审阅:可用" : "计划审阅:计划模式未激活",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vibe",
		description: "切换 vibe 模式(直接持久化 fast/good 工作会话;只读工具集)",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "Vibe:开";
			if (runtime.ctx.planModeEnabled) return "Vibe:计划模式下不可用";
			if (runtime.ctx.goalModeEnabled) return "Vibe:目标模式下不可用";
			return "Vibe:关";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleVibeModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "goal",
		description: "切换目标模式(本会话的持久自主目标)",
		subcommands: [
			{ name: "set", description: "设置或替换目标", usage: "<objective>" },
			{ name: "show", description: "显示当前目标详情" },
			{ name: "pause", description: "暂停当前目标" },
			{ name: "resume", description: "恢复已暂停的目标" },
			{ name: "drop", description: "放弃当前目标" },
			{ name: "budget", description: "调整 token 预算", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled" as SettingPath)) return "目标:已在设置中禁用";
			if (runtime.ctx.planModeEnabled) return "目标:计划模式下不可用";
			const state = runtime.ctx.session.getGoalModeState();
			return state ? `目标:${state.goal.status} (${shortDetail(state.goal.objective)})` : "目标:关";
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleGoalModeCommand(command.args || undefined);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "guided-goal",
		description: "让 Agent 在对话中访谈你,然后设置目标模式",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			// Clear the slash draft BEFORE the await: the handler blocks for the
			// whole kickoff turn, and a post-await clear would wipe an answer the
			// user starts typing while the first interview question streams.
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleGuidedGoalCommand(command.args || undefined);
		},
	},
	{
		name: "loop",
		description:
			"切换循环模式。启用后,你发送的下一条提示词会在每次产出后重新提交。Esc 取消当前迭代;再次输入 /loop 关闭。",
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "循环:关";
			if (runtime.ctx.loopModePaused) return "循环:已暂停";
			if (runtime.ctx.loopLimit) return `循环:开(${describeLoopLimitRuntime(runtime.ctx.loopLimit)})`;
			if (runtime.ctx.loopPrompt) return "循环:开(重复提示词)";
			return "循环:开(等待下一条提示词)";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		description: "将一条消息排队,待 Agent 产出后发送",
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		description: "切换本会话的模型",
		acpDescription: "显示当前模型选择",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `模型:${model.provider}/${model.id}` : "模型:未选择";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`未知模型:${modelId}。使用 ACP \`session/setModel\` 进行选择器驱动的选择,或使用 /model 列出可用模型。`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`模型已设置为 ${match.provider}/${match.id}。`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`设置模型失败:${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `当前模型:${model.provider}/${model.id}` : "当前未选择模型。",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "switch",
		description: "切换本会话的模型(与 alt+p 相同)",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `模型:${model.provider}/${model.id}` : "模型:未选择";
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fast",
		description: "切换优先服务层级(OpenAI service_tier=priority,Anthropic speed=fast)",
		acpDescription: "切换快速模式",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "启用快速模式" },
			{ name: "off", description: "禁用快速模式" },
			{ name: "status", description: "显示快速模式状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `快速:${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`快速模式已${enabled ? "启用" : "禁用"}。`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(supported ? "快速模式已启用。" : "当前模型不支持快速模式。");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("快速模式已禁用。");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`快速模式当前为${formatFastModeStatus(runtime.session)}。`);
				return commandConsumed();
			}
			return usage("用法:/fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`快速模式已${enabled ? "启用" : "禁用"}。`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(
					supported ? "快速模式已启用。" : "当前模型不支持快速模式。",
				);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("快速模式已禁用。");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`快速模式当前为${formatFastModeStatus(runtime.ctx.session)}。`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法:/fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "computer",
		description: "切换本会话的原生计算机使用工具",
		acpDescription: "切换计算机使用",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "为本会话启用计算机使用" },
			{ name: "off", description: "为本会话禁用计算机使用" },
			{ name: "status", description: "显示计算机使用状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`计算机:${runtime.ctx.session.settings.get("computer.enabled") ? "开" : "关"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(await formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !runtime.session.settings.get("computer.enabled");
				await runtime.output(await applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("用法:/computer [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(await formatComputerUseStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !runtime.ctx.session.settings.get("computer.enabled");
				runtime.ctx.showStatus(await applyComputerUseToggle(runtime.ctx.session, enable));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法:/computer [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vision",
		description: "控制本会话的 inspect_image 视觉委派工具",
		acpDescription: "切换视觉委派",
		acpInputHint: "[on|off|auto|status]",
		subcommands: [
			{ name: "on", description: "本会话始终暴露 inspect_image" },
			{ name: "off", description: "本会话从不暴露 inspect_image" },
			{ name: "auto", description: "遵循 inspect_image.mode(对支持视觉的模型自动隐藏)" },
			{ name: "status", description: "显示 inspect_image 状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `视觉:${runtime.ctx.session.inspectImageState().mode}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatVisionStatus(runtime.session));
				return commandConsumed();
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				await runtime.output(await applyVisionMode(runtime.session, arg));
				return commandConsumed();
			}
			return usage("用法:/vision [on|off|auto|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatVisionStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on" || arg === "off" || arg === "auto") {
				runtime.ctx.showStatus(await applyVisionMode(runtime.ctx.session, arg));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法:/vision [on|off|auto|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "prewalk",
		description: "在下一个动作时切换到快速/廉价模型(即使没有 --prewalk 也生效)",
		acpDescription: "在下一个动作时执行 Prewalk",
		handle: async (_command, runtime) => {
			const rolePattern = expandRoleAlias("@smol", runtime.settings);
			const resolved = resolveCliModel({
				cliModel: rolePattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
			});
			if (resolved.error || !resolved.model) {
				return usage(resolved.error ?? `未找到模型 "${rolePattern}"`, runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				return usage(`${resolved.model.provider}/${resolved.model.id} 没有 API 密钥`, runtime);
			}
			runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			await runtime.output(
				`Prewalk 已开启:将在下一次编辑/写入时切换到 ${resolved.model.provider}/${resolved.model.id}(受 todo 门控)。`,
			);
			return commandConsumed();
		},
	},
	{
		name: "advisor",
		description: "切换顾问(一个审查每一轮并注入备注的辅助模型)",
		acpDescription: "切换顾问",
		acpInputHint: "[on|off|status|dump [raw]|configure]",
		subcommands: [
			{ name: "on", description: "启用顾问" },
			{ name: "off", description: "禁用顾问" },
			{ name: "status", description: "显示顾问状态" },
			{ name: "dump", description: "将顾问的对话记录复制到剪贴板", usage: "[raw]" },
			{ name: "configure", description: "打开顾问配置编辑器(TUI)" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (stats.active && stats.advisors.length > 1) return `顾问:开(${stats.advisors.length} 个顾问)`;
			if (stats.active && stats.model) return `顾问:开(${stats.model.provider}/${stats.model.id})`;
			if (stats.configured) return "顾问:已配置,无模型";
			return "顾问:关";
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output("顾问已启用。");
				} else if (configured) {
					await runtime.output("顾问设置已启用,但未为 'advisor' 角色分配模型。");
				} else {
					await runtime.output("顾问已禁用。");
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active ? "顾问已启用。" : "顾问设置已启用,但未为 'advisor' 角色分配模型。",
				);
				return commandConsumed();
			}
			if (verb === "off") {
				runtime.session.setAdvisorEnabled(false);
				await runtime.output("顾问已禁用。");
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(runtime.session.formatAdvisorStatus());
				return commandConsumed();
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				const text = runtime.session.formatAdvisorHistoryAsText({ compact: !isRaw });
				await runtime.output(text ?? "本会话未激活顾问。");
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(
					"/advisor configure 会打开交互式编辑器,仅在交互式 TUI 中可用。",
				);
				return commandConsumed();
			}
			return usage("用法:/advisor [on|off|status|dump [raw]|configure]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus("顾问已启用。");
				} else if (configured) {
					runtime.ctx.showStatus("顾问设置已启用,但未为 'advisor' 角色分配模型。");
				} else {
					runtime.ctx.showStatus("顾问已禁用。");
				}
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active ? "顾问已启用。" : "顾问设置已启用,但未为 'advisor' 角色分配模型。",
				);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus("顾问已禁用。");
				refreshStatusLine(runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "configure") {
				runtime.ctx.showAdvisorConfigure();
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法:/advisor [on|off|status|dump [raw]|configure]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "export",
		description: "将会话导出为 HTML 文件",
		inlineHint: "[--themes] [path]",
		allowArgs: true,
		handle: async (command, runtime) => {
			try {
				const { outputPath, useUserThemes } = parseExportArgs(command.args);
				if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
					return usage("请使用 /dump 将会话复制到剪贴板。", runtime);
				}
				const filePath = await runtime.session.exportToHtml(outputPath, useUserThemes);
				await runtime.output(`会话已导出到:${filePath}`);
				return commandConsumed();
			} catch (err) {
				return usage(`导出会话失败:${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "dump",
		description: "将会话记录复制到剪贴板(并将 LLM 请求 JSON 写入临时目录)",
		acpDescription: "以纯文本返回完整记录,并附 LLM 请求 JSON 路径",
		allowArgs: true,
		handle: async (_command, runtime) => {
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output("暂无消息可导出。");
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					`LLM 请求 JSON:${sidecarPath}`,
					"此文件会保留在磁盘上,可能包含原始上下文/机密信息——请妥善处理。",
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleDumpCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "share",
		description: "通过加密链接分享会话(分享服务器或加密 gist)",
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: runtime.settings.get("share.serverUrl"),
					store: runtime.settings.get("share.store"),
					state: runtime.session.state,
					obfuscator: runtime.settings.get("share.redactSecrets") ? runtime.session.obfuscator : undefined,
				});
				const lines = [`分享链接:${result.url}`];
				if (result.gistUrl) lines.push(`Gist:${result.gistUrl}`);
				if (result.truncated) lines.push("注意:为符合分享大小限制,大段内容已被截断。");
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`分享会话失败:${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "collab",
		description: "通过中继实时分享本会话",
		inlineHint: "[start|view|stop|status] [relayUrl]",
		subcommands: [
			{ name: "view", description: "分享只读链接(访客可观看,不能发送提示)" },
			{ name: "status", description: "显示链接和参与者" },
			{ name: "stop", description: "停止分享" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) {
				return `协作:主持中(${Math.max(0, runtime.ctx.collabHost.participants.length - 1)} 位访客)`;
			}
			if (runtime.ctx.collabGuest?.readOnly) return "协作:只读访客";
			if (runtime.ctx.collabGuest) return "协作:访客";
			return "协作:关";
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				if (!ctx.collabHost) {
					ctx.showStatus("当前未主持协作会话");
					return;
				}
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("协作已停止");
				return;
			}
			if (verb === "status") {
				if (ctx.collabHost) {
					const names = ctx.collabHost.participants.map(p =>
						p.role === "host" ? `${p.name}(主持人)` : p.readOnly ? `${p.name}(仅观看)` : p.name,
					);
					ctx.showStatus(`协作:${names.join(", ")} — ${collabWebLinkClickable(ctx.collabHost.webLink)}`);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? "以只读访客身份处于协作会话中(/leave 退出)"
							: "以访客身份处于协作会话中(/leave 退出)",
					);
				} else {
					ctx.showStatus("当前不在协作会话中");
				}
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("已以访客身份处于协作会话中(请先 /leave)");
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			if (ctx.collabHost) {
				showCollabLink(
					ctx,
					ctx.collabHost,
					view ? "只读协作会话进行中" : "协作会话进行中",
					view,
				);
				return;
			}
			const explicitUrl = knownStartVerb ? rest : args;
			const relayInput = explicitUrl || ctx.settings.get("collab.relayUrl") || "";
			if (!relayInput) {
				ctx.showError(
					"未配置中继。请在 /settings 中设置 collab.relayUrl,或直接传入:/collab relay.example.com",
				);
				return;
			}
			// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
			const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
			const webUrl = ctx.settings.get("collab.webUrl") || "";
			const host = new CollabHost(ctx);
			try {
				await host.start(relayUrl, webUrl);
			} catch (err) {
				ctx.showError(`启动协作会话失败:${errorMessage(err)}`);
				return;
			}
			ctx.collabHost = host;
			showCollabLink(ctx, host, "协作会话已启动!", view);
		},
	},
	{
		name: "join",
		description: "加入共享的协作会话",
		inlineHint: "<link>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const link = command.args.trim();
			if (!link) {
				ctx.showError("用法:/join <link>");
				return;
			}
			if (ctx.collabHost) {
				ctx.showError("请先停止主持(/collab stop)");
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError("已处于协作会话中(请先 /leave)");
				return;
			}
			try {
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(`加入协作会话失败:${errorMessage(err)}`);
			}
		},
	},
	{
		name: "leave",
		description: "退出协作会话",
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabHost) return "退出协作:主持中";
			if (runtime.ctx.collabGuest) return "退出协作:访客";
			return "退出协作:不在协作中";
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			if (ctx.collabHost) {
				await ctx.collabHost.stop("host stopped");
				ctx.showStatus("协作已停止");
				return;
			}
			ctx.showStatus("当前不在协作会话中");
		},
	},
	{
		name: "browser",
		description: "切换浏览器无头模式与可见模式",
		acpInputHint: "[headless|visible]",
		subcommands: [
			{ name: "headless", description: "切换到无头模式" },
			{ name: "visible", description: "切换到可见模式" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("browser.enabled" as SettingPath)) return "浏览器:已禁用";
			return runtime.ctx.settings.get("browser.headless" as SettingPath) ? "浏览器:无头" : "浏览器:可见";
		},
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = runtime.settings.get("browser.enabled" as SettingPath) as boolean;
			if (!enabled) return usage("浏览器工具已禁用(请在设置中启用)。", runtime);
			const current = runtime.settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage("用法:/browser [headless|visible]", runtime);
			runtime.settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (err) {
					// Setting was already mutated; surface the restart failure so the
					// user knows the browser is in an inconsistent state.
					await runtime.output(
						`浏览器模式已设置为${next ? "无头" : "可见"},但重启失败:${errorMessage(err)}`,
					);
					return commandConsumed();
				}
			}
			await runtime.output(`浏览器模式:${next ? "无头" : "可见"}`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = settings.get("browser.headless" as SettingPath) as boolean;
			let next = current;
			if (!(settings.get("browser.enabled" as SettingPath) as boolean)) {
				runtime.ctx.showWarning("浏览器工具已禁用(请在设置中启用)");
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus("用法:/browser [headless|visible]");
				runtime.ctx.editor.setText("");
				return;
			}
			settings.set("browser.headless" as SettingPath, next as SettingValue<SettingPath>);
			const tool = runtime.ctx.session.getToolByName("browser");
			if (tool && "restartForModeChange" in tool) {
				try {
					await (tool as { restartForModeChange: () => Promise<void> }).restartForModeChange();
				} catch (error) {
					runtime.ctx.showWarning(`重启浏览器失败:${errorMessage(error)}`);
					runtime.ctx.editor.setText("");
					return;
				}
			}
			runtime.ctx.showStatus(`浏览器模式:${next ? "无头" : "可见"}`);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "copy",
		description: "从对话中选择要复制的文本或代码",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.session.messages);
				if (!block) {
					runtime.ctx.showStatus("没有可复制的代码块。");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus("已将代码块复制到剪贴板");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.session.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus("没有可复制的命令。");
					runtime.ctx.editor.setText("");
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(`已将${lastCommand.kind === "bash" ? "bash 命令" : "eval 代码"}复制到剪贴板`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法:/copy [code|cmd]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "todo",
		description: "查看或修改 Agent 的待办列表",
		acpDescription: "管理待办",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "在 $EDITOR 中打开待办(Markdown 往返)" },
			{ name: "copy", description: "将待办以 Markdown 复制到剪贴板" },
			{ name: "export", description: "将待办以 Markdown 写入文件(默认:TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "从 Markdown 文件替换待办(默认:TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "追加一个任务;阶段模糊匹配或自动创建",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "将任务标记为 in_progress(模糊匹配)", usage: "<task>" },
			{ name: "done", description: "将任务/阶段/全部标记为已完成(模糊匹配)", usage: "[<task|phase>]" },
			{ name: "drop", description: "将任务/阶段/全部标记为已放弃(模糊匹配)", usage: "[<task|phase>]" },
			{ name: "rm", description: "移除任务/阶段/全部(模糊匹配)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "待办:无";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return `待办:${pending + inProgress} 项未完成(${inProgress} 项进行中,${completed} 项已完成)`;
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "session",
		description: "会话管理命令",
		acpDescription: "显示或配置当前会话",
		acpInputHint: "[info|delete|pin [account]]",
		subcommands: [
			{ name: "info", description: "显示会话信息和统计" },
			{ name: "delete", description: "删除当前会话并返回选择器" },
			{
				name: "pin",
				description: "将当前提供商固定到已存储的 OAuth 账户",
				usage: "[account]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						`会话:${runtime.session.sessionId}`,
						`标题:${runtime.session.sessionName}`,
						`CWD:${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming) return usage("流式输出期间无法删除会话。", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("没有可删除的会话文件(内存会话)。", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`删除会话失败:${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`会话已删除:${sessionFile}。请使用 ACP \`session/load\` 切换到其他会话。`,
				);
				return commandConsumed();
			}
			if (verb === "pin") {
				await handleSessionPinCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("用法:/session [info|delete|pin [account]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				runtime.ctx.editor.setText("");
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			if (verb === "pin") {
				if (rest) {
					await handleSessionPinCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
					refreshStatusLine(runtime.ctx);
				} else {
					await runtime.ctx.showSessionPinSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus("用法:/session [info|delete|pin [account]]");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "jobs",
		description: "显示异步后台任务状态",
		acpDescription: "显示后台任务",
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) return "任务:无";
			return `任务:${snapshot.running.length} 个运行中,${snapshot.recent.length} 个最近`;
		},
		handle: async (_command, runtime) => {
			const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
				await runtime.output(
					"当前没有运行中的后台任务。(后台任务用于运行异步工具——例如长时间运行的 bash、debug 或 task 子代理,否则它们会占用整个轮次。任务在存活期间及结束后约 5 分钟内显示在这里。)",
				);
				return commandConsumed();
			}
			const now = Date.now();
			const lines: string[] = ["后台任务", `运行中:${snapshot.running.length}`];
			if (snapshot.running.length > 0) {
				lines.push("", "运行中的任务");
				for (const job of snapshot.running) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			if (snapshot.recent.length > 0) {
				lines.push("", "最近的任务");
				for (const job of snapshot.recent) {
					lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
					lines.push(`    ${job.label}`);
				}
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleJobsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "usage",
		description: "显示提供商用量和限制",
		acpDescription: "显示 token 用量",
		acpInputHint: "[show|reset [account|active]]",
		subcommands: [
			{ name: "show", description: "显示提供商用量和限制" },
			{ name: "reset", description: "消耗一次已保存的 Codex 限速重置", usage: "[account|active]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("用法:/usage [show|reset [account|active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				runtime.ctx.editor.setText("");
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法:/usage [show|reset [account|active]]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "stats",
		description: "启动本地统计仪表盘",
		inlineHint: "[--port <port>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output("正在同步会话文件...");
			try {
				const result = await launchStatsDashboard(parsed);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(`统计仪表盘失败:${errorMessage(error)}`);
			}
			return commandConsumed();
		},
	},
	{
		name: "changelog",
		description: "显示更新日志条目",
		acpDescription: "显示更新日志",
		acpInputHint: "[full]",
		subcommands: [{ name: "full", description: "显示完整更新日志" }],
		allowArgs: true,
		handle: async (command, runtime) => {
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const showFull = command.args.trim().toLowerCase() === "full";
			const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
			if (entriesToShow.length === 0) {
				await runtime.output("未找到更新日志条目。");
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const showFull = command.args.split(/\s+/).filter(Boolean).includes("full");
			await runtime.ctx.handleChangelogCommand(showFull);
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "hotkeys",
		description: "显示所有键盘快捷键",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "tools",
		description: "显示当前对 Agent 可见的工具",
		acpDescription: "显示可用工具",
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0 ? "工具:无可用" : `工具:${active} 个激活 / ${all} 个可用`;
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("没有可用工具。");
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "context",
		description: "显示估算的上下文用量明细",
		acpDescription: "显示上下文用量",
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return "上下文:不可用";
			return `上下文:${Math.round(usage.percent)}% (${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)})`;
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		description: "打开扩展控制中心仪表盘",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "agents",
		description: "打开 Agent 控制中心仪表盘",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "branch",
		description: "从之前的消息创建新分支",
		handleTui: (_command, runtime) => {
			if (settings.get("doubleEscapeAction") === "tree") {
				runtime.ctx.showTreeSelector();
			} else {
				runtime.ctx.showUserMessageSelector();
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "fork",
		description: "从之前的消息创建新分叉",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		description: "浏览会话树(切换分支)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "login",
		description: "使用 OAuth 提供商登录",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? `登录:等待 ${runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth"} 回调`
				: "登录:选择提供商",
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `${pendingProvider} 的 OAuth 登录已在进行中。请使用 /login <url> 粘贴重定向 URL。`
							: "OAuth 登录已在进行中。请使用 /login <url> 粘贴重定向 URL。";
						runtime.ctx.showWarning(message);
						runtime.ctx.editor.setText("");
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					runtime.ctx.editor.setText("");
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("已收到 OAuth 回调,正在完成登录…");
				} else {
					runtime.ctx.showWarning("当前没有等待手动回调的 OAuth 登录。");
				}
				runtime.ctx.editor.setText("");
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `${provider} 的 OAuth 登录已在进行中。请使用 /login <url> 粘贴重定向 URL。`
					: "OAuth 登录已在进行中。请使用 /login <url> 粘贴重定向 URL。";
				runtime.ctx.showWarning(message);
				runtime.ctx.editor.setText("");
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "logout",
		description: "退出 OAuth 提供商登录",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`未知的 OAuth 提供商:${providerId}`);
					runtime.ctx.editor.setText("");
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				runtime.ctx.editor.setText("");
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "mcp",
		description: "管理 MCP 服务器(添加、列出、移除、测试)",
		acpDescription: "管理 MCP 服务器",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "添加新的 MCP 服务器",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "列出所有已配置的 MCP 服务器" },
			{ name: "remove", description: "移除一个 MCP 服务器", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "测试与服务器的连接", usage: "<name>" },
			{ name: "reauth", description: "重新授权服务器的 OAuth", usage: "<name>" },
			{ name: "unauth", description: "移除服务器的 OAuth 认证", usage: "<name>" },
			{ name: "enable", description: "启用一个 MCP 服务器", usage: "<name>" },
			{ name: "disable", description: "禁用一个 MCP 服务器", usage: "<name>" },
			{
				name: "smithery-search",
				description: "在 Smithery 注册表中搜索并部署 MCP 服务器",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "登录 Smithery 并缓存 API 密钥" },
			{ name: "smithery-logout", description: "移除缓存的 Smithery API 密钥" },
			{ name: "reconnect", description: "重新连接到指定的 MCP 服务器", usage: "<name>" },
			{ name: "reload", description: "强制重新加载 MCP 运行时工具" },
			{ name: "resources", description: "列出已连接服务器提供的可用资源" },
			{ name: "prompts", description: "列出已连接服务器提供的可用提示词" },
			{ name: "notifications", description: "显示通知能力和订阅" },
			{ name: "help", description: "显示帮助信息" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
	{
		name: "ssh",
		description: "管理 SSH 主机(添加、列出、移除)",
		acpDescription: "管理 SSH 连接",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "添加一个 SSH 主机",
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
			},
			{ name: "list", description: "列出所有已配置的 SSH 主机" },
			{ name: "remove", description: "移除一个 SSH 主机", usage: "<name> [--scope project|user]" },
			{ name: "help", description: "显示帮助信息" },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		description: "开始新会话",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleClearCommand();
		},
	},
	{
		name: "fresh",
		description: "重置提供商流式状态,不更改本地记录",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? "全新会话:流式输出期间不可用" : "全新会话:就绪",
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					"请等待当前响应完成或中止它,然后再刷新提供商状态。",
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "clear",
		description: "就地清除对话上下文,保留会话",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? "清除:流式输出期间不可用" : "清除:丢弃上下文,保留会话",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleResetContextCommand();
		},
	},
	{
		name: "drop",
		description: "删除当前会话并开始新会话",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleDropCommand();
		},
	},
	{
		name: "compact",
		description: "手动压缩会话上下文",
		acpDescription: "压缩对话",
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: mode.rejectsFocus ? undefined : "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage ? `压缩:上下文已使用 ${Math.round(usage.percent)}%` : "压缩:上下文不可用";
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(`压缩失败:${errorMessage(err)}`, runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(`压缩完成。Token:${beforeTokens} -> ${afterTokens}(节省 ${saved})。`);
			} else {
				await runtime.output("压缩完成。");
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			runtime.ctx.editor.setText("");
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "shake",
		description: "从上下文中丢弃重内容(工具结果、大块内容)",
		acpDescription: "从对话上下文中抖掉重内容",
		subcommands: [
			{ name: "elide", description: "剥离工具结果和大块内容(默认)" },
			{ name: "images", description: "剥离图像块" },
		],
		acpInputHint: "[elide|images]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		description: "将会话上下文移交给新会话",
		inlineHint: "[focus instructions]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	{
		name: "resume",
		description: "恢复另一个会话",
		inlineHint: "[session id|@claude|@codex]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			runtime.ctx.editor.setText("");
			const foreignSource = sessionArg === "@claude" ? "claude" : sessionArg === "@codex" ? "codex" : undefined;
			if (foreignSource) {
				runtime.ctx.showSessionSelector(foreignSource);
				return;
			}
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const match = await resolveResumableSession(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!match) {
				runtime.ctx.showError(`未找到会话 "${sessionArg}"`);
				return;
			}
			await runtime.ctx.handleResumeSession(match.session.path);
		},
	},
	{
		name: "btw",
		description: "使用当前会话上下文提出一个临时的附带问题",
		inlineHint: "<question>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleBtwCommand(question);
		},
	},
	{
		name: "tan",
		description: "在附带工作上运行一个完整后台 Agent",
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleTanCommand(work);
		},
	},
	{
		name: "omfg",
		description: "根据投诉锻造一条 TTSR 规则以阻止重复行为",
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "retry",
		description: "重试最后一次失败的 Agent 轮次",
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("没有可重试的内容");
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "debug",
		description: "打开调试工具选择器",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "memory",
		description: "检查并操作记忆维护",
		acpDescription: "管理记忆",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: "显示当前记忆注入内容" },
			{ name: "stats", description: "显示记忆后端统计" },
			{ name: "diagnose", description: "运行记忆后端诊断" },
			{ name: "clear", description: "清除已持久化的记忆数据和产物" },
			{ name: "reset", description: "clear 的别名" },
			{ name: "enqueue", description: "将记忆整合维护加入队列" },
			{ name: "rebuild", description: "enqueue 的别名" },
			{ name: "mm list", description: "列出活动记忆库中的心智模型" },
			{ name: "mm show", description: "显示一个心智模型(需要 id)" },
			{
				name: "mm refresh",
				description: "刷新整个记忆库的自动刷新模型,或按 id 刷新单个模型",
			},
			{ name: "mm history", description: "查看心智模型变更历史的差异" },
			{ name: "mm seed", description: "创建缺失的内置心智模型" },
			{ name: "mm delete", description: "从记忆库中删除心智模型(需要 id)" },
			{ name: "mm reload", description: "重新拉取缓存的 <mental_models> 块" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "记忆注入内容为空。");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output("记忆已清除。");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("记忆整合已加入队列。");
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? memoryStatsUnavailableMessage(backend.id, verb));
					return commandConsumed();
				}
				case "mm":
					return usage(
						"在 ACP 模式下不支持通过 /memory mm 进行心智模型维护;请直接使用 hindsight HTTP API。",
						runtime,
					);
				default:
					return usage("用法:/memory <view|stats|diagnose|clear|reset|enqueue|rebuild>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		description: "重命名当前会话",
		inlineHint: "<title>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (!command.args) return usage("用法:/rename <title>", runtime);
			const ok = await runtime.sessionManager.setSessionName(command.args, "user");
			if (!ok) {
				await runtime.output("会话名称未更改(用户设置的名称优先)。");
				return commandConsumed();
			}
			await runtime.notifyTitleChanged?.();
			await runtime.output(`会话已重命名为 ${command.args}。`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const title = command.args.trim();
			if (!title) {
				runtime.ctx.showError("用法:/rename <title>");
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		description: "将当前会话移动到其他目录",
		acpDescription: "将当前会话移动到其他目录",
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("流式输出期间无法移动。", runtime);
			if (!command.args) return usage("用法:/move <path>", runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(`不是目录:${resolvedPath}`, runtime);
				}
			} catch {
				return usage(`目录不存在:${resolvedPath}`, runtime);
			}
			try {
				await runtime.settings.flush();
			} catch (err) {
				return usage(`保存待定设置失败:${errorMessage(err)}`, runtime);
			}
			try {
				await runtime.session.moveSession(resolvedPath);
			} catch (err) {
				return usage(`移动失败:${errorMessage(err)}`, runtime);
			}
			setProjectDir(resolvedPath);
			await runtime.settings.reloadForCwd(resolvedPath);
			applyProviderGlobalsFromSettings(runtime.settings);
			// Reload plugin/capability caches so the next prompt sees commands and
			// capabilities scoped to the new cwd.
			await runtime.reloadPlugins();
			await runtime.notifyConfigChanged?.();
			await runtime.notifyTitleChanged?.();
			await runtime.output(`已移动到 ${runtime.sessionManager.getCwd()}。`);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	{
		name: "add-dir",
		description: "向本会话添加工作区目录(多根)",
		acpDescription: "向本会话添加工作区目录",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("流式输出期间无法添加目录。", runtime);
			if (!command.args) return usage(formatWorkspaceDirectories(runtime, "用法:/add-dir <path>"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(`不是目录:${resolved}`, runtime);
			} catch {
				return usage(`目录不存在:${resolved}`, runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(`已在工作区中:${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `已添加 ${added}。`));
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		description: "从本会话移除工作区目录",
		acpDescription: "从本会话移除工作区目录",
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage("流式输出期间无法移除目录。", runtime);
			if (!command.args) return usage("用法:/remove-dir <path>", runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage("无法移除工作目录;请使用 /move 更改它。", runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(`不是工作区目录:${resolved}`);
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `已移除 ${removed}。`));
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		description: "列出本会话的工作区目录",
		acpDescription: "列出本会话的工作区目录",
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		description: "退出应用程序",
		handleTui: shutdownHandlerTui,
	},
	{
		name: "marketplace",
		description: "管理市场插件源和已安装插件",
		acpDescription: "管理来自市场的插件",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "添加市场源", usage: "<source>" },
			{ name: "remove", description: "移除市场源", usage: "<name>" },
			{ name: "update", description: "更新市场目录", usage: "[name]" },
			{ name: "list", description: "列出已配置的市场" },
			{ name: "discover", description: "浏览可用插件", usage: "[marketplace]" },
			{
				name: "install",
				description: "安装插件(无参数时打开交互式浏览器)",
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: "卸载插件(无参数时打开选择器)", usage: "[name@marketplace]" },
			{ name: "installed", description: "列出已安装的市场插件" },
			{ name: "upgrade", description: "升级过时的插件", usage: "[name@marketplace]" },
			{ name: "help", description: "显示使用指南" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(
							"未配置市场。\n\n开始使用:\n  /marketplace add anthropics/claude-plugins-official\n\n然后用 /marketplace discover 浏览",
						);
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(
							`市场:\n${lines.join("\n")}\n\n使用 /marketplace discover 浏览插件,或使用 /marketplace help 查看所有命令`,
						);
					}
					return commandConsumed();
				} catch (err) {
					return usage(`市场错误:${errorMessage(err)}`, runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					[
						"市场命令:",
						"  /marketplace                              列出已配置的市场",
						"  /marketplace add <source>                  添加市场(例如 owner/repo)",
						"  /marketplace remove <name>                 移除市场",
						"  /marketplace update [name]                 重新获取目录",
						"  /marketplace list                          列出已配置的市场",
						"  /marketplace discover [marketplace]        浏览可用插件",
						"  /marketplace install <name@marketplace>    安装插件",
						"  /marketplace uninstall <name@marketplace>  卸载插件",
						"  /marketplace installed                     列出已安装的插件",
						"  /marketplace upgrade [name@marketplace]    升级插件",
						"",
						"快速开始:",
						"  /marketplace add anthropics/claude-plugins-official",
					].join("\n"),
				);
				return commandConsumed();
			}
			if ((verb === "install" || verb === "uninstall") && !rest) {
				return usage(
					"交互式插件选择器仅限 TUI。请传入显式的 name@marketplace 参数。",
					runtime,
				);
			}
			try {
				const manager = await createMarketplaceManager(runtime);
				switch (verb) {
					case "add": {
						if (!rest) return usage("用法:/marketplace add <source>", runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(`已添加市场:${entry.name}`);
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage("用法:/marketplace remove <name>", runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(`已移除市场:${rest}`);
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(`已更新市场:${rest}`);
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(`已更新 ${results.length} 个市场`);
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output("未配置市场。");
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(`市场:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "discover": {
						const plugins = await manager.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await manager.listMarketplaces();
							await runtime.output(
								marketplaces.length === 0
									? "未配置市场。请尝试:\n  /marketplace add anthropics/claude-plugins-official"
									: "已配置的市场中没有可用插件",
							);
							return commandConsumed();
						}
						const lines = ["可用插件:"];
						for (const plugin of plugins) {
							lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
							if (plugin.description) lines.push(`      ${plugin.description}`);
						}
						await runtime.output(lines.join("\n"));
						return commandConsumed();
					}
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) return usage(parsed.error, runtime);
						const atIndex = parsed.installSpec.lastIndexOf("@");
						const pluginName = parsed.installSpec.slice(0, atIndex);
						const marketplace = parsed.installSpec.slice(atIndex + 1);
						await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.reloadPlugins();
						await runtime.output(`已从 ${marketplace} 安装 ${pluginName}`);
						return commandConsumed();
					}
					case "uninstall": {
						const parsed = parsePluginScopeArgs(
							rest,
							"用法:/marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(`已卸载 ${parsed.pluginId}`);
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output("未安装市场插件");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							await runtime.output(`已安装的插件:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "upgrade": {
						if (rest) {
							const parsed = parsePluginScopeArgs(
								rest,
								"用法:/marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in parsed) return usage(parsed.error, runtime);
							const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
							await runtime.reloadPlugins();
							await runtime.output(`已将 ${parsed.pluginId} 升级到 ${result.version}`);
							return commandConsumed();
						}
						const results = await manager.upgradeAllPlugins();
						if (results.length === 0) {
							await runtime.output("所有市场插件都是最新的");
						} else {
							await runtime.reloadPlugins();
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(`已升级 ${results.length} 个插件:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					default:
						return usage(
							`未知的 /marketplace 子命令:${verb}。请使用 /marketplace help 查看可用命令。`,
							runtime,
						);
				}
			} catch (err) {
				return usage(`市场错误:${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				try {
					runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(`市场错误:${err}`);
				}
				return;
			}

			const mgr = new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
					runtime.ctx.sessionManager.getCwd(),
				),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});

			try {
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus("用法:/marketplace add <source>");
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(`已添加市场:${entry.name}`);
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus("用法:/marketplace remove <name>");
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(`已移除市场:${rest}`);
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(`已更新市场:${rest}`);
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(`已更新 ${results.length} 个市场`);
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(
									"未配置市场。请尝试:\n  /marketplace add anthropics/claude-plugins-official",
								);
							} else {
								runtime.ctx.showStatus("已配置的市场中没有可用插件");
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(`可用插件:\n${lines.join("\n")}`);
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						runtime.ctx.showStatus(`已从 ${marketplace} 安装 ${name}`);
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							runtime.ctx.showPluginSelector("uninstall");
							return;
						}
						const uninstArgs = parsePluginScopeArgs(
							rest,
							"用法:/marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(`已卸载 ${uninstArgs.pluginId}`);
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus("未安装市场插件");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							runtime.ctx.showStatus(`已安装的插件:\n${lines.join("\n")}`);
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(
								rest,
								"用法:/marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							runtime.ctx.showStatus(`已将 ${upArgs.pluginId} 升级到 ${result.version}`);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus("所有市场插件都是最新的");
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(`已升级 ${results.length} 个插件:\n${lines.join("\n")}`);
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							[
								"市场命令:",
								"  /marketplace                              浏览并安装插件",
								"  /marketplace add <source>                  添加市场(例如 owner/repo)",
								"  /marketplace remove <name>                 移除市场",
								"  /marketplace update [name]                 重新获取目录",
								"  /marketplace list                          列出已配置的市场",
								"  /marketplace discover [marketplace]        浏览可用插件",
								"  /marketplace install <name@marketplace>    安装插件",
								"  /marketplace uninstall <name@marketplace>  卸载插件",
								"  /marketplace installed                     列出已安装的插件",
								"  /marketplace upgrade [name@marketplace]    升级插件",
								"",
								"快速开始:",
								"  /marketplace add anthropics/claude-plugins-official",
								"  /marketplace                               (打开交互式浏览器)",
							].join("\n"),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(
								"未配置市场。\n\n开始使用:\n  /marketplace add anthropics/claude-plugins-official\n\n然后用 /marketplace 或 /marketplace discover 浏览插件",
							);
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(
								`市场:\n${lines.join("\n")}\n\n使用 /marketplace discover 浏览插件,或使用 /marketplace help 查看所有命令`,
							);
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(`市场错误:${msg}`);
			}
		},
	},
	{
		name: "plugins",
		description: "查看并管理已安装插件",
		acpDescription: "管理插件",
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: "列出所有已安装插件(npm + 市场)" },
			{ name: "enable", description: "启用市场插件", usage: "<name@marketplace>" },
			{ name: "disable", description: "禁用市场插件", usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(
						rest,
						`用法:/plugins ${verb} [--scope user|project] <name@marketplace>`,
					);
					if ("error" in parsed) return usage(parsed.error, runtime);
					const manager = await createMarketplaceManager(runtime);
					const isEnable = verb === "enable";
					await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
					await runtime.reloadPlugins();
					await runtime.output(`${isEnable ? "已启用" : "已禁用"} ${parsed.pluginId}`);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push("npm 插件:");
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? "(已禁用)" : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("市场插件:");
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? "(已禁用)" : "";
						const shadowed = plugin.shadowedBy ? " [shadowed]" : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? "未安装插件" : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`插件错误:${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "list";
			const rest = args.slice(1).join(" ").trim();

			try {
				const mgr = new MarketplaceManager({
					marketplacesRegistryPath: getMarketplacesRegistryPath(),
					installedRegistryPath: getInstalledPluginsRegistryPath(),
					projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(
						runtime.ctx.sessionManager.getCwd(),
					),
					marketplacesCacheDir: getMarketplacesCacheDir(),
					pluginsCacheDir: getPluginsCacheDir(),
					clearPluginRootsCache: clearPluginRootsAndCaches,
				});

				switch (sub) {
					case "enable":
					case "disable": {
						const parsed = parsePluginScopeArgs(
							rest ?? "",
							`用法:/plugins ${sub} [--scope user|project] <name@marketplace>`,
						);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const isEnable = sub === "enable";
						await mgr.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
						runtime.ctx.showStatus(`${isEnable ? "已启用" : "已禁用"} ${parsed.pluginId}`);
						break;
					}
					default: {
						const lines: string[] = [];

						const npm = new PluginManager();
						const npmPlugins = await npm.list();
						if (npmPlugins.length > 0) {
							lines.push("npm 插件:");
							for (const p of npmPlugins) {
								const status = p.enabled === false ? "(已禁用)" : "";
								lines.push(`  ${p.name}@${p.version}${status}`);
							}
						}

						const mktPlugins = await mgr.listInstalledPlugins();
						if (mktPlugins.length > 0) {
							if (lines.length > 0) lines.push("");
							lines.push("市场插件:");
							for (const p of mktPlugins) {
								const entry = p.entries[0];
								const status = entry?.enabled === false ? "(已禁用)" : "";
								const shadowed = p.shadowedBy ? " [shadowed]" : "";
								lines.push(`  ${p.id} v${entry?.version ?? "?"}${status} [${p.scope}]${shadowed}`);
							}
						}

						if (lines.length === 0) {
							runtime.ctx.showStatus("未安装插件");
						} else {
							runtime.ctx.showStatus(lines.join("\n"));
						}
						break;
					}
				}
			} catch (err) {
				runtime.ctx.showStatus(`插件错误:${err}`);
			}
		},
	},
	{
		name: "reload-plugins",
		description: "重新加载所有插件(技能、命令、钩子、工具、Agent、MCP)",
		acpDescription: "重新加载所有插件",
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output("插件已重新加载。");
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await reloadTuiPluginState(runtime.ctx);
			runtime.ctx.showStatus("插件已重新加载。");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		description: "强制下一轮使用指定工具",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "强制:无激活工具" : `强制:${count} 个激活工具`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("用法:/force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`下一轮已强制使用 ${toolName}。`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("用法:/force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`下一轮已强制使用 ${toolName}。`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		description: "启动由 Codex 驱动的实时语音模式",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "pause",
		description: "冻结所有 Agent(主 Agent、子代理、顾问),直到恢复",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		description: "退出应用程序",
		handleTui: shutdownHandlerTui,
	},
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 */
function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/** /mcp subcommands whose argument is a server name (per their `usage: "<name>..."`). */
const MCP_SERVER_NAME_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	test: true,
	remove: true,
	reconnect: true,
	reauth: true,
	unauth: true,
};

/** Subcommands that accept names found only in `userConfig.disabledServers`. */
const MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
};

/**
 * Subcommands that accept configured servers whose `enabled` flag is false.
 * `unauth` can clear persisted credentials without connecting; test,
 * reconnect, and reauth explicitly require an enabled server.
 */
const MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	unauth: true,
};

/**
 * Build getArgumentCompletions for /mcp. Delegates to the generic
 * declarative subcommand completer while the subcommand name itself is
 * still being typed, then switches to MCP server-name completion (sourced
 * from {@link collectMcpServerNames}) once a recognized server-name
 * subcommand (enable/disable/test/remove/reconnect/reauth/unauth) is
 * followed by a space. `remove` gets its own scope-aware completions (see
 * {@link buildMcpRemoveCompletions}) since — unlike the others —
 * it only ever succeeds against a config-file entry. Subcommands with a
 * different argument shape (add, smithery-search, ...) get no argument
 * completion.
 */
function buildMcpArgumentCompletions(
	subcommands: SubcommandDef[],
	runtime: TuiSlashCommandRuntime,
): (argumentPrefix: string) => Promise<AutocompleteItem[] | null> {
	const genericCompletions = buildArgumentCompletions(subcommands);
	return async (argumentPrefix: string) => {
		const spaceIndex = argumentPrefix.indexOf(" ");
		if (spaceIndex === -1) return genericCompletions(argumentPrefix);

		const rawSubcommand = argumentPrefix.slice(0, spaceIndex);
		const lowerSubcommand = rawSubcommand.toLowerCase();
		if (MCP_SERVER_NAME_SUBCOMMANDS[lowerSubcommand] !== true) return null;
		const namePrefix = argumentPrefix.slice(spaceIndex + 1).toLowerCase();
		if (lowerSubcommand === "remove") {
			return await buildMcpRemoveCompletions(rawSubcommand, namePrefix);
		}

		let serverNames: string[];
		try {
			serverNames = await collectMcpServerNames(
				runtime.ctx,
				undefined,
				MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
				MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
			);
		} catch (error) {
			logger.warn("MCP server-name autocomplete failed to read config", { error });
			return null;
		}
		const matches: AutocompleteItem[] = serverNames
			.filter(name => name.toLowerCase().startsWith(namePrefix))
			.map(name => ({ value: `${rawSubcommand} ${name} `, label: name }));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build `/mcp remove <name>` completions. Unlike the other server-name
 * subcommands, `#handleRemove` only ever succeeds against a config-file
 * `mcpServers` entry in the target scope (project by default, user with an
 * explicit `--scope user`) — a purely runtime-discovered server has no
 * config entry to remove and always fails with `Server "<name>" not found
 * in <scope> config.`. Completions are therefore restricted to config-file
 * names, and a name that exists only in the user config is completed with
 * `--scope user` appended so the inserted command is directly executable.
 */
async function buildMcpRemoveCompletions(
	rawSubcommand: string,
	namePrefix: string,
): Promise<AutocompleteItem[] | null> {
	const cwd = getProjectDir();
	let projectNames: string[];
	let userNames: string[];
	try {
		const [projectConfig, userConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
		]);
		projectNames = Object.keys(projectConfig.mcpServers ?? {});
		userNames = Object.keys(userConfig.mcpServers ?? {});
	} catch (error) {
		logger.warn("MCP remove autocomplete failed to read config", { error });
		return null;
	}

	const projectNameSet = new Set(projectNames);
	const allNames = new Set([...projectNames, ...userNames]);
	const matches: AutocompleteItem[] = [...allNames]
		.filter(name => name.toLowerCase().startsWith(namePrefix))
		.map(name =>
			projectNameSet.has(name)
				? { value: `${rawSubcommand} ${name} `, label: name }
				: { value: `${rawSubcommand} ${name} --scope user `, label: `${name}(用户)` },
		)
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
	return matches.length > 0 ? matches : null;
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 */
function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (
			prefix === "" ||
			prefix === "." ||
			prefix === "./" ||
			prefix === ".." ||
			prefix === "../" ||
			prefix === "~" ||
			prefix === "~/" ||
			prefix === "/"
		) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else if (expandedPrefix.endsWith("/")) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else {
			const dir = path.dirname(expandedPrefix);
			searchDir = isAbsolute ? dir : path.join(cwd, dir);
			searchPrefix = path.basename(expandedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			return null;
		}
	};
}
function buildDirectoryCompletionDisplayValue(prefix: string, absoluteValue: string, cwd: string): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix.startsWith("~/")) {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "~") {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("/")) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("./")) {
		const relative = path.relative(cwd, normalized);
		return `./${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("../")) {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "..") {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}

	// Default: relative to cwd.
	const relative = path.relative(cwd, normalized);
	return `${relative.replaceAll("\\", "/")}/`;
}

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Reload the interactive session's plugin runtime: invalidate fs/plugin-root
 * caches, rediscover skills and file slash commands, reset the capability
 * cache, and reconnect MCP servers (rebinding the session's MCP tools). Shared
 * by `/reload-plugins`'s TUI handler and the `handle`-adapter's `reloadPlugins`
 * hook so both honor the command's documented MCP reload scope (#7189).
 */
async function reloadTuiPluginState(ctx: InteractiveModeContext): Promise<void> {
	const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	await ctx.refreshSkillState();
	await ctx.refreshSlashCommandState();
	resetCapabilities();
	if (ctx.mcpManager) {
		await new MCPCommandController(ctx).reloadServers();
	}
}

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} 在协作会话中仅限主持人使用`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
