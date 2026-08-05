# Natives Shell、PTY、Process 与 Key 内部机制

本文档涵盖 `@oh-my-pi/pi-natives` 中的执行/进程/终端原语:`shell`、`pty`、`ps` 和 `keys`,使用 `docs/natives-architecture.md` 中的架构术语。

## 实现文件

- `crates/pi-natives/src/shell.rs`
- `crates/pi-shell/src/shell.rs`
- `crates/pi-shell/src/cancel.rs`
- `crates/pi-shell/src/windows.rs`(仅 Windows 的 PATH 增强)
- `crates/pi-shell/src/process.rs`
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/ps.rs`
- `crates/pi-natives/src/keys.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

## 层职责

- **包入口**(`packages/natives/native/index.js`):加载 `.node` 插件并导出生成的 N-API 绑定。
- **Rust N-API 模块层**(`crates/pi-natives/src/*`):面向 JS 的 shell/PTY/process/key 导出与回调桥接。
- **运行时核心**(`crates/pi-shell/src/*`):brush shell 执行、取消清理、minimizer 集成、命令修正与跨平台进程引用。
- **消费方**(`packages/coding-agent`、`packages/tui`):更高级别的会话策略、输出产物/minimizer 处理、渲染策略与 UI 按键处理。

## Shell 子系统(`shell`)

### API 模型

Shell 执行模式:

1. **一次性**:通过 `executeShell(options, onChunk?)`。
2. **持久会话**:通过 `new Shell(options?)` 然后重复 `shell.run(...)`。

两者都通过线程安全回调流式输出合并后的 stdout/stderr,并返回 `{ exitCode?, cancelled, timedOut, minimized?, workingDir? }`。

持久化 `Shell` 还暴露 `liveBackgroundJobCount()`,它会静默回收已完成的作业,并返回活动的 `&`/`nohup` 子进程数量。这让宿主可以在后台子进程仍然存活时保留按调用创建的 shell;丢弃该 shell 会杀掉它们。

`ShellOptions` 支持 `sessionEnv`、`snapshotPath` 与可选的输出 `minimizer`。`ShellExecuteOptions` 额外支持 command、cwd、命令作用域 `env`、timeout/signal 与 minimizer。`ShellRunOptions` 支持 command、cwd、命令作用域 env、timeout 与 signal。

### 会话创建与环境模型

Rust 创建 `brush_core::Shell` 时:

- 禁用继承环境(`do_not_inherit_env: true`),随后从宿主环境显式重建环境,
- 跳过 profile 与 rc 加载,
- 启用 bash 模式内建命令,并禁用 `exec` 与 `suspend`,
- 注册原生 `sleep`、`timeout` 与 `nohup` 内建命令,
- 设置 shell 敏感变量(`PS1`、`PWD`、`SHLVL`、bash 函数导出等)的跳过列表,
- 提供未导出的 `env="$env"` 回退,使 PowerShell 风格的 `$env:NAME` 能在 brush 参数展开中存活,除非用户遮蔽了 `env`。

会话环境行为:

- `ShellOptions.sessionEnv` / 一次性 `sessionEnv` 在会话创建时应用。
- `ShellRunOptions.env` / 一次性 `env` 是命令作用域的(`EnvironmentScope::Command`),命令结束后弹出。
- `PATH` 在 Windows 上以不区分大小写的去重方式特殊合并。
- 仅 Windows 的路径增强(`pi-shell/src/windows.rs`)在存在且尚未包含时,追加发现的 Git-for-Windows 路径。
- `snapshotPath` 存在时,在会话创建期间 source,stdout/stderr/stdin 接至 null 文件。

### 运行时生命周期与状态转换

持久化 shell(`Shell.run`)使用以下状态机:

- **空闲/未初始化**:`session: None`。
- **运行中**:首次 `run()` 惰性创建会话、存储中止 token 并执行命令。
- **已完成 + 保活**:如果执行控制流正常,清除中止状态并复用会话。
- **已完成 + 拆除**:如果控制流与 loop/script/shell-exit 相关,丢弃会话。
- **已取消/超时**:触发 Tokio 取消 token,对基线快照之后启动的后代发送终止波,允许 2 秒宽限等待,任务可能被中止;若可获得锁,持久会话被丢弃。
- **错误**:丢弃会话。

一次性 shell(`executeShell`)每次调用总是创建并丢弃一个全新会话。

### 流式输出与 minimizer 行为

- stdout/stderr 被路由到共享管道并并发读取。
- 读取器增量解码 UTF-8;无效字节序列产生 `U+FFFD` 替换块。
- 命令以 `ProcessGroupPolicy::NewProcessGroup` 运行。
- 前台命令完成后,读取器排空直到 EOF、250ms 空闲输出或最多 2 秒;随后读取器关闭获得 250ms 超时。
- 可选的 minimizer 配置可以捕获并重写输出。发生最小化时,结果包含带筛选器名称、替换/原始文本与字节计数的 `minimized`。
- 成功结果可包含反映执行后 shell cwd 的 `workingDir`。
- 消费方负责持久化或展示 minimizer 产物;原生结果只携带数据。

### 取消、超时与中止

- `CancelToken` 由 `timeoutMs` 与可选的 `AbortSignal` 构造,然后转换为共享的 `pi_shell::cancel::CancelToken`。
- 取消/超时时,触发 shell 取消 token,运行后代清理,然后任务获得 2 秒宽限期,之后强制中止。
- 使用结构化结果标志:
  - 超时 -> `exitCode` 省略,`timedOut: true`。
  - 中止信号 / `Shell.abort()` -> `exitCode` 省略,`cancelled: true`。

`Shell.abort()` 行为:

- 通过存储的 `AbortToken` 中止该 `Shell` 实例当前正在运行的命令,
- 即使没有正在运行的内容也成功解析。

### 失败行为

常见表面错误包括:

- 会话初始化失败(`Failed to initialize shell`),
- cwd 错误(`Failed to set cwd`),
- env 设置/弹出失败,
- snapshot source 失败(`Failed to source snapshot`),
- 管道创建/克隆失败,
- 执行失败(`Shell execution failed: ...`),
- 任务包装失败(`Shell execution task failed: ...`)。

## PTY 子系统(`pty`)

### API 模型

`new PtySession()` 暴露:

- `start(options, onChunk?, onStart?) -> Promise<{ exitCode?, cancelled, timedOut }>` 通过 shell 运行命令字符串。
- `startArgv(options, onChunk?, onStart?)` 直接运行应用程序与参数向量,不经过 shell 解析。
- `write(data)`
- `resize(cols, rows)`
- `kill()`

两个启动方法在 spawn 之后调用 `onStart(error, pid)`(平台子进程 PID 不可用时实现提供 `0`)。`PtyStartOptions` 支持 `command`、可选 `cwd`、`env`、`timeoutMs`、`signal`、`cols`、`rows` 与 `shell`;其默认 shell 为 `sh`。`PtyArgvStartOptions` 则要求 `application` 与 `args`,且没有 `shell`。

### 运行时生命周期与状态转换

`PtySession` 状态机:

- **空闲**:`core: None`。
- **已保留**:`start()` 在异步工作开始前同步安装控制通道(`core: Some`),因此 `write/resize/kill` 立即可用。
- **运行中**:阻塞 PTY 循环处理子进程状态、读取器事件、取消 heartbeat 与控制消息。
- **终端已关闭 / 排空**:子进程退出或取消启动短暂的读取器排空窗口。
- **已终结**:start 任务完成(成功或错误)后,`core` 总是重置为 `None`。

并发守卫:

- 已在运行时再次启动返回 `PTY session already running`。

### Spawn/attach/write/read/terminate 模式

- PTY 通过 `portable_pty::native_pty_system().openpty(...)` 打开。
- 在 Windows 上,`openpty()` 在辅助线程上运行,带 5 秒启动超时;超时以 `PTY creation timed out (5s). ConPTY may be unavailable on this system.` 拒绝。
- `start()` 通过配置的 shell 运行命令:
  - `cmd.exe`/`cmd` 使用 `/c`,
  - `powershell`/`pwsh` 使用 `-Command`,
  - 其他 shell 使用 `-lc`。
- `startArgv()` 将每个参数直接传给 `portable_pty::CommandBuilder`。
- 默认尺寸为 `120x40`;启动与 resize 时尺寸被钳制(`cols 20..400`、`rows 5..200`)。
- `write()` 向 PTY stdin 发送原始字节。
- `resize()` 发送控制消息并再次钳制尺寸。
- `kill()` 发送控制消息,将运行标记为已取消并终止 PTY 进程目标。

输出路径:

- 专用读取器线程读取 master 流,
- 增量 UTF-8 解码对无效字节产生 `U+FFFD`,
- 块通过 N-API 线程安全回调转发。

终止路径:

- `terminate_pty_processes` 在可用时以 PTY 进程组为目标,在可用时以子进程 PID 为目标。
- 发送平台 `TERM_SIGNAL`,调用 `child.kill()`,然后发送平台 `KILL_SIGNAL`。
- 在 Windows 上,丢弃 master 前关闭 ConPTY 输入;master 丢弃被卸载到后台线程并最多等待 2 秒以避免死锁。

### 取消与超时语义

- `timeoutMs` 与 `AbortSignal` 提供给 `CancelToken`。
- 循环周期性地调用 `ct.heartbeat()`,最大等待节奏 16ms。
- 超时分类基于 heartbeat 错误字符串是否包含 `Timeout`。
- 取消/杀死启动 300ms 取消后排空窗口;正常子进程退出启动 300ms 退出后排空窗口。
- 最终读取器排空在非 Windows 上为 50ms,Windows 上为 500ms。

### 失败行为

错误表面包括:

- PTY 分配/打开失败,
- Windows PTY 启动超时,
- PTY spawn 失败,
- 写入器/读取器获取失败,
- 子进程状态/等待失败,
- 锁中毒,
- 控制通道断开(`PTY session is no longer available`)。

未运行时的控制调用失败:

- `write/resize/kill` 返回 `PTY session is not running`。

## Process 子系统(`ps`)

### API 模型

当前 JS 表面是 `Process` 类:

- `Process.fromPid(pid) -> Process | null`
- `Process.fromPath(path) -> Process[]`
- getter:`pid`、`ppid`
- 方法:`args()`、`killTree(signal?)`、`terminate(options?)`、`waitForExit(options?)`、`groupId()`、`children()`、`status()`

`ProcessTerminateOptions` 支持 `{ group?, gracefulMs?, timeoutMs?, signal? }`。`ProcessWaitOptions` 支持 `{ timeoutMs?, signal? }`。

### 行为

- `killTree(signal?)` 向进程与后代发送请求的信号,先子后父;在 Windows 上忽略 signal 参数,进程通过 `TerminateProcess` 终止。
- `terminate(options?)` 是异步的。默认使用 1000ms 宽限阶段与 5000ms 硬杀后等待。传入 `gracefulMs < 0` 跳过宽限阶段。`group: true` 在支持时也以进程组为目标;其中止其 signal 会拒绝 Promise。
- `waitForExit(options?)` 在进程退出时解析为 `true`,超时时为 `false`;中止其 signal 会拒绝 Promise。

平台特定实现位于 `pi_shell::process`;`crates/pi-natives/src/ps.rs` 是 N-API 垫片,外加供 PTY 终止使用的再导出。

## Key 解析子系统(`keys`)

### API 模型

暴露的辅助函数:

- `parseKey(data, kittyProtocolActive)`
- `matchesKey(data, keyId, kittyProtocolActive)`
- `parseKittySequence(data)`
- `matchesKittySequence(data, expectedCodepoint, expectedModifier)`
- `matchesLegacySequence(data, keyName)`

### 解析模型

解析器组合:

- 直接单字节映射(`enter`、`tab`、`ctrl+<letter>`、可打印 ASCII),
- O(1) 旧式转义序列查找(PHF 映射),
- xterm `modifyOtherKeys` 解析,
- Kitty 协议解析(`CSI u`、`CSI ~`、`CSI 1;...<letter>`),
- 归一化为 key ID(`ctrl+c`、`shift+tab`、`pageUp`、`f5` 等)。

修饰键处理:

- 键匹配只比较 shift/alt/ctrl/super 位,
- 比较前掩掉锁定位。

布局行为:

- 基础布局回退被刻意约束,使重映射布局不会对 ASCII 字母/符号产生假匹配。

### 失败行为

- 无法识别或无效的序列使解析函数产生 `null`。
- 匹配函数在解析失败或不匹配时返回 `false`。
- 畸形按键输入不暴露抛出错误表面。

## JS API ↔ Rust 导出映射

### Shell + PTY + Process

| JS API                                     | Rust N-API 导出                | 说明                                             |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------ |
| `executeShell(options, onChunk?)`          | `executeShell` (`execute_shell`) | 一次性 shell 执行                              |
| `new Shell(options?)`                      | `Shell` 类                     | 持久 shell 会话                                  |
| `shell.run(options, onChunk?)`             | `Shell::run`                   | 保活控制流上复用会话                             |
| `shell.abort()`                            | `Shell::abort`                 | 中止该 shell 实例的活动运行                      |
| `shell.liveBackgroundJobCount()`           | `Shell::live_background_job_count` | 回收作业,然后计数活动后台子进程             |
| `new PtySession()`                         | `PtySession` 类                | 有状态 PTY 会话                                  |
| `pty.start(options, onChunk?, onStart?)`   | `PtySession::start`            | shell 命令 PTY 运行                              |
| `pty.startArgv(options, onChunk?, onStart?)` | `PtySession::start_argv`     | 直接可执行文件/argv PTY 运行                     |
| `pty.write(data)`                          | `PtySession::write`            | 原始 stdin 直通                                  |
| `pty.resize(cols, rows)`                   | `PtySession::resize`           | 钳制终端尺寸                                     |
| `pty.kill()`                               | `PtySession::kill`             | 终止活动 PTY 子进程/目标                         |
| `Process.fromPid(pid)`                     | `Process::from_pid`            | 稳定进程引用查找                                 |
| `Process.fromPath(path)`                   | `Process::from_path`           | 按可执行路径查找进程                             |
| `process.killTree(signal?)`                | `Process::kill_tree`           | 先子后父的进程树终止                             |
| `process.terminate(options?)`              | `Process::terminate`           | 先宽限后强硬的进程终止                           |
| `process.waitForExit(options?)`            | `Process::wait_for_exit`       | 异步退出等待                                     |
| `process.children()`                       | `Process::children`            | 直接子进程为 `Process[]`                         |
| `process.status()`                         | `Process::status`              | `running` / `exited`                             |

### Keys

| JS API                                       | Rust N-API 导出                                 | 说明                             |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------- |
| `matchesKittySequence(data, cp, mod)`        | `matchesKittySequence` (`matches_kitty_sequence`) | Kitty 码点+修饰键匹配         |
| `parseKey(data, kittyProtocolActive)`        | `parseKey` (`parse_key`)                        | 归一化 key-id 解析器             |
| `matchesLegacySequence(data, keyName)`       | `matchesLegacySequence` (`matches_legacy_sequence`) | 精确旧式序列映射检查         |
| `parseKittySequence(data)`                   | `parseKittySequence` (`parse_kitty_sequence`)   | 结构化 Kitty 解析结果            |
| `matchesKey(data, keyId, kittyProtocolActive)` | `matchesKey` (`matches_key`)                  | 高层按键匹配器                   |

## 放弃的会话清理与终结说明

- **Shell 持久会话**:如果运行被取消/超时/出错/非保活控制流,Rust 丢弃内部会话状态。成功的正常运行保留会话以供复用。
- **PTY 会话**:`start()` 完成后(包括失败路径)`core` 总是被清除。
- **包装层未暴露显式 JS 终结器驱动的 kill 契约**;清理主要与运行完成/取消路径绑定。调用方应使用 `timeoutMs`、`AbortSignal`、`shell.abort()` 或 `pty.kill()` 进行确定性拆除。
