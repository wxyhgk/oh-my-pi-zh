# OpenAI Harmony 响应格式

Harmony 是 OpenAI 为其开源权重 `gpt-oss` 模型(`gpt-oss-20b`, `gpt-oss-120b`,2025 年 8 月发布)训练的响应格式。它定义了对话信封、多通道的推理/回答分离,以及函数调用的线上语法。缺少它,这些模型无法被正确提示。该格式刻意模仿 OpenAI *Responses* API(角色、通道、收件人),而不是更旧的 Chat Completions 形状。

token 使用 `o200k_harmony` 编码生成(`o200k_base` BPE 词表外加一组 Harmony 特殊 token;见下表)。参考渲染器/解析器是 Rust crate `openai-harmony`(Python 绑定:`pip install openai-harmony`;编码名 `HarmonyEncodingName.HARMONY_GPT_OSS`)。

只有当你自己构建推理循环时,才需要处理原始 Harmony。通过 OpenAI 兼容端点提供服务时,服务器会替你处理:

- **Ollama / LM Studio / HuggingFace**:Harmony 在内部应用;你发送普通的 OpenAI 风格 JSON。
- **vLLM**:`vllm serve openai/gpt-oss-120b --enable-auto-tool-choice --tool-call-parser openai --reasoning-parser openai_gptoss`。注意工具调用解析器标志是 `openai`(不是 `harmony`)。vLLM 还通过 `/v1/responses` 端点暴露一条 Harmony 原生路径。
- **SGLang**:`python3 -m sglang.launch_server --model-path openai/gpt-oss-20b --reasoning-parser gpt-oss --tool-call-parser gpt-oss`(在 NVIDIA Dynamo 分离模式中:`--dyn-tool-call-parser harmony --dyn-reasoning-parser gpt_oss`)。

随 gpt-oss 权重提供的聊天模板从标准的 `messages`/`tools` 数组渲染出这些相同的 token 序列。

## 特殊 token

所有 Harmony 控制 token 都具有字面形式 `<|type|>`(ASCII 竖线 `|`,U+007C —— 没有 unicode 变体)。它们是 `o200k_harmony` 中真正的单个 token,而不是会被 BPE 切分的文本。结构上有意义的包括:

| Token(原文) | Token ID | 用途 |
| :--------------- | :------- | :------ |
| `<\|start\|>`     | `200006` | 开始一条消息;其后紧跟头部(角色、可选收件人/通道/内容类型)。 |
| `<\|end\|>`       | `200007` | 结束一条完整成形的消息。 |
| `<\|message\|>`   | `200008` | 头部 → 内容转换。其后的所有内容(直到停止/结束 token)都是消息主体。 |
| `<\|channel\|>`   | `200005` | 引入头部的通道字段(`analysis` / `commentary` / `final`)。 |
| `<\|constrain\|>` | `200003` | 在工具调用头部标记内容类型 / 约束解码格式(例如 `<\|constrain\|>json`)。 |
| `<\|return\|>`    | `200002` | 停止 token:模型已完成其最终回答。仅用于解码时(见规范化说明)。 |
| `<\|call\|>`      | `200012` | 停止 token:模型正在输出一次工具调用,并希望它被执行。 |

`<|return|>` 和 `<|call|>` 是两个有效的生成停止 token —— 遇到任一即停止推理。

该编码还定义了(同一 `o200k_harmony` 块,ID `199998`–`200013`)`<|startoftext|>`(199998)、`<|endoftext|>`(199999),以及保留槽位 `<|reserved_200000|>`, `<|reserved_200001|>`, `<|reserved_200004|>`, `<|reserved_200009|>`–`<|reserved_200011|>`, `<|reserved_200013|>`,外加一个批量保留范围 `<|reserved_200014|>`…`<|reserved_201088|>`。渲染器还知道名称 `<|refusal|>`, `<|untrusted|>`, `<|end_untrusted|>`, `<|meta_end|>`,但它们不属于已提交的 gpt-oss 词表,不会出现在正常流量中。

## 角色 / 通道 / 轮次结构

**消息信封。** 每条消息都是:

```text
<|start|>{header}<|message|>{content}<|end|>
```

`{header}` 总是以角色开头,并可能携带可选的收件人(`to=...`)、通道和内容类型。一条完成的消息以 `<|end|>` 结束;一条正在生成的 assistant 消息则改为以停止 token(`<|return|>` 或 `<|call|>`)结束。

**角色**(五个)。用于解决冲突的指令层级为 `system` > `developer` > `user` > `assistant` > `tool`。

| 角色 | 用途 |
| :--- | :------ |
| `system` | 身份、知识截止 / 当前日期、推理努力程度、有效通道声明、内置工具。**不是**面向用户的“system prompt”。 |
| `developer` | 常规的“system prompt”:指令 + `# Tools` 函数声明 +(可选的)结构化输出 schema。 |
| `user` | 最终用户输入。 |
| `assistant` | 模型输出。携带一个通道,对于工具调用还携带收件人。 |
| `tool` | 已执行工具的输出。消息的*作者/角色是工具自身的名称*(例如 `functions.get_current_weather`),而不是字面的 `tool` 一词。 |

**通道**(仅 assistant 输出;每个 assistant 消息上通道都是必需的):

| 通道 | 用途 |
| :------ | :------ |
| `analysis` | 原始思维链(推理)。不受与 `final` 相同的安全标准约束;不要展示给最终用户。内置的 `python`/`browser` 调用通常放在这里。 |
| `commentary` | 函数工具调用,以及在调用多个工具之前用户可见的“开场白”(行动计划)。 |
| `final` | 面向用户的回答。 |

**推理努力程度**在 system 消息中设置为 `Reasoning: high`(或 `medium` / `low`;默认为 medium)。模型将 CoT 输出到 `analysis`,把回答输出到 `final`。

**CoT 结转规则。** 在下一轮次,如果上一个 assistant 轮次以 `final` 消息结束,则丢弃之前的 `analysis` 消息。例外是进行中的工具调用轮次:工具调用之前的 `analysis` **必须**连同工具结果一起回喂,以便模型继续推理(`openai-harmony` 渲染器通过 `RenderConversationConfig { auto_drop_analysis: true }` 实现这一点)。

## 工具定义

函数工具在 **developer** 消息中于 `# Tools` 部分之下、TypeScript 风格的 `namespace functions { ... }` 内进行广告。(内置的 `browser`/`python` 工具则改为在 **system** 消息中于各自的 `# Tools` / `## browser` / `## python` 标题下声明。)渲染器按以下规则把每个 JSON Schema 转换为 TS 类型:

- 无参函数 → `type name = () => any;`
- 有参函数 → 单个参数命名为 `_`,其对象类型内联:`type name = (_: { ... }) => any;`
- 返回类型总是 `any`。
- 属性 `description` 变成字段*上方*一行的 `//` 注释;JSON Schema 的 `title` 渲染为 `// TITLE`,后跟一行的 `//` 空注释;`examples` 渲染为 `// Examples:`,然后是 `// - "value"` 行。
- 可选(非 `required`)字段带尾部 `?`。`default` 渲染为尾部的 `// default: <value>` 注释;`enum` 变成 `"a" | "b"` 联合;`oneOf` 变成多行 `|` 联合;JSON `integer` 映射为 TS `number`。
- 函数定义之间以一个空行分隔;块以 `} // namespace functions` 结束。

如果 developer 消息没有指令文本,则省略 `# Instructions` 标题,消息只有 `# Tools` 块。当定义了任何函数时,system 消息会获得路由行 `Calls to these tools must go to the commentary channel: 'functions'.`

developer 消息逐字示例(指令 + 两个函数),与渲染器输出完全一致:

```text
<|start|>developer<|message|># Instructions

Use a friendly tone.

# Tools

## functions

namespace functions {

// Gets the location of the user.
type get_location = () => any;

// Gets the current weather in the provided location.
type get_current_weather = (_: {
// The city and state, e.g. San Francisco, CA
location: string,
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

// Gets the current weather in the provided list of locations.
type get_multiple_weathers = (_: {
// List of city and state, e.g. ["San Francisco, CA", "New York, NY"]
locations: string[],
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

} // namespace functions<|end|>
```

## 工具调用格式

函数调用是一条 **assistant** 消息,位于 **commentary** 通道,通过收件人 `to=functions.<name>` 发给工具,以 JSON 参数作为主体,以 `<|call|>` 停止 token 终止。

收件人可能出现在头部的*角色部分*或*通道部分* —— 两者都是有效的 Harmony,解析器都接受。模型通常把它放在通道部分。pi 渲染器省略可选的 content-type 标记:

```text
<|start|>assistant<|channel|>commentary to=functions.get_current_weather<|message|>{"location":"San Francisco, CA"}<|call|>
```

一些 Harmony 序列化器包含显式的 JSON 内容类型,并把收件人放在角色部分:

```text
<|start|>assistant to=functions.get_current_weather<|channel|>commentary <|constrain|>json<|message|>{"location":"San Francisco, CA"}<|call|>
```

参数主体是一个原始 JSON 对象。可选的 `<|constrain|>json` 内容类型表示 JSON(也是约束/基于语法的解码的挂钩);内容类型也可以是裸词,例如 `code`(在内置工具中可见)。内置工具只在通道和收件人上不同:它们通常在 `analysis` 上渲染,收件人为 `browser.search` / `browser.open` / `browser.find`,或始终为 `python`。

### OMP `harmony` 方言行为

OMP 输出上面的第一种形式:没有 `<|constrain|>` 标记,收件人在通道部分,JSON 参数紧凑。由于 Harmony 不携带调用 id,OMP 在收到时合成一个。有状态扫描器接受收件人出现在任一头部部分,从暴露的工具名中剥离前导的 `functions.`,并把任何非空的、非 `assistant` 的收件人当作工具调用(包括 `browser.search` 等内置工具)。

参数累积到 `<|call|>`, `<|end|>` 或 `<|return|>` 为止,并用 JSON 修复解析。空参数,或修复后仍无法解析的输入,变成 `{}` 而不是扫描器错误。扫描器在头部完成时输出 `toolStart`,仅在消息终止符处输出 `toolEnd`;`analysis` 主体块作为思考增量流式输出,而普通的 assistant `commentary`/`final` 主体作为文本流式输出。非 assistant 消息(包括工具结果信封)会被此输出扫描器跳过。

一个重要的自有扫描器边界情况与规范 Harmony 不同。在带收件人的头部到达 `<\|message\|>` 之后,OMP 已经输出了 `toolStart`。如果普通流式路径排空了主体字节,然后流在没有 `<\|call\|>`, `<\|end\|>` 或 `<\|return\|>` 的情况下结束,`flush()` 不会输出 `toolEnd`,也不会收回 start。Harmony 扫描器不输出参数增量,因此即使看到了未终止的主体文本,保留的规范调用仍然只有 `{}`。在正常停止时,OMP 把轮次改为 `toolUse`,并可能派发那个空调用。这是一种宽松且不安全的恢复行为,不是有效的 Harmony 终止符规则。

## 多个 / 并行工具调用

Harmony 没有专门的“并行”包装。多个调用只是多条连续的消息。模型可能先输出一个可选的**开场白** —— 一条 *用户可见*的 `commentary` 通道 assistant 消息(与 `analysis` 不同,它意在展示)—— 然后每个函数一条工具调用消息。每个单独的调用仍然以自己的 `<|call|>` 停止 token 结束,因此一个在 `<|call|>` 处停止的主机一次收集一个调用、执行、把结果回喂,然后继续:

```text
<|channel|>analysis<|message|>{reasoning}<|end|><|start|>assistant<|channel|>commentary<|message|>**Action plan**:
1. Generate an HTML file
2. Generate a JavaScript for the Node.js server
3. Start the server
---
Will start executing the plan step by step<|end|><|start|>assistant<|channel|>commentary to=functions.generate_file<|message|>{"template": "basic_html", "path": "index.html"}<|call|>
```

## 工具结果格式

已执行工具的输出作为一条消息回喂,其*作者/角色是工具的名称*,回发给 assistant(`to=assistant`),位于 **commentary** 通道,以 `<|end|>` 结束。这是规范(推荐)形式:

```text
<|start|>functions.get_current_weather to=assistant<|channel|>commentary<|message|>{"sunny": true, "temperature": 20}<|end|>
```

头部顺序是 `{toolname} to=assistant<|channel|>commentary`。内置工具结果遵循相同形状(例如 `<|start|>browser.search to=assistant<|channel|>commentary<|message|>{"result": "https://openai.com/"}<|end|>`)。当消息未设置通道/收件人时,渲染器接受的最小形式只是 `<|start|>{toolname}<|message|>{output}<|end|>`,但输出完整的 `to=assistant<|channel|>commentary` 头部才是参考解析器能往返的形式,也是推荐做法。追加结果后,通过输出下一个 `<|start|>assistant` 重新开始生成。

OMP 始终渲染上面所示的完整规范结果头部,并原样传递 `result.text`。Harmony 没有专门的错误位,因此 `isError` 不会单独表示;失败必须在结果负载中描述。

## 端到端示例

完整的多轮天气对话:system + developer 提示词 → 用户提问 → assistant analysis CoT → assistant commentary 工具调用 → 工具结果 → assistant 最终回答。这是一条连续拼接的单一 token 流(头部内的换行只是为了可读性,位于顶层消息之间;实际上消息之间没有分隔符地拼接)。

```text
<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: 2025-06-28

Reasoning: high

# Valid channels: analysis, commentary, final. Channel must be included for every message.
Calls to these tools must go to the commentary channel: 'functions'.<|end|><|start|>developer<|message|># Instructions

Use a friendly tone.

# Tools

## functions

namespace functions {

// Gets the current weather in the provided location.
type get_current_weather = (_: {
// The city and state, e.g. San Francisco, CA
location: string,
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

} // namespace functions<|end|><|start|>user<|message|>What is the weather like in SF?<|end|><|start|>assistant<|channel|>analysis<|message|>User wants the weather in San Francisco. Use get_current_weather.<|end|><|start|>assistant<|channel|>commentary to=functions.get_current_weather<|message|>{"location":"San Francisco, CA"}<|call|><|start|>functions.get_current_weather to=assistant<|channel|>commentary<|message|>{"sunny": true, "temperature": 20}<|end|><|start|>assistant<|channel|>final<|message|>It's sunny and about 20°C in San Francisco right now.<|return|>
```

轮次边界:

- 主机在 `<|call|>` 处停止生成,解析 `commentary` 调用,运行 `get_current_weather`,并追加 `functions.get_current_weather to=assistant` 结果消息。
- 然后它追加 `<|start|>assistant` 并恢复。前面的 `analysis` 消息被保留(该轮次以工具调用结束,而不是 `final`),因此模型可以继续推理。
- 生成在 `<|return|>` 处停止。当这一轮次被持久化到*更晚*轮次的历史中时,把尾部的 `<|return|>` 规范化为 `<|end|>`(见下一条说明)。

**`<|return|>` 规范化。** `<|return|>` 只是解码时的停止 token。当你把 assistant 的回答存进历史以供下一轮次使用时,把尾部的 `<|return|>` 替换为 `<|end|>`,这样每条存储的消息都是良构的 `<|start|>{header}<|message|>{content}<|end|>`。(对于监督训练目标,以 `<|return|>` 结束示例是正确的。)

## 兼容 OpenAI 的 API 映射

当服务器(vLLM/SGLang/Ollama)把 Harmony 桥接到 Chat Completions JSON 时:

- **`finish_reason`**:生成在 `<|call|>` 处停止时为 `tool_calls`;在 `<|return|>` 处停止时为 `stop`。
- **`message.tool_calls[]`**:每个 `commentary` `to=functions.*` 调用对应一个条目。`function.name` 是剥离了 `functions.` 命名空间的收件人(`get_current_weather`)。`function.arguments` 是 **JSON 字符串**(字面的 `<|message|>` 主体),与 OpenAI 语义一致 —— 不是解析后的对象。
- **`tool_call_id`**:Harmony 没有原生调用 ID。服务器合成一个(例如 `call_abc123`),并负责把后续的 `role:"tool"` 消息关联回 Harmony 工具结果信封(收件人 `to=functions.<name>` / 调用顺序)。
- **工具结果消息**(`{"role":"tool","tool_call_id":...,"content":...}`)被渲染为 `<|start|>{toolname} to=assistant<|channel|>commentary<|message|>{content}<|end|>`。服务器把 `tool_call_id` 映射回原始函数名,以构建 `{toolname}` 作者。
- **推理**:`analysis` 通道文本以 `reasoning_content`(vLLM/SGLang)或 `reasoning`/`thinking` 字段呈现,通常不会在后续请求中回显。`final` 通道文本是正常的 `message.content`。`commentary` 开场白如果呈现,也映射为 assistant 内容。
- **OMP 记录渲染:** `developer`, `user` 和其他非 assistant 角色直接映射为 Harmony 信封。Assistant 消息按顺序输出:一条完整的 `analysis` 消息用于思考,一条完整的 `final` 消息用于可见文本,然后每个工具调用一条 `commentary` 调用消息。因此伴随工具调用的可见文本被渲染为 `final`,而不是 commentary 开场白。工具结果序列成为连续的规范工具作者信封。
- **原生服务器/聊天模板编译:** 在原生 vLLM/SGLang 路径上,请求的 `tools` / `tool_choice` 由服务器的聊天模板编译进 developer 消息的 `namespace functions { ... }` 块;system 消息获得 commentary 路由行。
- **OMP 自有方言广告:** 当选择 OMP 的 `harmony` 方言时,OMP 会移除原生提供商工具,并把其通用的精简 `<tools>` JSON 目录以及 Harmony 格式指南追加到系统提示词。此路径不使用规范的 developer 消息命名空间作为其工具广告。

## 解析说明与注意事项

- **两个停止 token。** 始终在 `<|return|>` 和 `<|call|>` 两者上停止。只停在 `<|return|>` 上会越过工具调用;只停在 `<|end|>` 上对 assistant 生成是错误的。
- **收件人位置不定。** `to=functions.<name>` 可能出现在角色部分(`<|start|>assistant to=...<|channel|>commentary`)或通道部分(`<|channel|>commentary to=...`)。解析器必须同时接受两者。
- **通道在 assistant 消息上是必需的**;system 消息甚至会提醒模型(“Channel must be included for every message.”)。缺少通道的输出是畸形输出。
- **工具作者,而非 `tool`。** 工具结果消息的角色是工具的*名称*(`functions.get_current_weather`),而不是字面字符串 `tool`。把 `functions.x` 拆成命名空间 + 函数是解析器的工作。
- **CoT 丢弃是有条件的。** 只有当上一个 assistant 轮次以 `final` 结束时才丢弃 `analysis`。丢弃紧挨 `<|call|>` 之前的 `analysis` 会破坏多步工具推理。
- **`arguments` 是字符串。** 不要双重编码。`<|message|>` 之后的主体已经是序列化后的 JSON;直接把它作为 `arguments` 字符串传递。
- **内容类型变体。** `<|constrain|>json` 是可选的。如果存在,它是元数据,而不是有效 JSON 的保证。用约束解码 / 你自己的语法来强制 JSON 有效性 —— 仅凭提示格式不能保证 schema 符合性(同样的告诫也适用于结构化输出 `# Response Formats`)。
- **流式。** 使用有状态解析器(库附带 `StreamableParser`),以便增量重建不完整的 UTF-8 以及头部/通道/收件人/内容类型字段;天真的子串扫描会错误处理多字节切分和可选头部字段。`parse_messages_from_completion_tokens` 接受 `strict=True|False` —— `strict=False` 容忍一些畸形头部。不要把尾部的停止 token 传给解析器。
- **编码。** 使用 `o200k_harmony`(`o200k_base` 秩外加上面的 Harmony 特殊项)。在编码和解码时都把 `<|...|>` token 当作原子的特殊 token;把它们当作普通文本编码会产生不同的秩并破坏流。

## 来源

- OpenAI Cookbook —— OpenAI harmony 响应格式:https://cookbook.openai.com/articles/openai-harmony
- openai/harmony 渲染器(README):https://github.com/openai/harmony
- openai/harmony 规范格式指南:https://raw.githubusercontent.com/openai/harmony/main/docs/format.md
- openai/harmony 特殊 token 注册表(`o200k_harmony` ID):https://raw.githubusercontent.com/openai/harmony/main/src/tiktoken_ext/public_encodings.rs
- openai/harmony 渲染器/解析器测试与 schema→TS 逻辑:https://raw.githubusercontent.com/openai/harmony/main/src/tests.rs , https://raw.githubusercontent.com/openai/harmony/main/src/encoding.rs
- openai/harmony 测试夹具(逐字的渲染流):`test-data/test_render_functions_with_parameters.txt`, `test-data/test_does_not_drop_if_ongoing_analysis.txt`, `test-data/test_tool_response_parsing.txt`, `test-data/test_streamable_parser.txt`, `test-data/test_browser_and_function_tool.txt`(https://github.com/openai/harmony/tree/main/test-data)
- vLLM 工具调用 / gpt-oss 解析器标志:https://docs.vllm.ai/en/latest/features/tool_calling/
- SGLang gpt-oss 用法(`--tool-call-parser gpt-oss`):https://docs.sglang.io/basic_usage/gpt_oss.html
