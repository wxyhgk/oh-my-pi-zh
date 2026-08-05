import { describe, expect, it } from "bun:test";
import {
	generateThemeStyles,
	generateThemeVars,
	getTemplate,
	parseExportArgs,
} from "@wxyhgk/pi-coding-agent/export/html";

describe("HTML export themes", () => {
	it("bundles dark, light, and auto-following web themes", async () => {
		const styles = await generateThemeStyles("web");

		expect(styles).toContain(':root, :root[data-theme="dark"] { color-scheme: dark;');
		expect(styles).toContain(':root[data-theme="light"] { color-scheme: light;');
		expect(styles).toContain("@media (prefers-color-scheme: light)");
		expect(styles).toContain("--bg: #0f0b14;");
		expect(styles).toContain("--bg: oklch(0.985 0.004 307);");
	});

	it("bundles independently selected dark and light TUI themes", async () => {
		const [styles, dark, light] = await Promise.all([
			generateThemeStyles("theme", { dark: "titanium", light: "light" }),
			generateThemeVars("theme", "titanium"),
			generateThemeVars("theme", "light"),
		]);

		expect(styles).toContain(`:root, :root[data-theme="dark"] { color-scheme: dark; ${dark} }`);
		expect(styles).toContain(`:root[data-theme="light"] { color-scheme: light; ${light} }`);
	});

	it("renders an auto, light, and dark theme selector", () => {
		const html = getTemplate();
		expect(html).toContain('id="theme-select"');
		expect(html).toContain('<option value="auto">自动</option>');
		expect(html).toContain('<option value="light">浅色</option>');
		expect(html).toContain('<option value="dark">深色</option>');
	});

	it("parses the optional user-theme flag before or after the output path", () => {
		expect(parseExportArgs("--themes export.html")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("export.html --themes")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("")).toEqual({ outputPath: undefined, useUserThemes: false });
		expect(() => parseExportArgs("one.html two.html")).toThrow("用法:/export [--themes] [path]");
	});
});
