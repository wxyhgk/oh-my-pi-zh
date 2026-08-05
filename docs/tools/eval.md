# eval

> 在持久化的语言运行时中执行一个 Python、JavaScript、Ruby 或 Julia 单元格。一次工具调用即一个单元格;状态在后续调用中保留。

> **注意:** 请勿通过 `bash` 调用 `python -c`、`ruby -e`、`julia -e`、`bun -e` 或 `node -e` 执行临时代码。`eval` 提供保留状态、结构化 `display()` 捕获、工具/子代理桥接、流式输出、取消以及产物支撑的截断。

## 来源
- 入口与动态 schema:`packages/coding-agent/src/tools/eval.ts`
- 后端启用:`packages/coding-agent/src/tools/eval-backends.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/eval.md`
- 共享契约:`packages/coding-agent/src/eval/backend.ts`、`types.ts`、`executor-base.ts`、`kernel-base.ts`
- 宿主桥接:`packages/coding-agent/src/eval/agent-bridge.ts`、`completion-bridge.ts`、`concurrency-bridge.ts`、`budget-bridge.ts`
- JavaScript:`packages/coding-agent/src/eval/js/`
- Python:`packages/coding-agent/src/eval/py/`
- Ruby:`packages/coding-agent/src/eval/rb/`
- Julia:`packages/coding-agent/src/eval/jl/`
- 输出/截断:`packages/coding-agent/src/session/streaming-output.ts`
- Python 内部细节:`docs/python-repl.md`

## 输入

params 对象就是一个单元格。不存在 `cells` 数组、头部解析器、语言嗅探或隐式回退。请将增量步骤拆分为独立的工具调用;每种语言各自保留自己的状态。

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `language` | `"py" \| "js" \| "rb" \| "jl"` | 是 | 显式的后端标识。正常情况下实时 schema 仅包含已启用的运行时;参见下方“全部禁用”的边界情况。 |
| `code` | `string` | 是 | 单元格内容,原样执行。 |
| `title` | `string` | 否 | 简短的会话记录标签。 |
| `timeout` | `number` | 否 | 运行时工作的超时秒数。默认 30;`0` 禁用单元格超时。非零值会被工具超时策略与 `tools.maxTimeout` 钳制。 |
| `reset` | `boolean` | 否 | 执行前重新创建该语言的保留运行时。其他语言的运行时不受影响。默认 `false`。 |

跨三次调用的示例:

```json
{"language":"py","title":"imports","code":"import json\nfrom pathlib import Path"}
```

```json
{"language":"py","title":"load config","code":"data = json.loads(read('package.json'))\ndisplay(data)"}
```

```json
{"language":"py","title":"reuse state","code":"display(sorted(data['dependencies']))"}
```

## 后端可用性

`resolveEvalBackends(...)` 结合设置与环境变量覆盖:

| 标识 | 运行时 | 设置/默认值 | 环境变量覆盖 | 附加前提条件 |
| --- | --- | --- | --- | --- |
| `py` | 保留的 IPython 风格 Python 内核 | `eval.py=true` | `PI_PY` | 可用的已配置 Python 解释器/内核 |
| `js` | 保留的 Bun worker VM | `eval.js=true` | `PI_JS` | 内置 JS 运行时 |
| `rb` | 保留的 Ruby 内核 | `eval.rb=false` | `PI_RB` | 可用的 `ruby.interpreter` 或自动发现的 Ruby |
| `jl` | 保留的 Julia 内核 | `eval.jl=false` | `PI_JL` | 可用的 `julia.interpreter` 或自动发现的 Julia |

Ruby 与 Julia 为可选启用。当至少一个运行时被启用时,禁用的运行时将从会话级 wire schema 和模型提示词中移除。如果**四个全部**禁用,当前 `parameters` 回退逻辑仍会返回完整的静态联合,尽管每次执行都会被 `resolveBackend(...)` 拒绝;这与源码附近“禁用的后端永远不会到达模型”的注释相矛盾。请求不可用的运行时会抛出 `ToolError`;该工具绝不会用另一种语言替代。

## 输出

`execute()` 返回一个文本内容块及任意图像块。`onUpdate` 在运行期间流式输出当前单元格的输出与详情。

- 文本为 stdout/stderr 加上模型可见的 JSON `display()` 值与图像尺寸说明。
- 仅含图像的成功报告为 `(displayed N image(s); no text output)`;没有可见输出的单元格报告为 `(no output)`。
- 后端非零退出时会追加 `Command exited with code N`,将单元格标记为 `error`,并设置 `details.isError`。
- 取消操作返回已捕获的输出或 `Command aborted`,并置 `details.isError=true`。

`EvalToolDetails`:

- `cells`:单元素 `EvalCellResult[]`,包含 `index`、`title?`、`code`、后端 `language`、`output`、`status`、`durationMs?`、`exitCode?`、`statusEvents?` 与 `hasMarkdown?`。
- `language`:实际使用的后端;`languages`:去重后的后端列表。它们保留了历史的多单元格兼容形态,但当前一次调用只有一个后端。
- `jsonOutputs`:通过结构化 display 捕获的值。
- `images`:图像到达后在实时更新中出现;最终图像以内容块呈现。
- `statusEvents`:去重后的辅助函数/工具状态事件。
- `notice`:可选的后端提示。
- `meta`:由 `toolResult(...)` 提供的输出截断/产物元数据。
- `isError`:在后端失败或取消时设置。

渲染器将调用与结果内联合并,按声明的语言进行语法高亮,对 markdown 与 JSON 树做专门渲染,并展示超时/截断元数据。`session.allocateOutputArtifact?.("eval")` 为溢出的输出提供支撑;`meta` 中的 `artifact://...` 可访问完整捕获。

## 执行流程

1. `EvalTool` 根据已启用的语言构建会话专属 schema。它在单个 Agent 会话内为 essential(必需)、strict(严格),`approval="exec"`,且 `concurrency="exclusive"`。
2. `execute()` 将 `py/js/rb/jl` 映射为 `python/js/ruby/julia`,解析可用性,并把单个输入包装进与渲染器兼容的内部单元格列表。
3. 它从 `session.getEvalSessionId?.()` 或 `defaultEvalSessionId(session)` 获取保留的 executor id,分配输出 sink/产物,并通过 `trackEvalExecution?.(...)` 注册本次运行。
4. 超时默认 30 秒。`0` 表示不创建看门狗。否则 `IdleTimeout` 会与工具及会话的中止信号合并。
5. `agent()`、`parallel()` 与 `completion()` 会发出暂停/恢复状态操作:在这些宿主桥接中花费的时间不占用单元格的运行时工作预算。计算、输出、状态辅助函数以及普通的 `tool.*` 调用则会占用。
6. 所选后端会收到 cwd、保留的会话 id、会话文件、内核所有者、重置标志、回调以及取消信号。
7. 输出块流式写入支持产物的 `OutputSink` 与实时尾部。富显示内容被分离到 JSON、图像、markdown 与状态通道。
8. 成功、非零退出与取消会被组装成上述结果形态。即使执行失败,输出 sink 也会被收尾。

## 运行时行为

### JavaScript (`js`)

- 以 `js:${sessionId}` 为键的持久化 worker VM;`reset` 会重建 VM,对同时使用该会话 id 的其他用户具有破坏性。
- 运行于 Bun 之上,暴露宿主全局对象,包括 `Bun`、`Buffer`、`fetch`、`process`、`require`、`createRequire`、`fs` 与 Web Crypto。
- 通过异步包装支持顶层 `await` 与裸 `return`。
- 静态顶层 import 与动态 import 会经由本地模块加载器重写。本地文件系统 import 在单元格之间会做缓存失效处理;裸包名与 scheme/URL import 保持常规缓存身份。
- await 区域可以与共享同一 executor 的其他会话交错执行;同步代码仍会阻塞 worker 的事件循环。

### Python (`py`)

- 保留的内核以 `python:${sessionId}`、规范化后的 cwd 及解释器为键。`python.kernelMode="per-call"` 则会在每次调用时创建并关闭全新内核。
- 运行器使用单一持久的 asyncio 事件循环,因此顶层 `await` 可用;`asyncio.run(...)` 在其中无效。
- MIME 帧支持状态、PNG、JSON、markdown、纯文本以及 HTML 转 markdown。
- 交互式 stdin 会被拒绝,错误信息为 `Kernel requested stdin; interactive input is not supported.`
- 同步块使用带有复制 ContextVars 的默认 executor;Python 字节码仍会在 GIL 上竞争。

### Ruby (`rb`)

- 保留的内核以 `ruby:${sessionId}`、规范化后的 cwd 及解释器为键。
- 单元格在持久的 `TOPLEVEL_BINDING` 中求值;局部变量、方法与常量得以保留。除非是 nil、赋值或定义,末尾的值会像 IRB 一样被显示。
- 富显示支持 OMP MIME 约定与兼容 IRuby 的 MIME 钩子,使用共享的内核显示管线。
- `reset` 会替换保留的 Ruby 内核。

### Julia (`jl`)

- 保留的内核以 `julia:${sessionId}`、规范化后的 cwd 及解释器为键。
- 单元格在持久的 `Main` 中求值;带值的尾部表达式会被显示,除非被语句形式抑制。
- Julia 的显示栈被桥接到相同的 MIME/状态管线。
- `reset` 会替换保留的 Julia 内核。

## 预置辅助函数

所有已启用的运行时都会在语言允许的范围内暴露等价辅助函数:

- `display(value)`、`print(...)`
- `read(path, offset?, limit?)`、`write(path, content)`、`env(...)`、`output(...)`
- `tool.<name>(args)`:发起常规会话工具调用
- `completion(...)`、`agent(...)`、`parallel(...)`、`pipeline(...)`
- `log(message)`、`phase(title)`、`budget`

JS 的文件系统/桥接辅助函数是异步的;Python、Ruby 与 Julia 的辅助函数是同步的。`read()` 将非 `local://` 协议委托给已注册的 read 工具,通过注入的根解析 `local://`,并读取相对 cwd 的普通路径。`write()` 接受普通路径与 `local://` 路径,但拒绝其他协议 URL。

`display()` 按后端捕获 JSON 兼容结构、图像、markdown 或文本。Ruby 与 Julia 还会自动显示符合条件的最终表达式。

### `completion()`

一次无状态、不使用工具的模型单次调用:

- JS:`await completion(prompt, { model?, system?, schema? })`
- Python/Ruby/Julia:关键字形式,含 `model`、`system` 与 `schema`
- `model`:`"smol"`、`"default"` 或 `"slow"` 档位;默认为当前生效/默认档位。
- `schema`:为合成 `respond` 工具准备的 JSON Schema;成功的结构化调用会返回解析后的数据。
- 档位无法解析、凭据缺失、错误/中止停止、空输出以及无效的结构化输出都会在单元格内抛出异常。

### `agent()`

通过 `runStructuredSubagent(...)` 运行一个子代理:

- JS 支持推荐的 `await agent(prompt, { agent?, model?, label?, schema?, schemaMode?, isolated?, apply?, merge?, handle? })` 形式;遗留的位置参数槽位仍然保留实现。
- Python/Ruby/Julia 使用关键字参数(JS 之外为 `schema_mode`)。
- `agent` 默认取自当前的生成策略。`model` 可固定选择器/回退链。`schema` 覆盖 Agent/会话 schema;`schemaMode`/`schema_mode` 选择 `permissive` 或 `strict`。
- `isolated` 请求隔离。`apply` 控制捕获的变更是否被整合;`merge=false` 选择补丁模式,而常规设置控制分支模式。
- `handle=true` 时返回 `{ text, output, handle, id, agent }`、可选的解析后 `data` 以及隔离元数据,而不仅仅是 output/data。
- Eval 子代理是单次的(`keepAlive=false`),完成后即注销/释放,**不共享调用方的 eval executor**(`shareEvalSession=false`)。因此它们的代码变更不会出现在调用方保留的 VM/内核中。
- 生成策略、可发现 Agent 的可用性、`task.maxRecursionDepth` 门槛(默认 `2`;负值禁用上限)、硬性轮次预算、子代理失败、严格 schema 失败以及隔离应用失败都会作为单元格错误强制执行。

`parallel(thunks)` 在有界池中运行零参数可调用对象,并保持输入顺序。`pipeline(items, ...stages)` 将每个阶段作为带屏障的波次应用。池宽度实时读取自 `task.maxConcurrency`;`0` 表示同时处理所有项。失败时传播索引最小的那个。

## 副作用与取消

- 预置辅助函数可以读写文件并调用任意已注册的工具;JS 暴露了支持网络的 `fetch`。
- Python、Ruby 与 Julia 使用基于帧的本地 IPC 通信的保留子进程内核。JavaScript 使用 worker VM。
- 保留的运行时在重置、所有者清理或进程退出之前持续存活。
- 取消在必要时具有破坏性:JS 会终止其 worker;受管内核会中断,并可能升级为关闭。重置同样会破坏共享该后端会话的并发工作。
- 由 Eval 驱动的 `agent()` 可以运行工具与隔离工作区,但其子代理会被释放,而不是保留供中心后续跟进。

## 限制与错误

- 默认超时:30 秒;`0` 禁用。非零超时通过 `clampTimeout("eval", ..., tools.maxTimeout)` 钳制。
- 输出 sink 默认窗口:50 KiB(`DEFAULT_MAX_BYTES`);实时尾部:100 KiB;截断辅助函数上限为 3000 行。
- 包含在模型可见文本中的每个 JSON display 值上限为 8000 字符;完整结构化值仍保留在 `jsonOutputs` 中。
- 会话记录预览默认 10 行。
- Eval 子代理的生成遵循 `task.maxRecursionDepth`(默认 `2`;负值允许无限深度)。辅助函数的扇出使用 `task.maxConcurrency`(默认 32,`0` 表示无限制)。
- 格式错误的参数属于 schema 错误;不可用/禁用的后端与缺失会话属于 `ToolError`。
- 运行时异常会变成带非零退出的后端输出。交互式 stdin 属于错误。输出截断不会使调用失败。
- 已死亡的保留受管内核可被替换,其 executor 会对该次调用重试一次。

## 说明

- 一次调用即一个单元格。利用持久化时请使用独立调用,并只重跑失败的步骤。
- 状态按语言隔离;重置 Python 不会重置 JS、Ruby 或 Julia。
- 当前 schema 标识只有 `py`、`js`、`rb` 与 `jl`;完整语言名只是渲染器/审批的格式化别名,并非 wire 值。
- 原先的多单元格 `cells` 载荷、`*** Cell` 解析器、嗅探回退以及受限的 `eval.lark` 语法均已被移除。
- 父代理与普通任务子代理可以共享继承的 eval executor id;由 eval 自身 `agent()` 创建的子代理明确不共享。
