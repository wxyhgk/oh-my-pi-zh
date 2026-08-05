# pi-native 认证网关传输

`pi-native` 是 pi-ai 客户端与 `omp auth-gateway` 之间的无损传输。它**不是**文本工具调用方言:当前实现中没有 `<call:NAME>` 语法、解析器、渲染器或 `PI_DIALECT=pi-native` 值。工具调用仍然是 `Context` 和 `AssistantMessageEvent` 内部的规范 pi-ai `ToolCall` 内容块。

当客户端已经使用 pi-ai 协议、而网关持有提供商凭据时,使用此传输——例如,容器化的 omp 与主机网关通信,或 robomp 槽位与其 sidecar 通信。OpenAI/Anthropic 兼容路由会转换并可能丢失 pi 特有字段;pi-native 直接发送规范类型,保留服务层级、缓存标记、思考预算、工具选择变体、图像和工具调用 ID。

## 配置与分发

模型通过以下配置启用:

```yaml
transport: pi-native
baseUrl: http://gateway.internal:4000
```

`baseUrl` 必须指向一个 `omp auth-gateway`(或兼容服务)。缺少 `baseUrl` 会失败并报:

```text
pi-native transport requires `baseUrl` on model MODEL_ID (set it on the provider config in models.yml)
```

当 `model.transport === "pi-native"` 时,`streamSimple` 绕过常规的按 API 提供商实现,转而调用 `streamPiNative`。客户端会去掉 `baseUrl` 的尾随斜杠,然后 POST 到 `/v1/pi/stream`。

网关 bearer 是解析出的模型/API 密钥。它以 `Authorization: Bearer …` 发送,绝不放进 JSON options 中。模型头也会被转发;显式的 `model.headers.Authorization` 优先于解析出的密钥。

`transport` 只改变分发。定价、上下文窗口、最大 token 和思考元数据仍然从模型目录本地解析。

## 请求

```http
POST /v1/pi/stream
Content-Type: application/json
Accept: text/event-stream

{
  "modelId": "provider/model-id",
  "context": {
    "systemPrompt": ["..."],
    "messages": [],
    "tools": []
  },
  "options": {},
  "stream": true
}
```

客户端总是将 `modelId` 限定为 `${provider}/${id}`,并且总是请求流式。服务器也接受 `modelId`、字符串 `model` 或 `model.id`;其底层请求解析器默认 `stream` 为 `true`。

网关边界的校验刻意保持浅层:

- 请求体必须是对象;
- 必须存在非空的模型标识符;
- `context` 必须是带 `messages` 数组的对象;
- 存在时,`context.systemPrompt` 和 `context.tools` 必须是数组。

无效的形状会产生校验错误。规范消息/工具内部结构在此边界不再重新校验;下游失败会以网关上游错误的形式呈现。

## 跨线传输的 options

服务器接受以下 `SimpleStreamOptions` 子集:

`temperature`、`topP`、`topK`、`minP`、`presencePenalty`、
`frequencyPenalty`、`repetitionPenalty`、`stopSequences`、`maxTokens`、
`cacheRetention`、`cachedContent`、`headers`、`initiatorOverride`、
`maxRetryDelayMs`、`metadata`、`sessionId`、`promptCacheKey`、`promptCache`、
`statefulResponses`、`streamFirstEventTimeoutMs`、`streamIdleTimeoutMs`、
`reasoning`、`disableReasoning`、`hideThinkingSummary`、`thinkingBudgets`、
`toolChoice`、`serviceTier`、`kimiApiFormat`、`syntheticApiFormat`、
`preferWebsockets`、`openrouterVariant` 和 `loopGuard`。

未知、`null` 和 `undefined` 的 option 值会被服务器静默丢弃。客户端另外剥离运行时/服务器持有的字段:`signal`、`apiKey`、`fetch`、`onPayload`、`onResponse`、`onSseEvent`、`execHandlers`、`cursorExecHandlers`、`cursorOnToolResult` 和 `providerSessionState`。`onResponse` 仍然在本地针对网关的 HTTP 响应运行;回调和运行时句柄本身从不跨线传输。

## 流式响应

每个规范 `AssistantMessageEvent` 都按 JSON 序列化、不重塑,并以 SSE 帧封装:

```text
data: {"type":"start",...}

data: {"type":"text_delta",...}

data: {"type":"done","reason":"stop","message":{...}}

data: [DONE]

```

服务器在规范的 `done` 或 `error` 事件后停止,然后写入 `[DONE]`。如果其事件迭代器先抛出,它会尽力发出 `{"type":"error","reason":"error","errorMessage":"..."}`,随后是 `[DONE]`。取消 HTTP 请求体会把取消传播到网关请求。

客户端解析每个事件,并原样推入 `AssistantMessageEventStream`;没有部分内容重建或工具转换。调用方中止会取消响应体。首事件和空闲看门狗使用请求 options(如提供),否则使用标准 `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` / `PI_STREAM_IDLE_TIMEOUT_MS` 策略。初始 `start` 事件不算作空闲看门狗的进度。

如果 SSE 连接在终态事件之前关闭,客户端会合成一个终态助手边界,使 `.result()` 不会挂起。调用方取消会发出 `{type:"error", reason:"aborted", error: syntheticAssistant}`;嵌套的 `AssistantMessage` 具有 `stopReason:"aborted"` 和 `errorMessage:"stream closed without terminal event"`。任何其他干净关闭会发出 `{type:"done", reason:"stop", message: syntheticAssistant}`,其嵌套消息具有 `stopReason:"stop"`。因此 `reason` 是顶层事件字段;`stopReason` 只存在于嵌套的 `AssistantMessage` 上。

客户端只消费流式响应。服务器端点也支持 `stream: false`,返回:

```json
{ "message": { "role": "assistant", "content": [] } }
```

完整的规范 `AssistantMessage` 在 `message` 中。

## 错误

到达 pi-native 路由的提供商/处理器失败使用:

```json
{ "error": { "type": "rate_limit_error", "message": "..." } }
```

带相应的 HTTP 状态、`Content-Type: application/json` 和 `Cache-Control: no-store`。客户端将此形状转换为 `AuthGatewayError`,保留状态、响应头和 `type`。

Bearer 认证在路由处理器之前运行。网关 bearer 缺失或无效会被拒绝为 `{"error":"unauthorized"}`,而不是结构化的提供商信封;因此客户端使用其通用 `auth-gateway STATUS: BODY_OR_STATUS_TEXT` 回退,并且没有可保留的提供商错误 `type`。其他不合规的错误体使用相同的回退。无正文的成功响应也是 `AuthGatewayError`。

## 事实来源

- `packages/catalog/src/types.ts` — `Model.transport`
- `packages/ai/src/stream.ts` — pi-native 分发
- `packages/ai/src/providers/pi-native-client.ts` — 请求、认证、SSE 和超时行为
- `packages/ai/src/providers/pi-native-server.ts` — 请求校验、option 白名单、SSE 和错误信封
- `packages/ai/src/auth-gateway/server.ts` — `/v1/pi/stream` 路由以及网关模型/凭据解析
