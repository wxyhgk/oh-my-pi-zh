# debug

> 驱动一个 DAP 调试会话;相邻的调试 UI 代码复用同一子系统,用于日志、原始 SSE 捕获、报告、性能剖析与系统诊断。

## 源码
- 入口:`packages/coding-agent/src/tools/debug.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/debug.md`
- 主要协作模块:
  - `packages/coding-agent/src/dap/session.ts` — 会话生命周期、断点/状态缓存
  - `packages/coding-agent/src/dap/client.ts` — 适配器进程/套接字传输、DAP 消息循环
  - `packages/coding-agent/src/dap/config.ts` — 适配器解析与自动选择
  - `packages/coding-agent/src/dap/defaults.json` — 内置适配器定义
  - `packages/coding-agent/src/dap/types.ts` — 请求/响应/能力数据结构
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 各工具的超时钳制
  - `packages/coding-agent/src/debug/index.ts` — 交互式调试选择器菜单
  - `packages/coding-agent/src/debug/log-viewer.ts` — 最近日志 TUI 查看器
  - `packages/coding-agent/src/debug/raw-sse.ts` — 原始 SSE TUI 查看器
  - `packages/coding-agent/src/debug/raw-sse-buffer.ts` — 有界 SSE 捕获缓冲区
  - `packages/coding-agent/src/debug/remote-debugger.ts` — 一次性 JavaScriptCore 远程检查器套接字
  - `packages/coding-agent/src/debug/profiler.ts` — CPU/堆性能剖析辅助函数
  - `packages/coding-agent/src/debug/report-bundle.ts` — `.tar.gz` 报告打包、日志源、缓存清理
  - `packages/coding-agent/src/debug/system-info.ts` — 系统快照收集与环境变量脱敏
  - `packages/coding-agent/src/debug/terminal-info.ts` — 终端状态收集/格式化
  - `packages/coding-agent/src/debug/protocol-probe.ts` — 终端协议探测面板与示例图像

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | `"launch" \| "attach" \| "set_breakpoint" \| "remove_breakpoint" \| "set_instruction_breakpoint" \| "remove_instruction_breakpoint" \| "data_breakpoint_info" \| "set_data_breakpoint" \| "remove_data_breakpoint" \| "continue" \| "step_over" \| "step_in" \| "step_out" \| "pause" \| "evaluate" \| "stack_trace" \| "threads" \| "scopes" \| "variables" \| "disassemble" \| "read_memory" \| "write_memory" \| "modules" \| "loaded_sources" \| "custom_request" \| "output" \| "terminate" \| "sessions"` | 是 | `packages/coding-agent/src/tools/debug.ts` 中工具 switch 的分发键。 |
| `program` | `string` | 否 | 启动目标路径。`launch` 必填。若提供了 `cwd`,则相对于 `cwd` 解析,否则相对于会话工作目录。 |
| `args` | `string[]` | 否 | `launch` 的程序 argv。 |
| `adapter` | `string` | 否 | 显式适配器名称。否则由 `packages/coding-agent/src/dap/config.ts` 中的 `selectLaunchAdapter()` / `selectAttachAdapter()` 自动选择。 |
| `cwd` | `string` | 否 | launch/attach 时的工作目录。默认为会话工作目录。 |
| `file` | `string` | 否 | 源断点的源文件路径。 |
| `line` | `number` | 否 | 源断点的源文件行号。 |
| `function` | `string` | 否 | 函数断点名称。提供时,断点操作采用函数路径并忽略 `file`/`line`;schema 不拒绝同时给出两种形式。 |
| `name` | `string` | 否 | 数据断点信息的目标名称。`data_breakpoint_info` 必填。 |
| `condition` | `string` | 否 | 源/函数/指令/数据断点的条件表达式。 |
| `hit_condition` | `string` | 否 | 指令/数据断点的命中次数条件。 |
| `expression` | `string` | 否 | 表达式或原始调试器命令。`evaluate` 必填。 |
| `context` | `string` | 否 | 求值上下文。默认为 `"repl"`,原样作为 DAP evaluate 上下文传递。 |
| `frame_id` | `number` | 否 | `evaluate`、`scopes`、`data_breakpoint_info` 的帧选择器。省略时,`scopes` 与 `evaluate` 默认使用当前停止的帧。 |
| `scope_id` | `number` | 否 | 来自作用域的变量引用。`variables` 接受该值;也用作 `data_breakpoint_info` 的回退变量引用。 |
| `variable_ref` | `number` | 否 | `variables` 的变量引用;两者同时存在时优先于 `scope_id`。 |
| `pid` | `number` | 否 | `attach` 的本地进程 id。`attach` 需要 `pid` 或 `port`。 |
| `port` | `number` | 否 | 远程附加端口。若未强制指定适配器,提供 `port` 时 attach 优先使用 `debugpy`。 |
| `host` | `string` | 否 | `attach` 的远程附加主机。 |
| `levels` | `number` | 否 | `stack_trace` 的最大栈帧数。 |
| `memory_reference` | `string` | 否 | `disassemble`、`read_memory`、`write_memory` 的内存引用/地址。提供时 `disassemble` 使用该值;否则在适配器提供了当前停止位置的指令指针引用时回退到它。 |
| `instruction_reference` | `string` | 否 | 指令断点引用;指令断点操作必填。`disassemble` 不使用。 |
| `instruction_count` | `number` | 否 | `disassemble` 必填。 |
| `instruction_offset` | `number` | 否 | `disassemble` 的指令偏移量。 |
| `count` | `number` | 否 | `read_memory` 的字节数。该操作必填。 |
| `data` | `string` | 否 | `write_memory` 的 Base64 数据。该操作必填。 |
| `data_id` | `string` | 否 | 数据断点 id。`set_data_breakpoint` / `remove_data_breakpoint` 必填。 |
| `access_type` | `"read" \| "write" \| "readWrite"` | 否 | `set_data_breakpoint` 的访问筛选。 |
| `command` | `string` | 否 | 自定义 DAP 请求命令。`custom_request` 必填。 |
| `arguments` | `Record<string, unknown>` | 否 | `custom_request` 的自定义 DAP 请求体。 |
| `offset` | `number` | 否 | 指令断点、反汇编、内存读取、内存写入的偏移量。 |
| `resolve_symbols` | `boolean` | 否 | `disassemble` 的符号解析标志。 |
| `allow_partial` | `boolean` | 否 | `write_memory` 的部分写入许可。 |
| `start_module` | `number` | 否 | `modules` 的模块分页起始索引。 |
| `module_count` | `number` | 否 | `modules` 的模块分页数量。 |
| `timeout` | `number` | 否 | 每次请求的秒数,默认 `30`;`clampTimeout("debug", ...)` 先应用正数 `tools.maxTimeout` 上限,再应用该工具的 `5..300` 范围(因此 5 秒下限仍优先于更低的全局上限)。 |

### 各操作的特定要求
- `launch`: `program`
- `attach`: `pid` or `port`
- `set_breakpoint` / `remove_breakpoint`: `function`, or `file` + `line`
- `set_instruction_breakpoint` / `remove_instruction_breakpoint`: `instruction_reference`
- `data_breakpoint_info`: `name`
- `set_data_breakpoint` / `remove_data_breakpoint`: `data_id`
- `evaluate`: `expression`
- `variables`: `variable_ref` or `scope_id`
- `disassemble`:需要能力 `supportsDisassembleRequest`,外加 `instruction_count`,以及 `memory_reference`,或带有 `instructionPointerReference` 的当前停止位置
- `read_memory`:需要能力 `supportsReadMemoryRequest`,外加 `memory_reference` 与 `count`
- `write_memory`:需要能力 `supportsWriteMemoryRequest`,外加 `memory_reference` 与 `data`
- `modules`:需要能力 `supportsModulesRequest`
- `loaded_sources`:需要能力 `supportsLoadedSourcesRequest`
- `custom_request`: `command`

### 交互式选择器取值
`packages/coding-agent/src/debug/index.ts` 还暴露了一个仅用于 UI 的固定选择器,取值为 `open-artifacts`、`performance`、`work`、`dump`、`memory`、`logs`、`system`、`terminal`、`protocols`、`raw-sse`、`remote-debugger`、`transcript`、`clear-cache`。这些值不能通过 `debugSchema` 由模型调用;它们是本地 TUI 菜单路由。

## 输出
该代理工具从 `packages/coding-agent/src/tools/debug.ts` 返回标准的 `toolResult()` 载荷:
- `content`:一个文本块。每个操作都渲染为人类可读文本;`content` 中没有结构化 JSON 块。
- `details.action`:回显的操作。
- `details.success`:始终初始化为 `true`;失败会在返回结果之前通过抛出异常来呈现。
- `details.snapshot`:对于操作或创建会话的操作存在,使用 `packages/coding-agent/src/dap/types.ts` 中的 `DapSessionSummary`。
- 各操作专属的 `details` 字段:
  - `launch` / `attach`: `adapter`
  - 断点操作: `breakpoints`、`functionBreakpoints`、`instructionBreakpoints`、`dataBreakpoints`
  - `data_breakpoint_info`: `dataBreakpointInfo`
  - `continue` / `step_*`: `state`, `timedOut`
  - `threads`: `threads`
  - `stack_trace`: `stackFrames`
  - `scopes`: `scopes`
  - `variables`: `variables`
  - `evaluate`: `evaluation`
  - `disassemble`: `disassembly`
  - `read_memory`: `memoryAddress`, `memoryData`, `unreadableBytes`
  - `write_memory`: `bytesWritten`
  - `modules`: `modules`
  - `loaded_sources`: `sources`
  - `custom_request`: `customBody`
  - `output`: `output`
  - `sessions`: `sessions`

流式/UI 行为:
- 可发现工具的渲染器合并调用与结果(`mergeCallAndResult: true`),内联渲染,并在参数/结果仍在组装过程中启用动画化的部分结果展示。
- `debug.ts` 本身不通过 `_onUpdate` 发出进度更新;执行结果一次性交付。
- 批准与操作类型相关:只读操作(`output`、`threads`、`stack_trace`、`scopes`、`variables`、`disassemble`、`read_memory`、`loaded_sources`、`modules`、`sessions`)请求读取批准;其余所有操作请求执行批准。
- 交互式选择器由 UI 驱动而非模型驱动。它会替换 TUI 组件、向聊天面板追加状态行、在外部查看器中打开文件、写入归档/临时文件,或启动进程级 JavaScriptCore 检查器套接字。

模型工具结果之外的旁路产物:
- `createReportBundle()` 在报告目录下写入 `omp-report-<timestamp>.tar.gz`,并将文件系统路径返回给 UI 处理器。
- `#handleWorkReport()` 在打开 `/tmp/work-profile-<Date.now()>.svg` 之前先写入它。
- `RawSseViewerComponent` 与 `DebugLogViewerComponent` 可以将捕获的文本复制到剪贴板。

## 流程

1. 工具注册是有条件的:`packages/coding-agent/src/tools/debug.ts` 中的 `DebugTool.createIf()` 在 `session.settings.get("debug.enabled")` 为 true(默认 `true`)时返回实例,否则返回 `null`。`packages/coding-agent/src/tools/index.ts` 接入该工厂,并在工具筛选中重新检查同一设置。
2. `DebugTool.execute()` 通过 `clampTimeout("debug", params.timeout)` 钳制 `params.timeout`:先应用可选的 `tools.maxTimeout` 正数上限,再应用该工具的 5 秒下限与 300 秒上限,并将调用方的 `AbortSignal` 与 `AbortSignal.timeout(...)` 组合。
3. `launch` 解析 cwd/program 路径,将目标分类为文件/目录/不存在,除非所选适配器设置了 `acceptsDirectoryProgram`,否则拒绝目录,并委托给 `dapSessionManager.launch()`。`attach` 需要 `pid` 或 `port`,解析 cwd,选择适配器,并委托给 `.attach()`。
4. `DapSessionManager.launch()` / `.attach()` 强制唯一根会话,通过 `DapClient.spawn()` 启动适配器,注册监听器,发送 `initialize`,缓存能力,订阅整棵会话树的停止事件,发送 `launch`/`attach`,然后完成 `initialized` → `configurationDone` 握手。
5. `DapClient.spawn()` 以 `NON_INTERACTIVE_ENV` 分离方式启动适配器。`stdio` 使用适配器管道;`socket` 在 Linux 上使用 Unix 套接字,在其他平台上使用适配器回调连接本地 TCP 监听器;`tcp` 在适配器参数中替换 `${port}`,启动本地服务器,然后连接。子会话通过 `DapClient.connect()` 复用根 `tcp` 服务器。
6. `packages/coding-agent/src/dap/session.ts` 中的 `#registerSession()` 安装反向请求处理器:
   - `runInTerminal`:通过 `ptree.spawn()` 以分离方式启动所请求的被调试程序命令,并返回 `{ processId }`
   - `startDebugging`:将子 DAP 客户端连接到根 TCP 服务器,转发所请求的 `launch`/`attach` 配置,在 `configurationDone` 之前绑定根断点,并递归安装相同的处理器
   - 事件:`output`、`initialized`、`stopped`、`continued`、`exited` 与 `terminated` 更新缓存的会话状态;停止的子会话成为活动目标
7. 操作性操作(`set_breakpoint`、`evaluate`、`threads`、`read_memory`、`custom_request` 等)调用 `dapSessionManager` 的方法。大多数经 `#sendRequestWithConfig()` 流转:需要时先发送 `configurationDone`,然后发送 DAP 请求并刷新活动会话及其祖先。
8. 断点操作会在存活的根/子会话树中同步所需的断点集合。新子会话在发送 `configurationDone` 请求之前收到这些集合。
9. `continue` 与三个 step 操作会清除缓存的停止状态,在发送 DAP 请求之前订阅会话树中任意位置的停止/终止事件,然后由 `#awaitStopOutcome()` 返回活动子会话的停止位置,或报告目标在超时后仍在运行。
10. `pause` 发送 DAP `pause`,必要时等待停止事件;若程序已处于停止状态,则复用缓存的停止状态。
11. 当调用方省略 id 且缓存状态可用时,`stack_trace`、`scopes`、`variables` 与 `evaluate` 默认使用当前停止的子会话/线程/帧。
12. `output` 从活动 `DapSession` 读取内存中的输出环形缓冲区。`terminate` 从根遍历到每个子会话,尽力发送 `terminate`/`disconnect`,即使适配器超时也会销毁整棵会话树。
13. `sessions` 读取管理器的当前映射,并格式化根与子会话摘要。只能存在一棵根会话树;适配器请求的递归子会话通过 `parentSessionId` / `childSessionIds` 跟踪。
14. `packages/coding-agent/src/debug/index.ts` 中的交互式选择器构建固定取值的 `SelectList`,并将每个取值分派给对应的处理器:
   - `performance`:调用 `startCpuProfile()`,等待 Enter/Escape,停止剖析,用 `getWorkProfile(30)` 读取 30 秒的工作剖析数据,然后通过 `createReportBundle()` 打包
   - `work`:读取 `getWorkProfile(30)`,写入临时 SVG,并在外部打开
   - `dump`:立即创建报告包
   - `memory`:强制 GC,调用 `Bun.generateHeapSnapshot("v8")`,然后打包
   - `logs`:构建 `DebugLogSource` 并挂载 `DebugLogViewerComponent`
   - `raw-sse`:从会话解析 `RawSseDebugBuffer` 并挂载 `RawSseViewerComponent`
   - `remote-debugger`:复用或启动回环 JavaScriptCore `RemoteInspectorServer` 套接字,并显示其主机/端口;Bun API 是进程级的,没有停止操作
   - `system`:调用 `collectSystemInfo()`,并将 `formatSystemInfo()` 渲染到聊天面板
   - `terminal`:将 `collectTerminalState()` + `formatTerminalState()` 渲染到聊天面板
   - `protocols`:触发一条测试桌面通知(除非被抑制),然后挂载带示例图像的 `ProtocolProbeComponent`
   - `open-artifacts`:若存在则打开当前会话的产物目录
   - `transcript`:委托给 `ctx.handleDebugTranscriptCommand()`
   - `clear-cache`:显示确认提示,然后用 `clearArtifactCache()` 移除超过 30 天的产物目录

## 模式 / 变体
- **可用性门控**
  - 当 `debug.enabled` 为 false 时隐藏该工具;该设置默认为 `true`。工具使用可发现加载与独占并发。
- **适配器选择**
  - 内置适配器 id 为 `gdb`、`lldb-dap`、`codelldb`、`debugpy`、`dlv`、`js-debug-adapter`、`netcoredbg`、`kotlin-debug-adapter`、`rdbg`、`php-debug-adapter`、`bash-debug-adapter`、`dart-debug-adapter`、`flutter-debug-adapter` 与 `elixir-ls-debugger`。自动选择只考虑已配置命令可解析的适配器;显式选择已配置但不可用的适配器会产生适配器专属的安装/配置错误。
  - `launch`:显式 `adapter` 优先;否则 `selectLaunchAdapter()` 按扩展名匹配、根标记匹配排序可用适配器,对无扩展名的二进制再按原生调试器偏好(`gdb`、`lldb-dap`)排序。
  - `attach`:显式 `adapter` 优先;否则远程 `port` 优先选择 `debugpy`,然后是原生调试器,最后是第一个可用适配器。
- **自定义适配器配置**
  - 调试适配器可通过 `dap.json`、`.dap.json`、`dap.yaml`、`.dap.yaml`、`dap.yml` 或 `.dap.yml` 添加或覆盖。
  - 搜索顺序与 LSP 配置一致:项目根、项目配置目录(`.omp/`、`.claude/`、`.codex/`、`.gemini/`)、用户配置目录(`~/.omp/agent/`、`~/.claude/`、`~/.codex/`、`~/.gemini/`)、插件根,然后是家目录根回退。文件按从低到高的优先级合并。
  - 配置结构可以是 `{ "adapters": { ... } }` 或顶层适配器映射。
  - 适配器字段:
    - `command`:可执行文件名称或路径。必填。
    - `args`:适配器 argv。
    - `languages`:显示/筛选元数据。
    - `fileTypes`:用于启动自动选择的小写文件扩展名。
    - `rootMarkers`:用于为项目排序适配器的文件/目录。
    - `launchDefaults`:在所选的 program/cwd/args 之前合并的默认 DAP launch 参数。
    - `attachDefaults`:在 pid/port/host/cwd 之前合并的默认 DAP attach 参数。
    - `connectMode`:`"stdio"`(默认)、`"socket"`(Delve 风格、依赖平台的套接字/回调)或 `"tcp"`(启动本地 DAP 服务器,并在 `args` 中替换 `${port}`)。
    - `acceptsDirectoryProgram`:为 `dlv` 等可以启动包/项目目录的适配器设为 `true`。

示例 `.omp/dap.json`:

```json
{
  "adapters": {
    "custom-jvm": {
      "command": "kotlin-debug-adapter",
      "args": ["--stdio"],
      "languages": ["java", "kotlin"],
      "fileTypes": [".java", ".kt", ".kts"],
      "rootMarkers": ["pom.xml", "build.gradle", "build.gradle.kts"],
      "launchDefaults": {
        "request": "launch",
        "projectRoot": "."
      },
      "attachDefaults": {
        "request": "attach",
        "host": "127.0.0.1"
      }
    }
  }
}
```
- **传输**
  - `stdio`:直接对适配器 `stdin`/`stdout` 进行帧封装。
  - `socket`:Linux 上为 Unix 域套接字;macOS/其他平台为适配器回调连接本地 TCP 监听器。
  - `tcp`:预留一个回环端口,将其替换到适配器参数中的 `${port}`,等待适配器开始监听,然后连接。解析出的 JavaScript/TypeScript 适配器使用该模式,递归 `startDebugging` 子会话也必需。
- **DAP 代理工具操作**
  - `launch` — 启动适配器、初始化会话、可能入口处停止;返回格式化后的会话快照与 `details.adapter`。
  - `attach` — 连接活动进程或远程端口;输出结构与 `launch` 相同。
  - `set_breakpoint` — 添加/更新源断点或函数断点;返回该目标的当前断点列表。
  - `remove_breakpoint` — 移除源断点或函数断点;返回剩余断点列表。
  - `set_instruction_breakpoint` / `remove_instruction_breakpoint` — 需要 `supportsInstructionBreakpoints`;返回当前指令断点列表。
  - `data_breakpoint_info` — 需要 `supportsDataBreakpoints`;向适配器询问 `name` 的 `dataId`、访问类型与描述。
  - `set_data_breakpoint` / `remove_data_breakpoint` — 需要 `supportsDataBreakpoints`;返回缓存的数据断点列表。
  - `continue` / `step_over` / `step_in` / `step_out` — 返回描述执行已停止、已终止或仍在运行的文本,以及 `details.state` 和 `details.timedOut`。
  - `pause` — 中断正在运行的目标,返回停止后的快照。
  - `evaluate` — 适配器表达式求值;上下文默认为 `repl`。
  - `stack_trace` — 获取已解析线程的帧。
  - `threads` — 获取当前线程。
  - `scopes` — 显式 `frame_id` 或当前停止帧的帧作用域。
  - `variables` — `variable_ref` 或 `scope_id` 的变量。
  - `disassemble` — 需要 `supportsDisassembleRequest`;围绕 `memory_reference` 反汇编;未提供内存引用时围绕当前停止位置的指令指针反汇编。
  - `read_memory` — 需要 `supportsReadMemoryRequest`;返回地址、base64 数据与不可读字节数。
  - `write_memory` — 需要 `supportsWriteMemoryRequest`;写入 base64 数据并报告已写入字节数。
  - `modules` — 需要 `supportsModulesRequest`;可通过 `start_module` / `module_count` 分页。
  - `loaded_sources` — 需要 `supportsLoadedSourcesRequest`;返回已加载的源描述符。
  - `custom_request` — 发送任意 DAP 请求名称及任意参数。
  - `output` — 从会话缓存转储捕获的 stdout/stderr/console 文本。
  - `terminate` — 断开并销毁活动会话;无会话时返回 `No debug session to terminate.`。
  - `sessions` — 列出所有缓存的会话摘要。
- **交互式选择器路由(仅 UI)**
  - `logs` — 将今天的日志尾部及可选的更早每日日志文件加载到 `DebugLogViewerComponent`;支持复制、范围选择、pid 筛选、加载更早日志。
  - `raw-sse` — 基于会话 `RawSseDebugBuffer` 的实时视图;支持尾部跟随、滚动、全部复制。
  - `remote-debugger` — 在 `127.0.0.1` 与自动预留的端口上启动或复用进程级 JavaScriptCore WebKit 检查器;该功能是实验性的,无法停止/重新绑定,需要兼容的 Safari/WebKit 检查器客户端。
  - `performance` — CPU 剖析 + 30 秒工作剖析 + 报告包。
  - `memory` — 堆快照 + 报告包。
  - `dump` — 不含剖析器产物的报告包。
  - `work` — 独立的工作剖析火焰图导出/打开。
  - `system` — 格式化后的 OS/架构/CPU/内存/版本/cwd/shell/终端转储。
  - `terminal` — 格式化后的终端子协议/几何/回滚状态转储。
  - `protocols` — 终端协议测试:桌面通知副作用,外加采样特殊协议的探测面板。
  - `open-artifacts` / `transcript` / `clear-cache` — 打开产物目录、导出对话记录、清理产物缓存。

## 副作用
- 文件系统
  - 相对于会话 cwd 解析 program/file/cwd 路径。
  - 创建报告会写入 `.tar.gz` 包,并可能读取会话 JSONL、产物文件、子代理会话 JSONL 与日志文件。
  - 工作剖析导出写入 `/tmp/work-profile-<timestamp>.svg`。
  - 日志源从日志目录读取每日日志文件。
  - 产物缓存清理移除超过截止时间的会话产物目录。
  - `resolveRawSseDebugBuffer()` 在所有者存在显式 `rawSseDebugBuffer` 属性时复用该属性,否则在私有 `Symbol("debug.rawSseBuffer")` 键下缓存缓冲区(当所有者不可扩展时静默跳过)。
- 网络
  - socket/TCP 模式适配器绑定或连接本地套接字;远程 attach 可能通过适配器连接到远程调试端口。
  - 仅 UI 的 `remote-debugger` 路由在随机预留的 `127.0.0.1` TCP 端口上打开进程级 JavaScriptCore 检查器。它会探测套接字就绪状态,且没有停止操作。
- 子进程 / 原生绑定
  - 以分离方式启动调试器适配器(`gdb`、`lldb-dap`、`python -m debugpy.adapter`、`dlv` 及 `defaults.json` 中的其他适配器)。
  - 反向 DAP `runInTerminal` 请求通过 `ptree.spawn()` 以分离方式启动被调试程序。
  - `getWorkProfile(30)` 来自 `@oh-my-pi/pi-natives`。
  - CPU 剖析使用 `node:inspector/promises`;堆快照使用 `Bun.generateHeapSnapshot("v8")`;原始/日志查看器通过 `@oh-my-pi/pi-utils` 的 `sanitizeText()` 清理文本。
  - `openPath()` 为产物目录和 SVG 启动操作系统默认的文件/浏览器处理器。
  - 日志/原始 SSE 查看器可以调用 `copyToClipboard()`。
- 会话状态(对话记录、内存、任务、检查点、注册表)
  - `DapSessionManager` 在内存中维护会话摘要、断点、线程、栈帧、停止位置、输出捕获、能力与最后使用时间戳。
  - 活动会话 id 对单例 `dapSessionManager` 是全局的。
  - `RawSseDebugBuffer` 按所有者/会话存储最近的 SSE 事件。
  - `remote-debugger.ts` 缓存存活的检查器端点并合并并发启动;底层 Bun 检查器对进程是单向的。
  - 该工具是 `exclusive`(独占)的;并发的调试工具调用会被调度器阻止。
- 用户可见的提示 / 交互式 UI
  - 调试选择器在删除缓存前显示确认提示。
  - 性能剖析会临时接管编辑器的 Enter/Escape 处理器,直到剖析停止。
  - 日志/原始 SSE 查看器用自定义组件替换编辑器面板。
- 后台工作 / 取消
  - 每个 DAP 请求都接受 `AbortSignal`;超时与调用方取消会中止当前请求,而不是整个会话的生命周期。
  - `DapSessionManager` 每 30 秒运行一次后台清理循环。
  - 原始 SSE 查看器订阅缓冲区更新,直到关闭。

## 限制与上限
- 工具超时钳制:`packages/coding-agent/src/tools/tool-timeouts.ts` 中 `default=30`、`min=5`、`max=300`。
- 每次请求的 DAP 默认超时:`packages/coding-agent/src/dap/client.ts` 中 `DEFAULT_REQUEST_TIMEOUT_MS = 30_000`。
- 单一活动会话:由 `packages/coding-agent/src/dap/session.ts` 中的 `#ensureLaunchSlot()` 强制。
- 空闲会话清理:`IDLE_TIMEOUT_MS = 10 * 60 * 1000`,每 `CLEANUP_INTERVAL_MS = 30 * 1000` 检查一次。
- 适配器存活心跳:`HEARTBEAT_INTERVAL_MS = 5 * 1000`。
- 输出捕获上限:`MAX_OUTPUT_BYTES = 128 * 1024`;整块数据从开头丢弃(随后对最前块按字节切片,使剩余恰好为上限),并记录 `outputTruncated`。
- launch/attach 后初始停止捕获超时:`STOP_CAPTURE_TIMEOUT_MS = 5_000`。
- socket 模式适配器就绪超时:`packages/coding-agent/src/dap/client.ts` 中 `waitForCondition()` 与 TCP 连接超时逻辑的 `10_000` 毫秒。
- `packages/coding-agent/src/debug/raw-sse-buffer.ts` 中的原始 SSE 缓冲区上限:
  - `MAX_RAW_SSE_EVENTS = 1_000`
  - `MAX_RAW_SSE_CHARS = 512_000`
  - `MAX_RAW_SSE_EVENT_CHARS = 64_000`(每个事件);超预算事件先压缩 `tools` schema(保留名称,省略 schema/描述),然后进行头尾修剪:保留首尾部分,中间用 `: omp-debug-elided chars=...` 注释,末尾加上 `: omp-debug-truncated originalChars=...` 标记
- `packages/coding-agent/src/debug/log-viewer.ts` 中的日志查看器窗口:
  - `INITIAL_LOG_CHUNK = 50`
  - `LOAD_OLDER_CHUNK = 50`
- `packages/coding-agent/src/debug/report-bundle.ts` 中的报告/日志摄取上限:
  - `MAX_LOG_LINES = 5000`(交互式日志读取)
  - `MAX_LOG_BYTES = 2 * 1024 * 1024`(尾部读取上限)
  - 报告包只包含最后 `1000` 行日志
  - 子代理会话最多包含最近的 `10` 个 JSONL 文件
- `packages/coding-agent/src/debug/index.ts` 中的交互式剖析窗口:performance 与 work 报告都请求 `getWorkProfile(30)`。
- 产物缓存清理默认:`clearArtifactCache()` 与选择器确认文本中的 `30` 天。

## 错误
- `packages/coding-agent/src/tools/debug.ts` 中的参数校验会抛出带明确消息的 `ToolError`,例如:
  - `program is required for launch`
  - `attach requires pid or port`
  - `set_breakpoint requires file+line or function`
  - `variables requires variable_ref or scope_id`
  - `instruction_count is required for disassemble`
  - `disassemble requires memory_reference unless the current stop location has an instruction pointer reference`
  - `memory_reference is required for read_memory`
  - `count is required for read_memory`
  - `data is required for write_memory`
  - 当所选适配器未设置 `acceptsDirectoryProgram` 时:`launch program resolves to a directory: <path>...`
  - `command is required for custom_request`
- 适配器选择失败抛出 `No debugger adapter available. Installed adapters: ...`。
- 能力门控操作从 `requireCapability(...)` 抛出,例如 `Current adapter does not support memory reads`。
- 无会话与状态错误来自 `DapSessionManager`,例如 `No active debug session. Launch or attach first.`、`No active stack frame. Run stack_trace first or supply frame_id.`、`Debugger reported no threads.`
- 启动第二个存活会话抛出 `Debug session <id> is still active. Terminate it before launching another.`
- DAP 传输/请求失败以 `DapClient` 抛出的错误呈现:
  - `DAP request <command> timed out after <ms>ms`
  - `DAP event <event> timed out after <ms>ms`
  - `DAP adapter <name> is not running`
  - `DAP adapter exited (code N): <stderr>` 或 `DAP adapter exited unexpectedly (code N)`
  - DAP 请求失败时的适配器响应 `message`
- 当目标超过超时仍在运行时,`continue` / `step_*` 有意不视为致命错误:它们返回 `details.timedOut = true` 和 `state: "running"`,而不是抛出异常。
- `terminate` 在发送 `terminate`/`disconnect` 时抑制适配器错误;它仍然销毁客户端,并在可能时返回最后一个摘要。
- 交互式选择器处理器报告 UI 错误而非抛出异常:
  - 剖析器启动/停止、报告打包、日志读取、系统信息收集、缓存清理、产物打开与远程检查器启动使用 `ctx.showError(...)` / `ctx.showWarning(...)`
  - 空日志与空产物缓存是警告/状态消息,不是失败
  - 日志/原始 SSE 查看器中的复制失败会变成 UI 中的状态/错误文本
- 报告打包辅助函数对许多文件读取有意采用尽力而为:缺失的会话文件、缺失的产物目录、不可读的产物文件、缺失的日志目录、不可访问的缓存目录与缺失的子代理文件都会被静默跳过。
- `collectSystemInfo()` 对 CPU 探测采用尽力而为;该处失败回退到 `Unknown CPU`。
- 远程检查器启动拒绝已被占用的端口,若所选回环套接字未在其探测期限内变为可达则失败。UI 将其报告为 `Failed to start remote debugger: ...`。

## 备注
- `packages/coding-agent/src/prompts/tools/debug.md` 告知模型只支持一个活动的根会话。适配器请求的子会话属于该根会话树。
- 默认的 JavaScript/TypeScript 适配器通过 TCP 运行 vscode-js-debug 的 `dapDebugServer.js`。用 Mason 安装它,或将 `JS_DEBUG_DAP_SERVER` 设置为发布压缩包中的服务器路径。
- `configurationDone` 在根/子会话的 launch/attach 握手中自动发送;若初始握手未完成,则在后续请求前惰性发送。
- `startDebugging` 反向请求在同一 TCP 服务器上创建递归子会话;停止的子会话成为线程级操作的目标。
- `output` 只暴露活动会话合并后的 `output` 事件流;该工具不区分 stdout、stderr 与 console 类别。
- 会话摘要暴露 `needsConfigurationDone`、`parentSessionId` 与 `childSessionIds`。
- 源断点文件路径在缓存与跨会话树同步之前用 `path.resolve()` 规范化。
- `evaluate` 默认为 `repl`,因此当适配器支持时,该工具可以转发原始调试器命令。
- `disassemble` 先通过 `memory_reference` 解析目标,再使用当前停止会话的 `instructionPointerReference`;两者都不存在时抛出异常。
- `RawSseDebugBuffer.recordEvent()` 在有界保留之前递增 `totalEvents`。因此快照显示的保留记录数可能少于观察到的总事件数。
- 原始 SSE 缓冲区监听器失败会被吞掉,以免查看器缺陷破坏捕获。
- `createDebugLogSource()` 从新到旧遍历每日日志文件,但 `loadOlderLogs()` 在拼接前反转每个请求的片段,使更早的块按时间顺序前置。
- `clearArtifactCache()` 按目录 mtime 删除目录,而非按单个文件的年龄。
- `addDirectoryToArchive()` 用 `Bun.file(...).text()` 以文本方式读取产物文件。二进制产物内容不会在报告包中逐字节保留。
- 工具渲染器会为 TUI 预览截断显示的输出,但底层文本结果仍包含完整返回字符串。
- 仅 UI 的 JavaScriptCore 远程调试器在启动后是幂等的,并且无法停止,因为 `bun:jsc` 不返回句柄。它只绑定到 `127.0.0.1`;通过回环就绪探测判断是否成功,因为在 macOS 上即使套接字已启动,Bun 也可能抛出虚假的绑定错误。
