import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@wxyhgk/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@wxyhgk/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@wxyhgk/pi-coding-agent/modes/theme/theme";
import { SEARCH_PROVIDER_CHOICES } from "@wxyhgk/pi-coding-agent/web/search/types";

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
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
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
			onCancel: () => {},
		},
	);
}

const [firstChoice, secondChoice] = SEARCH_PROVIDER_CHOICES;

describe("multiselect settings (array-of-enum)", () => {
	it("edits providers.webSearchOrder via the ordered toggle list", () => {
		const comp = createSelector();
		for (const ch of "web search provider order") comp.handleInput(ch);
		const row = comp.render(120).join("\n");
		expect(row).toContain("网络搜索提供商顺序");
		expect(row).toContain("默认");

		// Open the editor; Space toggles the first provider, Enter the second.
		comp.handleInput("\n");
		comp.handleInput(" ");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");
		expect(settings.get("providers.webSearchOrder")).toEqual([firstChoice!.value, secondChoice!.value]);

		// ← promotes the highlighted member one slot earlier in priority.
		comp.handleInput("\x1b[D");
		expect(settings.get("providers.webSearchOrder")).toEqual([secondChoice!.value, firstChoice!.value]);

		// Toggling a member off removes it and renumbers the rest.
		comp.handleInput(" ");
		expect(settings.get("providers.webSearchOrder")).toEqual([firstChoice!.value]);

		// Esc returns to the list; the row summary reflects the saved order.
		comp.handleInput("\x1b");
		expect(comp.render(120).join("\n")).toContain(firstChoice!.label);
	});

	it("hides excluded providers from the web search order list", () => {
		const comp = createSelector();
		settings.set("providers.webSearchExclude", [firstChoice!.value]);
		for (const ch of "web search provider order") comp.handleInput(ch);
		comp.handleInput("\n");

		const menu = comp.render(120).join("\n");
		expect(menu).not.toContain(firstChoice!.label);
		expect(menu).toContain(secondChoice!.label);
	});

	it("splices the hovered option into the pressed digit's position", () => {
		const [a, b, c] = SEARCH_PROVIDER_CHOICES;
		const comp = createSelector();
		for (const ch of "web search provider order") comp.handleInput(ch);
		comp.handleInput("\n");

		// Select rows 1 and 3 → [a, c].
		comp.handleInput(" ");
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		comp.handleInput(" ");
		expect(settings.get("providers.webSearchOrder")).toEqual([a!.value, c!.value]);

		// Hover row 2 (unselected) and press "2" → spliced between them.
		comp.handleInput("\x1b[A");
		comp.handleInput("2");
		expect(settings.get("providers.webSearchOrder")).toEqual([a!.value, b!.value, c!.value]);

		// Press "9" (past the end) → clamps to the tail.
		comp.handleInput("9");
		expect(settings.get("providers.webSearchOrder")).toEqual([a!.value, c!.value, b!.value]);

		// Press "1" → promotes to the head.
		comp.handleInput("1");
		expect(settings.get("providers.webSearchOrder")).toEqual([b!.value, a!.value, c!.value]);
	});

	it("edits providers.webSearchExclude as an unordered toggle set", () => {
		const comp = createSelector();
		for (const ch of "excluded web search providers") comp.handleInput(ch);
		expect(comp.render(120).join("\n")).toContain("无");

		comp.handleInput("\n");
		comp.handleInput(" ");
		expect(settings.get("providers.webSearchExclude")).toEqual([firstChoice!.value]);

		// Unordered lists ignore reorder keys.
		comp.handleInput("\x1b[C");
		expect(settings.get("providers.webSearchExclude")).toEqual([firstChoice!.value]);

		comp.handleInput(" ");
		expect(settings.get("providers.webSearchExclude")).toEqual([]);
	});
});
