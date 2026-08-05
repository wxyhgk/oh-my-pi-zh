import { describe, expect, it } from "bun:test";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-coding-agent/modes/utils/hotkeys-markdown";

describe("buildHotkeysMarkdown", () => {
	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "Alt+Shift+L",
			"app.clipboard.copyPrompt": "Ctrl+Shift+P",
			"app.plan.toggle": "Alt+Shift+P",
			"app.tools.expand": "Ctrl+O",
			"app.tools.toggleVisibility": "Ctrl+Shift+O",
			"app.display.reset": "Alt+L",
			"app.interrupt": "Esc",
			"app.clear": "Ctrl+C",
			"app.exit": "Ctrl+D",
			"app.suspend": "Ctrl+Z",
			"app.thinking.cycle": "Shift+Tab",
			"app.model.cycleForward": "Ctrl+P",
			"app.model.cycleBackward": "Shift+Ctrl+P",
			"app.model.selectTemporary": "Ctrl+Shift+L",
			"app.model.select": "Alt+M",
			"app.history.search": "Ctrl+R",
			"app.thinking.toggle": "Ctrl+T",
			"app.editor.external": "Ctrl+G",
			"app.retry": "Alt+R",
			"app.clipboard.pasteImage": "Ctrl+V",
			"app.stt.toggle": "Alt+H",
			"app.live.toggle": "Ctrl+L",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**导航**");
		expect(markdown).toContain("| `Ctrl+Shift+P` | 复制整个提示词 |");
		expect(markdown).toContain("| `Ctrl+Shift+L` | 选择模型(临时) |");
		expect(markdown).toContain("| `Alt+M` | 选择模型(设置角色) |");
		expect(markdown).toContain("| `Alt+L` | 重置终端显示 |");
		expect(markdown).toContain("| `Ctrl+L` | 开始/停止实时语音模式(/live) |");
		expect(markdown).toContain("| `Alt+R` | 重试最后失败的 Agent 轮次 |");
		expect(markdown).toContain("| `Alt+Shift+P` | 切换计划模式 |");
		expect(markdown).toContain("| `Ctrl+Shift+O` | 显示/隐藏工具活动 |");
		expect(markdown).toContain("| `#<number>` | GitHub issue/PR 引用");
		expect(markdown).toContain("| `#` / `#<text>` | 提示词操作");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Alt+M";
					}
					if (action === "app.display.reset") {
						return "Alt+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `已禁用` | 选择模型(临时) |");
		expect(markdown).toContain("| `Alt+M` | 选择模型(设置角色) |");
	});
});
