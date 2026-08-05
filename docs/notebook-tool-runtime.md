# Notebook 文件运行时内部机制

本文档描述 `coding-agent` 中当前的 `.ipynb` 处理及其与内核支撑的 Python 运行时的关系。

关键区别:**notebook 支持是文件转换/编辑,而非 notebook 执行**。`.ipynb` 文件通过 `read` 与编辑流水线暴露为可编辑的带单元格标记文本;没有 notebook 专用工具启动或与 Python 内核通信。

## 实现文件

- [`src/edit/notebook.ts`](../packages/coding-agent/src/edit/notebook.ts)
- [`src/edit/read-file.ts`](../packages/coding-agent/src/edit/read-file.ts)
- [`src/tools/read.ts`](../packages/coding-agent/src/tools/read.ts)
- [`src/tools/eval.ts`](../packages/coding-agent/src/tools/eval.ts)
- [`src/eval/py/executor.ts`](../packages/coding-agent/src/eval/py/executor.ts)
- [`src/eval/py/kernel.ts`](../packages/coding-agent/src/eval/py/kernel.ts)
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts)

## 1) 运行时边界:编辑与执行

## `.ipynb` 文件转换(`src/edit/notebook.ts`)

- 除非选择器为 `:raw`,否则 `read` 将 `.ipynb` 文件视为 notebook。
- 默认 notebook 视图是带标记的可编辑文本:
  - `# %% [code] cell:N`
  - `# %% [markdown] cell:N`
  - `# %% [raw] cell:N`
- 行选择器与多范围选择器操作于该虚拟文本。
- 编辑流水线通过 `serializeEditedNotebookText(...)` 将虚拟文本往返回 notebook JSON。
- 当标记引用现有未使用的 `cell:N` 时,保留现有 notebook 元数据;新单元格获得全新的空元数据。
- 传给序列化器的缺失 notebook 从空的 nbformat 4.5 notebook 开始。
- 独立的 `write` 工具不感知 notebook:它用提供的字节替换文件。只将其用于有效 notebook JSON,而非虚拟标记表示。

该路径中不存在内核生命周期:

- 无内核会话 ID
- 无代码执行
- 无来自 Python 的流块
- 无富显示捕获
- 无执行产生的输出产物流水线

## 内核支撑的执行路径(`src/tools/eval.ts` + `src/eval/py/*`)

当 Agent 需要以持久状态与富显示运行单元格风格 Python 代码时,这通过每个单元格一次 **`eval` 工具**调用(`language: "py"`)进行,而非通过 notebook 文件处理。

Python 子进程生命周期、重置/取消行为、块流、富显示与输出产物截断都位于该路径。

## 2) Notebook 单元格处理语义

## 源规范化

Notebook JSON `source` 通过连接 source 数组转换为虚拟文本。虚拟文本序列化回去时,单元格 source 以保留换行的方式拆分:

- 每个以 `\n` 结尾的行作为带换行的独立 source 条目保留
- 末尾不以换行结尾的行存储时不强制尾随换行
- 空内容成为空 `source` 数组

这镜像 notebook JSON 约定,避免后续编辑时意外的行拼接。

### 类标记源转义

本身看起来像单元格标记的 source 行在渲染时通过添加一个 `%` 转义(`# %% ...` 变为 `# %%% ...`),并在解析时反转义。已转义的类标记行以同样方式增减一个 `%`。这防止单元格内的字面量标记文本在往返编辑中被误解析为新单元格。

## 标记解析与单元格保留

- 非空表示必须以标记开头;第一个标记之前的文本(包括空行)被拒绝。空文本序列化为无单元格的 notebook。
- 标记必须匹配 `# %% [code|markdown|raw]`,带可选的 `cell:N`。
- 如果 `cell:N` 指向未使用的现有单元格,该单元格被克隆,其 `cell_type` 与 `source` 被更新,不相关字段被保留。
- 现有代码单元格的 `execution_count` 与 `outputs` 被保留而非清除;缺失字段初始化为 `null` 与 `[]`。
- Markdown/raw 单元格移除 `execution_count` 与 `outputs`。
- 若无有效未使用原始索引,则创建带空元数据的新单元格。
- Notebook 级元数据、格式字段与不相关的顶层字段都能存活,因为序列化克隆原始文档并只替换 `cells`。

## 错误表面

以下情况抛出硬失败:

- read 时 notebook 缺失
- 无效 JSON
- 缺失/非数组 `cells`
- 无效单元格对象或单元格类型
- 无效可编辑表示(例如第一个单元格标记之前的文本)

这些通过 `read` 与编辑流水线等 notebook 感知调用方以普通工具错误形式表面化。独立 `write` 路径不解析 notebook JSON。

## 3) 内核会话语义(实际存在之处)

内核语义在 `executePython` / `PythonKernel` 中实现,并适用于 `eval` 工具的 Python 后端。

## 模式

`PythonKernelMode`:

- `session`(默认)
  - 内核按 `(会话 id, cwd, interpreter)` 缓存
  - 多个所有者可为同一键共享保留的内核
  - 执行由工具的排他并发与后端执行路径串行化
  - 执行前替换死亡内核
- `per-call`
  - 为请求创建子进程
  - 执行
  - 总是在 `finally` 中关闭子进程

## 重置行为

每个 eval 调用有可选 `reset` 标志。`reset: true` 在该调用执行前重置选定的 Python 会话;它不重置其他启用的语言运行时。

## 内核死亡 / 重启 / 重试

在 session 模式中:

- 执行前保留的子进程不存活,则替换它
- 如果执行因子进程死亡而失败,内核被替换,代码重试一次
- 同一会话键的并发重置会合并:已在途的重置被等待而非启动另一个,排在其后的运行在新重启的内核上继续

## 4) 环境/会话变量注入

内核启动与逐执行环境修补可接收:

- `PI_SESSION_FILE`
- `PI_ARTIFACTS_DIR`
- `PI_TOOL_BRIDGE_URL`
- `PI_TOOL_BRIDGE_TOKEN`
- `PI_TOOL_BRIDGE_SESSION`
- `PI_EVAL_LOCAL_ROOTS`

运行器初始化进程状态,使代码在请求的 cwd 中执行,受管 env 条目反映在 `os.environ` 中,并且 cwd 在 `sys.path` 上可用。

## 5) 流/块与显示处理(内核支撑路径)

Python 后端使用 NDJSON 子进程运行器。宿主按执行处理帧:

- `stdout` / `stderr` -> 文本块到 `onChunk`
- `display` / `result` -> MIME 包渲染
- `error` -> 回溯文本与结构化错误元数据
- `done` -> 最终状态、执行计数、取消状态

显示文本 MIME 优先级:

1. `text/markdown`
2. `text/plain`
3. 转换的 `text/html`

单独捕获的结构化输出包括:

- `application/json` -> JSON 显示输出
- `image/png` / `image/jpeg` -> 图像输出
- `application/x-omp-status` -> 状态事件

取消/超时:

- 中止/超时向运行器发送 `SIGINT`
- 如果运行器在中断宽限窗口后未稳定,关闭升级,内核在下次调用时重建
- 超时输出以超时消息注解

## 6) 截断与产物行为

内核执行路径使用 `src/session/streaming-output.ts` 中的 `OutputSink`:

- 净化每个块
- 跟踪总/输出行与字节
- 可选将完整输出溢出到产物文件
- 输出超过配置阈值时保留 UTF-8 安全的内存尾部缓冲区

`eval` 将该元数据转换为结果截断通知与 TUI 警告。

Notebook 文件转换**不**使用 `OutputSink`;它没有流/产物截断流水线,因为不执行代码。

## 7) 渲染器假设与格式化

## Read/edit notebook 表示

Notebook 文件作为文本渲染给模型。可见单元格标记是可编辑表示的一部分,不是序列化时被忽略的注释。

## Python 渲染器(用于实际执行输出)

内核支撑的执行渲染期望:

- 逐单元格状态转换(`pending` / `running` / `complete` / `error`)
- 可选结构化状态事件
- 可选 JSON 输出树
- 图像输出
- 截断警告 + 可选 `artifact://<id>` 指针

该渲染器行为与 notebook JSON 编辑无关,除了两者都复用共享 TUI 原语。

## 8) 实用工作流

如果工作流同时需要 notebook 变更与执行:

1. 以默认可编辑视图读取 `.ipynb` 文件,并用编辑流水线变更该视图
2. 将一个所需单元格 source 复制到 `language: "py"` 的 `eval` 调用中
3. 对后续单元格重复;session 模式 Python 状态跨调用持久
4. 通过编辑流水线应用后续 source 变更;整文件 `write` 必须包含 notebook JSON

当前实现不提供同时变更 `.ipynb` 并通过内核上下文执行 notebook 单元格的单一工具。
