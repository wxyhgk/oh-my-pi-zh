# 提供商端点约束

提供商集成并不是仅仅因为它们说 OpenAI 形状的 HTTP 协议就可以互换。一个请求同时由四层决定:

1. 端点家族:`openai-completions`、`openai-responses`、
   `openai-codex-responses`、`anthropic-messages` 等。
2. 网关/认证面:OpenRouter、Vercel AI Gateway、Azure OpenAI、Copilot、
   Alibaba Coding Plan、Kimi Code、Fireworks/Firepass 及类似主机
3. 模型元数据和 `compat` 覆盖
4. 请求上下文:工具、图像、推理模式、有状态会话、服务层级

在添加提供商、添加 compat 标志或将逻辑移出提供商特定分支时,使用此页面。目标是在最窄的、实际拥有该行为的层上一次性编码端点约束。

相关参考:

- [Providers](./providers.md) — 提供商可用性、凭据、自定义提供商
- [Model and Provider Configuration](./models.md) — `models.yml`、路由和 compat 字段
- [Provider streaming internals](./provider-streaming-internals.md) — 流事件规范化
- [Adding a provider](./adding-a-provider.md) — 新提供商的 catalog/auth 接线

## 基线规则

- 当行为可按模型或端点配置时,优先使用 compat 元数据而不是提供商名分支。
- 将传输机制保持在传输本地。Codex websocket 重放、Responses 项路由和 Chat Completions SSE 解码是协议行为,不是通用 compat 标志。
- 将回退限定在失败的特定能力上。严格工具失败不应禁用无关功能。过期的 Responses 链应重置链状态,而不是完全禁用 Responses。
- 不要发出改变网关路由的默认值。OpenRouter 是默认 `max_tokens` 的已知案例,但任何网关都可能将可选字段视为路由提示。
- 在可见副作用出现后停止重试。一旦文本或工具调用对用户/会话可见,重试策略必须避免重复输出和重复工具执行。

## 1. 先选择端点家族

### OpenAI Chat Completions 兼容

保留这些差异,而不是把每个主机都当作标准 OpenAI:

- `stream_options.include_usage` 只有在 compat 说明支持流式 usage 时才安全。
- `store: false` 只有部分主机接受。
- max-output 上限使用 `max_tokens` 或 `max_completion_tokens` 之一。
- 在当前的 OpenAI 形状端点集中,stop 序列和 frequency penalty 位于此路径上。
- OpenRouter 风格的推理和路由字段不能移植到其他 OpenAI 兼容主机,除非 compat 说明可以。

### OpenAI Responses 兼容

Responses 请求形状是它自己的方言:

- 使用 `input`、`instructions`、`store`、`prompt_cache_key`、可选的
  `previous_response_id` 和 `max_output_tokens`
- 可以默认将官方 OpenAI 请求通过 `previous_response_id` 加 `store: true` 进行有状态链式调用
- 第三方 Responses 代理可能拒绝原生推理历史、加密推理重放或 `previous_response_id`
- 流完成只有在 `response.completed` 或 `response.incomplete` 之后才具有权威性;在任一终止事件之前关闭的流对 OpenAI Responses 应该失败,而不是将部分输出呈现为成功

### OpenAI Codex Responses

Codex 不是换了个 URL 的普通 Responses。将这些保留为 Codex 传输策略:

- Codex 账户头和 beta 头
- `x-codex-turn-state` 和 `x-models-etag`
- 可选的 websocket 传输加 SSE 回退
- `responsesLite`
- 用作传输状态的 prompt-cache/session id
- 仅 websocket 的 `previous_response_id` 链式调用;SSE 从不链式
- Codex 重试/重放规则,包括重连和 SSE 重放边界
- 提供商重试只在面向用户内容发出之前
- 仅空白工具调用参数循环断路器

Codex 有意不转发调用者的 max-token 上限,因为后端会拒绝它们。

### Anthropic/OpenAI 双面提供商

Kimi Code 和 Synthetic 可以作为 OpenAI 兼容或 Anthropic 兼容调用。shim 可能需要:

- 切换 `format`
- 在需要时重建 Anthropic 模型
- 将内部推理映射到 Anthropic thinking 预算
- 委托回 OpenAI Completions

不要将这些编码为单向提供商迁移;它们是运行时面选择决策。

## 2. 应用网关和认证覆盖

这些约束位于端点家族之上。它们影响认证、头、路由、模型 id 或用量记账。

### Azure OpenAI

- Chat Completions 将基础 URL 重塑为
  `/deployments/{deployment}/chat/completions?api-version=...`。
- Responses 使用 `/responses?api-version=...`,没有 deployment 作用域的 URL;
  部署名称改为作为请求的 `model` 发送。
- 两个面都可以通过
  `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 将模型 id 映射到部署名称。
- Responses 用 `api-key` 头认证,默认 API 版本为
  `v1`,使用无状态 `store: false`,并拒绝显式提示缓存。

### GitHub Copilot

- API key 被解析为 access token。
- 动态 Copilot 头取决于消息/图像。
- `premiumRequests` 必须在用量填充和替换中幸存。
- 基础 URL 可以从原始 key 解析。

### OpenRouter

- 添加 attribution/cache 头。
- 支持 `:nitro` 和 `:floor` 等路由后缀。
- 仅当模型 id 在最后一个提供商路径段之后没有显式后缀时才追加路由后缀。
- 使用嵌套的 `reasoning` 请求字段。
- 通过 OpenRouter `provider` 对象路由提供商。
- 有特殊的 cache-write 用量记账。
- 对 Anthropic grammar-size 失败有严格工具回退。
- 除非调用者显式设置了上限,否则应省略 catalog 默认 `max_tokens`,以免上游路由被偏置。

### Vercel AI Gateway

- 路由偏好放在 `providerOptions.gateway.only` 和
  `providerOptions.gateway.order` 下。
- 不要复用 OpenRouter 的 `provider` 对象。

### Alibaba Coding Plan

- API key 字节可以是携带 `{ token, enterpriseUrl }` 的 JSON。
- 认证和基础 URL 解析是提供商特定的。

### Kimi Code

- OpenAI 兼容路径需要常见的 Kimi 头。
- 它也参与 OpenAI/Anthropic 双面 shim。

### Fireworks 和 Firepass

- Wire 模型 id 需要提供商特定映射。
- 当额外 body 字段合并后 DeepSeek 风格的 `thinking` 和 OpenAI 风格的
  `reasoning_effort` 同时存在时,Fireworks 可能冲突。

## 3. 按方言序列化请求参数

添加或转发字段前检查这些:

- **模型 id.** 某些模型从推理力度解析 wire id。
  Firepass/Fireworks 转换 id。OpenRouter 后缀处理是路径段感知的。
- **Max output tokens.** Kimi 家族模型即使调用者未设置,也可能需要 max-token 字段。OpenRouter 除非显式,否则应省略 catalog 默认。Codex 丢弃调用者上限。Responses 使用 `max_output_tokens`;Chat
  Completions 使用 `max_tokens` 或 `max_completion_tokens`。
- **服务层级.** Completions、Responses 和 Codex 都处理服务层级,
  但允许的值和定价乘数不同。Codex 对 `gpt-5.5` 有特殊的优先级乘数。
- **提示缓存/会话.** OpenAI Responses 使用 `prompt_cache_key`。
  OpenRouter Responses 使用 `session_id`。Codex 将 prompt cache/session id 用于
  传输状态。Anthropic 风格缓存控制需要在文本部分上设置 `cache_control`。
- **有状态链式调用.** 官方 OpenAI Responses 可以默认链式。
  第三方端点通常不应该。Codex 只在 websocket
  `response.create` 上链式。

## 4. 显式映射推理与思考

推理字段不可互换。

### OpenAI 风格 `reasoning_effort`

- 力度值来自 compat/模型元数据。
- 如果推理被禁用但主机没有真正的关闭开关,映射到最低支持的力度,而不是发明一个不支持的的值。

### Responses `reasoning`

- 使用 `reasoning: { effort, summary }`。
- 可以包含用于重放的 `reasoning.encrypted_content`。
- xAI Grok 模型可能要求省略 `reasoning.effort`。
- 某些 compat 路径注入 GPT-5 的 `# Juice: 0 !important` developer 脚手架。

### OpenRouter `reasoning`

- 使用嵌套的 `reasoning: { effort }`。
- 禁用推理必须发送 `reasoning: { enabled: false }`;否则 OpenRouter 可能默认将推理模型带入思考。

### Z.AI / GLM

- 使用 `thinking: { type: "enabled" }` 或
  `thinking: { type: "disabled" }`。
- GLM 5.2 reasoning-effort 模型也可能接收 `reasoning_effort`。
- 工具请求需要 `tool_stream: true`。

### Qwen

- 一种方言使用顶层 `enable_thinking`。
- 另一种使用 `chat_template_kwargs.enable_thinking`。

### Anthropic 兼容格式

- 推理映射到 Anthropic thinking 启用和 thinking-budget token,
  而不是 OpenAI 风格字段。

### DeepSeek 推理历史

- DeepSeek 兼容推理模型可能要求精确的 `reasoning_content`
  重放。
- 某些变体要求在每个助手轮次重放,而不只是工具调用轮次。
- Synthetic 的 `"."` 占位符对 Kimi/OpenRouter 风格 compat 可接受,
  但对 DeepSeek V4 精确重放不可接受。

### 推理加工具选择

- DeepSeek 推理模型在启用思考时会拒绝 `tool_choice`。
- Kimi 在启用思考时会拒绝强制工具选择。
- Compat 需要两种策略:为任何工具选择禁用推理,以及仅为强制工具选择禁用推理。

### 通过 Responses/SuperGrok 的 xAI Grok

保持这些独立:

- 省略 `reasoning.effort`
- 包含或丢弃加密推理重放
- 筛选推理历史包装

某些模型只拒绝其中一个字段;不要把它们折叠成一个"Grok 模式"分支。

## 5. 按端点规范化工具和 schema

### 严格工具

严格 schema 不是通用能力:

- 某些提供商支持严格工具
- 某些拒绝混合严格/非严格工具
- 某些拒绝严格化 schema
- OpenRouter Anthropic 模型可能因"compiled grammar too large"而失败

无严格重试应该是限定在当前会话/提供商路径的 compat 恢复策略。

### Responses 和 Codex 自定义工具

Responses 和 Codex 都支持用于 `apply_patch` 的自由格式自定义 grammar 工具。自定义 grammar 工具不强制请求级 `parallel_tool_calls`;Codex
`responsesLite` 在存在工具时单独禁用请求级并行工具调用。Responses 另外:

- 以不同方式清理 schema
- 隔离无效的 enum/const schema 矛盾
- 将孤儿工具输出修复为助手笔记
- 为孤儿工具调用合成占位输出

Codex 在发送前应用自己的请求转换。

### 工具选择

发出 `tool_choice` 前:

- 确认端点支持它
- 如果强制选择不受支持,将强制选择降级为 `auto`
- 没有发出工具时丢弃 `tool_choice: "none"`
- 如果具名工具被过滤掉,丢弃强制的具名工具选择

### 通过 LiteLLM/Bedrock 的 Anthropic

- 如果历史包含工具调用/结果且 `context.tools` 未定义,发送 `tools: []` 作为哨兵。
- 如果 `context.tools = []`,将其视为显式选择退出,不发出哨兵。

### Mistral / Devstral

- 工具调用 id 必须正好是 9 个字母数字字符。
- 某些流程在工具结果之后、下一条用户消息之前需要合成的助手桥接。

### 自定义工具输出

Responses/Codex 必须记住某个调用是否是 `custom_tool_call`;配对的
输出则必须是 `custom_tool_call_output`,而不是 `function_call_output`。

### MiniMax 兼容流式参数

工具参数可以以对象形式流式传输,而不是 JSON 字符串。深度合并对象
增量,然后发出一个最终的 concat-safe JSON 增量。

## 6. 安全转换消息和重放历史

- **System/developer 角色.** 推理模型可能要求 `developer`。某些提供商
  不支持 `developer`,必须降级为 `user`。某些拒绝多条 system 消息,需要合并。
- **Responses 系统提示词.** Responses 通常使用顶层 `instructions`。
  支持 `developer` 的推理模型将系统提示词作为 developer 消息内联。
- **助手内容.** 某些 OpenAI 兼容后端会逐字镜像数组内容,
  因此助手内容被规范化为字符串。工具调用重放可能要求
  `content: ""` 或 `content: "."` 而不是 `null`。
- **思考重放.** 某些模型希望思考作为可见文本。其他模型需要
  提供商特定的推理字段。某些允许合成占位符;其他需要精确重放。
- **视觉.** 如果模型/提供商不能接受图像,将图像输入和
  工具结果图像转换为占位符。某些 Qwen/Dashscope 兼容模式是
  纯文本的,即使高层模型是多模态的。
- **原生 Responses 历史.** 原生提供商负载重放是模型绑定的。
  剥离或规范化外来的推理签名。共享代码规范化
  Responses 的管道分隔工具 id、哈希外来项 id,并且可以筛选
  推理历史。

## 7. 按提供商行为解码流,而不只是按 schema

- **通用 OpenAI 兼容流.** 保活块、仅角色增量,以及
  空的 `choices: []` 不是进展。空闲看门狗不得因它们而永远沉睡。
- **Mistral Medium 3.5 风格内容.** `delta.content` 可以是文本部分的数组/对象,
  而不是字符串;将其规范化为文本。
- **通过 NVIDIA/native/代理的 DeepSeek.** 某些端点将聊天模板
  标记(如 `<｜...｜>`)泄漏到可见内容中。需要缓冲,因为
  标记可能跨块拆分。
- **DeepSeek/模板泄漏工具调用.** 某些提供商在文本中泄漏工具调用标记,
  同时也产生结构化工具调用。标记修复属于流解码器策略,而不是端点业务逻辑。
- **MiniMax-M3 累积推理.** 推理增量可能是累积
  快照。按推理字段签名去重。
- **Responses 流.** 按 `output_index`、`item_id`、
  call-id 别名和带前缀的 `fc_` 别名路由并行项。容忍缺失的
  `content_part.added` 或 `output_item.added`。在终止
  事件时最终确定待处理的工具调用。
- **终止行为.** Chat Completions 可以在 `finish_reason` 加
  usage 之后中断。Responses 在 `response.completed` 或 `response.incomplete` 上中断。带 `stop` 的工具调用提升为 `toolUse`。Codex/Responses 的 `end_turn:false` 映射
  到 `pause_turn`。
- **Ollama 长度失败.** 没有可见内容的 `finish_reason: length`
  被视为上下文窗口失败,并映射为错误。

## 8. 保留用量和成本语义

- OpenRouter 的 `prompt_tokens_details.cache_write_tokens` 计费方式不同:
  从输入 token 中减去它,并作为 cache-write 用量发出。
- DeepSeek 原生 `prompt_cache_miss_tokens` 是计费的输入部分,不是
  单独的 cache-write 费用。不要重复计算它。
- GitHub Copilot 的 `premiumRequests` 必须在用量被填充或
  替换时幸存。
- Responses 和 Codex 都按已解析的服务层级调整成本,但 Codex 使用
  不同的乘数。

## 9. 在正确的边界实现恢复

- **严格工具回退.** `400`/`422` schema 或严格工具失败应在适当的
  会话作用域禁用严格工具,并以非严格方式重试。
- **OpenAI Responses 有状态回退.** 过期、无效或不支持的
  `previous_response_id` 重置链状态,并用完整上下文重试。零
  数据保留立即禁用链式调用。
- **Codex websocket 回退.** websocket 连接错误、过期套接字、
  连接限制、重试预算耗尽或不安全的部分输出可以
  触发重连或 SSE 重放。
- **Codex 空白工具循环断路器.** Codex 可以无限流式传输仅空白
  工具调用参数增量。限制事件/字符,丢弃退化
  的部分工具调用,并且只在安全时重试。
- **Codex `previous_response_id` 回退.** 过期或不支持的 id 是
  链断裂,用完整上下文重试,但仅针对 websocket,因为 SSE 从不
  链式。
- **内容之前的提供商重试.** Codex 只在用户可见内容发出之前重试可重试的提供商流
  错误。

## 10. 新约束的清单

在添加分支或 compat 字段之前,按顺序回答这些:

1. 这是端点家族行为、网关行为、模型行为还是请求
   上下文行为?
2. 它能否用现有的 `compat` 元数据表示?
3. 如果不能,新 compat 字段是否比提供商名分支更好?
4. 该字段需要提供商级默认值、模型级覆盖,还是两者都要?
5. 它是否与工具、图像、推理、有状态 Responses 链或
   服务层级交互?
6. 重试能否只在可见文本/工具调用之前发生?
7. 用量记账是否仍保留缓存读/写、计费输入、服务
   层级乘数,以及 Copilot `premiumRequests` 等提供商特定计数器?
