/**
 * MCP Add Wizard Component
 *
 * Interactive multi-step wizard for adding MCP servers.
 */
import {
	Container,
	Input,
	matchesKey,
	replaceTabs,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
} from "@wxyhgk/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@wxyhgk/pi-utils";
import { validateServerName } from "../../mcp/config-writer";
import { analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes } from "../../mcp/oauth-discovery";
import type { MCPHttpServerConfig, MCPServerConfig, MCPSseServerConfig, MCPStdioServerConfig } from "../../mcp/types";
import { shortenPath } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

type TransportType = "stdio" | "http" | "sse";
type AuthMethod = "none" | "oauth" | "manual";
type AuthLocation = "env" | "header";
type Scope = "user" | "project";

type WizardStep =
	| "name"
	| "transport"
	| "command"
	| "args"
	| "url"
	| "auth-method"
	| "oauth-error"
	| "oauth-auth-url"
	| "oauth-token-url"
	| "oauth-client-id"
	| "oauth-client-secret"
	| "oauth-scopes"
	| "apikey"
	| "auth-location"
	| "env-var-name"
	| "header-name"
	| "scope"
	| "confirm";

/**
 * Result of the wizard's OAuth callback. `credentialId` is mandatory;
 * `clientId` is populated when the OAuth provider performed dynamic client
 * registration (or when the caller pre-supplied it) so the wizard can fold it
 * into the final `mcp.json` entry. Refresh material (including any DCR client
 * secret) is embedded in the stored credential, never written to config files.
 */
export interface MCPAddWizardOAuthResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

interface MCPAddWizardOAuthOptions {
	serverUrl?: string;
	resource?: string;
	registrationUrl?: string;
	/**
	 * External cancellation source. Aborting it tears down the in-flight OAuth
	 * flow and surfaces a neutral cancellation error. The wizard wires its own
	 * controller here so Esc cancels the OAuth wait instead of stepping back
	 * through the form (the wizard is focused, so the editor's Esc hook does
	 * not fire).
	 */
	abortSignal?: AbortSignal;
}

interface WizardState {
	name: string;
	transport: TransportType | null;
	command: string;
	args: string;
	url: string;
	authMethod: AuthMethod;
	oauthAuthUrl: string;
	oauthTokenUrl: string;
	oauthRegistrationUrl: string;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthScopes: string;
	oauthResource: string;
	oauthCredentialId: string | null;
	apiKey: string;
	authLocation: AuthLocation | null;
	envVarName: string;
	headerName: string;
	scope: Scope | null;
}

/** Max display width for sanitized error/URL text in wizard TUI */
const MAX_DISPLAY_WIDTH = 120;

/** Sanitize a string for TUI display: replace tabs and truncate */
function sanitize(text: string): string {
	return truncateToWidth(replaceTabs(text), MAX_DISPLAY_WIDTH);
}

export class MCPAddWizard extends Container {
	#currentStep: WizardStep = "name";
	#state: WizardState = {
		name: "",
		transport: null,
		command: "",
		args: "",
		url: "",
		authMethod: "none",
		oauthAuthUrl: "",
		oauthTokenUrl: "",
		oauthRegistrationUrl: "",
		oauthClientId: "",
		oauthClientSecret: "",
		oauthScopes: "",
		oauthResource: "",
		oauthCredentialId: null,
		apiKey: "",
		authLocation: null,
		envVarName: "API_KEY",
		headerName: "Authorization",
		scope: null,
	};

	#contentContainer: Container;
	#inputField: Input | null = null;
	#selectedIndex = 0;
	#validationError: string | null = null;
	#onCompleteCallback: (name: string, config: MCPServerConfig, scope: Scope) => void;
	#onCancelCallback: () => void;
	#onOAuthCallback:
		| ((
				authUrl: string,
				tokenUrl: string,
				clientId: string,
				clientSecret: string,
				scopes: string,
				options?: MCPAddWizardOAuthOptions,
		  ) => Promise<MCPAddWizardOAuthResult>)
		| null = null;
	#onTestConnectionCallback: ((config: MCPServerConfig) => Promise<void>) | null = null;
	#onRenderCallback: (() => void) | null = null;
	/**
	 * Set while the OAuth callback is in flight; populated by
	 * {@link #launchOAuthFlow} and consumed by {@link handleInput} so Esc
	 * cancels the OAuth wait instead of stepping back through the form.
	 */
	#oauthAbort: AbortController | null = null;

	constructor(
		onComplete: (name: string, config: MCPServerConfig, scope: Scope) => void,
		onCancel: () => void,
		onOAuth?: (
			authUrl: string,
			tokenUrl: string,
			clientId: string,
			clientSecret: string,
			scopes: string,
			options?: MCPAddWizardOAuthOptions,
		) => Promise<MCPAddWizardOAuthResult>,
		onTestConnection?: (config: MCPServerConfig) => Promise<void>,
		onRender?: () => void,
		initialName?: string,
	) {
		super();
		this.#onCompleteCallback = onComplete;
		this.#onCancelCallback = onCancel;
		this.#onOAuthCallback = onOAuth ?? null;
		this.#onTestConnectionCallback = onTestConnection ?? null;
		this.#onRenderCallback = onRender ?? null;
		if (initialName && initialName.trim().length > 0) {
			this.#state.name = initialName.trim();
			this.#currentStep = "transport";
		}

		// Add border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new TruncatedText(theme.bold("添加 MCP 服务器")));
		this.addChild(new Spacer(1));

		// Content container for step-specific content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Render first step
		this.#renderStep();
	}

	#requestRender(): void {
		this.#onRenderCallback?.();
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#inputField = null; // Reset input field

		switch (this.#currentStep) {
			case "name":
				this.#renderNameStep();
				break;
			case "transport":
				this.#renderTransportStep();
				break;
			case "command":
				this.#renderCommandStep();
				break;
			case "args":
				this.#renderArgsStep();
				break;
			case "url":
				this.#renderUrlStep();
				break;
			case "auth-method":
				this.#renderAuthMethodStep();
				break;
			case "oauth-error":
				this.#renderOAuthErrorStep();
				break;
			case "oauth-auth-url":
				this.#renderOAuthAuthUrlStep();
				break;
			case "oauth-token-url":
				this.#renderOAuthTokenUrlStep();
				break;
			case "oauth-client-id":
				this.#renderOAuthClientIdStep();
				break;
			case "oauth-client-secret":
				this.#renderOAuthClientSecretStep();
				break;
			case "oauth-scopes":
				this.#renderOAuthScopesStep();
				break;
			case "apikey":
				this.#renderApiKeyStep();
				break;
			case "auth-location":
				this.#renderAuthLocationStep();
				break;
			case "env-var-name":
				this.#renderEnvVarNameStep();
				break;
			case "header-name":
				this.#renderHeaderNameStep();
				break;
			case "scope":
				this.#renderScopeStep();
				break;
			case "confirm":
				this.#renderConfirmStep();
				break;
		}
	}

	#renderNameStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤 1:服务器名称")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("为此服务器输入唯一名称:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.name);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		// Show validation error if any
		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(new Text(theme.fg("muted", "[仅限字母、数字、短横线、下划线、点、冒号]"), 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 取消]"), 0, 0));
	}

	#renderTransportStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤 2:传输类型")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("选择传输类型:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{ value: "stdio" as const, label: "stdio (本地进程)" },
			{ value: "http" as const, label: "http (HTTP 服务器)" },
			{ value: "sse" as const, label: "sse (服务器推送事件)" },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[↑↓ 导航,Enter 选择,Esc 取消]"), 0, 0));
	}

	#renderCommandStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤 3:命令")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入要运行的命令:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.command);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderArgsStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤 4:参数(可选)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入命令参数(以空格分隔):", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.args);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[按 Enter 跳过或继续]"), 0, 0));
	}

	#renderUrlStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤 3:服务器 URL")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入服务器 URL:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.url);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		// Show validation error if any
		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(new Text(theme.fg("muted", "[必须以 http:// 或 https:// 开头]"), 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderAuthLocationStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤:如何提供密钥?")));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{ value: "env" as const, label: "环境变量" },
			{ value: "header" as const, label: "HTTP 请求头" },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[↑↓ 导航,Enter 选择,Esc 返回]"), 0, 0));
	}

	#renderEnvVarNameStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤:环境变量名称")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入环境变量名称:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.envVarName);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderHeaderNameStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤:HTTP 请求头名称")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入 HTTP 请求头名称:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.headerName);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderScopeStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤:配置范围")));
		this.#contentContainer.addChild(new Spacer(1));

		const cwd = getProjectDir();

		const userPathLabel = shortenPath(getMCPConfigPath("user", cwd));
		const projectPathLabel = shortenPath(getMCPConfigPath("project", cwd));
		const options = [
			{ value: "user" as const, label: `用户级 (${userPathLabel})` },
			{ value: "project" as const, label: `项目级 (${projectPathLabel})` },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[↑↓ 导航,Enter 选择,Esc 返回]"), 0, 0));
	}

	#renderConfirmStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "检查配置")));
		this.#contentContainer.addChild(new Spacer(1));

		// Show summary
		this.#contentContainer.addChild(new Text(`名称: ${theme.fg("accent", this.#state.name)}`, 0, 0));
		this.#contentContainer.addChild(new Text(`类型: ${this.#state.transport}`, 0, 0));

		if (this.#state.transport === "stdio") {
			this.#contentContainer.addChild(new Text(`命令: ${this.#state.command}`, 0, 0));
			if (this.#state.args) {
				this.#contentContainer.addChild(new Text(`参数: ${this.#state.args}`, 0, 0));
			}
		} else {
			this.#contentContainer.addChild(new Text(`URL: ${sanitize(this.#state.url)}`, 0, 0));
		}

		// Auth info
		if (this.#state.authMethod === "none") {
			this.#contentContainer.addChild(new Text("认证:无", 0, 0));
		} else if (this.#state.authMethod === "oauth") {
			this.#contentContainer.addChild(new Text("认证:OAuth(已认证)", 0, 0));
		} else if (this.#state.authMethod === "manual") {
			if (this.#state.authLocation === "env") {
				this.#contentContainer.addChild(
					new Text(`认证:通过环境变量提供 API 密钥(${this.#state.envVarName})`, 0, 0),
				);
			} else {
				this.#contentContainer.addChild(new Text(`认证:通过请求头提供 API 密钥(${this.#state.headerName})`, 0, 0));
			}
		}

		const scopeLabel = this.#state.scope === "user" ? "用户级" : "项目级";
		this.#contentContainer.addChild(new Text(`范围: ${scopeLabel}`, 0, 0));

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("保存此配置?", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = ["是", "否"];
		for (let i = 0; i < options.length; i++) {
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", options[i]) : options[i];
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[↑↓ 导航,Enter 选择,Esc 返回]"), 0, 0));
	}

	handleInput(keyData: string): void {
		// While an OAuth callback is being awaited, Esc/Ctrl+C aborts the flow
		// rather than stepping back through the form: the wizard advertises
		// "(Press Esc to cancel)" during the wait, and stepping back would
		// leave the OAuth login orphaned.
		if (this.#oauthAbort && (keyData === "\x03" || matchesAppInterrupt(keyData))) {
			this.#oauthAbort.abort("MCP OAuth 流程已被用户取消");
			return;
		}

		// Handle Ctrl+C to cancel wizard immediately
		if (keyData === "\x03") {
			// Ctrl+C pressed - cancel wizard
			this.#onCancelCallback();
			return;
		}

		// Handle Escape (always handled by wizard)
		if (matchesAppInterrupt(keyData)) {
			if (this.#currentStep === "name") {
				// Cancel wizard
				this.#onCancelCallback();
				return;
			}
			// Go back to previous step
			this.#goBack();
			return;
		}

		// If we have an input field, let it handle the input
		if (this.#inputField) {
			// Handle Enter to proceed
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#saveInputAndProceed();
				return;
			}
			// Pass all other keys to the input field
			this.#inputField.handleInput(keyData);
			return;
		}

		// Selector steps - handle Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
			return;
		}

		// Handle up/down arrows for selectors
		if (matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}
	}

	#saveInputAndProceed(): void {
		if (!this.#inputField) return;

		const value = this.#inputField.getValue().trim();

		switch (this.#currentStep) {
			case "name": {
				// Validate server name
				const nameError = validateServerName(value);
				if (nameError) {
					this.#validationError = nameError;
					this.#renderStep();
					return;
				}
				this.#validationError = null;
				this.#state.name = value;
				this.#currentStep = "transport";
				this.#selectedIndex = 0;
				break;
			}
			case "command":
				if (!value) {
					// Command is required
					return;
				}
				this.#state.command = value;
				this.#currentStep = "args";
				break;
			case "args":
				this.#state.args = value; // Optional
				void this.#testConnectionAndDetectAuth();
				return;
			case "url": {
				// Validate URL
				if (!value) {
					this.#validationError = "必须提供 URL";
					this.#renderStep();
					return;
				}
				let parsedUrl: URL;
				try {
					parsedUrl = new URL(value);
				} catch {
					this.#validationError = "URL 格式无效(必须以 http:// 或 https:// 开头)";
					this.#renderStep();
					return;
				}
				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
					this.#validationError = "URL 必须使用 http:// 或 https:// 协议";
					this.#renderStep();
					return;
				}
				this.#validationError = null;
				this.#state.url = value;
				void this.#testConnectionAndDetectAuth();
				return;
			}
			case "oauth-auth-url":
				if (!value) return;
				this.#state.oauthAuthUrl = value;
				this.#currentStep = "oauth-token-url";
				break;
			case "oauth-token-url":
				if (!value) return;
				this.#state.oauthTokenUrl = value;
				this.#currentStep = "oauth-client-id";
				break;
			case "oauth-client-id":
				if (!value) return;
				this.#state.oauthClientId = value;
				this.#currentStep = "oauth-client-secret";
				break;
			case "oauth-client-secret":
				this.#state.oauthClientSecret = value; // Optional
				this.#currentStep = "oauth-scopes";
				break;
			case "oauth-scopes":
				this.#state.oauthScopes = value; // Optional
				// Launch OAuth flow
				void this.#launchOAuthFlow();
				return;
			case "apikey":
				if (!value) {
					// API key is required
					return;
				}
				this.#state.apiKey = value;
				// Determine auth location based on transport
				if (this.#state.transport === "stdio") {
					this.#currentStep = "env-var-name";
				} else {
					this.#currentStep = "auth-location";
					this.#selectedIndex = 0;
				}
				break;
			case "env-var-name":
				if (!value) {
					return;
				}
				this.#state.envVarName = value;
				this.#state.authLocation = "env";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				break;
			case "header-name":
				if (!value) {
					return;
				}
				this.#state.headerName = value;
				this.#state.authLocation = "header";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				break;
		}

		this.#inputField = null;
		this.#renderStep();
	}

	#selectCurrentOption(): void {
		switch (this.#currentStep) {
			case "transport": {
				const transports: TransportType[] = ["stdio", "http", "sse"];
				this.#state.transport = transports[this.#selectedIndex];
				this.#currentStep = this.#state.transport === "stdio" ? "command" : "url";
				break;
			}
			case "auth-method": {
				const authMethods: Array<"oauth" | "manual"> = ["oauth", "manual"];
				this.#state.authMethod = authMethods[this.#selectedIndex];
				if (this.#state.authMethod === "oauth") {
					this.#currentStep = "oauth-auth-url";
				} else {
					// manual
					this.#currentStep = "apikey";
				}
				break;
			}
			case "oauth-error":
				if (this.#selectedIndex === 0) {
					void this.#launchOAuthFlow();
				} else {
					this.#currentStep = "oauth-auth-url";
				}
				return;
			case "auth-location": {
				const authLocations: Array<"env" | "header"> = ["env", "header"];
				this.#state.authLocation = authLocations[this.#selectedIndex];
				if (this.#state.authLocation === "env") {
					this.#currentStep = "env-var-name";
				} else {
					this.#currentStep = "header-name";
				}
				break;
			}
			case "scope": {
				const scopes: Scope[] = ["user", "project"];
				this.#state.scope = scopes[this.#selectedIndex];
				this.#currentStep = "confirm";
				this.#selectedIndex = 0;
				break;
			}
			case "confirm": {
				if (this.#selectedIndex === 0) {
					this.#complete();
					return;
				}
				this.#currentStep = "scope";
				this.#selectedIndex = this.#state.scope === "user" ? 0 : 1;
				break;
			}
		}

		this.#renderStep();
	}

	#moveSelection(delta: number): void {
		const maxIndex = this.#getMaxIndexForCurrentStep();
		this.#selectedIndex = (this.#selectedIndex + delta + maxIndex + 1) % (maxIndex + 1);
		this.#renderStep();
		this.#requestRender();
	}

	#getMaxIndexForCurrentStep(): number {
		switch (this.#currentStep) {
			case "transport":
				return 2; // 3 options
			case "auth-method":
				return 1; // 2 options
			case "oauth-error":
				return 1; // 2 options
			case "auth-location":
				return 1; // 2 options
			case "scope":
				return 1; // 2 options
			case "confirm":
				return 1; // 2 options
			default:
				return 0;
		}
	}

	#goBack(): void {
		// Navigate to previous step
		switch (this.#currentStep) {
			case "transport":
				this.#currentStep = "name";
				break;
			case "command":
			case "url":
				this.#currentStep = "transport";
				this.#selectedIndex = this.#state.transport === "stdio" ? 0 : this.#state.transport === "http" ? 1 : 2;
				break;
			case "args":
				this.#currentStep = "command";
				break;
			case "auth-method":
				// Go back to url or args depending on transport
				if (this.#state.transport === "stdio") {
					this.#currentStep = "args";
				} else {
					this.#currentStep = "url";
				}
				break;
			case "oauth-auth-url":
			case "apikey":
				// Go back to transport-specific connection step
				if (this.#state.transport === "stdio") {
					this.#currentStep = "args";
				} else {
					this.#currentStep = "url";
				}
				break;
			case "auth-location":
				// Go back to API key input
				this.#currentStep = "apikey";
				break;
			case "env-var-name":
			case "header-name":
				// Go back to auth location selection (for HTTP) or directly to apikey (for stdio)
				if (this.#state.transport === "stdio") {
					this.#currentStep = "apikey";
				} else {
					this.#currentStep = "auth-location";
					this.#selectedIndex = this.#state.authLocation === "env" ? 0 : 1;
				}
				break;
			case "oauth-token-url":
			case "oauth-client-id":
			case "oauth-client-secret":
			case "oauth-scopes":
				// Go back through OAuth flow
				if (this.#currentStep === "oauth-token-url") {
					this.#currentStep = "oauth-auth-url";
				} else if (this.#currentStep === "oauth-client-id") {
					this.#currentStep = "oauth-token-url";
				} else if (this.#currentStep === "oauth-client-secret") {
					this.#currentStep = "oauth-client-id";
				} else if (this.#currentStep === "oauth-scopes") {
					this.#currentStep = "oauth-client-secret";
				}
				break;
			case "scope":
				// Go back to last authentication step
				if (this.#state.authMethod === "oauth") {
					this.#currentStep = "oauth-scopes";
				} else {
					// manual - go back to env var name or header name
					if (this.#state.authLocation === "env") {
						this.#currentStep = "env-var-name";
					} else {
						this.#currentStep = "header-name";
					}
				}
				break;
			case "oauth-error":
				this.#currentStep = "oauth-auth-url";
				break;
			case "confirm":
				this.#currentStep = "scope";
				this.#selectedIndex = this.#state.scope === "user" ? 0 : 1;
				break;
		}

		this.#renderStep();
	}

	#renderAuthMethodStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "步骤:身份验证方式")));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{ value: "oauth" as const, label: "OAuth 流程(基于 Web)", desc: "(将打开浏览器)" },
			{ value: "manual" as const, label: "手动输入 API 密钥/token", desc: "(粘贴或使用 shell 命令)" },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
			if (!isSelected) {
				this.#contentContainer.addChild(new Text(`    ${theme.fg("dim", option.desc)}`, 0, 0));
			}
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[↑↓ 导航,Enter 选择,Esc 返回]"), 0, 0));
	}

	#renderOAuthAuthUrlStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth:授权 URL")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入 OAuth 授权端点:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthAuthUrl);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "例如:https://auth.example.com/oauth/authorize"), 0, 0),
		);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderOAuthTokenUrlStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth:Token URL")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入 OAuth token 端点:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthTokenUrl);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "例如:https://auth.example.com/oauth/token"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderOAuthClientIdStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth:客户端 ID")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入您的 OAuth 客户端 ID:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthClientId);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderOAuthClientSecretStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth:客户端密钥(可选)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入您的 OAuth 客户端密钥:", 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "(仅 PKCE 流程可留空)"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthClientSecret);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderOAuthScopesStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth:作用域(可选)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入 OAuth 作用域(以空格分隔):", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthScopes);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "例如:read write"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	#renderOAuthErrorStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("error", "OAuth 身份验证失败"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("选择下一步操作:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = ["重试 OAuth 身份验证", "编辑 OAuth 设置"];
		for (let i = 0; i < options.length; i++) {
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", options[i]) : options[i];
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[↑↓ 导航,Enter 选择,Esc 返回]"), 0, 0));
	}

	#renderApiKeyStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "需要 API 密钥")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("输入您的 API 密钥或 token:", 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "(支持 !command,可用于密码管理器)"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.apiKey);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter 继续,Esc 返回]"), 0, 0));
	}

	/**
	 * Test connection and automatically detect if auth is needed.
	 */
	async #testConnectionAndDetectAuth(): Promise<void> {
		const testConfig = this.#buildServerConfig();

		if (!this.#onTestConnectionCallback) {
			// Skip test, go to scope
			this.#currentStep = "scope";
			this.#selectedIndex = 0;
			this.#renderStep();
			return;
		}

		try {
			// Try to connect - timeout is handled by the transport layer (5 seconds)
			await this.#onTestConnectionCallback(testConfig);

			// Success! No auth required
			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("success", "✓ 连接成功!"), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text("无需身份验证", 0, 0));
			this.#contentContainer.addChild(new Spacer(1));

			setTimeout(() => {
				this.#state.authMethod = "none";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				this.#renderStep();
			}, 1000);
		} catch (error) {
			// Connection failed - check if it's an auth error
			const authResult = analyzeAuthError(error as Error, this.#state.url);

			if (authResult.requiresAuth) {
				// Prefer OAuth first: use error metadata, then well-known discovery fallback.
				let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
				if (!oauth && this.#state.transport !== "stdio" && this.#state.url) {
					try {
						oauth = await discoverOAuthEndpoints(
							this.#state.url,
							authResult.authServerUrl,
							authResult.resourceMetadataUrl,
							{ protectedScopes: authResult.scopes },
						);
					} catch {
						// Ignore discovery failures and fallback to manual auth.
					}
				}
				if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
					// JSON-error-body path skips `discoverOAuthEndpoints` when the body
					// already carries endpoints, so scopes advertised only in the
					// protected-resource metadata document never reach the grant.
					const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
					if (scopes) oauth = { ...oauth, scopes };
				}

				if (oauth) {
					this.#state.oauthAuthUrl = oauth.authorizationUrl;
					this.#state.oauthTokenUrl = oauth.tokenUrl;
					this.#state.oauthRegistrationUrl = oauth.registrationUrl || "";
					this.#state.oauthClientId = oauth.clientId || "";
					this.#state.oauthScopes = oauth.scopes || "";
					this.#state.oauthResource = oauth.resource || (this.#state.transport === "stdio" ? "" : this.#state.url);
					this.#state.authMethod = "oauth";

					this.#contentContainer.clear();
					this.#contentContainer.addChild(new Text(theme.fg("success", "✓ 检测到 OAuth"), 0, 0));
					this.#contentContainer.addChild(new Spacer(1));
					this.#contentContainer.addChild(new Text("正在启动浏览器进行授权...", 0, 0));
					this.#contentContainer.addChild(new Spacer(1));

					void this.#launchOAuthFlow();
					return;
				}

				// OAuth metadata unavailable: fallback to manual API key.
				this.#contentContainer.clear();
				this.#contentContainer.addChild(new Text(theme.fg("warning", "⚠ 需要身份验证"), 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text("无法发现 OAuth 参数。", 0, 0));
				this.#contentContainer.addChild(new Text("请手动提供 API 密钥/token。", 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#currentStep = "apikey";
				this.#renderStep();
			} else {
				// Not an auth error - just a connection failure
				const errorMsg = sanitize(error instanceof Error ? error.message : String(error));
				this.#contentContainer.clear();
				this.#contentContainer.addChild(new Text(theme.fg("error", "✗ 连接失败"), 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(errorMsg, 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("muted", "仍将添加服务器..."), 0, 0));

				setTimeout(() => {
					this.#state.authMethod = "none";
					this.#currentStep = "scope";
					this.#selectedIndex = 0;
					this.#renderStep();
				}, 2000);
			}
		}
	}

	/**
	 * Build a server config from current wizard state for connection testing (no auth).
	 */
	#buildServerConfig(): MCPServerConfig {
		return this.#buildServerConfigWithAuth(false);
	}

	#buildServerConfigWithAuth(includeAuth: boolean): MCPServerConfig {
		const transport = this.#state.transport ?? "stdio";

		if (transport === "stdio") {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: this.#state.command,
				timeout: 5000,
			};

			if (this.#state.args) {
				config.args = this.#state.args.split(/\s+/).filter(Boolean);
			}

			if (includeAuth && this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
				config.auth = {
					type: "oauth",
					credentialId: this.#state.oauthCredentialId,
					tokenUrl: this.#state.oauthTokenUrl || undefined,
					resource: this.#state.oauthResource || undefined,
					clientId: this.#state.oauthClientId || undefined,
					clientSecret: this.#state.oauthClientSecret || undefined,
				};
			}

			if (includeAuth && this.#state.authMethod === "manual" && this.#state.apiKey) {
				config.env = {
					...(config.env ?? {}),
					[this.#state.envVarName || "API_KEY"]: this.#state.apiKey,
				};
			}

			return config;
		}

		// http or sse
		const config: MCPHttpServerConfig | MCPSseServerConfig = {
			type: transport,
			url: this.#state.url,
			timeout: 5000,
		};

		if (includeAuth && this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
			config.auth = {
				type: "oauth",
				credentialId: this.#state.oauthCredentialId,
				tokenUrl: this.#state.oauthTokenUrl || undefined,
				resource: this.#state.oauthResource || undefined,
				clientId: this.#state.oauthClientId || undefined,
				clientSecret: this.#state.oauthClientSecret || undefined,
			};
		}

		if (includeAuth && this.#state.authMethod === "manual" && this.#state.apiKey) {
			if (this.#state.authLocation === "env") {
				// For HTTP with env location, store in headers using the env var name as-is
				config.headers = {
					...(config.headers ?? {}),
					[this.#state.headerName || "Authorization"]: this.#state.apiKey,
				};
			} else {
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					...(config.headers ?? {}),
					[headerName]: this.#state.apiKey,
				};
			}
		}

		return config;
	}

	async #launchOAuthFlow(): Promise<void> {
		if (!this.#onOAuthCallback) {
			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("error", "OAuth 流程不可用"), 0, 0));
			this.#renderStep();
			this.#requestRender();
			return;
		}

		// Validate OAuth configuration
		if (!this.#state.oauthAuthUrl || !this.#state.oauthTokenUrl) {
			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("error", "OAuth 配置不完整"), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text("必须提供授权 URL 和 Token URL。", 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("muted", "[按 Esc 返回]"), 0, 0));
			this.#requestRender();
			return;
		}

		// Show "Authenticating..." message
		this.#contentContainer.clear();
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth 身份验证"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("正在启动 OAuth 流程...", 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "浏览器将自动打开。"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("warning", "如果浏览器未打开,请从聊天中复制 URL。"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "(按 Esc 取消)"), 0, 0));
		this.#requestRender();

		this.#oauthAbort = new AbortController();
		try {
			// Call OAuth handler
			const oauthResource = this.#state.oauthResource || (this.#state.transport === "stdio" ? "" : this.#state.url);
			const oauthResult = await this.#onOAuthCallback(
				this.#state.oauthAuthUrl,
				this.#state.oauthTokenUrl,
				this.#state.oauthClientId,
				this.#state.oauthClientSecret,
				this.#state.oauthScopes,
				{
					serverUrl: this.#state.url || undefined,
					registrationUrl: this.#state.oauthRegistrationUrl || undefined,
					resource: oauthResource || undefined,
					abortSignal: this.#oauthAbort.signal,
				},
			);

			// Store credential ID + any dynamically-registered client id. DCR client
			// secrets stay embedded in the stored credential, never in mcp.json.
			this.#state.oauthCredentialId = oauthResult.credentialId;
			if (oauthResult.clientId) this.#state.oauthClientId = oauthResult.clientId;
			this.#state.oauthResource = oauthResult.resource ?? oauthResource;

			// Show success message
			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("success", "✓ 身份验证成功!"), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("muted", "正在运行连接健康检查..."), 0, 0));
			const spinnerFrames = theme.spinnerFrames;
			const initialFrame = spinnerFrames[0] ?? "|";
			const healthText = new Text(theme.fg("muted", `${initialFrame} 正在检查服务器连接...`), 0, 0);
			this.#contentContainer.addChild(healthText);

			let spinnerIndex = 0;
			const spinner = setInterval(() => {
				healthText.setText(
					theme.fg("muted", `${spinnerFrames[spinnerIndex % spinnerFrames.length]} 正在检查服务器连接...`),
				);
				spinnerIndex++;
				this.#requestRender();
			}, 80);

			let healthPassed = true;
			let healthError = "";
			if (this.#onTestConnectionCallback) {
				try {
					const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
					const timer = setTimeout(() => timeoutReject(new Error("健康检查在 10 秒后超时")), 10_000);
					try {
						await Promise.race([
							this.#onTestConnectionCallback(this.#buildServerConfigWithAuth(true)),
							timeoutPromise,
						]);
					} finally {
						clearTimeout(timer);
					}
				} catch (error) {
					healthPassed = false;
					healthError = sanitize(error instanceof Error ? error.message : String(error));
				}
			}

			clearInterval(spinner);
			if (healthPassed) {
				healthText.setText(theme.fg("success", "✓ 健康检查通过"));
			} else {
				healthText.setText(theme.fg("warning", "⚠ 健康检查失败(仍将保存配置)"));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("muted", healthError), 0, 0));
			}
			this.#requestRender();

			// Move to scope selection after short delay
			setTimeout(
				() => {
					this.#currentStep = "scope";
					this.#selectedIndex = 0;
					this.#renderStep();
					this.#requestRender();
				},
				healthPassed ? 1000 : 2000,
			);
		} catch (error) {
			// User cancellation has its own neutral heading + tip; everything else
			// keeps the "OAuth authentication failed" framing so the existing tips
			// stay meaningful. Name-matching avoids importing controller types.
			const cancelled = error instanceof Error && error.name === "MCPOAuthCancelledError";
			const errorMsg = sanitize(error instanceof Error ? error.message : String(error));
			this.#contentContainer.clear();
			this.#contentContainer.addChild(
				new Text(cancelled ? theme.fg("muted", "○ OAuth 已取消") : theme.fg("error", "✗ OAuth 身份验证失败"), 0, 0),
			);
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(errorMsg, 0, 0));
			this.#contentContainer.addChild(new Spacer(1));

			// Provide helpful tips based on error type
			if (cancelled) {
				this.#contentContainer.addChild(new Text(theme.fg("muted", "提示:选择重试可再次打开浏览器。"), 0, 0));
			} else if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				this.#contentContainer.addChild(new Text(theme.fg("muted", "提示:下次请更快地完成授权"), 0, 0));
			} else if (errorMsg.includes("Invalid OAuth URLs")) {
				this.#contentContainer.addChild(new Text(theme.fg("muted", "提示:请检查 OAuth URL 是否正确"), 0, 0));
			} else if (errorMsg.includes("ECONNREFUSED")) {
				this.#contentContainer.addChild(new Text(theme.fg("muted", "提示:请确认 OAuth 服务器可访问"), 0, 0));
			}

			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(`${theme.fg("accent", "→ ")}重试`, 0, 0));
			this.#contentContainer.addChild(new Text("  编辑 OAuth 设置", 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("muted", "[↑↓ 导航,Enter 选择,Esc 返回]"), 0, 0));
			this.#requestRender();

			// Set up as a selector step
			this.#selectedIndex = 0;
			this.#currentStep = "oauth-error";
		} finally {
			this.#oauthAbort = null;
		}
	}

	#complete(): void {
		if (!this.#state.scope) return;

		// Build the config
		const config: MCPServerConfig = this.#buildConfig();

		// Call completion callback
		this.#onCompleteCallback(this.#state.name, config, this.#state.scope);
	}

	#buildConfig(): MCPServerConfig {
		if (this.#state.transport === "stdio") {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: this.#state.command,
			};

			if (this.#state.args) {
				config.args = this.#state.args.split(/\s+/).filter(Boolean);
			}

			// Add OAuth auth if configured
			if (this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
				config.auth = {
					type: "oauth",
					credentialId: this.#state.oauthCredentialId,
					tokenUrl: this.#state.oauthTokenUrl || undefined,
					resource: this.#state.oauthResource || undefined,
					clientId: this.#state.oauthClientId || undefined,
					clientSecret: this.#state.oauthClientSecret || undefined,
				};
			}

			// Add API key to env if manual auth — use user-chosen env var name
			if (this.#state.authMethod === "manual" && this.#state.apiKey) {
				const envKey = this.#state.envVarName || "API_KEY";
				config.env = {
					[envKey]: this.#state.apiKey,
				};
			}

			return config;
		}

		// HTTP or SSE — use concrete type
		const config: MCPHttpServerConfig | MCPSseServerConfig = {
			type: this.#state.transport!,
			url: this.#state.url,
		};

		// Add OAuth auth if configured
		if (this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
			config.auth = {
				type: "oauth",
				credentialId: this.#state.oauthCredentialId,
				tokenUrl: this.#state.oauthTokenUrl || undefined,
				resource: this.#state.oauthResource || undefined,
				clientId: this.#state.oauthClientId || undefined,
				clientSecret: this.#state.oauthClientSecret || undefined,
			};
		}

		// Add API key using user-chosen header name and auth location
		if (this.#state.authMethod === "manual" && this.#state.apiKey) {
			if (this.#state.authLocation === "env") {
				// Env-based auth for HTTP: store the key in env on the config
				// HTTP/SSE configs don't have an env field, so use headers as carrier
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					[headerName]: this.#state.apiKey,
				};
			} else {
				// Header-based auth: use the user's chosen header name
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					[headerName]: this.#state.apiKey,
				};
			}
		}

		return config;
	}
}
