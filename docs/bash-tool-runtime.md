# Bash 工具运行时

本文档描述 Agent 工具调用使用的 **`bash` 工具** 运行时路径,从命令归一化到执行、截断/产物和渲染。

它还会指出交互式 TUI、print 模式、RPC 模式以及用户发起的 bang(`!`)shell 执行中行为有何不同。

## 范围与运行时表面

coding-agent 中有两个不同的 bash 执行表面:

1. **工具调用表面**(`toolName: "bash"`):模型调用 bash 工具时使用。
   - 入口:`BashTool.execute()`。
   - 参数包括 `command`、可选 `env`、`timeout`、`cwd`、`pty`,以及 `async.enabled` 为 true 时的 `async`。
2. **用户 bang-命令表面**(交互输入的 `!cmd` 或 RPC `bash` 命令):会话级辅助路径。
   - 入口:`AgentSession.executeBash()`。

两者最终都在非 PTY 执行时使用 `src/exec/bash-executor.ts` 的 `executeBash()`,但只有工具调用路径运行归一化/拦截、可选托管后台作业处理和工具渲染器逻辑。

在设置中设 `bash.enabled: false` 可从活动工具注册表中移除面向模型的 `bash` 工具。这不会禁用用户发起的 bang 命令或 RPC `bash` 请求。

## 端到端工具调用流水线

## 1) 输入处理与参数合并

`BashTool.execute()` 目前按以下方式处理输入:

- 对照 shell 变量语法校验可选的 `env` 名称,
- 未提供 `cwd` 时,把前导的单行 `cd <path> && ...` 提取为 `cwd`,除非路径需要 shell 展开,
- `async.enabled` 为 false 时拒绝 `async: true`,
- `timeout` 默认为 300 秒;`0` 显式禁用命令截止时间。

没有结构化的 `head` 或 `tail` 参数。执行前,命令和环境值中的内部 URL 被展开为底层文件系统路径;用作 `cwd` 的内部 URL 也被解析。展开可以为可写的 `local://` 路径创建父目录。配置的 direnv/devenv 预检随后可合并项目环境变更,显式 `env` 值优先。

### 批准策略

bash 工具具有 `exec` 批准层级。`bash.patterns` 规则可以显式 `allow`、`deny` 或 `prompt`:deny/prompt 规则匹配完整命令或 token 化的复合命令段,而 allow 规则必须匹配整个命令,且绝不允许 shell 控制语法。一组固定的关键破坏性和远程抓取并执行模式总是强制 exec 批准,即使用户 allow 规则匹配。拦截和批准是独立机制:拦截把滥用路由到专用工具;批准决定执行是否可以进行。

## 2) 可选拦截(被阻止命令路径)

如果 `bashInterceptor.enabled` 为 true,`BashTool` 从设置加载规则(`getBashInterceptorRules()`),并针对命令运行 `checkBashInterception()` —— 两者不同时,同时检查原始形式和 cwd 归一化形式(在提取前导 `cd … &&` 之后)。规则语法不变:每条规则先检查完整输入,然后检查由未加引号/未转义的 `&&`、`||`、`;`、`|`、`&` 或换行分隔的原始扁平命令片段,再检查移除前导 `NAME=value` 赋值后的这些片段。

拦截行为:

- 命令**仅当**满足以下条件时才被阻止:
  - 正则规则匹配,且
  - 建议工具存在于 `ctx.toolNames` 中。
- 无效正则规则被静默跳过。
- 阻止时,`BashTool` 抛出 `ToolError`,消息为:
  - `Blocked: ...`
  - 包含原始命令。
- heredoc、参数展开、命令替换、反引号、分组和格式错误的引号不会产生额外片段;它们只保留完整输入检查。拦截是尽力而为地路由到专用工具,不是 shell 安全策略。

默认规则模式(代码中定义)针对常见滥用:

- 文件读取器(`cat`、`head`、`tail`, ...)
- 搜索工具(`grep`、`rg`, ...)
- 文件查找器(`find`、`fd`, ...)
- 就地编辑器(`sed -i`、`perl -i`、`awk -i inplace`)
- shell 重定向写入(`echo ... > file`、heredoc 重定向)

### 注意事项

`InterceptionResult` 包含 `suggestedTool`,但 `BashTool` 目前只浮现消息文本(`details` 中没有结构化的建议工具字段)。

## 3) CWD 校验与超时解析

`cwd` 相对会话 cwd 解析(`resolveToCwd`),然后通过 `stat` 校验:

- 路径缺失 -> `ToolError("Working directory does not exist: ...")`
- 非目录 -> `ToolError("Working directory is not a directory: ...")`

默认超时是 300 秒。`timeout: 0` 禁用截止时间。其他值被钳制在 `[1, 3600]` 秒,并由正的 `tools.maxTimeout` 上限约束;两者不同时记录钳制通知和请求/解析值。

## 4) 产物分配

执行前,工具分配一个产物路径/id(尽力而为),用于截断输出的存储。

- 产物分配失败不致命(执行继续,无产物溢出文件),
- 产物 id/路径传入执行路径,用于截断时完整输出持久化。

## 5) PTY 与非 PTY 执行选择

PTY 资格由 `canUseInteractiveBashPty(pty, ctx)`(`src/tools/bash-pty-selection.ts`)决定;本地 PTY 覆盖只在以下全部为真时运行:

- 工具输入 `pty === true`
- `PI_NO_PTY !== "1"`
- 工具上下文有 UI(`ctx.hasUI === true` 且设置了 `ctx.ui`)

请求了 `pty` 但不可用时,调用回退到非 PTY,并追加 `pty requested but unavailable …` 通知。

在本地 PTY/非 PTY 选择之前,前台(`async: false`)调用可以路由到托管后台作业(自动后台化;见下文),或 —— 当会话客户端宣告终端能力(`clientBridge.capabilities.terminal` + `createTerminal`,且 `pty` 为 false)时 —— 路由到**客户端桥编辑器终端**,它在远程运行命令(流式 `terminalId` 更新、超时杀死、把信号杀死映射到退出码 `137`)。否则使用非交互式 `executeBash()`。

这意味着 print 模式和非 UI 的 RPC/工具上下文总是使用非 PTY。

## 非交互式执行引擎(`executeBash`)

## Shell 会话复用模型

`executeBash()` 在进程全局映射中缓存原生 `Shell` 实例,键为:

- shell 路径,
- 配置的命令前缀,
- 快照路径,
- 序列化的 shell 环境,
- 可选的 Agent 会话键,
- 最小化器配置。

会话级 bang-命令执行传 `sessionKey: this.sessionId`。

工具调用执行在可用时传 `sessionKey: this.session.getSessionId?.()`。在两个表面中,会话键按会话隔离 shell 复用;没有时,复用回退到 shell 配置/快照/环境。
并发调用从不共享一个 `Shell`:原生会话一次运行一个命令,`Shell.abort()` 会杀死它上面的每个在途运行。`executeBash()` 在 `shellSessionsInUse` 中跟踪在途键;键忙时,重叠调用跳过缓存,通过一次性 `executeShell()` 运行(与隔离会话相同的隔离)。只有拥有调用的 `finally` 释放使用中标志或删除缓存会话。

## 捆绑的 `jq` 兼容性

除非 `PI_DISABLE_UUTILS_BUILTINS` 为真值,非 PTY 原生 shell 注册一个捆绑的 `jq` 命令,由供应商的 [jaq](https://github.com/01mf02/jaq) 支撑,而非系统 `jq`。设置该标志会禁用进程内 uutils 命令集,并回退到系统二进制。捆绑 jaq 在链式访问索引穿过 null 或缺失中间值时出错:`{}` 上的 `.a.b` 以 5 退出,而 jq 返回 `null`。

当父级可能为 null 或缺失时,用 `[.a.b?][0]` 保护访问。`?` 抑制 jaq 的遍历错误(jq 从不引发它),`[…][0]` 把被抑制的空输出映射为 `null`,同时保留合法的 `false` 或 `null` 值:

```jq
{"c": [.a.b?][0]}
```

避免天真的 `.a.b? // null`:`//` 把合法的 `false`(和 `null`)视为缺失,因此它会把布尔数据静默重写为回退值。它在解析上也有分歧 —— `{"c": .a.b? // null}` 被 jaq 接受,但却是 jq 中的语法错误(该值需要括号:`{"c": (.a.b? // null)}`)。

## Shell 配置、direnv 和快照行为

每次调用时,执行器加载设置的 shell 配置(`shell`、`env`、可选 `prefix`),并运行 `applyDirenvPreflight()`。

除非 `bash.direnv` 为 `"off"`,预检尝试在 `bash.direnvLoadTimeoutMs` 内加载 cwd 的 direnv/devenv 变更,并额外受正命令超时约束。direnv 提供的变量合并到显式调用方 `env` 之下;被 direnv 移除的安全变量以 `unset -v ...` 前缀。ACP 终端和 PTY 路由在其后端前运行相同的预检;非 PTY 执行器内部运行它。

所选 shell 包含 `bash` 时,它尝试 `getOrCreateSnapshot()`:

- 快照从用户 rc 捕获别名/函数/选项,
- 快照创建是尽力而为,
- 失败回退到无快照。

配置了 `prefix` 时,它在任何 direnv unset 前缀之后包装命令。

随后,逐命令子环境由 `buildNonInteractiveEnv()`(`src/exec/non-interactive-env.ts`)构建,它在调用方和 direnv 覆盖**之下**叠加非交互式加固默认值:

- 禁用分页器(`PAGER=cat`、`GIT_PAGER=cat`, … 以及 `LESS=FRX`),
- 禁用编辑器提示(`GIT_EDITOR=true`、`EDITOR=true`、`VISUAL=true`),
- 减少终端/凭据提示(`TERM=dumb`、`GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS=/usr/bin/false`、`NO_COLOR=1`、`CI=1`),
- 面向非交互行为的包管理器/工具自动化标志(npm/pnpm/yarn/pip/cargo/terraform/gh, …),
- 在 Windows 上,缺失时添加 UTF-8 区域设置/代码页默认值。

## 流式与取消

`Shell.run()` 把块流式传输到 `OutputSink` 和可选的 `onChunk` 回调。

取消:

- 中止信号触发 `shellSession.abort(...)`,
- 来自原生结果的超时映射为 `cancelled: true` + 注释文本,
- 显式取消同样返回 `cancelled: true` + 注释。

超时/取消时执行器内部不抛异常;它返回结构化的 `BashResult`,让调用方映射错误语义。

## 交互式 PTY 路径(`runInteractiveBashPty`)

启用 PTY 时,工具运行 `runInteractiveBashPty()`,它打开一个覆盖控制台组件,并驱动原生 `PtySession`。

行为要点:

- xterm-headless 虚拟终端在覆盖层中渲染视口,
- 键盘输入被归一化(包括 Kitty 序列和应用光标模式处理),
- 运行中按 `esc` 杀死 PTY 会话,
- 终端大小变化传播到 PTY(`session.resize(cols, rows)`)。

与非 PTY 引擎不同,交互式 PTY 路径**不**应用非交互式加固。它继承用户的环境,并设置真实的 `TERM=xterm-256color`(在 Rust 侧作为覆盖应用),使编辑器、分页器和 TUI 表现得像普通终端。

PTY 输出被归一化(`CRLF`/`CR` 到 `LF`、`sanitizeText`)并写入 `OutputSink`,包括产物溢出支持。

PTY 启动/运行错误时,接收器收到 `PTY error: ...` 行,命令以未定义退出码结束。

## 输出处理:流式、截断、产物溢出

PTY 和非 PTY 路径都使用 `OutputSink`。

## OutputSink 语义

bash 执行器从设置(`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`)用 `headBytes` 和 `maxColumns` 构建接收器。

- 保持 UTF-8 安全的滚动**尾部**窗口(`spillThreshold`、`DEFAULT_MAX_BYTES`,目前 50KB);溢出时修剪到尾部(UTF-8 边界安全)并标记 `truncated`,
- `headBytes > 0` 时(`tools.artifactHeadBytes`,默认 20KB)还保留**头部**窗口并省略中间,在 `dump()` 中于头部和尾部之间拼接省略标记,
- 逐行列上限:`maxColumns > 0` 时(`tools.outputMaxColumns`,默认 768 字节)超宽行在写入时被省略号截断,行其余部分被丢弃,
- 跟踪已见总字节/行,
- 输出溢出、列上限丢弃字节或文件已活动时,把**原始、无上限**的流镜像到产物文件,
- 在尾部溢出、中间省略、列上限丢弃或文件溢出时标记 `truncated`。

`dump()` 返回:

- `output`(可能带注释前缀),
- `truncated`,
- `totalLines/totalBytes`,
- `outputLines/outputBytes`,
- 省略中间时的 `elidedBytes/elidedLines`,
- 逐行上限触发时的 `columnDroppedBytes/columnTruncatedLines`,
- 产物文件活动时的 `artifactId`。

### 长输出注意事项

运行时截断在 `OutputSink` 中基于字节阈值(默认 50KB 尾部窗口,外加可选头部窗口用于中间省略)。它不在该代码路径中强制硬行数上限。

### Shell 输出最小化器

非 PTY 执行还把 shell 最小化器设置传入原生 `Shell` 会话。最小化器重写冗长输出时,执行器用最小化文本替换接收器的可见文本,并尽可能把原始捕获保存为单独的 `bash-original` 产物,由 `[raw output: artifact://<id>]` 页脚引用。

## 实时工具更新与异步作业

对于非 PTY 前台执行,`BashTool` 使用单独的 `TailBuffer` 处理部分更新,并在命令运行期间发出 `onUpdate` 快照。

对于 PTY 执行,实时渲染由自定义 UI 覆盖层处理,而不是 `onUpdate` 文本块。

`async.enabled` 为 true 且调用传 `async: true` 时,`BashTool` 立即启动托管 bash 作业,返回带作业 id 的运行结果,并通过会话作业管理器存储完成。自动后台化也可以在 `bash.autoBackground.thresholdMs` 后使用此路径;它被 PTY 和客户端桥终端路由跳过,作业管理器满时回退到前台执行。排队的引导消息可以提前把仍在运行的自动后台候选转为后台。

## 结果整形、元数据与错误映射

执行后:

1. 取消或缺失退出状态抛出工具错误。客户端桥终端路由在结构化结果整形前也会为超时抛出 `ToolError`。
2. 本地非 PTY 和交互式 PTY 超时返回 `details.timedOut = true` 的错误结果,使渲染器能区分它们与普通失败。
3. 空输出变成 `(no output)`。
4. 最终内联字节上限保护绕过 `OutputSink` 的路由;它尽可能复用接收器产物,或保存 `bash-original` 产物。
5. 截断元数据从接收器摘要附加。
6. 非零退出返回 `details.exitCode` 的错误结果;零返回成功。

结果细节还可以包括解析/请求超时、`timeoutDisabled`、客户端 `terminalId`、墙钟时间、异步作业状态和截断元数据。截断包括方向/原因、总行数和显示行数/字节数、显示范围,以及持久化成功时的 `artifactId`。

内置工具包装自动追加面向模型的恢复通知,例如 `Read artifact://<id> for full output`。

## 渲染路径

## 工具调用渲染器(`bashToolRenderer`)

`bashToolRenderer` 用于工具调用消息(`toolCall` / `toolResult`):

- 折叠模式显示视觉行截断预览,
- 展开模式显示所有当前可用的输出文本,
- 警告行包括截断原因和截断时的 `artifact://<id>`,
- 超时值(来自参数)显示在页脚元数据行。

### 注意事项:完整产物展开

`BashRenderContext` 有 `isFullOutput`,但当前渲染器上下文构建器不为 bash 工具结果设置它。展开视图仍使用结果内容中已有的文本(尾部/截断输出),除非另一个调用方提供完整产物内容。

## 用户 bang-命令组件(`BashExecutionComponent`)

`BashExecutionComponent` 用于交互模式中的用户 `!` 命令(非模型工具调用):

- 实时流式块,
- 折叠预览保留最后 20 个逻辑行,
- 每行钳制在 4000 字符,
- 存在元数据时显示截断 + 产物警告,
- 分别标记取消/错误/退出状态。

该组件由 `CommandController.handleBashCommand()` 接线,并由 `AgentSession.executeBash()` 供数据。

## 模式特定行为差异

| 表面                        | 入口路径                                            | PTY 资格                                          | 实时输出 UX                                                           | 错误浮现                                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| 交互式工具调用          | `BashTool.execute`                                    | 是,当 `pty=true` 且存在 UI 且 `PI_NO_PTY!=1` | PTY 覆盖层(交互式)或流式尾部更新                       | 工具错误变成 `toolResult.isError`          |
| print 模式工具调用           | `BashTool.execute`                                    | 否(无 UI 上下文)                                    | 无 TUI 覆盖层;输出出现在事件流/最终助手文本流中 | 相同的工具错误映射                          |
| RPC 工具调用(agent 工具)  | `BashTool.execute`                                    | 通常无 UI -> 非 PTY                              | 结构化工具事件/结果                                           | 相同的工具错误映射                          |
| 交互式 bang 命令(`!`) | `AgentSession.executeBash` + `BashExecutionComponent` | 否(直接使用执行器)                           | 专用 bash 执行组件                                       | 控制器捕获异常并显示 UI 错误 |
| RPC `bash` 命令             | `rpc-mode` -> `session.executeBash`                   | 否                                                    | 直接返回 `BashResult`                                            | 消费者处理返回字段                 |

## 操作注意事项

- 拦截器只在建议工具当前在上下文中可用时阻止命令。
- 产物分配失败时,截断仍然发生,但没有可用的 `artifact://` 反向引用。
- 本模块中 shell 会话缓存没有显式驱逐;生命周期是进程范围的。
- 超时整形是后端特定的:本地非 PTY 和交互式 PTY 超时返回 `details.timedOut` 的错误结果;客户端桥终端创建/执行超时路径抛出 `ToolError`。非超时取消在这些工具调用路由上抛出。

## 实现文件

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — 工具入口点、输入处理/拦截、异步与 PTY/非 PTY 选择、结果/错误映射、bash 工具渲染器。
- [`src/tools/bash-pty-selection.ts`](../packages/coding-agent/src/tools/bash-pty-selection.ts) — 用于选择本地 PTY 覆盖层的 `canUseInteractiveBashPty` 谓词。
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — 拦截器规则匹配和被阻止命令消息。
- [`src/tools/bash-skill-urls.ts`](../packages/coding-agent/src/tools/bash-skill-urls.ts) — 命令、环境值和 cwd 的内部 URL 展开。
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — 非 PTY 执行器、shell 会话复用、取消接线、输出接收器集成。
- [`src/exec/non-interactive-env.ts`](../packages/coding-agent/src/exec/non-interactive-env.ts) — 非 PTY 执行器使用的非交互式子进程环境默认值(`buildNonInteractiveEnv`)。
- [`src/exec/direnv.ts`](../packages/coding-agent/src/exec/direnv.ts) — 执行器预检使用的 direnv/devenv 环境加载。
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY 运行时、覆盖 UI、输入归一化和交互式 `TERM` 设置。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`、`TailBuffer`、截断/产物溢出和摘要元数据。
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — 截断元数据形状 + 通知注入包装器。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 会话级 `executeBash`、消息记录、中止生命周期。
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — 交互式 `!` 命令执行组件。
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — 交互式 `!` 命令 UI 流/更新完成的接线。
- [`src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) — RPC `bash` 和 `abort_bash` 命令表面。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` 解析。
