# 原生 Rust 任务执行与取消(`pi-natives`)

本文档描述 `crates/pi-natives` 如何调度原生工作,以及取消如何从 JS 选项(`timeoutMs`、`AbortSignal`)流入 Rust 执行。

## 实现文件

- `crates/pi-natives/src/task.rs`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/workspace.rs`
- `crates/pi-natives/src/shell.rs`
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/ps.rs`

## 核心原语(`task.rs`)

`task.rs` 定义:

1. `task::blocking(tag, cancel_token, work)`
   - 包装 `napi::AsyncTask` / `Task`。
   - `compute()` 在 libuv worker 线程上运行。
   - 为导出的函数返回 JS `Promise<T>`。
   - 通过 `profile_region(tag)` 记录一个性能剖析样本。

2. `task::future(env, tag, work)`
   - 包装 `env.spawn_future(...)`。
   - 在 Tokio 运行时上运行异步工作。
   - 返回 `PromiseRaw<'env, T>`。
   - 通过 `profile_region(tag)` 记录一个性能剖析样本。

3. `CancelToken` / `AbortToken` / `AbortReason`
   - `CancelToken::new(timeout_ms, signal)` 包装共享的 `pi_shell::cancel::CancelToken`,并附加可选的 JS `AbortSignal` 桥。
   - `CancelToken::heartbeat()` 是阻塞循环的协作式取消。
   - `CancelToken::wait()` 异步等待信号或超时。
   - `CancelToken::abort_token()` 在共享标志已存在时返回由其支撑的中止句柄;没有标志时句柄是惰性的。`emplace_abort_token()` 惰性安装标志并返回活动句柄。`CancelToken::new` 使用后者将 JS `AbortSignal` 桥接到 `AbortReason::Signal`。
   - `CancelToken::aborted()` 提供非阻塞的信号/截止时间检查,`into_core()` 将 token 转移给 `pi-shell`。
   - `AbortToken::abort(reason)` 允许外部代码请求中止。原因是 `Unknown`、`Timeout`、`Signal` 和 `User`。

## `blocking` 与 `future`:执行模型与选择

### 使用 `task::blocking`

当工作属于 CPU 密集或本质同步/阻塞时使用:

- 正则/文件扫描(`grep`、`glob`、`fuzzyFind`)
- ast-grep 搜索/编辑 worker 工作
- HTML 转换
- 剪贴板图像读取

行为:

- 工作闭包接收克隆的 `CancelToken`。
- 取消仅在被检查 `ct.heartbeat()?` 的代码处被观察到。
- 闭包 `Err(...)` 拒绝 JS Promise。

### 使用 `task::future`

当工作必须 `await` 异步操作时使用:

- shell 会话编排(`Shell.run`、`executeShell`)
- 进入 `spawn_blocking` 之前的 PTY 外层 Promise(`PtySession.start`)
- 必须桥接完成与取消的异步任务编排

行为:

- Future 代码可以将正常完成与 `ct.wait()` 竞争。
- 在取消路径上,异步实现通常会取消下属机制,并可能在宽限期超时后强制中止。

## JS API ↔ Rust 导出映射(与 task/取消相关)

| JS 面向 API                                               | Rust 导出                 | 调度器                                                         | 取消接线                                                                                                                             |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `grep(options, onMatch?)`                                 | `grep`                    | `task::blocking("grep", ct, ...)`                              | `CancelToken::new(options.timeoutMs, options.signal)` + heartbeat 检查                                                                |
| `glob(options, onMatch?)`                                 | `glob`                    | `task::blocking("glob", ct, ...)`                              | `CancelToken::new(...)` + heartbeat 检查                                                                                              |
| `fuzzyFind(options)`                                      | `fuzzy_find`              | `task::blocking("fuzzy_find", ct, ...)`                        | `CancelToken::new(...)` + heartbeat 检查                                                                                              |
| `astGrep(options)` / `astMatch(options)` / `astEdit(options)` | ast 导出               | blocking worker 路径                                          | options 接受 timeout/signal 字段,并在 worker 循环中以协作方式检查                                                                     |
| `listWorkspace(options)`                                  | `list_workspace`          | `task::blocking("listWorkspace", ct, ...)`                     | `CancelToken::new(options.timeoutMs, options.signal)` + heartbeat 检查                                                                |
| `Shell#run(options, onChunk?)`                            | `Shell::run`              | `task::future(env, "shell.run", ...)`                          | JS `CancelToken` 转换为 `pi_shell::cancel::CancelToken`;shell 将其与命令完成及后代清理竞争                                              |
| `executeShell(options, onChunk?)`                         | `execute_shell`           | `task::future(env, "shell.execute", ...)`                      | 相同的取消竞争与 2 秒宽限期                                                                                                           |
| `Process#terminate(options?)`                             | `Process::terminate`      | `task::future(env, "process.terminate", ...)`                  | 可选 signal 取消终止等待;grace 与 hard-kill 超时是进程策略而非 `CancelToken` 截止时间                                                  |
| `Process#waitForExit(options?)`                           | `Process::wait_for_exit`  | `task::future(env, "process.wait_for_exit", ...)`              | 可选 signal 通过 `CancelToken` 桥接;`timeoutMs` 是等待操作的类型化 `false` 超时                                                        |
| `PtySession#start(...)` / `startArgv(...)`                | PTY 方法                 | `task::future(env, "pty.start", ...)` + 内部 `spawn_blocking`  | 同步 PTY 循环中通过 `heartbeat()` 检查 `CancelToken`                                                                                  |
| `htmlToMarkdown(html, options?)`                          | `html_to_markdown`        | `task::blocking("html_to_markdown", (), ...)`                  | 无(`()` token)                                                                                                                        |
| `encodeSixel(...)`                                        | `encode_sixel`            | 同步原生函数                                                   | 无                                                                                                                                    |
| `readImageFromClipboard()`                                | `read_image_from_clipboard` | `task::blocking("clipboard.read_image", (), ...)`            | 无(`()` token)                                                                                                                        |

`text.rs`、`tokens.rs`、`keys.rs`、大多数同步 `ps.rs` 函数、SIXEL 编码与同步工具导出不使用 `task::blocking`/`task::future` 取消。异步的 `Process.terminate()` 与 `Process.waitForExit()` 方法会使用。

## 取消生命周期与状态转换

### `CancelToken` 生命周期

```text
Created(已创建)
  ├─ 无 signal + 无 timeout  -> 被动 token
  ├─ 已注册 signal           -> AbortSignal 回调可设置 AbortReason::Signal
  └─ 已设置截止时间          -> 超时检查变为活动

Running(运行中)
  ├─ heartbeat()/wait() 看到 signal   -> AbortReason::Signal
  ├─ heartbeat()/wait() 看到截止时间  -> AbortReason::Timeout
  └─ 无中止                          -> 继续

Aborted(已中止)
  └─ 共享标志唤醒等待者;后续的中止调用可替换已存储的原因,而截止时间独立评估
```

### 启动前与执行中取消

- **启动前 / 首次取消检查前**:
  - 在 `ct.wait()` 上竞争的 `task::future` 使用者一旦进入 `select!` 即可解析取消。
  - `task::blocking` 使用者仅在闭包代码到达 `heartbeat()` 时才观察到取消。

- **执行中**:
  - `blocking`:下一次 `heartbeat()` 返回 `Err("Aborted: ...")`。
  - `future`:`ct.wait()` 分支在 `select!` 中获胜,然后代码取消下属异步机制。
  - shell:取消触发 Tokio 取消 token,发送后代终止波,等待命令任务最多 2 秒,必要时再中止任务。
  - PTY:heartbeat 失败或 `kill()` 终止 PTY 子进程/进程目标,并短暂排空输出。

## 长循环的 heartbeat 预期

`heartbeat()` 必须在包含无界或大型工作集的循环中以可预测的节奏运行。

已观察到的模式:

- `glob` 与 `fuzzyFind` 将 heartbeat 回调传入 `pi-walker` 遍历,并检查结果处理循环。
- `grep` 在昂贵搜索之前和期间进行检查,并将 token 传给其扫描/搜索 worker。
- `run_pty_sync` 以最大 16ms 等待节奏在每个循环 tick 检查。
- `listWorkspace` 在遍历期间检查。

实用规则:任何遍历外部规模输入的循环都不应在没有 heartbeat 的情况下超过一个短的受限时间间隔。

## 失败行为与向 JS 传播错误

### 阻塞任务

错误路径:

1. 闭包返回 `Err(napi::Error)`(包括 `heartbeat()` 中止)。
2. `Task::compute()` 返回 `Err`。
3. `AsyncTask` 拒绝 JS Promise。

典型错误字符串:

- `Aborted: Timeout`
- `Aborted: Signal`
- 领域错误(`Failed to decode image: ...`、`Conversion error: ...` 等)

### Future 任务

错误路径:

1. 异步主体返回 `Err(napi::Error)`,或 join 失败被映射(`... task failed: {err}`)。
2. `task::future` 派生的 Promise 被拒绝。
3. 当取消路径获胜时,shell 与 PTY 命令 API 将取消建模为结构化结果而非拒绝:`exitCode` 省略,`cancelled` 或 `timedOut` 被设置。

### 取消报告划分

- **中止作为错误**:使用 `heartbeat()?` 的阻塞导出。
- **中止作为类型化结果**:在结果结构体中建模取消的 shell/PTY 命令 API。

每个 API 选择一种模型并明确记录。

## 常见陷阱

1. **阻塞循环中缺少 heartbeat**
   - 症状:超时/信号在循环结束前看似被忽略。
   - 修复:在循环顶部与昂贵的逐项步骤之前添加 `ct.heartbeat()?`。

2. **不可取消的长段落**
   - 症状:单个大调用(解码、排序、压缩、解析器调用等)期间取消延迟飙升。
   - 修复:将工作拆分为带 heartbeat 边界的块;如不可能,记录延迟。

3. **阻塞异步执行器**
   - 症状:重同步代码直接运行在 future 中时,异步 API 停滞。
   - 修复:将 CPU/同步块移到 `task::blocking` 或 `tokio::task::spawn_blocking`。

4. **不一致的取消语义**
   - 症状:一个 API 在取消时拒绝,另一个用标志解析,令调用方困惑。
   - 修复:按领域标准化并保持文档一致。

5. **嵌套异步任务中忘记取消桥**
   - 症状:外层 token 已取消,但内部读取器/子进程任务仍在运行。
   - 修复:将取消桥接到内部 token/signal,并强制宽限超时 + 强制中止回退。

## 新可取消导出的检查清单

1. 正确分类工作:
   - CPU 密集或同步阻塞 -> `task::blocking`。
   - 异步 I/O / `await` 编排 -> `task::future`。

2. 需要时暴露取消输入:
   - 在 `#[napi(object)]` options 中包含 `timeoutMs` 与 `signal`,
   - 创建 `let ct = task::CancelToken::new(timeout_ms, signal);`。

3. 贯穿所有层接线取消:
   - 阻塞循环:`ct.heartbeat()?` 以稳定间隔运行,
   - 异步编排:与 `ct.wait()` 竞争并取消子任务/token。

4. 决定取消契约:
   - 以中止错误拒绝 Promise,或
   - 解析类型化 `{ cancelled, timedOut, ... }`,
   - 保持该契约在 API 族内一致。

5. 带上下文传播失败:
   - 通过 `Error::from_reason(format!("...: {err}"))` 映射错误,
   - 包含阶段特定前缀(`spawn`、`decode`、`wait` 等)。

6. 处理启动前与飞行中取消:
   - 取消检查/等待必须发生在昂贵主体之前,并在长时间执行期间进行。

7. 验证没有执行器误用:
   - 不要在异步 future 内部直接执行长时间同步工作,除非通过 `spawn_blocking`/阻塞任务包装。
