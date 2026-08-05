# bash

> 在会话工作区中执行 shell 命令,支持可选的 PTY 或后台任务处理。

## 来源
- 入口:`packages/coding-agent/src/tools/bash.ts`
- 模型提示词:`packages/coding-agent/src/prompts/tools/bash.md`
- 主要协作方:
  - `packages/coding-agent/src/tools/bash-interactive.ts` — PTY/TUI 执行路径。
  - `packages/coding-agent/src/tools/bash-interceptor.ts` — 拦截更适合用工具完成的 shell 模式。
  - `packages/coding-agent/src/tools/bash-skill-urls.ts` — 将内部 URL 展开为路径。
  - `packages/coding-agent/src/tools/bash-pty-selection.ts` — `canUseInteractiveBashPty()` 决定调用是否可以使用本地 PTY 覆盖层。
  - `packages/coding-agent/src/tools/gh-cache-invalidation.ts` — 为变更性的 `gh issue`/`gh pr` 子命令丢弃 `github-cache` 行。
  - `packages/coding-agent/src/exec/bash-executor.ts` — 非 PTY shell 执行。
  - `packages/coding-agent/src/session/streaming-output.ts` — 尾部缓冲区、截断、产物溢出。
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 超时钳制边界。
  - `packages/coding-agent/src/config/settings-schema.ts` — 默认拦截规则。
  - `docs/bash-tool-runtime.md` — 更深入的执行器/运行时说明;作为 shell 会话内部的配套文档。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `command` | `string` | 是 | 要执行的 shell 命令文本。仅当省略 `cwd` 时,前导 `cd <path> && ...` 会被重写为 `cwd`。 |
| `env` | `Record<string, string>` | 否 | 额外的环境变量。键必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`,否则工具抛出异常。值经过内部 URL 展开,并作为环境值传递,而非 shell 文本。 |
| `timeout` | `number` | 否 | 超时秒数。默认 `300`。`0` 禁用截止时间。正值先被 `tools.maxTimeout` 封顶(当该设置为正时),然后钳制到 Bash 范围 `1..3600`。 |
| `cwd` | `string` | 否 | 工作目录,通过 `resolveToCwd` 相对 `session.cwd` 解析。必须存在且为目录。 |
| `pty` | `boolean` | 否 | 请求 PTY 模式。默认 `false`。仅当 `pty: true`、`PI_NO_PTY !== "1"` 且工具上下文有 UI 时使用 PTY。 |
| `async` | `boolean` | 否 | 后台执行请求。仅当会话的 `async.enabled` 为 true 时存在。立即返回任务 id 而非等待;它不改变有效截止时间,包括 `timeout: 0` 禁用的截止时间。 |

## 输出
该工具返回单个 `text` 内容块加可选 `details`。

- 成功,前台:
  - `content[0].text`:命令输出,命令无输出时为 `(no output)`。
  - `details.timeoutSeconds`:全局/工具钳制后的有效正超时,或 `timeout: 0` 时的 `details.timeoutDisabled: true`。
  - `details.requestedTimeoutSeconds`:当请求的正超时不同于有效超时时存在。
  - `details.wallTimeMs`:已完成本地/客户端终端运行经过的墙钟毫秒数。
  - `details.terminalId`:执行通过客户端终端桥路由时存在。
  - `details.exitCode`:命令以非零退出码完成时存在。
  - `details.timedOut: true`:本地/PTY 超时结果上存在。
  - `details.meta.truncation`:输出在内存中被截断时存在;完整输出溢出到产物时包含 `artifactId`。
  - 非零退出与本地/PTY 超时返回标记为 `isError` 的工具结果;确定的非零输出以 `Command exited with code <n>` 结尾。
- 成功,后台启动(`async: true` 或自动后台):
  - `content[0].text`:可选的预览尾部与提示,后跟 `Backgrounded as job <id>; result will be delivered automatically.`
  - `details.async`:`{ state: "running", jobId, type: "bash" }`。
- 后台进度 / 完成:
  - 通过 `onUpdate` / 异步任务管理器投递,而非初始返回。
  - 运行中更新仅在任务被视为后台后包含尾部文本与 `details.async.state: "running"`。
  - 完成/失败更新携带最终文本与 `details.async.state: "completed" | "failed"`。非零退出或超时记录为失败的后台任务。
- 失败:
  - 取消、缺失退出状态、校验失败、被拦截的命令与客户端终端桥超时抛出 `ToolError` / `ToolAbortError`。

stdout 与 stderr 在模型看到之前合并。确定的非零退出码以 `Command exited with code <n>` 附加到返回的错误结果文本中。

## 命令策略与专用工具路由

两个独立设置可以阻止 Bash 子进程启动。它们用途不同,在工具调用生命周期的不同点生效。

| 设置 | 用途 | 规则语法 | 匹配时结果 |
| --- | --- | --- | --- |
| `bash.patterns` | 命令特定执行策略 | 带 `*` 通配符的字面文本 | 允许调用、请求人工批准或拒绝它。 |
| `bashInterceptor.patterns` | 优先使用专用工具而非 Bash | JavaScript 正则表达式、可选标志、工具名与消息 | 返回 Bash 工具错误,告诉模型改调用指定的专用工具。 |

### `bash.patterns`:权限策略

`bash.patterns` 用于必须被允许、需人工确认或无论其他工具能否完成工作都拒绝的命令。规则按顺序排列;第一条匹配的规则生效。每条规则有一个 `match` glob 与一个值为 `allow`、`prompt` 或 `deny` 的 `approval`。

```yaml
bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "curl *"
      approval: prompt
    - match: "rm -rf *"
      approval: deny
```

- `deny` 在 `BashTool.execute()` 运行前停止调用,包括 `yolo` 模式。
- `prompt` 显示批准请求。只有被接受的请求才会继续到 `BashTool.execute()`。
- `allow` 可以降低简单命令的批准等级,但不能批准复合命令。例如,`match: "git *"` 不会批准 `git status && rm -rf build`。
- `deny` 与 `prompt` 检查完整命令与每个 shell 命令段。因此 `match: "rm -rf *"` 这样的规则会捕获 `cd /tmp && rm -rf build`。

使用此设置可实现安全与用户控制。它对没有合适替代工具的命令仍然有用,例如破坏性删除、网络访问、部署脚本或项目特定脚本。

### `bashInterceptor.patterns`:专用工具路由

`bashInterceptor` 是可选加入的路由层(`bashInterceptor.enabled` 默认为 `false`)。它用于技术上有效但通过可用专用工具表达更好的 Bash 命令。每条模式是一个正则表达式,包含该替换工具的名称与向模型展示的解释。

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead; it handles binary files and provides better context."
    - pattern: '^\s*(grep|rg)\s+'
      tool: grep
      message: "Use the grep tool instead; it respects .gitignore and returns structured results."
```

拦截规则仅当其 `tool` 在当前会话中可用时适用。若 `read` 被禁用,针对 `read` 的 `cat` 规则不会阻止 Bash 调用。这使拦截器成为尽力而为的能力偏好,而非执行安全边界。

内置默认规则将 `cat` 等常见操作路由到 `read`、`rg` 到 `grep`、原地 `sed` 到 `edit`、shell 重定向到 `write`,以及不受管理的服务/后台进程到 `hub`。完整列表见 `packages/coding-agent/src/config/settings-schema.ts` 中的 `DEFAULT_BASH_INTERCEPTOR_RULES`。

为兼容现有自定义正则,拦截器总是先检查完整原始命令,然后检查由未加引号且未转义的 `&&`、`||`、`;`、`|`、`&` 或换行分隔的原始扁平命令片段。还会检查移除前导环境赋值后的片段:

```bash
git add file && git commit -m "message"
GIT_AUTHOR_NAME=Dev git commit -m "message"
```

因此 `^\s*git\s+commit\b` 这样的锚定规则可以在两个示例中匹配 `git commit` 命令。带引号、转义与被注释的文本不作为命令处理。Heredoc、参数展开、命令替换、反引号、分组与格式错误的引号只保留完整命令检查;拦截器刻意不尝试成为完整的 shell 解析器。

### 交互与选择指南

批准策略在执行前解析。匹配的 `bash.patterns` `deny` 永远不会到达拦截器。匹配的 `prompt` 仅在用户接受批准请求后才到达拦截器。若被接受的调用随后匹配拦截规则,Bash 调用仍不会运行;模型收到路由错误,应调用专用工具。

除非有意采用这种两步行为,否则避免在两处配置同一操作。例如,`cat *` 的 `prompt` 规则加上启用的 `cat`→`read` 拦截器会先请用户批准 Bash,然后拒绝 Bash 并要求模型改用 `read`。

按期望结果选择设置:

- 当问题是**命令是否允许执行**时,使用 `bash.patterns`。
- 当问题是**应由哪个工具执行该操作**时,使用 `bashInterceptor.patterns`。

1. `packages/coding-agent/src/tools/bash.ts` 中的 `BashTool.execute()` 读取 `command`,校验 `env`,并将 `timeout` 默认为 `300`。
2. 若缺少 `cwd`,它将前导 `cd <path> && ...` 重写为结构化 `cwd` 字段,并从 `command` 中剥离该前缀。
3. 若在 `async.enabled` 关闭时请求 `async: true`,它会在任何执行前抛出 `ToolError`。
4. 若 `bashInterceptor.enabled` 开启,`checkBashInterception()` 对原始命令与剥离 `cd` 后的命令都运行。对每种形式,配置的正则先检查完整输入,然后检查由未加引号/未转义的 `&&`、`||`、`;`、`|`、`&` 或换行分隔的每个扁平命令,随后是没有前导 `NAME=value` 赋值的片段版本。匹配的启用规则在 URL 展开或执行前抛出异常。
5. `expandInternalUrls()` 重写 `command` 内、每个 `env` 值以及看起来像协议的 `cwd` 值中受支持的内部 URL。命令替换经过 shell 转义;`env` 与 `cwd` 替换使用原始文件系统/字符串值,因为它们不会插入 shell 文本。
6. `resolveToCwd()` 相对 `session.cwd` 解析 `cwd`;`fs.stat()` 验证目标存在且为目录。
7. `timeout: 0` 禁用截止时间。否则 `clampTimeout("bash", requestedTimeoutSec, tools.maxTimeout)` 应用正全局上限(配置时),然后 `TOOL_TIMEOUTS.bash`(`min: 1`、`max: 3600`)。被钳制时,`#buildCompletedResult()` / `#buildBackgroundStartResult()` 附加一行提示。
8. 执行路径分支:
   1. `async: true` -> `#startManagedBashJob()` 注册会话异步任务并立即返回。
   2. 非 PTY 且 `bash.autoBackground.enabled` 开启、异步任务管理器低于其运行任务上限、且无客户端终端桥可用(两者都适用时桥优先)-> 启动托管任务,最多等待 `min(thresholdMs, timeoutMs - 1000)`,然后要么返回完成结果,要么将运行转换为后台任务。
   3. 非 PTY 客户端终端桥,当会话通告终端能力且 `pty` 为 false 时 -> 创建远程终端,流式/轮询当前输出,完成后释放终端。
   4. 否则运行前台执行。
9. 无客户端终端的非 PTY 前台调用 `packages/coding-agent/src/exec/bash-executor.ts` 的 `executeBash()`;该路径自行执行 direnv/devenv 预检。
10. 前台 PTY 与客户端终端路径在 `BashTool` 中于派发前运行相同的 direnv 预检。使用 `bash.direnv: "auto"`(默认)时,被允许的 `.envrc` 可将环境变更合并进命令;`"off"` 禁用此行为。`bash.direnvLoadTimeoutMs` 默认为 `30_000`,正的命令超时也约束预检。
11. 本地非 PTY 与 PTY 路径在 `session.allocateOutputArtifact` 可用时先分配输出产物。产物路径/id 传入 sink,使大输出可以溢出到磁盘。
12. `executeBash()` 加载 shell 设置、可选 shell 快照与 shell 最小化器设置,然后通过持久原生 `Shell` 会话或一次性 `executeShell()` 运行。`docs/bash-tool-runtime.md` 详细覆盖该路径。
13. `runInteractiveBashPty()` 创建 `PtySession`,叠加 xterm 驱动的控制台 UI,将用户按键输入转发到 PTY,通过 `OutputSink` 捕获输出,并在关闭/释放时杀死 PTY。
14. 客户端终端桥模式调用 `session.getClientBridge().createTerminal(...)`,发出 `terminalId` 更新,轮询输出直到退出/超时/中止,将信号退出映射为 `137`,并在 `finally` 中释放句柄。
15. 完成时,`#buildCompletedResult()` 在需要时格式化 `(no output)`,从输出摘要附加截断元数据,附加墙钟时间/超时/退出提示,并在返回前重新检查未完成状态。
16. 本地/PTY 超时结果成为带 `details.timedOut` 的 `isError` 结果;客户端终端超时与取消/缺失退出状态路径在可用时携带捕获的输出抛出异常。

## 模式 / 变体
1. 前台非 PTY 本地
   - 无客户端终端桥可用时的默认路径。
   - 使用 `executeBash()`。
   - 通过 `streamTailUpdates()` 与 `TailBuffer(DEFAULT_MAX_BYTES)` 流式传输仅尾部更新。
2. 前台非 PTY 客户端终端
   - 当 `session.getClientBridge()?.capabilities.terminal` 为 true、`createTerminal` 存在且 `pty` 为 false 时使用。
   - 通过带 `details.terminalId` 的轮询更新流式传输当前终端输出。
   - 强制相同的超时与中止行为,然后释放终端句柄。
3. 前台 PTY
   - 需要 `pty: true`、UI 上下文与 `PI_NO_PTY !== "1"`。
   - 使用 `runInteractiveBashPty()` 与 `PtySession` 覆盖层。
   - 支持交互输入;`Esc` 从覆盖层杀死会话。
4. 显式后台任务
   - 需要 `async: true` 与 `async.enabled`。
   - 用 `session.asyncJobManager` 注册任务并立即返回 `{ state: "running", jobId }`。`timeout: 0` 使任务没有工具强加的截止时间。
5. 自动后台非 PTY 任务
   - 需要 `bash.autoBackground.enabled`、无 PTY/客户端终端桥,且异步任务管理器低于其运行任务上限。
   - 像前台托管任务一样启动,然后在超过等待窗口时将其后台化;达到容量时,Bash 回退为直接前台执行。
6. 被拦截的命令
   - 不创建子进程。
   - 返回指向 `read`、`grep`、`glob`、`edit` 或 `write` 的 `ToolError`。

## 副作用
- 文件系统
  - 用 `fs.stat()` 校验 `cwd`。
  - 可能分配并写入完整本地输出(`bash`)与最小化器保留的原始输出(`bash-original`)的产物文件。
  - `expandInternalUrls(..., { ensureLocalParentDirs: true })` 在执行前为 `local://` 路径创建父目录。
- 子进程 / 原生绑定 / 客户端终端
  - 非 PTY 本地执行通过 `@oh-my-pi/pi-natives` 使用原生 shell 执行(`Shell.run()` 或 `executeShell()`)。
  - PTY 使用原生 `PtySession.start()`。
  - 客户端终端模式将进程执行委托给已连接的客户端终端能力。
- 会话状态
  - 读取异步、自动后台、拦截器、direnv、全局超时上限、工具可用性与 shell 配置的会话设置。
  - 为显式/自动后台运行向 `session.asyncJobManager` 注册任务。
  - 使用 `session.getSessionId()` 隔离 shell 复用与异步会话键。
  - 使用 `session.allocateOutputArtifact()` 作为溢出文件。
  - 当命令包含变更性的 `gh issue`/`gh pr` 子命令时,在执行前使 `github-cache` 行失效,以便后续 `issue://`/`pr://` 读取看到变更后的状态(`invalidateGithubCacheForBashCommand`)。
- 用户可见提示 / 交互式 UI
  - PTY 模式打开标题为 `Console` 的 TUI 覆盖层并将输入转发到 PTY。
  - 后台启动消息注明结果完成时自动投递,在此之前 `hub` 工具可以等待它。
- 后台工作 / 取消
  - 异步与自动后台任务在初始工具返回后继续,直到完成、取消或其截止时间(除非 `timeout: 0` 禁用它)。
  - 取消中止原生运行;PTY 覆盖层关闭也会杀死 PTY。

## 限制与上限
- 默认超时:`300s`(`packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `TOOL_TIMEOUTS.bash.default`)。
- `timeout: 0` 禁用命令截止时间。
- 正超时钳制:`tools.maxTimeout` 是可选全局上限(`0` 表示无全局上限),然后是 Bash `1..3600s` 范围。
- 自动后台默认阈值:`60_000ms`(`packages/coding-agent/src/tools/bash.ts` 中的 `DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS`),存在截止时间时进一步限制为 `timeoutMs - 1000`;禁用截止时间时阈值不设上限。
- 带截止时间的非 PTY 执行器在 `max(1_000, timeoutMs)` 处武装宿主侧计时器,并将相同的正超时传给原生运行;`timeout: 0` 不传截止时间。超时的持久 shell 会话被隔离(`packages/coding-agent/src/exec/bash-executor.ts`)。
- 内存输出尾部上限:`50 * 1024` 字节(`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_BYTES`)。超过后,sink 只在内存中保留尾部窗口。
- `executeBash()` 中的流式回调节流:启用流式时 `onChunk` 调用间隔 `50ms`。
- TUI 折叠预览:`10` 个视觉行(`BASH_DEFAULT_PREVIEW_LINES`),在 Agent UI 中内联渲染时;这是渲染器上限,不是工具输出上限。

## 错误
- 输入校验:
  - 无效 env 键 -> `ToolError("Invalid bash env name: <key>")`。
  - 禁用时请求异步 -> `ToolError("Async bash execution is disabled...")`。
  - 缺少异步任务管理器 -> `ToolError("Background job manager unavailable for this session.")`。
  - 缺失/错误 `cwd` -> `ToolError("Working directory does not exist: ...")` 或 `ToolError("Working directory is not a directory: ...")`。
- 拦截器:
  - 匹配的命令 -> 带 `Blocked: <rule.message>` 与原始命令的 `ToolError`。
  - 无效的拦截器正则被 `compileRules()` 静默跳过。
- 内部 URL 展开:
  - 不支持的协议、未知技能、路径穿越、缺少路由器支持或路由器解析失败都会从 `packages/coding-agent/src/tools/bash-skill-urls.ts` 抛出 `ToolError`。
- 执行:
  - 非零退出 -> 返回标记为 `isError` 的工具结果,带 `details.exitCode`,文本以 `Command exited with code <n>` 结尾。
  - 缺失退出码 -> 抛出带 `Command failed: missing exit status` 的 `ToolError`。
  - 超时 -> 本地/PTY 执行返回带 `details.timedOut: true` 与超时提示的 `isError` 结果;客户端终端桥在杀死终端并尝试最终输出读取后抛出 `ToolError`。托管后台执行将任一形式记录为失败任务。
  - 用户中止 -> 调用方信号中止时抛出 `ToolAbortError`。
- 产物分配 / 产物保存失败在 `saveBashOriginalArtifact()` 与 `OutputSink.#createFileSink()` 中被吞掉;执行继续而不带该产物。

## 备注
- `BashTool` 上设置了 `strict = true`;`concurrency` 按调用解析:`pty: true` 为 `"exclusive"`(它接管终端 UI),其他一切都是 `"shared"`,因此一条助手消息中的多个非 pty bash 调用并行运行。当并行调用在同一 shell 会话键上重叠时,第一个拥有持久 `Shell`;其余在隔离的一次性 shell 中运行(见 `bash-executor.ts` 中的 `shellSessionsInUse`)。
- `command` URL 展开对替换做 shell 转义;`env` 与 `cwd` 展开使用 `noEscape: true`,因为它们成为环境值/文件系统路径,而非 shell 文本。
- `checkBashInterception()` 仅当匹配规则的 `tool` 名称存在于 `ctx.toolNames` 中时拦截;缺失工具会禁用其对应规则。
- 拦截器配置语法不变。它处理常见扁平命令列表,而非完整 shell 解析:heredoc、参数展开、命令替换、反引号、分组与格式错误的引号只接收现有的完整输入检查。这是对专用工具的尽力路由,不是安全边界。
- `bash.direnv` 默认为 `"auto"` 并遵守 direnv 的允许列表;未允许的 `.envrc` 不会执行。设为 `"off"` 可绕过预检。`bash.direnvLoadTimeoutMs` 控制冷加载预算。
- 默认拦截规则来自 `packages/coding-agent/src/config/settings-schema.ts` 中的 `DEFAULT_BASH_INTERCEPTOR_RULES`:
  - `cat|head|tail|less|more` -> `read`
  - `grep|rg|ripgrep|ag|ack` -> `grep`
  - 带 name/type/glob 标志的 `find|fd|locate` -> `glob`
  - `sed -i`、`perl -i`、`awk -i inplace` -> `edit`
  - 带重定向的 `echo|printf|cat <<` -> `write`
- 非 UI 上下文与 `PI_NO_PTY=1` 时忽略 PTY 模式(由 `canUseInteractiveBashPty()` 门控);工具回退为非 PTY 执行并附加 `pty requested but unavailable in this environment; ran without a terminal` 提示。
- 非 PTY 运行通过 `buildNonInteractiveEnv()` 将 `NON_INTERACTIVE_ENV` 与 `env` 合并;PTY 运行改为继承用户环境,并在自定义 `env` 值之前前置 `TERM=xterm-256color`。
- 当 shell 最小化器在 `executeBash()` 内重写输出时,可见输出被替换为最小化文本,若 `onMinimizedSave` 持久化了原文,可能附加 `[raw output: artifact://<id>]` 页脚。
- TUI 渲染器解析部分 JSON 以在流式预览早期恢复 `env` 赋值;该行为仅用于显示。
- 对非工具特定的执行器内部 — shell 会话复用键、快照、前缀处理与原生超时行为 — 见 `docs/bash-tool-runtime.md`。
