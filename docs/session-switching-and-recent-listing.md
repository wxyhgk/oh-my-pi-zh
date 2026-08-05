# 会话切换与最近会话列表

本文档描述 coding-agent 如何发现最近会话、解析 `--resume` 目标、呈现会话选择器,以及切换活动运行时会话。

它侧重于当前实现行为,包括回退路径和注意事项。

## 实现文件

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts)
- [`../src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/cli/session-picker.ts`](../packages/coding-agent/src/cli/session-picker.ts)
- [`../src/modes/components/session-selector.ts`](../packages/coding-agent/src/modes/components/session-selector.ts)
- [`../src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)
- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## 最近会话发现

### 目录作用域

`SessionManager` 默认将文件会话存储在规范 cwd 桶下:

- `~/.omp/agent/sessions/<scope>-<project-basename>-<sha256(canonical-cwd)>/*.jsonl`

`scope` 是 `home`、`tmp` 或 `abs`。旧版相对/绝对桶名会尽力迁移。`SessionManager.list(cwd, sessionDir?)` 只读取解析后的桶,除非提供了显式的 `sessionDir`。

### 两条载荷不同的列表路径

有两条不同的列表流水线:

1. `getRecentSessions(sessionDir, limit)`(欢迎/摘要视图)
   - 只读取每个文件的 4 KiB 前缀。
   - 既理解当前的固定宽度标题槽文件,也理解旧版头优先文件。
   - 解析头 + 最早的用户文本预览。
   - 返回轻量级 `RecentSessionInfo`(`path`、`name`、`timeAgo`)。
   - 按文件 `mtime` 降序排序。

2. `SessionManager.list(...)` / `SessionManager.listAll()`(恢复选择器和 id 匹配)
   - 每个文件读取 4 KiB 前缀加上有界的 32 KiB 尾部,而不是完整 JSONL 正文。
   - 构建 `SessionInfo`(`path`、`id`、`cwd`、标题/父元数据、日期、大小、消息预览/计数和生命周期状态)。
   - 列表文本使用前缀解析加标记计数,最终消息生命周期状态使用尾部解析;前缀之后的消息可能不存在于 `allMessagesText` 中。
   - 状态为 `complete`、`interrupted`、`aborted`、`error`、`pending` 或 `unknown`。
   - 按 `modified` 降序排序。基于 stat 键控的扫描结果会被缓存;大型列表使用有界的并行 worker。

正常的按目录扫描会修复 EPERM 原子重写回退创建的最新的孤立 `.bak`(当其主 JSONL 缺失时)。`listSessionsReadOnly` 是不变更的变体。

### 元数据回退行为

对于最近摘要(`RecentSessionInfo`):

- 显示名称偏好(`sessionDisplayName`):`title` -> 第一条用户消息 -> `Untitled · <time>` 标签(原始 `id` 有意从不使用)
- 欢迎界面将渲染名称截断到可用列宽(没有固定长度)
- 只保留第一行,并从标题/消息派生的名称中剥离控制字符(`sanitizeSessionName`)

对于 `SessionInfo` 列表条目:

- `title` 是存在时的固定标题槽值,否则为 `header.title`,再否则为前缀中看到的最后一次压缩 `shortSummary`
- `firstMessage` 是从前缀可发现的第一条用户消息文本,或 `"(no messages)"`
- 选择器还显示修改时间、文件大小、生命周期状态(`unknown` 除外)、分叉标记,以及所有项目作用域中的 cwd

## `--continue` 解析与终端面包屑偏好

`SessionManager.continueRecent(cwd, sessionDir?)` 按此顺序解析目标:

1. 读取终端作用域的面包屑(`~/.omp/agent/terminal-sessions/<terminal-id>`)
2. 验证面包屑。已物化的目标可用;缺失的目标仅当其可选第三行为 `fresh`(表示惰性未物化的 `/new` 边界)时才可用。
3. 缺失的全新目标会启动一个新会话,而不是回退并复活先前的转录。
4. 将过时的修复前子 Agent 面包屑解析到其交互式父会话。
5. 如果面包屑的 cwd 与当前 cwd 不同,该目录不再存在,且当前位置没有自己的会话,则将面包屑会话重新根植到当前 cwd(`open` + `moveTo`)。
6. 否则使用 cwd 与当前 cwd 匹配的面包屑;对于 cwd 不匹配,使用最新的当前桶会话。
7. 没有可用面包屑时,按 mtime 选择最新文件;如果不存在,则创建新会话。

终端 id 派生偏好 TTY 路径,并回退到基于环境的标识符(`ZELLIJ_PANE_ID`、`TMUX_PANE`、`CMUX_SURFACE_ID`、`KITTY_WINDOW_ID`、`WEZTERM_PANE`、`TERM_SESSION_ID`、`WT_SESSION`)。

面包屑写入是尽力而为且非致命的。

当唯一的位置值匹配会话 id 形态时,`-c <value>` 会被规范化为显式恢复目标;其他位置文本保持为 `--continue` 的初始提示词。

## 启动时恢复目标解析(`main.ts`)

### `--resume <value>`

`createSessionManager(...)` 以两种模式处理字符串值的 `--resume`:

1. 路径样式的值(包含 `/`、`\\`,或以 `.jsonl` 结尾)
   - 直接 `SessionManager.open(sessionArg, parsed.sessionDir)`

2. 恢复键值
   - `resolveResumableSession(...)` 先搜索本地会话,然后搜索所有会话,除非自定义 `sessionDir` 禁用全局回退
   - 匹配不区分大小写,接受 `id` 前缀、完整 JSONL 文件名前缀,或时间戳之后的会话 id 后缀
   - 使用修改降序中的第一个匹配(没有歧义提示)

如果匹配会话的记录 cwd 已不存在,CLI 会提示 `Move (re-root) it into the current directory? [Y/n]`。接受会打开它,`moveTo(cwd)` 重新定位它;拒绝则干净退出。非 TTY 无法回答并抛出 `SessionResolutionError`。

否则,会话在其记录的项目中打开,包括全局匹配;启动会切换进程 cwd,重新加载项目作用域的设置/插件,并在构造 Agent 之前重新解析启用的模型。它**不会**仅仅因为匹配跨项目就分叉。

无匹配抛出 `Session "..." not found.`。

### `--resume`(无值)

在初始会话管理器构造之后处理:

1. 使用 `SessionManager.list(cwd, parsed.sessionDir)` 列出当前文件夹会话
2. 如果为空,仅探测 `SessionManager.listAll()` 以区分全局为空状态并预加载 Tab 作用域;选择器仍以当前文件夹作用域打开
3. 如果两个列表都为空,打印 `No sessions found` 并退出
4. 打开全屏 TUI 选择器(`selectSession`)
5. 如果取消,打印 `No session selected` 并退出
6. 选中后,将进程/项目作用域状态切换到会话的 cwd,然后 `SessionManager.open(selected.path)`

### `--continue`

直接使用 `SessionManager.continueRecent(...)`(上面的面包屑优先行为)。

## 基于选择器的选择内部机制

## CLI 选择器(`src/cli/session-picker.ts`)

`selectSession(sessions, options)` 使用 `SessionSelectorComponent` 创建全屏备用屏幕 TUI,并恰好解析一次:

- 选择 -> 解析选中的 `SessionInfo`
- 取消(Esc)-> 解析 `null`
- 硬退出(Ctrl+C 路径)-> 停止 TUI 并退出
- Tab 切换当前文件夹 / 所有项目作用域;所有项目列表惰性加载或预加载提供
- 搜索在短暂防抖后结合会话元数据/前缀文本与来自 `history.db` 的提示词历史匹配
- 鼠标滚轮更改选择,左键单击在全屏选择器中选中
- Delete,或空搜索时 Backspace,打开确认并删除 JSONL 与会话产物

## 会话内交互选择器(`SelectorController.showSessionSelector`)

流程:

1. 通过 `SessionManager.list(currentCwd, currentSessionDir)` 获取当前文件夹会话;即使文件夹作用域为空,所有项目列表仍保持惰性
2. 在编辑器区域挂载 `SessionSelectorComponent`,带惰性所有项目加载和 `history.db` 提示词匹配器
3. 回调:
   - select -> 锁定选择器输入并调用 `handleResumeSession(sessionPath)`;可恢复的切换前失败会解锁选择器
   - cancel -> 恢复编辑器并重新渲染
   - exit -> `ctx.shutdown()`

`/resume <id-prefix>` 先本地后全局解析匹配并直接切换。`/resume @claude` 和 `/resume @codex` 改为打开只读源导入选择器:选中的外部转录被持久化为 OMP 会话,然后切换;这些选择器中不提供删除、历史增强和所有项目作用域。

## 会话选择器组件行为

`SessionList` 支持:

- Up/Down 和 Page Up/Page Down 导航(钳制,不循环)
- Enter 选择
- Delete,或空搜索时 Backspace,确认后删除
- Esc 取消;Ctrl+C 退出
- Tab 切换当前文件夹 / 所有项目作用域
- 全屏选择器中的鼠标滚轮/点击
- 跨 id/标题/cwd/第一条消息/前缀消息文本/路径的多 token 搜索:字面匹配按新旧排序优先,然后足够强的模糊匹配;来自 `history.db` 的提示词历史匹配可能在键入停顿时被提升

空列表渲染行为:

- 当前文件夹作用域渲染 `No sessions in current folder. Press Tab to view all.`;所有项目作用域渲染 `No sessions found`
- 空时 Enter/Delete/Backspace 不做任何事
- Esc/Ctrl+C 仍然有效

## 运行时切换执行(`AgentSession.switchSession`)

`switchSession(sessionPath)` 是核心的进程内切换路径。

生命周期/状态转换:

1. 捕获先前的文件并发出可取消的 `session_before_switch`(`reason: "resume"`,目标文件)
2. 断开 Agent 监听器,中止活动工作,运行切换前协调器,并刷新待处理的 bash/会话写入
3. 快照回退状态(管理器、队列、消息、模型/思考/层级、工具/提示词、提供商缓存身份,以及检查点/回退状态),然后清除消息队列
4. 对于不同的会话,排空/分离顾问记录器
5. `sessionManager.setSessionFile(sessionPath)`:更新面包屑,加载/迁移/blob 解析/索引条目,并采纳现有记录的 cwd
6. 同步会话 id、内存密钥、继承的提供商缓存密钥、显示上下文,以及检查点/回退状态
7. 发出 `session_switch`,替换消息,重置顾问会话状态,并同步 todos
8. 对于不同的会话关闭提供商会话,或对于重放已变更的同会话重新加载关闭
9. 以角色/默认回退顺序恢复第一个可用的记录模型
10. 如果加载的分支以被中断的工具流结束,追加一条合成中止消息并重建显示上下文
11. 恢复配置的思考(`auto` 以 auto 存活)和各系列服务层级,当不存在对应条目时回退到当前设置
12. 按要求重置内存/工具会话状态,重新连接监听器,运行模式协调,并刷新工作区感知的基础系统提示词
13. 为不同的会话恢复顾问费用,完成 bash 转换,通知会话变更回调,并返回 `true`

快照之后的任何失败都会恢复先前的管理器和运行时状态,重新连接/协调它,将 bash 转换标记为失败,然后重新抛出。

## 交互式切换后的 UI 状态重建

`SelectorController.handleResumeSession` 在 `switchSession` 周围执行 UI 重置:

- 停止加载动画
- 清除状态容器
- 清除待处理消息 UI 和待处理工具映射
- 重置流式组件/消息引用
- 调用 `session.switchSession(...)`
- 如果恢复会话的 cwd 与先前不同,将进程和 cwd 派生的缓存重新指向它(`applyCwdChange`)
- 清除聊天容器并从会话上下文重新渲染(`renderInitialMessages`)
- 从新会话产物重新加载 todos
- 显示 `Resumed session`(跨项目恢复时显示 `Resumed session in <dir>`)

因此,可见的对话/待办状态从新会话文件重建。

## 启动恢复 vs 会话内切换

### 启动恢复(`--continue`、`--resume`、直接打开)

- 会话文件在 `createAgentSession(...)` 之前选择。
- `sdk.ts` 在创建期间构建现有会话上下文。
- Agent 消息和重放状态在构造期间恢复一次。
- 模型/思考/服务层级使用持久化状态并带当前配置回退。
- 交互模式随后协调持久化的模式状态。

### 会话内切换(`/resume` 样式选择器路径)

- 在已运行的会话上使用 `AgentSession.switchSession(...)`。
- 消息/模型/思考/层级和会话作用域的运行时状态被就地重建。
- 发出 `session_before_switch`/`session_switch` 钩子。
- 刷新 UI 聊天/todos。
- 交互模式协调通过已注册的会话切换协调器运行。

## 失败与边界情况行为

### 取消路径

- CLI 选择器取消 -> 返回 `null`,调用方打印 `No session selected`,进程退出。
- 交互选择器取消 -> 关闭覆盖层,不改变会话。
- 核心钩子取消(`session_before_switch`)-> `switchSession()` 返回 `false`。
- **当前交互注意事项:** `handleResumeSession` 不检查该布尔值,并继续其 UI 刷新/状态路径。因此,被钩子取消的交互式切换会保留旧会话,但可能显示误导性的恢复状态。

### 空列表路径

- CLI `--resume`(无值):仅当当前文件夹**和**全局列表都为空时才打印 `No sessions found` 并退出;否则空的文件夹作用域选择器邀请 Tab。
- 交互选择器:空的文件夹作用域渲染 Tab 提示,并保持可取消。

### 缺失/无效的目标会话文件

打开/切换到特定路径时(`setSessionFile`):

- ENOENT -> 视为空 -> 在该精确路径初始化新会话并持久化。
- 畸形/无效的头(或实际上不可读的解析条目)-> 视为空 -> 初始化并持久化新会话。

这是恢复行为,不是硬失败。

### 硬失败

真正的 I/O 失败(权限错误、重写失败等)时,切换/打开仍可能抛出,并传播给调用方。

### id 前缀匹配注意事项

- 匹配对小写的会话 id、小写的 JSONL 文件名,以及文件名时间戳之后的小写 id 后缀使用 `startsWith`。
- 修改降序中的第一个匹配获胜;如果多个会话共享一个前缀,没有歧义 UI。
- 前缀列表元数据有意保持轻量,因此搜索文本可能不包含会话文件前 4KB 之外的消息。
