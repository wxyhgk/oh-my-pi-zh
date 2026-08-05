# GLM-4.5 / GLM-4.6 工具调用格式

智谱 AI / Z.ai 的 **GLM-4.5** 系列(`zai-org/GLM-4.5` 355B-A32B 与 `zai-org/GLM-4.5-Air` 106B-A12B,`model_type: "glm4_moe"`)的原生工具调用约定,**GLM-4.6** 与其逐字节共享。与大多数系列使用的“标签内嵌 JSON”约定不同,GLM 将每次工具调用输出为一个 **XML 风格**的块:`<tool_call>{name}` 后跟交替出现的 `<arg_key>`/`<arg_value>` 元素对,以 `</tool_call>` 结束。提示词是由 `[gMASK]<sop>` 开头的 GLM 风格序列,带有轮次标记 `<|system|>`, `<|user|>`, `<|assistant|>`, `<|observation|>`。推理服务器通过解析器加推理解析器把原始流转换为 OpenAI 风格的 `tool_calls`:vLLM 与 SGLang 都提供 `--tool-call-parser glm45 --reasoning-parser glm45`(vLLM 另外还需要 `--enable-auto-tool-choice`)。工具调用与推理完全由随附的 `chat_template.jinja` 驱动;思考模式默认开启,可通过 `chat_template_kwargs={"enable_thinking": False}` 按请求禁用。

本文档已对照以下来源进行验证:HF 仓库中的权威 `chat_template.jinja`(以 raw 方式获取,并在本地用 Jinja2 **渲染** —— `trim_blocks=True, lstrip_blocks=True`,以及 transformers 的 `tojson` 过滤器 —— 以生成下方的逐字节精确流)、`tokenizer_config.json` 与 `generation_config.json`(用于精确的 token ID 与停止 token)、模型卡,以及 vLLM(`Glm4MoeModelToolParser`)与 SGLang(`Glm4MoeDetector`)的解析器源码。HF 的 `resolve`/`blob` 网页路径会重定向到模型卡 API;逐字节精确的源码通过 `resolve/main/...:raw` 缓存获得(模板提交 `cbb2c7cfb52fa128a9660cb1a7a78e017899e115`)。GLM-4.5 与 GLM-4.6 的 `chat_template.jinja` 文件完全相同(内容哈希一致,均为 `41478957…`)。

## 特殊 token

token ID 来自 `tokenizer_config.json`(`added_tokens_decoder`)。注意其中的区分:轮次/角色标记注册为 **special** token,而结构性的工具调用与思考标签各自是词表中一个专用 token,但标记为 **`special: false`**(它们以普通文本形式输出/打印,而不会像控制 token 一样被剥离)。

| Token(原文) | ID | `special` | 用途 |
|---|---|---|---|
| `[gMASK]` | 151331 | true | GLM 前缀 / 空白填充哨兵;每个提示词的第一个 token |
| `<sop>` | 151333 | true | “Start of piece(片段开始)” —— 紧跟在 `[gMASK]` 之后打开序列 |
| `<eop>` | 151334 | true | “End of piece(片段结束)”(聊天模板不会输出) |
| `<\|system\|>` | 151335 | true | 打开 system 轮次(以及注入的 tools 轮次) |
| `<\|user\|>` | 151336 | true | 打开 user 轮次(同时也是 EOS id —— 见下文) |
| `<\|assistant\|>` | 151337 | true | 打开 assistant 轮次 / 生成提示词 |
| `<\|observation\|>` | 151338 | true | 打开工具结果(observation)轮次(同时也是 EOS id) |
| `<\|endoftext\|>` | 151329 | true | 文本结束;`eos_token` 与 `pad_token` |
| `<think>` | 151350 | false | 打开 assistant 轮次内的推理区间 |
| `</think>` | 151351 | false | 关闭推理区间 |
| `<tool_call>` | 151352 | false | 打开一次工具调用;函数名在同一行紧随其后 |
| `</tool_call>` | 151353 | false | 关闭一次工具调用 |
| `<arg_key>` | 151356 | false | 打开参数名元素 |
| `</arg_key>` | 151357 | false | 关闭参数名元素 |
| `<arg_value>` | 151358 | false | 打开参数值元素 |
| `</arg_value>` | 151359 | false | 关闭参数值元素 |
| `<tool_response>` | 151354 | false | 在 observation 轮次内包裹一条工具结果 |
| `</tool_response>` | 151355 | false | 关闭一条工具结果 |
| `/nothink` | 151360 | true | 追加到用户文本末尾以抑制思考的软开关 |

精确性说明:
- 所有竖线均为 ASCII `|`(U+007C);GLM 不使用全角 `｜`(U+FF5C)或 `▁`(U+2581)变体(与 DeepSeek 不同)。请精确复现 `<|system|>`, `<|user|>`, `<|assistant|>`, `<|observation|>`,而 `[gMASK]` 使用字面方括号。
- 由于 `<tool_call>`, `<arg_key>`, `<arg_value>`, `<tool_response>`, `<think>`(及其闭合标签)各自恰好映射到**一个** token ID,它们在流中每个各占一个 token —— 但因为 `special: false`,它们经过去 token 化后会以纯文本形式往返。因此解析器在解码文本中把它们当作字面子串来匹配,而不是当作控制 token id。
- `eos_token_id` 是一个**列表**:`[151329, 151336, 151338]` = `<|endoftext|>`, `<|user|>`, `<|observation|>`(来自 `generation_config.json`)。工具调用轮次就是这样结束的:`</tool_call>` 之后模型输出 `<|observation|>`,它本身是一个 EOS id,因此生成停止,服务器报告一次工具调用(参见「轮次结构」)。

## 角色 / 通道 / 轮次结构

每个提示词都以字面的双 token 前缀 `[gMASK]<sop>` 开头(后面没有换行)。随后各轮次拼接在一起,每轮由其角色标记引入;渲染的历史中没有每轮单独的终止 token(下一个标记,或生成期间的 EOS id,即为一轮的结束)。

- **System**(`<|system|>`):角色标记、换行,然后是消息文本。当提供 `tools` 时,会**首先**渲染一个合成的 tools system 轮次,位于任何用户提供的 system 轮次之前(两者是各自独立的 `<|system|>` 块 —— 参见「工具定义」)。
- **User**(`<|user|>`):角色标记、换行,然后是文本。如果 `enable_thinking` 为 false,会在用户文本末尾追加字面的 `/nothink`(除非它已经以 `/nothink` 结尾)。
- **Assistant**(`<|assistant|>`):角色标记,然后是推理区间和/或可见内容和/或工具调用。推理区间为 `\n<think>{reasoning}</think>`;可见内容在其后单独一行;工具调用以 `<tool_call>…</tool_call>` 块紧随其后。
- **工具结果**(`<|observation|>`):角色标记,引入一个或多个 `<tool_response>…</tool_response>` 块(参见「工具结果格式」)。

思考 / 推理通道:
- 推理位于 assistant 轮次内的 `<think>…</think>` 中。`--reasoning-parser glm45` 将其提取到独立的 `reasoning_content` 字段;可见的回答是 `</think>` 之后的内容。
- **只保留最后一条用户消息之后的 assistant 轮次的推理。** 模板将更早的每个 assistant 轮次渲染为空的 `<think></think>`,并丢弃其 `reasoning_content`(或 `content` 中内嵌的任何 `<think>…</think>`)。这样可在后续轮次中避免过时的思维链进入上下文。
- 既没有保留推理也没有显式思维链的 assistant 轮次会渲染为 `\n<think></think>`(空),然后是内容/工具调用。

生成提示词(`add_generation_prompt=True`):
- **思考模式(默认):**提示词以裸 `<|assistant|>` 结束;模型接着输出 `\n<think>…</think>`,然后是它的回答或工具调用。
- **非思考模式**(`enable_thinking=false`):提示词以 `<|assistant|>\n<think></think>` 结束,预填一个空的推理区间,让模型直接给出回答。

工具调用轮次如何终止:没有专门的“工具调用后停止”token。模型输出 `</tool_call>`,然后输出 `<|observation|>`(token 151338),它是三个 EOS id 之一,因此解码停止。服务器检查文本,发现 `<tool_call>`,返回 `finish_reason: "tool_calls"`。

## 工具定义

当请求携带 `tools` 时,模板会前置一个 `<|system|>` 轮次,其中包含固定的开场白、包裹在 `<tools>…</tools>` 中的工具列表,以及对输出格式的字面描述。每个工具用 `tool | tojson(ensure_ascii=False)` 序列化 —— 即 **整个 OpenAI 工具对象原样输出**,包括 `{"type": "function", "function": {…}}` 包装,使用默认 JSON 间距(`", "` / `": "`)。每行一个工具。

```text
<|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call>
```

上面 `<tool_call>{function-name}` / `<arg_key>` / `<arg_value>` 这几行是**提示词文本**的一部分(模型被要求遵循的格式规范),而不是示例调用。这个 tools 轮次仅在 `tools` 非空时输出,并由下一个角色标记(例如用户提供的 `<|system|>` 或第一个 `<|user|>`)隐式结束,两者之间没有空行。

## 工具调用格式

模型将一次调用输出为 `<tool_call>` 块:函数**名与开始标签在同一行**,一个换行,然后每个参数一个 `<arg_key>…</arg_key>` + `<arg_value>…</arg_value>` 对,以 `</tool_call>` 结束。最小的单次调用(思考模式下的 assistant 生成;为真实起见一并展示推理):

```text
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
```

调用结构与值的编码(这是最容易出错的部分):

- 函数名是 `<tool_call>` 与第一个换行之间的文本 —— 它周围**没有**包裹标签,`<tool_call>` 之后也**没有**空格。
- 每个参数是两个相邻的元素:`<arg_key>name</arg_key>`,然后是 `<arg_value>value</arg_value>`,通常每行一对。
- **参数值并非统一为 JSON。** 模板将每个值渲染为 `value | tojson(ensure_ascii=False) if value is not string else value`:
  - **string** 值**原样输出,不带引号** → `<arg_value>Beijing</arg_value>`(而非 `"Beijing"`)。
  - **非 string** 值(数字、布尔、null、对象、数组)以 JSON 编码 → `<arg_value>3</arg_value>`, `<arg_value>true</arg_value>`, `<arg_value>{"k": 1}</arg_value>`。
- **零参数**调用没有配对:函数名后跟换行和闭合标签 —— `<tool_call>get_time\n</tool_call>`。

由于字符串值失去了引号,解析器必须逐参数决定是进行 JSON 解码还是把值当作字面字符串。两个参考解析器都通过查阅工具的 JSON Schema 来完成:如果参数类型为 `string`,则原样取用原始文本;否则对值进行 JSON 解码(带有 `ast.literal_eval` 与原始字符串回退)。模型经过训练会遵循 schema,因此恰好当参数为 string 类型时输出裸字符串。

## 多个 / 并行工具调用

同一轮次中的两次或更多调用以连续的 `<tool_call>…</tool_call>` 块输出,块之间用单个换行分隔(整个集合外没有包裹元素)。两个参数类型混合的并行调用的原始 assistant 输出:

```text
<think>Two cities. Call get_weather twice in parallel.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Shanghai</arg_value>
<arg_key>days</arg_key>
<arg_value>3</arg_value>
<arg_key>verbose</arg_key>
<arg_value>true</arg_value>
</tool_call>
```

注意 `Beijing`/`Shanghai`/`celsius`(string)是裸文本,而 `3`(数字)和 `true`(布尔)是 JSON 字面量。解析器使用非贪婪的 `<tool_call>.*?</tool_call>` 正则切分,因此支持任意数量的调用;每个调用成为 `tool_calls[]` 中的一个独立条目。

## 工具结果格式

结果在 **observation** 轮次中返回。单个结果:`<|observation|>` 标记、一个换行,然后结果包裹在 `<tool_response>` / `</tool_response>` 中:

```text
<|observation|>
<tool_response>
{"temperature": 26, "unit": "celsius", "condition": "Sunny"}
</tool_response>
```

标签之间的内容**原样**插入(调用方通常传入 JSON 字符串,但允许任意文本)。对于一组并行调用的**多个**结果,`<|observation|>` 标记只出现**一次**,每个结果都有自己的 `<tool_response>` 块(连续的 `tool` 角色消息合并到单个 observation 轮次下):

```text
<|observation|>
<tool_response>
{"temperature": 26, "condition": "Sunny"}
</tool_response>
<tool_response>
{"temperature": 30, "condition": "Cloudy"}
</tool_response>
```

聊天模板**只**读取工具消息的 `content` —— 它不查看任何 `tool_call_id`。因此结果**按位置 / 顺序**与调用对应,而不是通过内嵌的 id(GLM 的线上格式不携带每次调用的 id;参见「API 映射」)。

## 端到端示例

一个完整的多轮天气对话。以下是本地渲染的精确流;轮次内的换行是字面的,轮次之间首尾相接(标记之间没有分隔符)。

**阶段 1 —— 喂给模型的提示词**(已设置 `tools`,一条先前的 system 消息,`add_generation_prompt=True`,思考模式):

```text
[gMASK]<sop><|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call><|system|>
You are a helpful assistant.<|user|>
What's the weather in Beijing?<|assistant|>
```

**Assistant 生成**(模型输出;它以输出 `<|observation|>` 结束,这是一个 EOS id,因此解码在此停止;服务器返回 `finish_reason: "tool_calls"`):

```text
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
```

**阶段 2 —— 下一轮次的提示词**,在追加 assistant 工具调用轮次与工具结果之后,再 `add_generation_prompt=True`:

```text
[gMASK]<sop><|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call><|system|>
You are a helpful assistant.<|user|>
What's the weather in Beijing?<|assistant|>
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call><|observation|>
<tool_response>
{"temperature": 26, "unit": "celsius", "condition": "Sunny"}
</tool_response><|assistant|>
```

**最终 assistant 生成**(自然语言回答,以 `<|endoftext|>` 终止;`finish_reason: "stop"`):

```text
<think>Got it, 26C and sunny.</think>
It's 26°C and sunny in Beijing right now.
```

上面可以看到两个微妙之处:(1)assistant 工具调用轮次的推理在阶段 2 中之所以**保留**,只是因为它是最后一条用户消息之后的段落;如果其后还有另一个用户轮次,那个 `<think>…</think>` 就会被重新渲染为空。(2)工具调用轮次与 observation 轮次直接相邻(`</tool_call><|observation|>`),observation 又与下一个 assistant 标记相邻(`</tool_response><|assistant|>`)。

对于**非思考**模式,用户文本携带软开关,生成提示词预填一个空的思考区间:

```text
<|user|>
Hi there/nothink<|assistant|>
<think></think>
```

## 兼容 OpenAI 的 API 映射

在启用服务器解析器(`--tool-call-parser glm45 --reasoning-parser glm45`)的情况下,原始流按如下方式映射到 Chat Completions:

- 输出包含至少一个 `<tool_call>` 时,`choices[].finish_reason` = `"tool_calls"`(否则为 `"stop"`)。
- `choices[].message.content` = 第一个 `<tool_call>` **之前**的文本(若为空/仅空白则规范化为 `null`)。`<think>…</think>` 推理被推理解析器移除,并单独作为 `message.reasoning_content` 呈现。
- `choices[].message.tool_calls[]` —— 每个 `<tool_call>…</tool_call>` 块对应一个条目:
  - `.id` = **服务器生成**的 id(例如 vLLM 的 `make_tool_call_id()`),模型输出中**没有**此字段。GLM 在流中不输出每次调用的 id。
  - `.type` = `"function"`。
  - `.function.name` = `<tool_call>` 之后到第一个换行之前的文本。
  - `.function.arguments` = **JSON 字符串**(一个对象),根据 `<arg_key>`/`<arg_value>` 对重建,并使用工具 schema 中每个参数的类型。vLLM 返回 `json.dumps(arg_dct, ensure_ascii=False)`,例如 `"{\"location\": \"Beijing\", \"unit\": \"celsius\"}"`。客户端在使用前对其执行 `json.loads()`。
- **请求侧 —— 工具结果**以 `role: "tool"` 消息回传,例如:

  ```json
  {"role": "tool", "tool_call_id": "call_abc123", "content": "{\"temperature\": 26, \"unit\": \"celsius\", \"condition\": \"Sunny\"}"}
  ```

  聊天模板只渲染 `content`(在 `<tool_response>` 内);`tool_call_id` **被模板忽略**,仅对客户端自己的记账有意义。请按调用顺序排列结果。
- **请求侧 —— assistant 工具调用历史**:OpenAI 形状将 `function.arguments` 作为 JSON **字符串**携带,但聊天模板会迭代 `arguments.items()`,因此需要**对象**。vLLM/SGLang 在渲染前把字符串解析回 dict;如果你直接调用 `tokenizer.apply_chat_template`,请把 `arguments` 作为 dict 传入(可选地,`reasoning_content` 作为字符串),否则模板会报错。
- 通过 `extra_body={"chat_template_kwargs": {"enable_thinking": False}}`(OpenAI Python 客户端)禁用思考 —— 这会把模板切换到 `/nothink` + 预填 `<think></think>` 的路径。

## 解析说明与注意事项

- **字符串值不带引号;类型判定需要 schema。** 决定性规则:当且仅当参数在工具的 JSON Schema 中为 string 类型时,`<arg_value>` 才是字面字符串;否则它是 JSON。vLLM 的 `_is_string_type` 与 SGLang 的 `get_argument_type` 都会遍历 `properties[arg].type`(处理 `anyOf`/`oneOf`/`enum`/`allOf`/类型数组)。如果 schema 缺失/宽松,它们回退为“先试 `json.loads`,再试 `ast.literal_eval`,最后当作字符串” —— 因此像 `celsius` 这样的裸词会作为字符串保留,而 `26` 会变成数字。*看起来*像 JSON 的字符串值(例如类型为 `string` 的参数,其值为 `{"a":1}`)之所以被正确地保留为字面字符串,只是因为 schema 声明了 `string`。
- **提取正则(GLM-4.5/4.6)。** vLLM:调用用 `<tool_call>.*?</tool_call>`(DOTALL);名称/主体用 `<tool_call>([^\n]*)\n(.*)</tool_call>`;配对用 `<arg_key>(.*?)</arg_key>\s*<arg_value>(.*?)</arg_value>`。名称正则**要求**名称之后有换行 —— 与 4.5/4.6 模板一致。SGLang 使用等价的 `(?:\\n|\n)` 形式,因此也容忍字面转义的 `\n`。
- **值中包含 `</arg_value>` 会破坏解析。** 值被非贪婪地捕获到下一个 `</arg_value>`;文本中包含 `</arg_value>`(或 `</tool_call>`)的值会提前截断。线上格式中没有转义机制。
- **工具调用只从 `content` 解析,不从推理中解析。** 在 `<think>…</think>` 内输出的 `<tool_call>` 会被工具解析器忽略(vLLM 的推理/工具解析器相互配合,只扫描 `</think>` 之后的内容)。不要指望“边思考边发起”的调用会生效。
- **GLM 抑制引导式解码。** 对于 `tool_choice: "required"` 或指定名称的工具,vLLM 刻意**不**应用 JSON 结构化输出/引导式解码,因为那会强制 JSON 输出,与 GLM 的 XML 语法冲突;解析器改为从自由形式的 XML 中提取。
- **`skip_special_tokens` 必须关闭。** 尽管工具/思考标签是 `special: false`,vLLM 在启用工具时仍强制 `skip_special_tokens = False`(防御 transformers 5.x 的去 token 化变更),以便字面的 `<tool_call>`/`</tool_call>` 文本能保留下来供正则使用。
- **流式。** 过去长字符串参数会被缓冲到闭合标签出现为止(vLLM issue #32829);当前解析器在每个 delta 到达时重新解析已累积的文本,只输出差异,采用“先开引号再填充”的策略流式输出增量字符串内容,并暂存任何不完整的尾部标签(`partial_tag_overlap`)。流式输出的工具名是第一个 `\n` 或 `<arg_key>` 之前的文本。SGLang 以显式的 XML→JSON 状态机(`INIT → IN_KEY → WAITING_VALUE → IN_VALUE`)实现同样的行为。格式错误的尾部(在 `</tool_call>` 之前缺少 `</arg_value>`)会被启发式地收尾。
- **谱系 —— GLM-4.5 与 GLM-4.6:**线上格式相同,`chat_template.jinja` 也相同(内容哈希一致);同一个 `glm45` 解析器服务于两者。
- **谱系 —— GLM-4.7 / GLM-5 改变了格式。** 较新的模型可能省略结构性换行:函数名可以直接位于第一个 `<arg_key>` 之前,零参数调用可以是 `<tool_call>func</tool_call>`,并行调用可以首尾相接。vLLM/SGLang 为此变体需要各自的 GLM-4.7 解析器。omp 的仓库扫描器有意更宽泛:它接受换行、`<arg_key>` 或 `</tool_call>` 作为名称分隔符,因此同一个 `glm` 方言扫描器可处理两种布局。

## omp / pi 转换器行为

仓库的 `glm` 方言是一个**自有带内转换器**。用 `PI_DIALECT=glm` 选择它;旧式 `PI_DIALECT=1` 与 `PI_DIALECT=true` 也会解析为 GLM。当存在工具时,Agent 会把 GLM 格式指南与精简工具目录追加到系统提示词,移除原生提供商工具,把先前的调用/结果改写成语法自有的文本,并把 assistant 文本扫描回规范的 pi 事件。GLM 系列模型亲和度解析为该方言。

自有渲染器始终输出 GLM-4.5 换行布局。它查阅每个工具的规范化 schema:仅字符串的属性原样输出,其余所有值以 JSON 序列化。并行调用以换行分隔。在自有历史中,结果批次成为一条合成的用户消息,包含 `<observation>`,每个结果对应一个 `<tool_response>`;更底层的 GLM 记录(transcript)渲染器则改用模型原生的 `<|observation|>` 角色标记。

扫描器合成 `ptc_…` id,一旦名称分隔符到达就输出 `toolStart`,并将每个参数主体以带键的 `toolArgDelta` 事件流式输出。仅字符串的 schema 属性保持原样;其余每个完成的属性在去除首尾空白后用严格的 `JSON.parse` 解析,失败时回退为原始文本。冲刷(flush)时,未完成的键/值只会丢弃扫描器私有的调用状态。如果 `toolStart` 已经输出,OMP 会保留规范调用,正常停止时可能会派发它;先前累积的参数 —— 包括通过 `toolArgDelta` 发布的局部值文本 —— 仍保留在该调用上。从未产生有效名称的输入不会输出 `toolStart`,因此不会留下调用。扫描器还能修复一些可窄识别的模型错误:用 `</arg_key>` 代替 `</arg_value>`、在真正的闭合标签之前出现多余的错误闭合标签,以及紧邻下一个参数或调用闭合之前缺少值闭合标签。

思考解析默认启用,并从可见文本中排除 `<think>…</think>`。如果 assistant 输出中出现 `<tool_response>`,扫描器会丢弃该标签以及当前缓冲块中剩余的内容,而不是把幻觉出来的结果当作 assistant 内容。

## 来源

- 聊天模板(权威;已在本地渲染以获得逐字节精确的流),GLM-4.5 提交 `cbb2c7c…`:https://huggingface.co/zai-org/GLM-4.5/resolve/main/chat_template.jinja —— `blob`/网页路径会重定向到模型卡 API;已通过 raw 的 `resolve/main` 缓存验证。
- 完全相同的 GLM-4.6 模板(内容哈希一致,确认格式共享):https://huggingface.co/zai-org/GLM-4.6/resolve/main/chat_template.jinja
- 特殊 token ID 与 `special` 标志(`added_tokens_decoder`, `additional_special_tokens`):https://huggingface.co/zai-org/GLM-4.5/resolve/main/tokenizer_config.json
- 停止 token(`eos_token_id = [151329, 151336, 151338]`):https://huggingface.co/zai-org/GLM-4.5/resolve/main/generation_config.json
- 模型卡(服务器标志 `--tool-call-parser glm45 --reasoning-parser glm45`、`enable_thinking` 开关、解析器链接):https://huggingface.co/zai-org/GLM-4.5
- vLLM GLM-4.5/4.6 工具解析器(`Glm4MoeModelToolParser`:正则、schema 驱动的字符串类型判定、JSON 字符串 `arguments`、流式、`skip_special_tokens`):https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/glm4_moe_tool_parser.py
- vLLM GLM-4.7 工具解析器(`Glm47MoeModelToolParser`:同行名称、可选/零参数):https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/glm47_moe_tool_parser.py
- SGLang GLM-4.5/4.6 检测器(`Glm4MoeDetector`:格式文档字符串、XML→JSON 状态机、参数类型判定):https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/function_call/glm4_moe_detector.py
- SGLang GLM-4.7 检测器(`Glm47MoeDetector`:无换行 / 首尾相接的调用):https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/function_call/glm47_moe_detector.py
- vLLM 工具调用文档:https://docs.vllm.ai/en/latest/features/tool_calling/
