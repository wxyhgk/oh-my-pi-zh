# Eval 工具 Python 后端

本文档描述 `packages/coding-agent` 中的 Python 执行栈。
它涵盖工具行为、runner 生命周期、环境处理、执行语义、输出渲染、受支持的 magic 和运维失败模式。

## 范围与关键文件

- 工具面:`src/tools/eval.ts`
- 会话/每次调用内核编排:`src/eval/py/executor.ts`
- 子进程内核客户端:`src/eval/py/kernel.ts`
- Python 包装 / NDJSON 服务器:`src/eval/py/runner.py`
- 加载到每个内核的前置辅助:`src/eval/py/prelude.py`
- 宿主侧子代理辅助桥:`src/eval/agent-bridge.ts`
- MIME bundle 渲染器(文本 + 结构化输出):`src/eval/py/display.ts`
- 用户触发的 Python 运行的交互模式渲染器:`src/modes/components/eval-execution.ts`
- 运行时/env 过滤和 Python 解析:`src/eval/py/runtime.ts`

## eval 的 Python 后端是什么

`eval` 工具每次调用在一个保留的 `python` 子进程内执行一个 Python cell,该子进程通过 stdin/stdout 说 NDJSON。不需要 Jupyter 网关,也不需要额外的 pip 依赖。捆绑的 runner 使用 Python 3.10 语法(`str | None`),因此有效要求是 Python 3.10+。丰富的 `display()` 输出(PIL、pandas、plotly、matplotlib 图形)可用,因为包装实现了 MIME-bundle 分派。

当前工具输入:

```ts
{
  language: "py";
  code: string;
  title?: string;
  timeout?: number; // seconds; default 30, 0 disables, otherwise clamped to 1..3600
  reset?: boolean;  // wipe the Python kernel before this call
}
```

会话作用域的 wire schema 只宣传启用的运行时。静态实现还支持 `"js"`、`"rb"` 和 `"jl"`;Python 和 JavaScript 默认开启,而 Ruby 和 Julia 是选择加入的。该工具对会话是 `concurrency = "exclusive"`,因此调用不会重叠。状态在同一语言运行时的不同调用之间持久存在。

## 内核生命周期

每个 Python 内核是一个单一子进程:`<resolved-python> -u <runner.py>`。runner 与宿主二进制捆绑(Bun 文本导入),按脚本哈希一次写入 OS 临时目录下的 `omp-python-runner` 缓存,并被后续派生复用。

内核启动序列:

1. 可用性检查(`checkPythonKernelAvailability`)——验证 Python 解释器可以解析并运行。
2. 用过滤后的 env 和 `cwd` 派生 `python -u runner.py`。
3. 发送 init 请求,运行 `os.chdir(cwd)`,注入 env 条目,并将 `cwd` 添加到 `sys.path`。
4. 执行 `PYTHON_PRELUDE`(幂等——每个进程只初始化一次)。

内核关闭:

- 通过 stdin 发送 `{"type": "exit"}`。
- 以 `SHUTDOWN_GRACE_MS` 预算等待进程退出。
- 如果进程未及时退出,升级为 `SIGTERM`,最后 `SIGKILL`。

## Wire 协议(NDJSON,宿主 ↔ runner)

每行一个 JSON 对象,UTF-8,以 `\n` 终止。

宿主 → runner:

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

Runner → 宿主:

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "display",  "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "result",   "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

prelude 发出的状态事件(如 `_emit_status("find", count=…)`)在 `application/x-omp-status` 下的 display bundles 内运输,因此现有 TUI 状态渲染器保持工作。

## Magic

runner 的源码转换器在解析前将 IPython 风格 magic 重写为普通 Python 调用。受支持集合:

| Magic                             | 效果                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%pip <args>`                     | `python -m pip <args>`,带实时流式输出。新安装的包会从 `sys.modules` 中驱逐,以便下一次 `import` 拾取新安装。 |
| `%cd <path>`                      | `os.chdir(path)`(带 `~` 展开);发出状态事件。                                                                                                  |
| `%pwd`                            | 返回 `os.getcwd()`。                                                                                                                                      |
| `%ls [path]`                      | 返回 `sorted(os.listdir(path))`。                                                                                                                         |
| `%env [KEY[=VAL]]`                | 列出、读取或设置环境变量(匹配 prelude `env()` 语义)。                                                                                            |
| `%set_env KEY VALUE`              | 设置 `os.environ[KEY]`。                                                                                                                                      |
| `%time <expr>` / `%timeit <expr>` | 计时表达式;发出带耗时 ms 的状态事件。                                                                                                    |
| `%who` / `%whos`                  | 列出用户命名空间名称。                                                                                                                                  |
| `%reset`                          | 清除用户全局变量并重新注入 prelude。                                                                                                                   |
| `%load <path>`                    | 将文件读入新 cell 并执行。                                                                                                                  |
| `%run <path>`                     | `runpy.run_path` 并将全局变量合并回来。                                                                                                                    |
| `%%bash` / `%%sh`                 | 通过 `bash`/`sh` 运行 cell 体。                                                                                                                          |
| `%%capture [name]`                | 运行 cell 体并将 stdout/stderr 捕获到 `name`。                                                                                                           |
| `%%timeit`                        | 对 cell 体计时。                                                                                                                                         |
| `%%writefile <path>`              | 将 cell 体写入文件。                                                                                                                                         |
| `!cmd` / `var = !cmd`             | 通过子进程 shell 运行命令;返回带 `.n` / `.s` 辅助的 SList 风格结果。                                                                   |
| `var = %name args`                | 赋值形式对行 magic 和 `!cmd` 有效。                                                                                                           |

未知 magic 名称在 cell 内抛出 `NameError: UsageError: ...`。

## 会话持久化语义

`python.kernelMode` 控制保留内核复用:

- `session`(默认)
  - 复用按命名空间 eval 会话 id 加规范化 cwd 和解释器为 key 的内核会话。
  - 多个所有者可以共享该 key 的同一保留内核。
  - 通过工具的调用是排他的,因此工具调用不会重叠。
  - 死掉的保留子进程在执行前被替换。
  - 如果子进程在执行期间死亡,它会被替换,调用重试一次。
- `per-call`
  - 每次调用派生新的子进程。
  - 调用后关闭子进程。
  - 无跨调用状态持久化。

### eval 调用之间的状态

每个工具调用包含一个 cell。Python 调用按顺序运行,因为工具是排他的,后来的调用在 `session` 模式下复用选定的保留内核。

如果 cell 失败,错误前完成的定义和变更可以保留在内核内存中。`reset: true` 只在该调用前重置选定的语言运行时;其他语言运行时不受影响。

## 环境过滤与运行时解析

启动 runner 前过滤环境:

- 允许列表包括 `PATH`、`HOME`、locale 变量、`VIRTUAL_ENV`、`PYTHONPATH` 等核心变量。
- 允许前缀:`LC_`、`XDG_`、`PI_`
- 拒绝列表剥离常见 API key(OpenAI/Anthropic/Gemini 等)

运行时选择顺序(`python.interpreter` 设置命名显式可执行文件时完全跳过):

1. 活动/定位的 venv(`VIRTUAL_ENV`,然后 `CONDA_PREFIX`,然后 `<cwd>/.venv`、`<cwd>/venv`)
2. `~/.omp/python-env` 的管理 venv
3. PATH 上的 `python` 或 `python3`

选择 venv 时,其 bin/Scripts 路径被前置到 `PATH`。

runner 另外接收 `PYTHONUNBUFFERED=1` 和 `PYTHONIOENCODING=utf-8`,以便流式输出及时到达宿主。

## 工具可用性与模式选择

后端设置 `eval.py` / `eval.js` 默认为 `true`;`eval.rb` / `eval.jl` 默认为 `false`。可选的布尔环境标志 `PI_PY`、`PI_JS`、`PI_RB` 和 `PI_JL` 独立覆盖对应设置。

工具的会话作用域 schema 只列出启用的运行时。如果 Python 预检失败而另一个运行时启用,`eval` 对该运行时仍然可用,`py` 调用报告 Python 后端可用性错误,并附上启用的备选方案。

Python prelude 辅助包括 `agent(prompt, *, agent="task", model=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, handle=False)`。它同步调用宿主桥,返回最终文本;提供 `schema` 时返回解析后的数据。`schema_mode` 选择宽松或严格的结构化输出处理;isolation/apply/merge 标志控制任务 worktree 行为。使用 `handle=True` 时,它返回 DAG 节点字典(`{"text", "output", "handle", "id", "agent"}`),其 handle 是可恢复的 `agent://<id>` URI;解析后的输出在可用时也存储在 `"data"` 下。

## 执行流程与取消/超时

### Cell 超时

`timeout` 以秒为单位,默认为 30。`0` 禁用 cell 超时;非零值被限制在 `1..3600` 秒,并在传给 `IdleTimeout` 前受正 `tools.maxTimeout` 上限约束。当宿主侧 `agent()` / `parallel()` / `completion()` 桥调用在飞行中时,超时被挂起:这些调用通过 `withBridgeTimeoutPause` 发出引用计数的暂停/恢复事件,控制返回时开始新的超时窗口。

暂停/恢复事件是挂起预算的唯一机制。计算、`stdout`/`stderr`、`log()`/`phase()` 和普通工具调用都计入预算。工具用 `AbortSignal.any(...)` 组合调用者、会话和看门狗中止信号;后端不武装竞争的截止时间。

### 内核执行取消

中止/超时时:

- 宿主向 runner 子进程发送 `kill("SIGINT")`。
- runner 的执行时信号处理器在用户代码内抛出 `KeyboardInterrupt`。
- 结果包含 `cancelled=true`;内核超时被注解为 `eval cell timed out after <n>s; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`
- 在请求之间,runner 为 SIGINT 安装 `SIG_IGN`,以免游离取消拆掉内核。

如果 runner 在中断后 5 秒内(`INTERRUPT_ESCALATION_MS`——例如卡在持有 GIL 的 C 代码中)没有发出 `done`,宿主关闭子进程(升级 `exit` → `SIGTERM` → `SIGKILL`),该 cell 被注解为 kernel-killed,内核在下一次调用时重新创建。

### stdin 行为

不支持交互式 stdin。runner 不转发 `input()` 提示;调用 `input()` 的用户代码会阻塞直到取消。

## 输出捕获与渲染

### 捕获的输出类别

来自 runner 帧:

- `stdout` / `stderr` → 纯文本块
- `display` / `result` → 富显示处理(MIME bundle)
- `error` → traceback 文本
- `display` 内的 `application/x-omp-status` MIME → 结构化状态事件

Display MIME 优先级:

1. `text/markdown`
2. `text/plain`
3. `text/html`(转换为基本 markdown)

另外捕获为结构化输出:

- `application/json` → JSON 树数据
- `image/png` / `image/jpeg` → 图像负载
- `application/x-omp-status` → 状态事件

### Matplotlib

runner 将 `MPLBACKEND=Agg` 设置为环境默认值,以便图形离屏渲染。每个 cell 后迭代 `pyplot.get_fignums()`;每个图形保存为 PNG,作为 `image/png` display 发出,并关闭。

### 存储与截断

输出通过 `OutputSink` 流式传输,并可能持久化到产物存储。工具结果可以包含截断元数据和用于完整输出恢复的 `artifact://<id>`。

### 渲染器行为

- 工具渲染器(`eval-render.ts`,从 `eval.ts` 重新导出):
  - 显示带每 cell 状态的代码 cell 块
  - 折叠预览默认为 10 行
  - 支持对工具结果中保留的所有输出的展开模式
- 交互渲染器(`eval-execution.ts`):
  - 用于 TUI 中用户触发的 Python 执行
  - 折叠预览默认为 20 行
  - 为显示安全将超长的单行限制到 4000 字符
  - 显示取消/错误/截断通知

## 运维故障排查

- **Python 后端不可用** — 检查 `eval.py`、`PI_PY`,以及 `python`/`python3` 是否在 PATH 上。如果启用了另一个后端,使用它宣传的语言 token。
- **PATH 上没有 Python** — 安装系统 Python 3.10+,或将兼容 venv 放在 `~/.omp/python-env`。`omp setup python --check` 报告解析出的解释器。
- **执行挂起然后超时** — 为合法工作增加 `timeout`,或设置为 `0` 禁用看门狗。对于卡住的原生代码,取消先发送 `SIGINT` 然后升级;会话模式在必须被杀时会在下一次请求时重新创建内核。
- **Python 代码中的 stdin/input 提示** — 不支持 `input()`;以编程方式传递数据。
- **工作目录错误** — Python 在会话 cwd 中运行。在保留内核内使用 `%cd` 或 `os.chdir()` 更改它。

## 相关环境变量

- `PI_PY` / `PI_JS` / `PI_RB` / `PI_JL` — 每后端的暴露覆盖
- `PI_PYTHON_SKIP_CHECK=1` — 绕过 Python 预检/预热检查
- `PI_PYTHON_INTEGRATION=1` — 启用派生真实 Python 的门控集成测试
- `PI_PYTHON_IPC_TRACE=1` — 记录与 runner 子进程交换的 NDJSON 帧
