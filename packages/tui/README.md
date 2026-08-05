# @oh-my-pi/pi-tui

极简终端 UI 框架,带差分渲染与同步输出,为无闪烁的交互式 CLI 应用而生。

## 特性

- **差分渲染**:三策略渲染系统,只更新发生变化的部分
- **同步输出**:使用 CSI 2026 实现原子屏幕更新(无闪烁)
- **括号粘贴模式**:用标记正确处理大段粘贴(>10 行的粘贴)
- **组件化**:简单的 Component 接口,带 render() 方法
- **主题支持**:组件接受主题接口,可自定义样式
- **内置组件**:Text、TruncatedText、Input、Editor、Markdown、Loader、SelectList、SettingsList、Spacer、Image、Box、Container
- **内联图像**:在支持 Kitty 或 iTerm2 图形协议的终端中渲染图像
- **自动补全支持**:文件路径与斜杠命令

## 快速开始

```typescript
import { TUI, Text, Editor, ProcessTerminal } from "@oh-my-pi/pi-tui";

// 创建终端
const terminal = new ProcessTerminal();

// 创建 TUI
const tui = new TUI(terminal);

// 添加组件
tui.addChild(new Text("Welcome to my app!"));

const editor = new Editor(editorTheme);
editor.onSubmit = (text) => {
	console.log("Submitted:", text);
	tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// 启动
tui.start();
```

## 核心 API

### TUI

管理组件与渲染的主容器。

```typescript
const tui = new TUI(terminal);
tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // 请求一次重新渲染
tui.requestComponentRender(component); // 安全时只重渲染包含 `component` 的根子树(在调整大小、覆盖层、图像或并发完整请求时回退到完整渲染)

// 全局调试键处理(Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### Component 接口

所有组件都实现:

```typescript
interface Component {
	render(width: number): readonly string[];
	handleInput?(data: string): void;
	invalidate?(): void;
}
```

| 方法               | 说明                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `render(width)`      | 返回字符串数组,每行一个。每行**不得超过 `width`**,否则 TUI 会报错。用 `truncateToWidth()` 或手动换行来保证这一点。结果归组件所有,对调用方不可变;内容未变时返回同一数组引用(启用渲染器记忆化),内容变化时返回新数组。 |
| `handleInput?(data)` | 组件获得焦点并收到键盘输入时调用。`data` 字符串包含原始终端输入(可能含 ANSI 转义序列)。                |
| `invalidate?()`      | 调用以清除任何缓存的渲染状态。组件应在下一次 `render()` 调用时从头重新渲染。                                                     |

## 内置组件

### Container

对子组件分组。

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

给所有子元素应用内边距与背景色的容器。

```typescript
const box = new Box(
	1, // paddingX (默认: 1)
	1, // paddingY (默认: 1)
	(text) => chalk.bgGray(text), // 可选背景函数
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text)); // 动态更改背景
```

### Text

显示带自动换行与内边距的多行文本。

```typescript
const text = new Text(
	"Hello World", // 文本内容
	1, // paddingX (默认: 1)
	1, // paddingY (默认: 1)
	(text) => chalk.bgGray(text), // 可选背景函数
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

截断以适配视口宽度的单行文本。适合状态行与页头。

```typescript
const truncated = new TruncatedText(
	"This is a very long line that will be truncated...",
	0, // paddingX (默认: 0)
	0, // paddingY (默认: 0)
);
```

### Input

带水平滚动的单行文本输入。

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

**快捷键:**

- `Enter` - 提交
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+W` 或 `Alt+Backspace` - 向后删除一个单词
- `Ctrl+U` - 删除到行首
- `Ctrl+K` - 删除到行尾
- `Ctrl+Left` / `Ctrl+Right` - 按单词导航
- `Alt+Left` / `Alt+Right` - 按单词导航
- 方向键、Backspace、Delete 按预期工作

### Editor

带自动补全、文件补全与粘贴处理的多行文本编辑器。

```typescript
interface SymbolTheme {
	cursor: string;
	ellipsis: string;
	boxRound: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	boxSharp: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
		teeDown: string;
		teeUp: string;
		teeLeft: string;
		teeRight: string;
		cross: string;
	};
	table: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
		teeDown: string;
		teeUp: string;
		teeLeft: string;
		teeRight: string;
		cross: string;
	};
	quoteBorder: string;
	hrChar: string;
	spinnerFrames: string[];
}

interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
	symbols: SymbolTheme;
}

const editor = new Editor(theme);
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // 暂时禁用提交
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // 动态更改边框
```

**特性:**

- 带自动换行的多行编辑
- 斜杠命令自动补全(输入 `/`)
- 文件路径自动补全(按 `Tab`)
- 大段粘贴处理(>10 行创建 `[paste #1 +50 lines]` 标记)
- 编辑器上方/下方的水平线
- 伪光标渲染(隐藏真实光标)

**快捷键:**

- `Enter` - 提交
- `Shift+Enter`、`Ctrl+Enter` 或 `Alt+Enter` - 换行(取决于终端,`Alt+Enter` 最可靠)
- `Tab` - 自动补全
- `Ctrl+K` - 删除行
- `Alt+D` / `Alt+Delete` - 向前删除一个单词
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+-` - 撤销上次编辑
- 方向键、Backspace、Delete 按预期工作

### Markdown

渲染带语法高亮与主题支持的 markdown。

```typescript
interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	symbols: SymbolTheme;
}

interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	underline?: boolean;
}

const md = new Markdown(
	"# Hello\n\nSome **bold** text",
	1, // paddingX
	1, // paddingY
	theme, // MarkdownTheme
	defaultStyle, // 可选 DefaultTextStyle
	2, // 可选代码块缩进(空格数)
);
md.setText("Updated markdown");
```

**特性:**

- 标题、粗体、斜体、代码块、列表、链接、引用块
- HTML 标签渲染为纯文本
- 通过 `highlightCode` 的可选语法高亮
- 内边距支持
- 面向性能的渲染缓存

### Loader

动画加载转轮。

```typescript
const loader = new Loader(
	tui, // 用于渲染更新的 TUI 实例
	(s) => chalk.cyan(s), // 转轮颜色函数
	(s) => chalk.gray(s), // 消息颜色函数
	"Loading...", // 消息 (默认: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

扩展 Loader,增加 Escape 键处理与用于取消异步操作的 AbortSignal。

```typescript
const loader = new CancellableLoader(
	tui, // 用于渲染更新的 TUI 实例
	(s) => chalk.cyan(s), // 转轮颜色函数
	(s) => chalk.gray(s), // 消息颜色函数
	"Working...", // 消息
);
loader.onAbort = () => done(null); // 用户按 Escape 时调用
doAsyncWork(loader.signal).then(done);
```

**属性:**

- `signal: AbortSignal` - 用户按 Escape 时中止
- `aborted: boolean` - loader 是否被中止
- `onAbort?: () => void` - 用户按 Escape 时的回调

### SelectList

带键盘导航的交互式选择列表。

```typescript
interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	symbols: SymbolTheme;
}

const list = new SelectList(
	[
		{ value: "opt1", label: "Option 1", description: "First option" },
		{ value: "opt2", label: "Option 2", description: "Second option" },
	],
	5, // maxVisible
	theme, // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // 筛选条目
```

**控制:**

- 方向键:导航
- Enter:选择
- Escape:取消

### SettingsList

带值循环与子菜单的设置面板。

```typescript
interface SettingItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[]; // 提供时,Enter/Space 循环这些值
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

const settings = new SettingsList(
	[
		{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
		{ id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
	],
	10, // maxVisible
	theme, // SettingsListTheme
	(id, newValue) => console.log(`${id} changed to ${newValue}`),
	() => console.log("Cancelled"),
);
settings.updateValue("theme", "light");
```

**控制:**

- 方向键:导航
- Enter/Space:激活(循环值或打开子菜单)
- Escape:取消

### Spacer

用于垂直间距的空行。

```typescript
const spacer = new Spacer(2); // 2 个空行 (默认: 1)
```

### Image

为支持 Kitty 图形协议(Kitty、Ghostty、WezTerm,macOS/Linux 上的 Warp)或 iTerm2 内联图像的终端内联渲染图像。在不支持的终端上回退为文本占位符。

```typescript
interface ImageTheme {
	fallbackColor: (str: string) => string;
}

interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
}

const image = new Image(
	base64Data, // base64 编码的图像数据
	"image/png", // MIME 类型
	theme, // ImageTheme
	options, // 可选 ImageOptions
);
tui.addChild(image);
```

支持的格式:PNG、JPEG、GIF、WebP。尺寸自动从图像头解析。

## 自动补全

### CombinedAutocompleteProvider

同时支持斜杠命令与文件路径。

```typescript
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";

const provider = new CombinedAutocompleteProvider(
	[
		{ name: "help", description: "Show help" },
		{ name: "clear", description: "Clear screen" },
		{ name: "delete", description: "Delete last message" },
	],
	getProjectDir(), // 文件补全的基准路径
);

editor.setAutocompleteProvider(provider);
```

**特性:**

- 输入 `/` 查看斜杠命令
- 按 `Tab` 进行文件路径补全
- 支持 `~/`、`./`、`../` 与 `@` 前缀
- `@` 前缀筛选为可附加文件

## 按键检测

用于检测键盘输入的辅助函数(支持 Kitty 键盘协议):

```typescript
import {
	isEnter,
	isEscape,
	isTab,
	isShiftTab,
	isArrowUp,
	isArrowDown,
	isArrowLeft,
	isArrowRight,
	isCtrlA,
	isCtrlC,
	isCtrlE,
	isCtrlK,
	isCtrlO,
	isCtrlP,
	isCtrlLeft,
	isCtrlRight,
	isAltLeft,
	isAltRight,
	isShiftEnter,
	isAltEnter,
	isShiftCtrlO,
	isShiftCtrlD,
	isShiftCtrlP,
	isBackspace,
	isDelete,
	isHome,
	isEnd,
	// ... 以及更多
} from "@oh-my-pi/pi-tui";

if (isCtrlC(data)) {
	process.exit(0);
}
```

## 差分渲染

TUI 使用三种渲染策略:

1. **首次渲染**:输出所有行,不清除回滚缓冲区
2. **宽度改变或视口上方变化**:清屏并完整重渲染
3. **常规更新**:把光标移到第一个变化的行,清除到行尾,渲染变化的行

所有更新都包裹在**同步输出**(`\x1b[?2026h` ... `\x1b[?2026l`)中,实现原子、无闪烁渲染,除非设置了 `PI_NO_SYNC_OUTPUT=1`。该退出开关只移除 DEC 2026 包裹;绘制写入仍会守卫终端自动换行,避免悬置换行光标伪影。

## 终端接口

TUI 可与任何实现 `Terminal` 接口的对象协作:

```typescript
interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void, onDisconnect?: () => void): void;
	stop(): void;
	write(data: string): void;
	get columns(): number;
	get rows(): number;
	moveBy(lines: number): void;
	hideCursor(force?: boolean): void;
	showCursor(force?: boolean): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
}
```

**内置实现:**

- `ProcessTerminal` - 使用 `process.stdin/stdout`
- `VirtualTerminal` - 用于测试(使用 ghostty-web)

## 工具函数

```typescript
import { Ellipsis, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";

// 获取字符串的可见宽度(忽略 ANSI 码,使用 Bun.stringWidth)
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// 把字符串截断到指定宽度(保留 ANSI 码,追加省略号)
const truncated = truncateToWidth("Hello World", 8); // "Hello…" (默认: Ellipsis.Unicode)

// 不带省略号截断
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, Ellipsis.Omit); // "Hello Wo"

// 把文本换行到指定宽度(Bun.wrapAnsi 单词换行,修剪行尾,保留 ANSI)
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## 创建自定义组件

创建自定义组件时,**`render()` 返回的每行都不得超过 `width` 参数**。任何行比终端宽,TUI 都会报错。

### 处理输入

用按键检测工具处理键盘输入:

```typescript
import { isEnter, isEscape, isArrowUp, isArrowDown, isCtrlC, isTab, isBackspace } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";

class MyInteractiveComponent implements Component {
	private selectedIndex = 0;
	private items = ["Option 1", "Option 2", "Option 3"];

	onSelect?: (index: number) => void;
	onCancel?: () => void;

	handleInput(data: string): void {
		if (isArrowUp(data)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (isArrowDown(data)) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
		} else if (isEnter(data)) {
			this.onSelect?.(this.selectedIndex);
		} else if (isEscape(data) || isCtrlC(data)) {
			this.onCancel?.();
		}
	}

	render(width: number): readonly string[] {
		return this.items.map((item, i) => {
			const prefix = i === this.selectedIndex ? "> " : "  ";
			return truncateToWidth(prefix + item, width);
		});
	}
}
```

### 处理行宽

用提供的工具确保行能放下:

```typescript
import { visibleWidth, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";

class MyComponent implements Component {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): readonly string[] {
		// 方案 1:截断长行
		return [truncateToWidth(this.text, width)];

		// 方案 2:检查并填充到精确宽度
		const line = this.text;
		const visible = visibleWidth(line);
		if (visible > width) {
			return [truncateToWidth(line, width)];
		}
		// 填充到精确宽度(可选,用于背景)
		return [line + " ".repeat(width - visible)];
	}
}
```

### ANSI 码注意事项

`visibleWidth()`、`truncateToWidth()` 与 `wrapTextWithAnsi()` 能正确处理 ANSI 转义码:

- `visibleWidth()` 计算宽度时忽略 ANSI 码(通过 `Bun.stringWidth`)
- `truncateToWidth()` 保留 ANSI 码,并在截断时正确闭合它们
- `wrapTextWithAnsi()` 单词换行与修剪行尾时保留 ANSI 码

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (不计 ANSI 码)
const truncated = truncateToWidth(styled, 8); // 红色 "Hello" + " W..." 带正确的重置
```

### 缓存

为提升性能,组件应缓存渲染输出,只在必要时重渲染:

```typescript
class CachedComponent implements Component {
	private text: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	render(width: number): readonly string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines = [truncateToWidth(this.text, width)];

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
```

## 示例

完整的聊天界面示例见 `test/chat-simple.ts`,包含:

- 带自定义背景色的 Markdown 消息
- 响应期间的加载转轮
- 带自动补全与斜杠命令的编辑器
- 消息之间的 Spacer

运行它:

```bash
npx tsx test/chat-simple.ts
```

## 开发

```bash
# 安装依赖(从 monorepo 根目录)
npm install

# 运行类型检查
npm run check

# 运行演示
npx tsx test/chat-simple.ts
```
