# Qwen3 工具调用格式(Hermes 约定)

阿里巴巴 **Qwen3** 系列(`Qwen/Qwen3-*`:密集 `0.6B–32B` 与 MoE `30B-A3B`/`235B-A22B`;与 `Qwen2.5-*` 和 `QwQ-32B` 同一模板线)的工具调用约定。它就是 **Hermes** 约定 —— NousResearch 的 Hermes 2 Pro 首创、被 Qwen 原样采用的 XML+JSON 格式,外加一长串社区微调模型。信封是 **ChatML**:每个轮次是 `<|im_start|>{role}\n{body}<|im_end|>\n`。可用工具在 system 轮次内的 `<tools>…</tools>` 块中广告(每行一个 JSON 规范);模型把每次调用输出为 `<tool_call>\n{json}\n</tool_call>` 块,其 `arguments` 是**嵌套的 JSON 对象**(不是字符串化的 JSON);工具结果在 `<tool_response>…</tool_response>` 内回喂。混合推理由 `<think>…</think>` 承载。该格式随模型自带的 `chat_template` 一起提供,因此推理服务器无需额外模板即可启用它:vLLM 使用 `--enable-auto-tool-choice --tool-call-parser hermes`(搭配 `--reasoning-parser deepseek_r1` 以拆分思考);SGLang 提供对应的解析器(例如 `--reasoning-parser qwen3`)。

已对照:Qwen 的规范函数调用指南(`qwen.readthedocs.io/en/latest/framework/function_call.html`,完整阅读,包括 Qwen-Agent 与 vLLM 部分)、`Qwen/Qwen3-8B` 的 `tokenizer_config.json` 中逐字节精确的 `chat_template` 字段(HF resolve 缓存提交 `b968826d9c46dd6066d109eabc6255188de91218`,已在本地用 Jinja2 渲染以获得下方的原始流)及其 `added_tokens_decoder`(用于 token ID)、NousResearch `Hermes-Function-Calling` README,以及 vLLM 工具调用文档(`hermes` 解析器 + Qwen 模型部分)。

## 特殊 token

只有三个 ChatML 标记是“特殊”控制 token(`special=true`,会被 `skip_special_tokens` 跳过)。推理与工具标记也是单个词表 token(各一个 ID),但注册为 `special=false`,即它们以普通文本渲染,**不会**被 `skip_special_tokens` 剥离。`<tools>`/`</tools>` 包装**没有**专用 token —— 它是会被 BPE 切分成多个 token 的纯文本。ID 来自 `Qwen/Qwen3-8B` 的 `added_tokens_decoder`。

| Token(原文) | ID | `special` | 用途 |
|---|---|---|---|
| `<\|im_start\|>` | 151644 | true | 轮次开始;其后紧跟角色名 + `\n` |
| `<\|im_end\|>` | 151645 | true | 轮次结束;聊天停止 token |
| `<\|endoftext\|>` | 151643 | true | 基础 EOS / pad token |
| `<think>` | 151667 | false | 打开推理块 |
| `</think>` | 151668 | false | 关闭推理块 |
| `<tool_call>` | 151657 | false | 打开一次工具调用 |
| `</tool_call>` | 151658 | false | 关闭一次工具调用 |
| `<tool_response>` | 151665 | false | 打开一条工具结果 |
| `</tool_response>` | 151666 | false | 关闭一条工具结果 |
| `<tools>` … `</tools>` | — | — | system 轮次中工具列表周围的纯文本包装(不是单个 token) |

精确性说明:
- 所有标记都使用 ASCII 竖线 `|`(U+007C)与 ASCII 尖括号。Qwen3 **没有**全角(`｜` U+FF5C)或 `▁`(U+2581)变体 —— 那是 DeepSeek/SentencePiece 的领域,不是 Qwen。
- `<|im_start|>` 与 `<|im_end|>` 是仅有的对切分轮次重要的 token。由于 `<tool_call>`, `</tool_call>`, `<tool_response>`, `<think>`, `</think>` 是 `special=false`,它们在 `skip_special_tokens=True` 解码后仍然幸存,这正是基于正则的 `hermes` 解析器能从解码文本中恢复它们的原因。
- 模型卡确认 `</think>` = token `151668`(被参考解析片段 `output_ids[::-1].index(151668)` 使用)。

## 角色 / 通道 / 轮次结构

ChatML。每条消息渲染为:

```text
<|im_start|>{role}
{body}<|im_end|>
```

- 角色:`system`, `user`, `assistant`, `tool`。没有单独的“通道”概念;唯一的子流是 assistant 轮次内的 `<think>` 推理块。
- `<|im_end|>\n` 终止每个轮次。当 `add_generation_prompt=True` 时,提示词以 `<|im_start|>assistant\n` 结束,模型从那里继续。
- **System 轮次:** 如果调用方提供 `system` 消息,它就成为第一轮。当存在 `tools` 时,工具广告**合并进**同一个 system 轮次(先是用户的 system 文本,然后 `\n\n`,然后是 `# Tools` 块 —— 见下文)。Qwen3 在没有给定 system 消息时不注入默认系统提示词。
- **工具结果轮次使用 `user` 信封。** Qwen3 的模板把每条 `role: "tool"` 消息映射为携带 `<tool_response>` 块的 `<|im_start|>user` 轮次(连续的工具消息合并为一个 user 轮次)。这与经典 Hermes 2 Pro 不同 —— 后者为结果使用专门的 `<|im_start|>tool` 轮次;Qwen 把它们折叠进 `user`。
- **思考/推理:** 承载于 assistant 轮次开头的 `<think>…</think>`(参见「解析说明」中的开关与历史重渲染规则)。

## 工具定义

工具在 system 轮次内广告。模板输出固定的开场白,然后每个工具对象用 `tool | tojson`(`json.dumps(..., ensure_ascii=False)`)序列化,各自**独占一行**,然后是固定的收尾。每个列表元素都是完整的 OpenAI 工具对象 `{"type": "function", "function": {...}}`(带有 JSON-Schema `parameters` 对象)。Qwen3 产生的精确、逐字包装:

```text
<|im_start|>system
{optional original system content}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_current_temperature", "description": "Get current temperature at a location.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location"]}}}
{"type": "function", "function": {"name": "get_temperature_date", "description": "Get temperature at a location and date.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "date": {"type": "string", "description": "The date to get the temperature for, in the format \"Year-Month-Day\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location", "date"]}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
```

- 如果第一条消息是 `system` 消息,其内容放在 `# Tools` 之前(用空行分隔);否则轮次直接以 `# Tools` 开始。
- 尾部指令是提示词的**字面**部分,包括占位行 `{"name": <function-name>, "arguments": <args-json-object>}`(那些尖括号 token 是指令,不是输出的内容)。
- 版本说明:原始 Hermes 2 Pro 系统提示词额外嵌入了 `FunctionCall` pydantic schema 行(`{"title": "FunctionCall", "type": "object", "properties": {"name": …, "arguments": …}}`)。Qwen3 删掉了那一行;上面的包装正是 Qwen3 输出的内容。

## 工具调用格式

模型把每次调用输出为一个 `<tool_call>` 行、一个单行 JSON 对象,然后是 `</tool_call>`。最小的单次调用:

```text
<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA", "unit": "celsius"}}
</tool_call>
```

- `arguments` 是**嵌套的 JSON 对象**,不是 JSON 编码的字符串。线上形式是 `"arguments": {"location": "..."}` —— 绝不是 `"arguments": "{\"location\": ...}"`。(模板通过 `tojson` 渲染 dict 参数;只有当调用方把 `arguments` 存成预序列化字符串时,它才会原样通过。)
- 调用对象恰好有两个键:`name`(字符串)与 `arguments`(对象)。线上没有每次调用的 ID —— OpenAI 风格的 `tool_call_id` 由服务器铸造,而不是模型(参见「API 映射」)。
- 工具调用的 assistant 轮次也可以在第一个 `<tool_call>` 之前包含自然语言的 `content`;模板会在该内容与第一次调用之间插入一个 `\n`。

## 多个 / 并行工具调用

并行调用在单个 assistant 轮次内作为连续的 `<tool_call>…</tool_call>` 块输出,每个块之间以换行分隔:

```text
<|im_start|>assistant
<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA"}}
</tool_call>
<tool_call>
{"name": "get_temperature_date", "arguments": {"location": "San Francisco, CA, USA", "date": "2024-10-01"}}
</tool_call><|im_end|>
```

解析器按输出顺序把它们返回为 `tool_calls[0]`, `tool_calls[1]`, …。应用必须执行它们,并按相同顺序为每个调用返回一个 `<tool_response>`。

## 工具结果格式

每个已执行的结果都包裹在 `<tool_response>…</tool_response>` 中。Qwen3 把它们放在 **`user`** 轮次内,并把连续的工具结果**合并**到一个轮次中(每个结果一个 `<tool_response>` 块,以换行分隔,单个闭合 `<|im_end|>`):

```text
<|im_start|>user
<tool_response>
{"temperature": 26.1, "location": "San Francisco, CA, USA", "unit": "celsius"}
</tool_response>
<tool_response>
{"temperature": 25.9, "location": "San Francisco, CA, USA", "date": "2024-10-01", "unit": "celsius"}
</tool_response><|im_end|>
```

- 标签之间的主体是工具的返回值(通常是 JSON 字符串,但允许任意文本)。函数名**不会**在 Qwen3 的 `<tool_response>` 内重复 —— 顺序把结果与调用对应起来。(经典 Hermes 2 Pro 则是在 `tool` 轮次下把 `{"name": ..., "content": ...}` 嵌套在 `<tool_response>` 内;Qwen3 的模板在 `user` 轮次下输出裸内容。)
- 在 OpenAI API 层,结果消息是 `{"role": "tool", "content": "...", "tool_call_id": "..."}`;模板只把其 `content` 渲染进 `<tool_response>` 块。

## 端到端示例

**非思考模式**(`enable_thinking=False`)下的完整多轮天气对话,与 `apply_chat_template` 为实时流程渲染的完全一致。禁用思考时,每个生成步骤都会在 `<|im_start|>assistant\n` 之后注入一个空的 `<think>\n\n</think>\n\n`;然后模型输出其工具调用 / 最终回答。可复制粘贴、逐字节精确:

```text
<|im_start|>system
You are a helpful assistant. Current Date: 2024-09-30.

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_current_temperature", "description": "Get current temperature at a location.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location"]}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
<|im_start|>user
What's the temperature in San Francisco now?<|im_end|>
<|im_start|>assistant
<think>

</think>

<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA", "unit": "celsius"}}
</tool_call><|im_end|>
<|im_start|>user
<tool_response>
{"temperature": 26.1, "location": "San Francisco, CA, USA", "unit": "celsius"}
</tool_response><|im_end|>
<|im_start|>assistant
<think>

</think>

The current temperature in San Francisco is 26.1°C.<|im_end|>
```

在**思考模式**(`enable_thinking=True`,默认)下,生成提示词改为以裸 `<|im_start|>assistant\n` 结束,模型自己在 `<tool_call>` 之前产生 `<think>…真实推理…</think>` 块。(重新渲染存储的历史时,模板只为最后一条 assistant 消息或携带 `reasoning_content` 的消息保留 `<think>` 块,并从更早的轮次剥离推理 —— 参见「解析说明」。)

## 兼容 OpenAI 的 API 映射

使用 `--enable-auto-tool-choice --tool-call-parser hermes` 时,vLLM 把原始流转换为标准 Chat Completions 响应:

- `finish_reason`:轮次以工具调用结束时为 `"tool_calls"`(否则为 `"stop"`)。
- `message.role`:`"assistant"`;`message.content`:纯工具调用轮次为 `null`(调用前的任何散文成为 `content`)。
- `message.tool_calls[]`:每个 `<tool_call>` 块一个条目,每个:
  - `id`:服务器生成,例如 `"chatcmpl-tool-924d705adb044ff88e0ef3afdd155f15"`(模型不输出 ID)。
  - `type`:`"function"`。
  - `function.name`:调用的 `name`。
  - `function.arguments`:API 边界处的 **JSON 字符串**,例如 `'{"location": "San Francisco, CA, USA"}'`。线上格式是嵌套对象,但服务器在这里把它重新序列化为字符串(使用前 `json.loads(...)`),与 OpenAI 和 Qwen-Agent 一致。
- 结合思考与 `--reasoning-parser deepseek_r1` 时,`<think>…</think>` 内容被拆分到 `message.reasoning_content` 并从 `content` 中移除。
- 回喂结果:为每个结果追加 `{"role": "tool", "content": <result>, "tool_call_id": <id-from-the-call>}`。`tool_call_id` 把结果与其调用关联起来(Qwen3 的模板渲染时忽略该 id —— 顺序才是模型看到的 —— 但 API 仍然要求它)。

两个调用查询返回的 assistant 消息示例:

```text
finish_reason='tool_calls'
message.content = None
message.tool_calls = [
  {id:'chatcmpl-tool-924d…', type:'function', function:{name:'get_current_temperature', arguments:'{"location": "San Francisco, CA, USA"}'}},
  {id:'chatcmpl-tool-7e30…', type:'function', function:{name:'get_temperature_date',   arguments:'{"location": "San Francisco, CA, USA", "date": "2024-10-01"}'}},
]
```

## omp / pi 转换器行为

仓库的 `qwen3` 方言是一个**自有带内转换器**。用 `PI_DIALECT=qwen3`(或等效的 Agent 配置)选择它。当存在工具时,Agent 会把 Qwen3 格式指南与精简工具目录追加到系统提示词,移除原生提供商工具,把更早的调用与结果改写为这种语法的文本,并把流式输出扫描回规范的 pi 工具调用事件。`hermes` 仍然是一个可单独选择的方言,尽管两者输出相同的 `<tool_call>` 内嵌 JSON 基本约定。

目录当前的家族亲和辅助函数把每个包含 `qwen` 的模型 id 映射到 `qwen3`,包括 Qwen3-Coder。对于 Coder 端点,设置 `tools.format=native`(或等效的原生工具设置),并在服务端点本身配置其 `qwen3_xml` 解析器。`qwen3_xml` 不是 OMP 自有的方言,因此不是有效的 `tools.format` 值。

omp 渲染器总是写嵌套的 `arguments` 对象,并把并行调用渲染为换行分隔。结果成为合成 user 历史消息内以换行分隔的 `<tool_response>` 块。扫描器铸造一个 id(`ptc_…`),并一旦前导 JSON 包含完整的字符串 `name` 就输出 `toolStart`。它等待 `</tool_call>` 才输出 `toolEnd`,并且不流式输出参数增量。闭合时使用共享的修复 JSON 解析器。为兼容起见,它也接受字符串化的 `arguments` 值并再解析一次,尽管自有渲染器从不输出那种形状。完成的字符串解析失败或非对象参数规范化为 `{}`;无法恢复名称的已完成外层对象会被消费而不创建调用。

如果 EOF 在名称被恢复之后、`</tool_call>` 之前到达,则不会输出 `toolEnd`,但 `toolStart` 创建的规范调用会以空参数幸存,并可能在正常停止时被派发。从未产生名称的畸形输入不会产生调用。

思考解析默认启用:`<think>…</think>` 变成思考事件,并从可见文本中排除。创建扫描器的调用方可以设置 `parseThinking: false`,此时思考标记作为普通文本保留。

## 解析说明与注意事项

- **参数对象 vs 字符串:**线上 `arguments` 是嵌套 JSON 对象;OpenAI 层把它作为 JSON 字符串交回。读取原始流的代码必须解析对象;读取 API 的代码必须 `json.loads` 字符串。不要双重编码。
- **`<tools>` 不是 token。** 只能指望 `<|im_start|>`/`<|im_end|>`(以及 `*tool_call*`/`*tool_response*`/`*think*` 单个 token)是原子的。`<tools>`/`</tools>` 是纯文本。
- **正则/流式解析:**vLLM `hermes` 解析器(`vllm/tool_parsers/hermes_tool_parser.py`, `Hermes2ProToolParser`)以字面 `<tool_call>` / `</tool_call>` 子串为键并对主体做 JSON 解码,支持每轮多个块。在流式中,它从 `<tool_call>` 缓冲,直到能增量解析 `name` 然后是 `arguments`;部分参数 JSON 作为参数增量输出。第一个 `<tool_call>` 之前的文本作为普通内容流式输出。
- **思考开关:**`enable_thinking=False`(通过 OpenAI API 传 `chat_template_kwargs={"enable_thinking": False}`,或 `tokenizer.apply_chat_template(..., enable_thinking=False)`)会在生成提示词中注入空的 `<think>\n\n</think>\n\n`,硬性抑制推理。启用思考时,user/system 消息中的软开关 `/think` 与 `/no_think` 会按轮次切换。Qwen3 不鼓励贪婪解码(重复风险)。
- **历史重渲染不对称:**当 `apply_chat_template` 重新渲染存储的对话时,它只为最后一条 assistant 消息或携带 `reasoning_content` 的消息输出 `<think>` 块;更早轮次的推理被丢弃。因此存储的中间工具调用 assistant 轮次不显示 `<think>` 块,而产生它的实时生成步骤(非思考模式下)前缀有一个。推理只在当前多步工具序列内(最后一次真实用户查询之后)被保留。
- **推理模型 + 停止词模板:**Qwen 警告不要对 Qwen3 使用 ReAct 风格的停止词工具模板,因为推理文本可能包含停止词并破坏解析 —— 改用这个原生 Hermes 模板。
- **健壮性:**该格式由提示词/模板驱动,因此可能出现畸形输出(截断的 JSON、缺失 `</tool_call>`、散文混入调用,或字符串化参数)。vLLM 可能根据其解析器路径回退到 content;omp 的自有扫描器则消费已识别的块,并在外层 JSON/名称无法恢复时不输出调用。使用 vLLM 原生工具时,命名 / `required` 工具选择可以路由到 vLLM 的结构化输出后端,但自有模式不发送原生提供商工具定义,因此不能依赖该后端。
- **版本/范围:**这个 `hermes` 模板覆盖 `Qwen3-*`, `Qwen2.5-*` 与 `QwQ-32B`。它**不**覆盖 `Qwen3-Coder`,后者使用不同的 XML 方案,由服务引擎的 `qwen3_xml` 解析器解析。OMP 没有 `qwen3_xml` 自有方言;使用 `tools.format=native` 并在端点配置该解析器。

## 来源

- Qwen 函数调用指南:https://qwen.readthedocs.io/en/latest/framework/function_call.html
- Qwen3-8B 聊天模板 + token ID(`tokenizer_config.json`, `chat_template` + `added_tokens_decoder`):https://huggingface.co/Qwen/Qwen3-8B/resolve/main/tokenizer_config.json(已通过 HF resolve 缓存提交 `b968826d9c46dd6066d109eabc6255188de91218` 验证)
- Qwen3-8B 模型卡(思考模式、`enable_thinking`、`</think>`=151668):https://huggingface.co/Qwen/Qwen3-8B
- NousResearch Hermes-Function-Calling(该约定的起源):https://github.com/NousResearch/Hermes-Function-Calling
- vLLM 工具调用文档(`hermes` 解析器、Qwen 模型、自动工具选择):https://docs.vllm.ai/en/latest/features/tool_calling/
