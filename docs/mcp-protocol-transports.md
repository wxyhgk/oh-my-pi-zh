# MCP 协议与传输内部机制

本文档描述 coding-agent 如何实现 MCP JSON-RPC 消息传递，以及协议关注点如何与传输关注点分离。

## 范围

涵盖：

- JSON-RPC 请求/响应和通知流程
- 服务器到客户端请求处理（`ping`、`roots/list`）
- stdio 和 HTTP/SSE 传输的请求关联与生命周期
- 超时、取消和认证刷新行为
- 错误传播与畸形负载处理
- 传输选择边界（`stdio` vs `http` vs `sse`）
- 哪些重连/重试责任属于传输层，哪些属于管理器/工具桥接层

不包括扩展编写 UX 或命令 UI。

## 实现文件

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/transports/stdio.ts`](../packages/coding-agent/src/mcp/transports/stdio.ts)
- [`src/mcp/transports/http.ts`](../packages/coding-agent/src/mcp/transports/http.ts)
- [`src/mcp/transports/sse.ts`](../packages/coding-agent/src/mcp/transports/sse.ts)
- [`src/mcp/transports/index.ts`](../packages/coding-agent/src/mcp/transports/index.ts)
- [`src/mcp/json-rpc.ts`](../packages/coding-agent/src/mcp/json-rpc.ts)
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)

## 层边界

### 协议层（JSON-RPC + MCP 方法）

- 消息形状在 `types.ts` 中定义（`JsonRpcRequest`、`JsonRpcNotification`、`JsonRpcResponse`、`JsonRpcMessage`）。
- MCP 客户端逻辑（`client.ts`）决定方法顺序和会话握手：
  1. `initialize` 请求
  2. 对于 Streamable HTTP 传输，在 initialize 响应确立任何会话 id 后启动可选的后台 SSE 监听器
  3. `notifications/initialized` 通知
  4. `tools/list`、`tools/call` 等方法调用

### 传输层（`MCPTransport`）

`MCPTransport` 抽象了投递和生命周期：

- `request(method, params, options?) -> Promise<T>`
- `notify(method, params?) -> Promise<void>`
- `close()`
- `connected`
- 可选回调：`onClose`、`onError`、`onNotification`、`onRequest`

传输实现拥有帧格式和 I/O 细节：

- `StdioTransport`：子进程 stdio 上的换行分隔 JSON
- `HttpTransport`：通过 POST 的 Streamable HTTP JSON-RPC，可选 SSE 响应/监听
- `LegacySseTransport`：协议修订版 2024-11-05 HTTP+SSE，具有持久 GET 流，并从 `endpoint` 事件发现 POST 端点

### 管理器/客户端接线

`connectToServer()` 总是为标准服务器到客户端请求安装 `onRequest` 处理程序。`MCPManager` 安装通知处理程序、针对 HTTP 类 OAuth 服务器的 OAuth 刷新钩子，以及受管理连接的 `onClose` 重连处理。

## 传输选择

`client.ts:createTransport()` 从配置选择传输：

- `type` 省略或 `"stdio"` -> `createStdioTransport`
- `"http"` -> `createHttpTransport`
- `"sse"` -> `createSseTransport`

`"sse"` 使用旧的 HTTP+SSE 传输：它用 GET 打开配置的 URL，读取 `endpoint` 事件的纯文本 URL/路径，向该端点 POST JSON-RPC 请求，并在流上接收 JSON-RPC 响应。

## JSON-RPC 消息流与关联

## 请求 ID

每个传输拥有一个 `RequestIdAllocator`。出站 ID 默认为从 `1` 开始的单调递增整数，这与更广泛的 MCP 生态系统以及 Apple 的 `xcrun mcpbridge` 等服务器匹配。服务器配置可以设置 `requestIdFormat: "string"` 以改用抗冲突的 `Snowflake.next()` 字符串。ID 仍然是传输本地的关联令牌。

## Stdio 关联路径

- 出站请求被序列化为一个 JSON 对象 + `\n`。
- `#pendingRequests: Map<id, {resolve,reject}>` 存储进行中的请求。
- 读取循环从 stdout 解析 JSONL 并调用 `#handleMessage`。
- 如果入站消息具有匹配的 `id`，请求 resolve/reject。
- 如果入站消息具有 `method` 而没有 `id`，则视为通知并发送到 `onNotification`。
- 如果入站消息同时具有 `method` 和 `id`，则视为服务器到客户端请求并通过 `onRequest` 应答；没有处理程序时，传输以 JSON-RPC `-32601 Method not found` 应答。

未知的响应 ID 被忽略（不 reject，不调用错误回调）。

## HTTP 关联路径

- 出站请求是带 JSON 体和生成的 `id` 的 HTTP `POST`。
- 非 SSE 响应路径：解析一个 JSON-RPC 响应并返回 `result`/在 `error` 时抛出。
- SSE 响应路径（`Content-Type: text/event-stream`）：流式处理事件，返回第一个 `id` 匹配预期请求 ID 且具有 `result` 或 `error` 的消息。
- 具有 `method` 而没有 `id` 的 SSE 消息视为通知。
- 同时具有 `method` 和 `id` 的 SSE 消息视为服务器到客户端请求，并以 POSTed JSON-RPC 响应应答。

如果 SSE 流在匹配响应前结束，请求以 `No response received for request ID ...` 失败。捕获匹配响应后，传输在后台排空剩余的 SSE 消息。

## 通知

客户端通过 `transport.notify(...)` 发出 JSON-RPC 通知。

- Stdio：通过 `writeFrame()` 向 stdin 写入通知帧（`jsonrpc`、`method`、`params`）加换行。同步写入失败会关闭传输并抛出；异步 `FileSink` 拒绝被中和，因为通知没有可 reject 的响应 promise。
- HTTP：发送不带 `id` 的 POST 体；成功接受任何 `2xx` 响应，包括 `202 Accepted`。

服务器发起的通知通过传输 `onNotification` 浮出；`MCPManager` 消费已知的 MCP 列表/更新通知，并可以通过自己的回调转发所有通知。

## Stdio 传输内部机制

## 生命周期与状态转换

- 初始：`connected=false`、`process=null`、pending 映射为空
- `connect()`：
  - 用配置的 command/args/env/cwd 生成子进程
  - 标记为已连接
  - 启动 stdout 读取循环（`readJsonl`）
  - 启动 stderr 循环（读取/丢弃；目前静默）
- `close()`：
  - `#handleClose()`：标记为断开，reject 所有 pending 请求（`Transport closed`），发出 `onClose`
  - 杀死子进程
  - 分离读取循环而不等待（它可能无限挂起）

如果读取循环意外退出，`finally` 触发 `#handleClose()`，执行相同的 pending 请求拒绝和关闭回调。

## 超时与取消

每个请求：

- 超时来自 `resolveMCPTimeoutMs`：`OMP_MCP_TIMEOUT_MS` 环境变量覆盖，否则 `config.timeout ?? 30000`；`0` 禁用
- 可选的调用方 `AbortSignal`
- 中止和超时都会 reject pending promise 并清理其映射条目；迟到的写入拒绝在已结算后会被忽略

取消仅是本地的：传输不会向服务器发送协议级取消通知。

## 畸形负载处理

在读取循环中：

- 每个解析的 JSONL 行在 `try/catch` 中传给 `#handleMessage`
- 畸形/无效消息的处理异常被丢弃（`Skip malformed lines` 注释）
- 循环继续，因此一条坏消息不会杀死连接

如果底层流解析器抛出，则调用 `onError`（仍在连接时），然后连接关闭。

## 断开/失败行为

当进程退出或流关闭时：

- 所有进行中的请求以 `Transport closed` 拒绝
- 不自动重启或重连
- 更上层必须通过创建新传输来重连

## 背压/流式说明

- `request()` 刻意**不**等待 `stdin.write()` 或 `flush()`：等待整个管道可能使异步函数在返回响应 promise 之前搁浅，从而阻止其超时/中止拒绝到达调用方。同步抛出和异步写入/刷新拒绝改为拒绝该 pending 响应 promise。`notify()` 通过 `writeFrame()` 写入，它检测同步失败但中和异步 EPIPE 拒绝。
- 传输中没有显式队列或高水位管理。
- 入站处理是流驱动的（对 `readJsonl` 的 `for await`），一次一个解析消息。

## Streamable HTTP 传输内部机制

## 生命周期与连接语义

HTTP 传输具有逻辑连接状态，但请求路径对每次 HTTP 调用是无状态的：

- `connect()` 设置 `connected=true`（无 socket/会话握手）
- 可选的服务器会话跟踪通过 `Mcp-Session-Id` header
- `close()` 可选发送带 `Mcp-Session-Id` 的 `DELETE`，中止 SSE 监听器，发出 `onClose`

因此 `connected` 意味着"传输可用"，而非"持久流已建立"。

## 会话 header 行为

- 在 POST 响应上，如果存在 `Mcp-Session-Id` header，传输存储它。
- 后续请求/通知包含 `Mcp-Session-Id`。
- `close()` 尝试用 HTTP DELETE 终止服务器会话；终止失败被忽略。

## 超时、取消与认证刷新

对于 `request()`：

- 超时通过 `createMCPTimeout` 使用 `AbortController`（`OMP_MCP_TIMEOUT_MS` 覆盖，否则 `config.timeout ?? 30000`；`0` 禁用）
- 外部信号（如提供）通过 `AbortSignal.any([...])` 合并
- AbortError 处理区分调用方中止与超时

对于 `notify()`：

- 超时使用内部 `AbortController`，采用相同的已解析超时
- 传输接口上没有外部中止选项

对于由 `MCPManager` 管理的 HTTP 类 OAuth 配置，出站请求和尽力而为的服务器请求响应在 token 刷新返回替换 header 时，会在 `HTTP 401`/`403` 上重试一次。

## HTTP 错误传播

在非 OK 响应上：

- 响应文本包含在抛出的错误中（`HTTP <status>: <text>`）
- 如果存在，追加来自 `WWW-Authenticate` 和 `Mcp-Auth-Server` 的认证提示

在 JSON-RPC 错误对象上：

- 抛出 `MCP error <code>: <message>`

格式错误的 JSON 体（`response.json()` 失败）作为解析异常传播。

## SSE 行为与模式

存在两条 SSE 路径：

1. **每请求 SSE 响应**（`#parseSSEResponse`）
   - 当 POST 响应内容类型为 `text/event-stream` 时使用
   - 消费流直到找到匹配的响应 id
   - 可以在同一流中处理交错的通知

2. **后台 SSE 监听器**（`startSSEListener()`）
   - 用于服务器发起通知和服务器到客户端请求的可选 GET 监听器
   - `connectToServer()` 在 `initialize` 之后、`notifications/initialized` 之前为 Streamable HTTP 传输启动它
   - 监听器启动最多等待一秒，对于非常小的请求超时则更短；`timeout: 0` / `OMP_MCP_TIMEOUT_MS=0` 禁用该启动期限
   - 如果 GET 返回 `405`、其他非 OK 状态、无体或超时，监听器静默禁用自身

## 畸形负载与断开处理

SSE JSON 解析错误从 `readSseJson` 冒出并 reject 请求/监听器。

- 请求 SSE 解析错误 reject 活动请求。
- 后台监听器错误触发 `onError`（AbortError 除外），而仍在连接时结束的已建立监听器触发 `onClose`，以便管理器重连。
- 传输不会自行重启监听器；受管理的连接可以通过管理器的 `onClose` 处理重连。

## 旧版 HTTP+SSE 传输内部机制

`LegacySseTransport` 实现 MCP 协议修订版 2024-11-05：

- `connect()` 用 `GET Accept: text/event-stream` 打开配置的 URL。
- 第一个 `endpoint` 事件是控制数据而非 JSON；其 `data` 值针对配置的 URL 解析，并存储为 JSON-RPC POST 端点。
- `request()` 和 `notify()` 向发现的端点 POST JSON-RPC 帧。
- JSON-RPC 响应、通知和服务器到客户端请求从 `event: message` 流事件读取，并按请求 id 关联。
- 如果流结束，pending 请求以 `Legacy SSE stream closed` 失败；受管理的连接可以通过 `onClose` 重连。

## `json-rpc.ts` 工具与传输抽象

`src/mcp/json-rpc.ts` 为直接 HTTP MCP 调用提供 `callMCP()` 和 `parseSSE()` 辅助函数（由 Exa 集成使用），而不是 `MCPClient`/`MCPManager` 使用的 `MCPTransport` 抽象。

与 `HttpTransport` 的显著差异：

- 先解析整个响应文本，然后提取第一条 `data: ` 行（`parseSSE`），带 JSON 回退
- 可选的调用方 `AbortSignal`（`CallMcpOptions`），未提供时有 60 秒的硬 `AbortSignal.timeout` 默认值；无会话 id 处理，无传输生命周期
- 返回原始 JSON-RPC 信封对象

此路径轻量，但不如完整传输实现健壮。

## 重试/重连责任

## 传输层

当前传输实现**不**：

- 重试普通的失败请求，除非 HTTP 类传输在接线 `onAuthError` 时进行单次 OAuth 刷新重试
- 在 stdio 进程退出后重连
- 自行重连 SSE 监听器
- 在断开后重发进行中的请求

它们快速失败并传播错误。

## 管理器/工具桥接层

`MCPManager` 为受管理连接接线 `transport.onClose`，并在传输意外关闭时运行 `reconnectServer(name)`。重连会拆除过期连接、重新解析认证/配置值、以退避（`500`、`1000`、`2000`、`4000` ms）重试、重新加载工具，并在重连期间保留过期工具。

`MCPTool` 和 `DeferredMCPTool` 也会在工具调用期间为可重试的连接错误尝试一次重连 + 重试。这是工具可用性恢复，而非传输层重试。

## 失败场景总结

- **格式错误的 stdio 消息行**：丢弃；流继续。
- **stdio 流/进程结束**：传输关闭；pending 请求以 `Transport closed` 拒绝；管理器管理的连接触发重连。
- **HTTP 非 2xx**：request/notify 抛出 HTTP 错误；受管理的 OAuth 请求可以在 401/403 上刷新认证并重试一次。
- **无效 JSON 响应**：解析异常传播。
- **旧版 SSE 流结束**：pending 请求以 `Legacy SSE stream closed` 失败；管理器管理的连接触发重连。
- **SSE 结束而无匹配 id**：请求以 `No response received for request ID ...` 失败。
- **超时**：传输特定的超时错误。
- **调用方中止**：AbortError/原因从接受该参数的调用方信号传播。

## 实用边界规则

如果关注点是消息形状、id 关联或 MCP 方法顺序，则属于协议/客户端逻辑。

如果关注点是帧格式（JSONL vs HTTP/SSE）、流解析、fetch/spawn 生命周期、超时时钟或连接拆除，则属于传输实现。
