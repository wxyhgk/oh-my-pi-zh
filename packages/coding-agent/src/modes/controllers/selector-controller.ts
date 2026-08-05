import { type AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import type { Component, OverlayHandle } from "@oh-my-pi/pi-tui";
import { Loader, Spacer, setTuiTight, Text } from "@oh-my-pi/pi-tui";
import { getAgentDbPath, getAgentDir, getProjectDir, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import {
	type AdvisorConfigScope,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../../advisor";
import { reset as resetCapabilities } from "../../capability";
import {
	formatModelSelectorValue,
	resolveAdvisorRoleSelection,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import { getRoleInfo } from "../../config/model-roles";
import { settings } from "../../config/settings";
import { disableProvider, enableProvider } from "../../discovery";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import {
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setMarkdownMermaidRendering,
	setSymbolPreset,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import type { SessionOAuthAccountList } from "../../session/agent-session-types";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "../../session/auth-storage";
import {
	createForeignSessionStore,
	foreignSessionInfoToSessionInfo,
	foreignSessionSourceName,
	persistForeignSession,
} from "../../session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource } from "../../session/foreign-session-store";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { type LogoutAccount, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import {
	describeRedeemOutcome,
	type ResetUsageAccount,
	toResetUsageAccounts,
} from "../../slash-commands/helpers/reset-usage";
import { toSessionPinAccounts } from "../../slash-commands/helpers/session-pin";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
} from "../../thinking";
import {
	isSearchProviderId,
	setExcludedSearchProviders,
	setImageProviderOrder,
	setSearchProviderOrder,
	type ToolSession,
} from "../../tools";
import { AskTool, type AskToolDetails, type AskToolInput } from "../../tools/ask";
import { shortenPath } from "../../tools/render-utils";
import { ToolAbortError } from "../../tools/tool-errors";
import { copyToClipboard } from "../../utils/clipboard";
import { repo } from "../../utils/git";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { type AdvisorConfigDeps, AdvisorConfigOverlayComponent } from "../components/advisor-config";
import { AgentDashboard } from "../components/agent-dashboard";
import { AgentHubOverlayComponent } from "../components/agent-hub";
import { AssistantMessageComponent } from "../components/assistant-message";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { LoginDialogComponent } from "../components/login-dialog";
import { LogoutAccountSelectorComponent } from "../components/logout-account-selector";
import { ModelHubComponent, type ModelRoleSelectionScope } from "../components/model-hub";
import { ModelPickerComponent } from "../components/model-picker";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { PluginSelectorComponent } from "../components/plugin-selector";
import { ReadToolGroupComponent } from "../components/read-tool-group";
import { ResetUsageSelectorComponent } from "../components/reset-usage-selector";
import { renderSegmentTrack } from "../components/segment-track";
import { SessionAccountSelectorComponent } from "../components/session-account-selector";
import { SessionSelectorComponent, type SessionSelectorOptions } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { StrippedToolCallsPlaceholder } from "../components/stripped-tool-calls-placeholder";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TranscriptBlock } from "../components/transcript-container";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { buildCopyTargets } from "../utils/copy-targets";

const MANUAL_LOGIN_PROMPT = "粘贴授权码(或完整的重定向 URL),然后按 Enter:";

export class SelectorController {
	constructor(private ctx: InteractiveModeContext) {}
	#defaultRoleMutationTail = Promise.resolve();

	async #acquireDefaultRoleMutation(): Promise<() => void> {
		const previous = this.#defaultRoleMutationTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#defaultRoleMutationTail = previous.then(() => promise);
		await previous;
		return resolve;
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}

	/**
	 * Restore keyboard focus to whatever currently owns the editor slot. The
	 * slot can hold the editor itself or a hook selector/input/editor pushed
	 * in by `ExtensionUiController` — e.g. an approval prompt that fired while
	 * a fullscreen overlay was up. `overlayHandle.hide()` restores focus to
	 * the component focused when the overlay opened, which is stale in that
	 * case (the editor was swapped out): keys land on a hidden editor and the
	 * visible prompt receives nothing (issue #3349). Call this after the
	 * overlay hides to re-target focus at the visible slot owner.
	 */
	focusActiveEditorArea(): void {
		const visible = this.ctx.editorContainer.children[0] ?? this.ctx.editor;
		this.ctx.ui.setFocus(visible);
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			// Fullscreen settings editor on the alternate screen: the overlay
			// enables mouse tracking (click/hover/wheel) for its lifetime and
			// the transcript stays untouched underneath.
			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
					thinkingLevel: this.ctx.session.thinkingLevel,
					availableThemes,
					providers: [...new Set(this.ctx.session.getAvailableModels().map(model => model.provider))].sort(
						(a, b) => a.localeCompare(b),
					),
					cwd: getProjectDir(),
					model: this.ctx.session.model,
					imageBudget: this.ctx.ui.imageBudget,
					requestRender: () => this.ctx.ui.requestRender(),
				},
				{
					onChange: (id, value) => this.handleSettingChange(id, value),
					onThemePreview: async themeName => {
						const result = await previewTheme(themeName);
						if (result.success) {
							this.ctx.statusLine.invalidate();
							this.ctx.ui.invalidate();
							this.ctx.ui.requestRender();
						}
					},
					onStatusLinePreview: previewSettings => {
						// Update status line with preview settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
							...previewSettings,
						});
						this.ctx.ui.requestRender();
					},
					getStatusLinePreview: () => {
						// Return the rendered status line for inline preview
						const availableWidth = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
						return this.ctx.statusLine.getTopBorder(availableWidth).content;
					},
					onPluginsChanged: async () => {
						const projectPath = await resolveActiveProjectRegistryPath(this.ctx.sessionManager.getCwd());
						clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
						await this.ctx.refreshSkillState();
						await this.ctx.refreshSlashCommandState();
						resetCapabilities();
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						// Restore status line to saved settings
						this.ctx.statusLine.updateSettings({
							preset: settings.get("statusLine.preset"),
							leftSegments: settings.get("statusLine.leftSegments"),
							rightSegments: settings.get("statusLine.rightSegments"),
							separator: settings.get("statusLine.separator"),
							showHookStatus: settings.get("statusLine.showHookStatus"),
							sessionAccent: settings.get("statusLine.sessionAccent"),
							transparent: settings.get("statusLine.transparent"),
							compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
						});
						this.ctx.ui.requestRender();
					},
				},
			);
			overlayHandle = this.ctx.ui.showOverlay(selector, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(selector);
			this.ctx.ui.requestRender();
		});
	}

	showAdvisorConfigure(): void {
		const cwd = this.ctx.sessionManager.getCwd();
		const agentDir = getAgentDir() ?? getProjectDir();
		const initialScope: AdvisorConfigScope = "project";
		void (async () => {
			// "Project" scope edits the repo-root WATCHDOG.yml (the project-level file
			// discovery walks), not the launch subdir — `getProjectDir()` is only cwd.
			let projectDir = cwd;
			try {
				projectDir = (await repo.root(cwd)) ?? cwd;
			} catch {
				projectDir = cwd;
			}
			const dirs = { projectDir, agentDir };
			const initialDoc = await loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(initialScope, dirs));
			// Fullscreen editor on the alternate screen (the /settings idiom): the
			// overlay holds the alt buffer + mouse tracking; the transcript stays put.
			let overlayHandle: OverlayHandle | undefined;
			const done = () => {
				overlayHandle?.hide();
				this.focusActiveEditorArea();
				this.ctx.ui.requestRender();
			};
			// Label the seeded implicit-default row with the actual advisor-role model
			// (NOT the first live advisor, which may be a named advisor from another scope).
			const advisorRoleSel = resolveAdvisorRoleSelection(
				this.ctx.settings,
				this.ctx.session.modelRegistry.getAvailable(),
			);
			const defaultAdvisorModel = advisorRoleSel?.model;
			const deps: AdvisorConfigDeps = {
				modelRegistry: this.ctx.session.modelRegistry,
				settings: this.ctx.settings,
				scopedModels: this.ctx.session.scopedModels,
				availableToolNames: this.ctx.session.getAdvisorAvailableToolNames(),
				defaultModelLabel: defaultAdvisorModel
					? `${defaultAdvisorModel.provider}/${defaultAdvisorModel.id}`
					: undefined,
			};
			const overlay = new AdvisorConfigOverlayComponent(this.ctx.ui, deps, initialScope, initialDoc, {
				loadDoc: async scope => loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
				save: async (scope, doc) => {
					await saveWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs), doc);
					// Re-discover the merged roster (project + user) so the live advisors
					// reflect cross-level precedence, not just the edited file.
					const discovered = await discoverAdvisorConfigs(cwd, agentDir);
					const count = this.ctx.session.applyAdvisorConfigs(discovered.advisors, discovered.sharedInstructions);
					this.ctx.statusLine.invalidate();
					this.ctx.showStatus(
						count > 0
							? `已保存 ${scope} 的 WATCHDOG.yml — ${count} 个顾问已启用。`
							: `已保存 ${scope} 的 WATCHDOG.yml。运行 /advisor on 以启用已配置的顾问。`,
					);
					this.ctx.ui.requestRender();
				},
				close: done,
				requestRender: () => this.ctx.ui.requestRender(),
				notify: message => this.ctx.showStatus(message),
				getAdvisorStats: () => this.ctx.session.getAdvisorStats().advisors,
				getUsageReports: async () => this.ctx.session.fetchUsageReports?.() ?? null,
				resolveActiveAccount: (provider, sessionId) =>
					this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
						provider,
						sessionId ?? this.ctx.session.sessionId,
					),
			});
			overlayHandle = this.ctx.ui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(overlay);
			this.ctx.ui.requestRender();
		})();
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);
		// Fullscreen dashboard on the alternate screen (the /settings idiom): the
		// overlay borrows the terminal's alt buffer and enables mouse tracking for
		// its lifetime, leaving the transcript untouched underneath.
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
			fullscreen: true,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Show the Agent Control Center dashboard.
	 */
	async showAgentsDashboard(): Promise<void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		const dashboard = await AgentDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows, {
			modelRegistry: this.ctx.session.modelRegistry,
			activeModelPattern,
			defaultModelPattern,
		});
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => {
			this.ctx.ui.requestRender();
		};
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "advisor.enabled":
				this.ctx.session.setAdvisorEnabled(value as boolean);
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ConfiguredThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;
			case "personality":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`应用个性设置失败:${err}`);
				});
				break;
			case "tools.xdevDocs":
				void this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`应用 xd:// 提示词文档设置失败:${err}`);
				});
				break;
			case "memory.backend":
				void this.ctx.session.applyMemoryBackend().catch(err => {
					this.ctx.showError(`应用记忆后端失败:${err}`);
				});
				break;
			case "inspect_image.mode":
				void this.ctx.session.applyInspectImageModeChange().catch(err => {
					this.ctx.showError(`应用视觉模式失败:${err}`);
				});
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

			// Settings with UI side effects
			case "display.hideToolActivity": {
				const hidden = value as boolean;
				this.ctx.hideToolActivity = hidden;
				if (!hidden) this.ctx.toolOutputExpanded = false;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent) {
						if (!hidden) child.setExpanded(false);
						child.setToolActivityVisible(!hidden);
					} else if (child instanceof AssistantMessageComponent) {
						child.setToolResultImagesVisible(!hidden);
					} else if (child instanceof StrippedToolCallsPlaceholder) {
						child.setToolActivityVisible(!hidden);
					}
				}
				if (hidden) this.ctx.ui.clearInlineImages();
				this.ctx.ui.resetDisplay();
				break;
			}
			case "terminal.showImages":
			case "showImages": {
				const visible = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(visible);
					} else if (child instanceof AssistantMessageComponent) {
						child.setImagesVisible(visible);
					}
				}
				if (!visible) this.ctx.ui.clearInlineImages();
				this.ctx.ui.resetDisplay();
				break;
			}
			case "hideThinkingBlock":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
					}
				}
				// Full clear + replay so blocks frozen in committed scrollback on
				// ED3-risk terminals retire their stale snapshots too (see
				// InputController.toggleThinkingBlockVisibility).
				this.ctx.ui.resetDisplay();
				break;
			case "proseOnlyThinking":
				this.ctx.proseOnlyThinking = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setProseOnlyThinking(value as boolean);
					}
				}
				this.ctx.ui.resetDisplay();
				break;
			case "omitThinking":
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				break;
			case "display.cacheMissMarker":
				// Rebuild re-runs the usage-based detection under the new setting so
				// markers appear/disappear; full reset retires any already committed
				// to native scrollback (mirrors hideThinking).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "display.collapseCompacted":
				// Rebuild swaps between the collapsed tail and the full inline
				// history; full reset retires blocks already committed to native
				// scrollback (mirrors cacheMissMarker).
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;
			case "tui.tight":
				setTuiTight(value as boolean);
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;

			case "tui.scrollbackRebuild":
				this.ctx.ui.setScrollbackRebuild(value as boolean);
				break;

			case "tui.renderMermaid":
				setMarkdownMermaidRendering(value as boolean);
				this.ctx.session.refreshBaseSystemPrompt().catch(err => {
					this.ctx.showError(`应用 Mermaid 渲染设置失败:${err}`);
				});
				this.ctx.rebuildChatFromMessages();
				this.ctx.ui.resetDisplay();
				break;

			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`加载主题 "${value}" 失败:${result.error}\n已回退到深色主题。`);
					}
				});
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "git.enabled":
			case "statusLinePreset":
			case "statusLine.preset":
			case "statusLineSeparator":
			case "statusLine.separator":
			case "statusLineShowHooks":
			case "statusLine.showHookStatus":
			case "statusLine.sessionAccent":
			case "statusLine.transparent":
			case "statusLine.compactThinkingLevel":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				const statusLineSettings = {
					preset: settings.get("statusLine.preset"),
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					sessionAccent: settings.get("statusLine.sessionAccent"),
					transparent: settings.get("statusLine.transparent"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
					compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "providers.webSearchOrder":
				if (Array.isArray(value)) {
					setSearchProviderOrder(value.filter(isSearchProviderId));
				}
				break;
			case "providers.webSearchExclude":
				if (Array.isArray(value)) {
					setExcludedSearchProviders(value.filter(isSearchProviderId));
				}
				break;
			case "providers.imageOrder":
				if (Array.isArray(value)) {
					setImageProviderOrder(value.filter((entry): entry is string => typeof entry === "string"));
				}
				break;

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		if (options?.temporaryOnly) {
			this.#showModelPicker();
			return;
		}
		this.#showModelHub({});
	}

	/**
	 * Compact session-only model picker (alt+p / `/switch`): a floating
	 * bottom-anchored overlay over the transcript. The current model is
	 * highlighted and preselected; a leading `@` searches ctrl+p quick roles.
	 */
	#showModelPicker(): void {
		const currentContextTokens = this.ctx.session.getContextUsage()?.tokens ?? 0;
		const current = this.ctx.session.model;
		const quickRoleOrder = this.ctx.settings.get("cycleOrder");
		const quickRoleCycle = this.ctx.session.getRoleModelCycle(quickRoleOrder);
		let overlayHandle: OverlayHandle | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const picker = new ModelPickerComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onPick: async (model, selector, { overContext }) => {
					// Session-only: update agent state but don't persist the model to settings.
					const applySessionModel = async () => {
						const roleThinkingLevel = this.ctx.session.resolveTemporaryModelThinkingLevel(model);
						await this.ctx.session.setModelTemporary(model, roleThinkingLevel);
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						const roleSelectorHint = this.ctx.keybindings.getKeys("app.model.select")[0] ?? "Alt+M";
						this.ctx.showStatus(`仅会话模型:${selector}。使用 ${roleSelectorHint} 或 /model 选择角色。`);
					};
					try {
						if (overContext) {
							// Over-context pick: close the picker so the compaction loader is
							// visible, compact with the current model, then switch. The switch
							// runs in the before-flush hook so any prompt queued during
							// compaction executes on the target model, not the old one; the
							// early "nothing to compact" return skips the hook, so the
							// idempotent post-return call covers it. A cancelled or failed
							// compaction keeps the current model — the target still cannot
							// fit the transcript.
							done();
							let switched = false;
							const switchAfterCompaction = async (outcome: CompactionOutcome) => {
								if (switched || outcome !== "ok") return;
								switched = true;
								await applySessionModel();
							};
							const outcome = await this.ctx.handleCompactCommand(undefined, undefined, switchAfterCompaction);
							await switchAfterCompaction(outcome);
							return;
						}
						await applySessionModel();
						done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onPickRole: async entry => {
					try {
						await this.ctx.session.applyRoleModel(entry);
						this.ctx.statusLine.invalidate();
						this.ctx.updateEditorBorderColor();
						this.ctx.showModelCycleTrack(
							renderSegmentTrack(
								quickRoleOrder.map(role => ({ label: role })),
								quickRoleOrder.indexOf(entry.role),
							),
						);
						done();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onCancel: done,
			},
			{
				currentContextTokens,
				currentSelector: current ? `${current.provider}/${current.id}` : undefined,
				quickRoles: quickRoleCycle?.models,
				quickRoleOrder,
				currentQuickRole: quickRoleCycle?.models[quickRoleCycle.currentIndex]?.role,
			},
		);
		overlayHandle = this.ctx.ui.showOverlay(picker, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(picker);
		this.ctx.ui.requestRender();
	}

	/**
	 * Fullscreen model hub on the alternate screen (the /settings idiom): the
	 * overlay enables mouse tracking for its lifetime and the transcript stays
	 * untouched underneath. `initialProviderId` preselects a provider's sidebar
	 * entry — used when reopening the hub after a /login round-trip.
	 */
	#showModelHub(hubOptions: { initialProviderId?: string }): void {
		let overlayHandle: OverlayHandle | undefined;
		let hub: ModelHubComponent | undefined;
		let closed = false;
		const done = () => {
			// Re-entrant guard: cancel paths (Esc, login forward) may race;
			// the overlay must hide exactly once.
			if (closed) return;
			closed = true;
			hub?.dispose();
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		hub = new ModelHubComponent(
			this.ctx.ui,
			this.ctx.settings,
			this.ctx.session.modelRegistry,
			this.ctx.session.scopedModels,
			{
				onAssign: async (model, role, thinkingLevel, selector, scope?: ModelRoleSelectionScope) => {
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					// `auto` is session-global: never baked into a per-role model value
					// (it can't round-trip through `model:<level>`). Apply it to the session
					// separately and persist via `defaultThinkingLevel`.
					const isAuto = thinkingLevel === AUTO_THINKING;
					const concreteThinking = isAuto || thinkingLevel === undefined ? undefined : thinkingLevel;
					const selectorValue = selector ?? `${model.provider}/${model.id}`;
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "项目" : "全局"} ` : "";
					const defaultStatusLabel = configuredStorage === "project" ? `${scopeLabel}默认` : "默认";
					try {
						if (role === "default") {
							const effectiveProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const shadowedGlobal =
								configuredStorage === "project" &&
								targetScope === "global" &&
								(effectiveProvenance === "project" ||
									effectiveProvenance === "overlay" ||
									(effectiveProvenance === "runtime" &&
										this.ctx.settings.isProjectModelRoleRuntimeOverrideActive("default")));
							const shadowedProject =
								configuredStorage === "project" &&
								targetScope === "project" &&
								effectiveProvenance === "overlay";
							if (shadowedGlobal) {
								this.ctx.settings.setModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
								if (isAuto) {
									this.ctx.settings.set("defaultThinkingLevel", AUTO_THINKING);
								}
							} else if (shadowedProject) {
								this.ctx.settings.setProjectModelRole(
									"default",
									formatModelSelectorValue(selectorValue, concreteThinking),
								);
								if (isAuto) {
									this.ctx.settings.set("defaultThinkingLevel", AUTO_THINKING);
								}
							} else {
								const { switched } = await this.ctx.session.setModel(model, role, {
									selector,
									thinkingLevel: isAuto ? ThinkingLevel.Inherit : concreteThinking,
									persist: targetScope === "global",
								});
								if (!switched) return;
								if (targetScope === "project") {
									this.ctx.settings.setProjectModelRole(
										"default",
										formatModelSelectorValue(selectorValue, concreteThinking),
									);
								}
								if (isAuto) {
									this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
								} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
									this.ctx.session.setThinkingLevel(concreteThinking);
								}
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorBorderColor();
							}
							this.ctx.showStatus(`${defaultStatusLabel} 模型:${selector ?? model.id}`);
						} else {
							// Other roles (smol, slow, custom): update settings, not the current model.
							const modelRoleValue = formatModelSelectorValue(selectorValue, concreteThinking);
							if (targetScope === "project") {
								this.ctx.settings.setProjectModelRole(role, modelRoleValue);
							} else {
								this.ctx.settings.setModelRole(role, modelRoleValue);
							}
							if (isAuto) {
								this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
							}
							const roleInfo = getRoleInfo(role, settings);
							this.ctx.showStatus(
								`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} 模型:${selector ?? model.id}`,
							);
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onUnassign: async (role, scope?: ModelRoleSelectionScope) => {
					const releaseDefaultMutation = role === "default" ? await this.#acquireDefaultRoleMutation() : undefined;
					const configuredStorage = this.ctx.settings.get("modelRoleStorage");
					const targetScope = configuredStorage === "project" ? (scope ?? "project") : "global";
					const scopeLabel =
						configuredStorage === "project" ? `${targetScope === "project" ? "项目" : "全局"} ` : "";
					try {
						const previousEffectiveRoleValue =
							role === "default" ? this.ctx.settings.getModelRole("default") : undefined;
						if (targetScope === "project") {
							this.ctx.settings.clearProjectModelRole(role);
						} else {
							this.ctx.settings.setModelRole(role, undefined);
						}
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							`${scopeLabel}${roleInfo?.tag ?? roleInfo?.name ?? role} 角色已清除 — 自动选择生效`,
						);
						// Clearing either persisted scope can also remove a captured
						// runtime override. When that changes the effective default,
						// resolve the newly exposed persisted layer and switch the live
						// session without writing it back to global settings. Overlay
						// and runtime provenance remain authoritative and session-neutral.
						if (role === "default") {
							const fallbackRoleValue = this.ctx.settings.getModelRole("default");
							const fallbackProvenance = this.ctx.settings.getModelRoleProvenance("default");
							const exposesPersistedFallback =
								fallbackProvenance === "project" || fallbackProvenance === "global";
							if (
								fallbackRoleValue &&
								fallbackRoleValue !== previousEffectiveRoleValue &&
								exposesPersistedFallback
							) {
								const scopedModels = this.ctx.session.scopedModels.map(sm => sm.model);
								const availableModels =
									scopedModels.length > 0 ? scopedModels : this.ctx.session.getAvailableModels();
								const resolved = resolveModelRoleValue(fallbackRoleValue, availableModels, {
									settings: this.ctx.settings,
								});
								if (resolved.model) {
									const fallbackModel = resolved.model;
									const isAuto = resolved.thinkingLevel === AUTO_THINKING;
									let concreteThinking = concreteThinkingLevel(resolved.thinkingLevel);
									let isAutoFromDefault = false;
									if (!resolved.explicitThinkingLevel && !concreteThinking) {
										const defaultLevel = parseConfiguredThinkingLevel(
											this.ctx.settings.get("defaultThinkingLevel"),
										);
										if (defaultLevel === AUTO_THINKING) {
											isAutoFromDefault = true;
										} else if (defaultLevel) {
											concreteThinking = defaultLevel;
										}
									}
									const effectiveIsAuto = isAuto || isAutoFromDefault;
									const { switched } = await this.ctx.session.setModel(fallbackModel, "default", {
										persist: false,
										thinkingLevel: effectiveIsAuto
											? ThinkingLevel.Inherit
											: (concreteThinking ?? ThinkingLevel.Inherit),
									});
									if (!switched) return;
									if (effectiveIsAuto) {
										this.ctx.session.setThinkingLevel(AUTO_THINKING, true);
									} else if (concreteThinking && concreteThinking !== ThinkingLevel.Inherit) {
										this.ctx.session.setThinkingLevel(concreteThinking);
									}
									this.ctx.statusLine.invalidate();
									this.ctx.updateEditorBorderColor();
								}
							}
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						releaseDefaultMutation?.();
						hub?.refreshAfterExternalMutation();
					}
				},
				onFallbackChainChange: (role, chain) => {
					try {
						const chains = { ...this.ctx.settings.get("retry.fallbackChains") };
						if (chain.length === 0) {
							delete chains[role];
						} else {
							chains[role] = chain;
						}
						this.ctx.settings.set("retry.fallbackChains", chains);
						const roleInfo = getRoleInfo(role, settings);
						this.ctx.showStatus(
							chain.length > 0
								? `${roleInfo?.tag ?? roleInfo?.name ?? role} 回退:${chain.join(" → ")}`
								: `${roleInfo?.tag ?? roleInfo?.name ?? role} 回退已清除`,
						);
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},

				onLoginRequest: providerId => {
					done();
					void this.#loginThenReopenModelHub(providerId);
				},
				onCycleOrderChange: order => {
					try {
						this.ctx.settings.set("cycleOrder", order);
						this.ctx.showStatus(
							order.length > 0 ? `快速切换循环:${order.join(" → ")}` : "快速切换循环已清除",
						);
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onCancel: () => done(),
			},
			{
				initialProviderId: hubOptions.initialProviderId,
			},
		);
		overlayHandle = this.ctx.ui.showOverlay(hub, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(hub);
		this.ctx.ui.requestRender();
	}

	/** /login round-trip for a locked provider; reopen the hub on that provider only after a successful login. */
	async #loginThenReopenModelHub(providerId: string): Promise<void> {
		const succeeded = await this.#handleOAuthLogin(providerId);
		if (succeeded) {
			this.#showModelHub({ initialProviderId: providerId });
		}
	}

	async showPluginSelector(mode: "install" | "uninstall" = "install"): Promise<void> {
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const [marketplaces, installed] = await Promise.all([mgr.listMarketplaces(), mgr.listInstalledPlugins()]);
		const installedIds = new Set(installed.map(p => p.id));

		if (mode === "uninstall") {
			// Show only installed plugins for uninstall
			const items = installed.map(p => {
				const entry = p.entries[0];
				const atIdx = p.id.lastIndexOf("@");
				const pluginName = atIdx > 0 ? p.id.slice(0, atIdx) : p.id;
				const mkt = atIdx > 0 ? p.id.slice(atIdx + 1) : "unknown";
				return {
					plugin: { name: pluginName, version: entry?.version, description: undefined as string | undefined },
					marketplace: mkt,
					scope: p.scope,
				};
			});
			this.showSelector(done => {
				const selector = new PluginSelectorComponent(marketplaces.length, items, new Set(), {
					onSelect: async (name, marketplace, scope) => {
						done();
						const pluginId = `${name}@${marketplace}`;
						this.ctx.showStatus(`正在卸载 ${pluginId}...`);
						this.ctx.ui.requestRender();
						try {
							await mgr.uninstallPlugin(pluginId, scope);
							this.ctx.showStatus(`已卸载 ${pluginId}`);
						} catch (err) {
							this.ctx.showStatus(`卸载失败:${err}`);
						}
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.ui.requestRender();
					},
				});
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		// Install mode: show all available plugins from all marketplaces
		const allPlugins: Array<{
			plugin: { name: string; version?: string; description?: string };
			marketplace: string;
		}> = [];
		for (const mkt of marketplaces) {
			const plugins = await mgr.listAvailablePlugins(mkt.name);
			for (const plugin of plugins) {
				allPlugins.push({ plugin, marketplace: mkt.name });
			}
		}

		this.showSelector(done => {
			const selector = new PluginSelectorComponent(marketplaces.length, allPlugins, installedIds, {
				onSelect: async (name, marketplace) => {
					done();
					this.ctx.showStatus(`正在从 ${marketplace} 安装 ${name}...`);
					this.ctx.ui.requestRender();
					try {
						const force = installedIds.has(`${name}@${marketplace}`);
						await mgr.installPlugin(name, marketplace, { force });
						this.ctx.showStatus(`已从 ${marketplace} 安装 ${name}`);
					} catch (err) {
						this.ctx.showStatus(`安装失败:${err}`);
					}
					this.ctx.ui.requestRender();
				},
				onCancel: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("没有可分支的消息");
			return;
		}

		this.showSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}

					this.ctx.renderInitialMessages({ clearTerminalHistory: true });
					this.ctx.editor.setDraft(result.selectedText, result.selectedImages);
					done();
					this.ctx.showStatus("已分支到新会话");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	showCopySelector(): void {
		const targets = buildCopyTargets(this.ctx.session);
		if (targets.length === 0) {
			this.ctx.showStatus("暂无可复制的内容。");
			return;
		}

		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.ctx.ui.requestRender();
		};
		const selector = new CopySelectorComponent(targets, {
			onPick: target => {
				done();
				if (target.content === undefined) return;
				void copyToClipboard(target.content);
				this.ctx.showStatus(target.copyMessage ?? "已复制到剪贴板");
			},
			onCancel: done,
		});

		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("会话中没有条目");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async (entryId, options) => {
					// Selecting the current leaf is normally a no-op (already there) —
					// unless it's an `ask` toolResult, in which case the re-answer flow
					// must still be allowed to reopen the picker even though the leaf
					// doesn't move (chatgpt-codex review on #5895).
					if (entryId === realLeafId) {
						const currentEntry = this.ctx.sessionManager.getEntry(entryId);
						const currentIsAskResult =
							currentEntry?.type === "message" &&
							currentEntry.message.role === "toolResult" &&
							currentEntry.message.toolName === "ask";
						if (!currentIsAskResult) {
							done();
							this.ctx.showStatus("已在该位置");
							return;
						}
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree.
					// Shift+Enter in the tree selector pre-answers "Summarize" and
					// skips the prompt entirely.
					let wantsSummary = options.summarize;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (!wantsSummary && branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("汇总分支?", [
							"不汇总",
							"汇总",
							"使用自定义提示词汇总",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "不汇总";

						if (summaryChoice === "使用自定义提示词汇总") {
							customInstructions = await this.ctx.showHookEditor("自定义汇总说明");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"正在汇总分支...(esc 取消)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						let result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
							allowAskReopen: true,
						});

						// Selecting an `ask` toolResult doesn't land the leaf directly —
						// re-open the picker with the original questions first, then
						// complete the navigation as a new sibling branch (issue #5642).
						if (result.reopenAsk) {
							const reanswer = await this.#reanswerAsk(result.reopenAsk.questions);
							if (!reanswer) {
								this.ctx.showStatus("已取消重新回答");
								return;
							}
							result = await this.ctx.session.navigateTree(entryId, {
								summarize: wantsSummary,
								customInstructions,
								allowAskReopen: true,
								reanswerAskResult: reanswer,
							});
						}

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("已取消分支汇总");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("已取消导航");
							return;
						}

						// Update UI — rebuild the display transcript for the new leaf (the
						// context from navigateTree is the LLM context, not the transcript).
						this.ctx.renderInitialMessages({ clearTerminalHistory: true });
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setDraft(result.editorText, result.editorImages);
						}
						this.ctx.showStatus("已导航到所选位置");

						// Re-answering a past `ask` commits a new sibling answer but,
						// unlike a live `ask`, leaves the agent idle. Resume it now —
						// after the transcript rebuild above — so the model consumes the
						// new answer without the resumed turn rendering against the stale
						// pre-rebuild UI (issue #6483).
						if (result.askReanswerCommitted) {
							this.ctx.session.resumeAfterAskReanswer();
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.disposeChildren();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * Re-open the `ask` picker with the original `questions` (issue #5642):
	 * runs a standalone `AskTool.execute()` outside a normal agent turn,
	 * reusing the same picker/dialog primitives a live `ask` tool call gets.
	 * Returns `undefined` when the user cancels — mirrors `navigateTree`'s
	 * cancellation contract instead of throwing.
	 */
	async #reanswerAsk(questions: AskToolInput["questions"]): Promise<AgentToolResult<AskToolDetails> | undefined> {
		const uiContext = this.ctx.getToolUIContext();
		if (!uiContext) {
			this.ctx.showError("Ask 工具界面尚未就绪");
			return undefined;
		}
		const toolSession: ToolSession = {
			cwd: this.ctx.sessionManager.getCwd(),
			hasUI: true,
			settings: this.ctx.settings,
			getSessionFile: () => this.ctx.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			getPlanModeState: () => this.ctx.session.getPlanModeState(),
		};
		const askTool = new AskTool(toolSession);
		const context = this.ctx.session.buildAskReanswerContext(uiContext);
		let result: AgentToolResult<AskToolDetails>;
		try {
			result = await askTool.execute("tree-reanswer", { questions }, undefined, undefined, context);
		} catch (error) {
			if (error instanceof ToolAbortError) return undefined;
			throw error;
		}
		// The rich ask dialog can race a collab guest choosing "Chat about this"
		// (`AskTool`'s `chatRedirect` result); that's meaningful inside a live
		// agent turn, where the model sees the redirect and starts a
		// conversation, but this standalone re-answer has no turn to hand it
		// to — completing the navigation with it would silently drop the
		// user's intent to chat (roboomp review on #5895).
		if (result.details?.chatRedirect) {
			this.ctx.showError(
				"从树中重新回答时无法使用“就此进行对话” — 请改选一个选项或输入自定义回答。",
			);
			return undefined;
		}
		return result;
	}

	async showSessionSelector(source?: ForeignSessionSource): Promise<void> {
		let sessions: SessionInfo[];
		let onSelectSession: (session: SessionInfo) => Promise<boolean>;
		let selectorOptions: SessionSelectorOptions;

		if (source) {
			const sourceName = foreignSessionSourceName(source);
			const store = createForeignSessionStore(source);
			let foreignSessions: ForeignSessionInfo[];
			try {
				foreignSessions = await store.list();
			} catch (error) {
				this.ctx.showError(
					`列出 ${sourceName} 会话失败:${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			if (foreignSessions.length === 0) {
				this.ctx.showWarning(`未找到 ${sourceName} 会话`);
				return;
			}
			const foreignByPath = new Map(foreignSessions.map(session => [session.path, session]));
			sessions = foreignSessions.map(foreignSessionInfoToSessionInfo);
			onSelectSession = async session => {
				try {
					await this.ctx.settings.flush();
				} catch (error) {
					this.ctx.showError(
						`保存待定设置失败:${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
				const foreignSession = foreignByPath.get(session.path);
				if (!foreignSession) throw new Error(`所选 ${sourceName} 会话不再可用`);
				const imported = await persistForeignSession(store, foreignSession, {
					fallbackCwd: this.ctx.sessionManager.getCwd(),
					suppressBreadcrumb: true,
				});
				const sessionFile = imported.getSessionFile();
				if (!sessionFile) throw new Error(`持久化 ${sourceName} 会话失败`);
				await imported.close();
				return await this.handleResumeSession(sessionFile, { settingsFlushed: true });
			};
			selectorOptions = {
				title: `导入 ${sourceName} 会话`,
				scopeLabel: false,
				showCwd: true,
			};
		} else {
			sessions = await SessionManager.list(
				this.ctx.sessionManager.getCwd(),
				this.ctx.sessionManager.getSessionDir(),
			);
			const historyStorage = this.ctx.historyStorage;
			const historyMatcher = historyStorage
				? (query: string) => historyStorage.matchingSessionIds(query)
				: undefined;
			onSelectSession = session => this.handleResumeSession(session.path);
			selectorOptions = {
				onDelete: async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
						return true;
					} catch (error) {
						throw new Error(
							`删除会话失败:${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
					}
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAll(),
			};
		}

		// Keep the fullscreen picker on the alternate buffer while a selected
		// session is loaded and its transcript is rebuilt.
		let overlayHandle: OverlayHandle | undefined;
		const done = () => {
			overlayHandle?.hide();
			this.focusActiveEditorArea();
			this.ctx.ui.requestRender();
		};
		const selector = new SessionSelectorComponent(
			sessions,
			async (session: SessionInfo) => {
				selector.lockInput();
				let keepOpen = false;
				try {
					const success = await onSelectSession(session);
					if (!success) {
						keepOpen = true;
						selector.unlockInput();
						this.ctx.ui.requestRender();
					}
				} catch (error) {
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				} finally {
					if (!keepOpen) done();
				}
			},
			done,
			() => {
				// Release the alt buffer before teardown: shutdown() awaits flush/save/
				// dispose/drain before stop() leaves the alt screen.
				done();
				void this.ctx.shutdown();
			},
			{
				...selectorOptions,
				getTerminalRows: () => this.ctx.ui.terminal.rows,
				fillHeight: true,
			},
		);
		selector.setOnRequestRender(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.ctx.clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.ui.requestRender();
		this.ctx.updateEditorBorderColor();
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		return true;
	}

	async handleResumeSession(sessionPath: string, options?: { settingsFlushed?: boolean }): Promise<boolean> {
		const previousCwd = this.ctx.sessionManager.getCwd();
		// Flush pending settings writes before switching sessions so a save
		// failure leaves the session, process project dir, and Settings in the
		// source scope — the switch below mutates the SessionManager cwd.
		if (!options?.settingsFlushed) {
			try {
				await this.ctx.settings.flush();
			} catch (err) {
				this.ctx.showError(`保存待定设置失败:${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		}
		// Switch session via AgentSession (emits hook and tool session events). The
		// SessionManager adopts the resumed session's own cwd when it differs.
		await this.ctx.session.switchSession(sessionPath);
		this.ctx.clearTransientSessionUi();
		const newCwd = this.ctx.sessionManager.getCwd();
		const movedProject = normalizePathForComparison(newCwd) !== normalizePathForComparison(previousCwd);
		if (movedProject) {
			// Resumed a session from another project: re-point the process and every
			// cwd-derived cache at it before rendering.
			await this.ctx.applyCwdChange(newCwd);
		}
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.ctx.reloadTodos();
		this.ctx.showStatus(movedProject ? `已在 ${shortenPath(newCwd)} 恢复会话` : "已恢复会话");
		return true;
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("没有可删除的会话文件(内存会话)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("会话尚未保存");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"删除会话",
			"这将永久删除当前会话。\n您将返回会话选择器。",
		);

		if (!confirmed) {
			this.ctx.showStatus("已取消删除");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("已取消删除");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("会话已删除");
		await this.showSessionSelector();
	}

	/**
	 * Run the OAuth login flow for `providerId` inside a cancellable
	 * {@link LoginDialogComponent} that replaces the editor slot. Esc aborts:
	 * the dialog's abort signal reaches the provider flow, any pending prompt
	 * rejects, and the editor is restored immediately. Returns true when
	 * credentials were stored.
	 */
	async #handleOAuthLogin(providerId: string): Promise<boolean> {
		this.ctx.showStatus(`正在登录 ${providerId}…`);
		const useManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const dialog = new LoginDialogComponent(this.ctx.ui, providerId, (_success, message) => {
			// Fires on Esc: unblock the editor immediately; the aborted flow's
			// rejection settles the awaited login below.
			restoreEditor();
			if (message) this.ctx.showStatus(message);
		});
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(dialog);
		this.ctx.ui.setFocus(dialog);
		this.ctx.ui.requestRender();
		try {
			const identity = await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: dialog.signal,
				onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
					// The dialog renders the full URL (SSH-safe copy target) and
					// opens the browser best-effort.
					dialog.showAuth(info.url, info.instructions, info.launchUrl);
				},
				onPrompt: (prompt: { message: string; placeholder?: string }) =>
					dialog.showPrompt(prompt.message, prompt.placeholder),
				onProgress: (message: string) => {
					dialog.showProgress(message);
				},
				// Paste-code providers (e.g. Codex) may need the user to paste the
				// fallback redirect URL when the loopback callback can't complete
				// (headless/remote/Windows). Mount a focused input in the dialog so
				// the paste lands somewhere the OAuth flow consumes — the hidden
				// editor's `/login <url>` path is unreachable while the dialog holds
				// focus (#5339).
				onManualCodeInput: useManualInput ? () => dialog.showManualInput(MANUAL_LOGIN_PROMPT) : undefined,
			});
			// Scope the post-login refresh to the just-authenticated provider with an
			// `online` strategy: the default all-provider `online-if-uncached` reuses
			// a fresh authoritative cache row (e.g. an empty result fetched before
			// login), so newly persisted credentials would never re-run discovery and
			// models would stay unavailable in-session (#5780). Unrelated providers
			// are left untouched. `refreshProvider` swallows discovery failures, so
			// awaiting cannot reject the login.
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();
			// Name the account (and Anthropic organization) that was stored so a
			// login that lands on an unintended account/subscription is visible
			// immediately instead of silently replacing an existing registration.
			const whoBase = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
			const whoOrg = identity?.type === "oauth" ? (identity.orgName ?? identity.orgId) : undefined;
			const who = whoBase ? ` as ${whoBase}${whoOrg ? ` (${whoOrg})` : ""}` : whoOrg ? ` as ${whoOrg}` : "";
			block.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} 已成功登录 ${providerId}${who}`),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `凭据已保存到 ${getAgentDbPath()}`), 1, 0));
			this.ctx.present(block);
			return true;
		} catch (error: unknown) {
			if (dialog.signal.aborted) {
				// User-cancelled: the dialog already restored the editor and
				// surfaced "Login cancelled".
				return false;
			}
			this.ctx.showError(`登录失败:${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			restoreEditor();
		}
	}

	async #handleCredentialLogout(providerId: string, account: LogoutAccount): Promise<void> {
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const removed = await authStorage.removeCredential(providerId, account.credentialId);
			if (!removed) {
				this.ctx.showError(`已跳过退出登录:${account.label} 不再存储在 ${providerId} 中。`);
				return;
			}

			// Provider-scoped online refresh so the removed credential's stale
			// endpoint/deployment models are invalidated deterministically; the
			// default all-provider `online-if-uncached` would reuse the fresh
			// authoritative cache row and keep showing models the credential
			// unlocked (#5780). Other providers are left untouched.
			await this.ctx.session.modelRegistry.refreshProvider(providerId, "online");
			const block = new TranscriptBlock();
			block.addChild(
				new Text(
					theme.fg(
						"success",
						`${theme.status.success} 已成功从 ${providerId} 退出登录 ${account.label}`,
					),
					1,
					0,
				),
			);
			block.addChild(new Text(theme.fg("dim", `凭据已从 ${getAgentDbPath()} 中移除`), 1, 0));
			const remainingSource = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			if (remainingSource) {
				block.addChild(
					new Text(theme.fg("warning", `${providerId} 仍通过 ${remainingSource} 进行身份验证`), 1, 0),
				);
			}
			this.ctx.present(block);
		} catch (error: unknown) {
			this.ctx.showError(`退出登录失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #showOAuthLogoutAccountSelector(providerId: string): Promise<void> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.reload();
		} catch (error: unknown) {
			this.ctx.showError(
				`无法加载已存储的凭据:${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
		const accounts = toLogoutAccounts(providerId, authStorage.listStoredCredentials(providerId), {
			activeIdentity: authStorage.getOAuthAccountIdentity(providerId, this.ctx.session.sessionId),
			activeApiKey: authStorage.getCredentialOrigin(providerId)?.kind === "api_key",
		});
		if (accounts.length === 0) {
			const source = authStorage.describeCredentialSource(providerId, this.ctx.session.sessionId);
			const suffix = source ? ` 当前身份验证来自 ${source};要退出登录,请移除该来源。` : "";
			this.ctx.showError(`已跳过退出登录:${providerId} 没有存储的凭据。${suffix}`);
			return;
		}

		this.showSelector(done => {
			const selector = new LogoutAccountSelectorComponent(
				provider?.name ?? providerId,
				accounts,
				account => {
					done();
					void this.#handleCredentialLogout(providerId, account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId);
			} else {
				await this.#showOAuthLogoutAccountSelector(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.has(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("没有可退出登录的已存储提供商凭据。请在来源处移除环境变量或配置文件中的身份验证。");
				return;
			}
		}

		this.showSelector(done => {
			let selector: OAuthSelectorComponent;
			selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						await this.#handleOAuthLogin(selectedProviderId);
					} else {
						await this.#showOAuthLogoutAccountSelector(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					requestRender: () => {
						this.ctx.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionPinSelector(): Promise<void> {
		const session = this.ctx.session;
		if (session.isStreaming) {
			this.ctx.showStatus("会话流式输出期间无法固定账户。");
			return;
		}
		this.ctx.showStatus("正在加载提供商账户…", { dim: true });
		let accountList: SessionOAuthAccountList | undefined;
		try {
			accountList = await session.listCurrentProviderOAuthAccounts();
		} catch (error) {
			this.ctx.showError(
				`无法加载提供商账户:${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (!accountList) {
			this.ctx.showStatus("请先选择模型,再固定提供商账户。");
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
			this.ctx.showStatus(
				source
					? `没有 ${providerName} 的已存储 OAuth 账户。当前身份验证来自 ${source}。`
					: `没有 ${providerName} 的已存储 OAuth 账户。使用 /login 添加一个。`,
			);
			return;
		}

		this.showSelector(done => {
			const selector = new SessionAccountSelectorComponent(
				providerName,
				accounts,
				account => {
					done();
					if (!session.pinCurrentProviderOAuthAccount(account.credentialId)) {
						this.ctx.showWarning(`${account.label} 不再可固定。`);
						return;
					}
					this.ctx.showStatus(`已将 ${account.label} 固定到此会话(${providerName})。`);
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async showResetUsageSelector(): Promise<void> {
		const session = this.ctx.session;
		this.ctx.showStatus("正在检查已保存的速率限制重置…", { dim: true });
		let statuses: ResetCreditAccountStatus[];
		try {
			statuses = await session.listResetCredits();
		} catch (error) {
			this.ctx.showError(`无法加载已保存的重置:${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const accounts = toResetUsageAccounts(statuses);
		if (accounts.length === 0) {
			this.ctx.showStatus("未找到 Codex 账户。使用 /login 添加一个。");
			return;
		}
		if (!accounts.some(account => account.availableCount > 0)) {
			this.ctx.showStatus(
				accounts.some(account => account.error)
					? "没有可用的已保存重置 — 部分账户无法访问(请尝试 /login)。"
					: "当前没有可用的已保存速率限制重置。",
			);
			return;
		}
		this.showSelector(done => {
			const selector = new ResetUsageSelectorComponent(
				accounts,
				account => {
					done();
					void this.#redeemReset(account);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #redeemReset(account: ResetUsageAccount): Promise<void> {
		this.ctx.showStatus(`正在为 ${account.label} 花费 1 次已保存的重置…`, { dim: true });
		let outcome: ResetCreditRedeemOutcome;
		try {
			outcome = await this.ctx.session.redeemResetCredit(account.target);
		} catch (error) {
			this.ctx.showError(
				`重置失败(${account.label}):${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const message = describeRedeemOutcome(outcome, account.label);
		if (outcome.ok) {
			this.ctx.showStatus(message);
			// Refresh the status-line usage so the freshly-reset window shows.
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		} else {
			this.ctx.showWarning(message);
		}
	}

	async showDebugSelector(): Promise<void> {
		const { DebugSelectorComponent } = await import("../../debug");
		this.showSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}

	showAgentHub(
		observers: SessionObserverRegistry,
		options?: { requireContent?: boolean; armCloseTap?: boolean },
	): void {
		const hubKeys = [
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		];
		let hub: AgentHubOverlayComponent | undefined;

		// Render the hub inline in the editor slot — the same anchored region
		// every other selector (model, session, tree, the `ask` tool) uses —
		// rather than a floating overlay. A non-fullscreen overlay composited over
		// a live transcript strands a stale copy in native scrollback every time a
		// running subagent's progress grows the frame and scrolls the window; the
		// hub is opened mid-run, so those copies stacked into a wall of duplicate
		// "Agent Hub" frames bleeding the task tree behind them. As an editor-slot
		// component it rides the normal append-only commit path: the transcript
		// commits above it exactly once and the hub repaints in place.
		const done = () => {
			hub?.dispose();
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};

		hub = new AgentHubOverlayComponent({
			observers,
			hubKeys,
			expandKeys: this.ctx.keybindings.getKeys("app.tools.expand"),
			onDone: done,
			requestRender: () => this.ctx.ui.requestRender(),
			registry: this.ctx.collabGuest?.agentRegistry,
			remote: this.ctx.collabGuest?.hubRemote,
			ui: this.ctx.ui,
			getTool: name => this.ctx.session.getToolByName(name),
			getMessageRenderer: type => this.ctx.session.extensionRunner?.getMessageRenderer(type),
			cwd: this.ctx.sessionManager.getCwd(),
			hideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			proseOnlyThinking: () => this.ctx.proseOnlyThinking,
			focusAgent: id => this.ctx.focusAgentSession(id),
			sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
		});

		const showReadyHub = () => {
			// The double-← gesture passes requireContent so it stays inert when
			// neither live nor persisted subagents are available. Persisted rows now
			// load asynchronously, so defer the gate until that scan has refreshed the
			// hub instead of treating the initial empty table as authoritative.
			if (options?.requireContent && hub.isEmpty) {
				hub.dispose();
				return;
			}

			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(hub);
			this.ctx.ui.setFocus(hub);
			// When the hub was raised by the editor's double-← gesture, prime its own
			// close detector so the *next* single ← dismisses it — the two taps that
			// opened it were consumed by the editor's detector (issue #4780).
			if (options?.armCloseTap) hub.armCloseTap();
			this.ctx.ui.requestRender();
		};

		if (options?.requireContent && hub.isEmpty) {
			void hub.persistedSubagentsReady.then(showReadyHub);
			return;
		}

		showReadyHub();
	}
}
