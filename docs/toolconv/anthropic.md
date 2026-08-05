# Anthropic Claude 工具调用(Messages API 内容块)

Anthropic 的 Claude 是封闭的托管模型系列,没有发布权重,因此无需设置 `--tool-call-parser` 标志。规范的函数调用约定是 **Messages API**(`POST /v1/messages`,请求头 `anthropic-version: 2023-06-01`):工具在顶层 `tools` 数组中声明,模型返回带 `stop_reason: "tool_use"` 的结构化 `tool_use` **内容块**,你通过 `user` 消息中的 `tool_result` 内容块把结果喂回去。只需包含 `tools` 参数(可选加 `tool_choice`)即可“启用”工具使用;随后 API 会注入工具使用系统提示词,并替你把模型输出解析回 JSON 块。这适用于所有当前模型(Claude Opus / Sonnet / Haiku 3.x、4、4.x),LiteLLM 等网关及第三方 Claude 兼容服务器也遵循同样约定。

在底层,模型被训练为输出 **XML** 函数调用语法(`<function_calls>` / `<invoke>` / `<parameter>`);API 会把你的 JSON Schema 工具序列化进系统提示词,并将模型的 XML 输出转换为 JSON `tool_use` 块。该底层格式在下面作为*次要*约定记录,连同更早的、现已退役的基于提示词的 **legacy XML** 格式(`<tool_name>` / `<parameters>` / `<function_results>`),后者早于 Messages API,在纯提示词式工具使用中仍会出现。

对任何解析器/渲染器而言,首要且权威的形式是 JSON 内容块格式。XML 仅供参考(如果从 token 级别重建提示词,它是唯一可见的东西)。

---

## 内容块类型与停止原因

Anthropic 的公开 API 中没有 token 级工具分隔符。基本单位是**内容块**:每个 `message.content` 都是类型化块的数组。工具调用新增两种块类型和一种停止原因;流式再增加一种增量类型。

| 条目 | 位置 | 形态 / 含义 |
| --- | --- | --- |
| `text` 块 | assistant 与 user | `{"type":"text","text":"..."}`。普通文本。assistant 可能在工具调用*之前*输出文本。 |
| `tool_use` 块 | assistant | `{"type":"tool_use","id":"toolu_...","name":"<tool>","input":{...}}`。函数调用。`input` 是**嵌套 JSON 对象**(已解析),符合工具的 `input_schema`。 |
| `tool_result` 块 | user | `{"type":"tool_result","tool_use_id":"toolu_...","content":<string \| block[]>,"is_error":<bool?>}`。执行结果,通过 `user` 消息发送回去。 |
| `server_tool_use` 块 | assistant | `{"type":"server_tool_use","id":"srvtoolu_...","name":"web_search","input":{...}}`。由 Anthropic 执行的服务器工具会发出此类块;你**无需**为它们返回 `tool_result`。 |
| `web_search_tool_result`(及类似块) | assistant | 服务器工具输出,由 Anthropic 在 assistant 轮次中内联注入。 |
| `thinking` / `redacted_thinking` 块 | assistant | 扩展思考推理块;带有 `signature`。在思考 + 工具组合使用时,必须跨轮次原样保留。 |
| `stop_reason: "tool_use"` | 响应顶层 | 模型调用了至少一个工具,正在等待结果。驱动 Agent 循环。 |
| `stop_reason: "end_turn"` | 响应顶层 | 自然完成(无工具调用);循环退出。 |
| 其它 `stop_reason` | 响应顶层 | `"max_tokens"`、`"stop_sequence"`、`"pause_turn"`(较长的服务器工具轮次,原样重发即可继续)、`"refusal"`、`"sensitive"`(被安全过滤器标记的输出)、`"model_context_window_exceeded"`(输出在上下文窗口处被截断,按 `max_tokens` 处理)。 |
| `id` 前缀 | — | 消息为 `msg_…`;客户端工具调用为 `toolu_…`;服务器工具调用为 `srvtoolu_…`。 |

流式新增以下 SSE 事件 / 增量类型(完整列表见[角色 / 通道](#角色--通道--轮次结构)与[工具调用格式](#工具调用格式)):

| 流式条目 | 形态 / 含义 |
| --- | --- |
| `message_start` | 携带 `Message` 骨架,`content` 为空,`stop_reason: null`。 |
| `content_block_start` | 在 `index` 处打开一个块。工具调用时为 `content_block.{type:"tool_use",id,name,input:{}}` —— `input` 以**空对象**开始。 |
| `content_block_delta` / `input_json_delta` | `{"type":"input_json_delta","partial_json":"<chunk>"}` —— `tool_use.input` 的**部分 JSON 字符串**片段。 |
| `content_block_delta` / `text_delta` | `{"type":"text_delta","text":"..."}`。 |
| `content_block_delta` / `thinking_delta`、`signature_delta` | 扩展思考内容 / 签名。 |
| `content_block_stop` | 在 `index` 处关闭块;此时累积的 `partial_json` 已完整,可以安全地 `JSON.parse`。 |
| `message_delta` | 顶层更新;携带最终的 `delta.stop_reason`(如 `"tool_use"`)和**累计** `usage`。 |
| `message_stop` | 流结束。 |
| `ping` / `error` | 心跳保活;`error`(如 `overloaded_error`)可能出现在流中途。 |

### Legacy XML 标签(基于提示词,早于 Messages API)

已退役的基于提示词格式使用这些标签。它们是嵌套元素标签(无属性),不同于现代的属性形式(`<invoke name="…">`)。已对照 Anthropic 归档的“Legacy tool use”文档核实(见[来源](#来源))。

| 标签 | 作用 | 备注 |
| --- | --- | --- |
| `<tools>` … `</tools>` | 工具声明 | 系统提示词中包裹所有 `<tool_description>` 条目的容器。 |
| `<tool_description>` | 工具声明 | 每个工具一个:包含 `<tool_name>`、`<description>`、`<parameters>`。 |
| `<tool_name>` | 两者 | 函数名(用于定义、调用和结果)。 |
| `<parameters>` / `<parameter>` | 定义 | `<parameters>` 包裹 `<parameter>` 条目,每个条目含 `<name>`、`<type>`、`<description>`。 |
| `<function_calls>` | 模型输出 | 包裹一个或多个 `<invoke>` 块。 |
| `<invoke>` | 模型输出 | 一次函数调用;包含 `<tool_name>` 及以 `<paramName>value</paramName>` 子标签组成的 `<parameters>` 块。 |
| `<function_results>` | 工具结果(回传) | 包裹 `<result>`(成功)或 `<error>`(失败)。 |
| `<result>` / `<stdout>` | 工具结果 | `<result>` 包含 `<tool_name>` + `<stdout>`;输出文本放在 `<stdout>` 中。 |
| `<error>` | 工具结果 | 函数出错时替代 `<result>`。 |
| `</function_calls>` | 停止序列 | 作为 `stop_sequence` 传入,使生成在调用后停止。 |
| `<scratchpad>` / `<answer>` | 模型输出 | 在 legacy 提示词中惯常用于思维链和最终回答。 |

---

## 角色 / 通道 / 轮次结构

Messages API 主要使用两个对话角色 `user` 和 `assistant`,交替出现。**没有**专门的 `tool`/`function` 角色,标准系统提示词是独立的顶层 `system` 参数(字符串或文本块数组)——不是消息角色。(Claude Opus 4.8+ 以及 Fable/Mythos 5 代还额外接受可选加入的会话中途 `system` **消息**角色,由 `mid-conversation-system-2026-04-07` beta 门控;否则只有 `user`/`assistant` 有效。)工具数据搭乘普通角色传输:

- `assistant` 消息包含 AI 生成的 `text`、`thinking` 和 `tool_use`(以及 `server_tool_use`)块。
- `user` 消息包含你的 `text`/`image`/`document` 内容和 `tool_result` 块。

没有名为“通道”的东西。与推理通道最接近的是扩展思考 `thinking` 内容块(带加密 `signature` 的一等块),它与用户可见的 `text` 块分开存放。当思考与工具同时启用时,工具调用轮次的 `thinking` 块必须在后续请求中原样传回。

Agent 循环以 `stop_reason` 为键:

1. 发送 `tools` 与用户消息。
2. Claude 以 `stop_reason: "tool_use"` 和至少一个 `tool_use` 块响应(前面可带 `text` 块)。
3. 执行每个工具;每次调用构建一个 `tool_result` 块。
4. 附加 assistant 消息**以及**携带全部 `tool_result` 块的 `user` 消息;重新发送。
5. 在 `stop_reason == "tool_use"` 期间重复;遇到 `end_turn`(或其他终止原因)时退出。

严格的排序规则(违反则返回 400):

- `tool_result` 块必须位于 `user` 消息 `content` 数组的**最前面**(其后才是任何文本)。
- 携带 `tool_result` 的 `user` 消息必须**紧随** assistant 的 `tool_use` 消息——中间不能有其它内容。
- 每个 `tool_use.id` 都必须在紧接着的消息里用 `tool_result.tool_use_id` 应答。

---

## 工具定义

工具通过顶层 `tools` 数组传入。每个用户定义(客户端)工具都是**扁平**对象——没有 `{"type":"function", "function":{…}}` 包装(那是 OpenAI 的)。字段:

- `name` —— 匹配 `^[a-zA-Z0-9_-]{1,64}$`。
- `description` —— 详细的纯文本(对工具调用质量影响最大的因素)。
- `input_schema` —— JSON Schema 对象(**不是** `parameters`),描述模型必须生成的输入。
- 可选:`cache_control`(提示词缓存断点)、`strict`(structured-outputs beta)、`eager_input_streaming`(细粒度工具流式 beta)。

```json
{
  "name": "get_weather",
  "description": "Get the current weather in a given location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string",
        "description": "The city and state, e.g. San Francisco, CA"
      },
      "unit": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "description": "The unit of temperature, either 'celsius' or 'fahrenheit'"
      }
    },
    "required": ["location"]
  }
}
```

Anthropic 模式的客户端工具(`bash`、`text_editor`、`computer`、`memory`)和服务器工具(`web_search`、`web_fetch`、`code_execution`、`tool_search`)则携带带版本的 `type`,如 `{"type": "web_search_20250305", "name": "web_search"}`。

### OMP 原生适配器 schema 归一化

原生 Anthropic 提供商不会原样转发 pi 工具的 JSON Schema。在放入 `input_schema` 之前,OMP 会保留以下关键字:

- 每个节点上:`$ref`、`$defs`、`$schema`、`definitions`、`type`、`enum`、`const`、`description`、`title`、`default` 和 `nullable`;
- 嵌套的 `anyOf` 和 `allOf`(根级组合器不保留,`oneOf` 在任何深度都不保留);
- 对象上:`properties`、`required` 和 `additionalProperties`;
- 数组上:`items`、`prefixItems` 和 `minItems`(仅当其值为 `0` 或 `1` 时);
- 字符串上:`format` 仅限 `date-time`、`time`、`date`、`duration`、`email`、`hostname`、`uri`、`ipv4`、`ipv6` 或 `uuid`。

其它约束——包括 `pattern`、字符串长度限制、数值范围、`maxItems`、不支持的格式和不支持的组合器——会被附加到该节点的 `description` 中。它们仍是模型可见的指引,但不再是机器强制的 schema 关键字。对象节点默认 `additionalProperties: false`;显式的 `true` 或带 schema 值的 `additionalProperties` 保持开放(空 schema 归一化为 `true`)。

OMP 仅对符合条件的内置工具(`bash`、`python`、`edit` 和 `find`)发送 `strict: true`,条件是:`PI_NO_STRICT` 和提供商兼容性/运行时回退都没有禁用严格工具、工具未选择退出、原始 schema 不含 `oneOf`、`allOf`、`$ref`、`patternProperties` 和 `propertyNames`,且每个对象都是闭合的。每次请求最多选 20 个严格工具,并共享 24 个可选属性与 16 次联合(union)使用的预算:可选预算耗尽后,另一个可选属性必须改用联合预算转换为必填且可空,否则该工具保持非严格。其它工具使用归一化后的非严格 schema。OMP 仅在模型兼容性数据和实际端点都支持时才发送 `eager_input_streaming: true`:Anthropic 第一方端点符合条件,显式配置了该能力的自定义端点也符合;若标准模型被路由到不合格的非 Anthropic 端点,则不发送。

`tool_choice` 控制调用(四种选项):

- `{"type":"auto"}` —— 由模型决定(`tools` 存在时的默认值)。
- `{"type":"any"}` —— 必须调用某个工具。
- `{"type":"tool","name":"get_weather"}` —— 必须调用该特定工具。
- `{"type":"none"}` —— 不使用工具(没有 `tools` 时的默认值)。

使用 `any` 或 `tool` 时,API 会预填充 assistant 轮次,因此 `tool_use` 块之前不会出现前置的自然语言文本。在 `tool_choice` 中加入 `"disable_parallel_tool_use": true` 可将每轮限制为一个工具。(扩展思考仅支持 `auto`/`none`。)

### API 如何将其转化为提示词(通往 XML 的桥梁)

当存在 `tools` 时,API 会用以下骨架构建工具使用系统提示词(依据“Define tools”核实):

```text
In this environment you have access to a set of tools you can use to answer the user's question.
{{ FORMATTING INSTRUCTIONS }}
String and scalar parameters should be specified as is, while lists and objects should use JSON format. Note that spaces for string values are not stripped. The output is not expected to be valid XML and is parsed with regular expressions.
Here are the functions available in JSONSchema format:
{{ TOOL DEFINITIONS IN JSON SCHEMA }}
{{ USER SYSTEM PROMPT }}
{{ TOOL CONFIGURATION }}
```

`{{ TOOL DEFINITIONS IN JSON SCHEMA }}` 是你的 `tools` 数组序列化成的 JSON Schema。`{{ FORMATTING INSTRUCTIONS }}` 是(未公开的)教模型带 `antml:` 命名空间前缀的 XML 语法的块(见[工具调用格式 → 底层 XML](#底层-xmlantml-命名空间的现代属性形式))。“用正则表达式解析”这一说明就是输出不必是良构 XML 的原因。

---

## 工具调用格式

你的应用消费的线上格式是 JSON。单次调用是 assistant 消息中的一个 `tool_use` 内容块,顶层带 `stop_reason: "tool_use"`:

```json
{
  "id": "msg_01Aq9w938a90dw8q",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    {
      "type": "text",
      "text": "I'll check the current weather in San Francisco for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA", "unit": "celsius" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 472, "output_tokens": 65 }
}
```

解析器需要知道的关键事实:

- `tool_use.input` 是已解析的**对象**,绝不是 JSON 字符串。
- 前置的 `text` 块可选且仅供参考;不要依赖它的措辞。
- 通过 `id` → `tool_use_id` 将调用与结果对应。

### 底层 XML(antml: 命名空间的现代属性形式)

在 API 转换之前,模型确实会输出一个 XML 块。当前(Claude 3+)形式基于属性:

```text
<function_calls>
<invoke name="get_weather">
<parameter name="location">San Francisco, CA</parameter>
<parameter name="unit">celsius</parameter>
</invoke>
</function_calls>
```

当前 Claude 模型会为这些标签加 `antml:` XML 命名空间前缀(如 `antml:function_calls`、`antml:invoke name="…"`、`antml:parameter name="…"`)。API 会剥离所有这些,只暴露 JSON `tool_use` 块;集成方应以 JSON 为目标,而非 XML。

### OMP `anthropic` 方言

OMP 作用于底层由提示词驱动的 XML,而非 Messages API 内容块。其渲染器始终输出上述无前缀的属性形式,将多次调用包进一个 `<function_calls>` 块,并把每个参数渲染为 `<parameter name="…">` 子元素。配合工具 schema 时,声明为字符串的参数以字面文本插入;其它值做 JSON 序列化。流式扫描器还接受 `antml:` 前缀标签、作为包装别名的 `<tool_calls>` 以及两种包装之外的裸 `<invoke>`。

由于这种 XML 没有调用 id,扫描器会自行铸造。它带状态地扫描流式文本,在每个参数体到达时发出 `toolArgDelta` 事件,并在 `</invoke>` 之后用 `toolEnd` 发布强制转换后的参数对象。参数值上限为 1,000,000 个 JavaScript 字符串代码单元;溢出会附加明确的截断后缀。JSON 样式的值用修复式解析,而 schema 声明为字符串的值保持字符串。启用 `parseThinking: true` 时,`<thinking>`、`<think>` 和 `<scratchpad>`(带前缀或不带前缀)变成思考事件;否则这些标签保持为可见文本。

`</invoke>` 门控 `toolEnd`,但并不门控规范调用的创建。一旦开头的 `<invoke name="…">` 发出了 `toolStart`,EOF 只会重置扫描器本地状态。在正常停止的流上,OMP 会保留该调用,把轮次改为 `toolUse`,即使没有收到 `toolEnd` 也可能派发它。已累积的任何 `toolArgDelta` 文本都会保留在调用中(不做关闭时的强制转换);没有累积参数文本的调用以 `{}` 运行。`length` 停止仍不可运行。

---

## 多次 / 并行工具调用

并行调用是默认行为。Claude 在**单条 assistant 消息中输出多个 `tool_use` 块**:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me check both cities." },
    {
      "type": "tool_use",
      "id": "toolu_01weather_sf",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA" }
    },
    {
      "type": "tool_use",
      "id": "toolu_02weather_nyc",
      "name": "get_weather",
      "input": { "location": "New York, NY" }
    }
  ]
}
```

你在**一条** `user` 消息中返回**所有**结果,每次调用一个 `tool_result`,结果在前:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01weather_sf",
      "content": "San Francisco: 68F, partly cloudy"
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_02weather_nyc",
      "content": "New York: 45F, clear skies"
    }
  ]
}
```

同一轮次内的调用**无序**,可以并发运行。如果两个批量调用恰好相互依赖,请在 `tool_result` 中以 `"is_error": true` 返回自然错误;Claude 会在后续轮次重新发出依赖的调用。(在 legacy XML 格式中,并行表现为一个 `<function_calls>` 内的多个 `<invoke>` 块。)

---

## 工具结果格式

结果就是 `user` 消息内的 `tool_result` 块:

- `tool_use_id`(必填)—— 它所应答的 `tool_use` 的 `id`。
- `content`(可选)—— 字符串,**或** `text`/`image`/`document` 块数组。空结果时省略。
- `is_error`(可选)—— 执行失败时为 `true`;在 `content` 中放入有用信息。

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "15 degrees"
    }
  ]
}
```

错误结果:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "ConnectionError: the weather service API is not available (HTTP 500)",
      "is_error": true
    }
  ]
}
```

富结果(文本 + 图像块):

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": [
        { "type": "text", "text": "15 degrees" },
        {
          "type": "image",
          "source": { "type": "base64", "media_type": "image/jpeg", "data": "/9j/4AAQSkZJRg..." }
        }
      ]
    }
  ]
}
```

服务器工具**不需要**你返回 `tool_result`——Anthropic 会执行它们并把结果内联注入 assistant 轮次。(Legacy XML 以 `<function_results><result><tool_name>…</tool_name><stdout>…</stdout></result></function_results>` 回传结果,失败时用 `<error>…</error>`。)

OMP 的提示词驱动方言不同于 Anthropic 的服务器工具行为。它把客户端结果渲染为:

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>15 degrees</stdout>
</result>
<error>
<tool_name>other_tool</tool_name>
<stderr>execution failed</stderr>
</error>
</function_results>
```

这种 XML 没有结果 id,因此结果按调用顺序关联。OMP 在成功和错误条目中都包含工具名,并且不把 `isError` 编码到任何其它地方。

---

## 端到端示例

一个完整的多轮天气对话。所有 JSON 均有效。

**请求 1 —— system + tools + 用户问题:**

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are a helpful weather assistant. Use the provided tools to answer.",
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "The city and state, e.g. San Francisco, CA" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "Unit for the temperature" }
        },
        "required": ["location"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "What's the weather in San Francisco?" }
  ]
}
```

**响应 1 —— assistant 请求调用工具(`stop_reason: "tool_use"`):**

```json
{
  "id": "msg_01Aq9w938a90dw8q",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    { "type": "text", "text": "I'll check the current weather in San Francisco for you." },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA", "unit": "celsius" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 472, "output_tokens": 65 }
}
```

**请求 2 —— 重放历史,附加 assistant 轮次和 `tool_result`:**

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are a helpful weather assistant. Use the provided tools to answer.",
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "The city and state, e.g. San Francisco, CA" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "Unit for the temperature" }
        },
        "required": ["location"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "What's the weather in San Francisco?" },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "I'll check the current weather in San Francisco for you." },
        {
          "type": "tool_use",
          "id": "toolu_01A09q90qw90lq917835lq9",
          "name": "get_weather",
          "input": { "location": "San Francisco, CA", "unit": "celsius" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
          "content": "15 degrees Celsius, partly cloudy"
        }
      ]
    }
  ]
}
```

**响应 2 —— assistant 的最终回答(`stop_reason: "end_turn"`):**

```json
{
  "id": "msg_01EeFG3hijk2lmno4PqrSt",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    { "type": "text", "text": "It's currently 15 degrees Celsius and partly cloudy in San Francisco." }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 530, "output_tokens": 18 }
}
```

### 工具调用的流式(SSE)形态

同一个工具调用的流式形态。注意 `tool_use` 以空的 `input` 打开,参数以 `input_json_delta.partial_json` 片段到达,最终的 `stop_reason` 落在 `message_delta` 中。此块逐字转载自 Anthropic 的流式文档:

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_014p7gG3wDgGV9EUtLvnow3U","type":"message","role":"assistant","model":"claude-opus-4-8","stop_sequence":null,"usage":{"input_tokens":472,"output_tokens":2},"content":[],"stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Okay"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" let"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"'s"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" check"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01T1x1fJ34qAmk2tNTrN7Up6","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"San"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" Francisc"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"o,"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" CA\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}

event: message_stop
data: {"type":"message_stop"}
```

重组:把给定 `index` 的所有 `partial_json` 拼接起来(`"" + "{\"location\":" + " \"San" + " Francisc" + "o," + " CA\"}"` → `{"location": "San Francisco, CA"}`),然后在该块的 `content_block_stop` 处 `JSON.parse`。工具使用还支持细粒度流式(按工具的 `eager_input_streaming`)以得到更细的 `partial_json` 分块。

---

## OpenAI 兼容 API 映射

Anthropic 把工具整合进 `user`/`assistant` 消息结构,而不是使用 OpenAI 独立的 `tool` 角色和 `function` 包装。逐字段对照:

| 概念 | Anthropic Messages API | OpenAI Chat Completions |
| --- | --- | --- |
| 工具定义包装 | flat `{"name","description","input_schema"}` in `tools[]` | `{"type":"function","function":{"name","description","parameters"}}` in `tools[]` |
| 工具 schema 键 | `input_schema` (JSON Schema) | `parameters` (JSON Schema) |
| “必须调用工具” | `tool_choice:{"type":"any"}` / `{"type":"tool","name":…}` | `tool_choice:"required"` / `{"type":"function","function":{"name":…}}` |
| 禁用并行调用 | `tool_choice:{…,"disable_parallel_tool_use":true}` | `parallel_tool_calls:false` (top level) |
| assistant 调用容器 | `tool_use` **content block** in `content[]` | `tool_calls[]` on the assistant `message` |
| 调用 id | `tool_use.id` = `toolu_…` | `tool_calls[].id` = `call_…` |
| 函数名 | `tool_use.name` | `tool_calls[].function.name` |
| 函数参数 | `tool_use.input` = **nested JSON object** (parsed) | `tool_calls[].function.arguments` = **JSON string** (must `JSON.parse`) |
| “已调用工具”信号 | `stop_reason:"tool_use"` | `finish_reason:"tool_calls"` |
| 结果消息角色 | `user` message containing `tool_result` block(s) | dedicated `{"role":"tool",…}` message(s) |
| 结果 ↔ 调用关联 | `tool_result.tool_use_id` | `tool` message `tool_call_id` |
| 结果负载 | `tool_result.content` = string **or** block array (text/image/document) | `tool` message `content` = string |
| 错误结果 | `tool_result` with `is_error:true` | no dedicated flag; encode in `content` |
| 系统提示词 | top-level `system` param (no `system` role) | `{"role":"system",…}` message |
| 流式参数 | `input_json_delta.partial_json` fragments | `tool_calls[].function.arguments` string deltas |

转换注意事项:

- **对象 vs 字符串:**要输出 OpenAI 形态,用 `JSON.stringify(tool_use.input)`;要把 OpenAI 形态消费进 Anthropic,用 `JSON.parse(arguments)`。
- **角色重塑:**把 N 条 OpenAI `tool` 消息合并为一条含 N 个 `tool_result` 块的 Anthropic `user` 消息(排在任何文本之前),反之亦然。
- **Anthropic 自定义工具没有 `type:"function"`** 包装;转换时按需增删。
- id 前缀不同(`toolu_` 对比 `call_`);绝不要假定一种格式的 id 在另一种格式中有效。

---

## 解析注意事项与陷阱

- **`input` 是对象,不是字符串。**与 OpenAI 的 `arguments` 不同,不要对非流式响应中的 `tool_use.input` 做 `JSON.parse`——它已经是对象。只有*流式* `partial_json` 片段才是字符串。
- **流式工具参数需要重组。**`tool_use` 的 `content_block_start` 总是 `input: {}`。按 `index` 缓冲 `partial_json`,只在 `content_block_stop` 时解析;流中途的片段本身不是有效 JSON(如 `{"location":`)。当前模型每次发出一个完整的键/值,因此会看到突发和间隙。
- **`stop_reason` 的位置。**流式中,`message_start` 的 `stop_reason` 是 `null`,最终值(`"tool_use"`/`"end_turn"`)出现在 `message_delta` 而非 `message_stop` 中。`message_delta` 里的 `usage` 是**累计**的。
- **排序被强制。**`tool_result` 块必须位于其 `user` 消息最前,并且必须紧随 assistant 的 `tool_use` 消息;每个 `tool_use.id` 都需要匹配的 `tool_result.tool_use_id`,否则会得到 HTTP 400(“找到没有紧随其后的 tool_result 块的 tool_use id”)。
- **`tool_choice:any`/`tool` 抑制前言。**API 会预填充 assistant 轮次,因此 `tool_use` 之前不会出现前置 `text` 块——不要编写期待解释性文本的解析器。
- **并行结果放在一条消息里。**把并行 `tool_result` 拆分到多条 `user` 消息会破坏约定;请一起发送。
- **把结果内容视为不可信。**工具结果可能携带间接提示词注入;让它们留在 `tool_result` 块内,绝不提升为 `system`/`user` 文本。
- **服务器工具不同。**`server_tool_use` / `web_search_tool_result` 块由 Anthropic 产生并消费;绝不为它们合成 `tool_result`。`stop_reason:"pause_turn"` 表示原样重发响应,让较长的服务器工具轮次继续。
- **扩展思考 + 工具。**跨轮次原样保留 `thinking`/`redacted_thinking` 块(连同它们的 `signature`);思考开启时,强制 `tool_choice`(`any`/`tool`)会被拒绝。
- **输出不是有效 XML。**底层模型输出由 Anthropic 用正则表达式解析,而非 XML 解析器(“输出不要求是有效 XML”)。如果你在 token 级别重建提示词,不要假定良构性;依赖 API 返回的 JSON。
- **Legacy 与现代 XML 是两套不同的标签。**Legacy:`<invoke>` + 子元素 `<tool_name>` + 带按名子标签的 `<parameters>`;结果在 `<function_results>/<result>/<stdout>` 中。现代:`<invoke name="…">` + `<parameter name="…">`。混用会导致解析错误。Legacy 格式还要求把 `</function_calls>` 作为 `stop_sequence` 传入,且未针对 Claude 3+ 优化。

### Legacy XML 格式(次要,基于提示词——已完全核实,现已退役)

在 Messages API 之前,工具的定义和调用完全发生在提示词中。Anthropic 归档的“Legacy tool use”文档对其做了逐字规定。

工具定义(位于系统提示词中的 `<tools>` 块内):

```text
<tool_description>
<tool_name>get_weather</tool_name>
<description>
Retrieves the current weather for a specified location.
Returns a dictionary with two fields:
- temperature: float, the current temperature in Fahrenheit
- conditions: string, a brief description of the current weather conditions
Raises ValueError if the provided location cannot be found.
</description>
<parameters>
<parameter>
<name>location</name>
<type>string</type>
<description>The city and state, e.g. San Francisco, CA</description>
</parameter>
</parameters>
</tool_description>
```

模型输出的调用(并行调用为多个 `<invoke>`;把 `</function_calls>` 作为 `stop_sequence` 传入):

```text
<function_calls>
<invoke>
<tool_name>get_weather</tool_name>
<parameters>
<location>San Francisco, CA</location>
</parameters>
</invoke>
</function_calls>
```

回传到下一条 user 轮次的结果:

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>
59 degrees Fahrenheit, partly cloudy
</stdout>
</result>
</function_results>
```

错误结果:

```text
<function_results>
<error>
error message goes here
</error>
</function_results>
```

legacy 系统提示词前言(逐字引自归档文档)为:

```text
In this environment you have access to a set of tools you can use to answer the user's question.
You may call them like this:
<function_calls>
<invoke>
<tool_name>$TOOL_NAME</tool_name>
<parameters>
<$PARAMETER_NAME>$PARAMETER_VALUE</$PARAMETER_NAME>
...
</parameters>
</invoke>
</function_calls>

Here are the tools available:
<tools>
...one <tool_description> per tool...
</tools>
```

Legacy 备注:没有内置工具(一切皆由提示词定义);Anthropic 建议 ≤3–5 个工具;模型惯例上把推理包在 `<scratchpad>` 中、把最终输出包在 `<answer>` 中。该格式“已过时”且“未针对 Claude 3 优化”——当前任何场景都应使用 JSON Messages API。

---

## 来源

- 工具使用概览 —— https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview
- 工具使用的工作原理 —— https://docs.claude.com/en/docs/agents-and-tools/tool-use/how-tool-use-works
- 定义工具(工具 schema、`input_schema`、`tool_choice`、构造的系统提示词)—— https://docs.claude.com/en/docs/agents-and-tools/tool-use/define-tools
- 处理工具调用(`tool_use`/`tool_result`、`is_error`、排序规则)—— https://docs.claude.com/en/docs/agents-and-tools/tool-use/handle-tool-calls
- 并行工具使用 —— https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use
- 流式消息(SSE 事件、`input_json_delta`、逐字的工具使用流)—— https://docs.claude.com/en/docs/build-with-claude/streaming
- Messages API 参考(`stop_reason` 枚举、响应形态、`tools`)—— https://docs.claude.com/en/api/messages
- Legacy tool use(已归档;逐字 XML 标签和提示词)—— https://web.archive.org/web/20240528231249/https://docs.anthropic.com/en/docs/legacy-tool-use ;另有在线本地化副本,如 https://docs.anthropic.com/de/docs/legacy-tool-use(英文路径现已重定向到工具使用概览)
