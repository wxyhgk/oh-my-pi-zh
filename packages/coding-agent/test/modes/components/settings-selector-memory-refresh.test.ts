import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(onCancel: () => void = () => {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel,
		},
	);
}

/** Switch the selector to the memory tab. SETTING_TABS puts memory at index 4 (after appearance/model/interaction/context). */
function focusMemoryTab(comp: SettingsSelectorComponent): void {
	for (let i = 0; i < 4; i++) {
		comp.handleInput("\x1b[C");
	}
}

describe("SettingsSelectorComponent memory tab", () => {
	it("reveals condition-gated Hindsight rows the moment memory.backend changes via the submenu", () => {
		settings.set("memory.backend", "off");
		const comp = createSelector();
		focusMemoryTab(comp);
		// Width 70 keeps the flat single-column layout (the wide split layout
		// shows only the active section's rows, covered by the sidebar test).
		const before = comp.render(70).join("\n");
		expect(before).toContain("记忆后端");
		expect(before).not.toContain("Hindsight API URL");
		expect(before).not.toContain("Hindsight API 令牌");

		// Memory Backend is the only visible row, so it's already selected at index 0.
		// Enter opens the SelectSubmenu pre-positioned on "off"; navigate to "hindsight" (index 2) and confirm.
		comp.handleInput("\n");
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");

		expect(settings.get("memory.backend")).toBe("hindsight");
		const after = comp.render(70).join("\n");
		expect(after).toContain("记忆后端");
		expect(after).toContain("Hindsight API URL");
		expect(after).toContain("Hindsight API 令牌");
		expect(after).toContain("Hindsight 自动回忆");
	});

	it("saves a pasted Hindsight API token from its settings row", () => {
		settings.set("memory.backend", "hindsight");
		settings.set("hindsight.apiToken", "saved-secret-token");
		const comp = createSelector();

		for (const ch of "hindsight api token") comp.handleInput(ch);
		const row = comp.render(120).join("\n");
		expect(row).toContain("Hindsight API 令牌");
		expect(row).toContain("••••••••");
		expect(row).not.toContain("saved-secret-token");

		comp.handleInput("\n");
		expect(comp.render(120).join("\n")).not.toContain("saved-secret-token");
		comp.handleInput("\n");
		expect(settings.get("hindsight.apiToken")).toBe("saved-secret-token");
		expect(comp.render(120).join("\n")).not.toContain("saved-secret-token");

		comp.handleInput("\n");
		comp.handleInput("\x15");
		comp.handleInput("\x1b[200~test-token-123\x1b[201~");
		expect(comp.render(120).join("\n")).not.toContain("test-token-123");
		comp.handleInput("\n");

		expect(settings.get("hindsight.apiToken")).toBe("test-token-123");
		expect(loadHindsightConfig(settings, {}).hindsightApiToken).toBe("test-token-123");
		expect(comp.render(120).join("\n")).not.toContain("test-token-123");
	});

	it("hides Hindsight rows again when the backend is switched back to off without leaving the tab", () => {
		settings.set("memory.backend", "hindsight");
		const comp = createSelector();
		focusMemoryTab(comp);
		// Width 70 keeps the flat layout so all sections' rows render inline.
		expect(comp.render(70).join("\n")).toContain("Hindsight API URL");

		// Open Memory Backend → SelectSubmenu pre-selects the current value
		// ("hindsight" at index 2) → step up twice to reach "off" → Enter confirms.
		comp.handleInput("\n");
		comp.handleInput("\x1b[A");
		comp.handleInput("\x1b[A");
		comp.handleInput("\n");

		expect(settings.get("memory.backend")).toBe("off");
		const after = comp.render(70).join("\n");
		expect(after).toContain("记忆后端");
		expect(after).not.toContain("Hindsight API URL");
		expect(after).not.toContain("Hindsight 自动回忆");
	});

	it("clears the global settings search on Escape before closing the selector", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});

		// Typing starts the cross-tab search: banner shows the query and matches.
		comp.handleInput("b");
		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const searching = comp.render(120).map(strip).join("\n");
		const banner =
			comp
				.render(120)
				.map(strip)
				.find(line => /\d+ 个匹配/.test(line)) ?? "";
		expect(banner).toContain(" b ");
		expect(searching).toMatch(/\d+ 个匹配/);

		// First Escape exits search mode without closing the panel.
		comp.handleInput("\x1b");
		expect(cancelCount).toBe(0);
		expect(comp.render(120).join("\n")).not.toContain("个匹配");

		comp.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});

	it("puts the exact global settings search hit before incidental matches", () => {
		const comp = createSelector();
		for (const ch of "图片") comp.handleInput(ch);

		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const rendered = comp.render(120).map(strip).join("\n");
		const providersIndex = rendered.indexOf("提供商");
		const appearanceIndex = rendered.indexOf("外观");

		expect(rendered).toContain("图片提供商顺序");
		expect(rendered).not.toContain("在提示词中包含模型");
		expect(rendered).not.toContain("服务层级");
		expect(providersIndex).toBeGreaterThanOrEqual(0);
		if (appearanceIndex >= 0) {
			expect(appearanceIndex).toBeGreaterThan(providersIndex);
		}
	});

	it("supports editor hotkeys in the global search bar", () => {
		const comp = createSelector();
		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const banner = (): string =>
			comp
				.render(120)
				.map(strip)
				.find(line => /\d+ 个匹配/.test(line)) ?? "";

		// alt+backspace deletes the trailing word from the query.
		for (const ch of "image provider") comp.handleInput(ch);
		comp.handleInput("\x1b\x7f");
		expect(banner()).toContain("image");
		expect(banner()).not.toContain("provider");

		// Arrow keys move the cursor; typing inserts mid-query instead of appending.
		comp.handleInput("\x15"); // ctrl+u clears the rest of the query
		for (const ch of "model") comp.handleInput(ch);
		for (let i = 0; i < 5; i++) comp.handleInput("\x1b[D");
		comp.handleInput("x");
		expect(banner()).toContain("xmodel");
	});

	it("delegates Escape to an open settings submenu before closing the selector", () => {
		let cancelCount = 0;
		settings.set("memory.backend", "off");
		const comp = createSelector(() => {
			cancelCount++;
		});
		focusMemoryTab(comp);

		comp.handleInput("\n");
		expect(comp.render(120).join("\n")).toContain("Esc 返回");

		comp.handleInput("\x1b");
		const afterBack = comp.render(120).join("\n");
		expect(cancelCount).toBe(0);
		expect(afterBack).toContain("记忆后端");
		expect(afterBack).toContain("Esc 关闭");
		expect(afterBack).not.toContain("Esc 返回");

		comp.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});
});
