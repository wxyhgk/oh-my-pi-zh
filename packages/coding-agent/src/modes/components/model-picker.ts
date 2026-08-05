/**
 * Compact session-model picker (alt+p / `/switch`): a bottom-anchored
 * floating overlay hosting just a {@link ModelBrowser} — no provider sidebar.
 * Model entries switch the current session only; a search beginning with `@`
 * exposes the configured ctrl+p quick roles.
 */
import type { Model } from "@wxyhgk/pi-ai";
import type { Component, TUI } from "@wxyhgk/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ResolvedRoleModel } from "../../session/agent-session";
import { theme } from "../theme/theme";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	resolveRoleAssignments,
	sortModelItems,
} from "./model-browser";
import type { ScopedModelItem } from "./model-hub";
import { bottomBorder, row, topBorder } from "./overlay-box";
import { resolveSegmentPalette } from "./segment-track";

export interface ModelPickerCallbacks {
	/**
	 * A model was chosen for a session-only switch. `selector` is `provider/id`.
	 * `overContext` is true when the session transcript exceeds the model's
	 * context window — the host must compact before switching.
	 */
	onPick: (model: Model, selector: string, meta: { overContext: boolean }) => void;
	/** A configured ctrl+p quick role was chosen. */
	onPickRole?: (entry: ResolvedRoleModel) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Session token count; models with smaller context windows are grayed and compact-first on pick. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
	/** Resolved role models in the same order used by the ctrl+p quick-role cycle. */
	quickRoles?: ReadonlyArray<ResolvedRoleModel>;
	/** Complete ctrl+p order, including unavailable roles, to preserve segment colors. */
	quickRoleOrder?: ReadonlyArray<string>;
	/** Active quick role, highlighted when the search begins with `@`. */
	currentQuickRole?: string;
}

/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;

const STATUS_HINT = "仅切换当前会话 — 角色模型保持不变";
const QUICK_ROLE_STATUS_HINT = "快速角色切换 — 为本会话应用其模型与思考设置";
const FOOTER_HINT = "↑/↓ 模型 · Enter 用于本会话 · 输入搜索 · @ 快速角色 · Esc 关闭";
const QUICK_ROLE_FOOTER_HINT = "↑/↓ 角色 · Enter 应用角色模型 · 输入搜索 · Esc 关闭";

/**
 * The alt+p picker component. Hosted as a non-fullscreen bottom-anchored
 * overlay (`ui.showOverlay(..., { anchor: "bottom-center" })`); keyboard-only,
 * since mouse tracking is reserved for fullscreen overlays.
 */
export class ModelPickerComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#browser: ModelBrowser;
	#configError: string | undefined;
	#currentSelector: string | undefined;
	#currentQuickRoleSelector: string | undefined;
	#modelItems: ModelBrowserItem[] = [];
	#quickRoleItems: ModelBrowserItem[] = [];
	#quickRoles = new Map<string, ResolvedRoleModel>();
	#roleMode = false;

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		options: ModelPickerOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#currentSelector = options.currentSelector;
		this.#currentQuickRoleSelector = options.currentQuickRole ? `@${options.currentQuickRole}` : undefined;
		this.#quickRoleItems = this.#buildQuickRoleItems(
			options.quickRoles ?? [],
			options.quickRoleOrder ?? options.quickRoles?.map(entry => entry.role) ?? [],
		);

		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			markOverContext: true,
			emptyText: () => (this.#roleMode ? "  Ctrl+P 循环中没有快速角色" : undefined),
		});
		this.#browser.onActivate = item => {
			const quickRole = this.#quickRoles.get(item.selector);
			if (quickRole) {
				callbacks.onPickRole?.(quickRole);
				return;
			}
			callbacks.onPick(item.model, item.selector, { overContext: this.#browser.isOverContext(item) });
		};
		this.#browser.onCancel = () => callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#syncItemsForQuery(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	invalidate(): void {}

	/** Rebuild model items and role chips from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			try {
				models = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				models = [];
			}
		}

		const allModels = this.#scopedModels.length > 0 ? models : this.#registry.getAll();
		const roles = resolveRoleAssignments(this.#settings, allModels, models);
		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		this.#modelItems = buildBrowserItems(models);
		sortModelItems(this.#modelItems, { roles, mruOrder });
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());
		this.#syncItemsForQuery(this.#browser.query, true);
	}

	/** Build virtual `@role` rows, colored by their ctrl+p segment position. */
	#buildQuickRoleItems(
		quickRoles: ReadonlyArray<ResolvedRoleModel>,
		quickRoleOrder: ReadonlyArray<string>,
	): ModelBrowserItem[] {
		const order = quickRoleOrder.length > 0 ? quickRoleOrder : quickRoles.map(entry => entry.role);
		const palette = resolveSegmentPalette(order.length);
		return quickRoles.map((entry, index) => {
			const selector = `@${entry.role}`;
			this.#quickRoles.set(selector, entry);
			const orderIndex = order.indexOf(entry.role);
			return {
				provider: "",
				id: selector,
				model: entry.model,
				selector,
				labelColor: palette[(orderIndex >= 0 ? orderIndex : index) % palette.length],
			};
		});
	}

	/** Switch browser content only when a leading `@` changes the search mode. */
	#syncItemsForQuery(query: string, refresh = false): void {
		const roleMode = query.startsWith("@");
		const modeChanged = roleMode !== this.#roleMode;
		if (!modeChanged && !refresh) return;

		this.#roleMode = roleMode;
		this.#browser.setShowProvider(!roleMode);
		this.#browser.setMarkOverContext(!roleMode);
		this.#browser.setPreserveQueryOrder(roleMode);
		const currentSelector = roleMode ? this.#currentQuickRoleSelector : this.#currentSelector;
		this.#browser.setCurrentSelector(currentSelector);
		this.#browser.setItems(roleMode ? this.#quickRoleItems : this.#modelItems);
		if (modeChanged && currentSelector) {
			this.#browser.selectSelector(currentSelector);
		}
	}

	handleInput(data: string): void {
		// Mouse tracking is off outside fullscreen overlays; drop any stray SGR
		// reports instead of feeding them to the search input.
		if (data.startsWith("\x1b[<")) return;
		this.#browser.handleInput(data);
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.floor(termRows * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS;
		this.#browser.setMaxVisible(Math.max(MIN_VISIBLE, listBudget));

		const inner = Math.max(1, width - 4);
		const status = this.#configError
			? theme.fg("error", ` ${this.#configError}`)
			: theme.fg("muted", ` ${this.#roleMode ? QUICK_ROLE_STATUS_HINT : STATUS_HINT}`);

		const out: string[] = [];
		out.push(topBorder(width, "切换模型"));
		out.push(row(status, width));
		for (const line of this.#browser.render(inner)) {
			out.push(row(line, width));
		}
		out.push(row(theme.fg("dim", this.#roleMode ? QUICK_ROLE_FOOTER_HINT : FOOTER_HINT), width));
		out.push(bottomBorder(width));
		return out;
	}
}
