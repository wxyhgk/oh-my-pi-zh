# 提供商流式传输内部

本文档解释 `@oh-my-pi/pi-ai` 中 token/工具流式传输如何被规范化,然后如何通过 `@oh-my-pi/pi-agent-core` 和 `coding-agent` 会话事件传播。

## 端到端流程

1. `streamSimple()`(`packages/ai/src/stream.ts`)映射通用选项,并分派到提供商流式函数。重型内置项通过 `packages/ai/src/providers/register-builtins.ts` 中的惰性包装访问;薄路由包装保持急切。
2. 提供商流式函数将提供商原生流事件翻译为统一的 `AssistantMessageEvent` 序列。当前内置项包括 Anthropic、OpenAI Responses/Completions/Codex/Azure Responses、Google Gemini/Gemini CLI/Vertex、Bedrock Converse、Ollama、Cursor、Devin、pi-native 网关传输,外加 GitLab Duo/Kimi/Synthetic 包装和扩展注册的自定义 API。
3. 每个提供商将事件推入 `AssistantMessageEventStream`(`packages/ai/src/utils/event-stream.ts`),它暴露:
   - 用于增量更新的异步迭代
   - 用于最终 `AssistantMessage` 的 `result()`
4. 惰性转发包装应用首进度和空闲看门狗。合成的 `start` 事件不计为首进度;提供商可以用 `trackLocalWork()` 标记服务器请求的本地工作,使该工作看起来不像停滞的流。
5. `agentLoop`(`packages/agent/src/agent-loop.ts`)消费这些事件,变更进行中的助手状态,并发出携带原始 `assistantMessageEvent` 的 `message_update` 事件。
6. `AgentSession`(`packages/coding-agent/src/session/agent-session.ts`)订阅 Agent 事件,持久化消息,驱动扩展钩子,并应用会话行为(重试、压缩、TTSR、流式编辑中止检查)。

## `@oh-my-pi/pi-ai` 中的统一流契约

所有提供商发出相同的形状(`packages/ai/src/types.ts` 中的 `AssistantMessageEvent`):

- `start`
- 内容块生命周期三元组:
  - 文本:`text_start` → `text_delta`* → `text_end`
  - 思考:`thinking_start` → `thinking_delta`* → `thinking_end`
  - 工具调用:`toolcall_start` → `toolcall_delta`* → `toolcall_end`
- 完整图像块:`image_end`
- 终止事件:
  - `done`,带 `reason: "stop" | "length" | "toolUse"`
  - 或 `error`,带 `reason: "aborted" | "error"`

`AssistantMessageEventStream` 保证:

- `done` 或 `error` 事件将 `result()` 解析为该事件的最终助手消息
- `fail(error)` 改为拒绝迭代和 `result()`;`end()` 在没有最终
  结果时拒绝 `result()`,而不是让它悬而未决
- 事件立即、按推送顺序交付给消费者(无批处理或合并)

## 增量节流行为

`AssistantMessageEventStream` 本身不再节流或合并增量事件——每个提供商事件都按推送交付。每增量成本控制移入工具调用参数解析:提供商累积部分 JSON,并通过 `parseStreamingJsonThrottled()`(`packages/utils/src/json-parse.ts`)重新解析,该函数在至少 `STREAMING_JSON_PARSE_MIN_GROWTH`(256)个新字节到达之前跳过重新解析,将流中解析成本从二次方限制为线性。工具调用边界处的最终解析是无条件且权威的。

没有提供商背压:提供商仍全速生产,而本地流排队。

## 提供商规范化细节

## Anthropic(`anthropic-messages`)

来源:`packages/ai/src/providers/anthropic.ts`

规范化点:

- `message_start` 初始化 usage(输入/输出/缓存 token)
- `content_block_start` 映射到文本/思考/工具调用开始
- `content_block_delta` 映射:
  - `text_delta` → `text_delta`
  - `thinking_delta` → `thinking_delta`
  - `input_json_delta` → `toolcall_delta`
  - `signature_delta` 只更新 `thinkingSignature`(无事件)
- `content_block_stop` 发出对应的 `*_end`
- `message_delta.stop_reason` 通过 `mapStopReason()` 映射

工具调用参数流式传输:

- 每个工具块携带内部 `partialJson`
- 每个 JSON 增量追加到 `partialJson`
- `arguments` 在追加增量时通过 `parseStreamingJsonThrottled()` 重新解析(仅在 ≥256 个新字节后重新解析)
- `toolcall_end` 再解析一次,然后剥离 `partialJson`

## OpenAI Responses 家族(`openai-responses`、`openai-codex-responses`、`azure-openai-responses`)

来源:`packages/ai/src/providers/openai-responses.ts`、`openai-codex-responses.ts` 和 `azure-openai-responses.ts`

规范化点:

- `response.output_item.added` 开始推理/文本/函数调用/自定义工具块
- 推理摘要事件(`response.reasoning_summary_text.delta`)和原始推理事件(`response.reasoning_text.delta`)变为 `thinking_delta`
- 输出/拒绝增量变为 `text_delta`
- `response.function_call_arguments.delta` 和 `response.custom_tool_call_input.delta` 变为 `toolcall_delta`
- `response.output_item.done` 发出 `thinking_end` / `text_end` / `toolcall_end`
- `response.completed` 将状态映射到停止原因和 usage;`response.failed` / SDK `error` 事件抛入包装器的终止 `error` 路径

工具调用参数流式传输:

- 函数调用 JSON 参数与 Anthropic 相同的 `partialJson` 累积模式
- 自定义工具流式传输原始字符串输入,并将最终参数暴露为 `{ input: <raw> }`
- 只发送 `response.function_call_arguments.done` 的提供商仍会填充最终参数
- 工具调用 id 规范化为 `"<call_id>|<item_id>"`

## Google Generative AI(`google-generative-ai`)

来源:`packages/ai/src/providers/google.ts`(薄请求包装)和 `google-shared.ts`(`streamGoogleGenAI`,共享的块到块翻译)

规范化点:

- 迭代 `candidate.content.parts`
- 文本部分由 `isThinkingPart(part)` 拆分为思考与文本
- 块转换在开始新块之前关闭前一个块
- `part.functionCall` 被视为完整工具调用(立即发出 start/delta/end)
- 完成原因由 `google-shared.ts` 中的 `mapStopReason()` 映射

工具调用参数流式传输:

- 函数调用参数以结构化对象到达,而不是增量 JSON 文本
- 实现发出一个包含 `JSON.stringify(arguments)` 的合成 `toolcall_delta`
- 此路径中 Google 不需要部分 JSON 解析器

## 部分工具调用 JSON 累积与恢复

共享行为使用 `parseStreamingJson()` / `parseStreamingJsonThrottled()`(`packages/utils/src/json-parse.ts`):

1. 尝试 `JSON.parse`
2. 回退到内部 `RelaxedJson` 解析器(宽松/修复)处理不完整片段
3. 如果两者都失败,返回 `{}`

含义:

- 格式错误或截断的参数增量不会立即崩溃流处理
- 进行中的 `arguments` 可能暂时为 `{}`
- 后续有效增量可以恢复结构化参数,因为解析会随缓冲增长而重试(流中节流到 ≥256 字节增长步长)
- 最终的 `toolcall_end` 在发出前再执行一次解析尝试

## 停止原因与传输/运行时错误

提供商停止原因被映射到规范化的 `stopReason`:

- Anthropic:`end_turn`→`stop`、`max_tokens`→`length`、`tool_use`→`toolUse`、安全/拒绝情况→`error`
- OpenAI Responses:`completed`→`stop`、`incomplete`→`length`、`failed/cancelled`→`error`
- Google:`STOP`→`stop`、`MAX_TOKENS`→`length`、安全/禁止/格式错误函数调用类→`error`

错误语义分为两个阶段:

1. **模型完成语义**(提供商报告的完成原因/状态)
2. **传输/运行时失败**(网络/客户端/解析器/中止异常)

如果提供商流抛出或发出失败信号,每个提供商包装会捕获并发出终止 `error` 事件,带有:

- 设置中止信号时为 `stopReason = "aborted"`
- 否则 `stopReason = "error"`
- `errorMessage = finalizeErrorMessage(error, rawRequestDump)`(`packages/ai/src/utils/http-inspector.ts`),它包装 `formatErrorMessageWithRetryAfter()` 并追加任何捕获的 HTTP 错误体/原始请求转储(`cursor` 包装直接调用 `formatErrorMessageWithRetryAfter()`)

## 格式错误块 / SSE 解析失败行为

OpenAI Completions/Responses 路径使用仓库内 HTTP+SSE 传输 `postOpenAIStream()`(`packages/ai/src/utils/openai-http.ts`),它用 `readSseJson()` 解码帧,并替换了 `openai` SDK 客户端。Anthropic 使用仓库内 `AnthropicMessagesClient`(`packages/ai/src/providers/anthropic-client.ts`);Google 路径和 Codex SSE 回退通过 `readSseJson()` 直接读取 SSE,websocket Codex 帧通过同一事件处理器规范化。

当前实现中观察到的行为:

- 格式错误的 SSE 帧或块 JSON 作为异常或流 `error` 事件浮出
- 格式错误的 Codex SSE JSON/帧从本地 SSE 读取器抛出
- 提供商不会从单个格式错误的块恢复。取决于提供商以及是否已发出任何不可重放输出,有界的提供商自有请求重试可能为瞬态传输或格式错误信封失败启动新尝试。
- 提供商自有恢复还包括有界空完成重试(OpenAI Responses、OpenAI Completions、Anthropic、Google native/Vertex、Gemini CLI 和 Ollama)和能力回退,如在没有被拒绝的严格工具字段的情况下重试
- Codex 只能在发出不可重放输出之前从 websocket 回退到 SSE
- `AgentSession` 单独处理消息级自动重试;它不会从失败的块重放流

## 取消边界

取消是分层的:

- AI 提供商请求:`options.signal` 被传入提供商客户端流调用。
- 提供商包装:流循环后,被中止的信号强制错误路径(`"Request was aborted"`)。
- Agent 循环:在处理每个提供商事件前检查 `signal.aborted`,可以从最新部分合成被中止的助手消息。
- 会话/Agent 控制:`AgentSession.abort()` -> `agent.abort()` -> 共享中止控制器取消。

工具执行取消与模型流取消分开:

- 工具 runner 使用 `AbortSignal.any([agentSignal, steeringAbortSignal])`
- steering 中断可以在保留已产生工具结果的同时中止轮次中剩余的工具执行

## 背压边界

提供商 SDK 流与下游消费者之间没有硬背压机制:

- `EventStream` 使用无最大大小的内存队列
- 节流的 partial-JSON 重新解析降低每增量 CPU 成本,但不减慢提供商摄入
- 如果消费者显著滞后,排队事件可以增长到完成

当前设计偏好响应性和简单排序,而不是有界缓冲流控制。

## 流事件如何作为 Agent/会话事件浮出

`agentLoop.streamAssistantResponse()` 桥接 `AssistantMessageEvent` 到 `AgentEvent`:

- 在 `start` 上:推送占位助手消息并发出 `message_start`
- 在块事件(`text_*`、`thinking_*`、`image_end`、`toolcall_*`)上:更新最后一条助手消息并发出带有原始 `assistantMessageEvent` 的 `message_update`
- 在终止(`done`/`error`)上:从 `response.result()` 解析最终消息,发出 `message_end`

然后 `AgentSession` 消费这些事件以进行会话级行为:

- TTSR 监视 `message_update.assistantMessageEvent` 的 `text_delta`、`thinking_delta` 和 `toolcall_delta`
- 流式编辑守卫检查 `edit` 调用上的 `toolcall_delta`/`toolcall_end`,可以提前中止
- 持久化在 `message_end` 写入最终消息
- 自动重试检查助手 `stopReason === "error"` 加 `errorMessage` 启发式

## 统一与提供商特定职责

统一(公共契约):

- 事件形状(`AssistantMessageEvent`)
- 最终结果提取(`done`/`error`)
- 即时、按序事件交付
- Agent/会话事件传播模型

提供商特定(未完全抽象):

- 上游事件分类法和映射逻辑
- 停止原因翻译表
- 工具调用 ID 约定
- 推理/思考块语义和签名
- 用量 token 语义和可用性时机
- 每个 API 的消息转换约束

## 实现文件

- [`../../ai/src/stream.ts`](../packages/ai/src/stream.ts) — 提供商分派、选项映射、API key/会话管道、自定义 API 分派和提供商特定凭据处理。
- [`../../ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts) — 通用流队列 + 最终结果解析。
- [`../../utils/src/json-parse.ts`](../packages/utils/src/json-parse.ts) — 流式工具参数的部分 JSON 解析。
- [`../../ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts) — Anthropic 事件翻译和工具 JSON 增量累积。
- [`../../ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts)、[`openai-shared.ts`](../packages/ai/src/providers/openai-shared.ts)、[`openai-codex-responses.ts`](../packages/ai/src/providers/openai-codex-responses.ts)、[`azure-openai-responses.ts`](../packages/ai/src/providers/azure-openai-responses.ts) — Responses 家族事件翻译和状态映射。
- [`../../ai/src/providers/google.ts`](../packages/ai/src/providers/google.ts)、[`google-gemini-cli.ts`](../packages/ai/src/providers/google-gemini-cli.ts)、[`google-vertex.ts`](../packages/ai/src/providers/google-vertex.ts) — Gemini 流块到块翻译变体。
- [`../../ai/src/providers/google-shared.ts`](../packages/ai/src/providers/google-shared.ts) — Gemini 完成原因映射和共享转换规则。
- [`../../ai/src/providers/amazon-bedrock.ts`](../packages/ai/src/providers/amazon-bedrock.ts)、[`openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts)、[`ollama.ts`](../packages/ai/src/providers/ollama.ts)、[`cursor.ts`](../packages/ai/src/providers/cursor.ts)、[`pi-native-client.ts`](../packages/ai/src/providers/pi-native-client.ts) — 使用相同事件契约的额外内置流适配器。
- [`../../ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts) 和 [`../../ai/src/utils/idle-iterator.ts`](../packages/ai/src/utils/idle-iterator.ts) — 惰性提供商转发、首进度/空闲看门狗和本地工作感知停滞处理。
- [`../../agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts) — 提供商流消费和 `message_update` 桥接。
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 流式更新、中止、重试和持久化的会话级处理。
