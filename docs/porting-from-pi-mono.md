# 从 pi-mono 移植:实用合并指南

本指南是一份可重复执行的清单,用于将 pi-mono 的变更移植到本仓库。
适用于任何合并场景:单个文件、功能分支或完整版本同步。

## 上次同步点(历史上游标记)

**提交:** `b21b42d032919de2f2e6920a76fa9a37c3920c0a`
**日期:** 2026-03-22

每次同步后更新本节;不要复用之前的区间。该提交是 pi-mono 上游标记,可能不存在于本仓库的本地对象数据库中。

开始新同步时,在包含该提交的 pi-mono checkout 或远端上,从该提交开始生成补丁:

```bash
git format-patch b21b42d032919de2f2e6920a76fa9a37c3920c0a..HEAD --stdout > changes.patch
```

## 0) 确定范围

- 明确上游参照(提交、标签或 PR)。
- 列出计划改动的包或目录。
- 决定哪些功能在范围内、哪些有意跳过。

## 1) 安全地迁移代码

- 优先采用干净、聚焦的差异,而不是整份复制。
- 避免复制构建产物或生成文件。
- 如果上游新增了文件,请显式添加并审查其内容。

## 2) 匹配导入扩展名约定

大多数运行时 TypeScript 源码在内部导入中省略 `.js`,但当前多个入口点和工具模块出于 ESM/运行时兼容性保留 `.js`。请遵循周围文件和包的导出风格;不要一刀切地删除或添加扩展名。

- 在 `packages/coding-agent` 运行时源码中,当周围模块省略扩展名时优先使用无扩展名的内部导入,但保留已要求 `.js` 的文件中现有的 `.js` 导入。
- 在 `packages/tui/test` 和 `packages/natives/bench` 中,周围文件已使用 `.js` 时保持 `.js`。
- 当工具链或导入断言(如 `.json`、`.css`、`.md` 文本内嵌)要求真实文件扩展名时,保留它们。
- 示例:`import { x } from "./foo.js";` → `import { x } from "./foo";` 仅在对应包/文件的约定为无扩展名时进行。

## 3) 替换导入作用域

上游使用不同的包作用域。请一致地替换它们。

- 用本仓库使用的本地作用域替换旧作用域。
- 示例(根据实际移植的包进行调整):
  - `@mariozechner/pi-coding-agent` → `@oh-my-pi/pi-coding-agent`
  - `@mariozechner/pi-agent-core` → `@oh-my-pi/pi-agent-core`
  - `@mariozechner/pi-tui` → `@oh-my-pi/pi-tui`
  - `@mariozechner/pi-ai` → `@oh-my-pi/pi-ai`
  - `@mariozechner/pi-utils` → `@oh-my-pi/pi-utils`
  - `@mariozechner/pi-catalog` → `@oh-my-pi/pi-catalog`
  - `@mariozechner/pi-natives` → `@oh-my-pi/pi-natives`
- 部分上游包以 `@earendil-works/*` 作用域发布,而不是 `@mariozechner/*`。以同样的方式映射(`@earendil-works/pi-coding-agent` → `@oh-my-pi/pi-coding-agent`,依此类推)。
- 裸的 `typebox` 包不属于 `@oh-my-pi/*` 作用域;不要把它改写为其中之一。关于工具参数 schema 的映射,参见第 15 节的 Extensions 分歧。

## 4) 在 Bun API 优于 Node 时使用 Bun API

我们运行在 Bun 上,但当前源码有意混用 Bun API 与少量 Node 标准库 API。仅在 Bun 提供更清晰、更安全或更简单的实现时替换 Node API;不要机械地重写每个 Node 导入。

**移植新代码时优先替换:**

- 进程派生:简单命令优先使用 Bun Shell `$`;需要流式或进程控制时使用 `Bun.spawn`/`Bun.spawnSync`。仅在其确切语义被需要时保留现有 `child_process`。
- HTTP 客户端:`node-fetch`、`axios` → 原生 `fetch`
- SQLite:`better-sqlite3` → `bun:sqlite`
- 环境加载:`dotenv` → Bun 自动加载 `.env`
- 运行时文本/资源:优先使用 Bun 导入(如 `with { type: "text" }` 或 `Bun.file()`),而不是复制步骤或打包回退文件读取。

**不要替换(这些在 Bun 中工作正常):**

- `os.homedir()` — 不要替换为 `Bun.env.HOME` 或字面量 `"~"`
- `os.tmpdir()` — 不要替换为 `Bun.env.TMPDIR || "/tmp"` 或硬编码路径
- `fs.mkdtempSync()` — 不要替换为手动路径构造
- `path.join()`、`path.resolve()` 等 — 这些没问题

**导入风格:** Node 标准库导入使用 `node:` 前缀。命名空间导入很常见,但当周围代码已使用具名导入时,具名导入也可以接受。

**其他 Bun 约定:**

- 短小、非流式命令优先使用 Bun Shell `$`;仅在需要流式 I/O 或进程控制时使用 `Bun.spawn`。
- 简单文件使用 `Bun.file()`/`Bun.write()`,面向目录的操作使用 `node:fs/promises`。当调用流程有意为同步时,现有的同步 `node:fs` 调用可以接受。
- 避免 `Bun.file().exists()` 检查;在 try/catch 中使用 `isEnoent` 处理。
- 优先使用 `Bun.sleep(ms)` 而不是 `setTimeout` 包装。

**错误写法:**

```typescript
// BROKEN: env vars may be undefined, "~" is not expanded
const home = Bun.env.HOME || "~";
const tmp = Bun.env.TMPDIR || "/tmp";
```

**正确写法:**

```typescript
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const configDir = path.join(os.homedir(), ".config", "myapp");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myapp-"));
```

## 5) 优先使用 Bun 内嵌(不复制)

不要新增运行时资源复制步骤。将资源保留在仓库内并优先使用 Bun 内嵌/导入;保留现有的显式生成工作流,如 `packages/coding-agent/src/export/html/tool-views.generated.js`(由 collab-web 源码通过 `bun run gen:tool-views` 构建)。

- 如果上游将资源复制到 dist 目录,请替换为 Bun 友好的内嵌。
- 提示词是静态 `.md` 文件;使用 Bun 文本导入(`with { type: "text" }`)和 Handlebars,而不是内联提示词字符串。
- 使用 `import.meta.dir` + `Bun.file` 加载相邻的非文本资源。
- 将资源保留在仓库内,让打包器包含它们。
- 除非用户明确要求,或该包已有有意的生成步骤,否则消除复制脚本。
- 如果上游在运行时读取打包回退文件,请将该文件系统读取替换为 Bun 文本内嵌导入,除非当前包已使用生成资源流水线。
  - 示例(Codex instructions 回退):
    - `const FALLBACK_PROMPT_PATH = join(import.meta.dir, "codex-instructions.md");` -> 移除
    - `import FALLBACK_INSTRUCTIONS from "./codex-instructions.md" with { type: "text" };`
    - 使用 `return FALLBACK_INSTRUCTIONS;` 而不是 `readFileSync(FALLBACK_PROMPT_PATH, "utf8")`

## 6) 谨慎移植 `package.json`

将 `package.json` 视为契约。有意地合并。

- 保留现有 `name`、`version`、`type`、`exports` 和 `bin`,除非移植需要更改。
- 用 Bun 等价命令替换 npm/node 脚本(如 `bun check`、`bun test`)。
- 确保依赖使用正确的作用域。
- 不要通过降级依赖来修复类型错误;应升级。
- 验证工作区包链接和 `peerDependencies`。

## 7) 统一代码风格与工具链

- 保留现有的格式化约定。
- 除非必要,不要引入 `any`。
- 除非出于可选依赖、启动成本或仅运行时模块的需要,否则避免动态导入;否则优先使用顶层导入。
- 绝不在代码中构建提示词;提示词是使用 Handlebars 渲染的静态 `.md` 文件。
- 在 `packages/coding-agent` 中,内部/运行时日志使用 `@oh-my-pi/pi-utils` 的 `logger`;CLI 命令文件可以为有意的面向用户输出使用 `console.*`。
- 使用 `Promise.withResolvers()` 而不是 `new Promise((resolve, reject) => ...)`。
- 新的封装状态优先使用 ES `#` 私有字段。构造函数参数属性已存在于当前代码中且可接受;移植时不要搅动无关的访问修饰符。
- 优先使用现有辅助函数和工具,而不是新的临时代码。
  保留本仓库已有的 Bun 优先基础设施变更:
  - 运行时是 Bun(主 CLI 没有 Node 入口点)。
  - 包管理器是 Bun(没有 npm lockfile)。
  - 不应随意引入重量级 Node API;当前源码在适合提供商、CLI 或进程控制语义的地方仍使用选定的 Node API(`node:crypto`、`node:readline`、同步 `node:fs` 和 `child_process`)。
  - 保留轻量级 Node API(`os.homedir`、`os.tmpdir`、`fs.mkdtempSync`、`path.*`)。
  - CLI shebang 使用 `bun`(不是 `node`,不是 `tsx`)。
  - TypeScript 包通常直接使用源文件;`@oh-my-pi/pi-natives` 从 `packages/natives/native` 导出生成的原生绑定。
  - CI 工作流使用 Bun 进行安装/检查/测试。

## 8) 移除旧的兼容层

除非被要求,否则移除上游兼容 shim。

- 删除已被替换的旧 API。
- 将所有调用点直接更新为新 API。
- 不要保留 `*_v2` 或并行版本。

## 9) 更新文档与引用

- 在适当的地方替换 pi-mono 仓库链接。
- 更新示例以使用 Bun 和正确的包作用域。
- 确保 README 说明仍与当前仓库行为一致。

## 10) 验证移植

运行覆盖该移植的检查:

- 针对仓库的 TypeScript 和 Rust 检查运行 `bun check`。
- 针对变更的包和行为运行定向 Bun 测试(例如 `bun test packages/<package>/test/<file>.test.ts`)。
- 如果依赖发生变化,在更新 `bun.lock` 后运行 `bun install --frozen-lockfile`。

测试使用 Bun 的 runner,而不是 Vitest。不要用全项目范围的 `bun test` 替代定向覆盖;根 `test` 脚本使用仓库的分片 runner。如果某个检查已因无关原因失败,请明确指出该命令和失败信息。

## 11) 保护已改进的功能(回归陷阱清单)

如果你已经在本地改进了某些行为,请将这些视为**不可协商**的。移植之前,写下这些改进并添加显式检查,以免在合并中丢失。

- **冻结预期行为**:为每项改进添加简短的"之前/之后"说明(输入、输出、默认值、边界情况)。这可以防止静默回滚。
- **映射旧 → 新 API**:如果上游重命名了概念(hooks → extensions、custom tools → tools 等),确保每个旧入口点仍然接线。遗漏一个标志或导出就等于丢失功能。
- **验证导出**:检查 `package.json` 的 `exports`、公开类型和 barrel 文件。上游移植经常忘记重新导出本地新增内容。
- **覆盖非正常路径**:如果你修复了错误处理、超时或回退逻辑,添加一个测试或至少一份手动清单来演练这些路径。
- **检查默认值和配置合并顺序**:改进通常存在于默认值中。确认新默认值没有被回退(例如新的配置优先级、禁用的功能、工具列表)。
- **审计环境变量/shell 行为**:如果你修复了执行或沙箱,验证新路径仍使用你清理过的环境,且没有重新引入别名/函数覆盖。
- **重新运行定向样例**:保留一组最小的"已知良好"示例,并在移植后运行它们(CLI 标志、扩展注册、工具执行)。

## 12) 识别并处理重构过的代码

移植一个文件之前,先检查上游是否对其进行了重大重构:

```bash
# Compare the file you're about to port against what you have locally
git diff HEAD upstream/main -- path/to/file.ts
```

如果差异显示该文件被**重构**了(不仅仅是打了补丁):

- 新抽象、重命名概念、合并模块、改变数据流

那么移植前你必须**彻底阅读新实现**。盲目合并重构过的代码会丢失功能,因为:

注:交互模式最近被拆分为 controllers/utils/types。回移相关变更时,请将更新移植到我们创建的各个文件中,并确保 `interactive-mode.ts` 的接线保持同步。

1. **默认值会静默改变** - 新的变量 `defaultFoo = [a, b]` 可能替换了旧 `getAllFoo()` 返回的 `[a, b, c, d, e]`。
2. **API 选项会被丢弃** - 当系统合并时(如 `hooks` + `customTools` → `extensions`),旧选项可能无法接入新实现。
3. **代码路径会过时** - 重命名的概念(如 `hookMessage` → `custom`)需要在每个 switch 语句、类型守卫和处理器中更新——不仅仅是定义。
4. **上下文/能力会缩小** - 旧 API 可能暴露了 `{ logger, typebox, pi }`,而新 API 忘了包含。

### 语义化移植流程

当上游重构了某个模块:

1. **阅读旧实现** - 了解它做了什么、接受哪些选项、暴露了什么。
2. **阅读新实现** - 了解新抽象及其与旧行为的映射。
3. **验证功能对等** - 对于旧代码中的每项能力,确认新代码保留它或明确移除它。
4. **搜索遗漏** - 搜索可能在 switch 语句、处理器、UI 组件中被遗漏的旧名称/概念。
5. **测试边界** - CLI 标志、SDK 选项、事件处理器、默认值——这些是回归藏身之处。

### 快速检查

```bash
# Find all uses of an old concept that may need updating
rg "oldConceptName" --type ts

# Compare default values between versions
git show upstream/main:path/to/file.ts | rg "default|DEFAULT"

# Check if all enum/union values have handlers
rg "case \"" path/to/file.ts
```

## 13) 快速审计清单

在完成前将其作为最终检查:

- [ ] 导入扩展名遵循本地包约定(没有一刀切地去除 `.js`)
- [ ] 没有新引入 Node 专用 API,除非与现有合理模式匹配
- [ ] 所有包作用域已更新
- [ ] `package.json` 脚本使用 Bun
- [ ] 提示词是 `.md` 文本导入(没有内联提示词字符串)
- [ ] coding-agent 中没有内部/运行时 `console.*`;CLI 面向用户的输出是有意的
- [ ] 资源通过 Bun 内嵌/导入模式加载,或通过现有的有意的生成流水线
- [ ] 测试或检查已运行(或明确注明受阻)
- [ ] 没有功能回归(参见第 11-12 节)

## 14) 提交信息格式

提交回移时,遵循仓库格式 `<type>(scope): <past-tense description>`,并在标题中保留提交区间。

```
fix(coding-agent): backported pi-mono changes (<from>..<to>)

packages/<package>:
- <type>: <description>
- <type>: <description> (#<issue> by @<contributor>)

packages/<other-package>:
- <type>: <description>
```

**示例:**

```
fix(coding-agent): backported pi-mono changes (9f3eef65f..52532c7c0)

packages/ai:
- fix: handle "sensitive" stop reason from Anthropic API
- fix: normalize tool call IDs with special characters for Responses API
- fix: add overflow detection for Bedrock, MiniMax, Kimi providers
- fix: 429 status is rate limiting, not context overflow

packages/tui:
- fix: refactored autocomplete state tracking
- fix: file autocomplete should not trigger on empty text
- fix: configurable autocomplete max visible items
- fix: improved table column width calculation with word-aware wrapping

packages/coding-agent:
- fix: preserve external config.yml edits on save (#1046 by @nicobailonMD)
- fix: resolve macOS NFD and curly quote variants in file paths
```

**规则:**

- 按包分组变更
- 使用常规提交类型(`fix`、`feat`、`refactor`、`perf`、`docs`)
- 为外部贡献包含上游 issue/PR 编号和贡献者署名
- 标题中的提交区间有助于追踪同步点

## 15) 有意的分歧

我们的 fork 有一些不同于上游的架构决策。**不要移植这些上游模式:**

### UI 架构

| 上游                                    | 我们的 fork                                                            | 原因                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `FooterDataProvider` class                  | `StatusLineComponent`                                               | 更简单、集成化的状态行                                                                                                                |
| `ctx.ui.setHeader()` / `ctx.ui.setFooter()` | 当前扩展上下文中的 no-op 桩函数                           | 尚未接线以替换 TUI 状态/标题 UI                                                                                        |
| `ctx.ui.setEditorComponent()`               | 在交互模式中接线;在 ACP/RPC/headless 上下文中为 no-op 桩函数 | 自定义编辑器替换在交互式 TUI 中有效;非 TUI 运行时保留桩函数                                                            |
| `ctx.ui.addAutocompleteProvider()`          | 在交互模式中接线;在 ACP/RPC/headless 上下文中为 no-op 桩函数 | 工厂包装与上游匹配;omp 的编辑器没有自定义 `triggerCharacters`,因此包装的提供商在内置触发点呈现 |
| `InteractiveModeOptions` options object     | 位置式构造函数参数(选项类型仍导出)           | 保持构造函数签名;上游新增字段时更新类型                                                                          |

### 组件命名

| 上游                     | 我们的 fork                |
| ---------------------------- | ----------------------- |
| `extension-input.ts`         | `hook-input.ts`         |
| `extension-selector.ts`      | `hook-selector.ts`      |
| `ExtensionInputComponent`    | `HookInputComponent`    |
| `ExtensionSelectorComponent` | `HookSelectorComponent` |

### API 命名

| 上游                                 | 我们的 fork                                 | 说明                                     |
| ---------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `sessionManager.appendSessionInfo(name)` | `sessionManager.setSessionName(name)`    | 我们通篇使用 `sessionName`                                         |
| `sessionManager.getSessionName()`        | `sessionManager.getSessionName()`        | 相同(我们统一以匹配上游的 RPC) |
| `agent.sessionName` / `setSessionName()` | `agent.sessionName` / `setSessionName()` | 相同                                      |

### 文件整合

| 上游                                           | 我们的 fork                                                  | 原因                                        |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| `clipboard.ts` + `clipboard-image.ts`(工具文件) | `src/utils/clipboard.ts`,由 `@oh-my-pi/pi-natives` 支撑 | 原生实现外加一个小型 TS 包装 |

### 测试框架

| 上游                  | 我们的 fork                      |
| ------------------------- | ----------------------------- |
| `vitest` with `vi.mock()` | `bun:test` with `vi` from bun |
| `node:test` assertions    | `expect()` matchers           |

### 工具架构

| 上游                            | 我们的 fork                                                                                                      | 说明                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `createTool(cwd: string, options?)` | `createTools(session: ToolSession)`,通过 `BUILTIN_TOOLS` 注册表                                              | 工具工厂接受 `ToolSession`,可以返回 `null` |
| Per-tool `*Operations` interfaces   | 仅保留当前的逐工具覆盖接口(例如 `FindOperations`)                               | 用于存在 SSH/远程覆盖的地方               |
| Node.js `fs/promises` everywhere    | 简单文件读写用 Bun 文件 API,目录操作用 `node:fs/promises`,必要时用选定的同步 `node:fs` | 优先在简化时使用 Bun API                        |

### 认证存储

| 上游                        | 我们的 fork                                    | 说明                                        |
| ------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `proper-lockfile` + `auth.json` | `agent.db`(bun:sqlite)                     | 凭据仅存储在 `agent.db` 中 |
| 每个提供商单个凭据  | 多凭据 + 轮询选择 | 保留会话亲和与退避逻辑 |

### 扩展

| 上游                                                               | 我们的 fork                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jiti` for TypeScript loading                                          | 原生 Bun `import()`                                                                                                                                                                                                                                                                        |
| `pkg.pi` manifest field                                                | 优先 `pkg.omp`;`pkg.pi` 回退保留                                                                                                                                                                                                                                            |
| `StringEnum` from `pi-ai`                                              | `pi.typebox` shim 中的 `Type.Enum`(或用 `pi.zod` 编写 schema);`pi-ai` 不再导出 `StringEnum`                                                                                                                                                                          |
| `formatSize` from `pi-coding-agent`                                    | `@oh-my-pi/pi-utils` 中的 `formatBytes`                                                                                                                                                                                                                                                      |
| 上游将 resource/package/settings 管理器作为原生架构 | 基于能力发现(`loadCapability(...)`)、`Settings` 单例和 `EventBus`;`legacy-pi-coding-agent-shim.ts` 中的 `DefaultResourceLoader`、`DefaultPackageManager` 和 `SettingsManager` 旧扩展导入是兼容 shim,不是原生实现 |

### 跳过这些上游功能

移植时,请**完全跳过**这些文件/功能:

- `footer-data-provider.ts` — 我们使用 StatusLineComponent
- `clipboard-image.ts` — 图像剪贴板支持通过 `@oh-my-pi/pi-natives` 支撑的 `src/utils/clipboard.ts` 暴露
- GitHub 工作流文件 — 我们有自己的 CI
- `models.generated.ts` — 自动生成,本地重新生成(以 models.json 替代)

### 我们新增的功能(请保留)

这些存在于我们的 fork 中,但上游没有。**切勿覆盖:**

- 交互模式中的 `StatusLineComponent`
- 带会话亲和的多凭据认证
- 基于能力的发现系统(`defineCapability`、`registerProvider`、`loadCapability`、`skillCapability` 等)
- MCP/Exa/SSH 集成
- 保存时格式化的 LSP writethrough
- Bash 拦截(`checkBashInterception`)
- read 工具中的模糊路径建议
