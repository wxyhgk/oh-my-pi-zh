# 主题参考

本文档描述当前 coding-agent 中主题的工作方式:结构定义、加载、运行时行为与故障模式。

## 主题系统控制什么

主题系统驱动:

- TUI 各处使用的前景/背景颜色 token
- markdown 样式适配器(`getMarkdownTheme()`)
- 选择器/编辑器/设置列表适配器(`getSelectListTheme()`、`getEditorTheme()`、`getSettingsListTheme()`)
- 符号预设 + 符号覆盖(`unicode`、`nerd`、`ascii`)
- 原生高亮器使用的语法高亮颜色(`@oh-my-pi/pi-natives`)
- 状态栏分段颜色

主要实现:`src/modes/theme/theme.ts`。

## 主题 JSON 结构

主题文件是 JSON 对象,需通过 `theme.ts` 中的运行时模式(`themeJsonSchema`)校验,并由 `src/modes/theme/theme-schema.json` 镜像。

顶层字段:

- `name`(必填)
- `colors`(必填;所有颜色 token 均为必填)
- `vars`(可选;可复用的颜色变量)
- `export`(可选;HTML 导出颜色)
- `symbols`(可选)
  - `preset`(可选:`unicode | nerd | ascii`)
  - `overrides`(可选:`SymbolKey` 的键/值覆盖)

颜色值接受:

- 十六进制字符串(`"#RRGGBB"`)
- 256 色索引(`0..255`)
- 变量引用字符串(通过 `vars` 解析)
- 空字符串(`""`),表示终端默认值(前景 `\x1b[39m`,背景 `\x1b[49m`)

## 必填与可选颜色 token

除 `thinkingMax` 外,`colors` 中以下所有 token 均为必填;`thinkingMax` 为兼容性而设,可选,缺失时回退到 `thinkingXhigh`。

### 核心文本与边框(11)

`accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`

### 背景块(7)

`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `statusLineBg`

### 消息/工具文本(5)

`userMessageText`, `customMessageText`, `customMessageLabel`, `toolTitle`, `toolOutput`

### Markdown(10)

`mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`

### 工具差异 + 语法高亮(12)

`toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`,
`syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`

### 模式/思考边框(8 必填,1 可选)

`thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, 可选 `thinkingMax`, `bashMode`, `pythonMode`

### 状态栏分段颜色(13)

`statusLineSep`, `statusLineModel`, `statusLinePath`, `statusLineGitClean`, `statusLineGitDirty`, `statusLineContext`, `statusLineSpend`, `statusLineStaged`, `statusLineDirty`, `statusLineUntracked`, `statusLineOutput`, `statusLineCost`, `statusLineSubagents`

## 可选 token

### `export` 段(可选)

用于 HTML 导出主题辅助:

- `export.pageBg`
- `export.cardBg`
- `export.infoBg`

若省略,导出代码会从已解析的主题颜色中推导默认值。

### `symbols` 段(可选)

- `symbols.preset` 设置主题级默认符号集。
- `symbols.overrides` 可覆盖单个 `SymbolKey` 值。
- `symbols.spinnerFrames` 覆盖加载 spinner 帧。接受扁平 `string[]`(同时应用于两种 spinner 类型)或对象 `{ "status"?: string[], "activity"?: string[] }` 以分别覆盖每种类型。未指定的类型回退到符号预设的默认帧。`status` 驱动约 12.5fps 的 spinner,用于加载器与工具执行指示器;`activity` 驱动约 30fps 的 spinner,用于 markdown 进度条及类似的高频 UI。

运行时优先级:

1. 设置中的 `symbolPreset` 覆盖(若已设置)
2. 主题 JSON 的 `symbols.preset`
3. 回退 `"unicode"`

无效的覆盖键会被忽略并记录日志(`logger.debug`)。

#### 框线绘制边框

所有描边 chrome —— 工具结果框、浮层、代码围栏、编辑器、欢迎横幅 —— 均使用 `boxRound.*` token 绘制:圆角(`╭╮╰╯`)加上 T 形/十字连接(`├┤┬┴┼`,这些没有圆角 Unicode 形式,因此取自 `boxSharp.*` token)。Markdown 表格是唯一例外,保留完全锐利的 `boxSharp.*` 集合(`┌┐└┘`)。

覆盖行为由此拆分决定:

- `boxRound.{topLeft,topRight,bottomLeft,bottomRight,horizontal,vertical}` 重新样式化所有边框的角与边。
- `boxSharp.{cross,teeDown,teeUp,teeRight,teeLeft}` 重新样式化各处分隔线/连接处(圆角框与表格均适用)。
- `boxSharp.{topLeft,topRight,bottomLeft,bottomRight}` 现在只影响 markdown 表格的角。

## 内置主题与自定义主题来源

主题查找顺序(`loadThemeJson`):

1. 内置嵌入主题(`dark.json`、`light.json` 以及所有编译进 `defaultThemes` 的 `defaults/*.json`)
2. 自定义主题文件:`<customThemesDir>/<name>.json`

自定义主题目录来自 `getCustomThemesDir()`:

- 默认:`~/.omp/agent/themes`
- 可由 `PI_CODING_AGENT_DIR` 覆盖(`$PI_CODING_AGENT_DIR/themes`)

`getAvailableThemes()` 返回合并后的内置 + 自定义名称,已排序;名称冲突时内置主题优先。

## 加载、校验与解析

对自定义主题文件:

1. 读取 JSON
2. 解析 JSON
3. 按 `themeJsonSchema` 校验
4. 递归解析 `vars` 引用
5. 按终端能力模式将解析后的值转换为 ANSI

校验行为:

- 缺少必填颜色 token:明确的成组错误消息
- token 类型/值错误:带 JSON 路径的校验错误
- 未知主题文件:`Theme not found: <name>`

变量引用行为:

- 支持嵌套引用
- 引用缺失变量时抛出异常
- 循环引用时抛出异常

## 终端颜色模式行为

颜色模式检测(`detectColorMode`):

- `COLORTERM=truecolor|24bit` => truecolor
- `WT_SESSION` => truecolor
- `TERM` 为 `dumb`、`linux` 或空 => 256color
- 其他情况 => truecolor

转换行为:

- hex -> `Bun.color(..., "ansi-16m" | "ansi-256")`
- 数值 -> `38;5` / `48;5` ANSI
- `""` -> 默认前景/背景重置

## 运行时切换行为

### 初始主题(`initTheme`)

`main.ts` 使用以下设置初始化主题:

- `symbolPreset`
- `colorBlindMode`
- `theme.dark`
- `theme.light`

自动主题槽位选择按此顺序使用终端外观:

1. 终端报告的 OSC 11 背景亮度,除非 macOS/Zellij 回退路径生效
2. `COLORFGBG` 背景索引(`< 8` => 深色,`>= 8` => 浅色)
3. 仅对已知有问题的 macOS/Zellij OSC 11 路径使用 macOS 外观回退
4. 深色槽位回退

设置模式中的当前默认值:

- `theme.dark = "titanium"`
- `theme.light = "light"`
- `symbolPreset = "unicode"`
- `colorBlindMode = false`

### 显式切换(`setTheme`)

- 加载所选主题
- 更新全局 `theme` 单例
- 可选启动监听器(watcher)
- 触发 `onThemeChange` 回调

失败时:

- 回退到内置 `dark`
- 返回 `{ success: false, error }`

### 预览切换(`previewTheme`)

- 将临时预览主题应用到全局 `theme`
- 本身**不**更改已持久化的设置
- 返回成功/错误,不做回退替换

设置 UI 使用它进行实时预览,取消时恢复之前的主题。

## 监听器与热重载

启用监听器时(`setTheme(..., true)` / 交互式初始化):

- 仅当 `<customThemesDir>/<currentTheme>.json` 文件存在时监听该文件
- 内置主题实际上不被监听;内置主题查找在同名自定义文件之前
- 匹配的文件变更会调度一次防抖重载;重载错误或文件暂时缺失时保留最后成功加载的主题
- 监听器不做删除/重命名回退;它等待未来一次成功的重载或显式主题切换

自动模式还会根据终端外观变化、`SIGWINCH` 以及在生效时的 macOS 回退观察者,重新评估深色/浅色槽位映射。

## 色盲模式行为

`colorBlindMode` 在运行时只改变一个 token:

- `toolDiffAdded` 做 HSV 调整(绿色向蓝色偏移)
- 仅在解析后的值是 hex 字符串时应用调整

其他 token 不变。

## 主题设置的持久化位置

与主题相关的设置由 `Settings` 持久化到全局配置 YAML:

- 路径:`<agentDir>/config.yml`
- 默认 agent 目录:`~/.omp/agent`
- 生效的默认文件:`~/.omp/agent/config.yml`

持久化的键:

- `theme.dark`
- `theme.light`
- `symbolPreset`
- `colorBlindMode`

存在旧版迁移:旧的扁平 `theme: "name"` 会根据亮度检测迁移为嵌套的 `theme.dark` 或 `theme.light`。

## 创建自定义主题(实操)

1. 在自定义主题目录中创建文件,例如 `~/.omp/agent/themes/my-theme.json`。
2. 包含 `name`、可选的 `vars`,以及**所有必填** `colors` token。
3. 可选包含 `symbols` 和 `export`。
4. 在设置中选择主题(外观 -> 深色主题 或 外观 -> 浅色主题),取决于你想要哪个自动槽位。

最小骨架:

```json
{
  "name": "my-theme",
  "vars": {
    "accent": "#7aa2f7",
    "muted": 244
  },
  "colors": {
    "accent": "accent",
    "border": "#4c566a",
    "borderAccent": "accent",
    "borderMuted": "muted",
    "success": "#9ece6a",
    "error": "#f7768e",
    "warning": "#e0af68",
    "muted": "muted",
    "dim": 240,
    "text": "",
    "thinkingText": "muted",

    "selectedBg": "#2a2f45",
    "userMessageBg": "#1f2335",
    "userMessageText": "",
    "customMessageBg": "#24283b",
    "customMessageText": "",
    "customMessageLabel": "accent",
    "toolPendingBg": "#1f2335",
    "toolSuccessBg": "#1f2d2a",
    "toolErrorBg": "#2d1f2a",
    "toolTitle": "",
    "toolOutput": "muted",

    "mdHeading": "accent",
    "mdLink": "accent",
    "mdLinkUrl": "muted",
    "mdCode": "#c0caf5",
    "mdCodeBlock": "#c0caf5",
    "mdCodeBlockBorder": "muted",
    "mdQuote": "muted",
    "mdQuoteBorder": "muted",
    "mdHr": "muted",
    "mdListBullet": "accent",

    "toolDiffAdded": "#9ece6a",
    "toolDiffRemoved": "#f7768e",
    "toolDiffContext": "muted",

    "syntaxComment": "#565f89",
    "syntaxKeyword": "#bb9af7",
    "syntaxFunction": "#7aa2f7",
    "syntaxVariable": "#c0caf5",
    "syntaxString": "#9ece6a",
    "syntaxNumber": "#ff9e64",
    "syntaxType": "#2ac3de",
    "syntaxOperator": "#89ddff",
    "syntaxPunctuation": "#9aa5ce",

    "thinkingOff": 240,
    "thinkingMinimal": 244,
    "thinkingLow": "#7aa2f7",
    "thinkingMedium": "#2ac3de",
    "thinkingHigh": "#bb9af7",
    "thinkingXhigh": "#f7768e",
    "thinkingMax": "#ff007c",

    "bashMode": "#2ac3de",
    "pythonMode": "#bb9af7",

    "statusLineBg": "#16161e",
    "statusLineSep": 240,
    "statusLineModel": "#bb9af7",
    "statusLinePath": "#7aa2f7",
    "statusLineGitClean": "#9ece6a",
    "statusLineGitDirty": "#e0af68",
    "statusLineContext": "#2ac3de",
    "statusLineSpend": "#7dcfff",
    "statusLineStaged": "#9ece6a",
    "statusLineDirty": "#e0af68",
    "statusLineUntracked": "#f7768e",
    "statusLineOutput": "#c0caf5",
    "statusLineCost": "#ff9e64",
    "statusLineSubagents": "#bb9af7"
  }
}
```

## 测试自定义主题

按此流程操作:

1. 启动交互模式(启动时启用监听器)。
2. 打开设置并预览主题值(实时 `previewTheme`)。
3. 对自定义主题文件,在运行中编辑 JSON,确认保存时自动重载。
4. 检查关键界面:
   - markdown 渲染
   - 工具块(进行中/成功/错误)
   - 差异渲染(新增/删除/上下文)
   - 状态栏可读性
   - 思考级别边框变化
   - bash/python 模式边框颜色
5. 如果你的主题依赖字形宽度/外观,请同时验证两种符号预设。

## 实际约束与注意事项

- 除可选的 `thinkingMax`(缺失时回退到 `thinkingXhigh`)外,自定义主题的所有 `colors` token 均为必填。
- `export` 和 `symbols` 可选。
- 主题 JSON 中的 `$schema` 仅供参考;运行时校验由代码中的 ArkType 模式强制实施。
- `setTheme` 失败时回退到 `dark`;`previewTheme` 失败不会替换当前主题。
- 文件监听器重载错误或文件暂时缺失时,保留当前已加载的主题,直到成功重载或显式切换主题。
