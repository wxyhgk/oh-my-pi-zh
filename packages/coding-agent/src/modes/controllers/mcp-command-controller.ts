/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import * as path from "node:path";
import { type Component, replaceTabs, Spacer, Text } from "@wxyhgk/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@wxyhgk/pi-utils";
import type { SourceMeta } from "../../capability/types";
import { expandEnvVarsDeep } from "../../discovery/helpers";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	loadAllMCPConfigs,
	MCPManager,
	type OAuthEndpoints,
} from "../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import {
	lookupMcpOAuthCredentialForServer,
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../mcp/oauth-credentials";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	getSmitheryLoginUrl,
	pollSmitheryCliAuthSession,
	type SmitheryCliPollResponse,
	saveSmitheryApiKey,
} from "../../mcp/smithery-auth";
import { SmitheryConnectError } from "../../mcp/smithery-connect";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../mcp/smithery-registry";
import type {
	MCPAuthChallenge,
	MCPAuthConfig,
	MCPConfigFile,
	MCPServerConfig,
	MCPServerConnection,
} from "../../mcp/types";
import { shortenPath } from "../../tools/render-utils";
import { urlHyperlinkAlways } from "../../tui";
import { copyToClipboard } from "../../utils/clipboard";
import { isTimeoutError } from "../../utils/fetch-timeout";
import { openPath } from "../../utils/open";
import { ChatBlock } from "../components/chat-block";
import { MCPAddWizard } from "../components/mcp-add-wizard";
import { TranscriptBlock } from "../components/transcript-container";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { groupBySource, parseRemoveArgs, readScopeFlag, showCommandMessage } from "./command-controller-shared";

const MCP_MANUAL_INPUT_PROVIDER_ID = "mcp";
const MCP_MANUAL_LOGIN_TIP = "无头环境?请使用 /login <value> 粘贴重定向 URL 或代码。";
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout?: () => void): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, createError: () => Error): Promise<T> {
	if (signal.aborted) return Promise.reject(createError());

	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

/**
 * Minimum column budget for URL wrapping. Below this the terminal is
 * effectively unusable, but we still emit chunks so no character is silently
 * dropped and the user can widen and reflow.
 */
const MCP_AUTH_MIN_WRAP_WIDTH = 16;

/**
 * Wrap `url` into rows that each fit inside `width`. When the label + URL fit
 * on one line, returns a single indented row; otherwise puts the label on its
 * own indented row and slices the URL into fixed-width chunks that start at
 * column 0. Continuation chunks carry ZERO leading bytes on purpose: a
 * multi-row terminal selection includes the newline plus any leading indent,
 * and while address bars strip newlines they preserve or percent-encode
 * embedded spaces — an indent would corrupt the URL at every chunk boundary
 * (silently, when the damage lands inside a query value).
 */
function wrapUrlRows(label: string, url: string, width: number): string[] {
	const indent = " ";
	const sanitized = replaceTabs(url);
	const effective = Math.max(MCP_AUTH_MIN_WRAP_WIDTH, Math.trunc(width));
	const inlineWidth = indent.length + label.length + 1 + sanitized.length;
	if (inlineWidth <= effective) {
		return [`${indent}${theme.fg("muted", `${label} ${sanitized}`)}`];
	}
	const rows: string[] = [`${indent}${theme.fg("muted", label)}`];
	for (let i = 0; i < sanitized.length; i += effective) {
		rows.push(theme.fg("muted", sanitized.slice(i, i + effective)));
	}
	return rows;
}

/**
 * Renders the MCP OAuth fallback URL. Always shows the full authorization URL
 * as the primary `Copy URL:` target — that works from any machine, including
 * SSH/WSL/headless sessions where the OMP-hosted `/launch` loopback URL would
 * resolve against the user's local browser and fail.
 *
 * The render is `width`-aware: on any viewport narrower than the composed row
 * ({@link TUI#prepareLine} truncates anything wider with `Ellipsis.Omit`, no
 * marker), the URL is hard-wrapped into width-fitted rows so the primary copy
 * target can never silently lose trailing OAuth parameters — the failure mode
 * that motivated #4418 in the first place. Browsers strip whitespace when a
 * multi-row selection is pasted into the address bar, so the reassembled URL
 * is byte-identical to what we rendered.
 *
 * When the flow's callback server hosts a short `launchUrl`, it is offered
 * as an additional local shortcut for wide-terminal local users. The OSC 8
 * hyperlink continues to carry the full URL for terminals that support it.
 */
export class MCPAuthorizationLinkPrompt implements Component {
	readonly #fullUrl: string;
	readonly #launchUrl: string | undefined;

	constructor(url: string, launchUrl?: string) {
		this.#fullUrl = url;
		this.#launchUrl = launchUrl && launchUrl !== url ? launchUrl : undefined;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const link = urlHyperlinkAlways(this.#fullUrl, "点击此处授权");
		const lines: string[] = [
			` ${theme.fg("success", "打开授权 URL:")}`,
			` ${theme.fg("accent", link)}`,
			...wrapUrlRows("复制 URL:", this.#fullUrl, width),
		];
		if (this.#launchUrl) {
			lines.push(...wrapUrlRows("本地快捷方式(仅限本机):", this.#launchUrl, width));
		}
		return lines;
	}
}

/**
 * Animated "Connecting to …" transcript block. Owns its spinner interval: it
 * starts on mount and is cleared on {@link ChatBlock.finish}/dispose, so callers
 * never juggle `setInterval`/`clearInterval` or `requestRender` by hand.
 */
class McpConnectingBlock extends ChatBlock {
	readonly #text: Text;

	constructor(private readonly serverName: string) {
		super();
		this.addChild(new Spacer(1));
		const frame = theme.spinnerFrames[0] ?? "|";
		this.#text = new Text(theme.fg("muted", `${frame} 正在连接到 "${serverName}"...`), 1, 0);
		this.addChild(this.#text);
	}

	protected override onMount(): void {
		const frames = theme.spinnerFrames;
		let frame = 0;
		const interval = setInterval(() => {
			frame++;
			this.#text.setText(
				theme.fg("muted", `${frames[frame % frames.length] ?? "|"} 正在连接到 "${this.serverName}"...`),
			);
			this.requestRender();
		}, 80);
		this.onCleanup(() => clearInterval(interval));
	}

	/** Replace the spinner line with a terminal status; pair with {@link finish}. */
	setStatus(text: string): void {
		this.#text.setText(text);
		this.requestRender();
	}
}

/**
 * Outcome of {@link MCPCommandController}'s OAuth handler.
 *
 * `credentialId` is deterministic per server URL when the URL was supplied, so
 * every profile resolves its own credential row under the same id. Refresh
 * material (token URL, client id/secret) is embedded in the stored credential;
 * the returned `clientId` may be folded into `mcp.json` for pre-auth reuse.
 * DCR-issued client secrets stay embedded in the stored credential and are
 * deliberately not surfaced here, so they cannot leak into config files.
 */
interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

/**
 * Thrown by {@link MCPCommandController}'s OAuth handler when the user (or a
 * caller-supplied {@link AbortSignal}) cancels the in-flight flow. Distinct
 * from network/timeout failures so callers can surface a neutral
 * "cancelled" status instead of an error banner.
 */
export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth 流程已取消") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

/** Reason recorded on the OAuth flow's AbortController when the user hits Esc. */
const MCP_OAUTH_USER_CANCEL_REASON = "MCP OAuth flow cancelled by user";

type MCPAddScope = "user" | "project";
type MCPAddTransport = "http" | "sse";

type MCPAddParsed = {
	initialName?: string;
	scope: MCPAddScope;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
};

type MCPSearchParsed = {
	keyword: string;
	scope: MCPAddScope;
	limit: number;
	semantic: boolean;
	error?: string;
};

/**
 * Collect the de-duplicated union of every MCP server name we know about:
 * user config, project config, and any runtime-discovered servers not
 * already present in either config (`ctx.mcpManager.getAllServerNames()`
 * covers connections, pending connections, and discovered-but-not-yet-
 * connected sources).
 *
 * `includeDisabledOnly` controls names found only in
 * `userConfig.disabledServers`, while `includeDisabledConfigured` controls
 * config entries whose `enabled` flag is false. Both default to true because
 * callers such as `/mcp list` need the complete union. Autocomplete callers
 * must disable the categories their target operation cannot accept.
 *
 * This is the single source of truth for "every known server name": both
 * `MCPCommandController#handleList()` and the `/mcp` slash-command argument
 * completer (server-name autocomplete for `enable`/`disable`/`test`/etc.)
 * call this instead of re-deriving the union themselves.
 *
 * `preloaded` lets a caller that already read both config files (e.g.
 * `#handleList()`) pass them in and skip the redundant re-read.
 */
export async function collectMcpServerNames(
	ctx: InteractiveModeContext,
	preloaded?: { userConfig: MCPConfigFile; projectConfig: MCPConfigFile },
	includeDisabledOnly = true,
	includeDisabledConfigured = true,
): Promise<string[]> {
	let userConfig: MCPConfigFile;
	let projectConfig: MCPConfigFile;
	if (preloaded) {
		({ userConfig, projectConfig } = preloaded);
	} else {
		const cwd = getProjectDir();
		[userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
		]);
	}

	const names = new Set<string>(includeDisabledOnly ? (userConfig.disabledServers ?? []) : []);
	const addConfiguredNames = (config: MCPConfigFile): void => {
		const servers = config.mcpServers;
		if (!servers) return;
		for (const name in servers) {
			const server = servers[name];
			if (server && (includeDisabledConfigured || server.enabled !== false)) names.add(name);
		}
	};
	addConfiguredNames(userConfig);
	addConfiguredNames(projectConfig);
	if (ctx.mcpManager) {
		for (const name of ctx.mcpManager.getAllServerNames()) {
			names.add(name);
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export class MCPCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /mcp command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			case "test":
				await this.#handleTest(parts[2]);
				break;
			case "reauth":
				await this.#handleReauth(parts[2]);
				break;
			case "unauth":
				await this.#handleUnauth(parts[2]);
				break;
			case "enable":
				await this.#handleSetEnabled(parts[2], true);
				break;
			case "disable":
				await this.#handleSetEnabled(parts[2], false);
				break;
			case "resources":
				await this.#handleResources();
				break;
			case "prompts":
				await this.#handlePrompts();
				break;
			case "notifications":
				await this.#handleNotifications();
				break;
			case "smithery-search":
				await this.#handleSearch(text);
				break;
			case "smithery-login":
				await this.#handleSmitheryLogin();
				break;
			case "smithery-logout":
				await this.#handleSmitheryLogout();
				break;
			case "reconnect":
				await this.#handleReconnect(parts[2]);
				break;
			case "reload":
				await this.#handleReload();
				break;
			default:
				this.ctx.showError(`未知子命令:${subcommand}。输入 /mcp help 查看用法。`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("MCP 服务器管理"),
			"",
			"管理用于外部工具集成的模型上下文协议 (MCP) 服务器。",
			"",
			theme.fg("accent", "命令:"),
			"  /mcp add              添加新的 MCP 服务器(交互式向导)",
			"  /mcp add <name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command...>]",
			"  /mcp list             列出所有已配置的 MCP 服务器",
			"  /mcp remove <name> [--scope project|user]    移除 MCP 服务器(默认:project)",
			"  /mcp test <name>      测试与 MCP 服务器的连接",
			"  /mcp reauth <name>    为 MCP 服务器重新授权 OAuth",
			"  /mcp unauth <name>    移除 MCP 服务器的 OAuth 授权",
			"  /mcp enable <name>    启用 MCP 服务器",
			"  /mcp disable <name>   禁用 MCP 服务器",
			"  /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			"                        搜索 Smithery 注册表并从选择器中部署",
			"  /mcp smithery-login   登录 Smithery 并缓存 API 密钥",
			"  /mcp smithery-logout  移除缓存的 Smithery API 密钥",
			"  /mcp reconnect <name> 重新连接到指定的 MCP 服务器",
			"  /mcp reload           强制重新加载并重新发现 MCP 运行时工具",
			"  /mcp resources        列出已连接服务器的可用资源",
			"  /mcp prompts          列出已连接服务器的可用提示词",
			"  /mcp notifications    显示通知能力与订阅状态",
			"  /mcp help             显示此帮助信息",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	#parseAddCommand(text: string): MCPAddParsed {
		const prefixMatch = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			return { scope: "project" };
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return { scope: "project" };
		}

		let name: string | undefined;
		let scope: MCPAddScope = "project";
		let url: string | undefined;
		let transport: MCPAddTransport = "http";
		let authToken: string | undefined;
		let commandTokens: string[] | undefined;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--") {
				commandTokens = tokens.slice(i + 1);
				break;
			}
			if (argToken === "--scope") {
				const r = readScopeFlag(tokens[i + 1]);
				if (!r.ok) {
					return { scope, error: r.error };
				}
				scope = r.scope;
				i += 2;
				continue;
			}
			if (argToken === "--url") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "--url 缺少值。" };
				}
				url = value;
				i += 2;
				continue;
			}
			if (argToken === "--transport") {
				const value = tokens[i + 1];
				if (!value || (value !== "http" && value !== "sse")) {
					return { scope, error: "--transport 值无效。请使用 http 或 sse。" };
				}
				transport = value;
				i += 2;
				continue;
			}
			if (argToken === "--token") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "--token 缺少值。" };
				}
				authToken = value;
				i += 2;
				continue;
			}
			return { scope, error: `未知选项:${argToken}` };
		}

		const hasQuick = Boolean(url) || Boolean(commandTokens && commandTokens.length > 0);
		if (!hasQuick) {
			return { scope, initialName: name };
		}
		if (!name) {
			return { scope, error: "快速添加需要服务器名称。用法:/mcp add <name> ..." };
		}
		if (url && commandTokens && commandTokens.length > 0) {
			return { scope, error: "请使用 --url 或 -- <command...> 之一,不能同时使用。" };
		}
		if (authToken && !url) {
			return { scope, error: "--token 需要 --url (HTTP/SSE 传输)。" };
		}

		if (commandTokens && commandTokens.length > 0) {
			const [command, ...args] = commandTokens;
			const config: MCPServerConfig = {
				type: "stdio",
				command,
				args: args.length > 0 ? args : undefined,
			};
			return { scope, initialName: name, quickConfig: config, isCommandQuickAdd: true };
		}

		const useHttpTransport = transport === "http";
		let normalizedUrl = url!;
		if (!/^https?:\/\//i.test(normalizedUrl)) {
			normalizedUrl = `https://${normalizedUrl}`;
		}
		const config: MCPServerConfig = {
			type: useHttpTransport ? "http" : "sse",
			url: normalizedUrl,
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		};
		return {
			scope,
			initialName: name,
			quickConfig: config,
			isCommandQuickAdd: false,
			hasAuthToken: Boolean(authToken),
		};
	}

	#parseSearchCommand(text: string): MCPSearchParsed {
		const prefixMatch = text.match(/^\/mcp\s+smithery-search\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return {
				keyword: "",
				scope: "project",
				limit: 20,
				semantic: false,
				error: "需要关键字。用法:/mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		const keywordParts: string[] = [];
		let scope: MCPAddScope = "project";
		let limit = 20;
		let semantic = false;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { keyword: "", scope, limit, semantic, error: "--scope 值无效。请使用 project 或 user。" };
				}
				scope = value;
				i++;
				continue;
			}
			if (token === "--limit") {
				const value = tokens[i + 1];
				if (!value) {
					return { keyword: "", scope, limit, semantic, error: "--limit 缺少值。" };
				}
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
					return {
						keyword: "",
						scope,
						limit,
						semantic,
						error: "--limit 值无效。请使用 1 到 100 之间的整数。",
					};
				}
				limit = parsed;
				i++;
				continue;
			}
			if (token === "--semantic") {
				semantic = true;
				continue;
			}
			if (token.startsWith("--")) {
				return { keyword: "", scope, limit, semantic, error: `Unknown option: ${token}` };
			}
			keywordParts.push(token);
		}

		const keyword = keywordParts.join(" ").trim();
		if (!keyword) {
			return {
				keyword: "",
				scope,
				limit,
				semantic,
				error: "需要关键字。用法:/mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		return { keyword, scope, limit, semantic };
	}

	/**
	 * Handle /mcp add - Launch interactive wizard or quick-add from args
	 */
	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (parsed.quickConfig && parsed.initialName) {
			let finalConfig = parsed.quickConfig;

			// Quick-add with URL should still perform auth detection and OAuth flow,
			// matching wizard behavior. Command quick-add intentionally skips this.
			if (!parsed.isCommandQuickAdd && (finalConfig.type === "http" || finalConfig.type === "sse")) {
				try {
					await this.#handleTestConnection(finalConfig);
				} catch (error) {
					if (parsed.hasAuthToken) {
						this.ctx.showError(
							`"${parsed.initialName}" 身份验证失败:${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					const authResult = analyzeAuthError(error as Error, finalConfig.url);
					if (authResult.requiresAuth) {
						let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
						if (!oauth && finalConfig.url) {
							try {
								oauth = await discoverOAuthEndpoints(
									finalConfig.url,
									authResult.authServerUrl,
									authResult.resourceMetadataUrl,
									{ protectedScopes: authResult.scopes },
								);
							} catch {
								// Ignore discovery error and handle below.
							}
						}
						if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
							// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
							// advertised protected-resource metadata for the required scopes.
							const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
							if (scopes) oauth = { ...oauth, scopes };
						}

						if (!oauth) {
							this.ctx.showError(
								`"${parsed.initialName}" 需要身份验证,但无法发现 OAuth 端点。` +
									`请使用 /mcp add ${parsed.initialName} (向导)或手动配置身份验证。`,
							);
							return;
						}

						try {
							const oauthResource = oauth.resource ?? finalConfig.url;
							const oauthResourceIsFallback = !oauth.resource;
							const oauthResult = await this.#handleOAuthFlow(
								oauth.authorizationUrl,
								oauth.tokenUrl,
								oauth.clientId ?? finalConfig.oauth?.clientId ?? "",
								finalConfig.oauth?.clientSecret ?? "",
								oauth.scopes ?? "",
								{
									callbackPort: finalConfig.oauth?.callbackPort,
									callbackPath: finalConfig.oauth?.callbackPath,
									redirectUri: finalConfig.oauth?.redirectUri,
									prompt: finalConfig.oauth?.prompt,
									registrationUrl: oauth.registrationUrl,
									serverUrl: finalConfig.url,
									resource: oauthResource,
									stripSameOriginResource: oauthResourceIsFallback,
								},
							);
							finalConfig = this.#persistOAuthResult(finalConfig, oauthResult, {
								tokenUrl: oauth.tokenUrl,
								resource: oauthResource,
								stripSameOriginResource: oauthResourceIsFallback,
								clientId: oauth.clientId,
								userClientSecret: finalConfig.oauth?.clientSecret,
							});
						} catch (oauthError) {
							if (oauthError instanceof MCPOAuthCancelledError) {
								this.ctx.showStatus(`已取消添加 "${parsed.initialName}"`);
								return;
							}
							this.ctx.showError(
								`"${parsed.initialName}" 的 OAuth 流程失败:${oauthError instanceof Error ? oauthError.message : String(oauthError)}`,
							);
							return;
						}
					}
				}
			}

			await this.#handleWizardComplete(parsed.initialName, finalConfig, parsed.scope);
			return;
		}

		// Save current editor state
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};

		// Create wizard with OAuth handler and connection test
		const wizard = new MCPAddWizard(
			async (name: string, config: MCPServerConfig, scope: "user" | "project") => {
				done();
				await this.#handleWizardComplete(name, config, scope);
			},
			() => {
				done();
				this.#handleWizardCancel();
			},
			async (authUrl: string, tokenUrl: string, clientId: string, clientSecret: string, scopes: string, options) => {
				return await this.#handleOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes, options);
			},
			async (config: MCPServerConfig) => {
				return await this.#handleTestConnection(config);
			},
			() => {
				this.ctx.ui.requestRender();
			},
			parsed.initialName,
		);

		// Replace editor with wizard
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(wizard);
		this.ctx.ui.setFocus(wizard);
		this.ctx.ui.requestRender();
	}

	/**
	 * Handle OAuth authentication flow for MCP server
	 */
	async #handleOAuthFlow(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		opts?: {
			callbackPort?: number;
			callbackPath?: string;
			redirectUri?: string;
			prompt?: string;
			serverUrl?: string;
			registrationUrl?: string;
			resource?: string;
			stripSameOriginResource?: boolean;
			/**
			 * External cancellation source: when this signal aborts, the in-flight
			 * OAuth flow is torn down and {@link MCPOAuthCancelledError} is thrown.
			 * Wizards (which own focus and absorb Esc themselves) pass their own
			 * controller here; editor-focused callers rely on the Esc hook
			 * installed below instead.
			 */
			abortSignal?: AbortSignal;
		},
	): Promise<OAuthFlowResult> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		let parsedAuthUrl: URL;

		// Validate OAuth URLs
		try {
			parsedAuthUrl = new URL(authUrl);
			new URL(tokenUrl);
		} catch (_error) {
			throw new Error(
				`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`,
			);
		}

		const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
		const resolvedClientSecret = clientSecret.trim() || undefined;

		const manualInput = this.ctx.oauthManualInput;
		if (manualInput.hasPending()) {
			const pendingProvider = manualInput.pendingProviderId ?? "another provider";
			throw new Error(
				`已在进行 ${pendingProvider} 的 OAuth 登录。请先完成或取消它,再开始 MCP OAuth。`,
			);
		}
		let manualInputClaim: { promise: Promise<string>; clear: (reason?: string) => void } | undefined;
		const oauthTimeout = new AbortController();
		// User Esc and external aborts route through here; the timeout path sets
		// its own reason and leaves this flag false so the catch can distinguish
		// "user cancelled" (status) from "deadline elapsed" (error).
		let userCancelled = false;
		const requestUserCancel = (reason: string): void => {
			userCancelled = true;
			if (!oauthTimeout.signal.aborted) oauthTimeout.abort(reason);
		};
		const originalOnEscape = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => requestUserCancel(MCP_OAUTH_USER_CANCEL_REASON);
		const externalSignal = opts?.abortSignal;
		const onExternalAbort = (): void => {
			const reason = externalSignal?.reason;
			requestUserCancel(typeof reason === "string" ? reason : MCP_OAUTH_USER_CANCEL_REASON);
		};
		if (externalSignal?.aborted) {
			onExternalAbort();
		} else {
			externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
		}
		try {
			// Create OAuth flow
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: authUrl,
					tokenUrl: tokenUrl,
					registrationUrl: opts?.registrationUrl,
					clientId: resolvedClientId,
					clientSecret: resolvedClientSecret,
					scopes: scopes || undefined,
					prompt: opts?.prompt,
					redirectUri: opts?.redirectUri,
					callbackPort: opts?.callbackPort,
					callbackPath: opts?.callbackPath,
					resource: opts?.resource,
					stripSameOriginResource: opts?.stripSameOriginResource,
				},
				{
					onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
						// Show auth URL prominently in chat as one block
						const block = new TranscriptBlock();
						this.ctx.present(block);
						block.addChild(new Text(theme.fg("accent", "━━━ 需要 OAuth 授权 ━━━"), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("muted", "正在准备浏览器授权..."), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(
							new Text(
								theme.fg("muted", "正在等待授权...(按 Esc 取消,5 分钟超时)"),
								1,
								0,
							),
						);
						block.addChild(new Text(theme.fg("muted", MCP_MANUAL_LOGIN_TIP), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0));
						// `openPath` is best-effort — it logs spawn failures but never
						// throws, so we always render the copy-URL fallback beneath the
						// "attempting to open browser" line and no earlier try/catch is
						// worth keeping.
						openPath(info.url);
						// Stage the FULL authorization URL on the clipboard via OSC 52.
						// The full URL works from any machine (unlike `launchUrl`, which
						// only resolves against the OMP host), and OSC 52 is a
						// wire-level protocol — the terminal writes it to the user's
						// LOCAL clipboard even when OMP is on a remote SSH box.
						// Best-effort: falls back to the visible copy-URL rows below
						// whether or not the terminal honors OSC 52.
						void copyToClipboard(info.url).catch(() => {});
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("success", "→ Attempting to open browser..."), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("muted", "如果浏览器未打开,请使用备选方式:"), 1, 0));
						block.addChild(new MCPAuthorizationLinkPrompt(info.url, info.launchUrl));
						this.ctx.ui.requestRender();
					},
					onProgress: (message: string) => {
						this.ctx.present([new Spacer(1), new Text(theme.fg("muted", message), 1, 0)]);
					},
					onManualCodeInput: () => {
						if (manualInputClaim) return manualInputClaim.promise;
						const pendingInput = manualInput.tryClaimInput(MCP_MANUAL_INPUT_PROVIDER_ID);
						if (!pendingInput) {
							const pendingProvider = manualInput.pendingProviderId ?? "another provider";
							throw new Error(
								`已在进行 ${pendingProvider} 的 OAuth 登录。请先完成或取消它,再开始 MCP OAuth。`,
							);
						}
						manualInputClaim = pendingInput;
						return pendingInput.promise;
					},
					signal: oauthTimeout.signal,
				},
			);

			const createAbortError = (): Error => {
				const reason = String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted");
				return userCancelled ? new MCPOAuthCancelledError() : new Error(reason);
			};
			if (oauthTimeout.signal.aborted) throw createAbortError();

			// Execute OAuth flow with 5 minute timeout. Race the login itself
			// against the abort signal because Esc/external abort may fire before
			// MCPOAuthFlow reaches OAuthCallbackFlow.#waitForCallback, where the
			// underlying callback server normally observes the signal.
			const credentials = await withTimeout(
				raceAbortSignal(flow.login(), oauthTimeout.signal, createAbortError),
				5 * 60 * 1000,
				"OAuth flow timed out after 5 minutes",
				() => oauthTimeout.abort("MCP OAuth flow timed out"),
			);

			this.ctx.present([
				new Spacer(1),
				new Text(theme.fg("success", "✓ Authorization completed in browser."), 1, 0),
			]);

			// Deterministic per-URL id: every profile resolves its own credential row
			// under the same key, so shared project configs stay profile-isolated.
			// Random fallback only for flows that never knew the server URL.
			const credentialId = opts?.serverUrl
				? mcpOAuthCredentialId(opts.serverUrl)
				: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

			// Embed refresh material so the credential is self-contained: token
			// refresh must work for configs that carry no auth block at all.
			const oauthCredential: MCPStoredOAuthCredential = {
				type: "oauth",
				...credentials,
				tokenUrl,
				clientId: flow.resolvedClientId ?? resolvedClientId,
				clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
				resource: flow.resource,
				authorizationUrl: flow.authorizationUrl,
			};

			await authStorage.set(credentialId, oauthCredential);

			return {
				credentialId,
				clientId: flow.resolvedClientId,
				resource: flow.resource,
			};
		} catch (error) {
			// User-initiated cancel (Esc or external signal) → neutral status, not
			// a failure. Check the flag we set in `requestUserCancel`, not the
			// abort reason: the timeout path also aborts but with a different
			// reason, and we want it to surface as a timeout error below.
			if (userCancelled) {
				throw new MCPOAuthCancelledError();
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages based on failure type
			if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				throw new Error("OAuth 流程超时。请重试。");
			} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
				throw new Error("OAuth 授权失败。请检查客户端凭据。");
			} else if (errorMsg.includes("invalid_grant")) {
				throw new Error("OAuth 授权码无效或已过期。请重试。");
			} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
				throw new Error("无法连接 OAuth 服务器。请检查 URL 和网络连接。");
			} else {
				throw new Error(`OAuth 身份验证失败:${errorMsg}`);
			}
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			externalSignal?.removeEventListener("abort", onExternalAbort);
			manualInputClaim?.clear("Manual MCP OAuth input cleared");
		}
	}

	/**
	 * Fold a completed OAuth flow back into a server config. Owns the
	 * persistence policy in one place: the auth block records the credential
	 * pointer plus refresh material, the oauth block echoes the client id for
	 * pre-auth reuse, and only a user-supplied client secret is ever written —
	 * DCR-issued secrets stay embedded in the stored credential so they cannot
	 * leak into (possibly shared/committed) config files.
	 */
	#persistOAuthResult(
		config: MCPServerConfig,
		result: OAuthFlowResult,
		opts: {
			tokenUrl: string;
			resource?: string;
			stripSameOriginResource?: boolean;
			clientId?: string;
			userClientSecret?: string;
		},
	): MCPServerConfig {
		const clientId = result.clientId ?? opts.clientId ?? config.oauth?.clientId;
		const resource =
			result.resource ?? (opts.stripSameOriginResource ? undefined : opts.resource) ?? config.auth?.resource;
		return {
			...config,
			auth: {
				type: "oauth",
				credentialId: result.credentialId,
				tokenUrl: opts.tokenUrl,
				clientId,
				clientSecret: opts.userClientSecret,
				resource,
			},
			oauth: {
				...config.oauth,
				clientId,
			},
		};
	}

	/**
	 * Test connection to an MCP server.
	 * Throws an error if connection fails (used for auto-detection).
	 */
	async #handleTestConnection(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<void> {
		// Create temporary connection using a test name
		const testName = `test_${Date.now()}`;
		let resolvedConfig: MCPServerConfig;
		if (this.ctx.mcpManager) {
			resolvedConfig = await this.ctx.mcpManager.prepareConfig(config, options);
		} else {
			const tempManager = new MCPManager(getProjectDir());
			tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
			resolvedConfig = await tempManager.prepareConfig(config, options);
		}

		const connection = await connectToServer(testName, resolvedConfig);
		await disconnectServer(connection);
	}

	async #findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null> {
		const cwd = getProjectDir();
		const userPath = getMCPConfigPath("user", cwd);
		const projectPath = getMCPConfigPath("project", cwd);

		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);

		if (userConfig.mcpServers?.[name]) {
			return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name] };
		}
		if (projectConfig.mcpServers?.[name]) {
			return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name] };
		}

		// Check standalone fallback files (mcp.json, .mcp.json) in the project root —
		// these match the discovery paths used by the mcp-json provider. Reads run in
		// parallel (mirroring user/project above) but precedence is preserved by the
		// for-loop's iteration order: mcp.json wins over .mcp.json on a same-name hit.
		const standalonePaths = [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")];
		const fallbackConfigs = await Promise.all(
			standalonePaths.map(async fallbackPath => {
				try {
					return await readMCPConfigFile(fallbackPath);
				} catch {
					// Malformed JSON in a standalone file — skip and continue lookup.
					return null;
				}
			}),
		);
		for (const [index, fallbackConfig] of fallbackConfigs.entries()) {
			const config = fallbackConfig?.mcpServers?.[name];
			if (config) {
				return { filePath: standalonePaths[index]!, scope: "project", config };
			}
		}
		return null;
	}

	/**
	 * Resolve a server for an auth/test operation.
	 *
	 * Unlike {@link #findConfiguredServer} (which only reads writable OMP config
	 * files), this also recognizes runtime-discovered servers that `/mcp list`
	 * surfaces but that live in no writable config — e.g. servers from a Claude
	 * Code marketplace plugin (`cloudflare:cloudflare-api`), `.cursor/mcp.json`,
	 * etc. Without this, `/mcp reauth|test|unauth` reports "not found" for a
	 * server the list just showed.
	 *
	 * For a discovered server, any persisted change is written into the *user*
	 * config under the same (namespaced) name; the native provider (priority 100)
	 * shadows the discovered entry on the next reload, so an OAuth `auth` block
	 * persisted by `/mcp reauth` takes effect. `discovered` lets callers tailor
	 * messaging and skip pointless writes when there is nothing to persist.
	 */
	async #resolveServerForAuth(name: string): Promise<{
		filePath: string;
		scope: "user" | "project";
		config: MCPServerConfig;
		discovered: boolean;
	} | null> {
		const found = await this.#findConfiguredServer(name);
		if (found) return { ...found, discovered: false };

		const config = this.ctx.mcpManager?.getServerConfig(name);
		const source = this.ctx.mcpManager?.getSource(name);
		if (!config || !source) return null;

		return {
			filePath: getMCPConfigPath("user", getProjectDir()),
			scope: "user",
			config,
			discovered: true,
		};
	}

	#stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
		const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
		delete next.auth;
		return next;
	}

	async #resolveOAuthEndpointsFromServer(
		config: MCPServerConfig,
		authChallenge?: MCPAuthChallenge,
	): Promise<OAuthEndpoints> {
		// Stdio servers manage credentials inside the child process; OMP's OAuth
		// flow only applies to http/sse transports. Without this guard the
		// unauthenticated preflight below spawns the child, which happily reuses
		// its own cached tokens (e.g. mcp-remote's machine-wide ~/.mcp-auth) and
		// produces the misleading "reauthorization is not required".
		if (config.type !== "http" && config.type !== "sse") {
			const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
			const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
			const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
			throw new Error(
				usesMcpRemote
					? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
					: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
			);
		}
		// First test if server actually needs auth by connecting without OAuth
		let connectionSucceeded = false;
		let connectionError: Error | undefined;
		try {
			await this.#handleTestConnection(this.#stripOAuthAuth(config), { oauth: false });
			connectionSucceeded = true;
		} catch (error) {
			connectionError = error as Error;
		}

		// Server connected fine without auth — reauth is not needed. A tool-level
		// challenge overrides this: servers may allow the anonymous handshake yet
		// protect individual tool calls with `_meta["mcp/www_authenticate"]`.
		if (connectionSucceeded && !authChallenge) {
			throw new Error("服务器已在无 OAuth 的情况下成功连接;无需重新授权。");
		}

		// Tool calls can carry richer RFC 6750/RFC 9728 hints than the original
		// connection error. Feed those hints through the same analyzer so
		// resource_metadata and scope reach protected-resource discovery.
		const authError = authChallenge
			? new Error(`${connectionError?.message ?? "HTTP 401"}\n${authChallenge.wwwAuthenticate.join("\n")}`)
			: connectionError!;
		const authResult = analyzeAuthError(authError, "url" in config ? config.url : undefined);
		let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

		if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
			oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
				protectedScopes: authResult.scopes,
			});
		}
		if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
			// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
			// advertised protected-resource metadata for the required scopes.
			const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
			if (scopes) oauth = { ...oauth, scopes };
		}

		if (!oauth) {
			throw new Error("无法从服务器响应中发现 OAuth 端点。");
		}

		return oauth;
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected"> {
		if (!this.ctx.mcpManager) return "disconnected";

		const block = new McpConnectingBlock(name);
		this.ctx.present(block);

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {
				// Ignore timeout/errors here and use status check below.
			}
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				block.setStatus(theme.fg("success", `${theme.status.enabled} 已连接到 "${name}"`));
			} else if (state === "connecting") {
				block.setStatus(theme.fg("muted", `◌ "${name}" 仍在连接中...`));
			} else {
				block.setStatus(
					options?.suppressDisconnectedWarning
						? theme.fg("muted", `◌ 已完成对 "${name}" 的连接检查`)
						: theme.fg("warning", `⚠ 暂时无法连接到 "${name}"`),
				);
			}
			return state;
		} finally {
			block.finish();
		}
	}

	async #syncManagerConnection(name: string, config: MCPServerConfig): Promise<void> {
		if (!this.ctx.mcpManager) return;
		if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") return;
		await this.ctx.mcpManager.connectServers({ [name]: config }, {});
		if (this.ctx.mcpManager.getConnectionStatus(name) === "connected") {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		}
	}

	async #handleWizardComplete(name: string, config: MCPServerConfig, scope: "user" | "project"): Promise<void> {
		try {
			// Determine file path
			const cwd = getProjectDir();
			const filePath = getMCPConfigPath(scope, cwd);

			// Add server to config
			await addMCPServer(filePath, name, config);

			// Reload MCP manager
			await this.reloadServers();
			const state =
				config.enabled === false
					? "disconnected"
					: await this.#waitForServerConnectionWithAnimation(name, { suppressDisconnectedWarning: true });
			let isConnected = state === "connected";
			const isConnecting = state === "connecting";

			// Fallback: if manager state is still disconnected but direct test works,
			// report as connected to avoid false-negative messaging.
			if (!isConnected && !isConnecting && config.enabled !== false) {
				try {
					await this.#handleTestConnection(config);
					isConnected = true;
					await this.#syncManagerConnection(name, config);
				} catch {
					// Keep disconnected status
				}
			}

			// refreshMCPTools preserves the prior MCP tool selection, so tools from
			// brand-new servers are registered in the registry but never activated.
			// Explicitly activate the newly added server's tools now.
			if (isConnected && this.ctx.mcpManager) {
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				if (serverTools.length > 0) {
					const currentActive = this.ctx.session.getEnabledToolNames();
					const toActivate = serverTools.map(t => t.name).filter(n => this.ctx.session.getToolByName(n));
					if (toActivate.length > 0) {
						await this.ctx.session.setActiveToolsByName([...new Set([...currentActive, ...toActivate])]);
					}
				}
			}

			// Show success message
			const scopeLabel = scope === "user" ? "用户" : "项目";
			const lines = ["", theme.fg("success", `+ 已将服务器 "${name}" 添加到${scopeLabel}配置`), ""];

			if (isConnected) {
				lines.push(theme.fg("success", `${theme.status.enabled} 已成功连接到服务器`));
				lines.push("");
			} else if (isConnecting) {
				lines.push(theme.fg("muted", `◌ 服务器正在后台连接...`));
				lines.push(theme.fg("muted", `  几秒后运行 ${theme.fg("accent", `/mcp test ${name}`)}。`));
				lines.push("");
			} else {
				lines.push(theme.fg("warning", `⚠ 服务器已添加但尚未连接`));
				lines.push(theme.fg("muted", `  运行 ${theme.fg("accent", `/mcp test ${name}`)} 测试连接。`));
				lines.push("");
			}

			lines.push(theme.fg("muted", `运行 ${theme.fg("accent", "/mcp list")} 查看所有已配置的服务器。`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
				helpText = "\n\n提示:检查配置目录的文件权限。";
			} else if (errorMsg.includes("ENOSPC")) {
				helpText = "\n\n提示:磁盘空间不足。";
			} else if (errorMsg.includes("already exists")) {
				helpText = `\n\n提示:使用 ${theme.fg("accent", "/mcp list")} 查看现有服务器。`;
			}

			this.ctx.showError(`添加服务器失败:${errorMsg}${helpText}`);
		}
	}

	#handleWizardCancel(): void {
		this.#showMessage(
			[
				"",
				theme.fg("muted", "已取消创建服务器。"),
				"",
				theme.fg("dim", "提示:随时可按 Ctrl+C 或 Esc 取消"),
				"",
			].join("\n"),
		);
	}

	/**
	 * Handle /mcp list - Show all configured servers
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();

			// Load from both user and project configs
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			const userPathLabel = shortenPath(userPath);
			const projectPathLabel = shortenPath(projectPath);
			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const userServers = Object.keys(userConfig.mcpServers ?? {});
			const projectServers = Object.keys(projectConfig.mcpServers ?? {});

			// Collect runtime-discovered servers not in config files
			const configServerNames = new Set([...userServers, ...projectServers]);
			const disabledServerNames = new Set(userConfig.disabledServers ?? []);
			const discoveredServers: { name: string; source: SourceMeta }[] = [];
			if (this.ctx.mcpManager) {
				const allServerNames = await collectMcpServerNames(this.ctx, { userConfig, projectConfig });
				for (const name of allServerNames) {
					if (configServerNames.has(name)) continue;
					if (disabledServerNames.has(name)) continue;
					const source = this.ctx.mcpManager.getSource(name);
					if (source) {
						discoveredServers.push({ name, source });
					}
				}
			}

			if (
				userServers.length === 0 &&
				projectServers.length === 0 &&
				discoveredServers.length === 0 &&
				disabledServerNames.size === 0
			) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "尚未配置 MCP 服务器。"),
						"",
						`使用 ${theme.fg("accent", "/mcp add")} 添加服务器。`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("已配置的 MCP 服务器"), ""];

			// Show user-level servers
			if (userServers.length > 0) {
				lines.push(theme.fg("accent", "用户级") + theme.fg("muted", ` (${userPathLabel}):`));
				for (const name of userServers) {
					const config = userConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ 未启用")
							: state === "connected"
								? theme.fg("success", " ● 已连接")
								: state === "connecting"
									? theme.fg("muted", " ◌ 连接中")
									: theme.fg("muted", " ○ 未连接");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			// Show project-level servers
			if (projectServers.length > 0) {
				lines.push(theme.fg("accent", "项目级") + theme.fg("muted", ` (${projectPathLabel}):`));
				for (const name of projectServers) {
					const config = projectConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ 未启用")
							: state === "connected"
								? theme.fg("success", " ● 已连接")
								: state === "connecting"
									? theme.fg("muted", " ◌ 连接中")
									: theme.fg("muted", " ○ 未连接");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			// Show discovered servers (from .claude.json, .cursor/mcp.json, .vscode/mcp.json, etc.)
			if (discoveredServers.length > 0) {
				for (const { providerName, shortPath, items: entries } of groupBySource(discoveredServers, e => e.source)) {
					lines.push(theme.fg("accent", providerName) + theme.fg("muted", ` (${shortPath}):`));
					for (const { name } of entries) {
						const state = this.ctx.mcpManager!.getConnectionStatus(name);
						const status =
							state === "connected"
								? theme.fg("success", " ● 已连接")
								: state === "connecting"
									? theme.fg("muted", " ◌ 连接中")
									: theme.fg("muted", " ○ 未连接");
						lines.push(`  ${theme.fg("accent", name)}${status}`);
					}
					lines.push("");
				}
			}

			// Show servers disabled via /mcp disable (from third-party configs)
			const relevantDisabled = [...disabledServerNames].filter(n => !configServerNames.has(n));
			if (relevantDisabled.length > 0) {
				lines.push(theme.fg("accent", "已禁用") + theme.fg("muted", " (发现的服务器):"));
				for (const name of relevantDisabled) {
					lines.push(`  ${theme.fg("accent", name)}${theme.fg("warning", " ◌ 已禁用")}`);
				}
				lines.push("");
			}
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`列出服务器失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp remove <name> - Remove a server
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const parsed = parseRemoveArgs(rest);
		if (!parsed.ok) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { name, scope } = parsed.value;

		if (!name) {
			this.ctx.showError("必须提供服务器名称。用法:/mcp remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = getProjectDir();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const filePath = scope === "user" ? userPath : projectPath;
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.ctx.showError(`服务器 "${name}" 未在 ${scope} 配置中找到。`);
				return;
			}

			// Disconnect if connected
			if (this.ctx.mcpManager?.getConnection(name)) {
				await this.ctx.mcpManager.disconnectServer(name);
			}

			// Remove from config
			await removeMCPServer(filePath, name);

			// Reload MCP manager
			await this.reloadServers();

			this.#showMessage(["", theme.fg("success", `- 已从 ${scope} 配置中移除服务器 "${name}"`), ""].join("\n"));
		} catch (error) {
			this.ctx.showError(`移除服务器失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp test <name> - Test connection to a server
	 */
	async #handleTest(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("必须提供服务器名称。用法:/mcp test <name>");
			return;
		}

		const originalOnEscape = this.ctx.editor.onEscape;
		const abortController = new AbortController();
		this.ctx.editor.onEscape = () => {
			abortController.abort();
		};

		let connection: MCPServerConnection | undefined;
		try {
			const found = await this.#resolveServerForAuth(name);

			if (!found) {
				this.ctx.showError(
					`未找到服务器 "${name}"。\n\n提示:运行 ${theme.fg("accent", "/mcp list")} 查看可用服务器。`,
				);
				return;
			}

			const { config } = found;
			if (config.enabled === false) {
				this.ctx.showError(`服务器 "${name}" 已禁用。请先运行 /mcp enable ${name}。`);
				return;
			}

			this.#showMessage(
				["", theme.fg("muted", `正在测试与 "${name}" 的连接...(esc 取消)`), ""].join("\n"),
			);

			// Resolve auth config if needed
			let resolvedConfig: MCPServerConfig;
			if (this.ctx.mcpManager) {
				resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
			} else {
				const tempManager = new MCPManager(getProjectDir());
				tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
				resolvedConfig = await tempManager.prepareConfig(config);
			}

			// Create temporary connection
			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal });

			// List tools to verify connection
			const tools = await listTools(connection, { signal: abortController.signal });

			const lines = [
				"",
				theme.fg("success", `${theme.status.enabled} 已成功连接到 "${name}"`),
				"",
				`  服务器:${connection.serverInfo.name} v${connection.serverInfo.version}`,
				`  工具:${tools.length}`,
			];

			// Show tool names if there are any
			if (tools.length > 0 && tools.length <= 10) {
				lines.push("");
				lines.push("  Available tools:");
				for (const tool of tools) {
					lines.push(`    • ${tool.name}`);
				}
			}

			lines.push("");
			await this.#syncManagerConnection(name, config);
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
				this.ctx.showStatus(`已取消对 "${name}" 的 MCP 测试`);
				return;
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
				helpText = "\n\n提示:请检查命令或 URL 是否正确。";
			} else if (errorMsg.includes("EACCES")) {
				helpText = "\n\n提示:请检查文件/命令权限。";
			} else if (errorMsg.includes("ECONNREFUSED")) {
				helpText = "\n\n提示:请检查服务器是否正在运行,以及 URL/端口是否正确。";
			} else if (errorMsg.includes("timeout")) {
				helpText = "\n\n提示:服务器可能较慢或无响应。请尝试增大超时时间。";
			} else if (errorMsg.includes("401") || errorMsg.includes("403")) {
				helpText = "\n\n提示:请检查身份验证凭据。";
			}

			this.ctx.showError(`连接到 "${name}" 失败:${errorMsg}${helpText}`);
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			if (connection) {
				// Best-effort: don't block UI on cleanup.
				void disconnectServer(connection);
			}
		}
	}

	async #handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (!name) {
			this.ctx.showError(`必须提供服务器名称。用法:/mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				// Check if this is a discovered server from a third-party config
				const userConfigPath = getMCPConfigPath("user", getProjectDir());
				const disabledServers = new Set(await readDisabledServers(userConfigPath));
				const isDiscovered = this.ctx.mcpManager?.getSource(name);
				const isCurrentlyDisabled = disabledServers.has(name);
				if (!isDiscovered && !isCurrentlyDisabled) {
					this.ctx.showError(`未找到服务器 "${name}"。`);
					return;
				}
				if (isCurrentlyDisabled === !enabled) {
					this.#showMessage(
						["", theme.fg("muted", `服务器 "${name}" 已${enabled ? "启用" : "禁用"}。`), ""].join(
							"\n",
						),
					);
					return;
				}
				await setServerDisabled(userConfigPath, name, !enabled);
				if (enabled) {
					await this.#connectEnabledMCPServer(name);
					const state = await this.#waitForServerConnectionWithAnimation(name);
					const status =
						state === "connected"
							? theme.fg("success", "已连接")
							: state === "connecting"
								? theme.fg("muted", "连接中")
								: theme.fg("warning", "尚未连接");
					this.#showMessage(
						[
							"",
							theme.fg("success", `${theme.status.enabled} 已启用 "${name}"`),
							"",
							`  状态:${status}`,
							"",
						].join("\n"),
					);
				} else {
					await this.ctx.mcpManager?.disconnectServer(name);
					await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
					this.#showMessage(["", theme.fg("muted", `${theme.status.disabled} 已禁用 "${name}"`), ""].join("\n"));
				}
				return;
			}

			if ((found.config.enabled ?? true) === enabled) {
				this.#showMessage(
					["", theme.fg("muted", `服务器 "${name}" 已${enabled ? "启用" : "禁用"}。`), ""].join(
						"\n",
					),
				);
				return;
			}

			const updated: MCPServerConfig = { ...found.config, enabled };
			await updateMCPServer(found.filePath, name, updated);
			if (enabled) {
				await this.#connectEnabledMCPServer(name);
			} else {
				await this.ctx.mcpManager?.disconnectServer(name);
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
			}

			let status = "";
			if (enabled) {
				const state = await this.#waitForServerConnectionWithAnimation(name);
				status =
					state === "connected"
						? theme.fg("success", "已连接")
						: state === "connecting"
							? theme.fg("muted", "连接中")
							: theme.fg("warning", "尚未连接");
			}

			const lines = [
				"",
				enabled
					? theme.fg("success", `${theme.status.enabled} 已启用 "${name}" (${found.scope} 配置)`)
					: theme.fg("muted", `${theme.status.disabled} 已禁用 "${name}" (${found.scope} 配置)`),
			];
			if (status) {
				lines.push("");
				lines.push(`  状态:${status}`);
			}
			lines.push("");
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(
				`${enabled ? "启用" : "禁用"}服务器失败:${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #handleUnauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("必须提供服务器名称。用法:/mcp unauth <name>");
			return;
		}

		try {
			const found = await this.#resolveServerForAuth(name);
			if (!found) {
				this.ctx.showError(`未找到服务器 "${name}"。`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			if (currentAuth?.type === "oauth") {
				await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
			}
			// Also drop this profile's url-keyed binding so the server is truly
			// signed out even when the config carries no auth block. Runtime
			// discovery expands `${...}` URL values before MCPManager looks up the
			// deterministic credential row, so unauth must clear that same key.
			let removedUrlKeyedCredential = false;
			if ((found.config.type === "http" || found.config.type === "sse") && found.config.url) {
				removedUrlKeyedCredential = await removeManagedMcpOAuthCredentials(
					authStorage,
					mcpOAuthCredentialIdsForServerUrl(found.config.url),
				);
			}

			if (found.discovered && currentAuth?.type !== "oauth") {
				if (!removedUrlKeyedCredential) {
					this.#showMessage(
						["", theme.fg("muted", `No stored OAuth auth to remove for "${name}".`), ""].join("\n"),
					);
					return;
				}
				await this.reloadServers();
				this.#showMessage(
					["", theme.fg("success", `- 已清除 "${name}" 的授权 (${found.scope} 配置)`), ""].join("\n"),
				);
				return;
			}

			const updated = this.#stripOAuthAuth(found.config);
			await updateMCPServer(found.filePath, name, updated);
			await this.reloadServers();

			this.#showMessage(
				["", theme.fg("success", `- 已清除 "${name}" 的授权 (${found.scope} 配置)`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`清除授权失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Reauthorize a server after a tool-level OAuth challenge. */
	async handleMCPAuthChallenge(name: string, challenge: MCPAuthChallenge): Promise<MCPServerConfig | undefined> {
		return this.#handleReauth(name, { silent: true, reload: false, authChallenge: challenge });
	}

	async #handleReauth(
		name: string | undefined,
		options: { silent?: boolean; reload?: boolean; authChallenge?: MCPAuthChallenge } = {},
	): Promise<MCPServerConfig | undefined> {
		if (!name) {
			if (!options.silent) this.ctx.showError("必须提供服务器名称。用法:/mcp reauth <name>");
			return;
		}

		try {
			const found = await this.#resolveServerForAuth(name);
			if (!found) {
				if (!options.silent) this.ctx.showError(`未找到服务器 "${name}"。`);
				return;
			}

			if (found.config.enabled === false) {
				if (!options.silent) this.ctx.showError(`服务器 "${name}" 已禁用。请先运行 /mcp enable ${name}。`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const baseConfig = this.#stripOAuthAuth(found.config);
			const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
			// Resolve endpoints first: this fails fast for stdio transports and
			// probes http/sse with { oauth: false }, so nothing destructive has
			// happened yet if the server turns out not to need (or support) OAuth.
			// Use the same env-expanded config shape runtime discovery passes to
			// MCPManager; the raw file value may contain `${...}` placeholders.
			const oauth = await this.#resolveOAuthEndpointsFromServer(runtimeBaseConfig, options.authChallenge);
			const serverUrl =
				runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;
			// Client credentials drive the token exchange, so they must come from the
			// env-expanded runtime config; `found.config`/`currentAuth` may still hold
			// `${...}` placeholders (the wizard writes the secret to auth.clientSecret).
			// DCR secrets are embedded in the stored credential and never echoed back
			// into config files.
			const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
			const configuredClientId = runtimeBaseConfig.oauth?.clientId ?? runtimeAuth?.clientId;
			const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
			const flowClientId = oauth.clientId ?? configuredClientId ?? existingCredential?.clientId ?? "";
			const storedClientSecret =
				existingCredential?.clientId === flowClientId ? existingCredential.clientSecret : undefined;
			const flowClientSecret =
				runtimeBaseConfig.oauth?.clientSecret ?? runtimeAuth?.clientSecret ?? storedClientSecret ?? "";
			// Persisted separately below: keep the raw `${...}` placeholder in the file
			// rather than writing the resolved secret back to (possibly shared) config.
			const userClientSecret = found.config.oauth?.clientSecret ?? currentAuth?.clientSecret;

			if (!options.silent) {
				this.#showMessage(["", theme.fg("muted", `正在重新授权 "${name}"...`), ""].join("\n"));
			}

			const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
			const oauthResource =
				oauth.resource ?? currentAuthResource ?? ("url" in runtimeBaseConfig ? runtimeBaseConfig.url : undefined);
			const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

			const oauthResult = await this.#handleOAuthFlow(
				oauth.authorizationUrl,
				oauth.tokenUrl,
				flowClientId,
				flowClientSecret,
				oauth.scopes ?? "",
				{
					callbackPort: found.config.oauth?.callbackPort,
					callbackPath: found.config.oauth?.callbackPath,
					redirectUri: found.config.oauth?.redirectUri,
					prompt: found.config.oauth?.prompt,
					registrationUrl: oauth.registrationUrl,
					serverUrl,
					resource: oauthResource,
					stripSameOriginResource: oauthResourceIsFallback,
				},
			);

			// The flow overwrote (or minted) this profile's row; a superseded
			// pointer row from the legacy random-id era is now orphaned. GC only
			// after success so cancelling the browser step leaves the previous
			// session signed in.
			if (currentAuth?.type === "oauth" && currentAuth.credentialId !== oauthResult.credentialId) {
				await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
			}

			// Definition-only entries resolve through the url-keyed binding alone;
			// skip the write-back so a committed project mcp.json stays clean.
			const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
			const shouldPersist = currentAuth || oauthResult.credentialId !== urlKeyedId;
			const updatedConfig = shouldPersist
				? this.#persistOAuthResult(baseConfig, oauthResult, {
						tokenUrl: oauth.tokenUrl,
						clientId: oauth.clientId,
						userClientSecret,
						resource: oauthResource,
						stripSameOriginResource: oauthResourceIsFallback,
					})
				: baseConfig;
			if (shouldPersist) {
				await updateMCPServer(found.filePath, name, updatedConfig);
			}
			if (options.reload !== false) {
				await this.reloadServers();
				const state = await this.#waitForServerConnectionWithAnimation(name);

				const lines = [
					"",
					theme.fg("success", `✓ 已重新授权 "${name}" (${found.scope} 配置)`),
					"",
					`  状态:${
						state === "connected"
							? theme.fg("success", "已连接")
							: state === "connecting"
								? theme.fg("muted", "连接中")
								: theme.fg("warning", "未连接")
					}`,
					"",
				];
				this.#showMessage(lines.join("\n"));
			}
			return updatedConfig;
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError) {
				if (!options.silent) this.ctx.showStatus(`已取消对 "${name}" 的重新授权`);
				return;
			}
			if (!options.silent) {
				this.ctx.showError(
					`重新授权服务器失败:${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleReload(): Promise<void> {
		try {
			this.#showMessage(["", theme.fg("muted", "正在重新加载 MCP 服务器和运行时工具..."), ""].join("\n"));
			await this.reloadServers();
			const connectedCount = this.ctx.mcpManager?.getConnectedServers().length ?? 0;
			this.#showMessage(
				[
					"",
					theme.fg("success", `${theme.icon.loop} MCP 重新加载完成`),
					`  已连接服务器:${connectedCount}`,
					"",
				].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`重新加载 MCP 失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp reconnect <name> - Reconnect to a specific server.
	 */
	async #handleReconnect(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("必须提供服务器名称。用法:/mcp reconnect <name>");
			return;
		}
		if (!this.ctx.mcpManager) {
			this.ctx.showError("MCP 管理器不可用。");
			return;
		}

		this.#showMessage(["", theme.fg("muted", `正在重新连接到 "${name}"...`), ""].join("\n"));

		try {
			const connection = await this.ctx.mcpManager.reconnectServer(name, { manual: true });
			if (connection) {
				// refreshMCPTools re-registers tools and preserves the user's prior
				// MCP tool selection. No need to call activateDiscoveredMCPTools —
				// that would broaden the selection to all server tools.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				this.#showMessage(
					[
						"\n",
						theme.fg("success", `${theme.status.enabled} 已重新连接到 "${name}"`),
						`  工具:${serverTools.length}`,
						"\n",
					].join("\n"),
				);
			} else {
				this.ctx.showError(`重新连接到 "${name}" 失败。请检查服务器状态和日志。`);
			}
		} catch (error) {
			this.ctx.showError(
				`重新连接到 "${name}" 失败:${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #connectEnabledMCPServer(name: string): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		const { configs, sources } = await loadAllMCPConfigs(getProjectDir());
		const config = configs[name];
		if (!config) {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			return;
		}

		const source = sources[name];
		const result = await this.ctx.mcpManager.connectServers({ [name]: config }, source ? { [name]: source } : {});
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		this.#showMCPConnectionErrors(result.errors);
	}

	#showMCPConnectionErrors(errors: Map<string, string>): void {
		if (errors.size === 0) {
			return;
		}

		const errorLines = ["", theme.fg("warning", "部分服务器连接失败:"), ""];
		for (const [serverName, error] of errors.entries()) {
			errorLines.push(`  ${serverName}: ${error}`);
		}
		errorLines.push("");
		this.#showMessage(errorLines.join("\n"));
	}

	/**
	 * Reconnect every configured MCP server and rebind the session's MCP tools.
	 *
	 * Disconnects all live connections, rediscovers `.mcp.json` configs, and
	 * calls `session.refreshMCPTools(...)` so config edits take effect without a
	 * restart. Public because `/reload-plugins` reuses it alongside `/mcp reload`
	 * and the config-mutation flows in this controller.
	 *
	 * Discovery options are derived from settings so the reload honors the same
	 * opt-outs as startup — notably `mcp.enableProjectConfig: false`, which must
	 * keep project `.mcp.json` servers from being started on reload.
	 */
	async reloadServers(): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		// Disconnect all existing servers
		await this.ctx.mcpManager.disconnectAll();
		// Prompt enrichment is asynchronous. Clear commands before rediscovery so
		// removed/disabled servers cannot leave stale `/server:prompt` entries;
		// newly loaded prompts repopulate them through the manager callback.
		this.ctx.session.setMCPPromptCommands([]);

		// Rediscover and connect, mirroring startup's discovery filters.
		const result = await this.ctx.mcpManager.discoverAndConnect({
			enableProjectConfig: this.ctx.settings.get("mcp.enableProjectConfig") ?? true,
			filterExa: true,
			filterBrowser: this.ctx.settings.get("browser.enabled") ?? false,
		});
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());

		this.#showMCPConnectionErrors(result.errors);
	}

	/**
	 * Handle /mcp resources - Show available resources from connected servers
	 */
	async #handleResources(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("没有可用的 MCP 管理器。");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP 资源"), ""];
		let hasAny = false;

		for (const name of servers) {
			const data = this.ctx.mcpManager.getServerResources(name);
			if (!data) continue;
			const { resources, templates } = data;
			if (resources.length === 0 && templates.length === 0) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const r of resources) {
				const desc = r.description ? ` ${theme.fg("dim", r.description)}` : "";
				const mime = r.mimeType ? ` ${theme.fg("dim", `[${r.mimeType}]`)}` : "";
				lines.push(`  ${theme.fg("success", r.uri)}${mime}${desc}`);
			}
			if (templates.length > 0) {
				lines.push(`  ${theme.fg("muted", "模板:")}`);
				for (const t of templates) {
					const desc = t.description ? ` ${theme.fg("dim", t.description)}` : "";
					lines.push(`    ${theme.fg("accent", t.uriTemplate)}${desc}`);
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "已连接服务器上没有可用资源。"));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	/**
	 * Handle /mcp prompts - Show available prompts from connected servers
	 */
	async #handlePrompts(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("没有可用的 MCP 管理器。");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP 提示词"), ""];
		let hasAny = false;

		for (const name of servers) {
			const prompts = this.ctx.mcpManager.getServerPrompts(name);
			if (!prompts?.length) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const p of prompts) {
				const commandName = `${name}:${p.name}`;
				const desc = p.description ? ` ${theme.fg("dim", p.description)}` : "";
				lines.push(`  ${theme.fg("success", `/${commandName}`)}${desc}`);
				if (p.arguments?.length) {
					for (const arg of p.arguments) {
						const required = arg.required ? theme.fg("warning", " *") : "";
						const argDesc = arg.description ? ` - ${arg.description}` : "";
						lines.push(`    ${arg.name}=${required}${theme.fg("dim", argDesc)}`);
					}
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "已连接服务器上没有可用提示词。"));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	/**
	 * Handle /mcp notifications - Show notification and subscription state
	 */
	async #handleNotifications(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("没有可用的 MCP 管理器。");
			return;
		}

		const { enabled, subscriptions } = this.ctx.mcpManager.getNotificationState();
		const servers = this.ctx.mcpManager.getConnectedServers();
		const statusIcon = enabled ? theme.fg("success", "已启用") : theme.fg("warning", "已禁用");
		const lines: string[] = ["", theme.bold("MCP 通知"), ""];
		lines.push(`  状态:${statusIcon}  ${theme.fg("dim", "(mcp.notifications 设置)")}`);
		lines.push("");

		let hasAny = false;
		for (const name of servers) {
			const connection = this.ctx.mcpManager.getConnection(name);
			if (!connection) continue;
			const caps = connection.capabilities;
			const supportsResources = caps.resources !== undefined;
			const supportsSubscribe = caps.resources?.subscribe === true;
			const supportsToolsChanged = caps.tools?.listChanged === true;
			const supportsPromptsChanged = caps.prompts?.listChanged === true;
			const supportsResourcesChanged = caps.resources?.listChanged === true;

			const hasNotifications =
				supportsToolsChanged || supportsPromptsChanged || supportsResourcesChanged || supportsSubscribe;
			if (!hasNotifications) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			const check = theme.fg("success", "✓");
			const cross = theme.fg("dim", "✗");
			if (supportsToolsChanged) lines.push(`  ${check} tools/list_changed`);
			if (supportsResourcesChanged) lines.push(`  ${check} resources/list_changed`);
			if (supportsPromptsChanged) lines.push(`  ${check} prompts/list_changed`);

			if (supportsSubscribe) {
				const subscribedUris = subscriptions.get(name);
				const subCount = subscribedUris?.size ?? 0;
				const subStatus =
					enabled && subCount > 0
						? theme.fg("success", `已订阅 (${subCount} 个 URI)`)
						: enabled
							? theme.fg("muted", "无活动订阅")
							: theme.fg("dim", "未启用(通知已禁用)");
				lines.push(`  ${check} resources/subscribe  ${subStatus}`);
				if (enabled && subscribedUris && subscribedUris.size > 0) {
					for (const uri of subscribedUris) {
						lines.push(`    ${theme.fg("success", "✓")} ${theme.fg("dim", uri)}`);
					}
				}
			} else if (supportsResources) {
				lines.push(`  ${cross} resources/subscribe  ${theme.fg("dim", "不支持")}`);
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "没有服务器支持通知。"));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	async #validateSmitheryApiKey(apiKey: string): Promise<void> {
		await searchSmitheryRegistry("mcp", { limit: 1, apiKey });
	}

	async #promptSmitheryApiKey(promptLabel: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(promptLabel);
			if (input === undefined) return null;
			const apiKey = input.trim();
			if (!apiKey) {
				this.ctx.showError("Smithery API 密钥不能为空。");
				continue;
			}
			try {
				await this.#validateSmitheryApiKey(apiKey);
				return apiKey;
			} catch (error) {
				this.ctx.showError(
					`Smithery API 密钥验证失败:${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleSmitheryLoginWithApiKey(): Promise<boolean> {
		const apiKey = await this.#promptSmitheryApiKey("Smithery API 密钥(Esc 取消)");
		if (!apiKey) return false;
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API 密钥已保存。");
		return true;
	}

	async #waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
		const pollIntervalMs = 2_000;
		const timeoutMs = 300_000;
		const startedAt = Date.now();

		while (!signal.aborted) {
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error("Smithery 授权在 5 分钟后超时。");
			}
			let response: SmitheryCliPollResponse;
			try {
				response = await pollSmitheryCliAuthSession(sessionId, signal);
			} catch (error) {
				// A single hung/slow poll aborts with TimeoutError; retry until the deadline.
				if (isTimeoutError(error)) continue;
				throw error;
			}
			if (response.status === "success" && response.apiKey) {
				return response.apiKey;
			}
			if (response.status === "error") {
				throw new Error(response.message ?? "Smithery 授权失败。");
			}
			await Bun.sleep(pollIntervalMs);
		}

		throw new Error("Smithery 授权已取消。");
	}

	async #handleSmitheryBrowserLogin(): Promise<boolean> {
		const session = await createSmitheryCliAuthSession();
		const fallbackLoginUrl = getSmitheryLoginUrl();
		this.#showMessage(
			[
				"",
				theme.bold("Smithery 登录"),
				theme.fg("muted", "已开始浏览器授权。请在浏览器中完成授权。"),
				theme.fg("dim", "授权 URL:"),
				theme.fg("accent", session.authUrl),
				theme.fg("dim", `备用:${fallbackLoginUrl}`),
				"",
			].join("\n"),
		);
		try {
			openPath(session.authUrl);
		} catch {
			// URL is already shown above.
		}

		const apiKey = await this.#waitForSmitheryCliApiKey(session.sessionId, new AbortController().signal);
		await this.#validateSmitheryApiKey(apiKey);
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API 密钥已保存。");
		return true;
	}

	async #promptSmitheryLogin(reason: string): Promise<boolean> {
		this.#showMessage(
			[
				"",
				theme.fg("muted", `需要 Smithery 身份验证 (${reason})。`),
				theme.fg("muted", "如果浏览器授权失败,你可以粘贴 API 密钥。"),
				"",
			].join("\n"),
		);
		try {
			return await this.#handleSmitheryBrowserLogin();
		} catch (error) {
			this.ctx.showWarning(
				`浏览器授权失败:${error instanceof Error ? error.message : String(error)}。回退到 API 密钥。`,
			);
			return await this.#handleSmitheryLoginWithApiKey();
		}
	}

	#getSmitheryErrorStatus(error: unknown): number | undefined {
		if (error instanceof SmitheryRegistryError || error instanceof SmitheryConnectError) {
			return error.status;
		}
		return undefined;
	}

	#toSmitheryAuthReason(status: number): string {
		return status === 429 ? "被 Smithery 限流" : "Smithery 拒绝/未授权";
	}

	async #requireSmitheryApiKey(reason: string): Promise<string> {
		let apiKey = await getSmitheryApiKey();
		if (apiKey) return apiKey;

		const loggedIn = await this.#promptSmitheryLogin(reason);
		if (!loggedIn) {
			throw new Error("Smithery 登录已取消。请运行 /mcp smithery-login,然后重试 /mcp smithery-search。");
		}

		apiKey = await getSmitheryApiKey();
		if (!apiKey) {
			throw new Error("登录后未找到 Smithery API 密钥。");
		}
		return apiKey;
	}

	async #runSmitheryOperationWithAuthRetry<T>(operation: (apiKey: string) => Promise<T>, reason: string): Promise<T> {
		const apiKey = await this.#requireSmitheryApiKey(reason);
		try {
			return await operation(apiKey);
		} catch (error) {
			const status = this.#getSmitheryErrorStatus(error);
			if (status === undefined || ![401, 403, 429].includes(status)) {
				throw error;
			}
			const loggedIn = await this.#promptSmitheryLogin(this.#toSmitheryAuthReason(status));
			if (!loggedIn) {
				throw error;
			}
			const retryApiKey = await this.#requireSmitheryApiKey(reason);
			return await operation(retryApiKey);
		}
	}

	async #handleSmitheryLogin(): Promise<void> {
		const ok = await this.#promptSmitheryLogin("login");
		if (!ok) {
			this.ctx.showStatus("Smithery 登录已取消。");
		}
	}

	async #handleSmitheryLogout(): Promise<void> {
		const removed = await clearSmitheryApiKey();
		this.ctx.showStatus(removed ? "Smithery API 密钥已移除。" : "未找到缓存的 Smithery API 密钥。");
	}

	async #nextAvailableServerName(scope: MCPAddScope, baseName: string): Promise<string> {
		const filePath = getMCPConfigPath(scope, getProjectDir());
		const config = await readMCPConfigFile(filePath);
		const existingNames = new Set(Object.keys(config.mcpServers ?? {}));
		if (!existingNames.has(baseName)) return baseName;
		for (let i = 2; i <= 999; i++) {
			const candidate = `${baseName}-${i}`;
			if (!existingNames.has(candidate)) return candidate;
		}
		return `${baseName}-${Date.now()}`;
	}

	async #promptDeploymentServerName(scope: MCPAddScope, defaultName: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(`部署的服务器名称(默认:${defaultName})`, defaultName);
			if (input === undefined) return null;
			const proposed = input.trim() || defaultName;
			if (!proposed) {
				this.ctx.showError("服务器名称不能为空。");
				continue;
			}
			const filePath = getMCPConfigPath(scope, getProjectDir());
			const config = await readMCPConfigFile(filePath);
			if (config.mcpServers?.[proposed]) {
				this.ctx.showError(`服务器 "${proposed}" 已存在于 ${scope} 配置中。`);
				continue;
			}
			return proposed;
		}
	}

	async #promptRequiredRegistryInputs(result: SmitherySearchResult): Promise<Record<string, string> | null> {
		const values: Record<string, string> = {};
		for (const input of result.requiredInputs) {
			const label = input.required ? `${input.key} (required)` : `${input.key} (optional)`;
			const prompt = `${label}${input.description ? ` - ${input.description}` : ""}`;
			const userInput = await this.ctx.showHookInput(prompt, input.defaultValue);
			if (userInput === undefined) {
				if (input.required) return null;
				continue;
			}
			const value = userInput.trim();
			if (!value) {
				if (input.required) {
					this.ctx.showError(`缺少 "${input.key}" 的必需值。`);
					return null;
				}
				continue;
			}
			values[input.key] = value;
		}
		return values;
	}

	#applyRegistryInputOverrides(config: MCPServerConfig, values: Record<string, string>): MCPServerConfig {
		if (Object.keys(values).length === 0) return config;
		if (config.type !== "stdio") {
			return config;
		}
		const args = [...(config.args ?? [])];
		const configJson = JSON.stringify(values);
		const index = args.indexOf("--config");
		if (index >= 0) {
			if (index + 1 < args.length) {
				args[index + 1] = configJson;
			} else {
				args.push(configJson);
			}
		} else {
			args.push("--config", configJson);
		}
		return { ...config, args };
	}

	async #pickRegistryResult(results: SmitherySearchResult[], keyword: string): Promise<SmitherySearchResult | null> {
		const options = results.map((result, index) => {
			const label = `${index + 1}. ${result.display.displayName} (${result.display.transport}, uses ${result.display.useCount})`;
			return label.length > 120 ? `${label.slice(0, 117)}...` : label;
		});
		const selected = await this.ctx.showHookSelector(`"${keyword}" 的注册表结果`, options);
		if (!selected) return null;
		const prefix = selected.split(".", 1)[0];
		const index = Number(prefix) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= results.length) return null;
		return results[index] ?? null;
	}

	async #deployRegistryResult(result: SmitherySearchResult, scope: MCPAddScope): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await this.#nextAvailableServerName(scope, baseName);
		const serverName = await this.#promptDeploymentServerName(scope, defaultName);
		if (!serverName) {
			this.ctx.showStatus("已取消 MCP 部署。");
			return;
		}
		const inputValues = await this.#promptRequiredRegistryInputs(result);
		if (inputValues === null) {
			this.ctx.showStatus("已取消 MCP 部署。");
			return;
		}
		const config = this.#applyRegistryInputOverrides(result.config, inputValues);
		await this.#handleWizardComplete(serverName, config, scope);
	}

	async #handleSearch(text: string): Promise<void> {
		const parsed = this.#parseSearchCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}

		try {
			this.#showMessage(
				["", theme.fg("muted", `正在搜索 Smithery 注册表:"${parsed.keyword}"...`), ""].join("\n"),
			);
			const results = await this.#runSmitheryOperationWithAuthRetry(
				apiKey =>
					searchSmitheryRegistry(parsed.keyword, {
						limit: parsed.limit,
						apiKey,
						includeSemantic: parsed.semantic,
					}),
				"用于 smithery-search",
			);
			if (results.length === 0) {
				this.#showMessage(
					["", theme.fg("warning", `未找到 "${parsed.keyword}" 的 Smithery 结果。`), ""].join("\n"),
				);
				return;
			}

			const selected = await this.#pickRegistryResult(results, parsed.keyword);
			if (!selected) {
				this.ctx.showStatus("已取消 MCP Smithery 选择。");
				return;
			}

			await this.#deployRegistryResult(selected, parsed.scope);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/authentication was cancelled|login cancelled/i.test(message)) {
				this.ctx.showError(`${message} 请先运行 /mcp smithery-login 进行身份验证。`);
				return;
			}
			this.ctx.showError(`Smithery 搜索失败:${message}`);
		}
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}
