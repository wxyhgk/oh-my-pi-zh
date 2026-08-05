import type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString">;
}

function appKey(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return bindings.keybindings.getDisplayString(action) || "已禁用";
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	return [
		"**导航**",
		"| 按键 | 操作 |",
		"|-----|--------|",
		"| `Arrow keys` | 移动光标 / 浏览历史(空输入时按上方向键) |",
		"| `Option+Left/Right` | 按词移动 |",
		"| `Ctrl+A` / `Home` / `Cmd+Left` | 行首 |",
		"| `Ctrl+E` / `End` / `Cmd+Right` | 行尾 |",
		"",
		"**编辑**",
		"| 按键 | 操作 |",
		"|-----|--------|",
		"| `Enter` | 发送消息 |",
		"| `Shift+Enter` / `Alt+Enter` | 换行 |",
		"| `Ctrl+W` / `Option+Backspace` | 向前删除一个词 |",
		"| `Ctrl+U` | 删除到行首 |",
		"| `Ctrl+K` | 删除到行尾 |",
		`| \`${appKey(bindings, "app.clipboard.copyLine")}\` | 复制当前行 |`,
		`| \`${appKey(bindings, "app.clipboard.copyPrompt")}\` | 复制整个提示词 |`,
		"",
		"**其他**",
		"| 按键 | 操作 |",
		"|-----|--------|",
		"| `Tab` | 路径补全 / 接受自动补全 |",
		`| \`${appKey(bindings, "app.interrupt")}\` | 取消自动补全 / 中断进行中的工作 |`,
		`| \`${appKey(bindings, "app.clear")}\` | 清空编辑器(第一次)/ 退出(第二次) |`,
		`| \`${appKey(bindings, "app.exit")}\` | 退出(编辑器为空时) |`,
		`| \`${appKey(bindings, "app.suspend")}\` | 挂起到后台 |`,
		`| \`${appKey(bindings, "app.display.reset")}\` | 重置终端显示 |`,
		`| \`${appKey(bindings, "app.thinking.cycle")}\` | 切换思考级别 |`,
		`| \`${appKey(bindings, "app.model.cycleForward")}\` | 切换角色模型(slow/default/smol) |`,
		`| \`${appKey(bindings, "app.model.cycleBackward")}\` | 切换角色模型(反向) |`,
		`| \`${appKey(bindings, "app.model.selectTemporary")}\` | 选择模型(临时) |`,
		`| \`${appKey(bindings, "app.model.select")}\` | 选择模型(设置角色) |`,
		`| \`${appKey(bindings, "app.plan.toggle")}\` | 切换计划模式 |`,
		`| \`${appKey(bindings, "app.history.search")}\` | 搜索提示词历史 |`,
		`| \`${appKey(bindings, "app.tools.expand")}\` | 展开/收起工具输出 |`,
		`| \`${appKey(bindings, "app.tools.toggleVisibility")}\` | 显示/隐藏工具活动 |`,
		`| \`${appKey(bindings, "app.thinking.toggle")}\` | 显示/隐藏思考块 |`,
		`| \`${appKey(bindings, "app.editor.external")}\` | 在外部编辑器中编辑消息 |`,
		`| \`${appKey(bindings, "app.retry")}\` | 重试最后失败的 Agent 轮次 |`,
		`| \`${appKey(bindings, "app.clipboard.pasteImage")}\` | 从剪贴板粘贴图片或文本 |`,
		"| 按住 `Space` | 语音转文字(按住说话):按住录音,松开转写 |",
		`| \`${appKey(bindings, "app.live.toggle")}\` | 开始/停止实时语音模式(/live) |`,
		`| \`${appKey(bindings, "app.agents.hub")}\` / \`${appKey(bindings, "app.session.observe")}\` / 双击 \`←\`(空编辑器)| 打开 Agent 中心 |`,
		"| `#<number>` | GitHub issue/PR 引用(如 `#3164` → `pr://`/`issue://`) |",
		"| `#` / `#<text>` | 提示词操作(复制 / 撤销 / 移动光标) |",
		"| `/` | 斜杠命令 |",
		"| `!` | 运行 bash 命令 |",
		"| `!!` | 运行 bash 命令(不包含在上下文中) |",
		"| `$` | 在共享内核中运行 Python |",
		"| `$$` | 运行 Python(不包含在上下文中) |",
	].join("\n");
}
