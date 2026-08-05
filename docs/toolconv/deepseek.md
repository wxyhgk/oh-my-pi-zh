# DeepSeek 工具调用线上格式

DeepSeek 的聊天模型(DeepSeek-V3、V3-0324、R1、R1-0528 和 DeepSeek-V3.1)共享同一个 tokenizer 家族,以及由**全角竖线**特殊 token 构建的独特封装,如 `<｜begin▁of▁sentence｜>` 和 `<｜User｜>`。工具调用以一组专用特殊 token(`<｜tool▁calls▁begin｜>` … `<｜tool▁calls▁end｜>`)发出,而不是文本内嵌 JSON 或 XML。本文以 **DeepSeek-V3.1**(当前混合思考/非思考模型)为中心,并把较旧的 **DeepSeek-V3-0324** 和 **DeepSeek-R1-0528** 格式作为明确的版本差异记录下来,因为它们的线上工具语法与 V3.1 *不同*。

推理服务器通过聊天模板加工具调用解析器来启用它:

- vLLM V3.1:`--enable-auto-tool-choice --tool-call-parser deepseek_v31 --chat-template examples/tool_chat_template_deepseekv31.jinja`(可选 `--reasoning-parser deepseek_r1`)。
- vLLM V3-0324 / R1-0528:`--enable-auto-tool-choice --tool-call-parser deepseek_v3 --chat-template examples/tool_chat_template_deepseekv3.jinja`(V3-0324)或 `tool_chat_template_deepseekr1.jinja`(R1-0528)。
- 模型自带的 `tokenizer_config.json` `chat_template`(以及内容相同的 `assets/chat_template.jinja`)渲染 V3.1 封装、工具调用和工具输出;它**不会**合成 `## Tools` 声明块,因此 vLLM 自带了一个会合成的模板(见下文)。

> 已核对:DeepSeek-V3.1 模型卡的“Chat Template”/“ToolCall”章节、`tokenizer_config.json` 与 `assets/chat_template.jinja` 中逐字节相同的 `chat_template`、`tokenizer.json` 中的 `added_tokens`(token ID)、`config.json`(bos/eos ID)、DeepSeek-V3-0324 和 DeepSeek-R1-0528 的 `tokenizer_config.json` 聊天模板、vLLM 的 `tool_chat_template_deepseekv31.jinja`,以及 vLLM 的工具调用 / 推理输出文档。

## 关于不寻常的 Unicode 的说明(不要替换为 ASCII)

DeepSeek 的标记**不使用** ASCII 竖线 `|`(U+007C)或 ASCII 下划线 `_`。它们使用:

- `｜` —— **U+FF5C 全角竖线**,用作尖括号内侧的分隔符。
- `▁` —— **U+2581 下半八分之一方块**(SentencePiece 词边界字形),用作 token 内部*词与词之间*的分隔符,如 `begin▁of▁sentence`、`tool▁calls▁begin`。

所以 `<｜tool▁calls▁begin｜>` 就是 `<` + `｜`(FF5C)+ `tool` + `▁`(2581)+ `calls` + `▁`(2581)+ `begin` + `｜`(FF5C)+ `>`。把这些 token 复制成 `<|tool_calls_begin|>`(ASCII 竖线 + 下划线)会产生模型从未训练过的 token,并在解析和生成时悄然出错。DeepSeek 唯一使用 ASCII 括号的标记是思考标签 `<think>` / `</think>`(普通 `<`、`/`、`>`)和很少使用的 `<|EOT|>`(ASCII 竖线)。

## 特殊 token

token ID 来自 DeepSeek-V3.1 的 `tokenizer.json`(`added_tokens`);`vocab_size` 为 129280。`special` 列反映 tokenizer 的 `"special"` 标志(它决定 `skip_special_tokens`);注意角色/思考/工具标记都是 `special: false`。

| Token(逐字)| ID | `special` | 用途 |
| --- | --- | --- | --- |
| `<｜begin▁of▁sentence｜>` | 0 | true | BOS;在提示词最开头预置一次。 |
| `<｜end▁of▁sentence｜>` | 1 | true | EOS;结束每个 assistant/工具轮次,是停止 token。 |
| `<｜▁pad▁｜>` | 2 | true | 填充(`pad_token`;模型卡/配置也复用 EOS 作为 pad)。 |
| `<｜search▁begin｜>` | 128796 | false | 搜索 Agent 查询开始(思考模式搜索工具)。 |
| `<｜search▁end｜>` | 128797 | false | 搜索 Agent 查询结束。 |
| `<think>` | 128798 | false | 打开推理/思考区间。ASCII 括号。 |
| `</think>` | 128799 | false | 关闭推理区间;**在非思考模式下也会发出**(见下文)。 |
| `<｜fim▁hole｜>` / `<｜fim▁begin｜>` / `<｜fim▁end｜>` | 128800–128802 | false | 中间填充(fill-in-the-middle,非聊天)。 |
| `<｜User｜>` | 128803 | false | User 角色标记。 |
| `<｜Assistant｜>` | 128804 | false | Assistant 角色标记。 |
| `<\|EOT\|>` | 128805 | true | 轮次结束(legacy;ASCII 竖线,聊天中很少使用)。 |
| `<｜tool▁calls▁begin｜>` | 128806 | false | 打开 assistant 的一批工具调用。 |
| `<｜tool▁calls▁end｜>` | 128807 | false | 关闭这一批工具调用。 |
| `<｜tool▁call▁begin｜>` | 128808 | false | 在批内打开单个工具调用。 |
| `<｜tool▁call▁end｜>` | 128809 | false | 关闭单个工具调用。 |
| `<｜tool▁outputs▁begin｜>` | 128810 | false | 打开一批工具结果(**仅 R1-0528 / V3-0324**)。 |
| `<｜tool▁outputs▁end｜>` | 128811 | false | 关闭一批工具结果(**仅 R1-0528 / V3-0324**)。 |
| `<｜tool▁output▁begin｜>` | 128812 | false | 打开单个工具结果。 |
| `<｜tool▁output▁end｜>` | 128813 | false | 关闭单个工具结果。 |
| `<｜tool▁sep｜>` | 128814 | false | 工具调用内部的分隔符(位于名称和参数之间)。 |

`config.json` 确认 `bos_token_id: 0`、`eos_token_id: 1`。

## 角色 / 通道 / 轮次结构

没有 OpenAI 风格的 `system`/`developer` 通道 token。角色是内联标记,提示词是一整条扁平字符串:

```text
<｜begin▁of▁sentence｜>{system_prompt}<｜User｜>{query}<｜Assistant｜>{response}<｜end▁of▁sentence｜>
```

- **系统提示词**没有标记。所有 `system` 消息被拼接(多条时以 `\n\n` 连接),在 `<｜begin▁of▁sentence｜>` 之后、第一个 `<｜User｜>` 之前立即发出。存在工具时,`## Tools` 块被追加到这段系统文本之后(以 `\n\n` 分隔)。
- **User 轮次**:`<｜User｜>` + 内容。(V3.1 中用户文本后没有 EOS;assistant 标记直接跟在后面。)
- **Assistant 轮次**:以 `<｜Assistant｜>` 开始,然后是思考标签,接着是内容,最后是 `<｜end▁of▁sentence｜>`。
- **思考 vs 非思考(V3.1 混合)** —— 由模板选择,而非模型:
  - 非思考生成前缀:`…<｜Assistant｜></think>` —— 模型在从未需要打开的 `</think>` *之后*开始。与 DeepSeek-V3 不同,V3.1 总是注入这个 `</think>`。
  - 思考生成前缀:`…<｜Assistant｜><think>` —— 模型输出思维链,以 `</think>` 关闭,然后是回答。
  - 在多轮上下文中,**每个**存储的 assistant 轮次都保留 `</think>`;只有最后一轮开头的思考标签反映请求的模式。渲染存储的 assistant 消息时,`content` 中直到并包括 `</think>` 的文本会在重新发出前被剥离(模板执行 `content.split('</think>', 1)[1]`)。
- **工具调用在非思考模式下运行。**模型卡说明“Toolcall is supported in non-thinking mode”,V3.1 工具模板以 `<｜Assistant｜></think>` 打开工具调用轮次。在 vLLM 中,V3.1 推理默认禁用;通过 `chat_template_kwargs={"thinking": true}` 启用。
- **搜索 Agent 通道**:使用 `<｜search▁begin｜>` / `<｜search▁end｜>` 的独立思考模式协议(见模型卡的 `assets/search_tool_trajectory.html`);不在普通函数调用范围内。

## 工具定义

工具通过**注入系统区域的 Markdown 块**声明(位于系统提示词之后、第一个 `<｜User｜>` 之前)。`tokenizer_config.json` 中的聊天模板不会根据 `tools=[…]` 参数构建这个块;由调用方(或 vLLM 的 `tool_chat_template_deepseekv31.jinja`)构造。逐字转载自 DeepSeek-V3.1 模型卡,完整布局为 `<｜begin▁of▁sentence｜>{system prompt}\n\n{tool_description}<｜User｜>{query}<｜Assistant｜></think>`,其中 `{tool_description}` 是:

```text
## Tools
You have access to the following tools:

### {tool_name1}
Description: {description}

Parameters: {json.dumps(parameters)}

IMPORTANT: ALWAYS adhere to this exact format for tool use:
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call_name<｜tool▁sep｜>tool_call_arguments<｜tool▁call▁end｜>{additional_tool_calls}<｜tool▁calls▁end｜>

Where:
- `tool_call_name` must be an exact match to one of the available tools
- `tool_call_arguments` must be valid JSON that strictly follows the tool's Parameters Schema
- For multiple tool calls, chain them directly without separators or spaces
```

每个工具贡献一个 `### {name}` 小节,含一行 `Description:` 和一行 `Parameters: {…}`,后者是 JSON Schema 参数对象的紧凑 JSON(模型卡中为 `json.dumps(parameters)`,vLLM 模板中为 `parameters | tojson`)。`IMPORTANT:` 指令块在最后一个工具之后追加一次。

## 工具调用格式

模型输出一个批次包装,内含一个或多个调用。每个调用是 `name <｜tool▁sep｜> arguments`,其中 **arguments 是原始 JSON 对象字符串**(无代码围栏)。最小的单调用(模型在 `<｜Assistant｜></think>` 前缀之后生成的内容):

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

语法(V3.1):

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>{name}<｜tool▁sep｜>{json_args}<｜tool▁call▁end｜>{…more calls…}<｜tool▁calls▁end｜>
```

- `{name}` 必须与声明的工具名完全匹配。它**最先**出现,紧跟在 `<｜tool▁call▁begin｜>` 之后。
- `{json_args}` 是符合工具参数 schema 的有效 JSON,直接内联。
- 随后整个 assistant 轮次由模板/服务器以 `<｜end▁of▁sentence｜>` 关闭。

(V3.1 **没有** `type` 字段,**也没有**包裹参数的 ` ```json ` 围栏——那是较旧的 R1/V3-0324 惯例;见版本差异。)

## 多次 / 并行工具调用

所有调用都在一个 `<｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>` 包装内。在第一个 `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>` 之后,每个额外调用都是**直接串接的另一个 `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>`,调用之间没有分隔符、换行或空格**(模型卡:“chain them directly without separators or spaces”):

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA"}<｜tool▁call▁end｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "Seattle, WA"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

注意 `<｜tool▁calls▁begin｜>`(复数,id 128806)恰好出现一次;每个调用使用单数 `<｜tool▁call▁begin｜>`(id 128808)/ `<｜tool▁call▁end｜>`(id 128809)。

## 工具结果格式

执行结果以 `tool` 角色消息回传。在 **V3.1** 中,每个结果用单数输出 token 包裹,**没有**复数 `<｜tool▁outputs▁…｜>` 包装,紧跟 assistant 工具调用轮次的 `<｜end▁of▁sentence｜>` 之后发出:

```text
<｜tool▁output▁begin｜>{result_text}<｜tool▁output▁end｜>
```

`{result_text}` 是原始工具输出(通常是 JSON 字符串,但可以是任何文本)。多个结果时,V3.1 模板对每条 `tool` 消息发出一个 `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`,直接拼接。**线上格式中没有工具调用 ID** —— 结果与调用**按位置**匹配(输出顺序 ↔ 调用顺序)。

随后模型**直接在 `<｜tool▁output▁end｜>` 之后**生成最终回答,没有 `<｜Assistant｜>` 标记,也没有 `</think>`(见解析注意事项——V3.1 参考模板刻意把工具之后的 assistant 内容渲染为单纯的 `content<｜end▁of▁sentence｜>`)。

> R1-0528 / V3-0324 不同:结果被包在 `<｜tool▁outputs▁begin｜>` … `<｜tool▁outputs▁end｜>` 批次包装中,每个结果为 `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`,多个结果以换行分隔。

## 端到端示例

一个完整的 DeepSeek-V3.1 **非思考**多轮对话。一切都是单条扁平字符串;内联 `←` 注释标记模型生成开始的位置(它们不属于流)。`## Tools` 块内的空白是字面换行。

```text
<｜begin▁of▁sentence｜>You are a helpful assistant.

## Tools
You have access to the following tools:

### get_weather
Description: Get the current weather for a location

Parameters: {"type": "object", "properties": {"location": {"type": "string", "description": "City and state, e.g. San Francisco, CA"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}

IMPORTANT: ALWAYS adhere to this exact format for tool use:
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call_name<｜tool▁sep｜>tool_call_arguments<｜tool▁call▁end｜>{additional_tool_calls}<｜tool▁calls▁end｜>

Where:
- `tool_call_name` must be an exact match to one of the available tools
- `tool_call_arguments` must be valid JSON that strictly follows the tool's Parameters Schema
- For multiple tool calls, chain them directly without separators or spaces
<｜User｜>What's the weather in San Francisco?<｜Assistant｜></think><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA", "unit": "celsius"}<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜><｜tool▁output▁begin｜>{"temperature": 18, "unit": "celsius", "condition": "Foggy"}<｜tool▁output▁end｜>It's currently 18°C and foggy in San Francisco.<｜end▁of▁sentence｜>
```

解读各区间:

1. `<｜begin▁of▁sentence｜>` + 系统文本 + `\n\n` + `## Tools…` 块 —— 提示词前缀。
2. `<｜User｜>What's the weather in San Francisco?` —— 用户轮次。
3. `<｜Assistant｜></think>` —— 非思考生成前缀(提示词)。**模型从这里开始生成。**
4. `<｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>` —— 模型的工具调用;服务器追加 `<｜end▁of▁sentence｜>` 并以 `finish_reason: "tool_calls"` 停止。
5. `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>` —— 你的执行结果,追加到提示词。
6. `It's currently 18°C and foggy in San Francisco.<｜end▁of▁sentence｜>` —— **模型在工具输出之后直接生成最终回答**(没有新的 `<｜Assistant｜>` 标记),以 EOS 结束。

## OpenAI 兼容 API 映射

由 OpenAI 兼容服务器(如带 `--tool-call-parser deepseek_v31` 的 vLLM)前置时:

- **`finish_reason`**:模型输出 `<｜tool▁calls▁begin｜>…` 批次时为 `"tool_calls"`;否则为 `"stop"`。
- **`message.tool_calls[]`**:每个 `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>` 一个元素。
  - `.type` = `"function"`。
  - `.function.name` = `<｜tool▁call▁begin｜>` 与 `<｜tool▁sep｜>` 之间的文本。
  - `.function.arguments` = `<｜tool▁sep｜>` 与 `<｜tool▁call▁end｜>` 之间的文本,以**JSON 字符串**返回(按 OpenAI 规范),而非嵌套对象。模型在那里已经输出原始 JSON,因此原样透传。
  - `.id` = **由服务器合成**(如 `chatcmpl-tool-…`)。DeepSeek 的线上格式不携带调用 ID。
- **工具结果消息**:`{"role": "tool", "tool_call_id": "<id>", "content": "<result>"}`。服务器把 `content` 渲染进 `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`。由于提示词没有 ID,`tool_call_id` 仅用于客户端记账;**模型依赖顺序**,因此要保持结果相对调用的顺序。
- **Assistant 重放**:当你把先前的 assistant 轮次连同 `tool_calls` 发回时,模板会内联 `function.arguments`。HF 参考模板**逐字**内联(假定它已是 JSON 字符串);vLLM 的 `tool_chat_template_deepseekv31.jinja` 用 `| tojson` 处理。按 OpenAI 规范以 JSON **字符串**发送 `arguments`(见下面关于双重编码的陷阱)。

## 解析注意事项与陷阱

- **Unicode 承载关键语义。**必须精确匹配 `｜` = U+FF5C 和 `▁` = U+2581。ASCII 的 `<|tool_calls_begin|>` 无法分词为这些特殊 token。`<think>`/`</think>` 使用 ASCII 括号;罕见的 `<|EOT|>` 使用 ASCII 竖线。
- **工具/角色标记是 `special: false`。**只有 `<｜begin▁of▁sentence｜>`、`<｜end▁of▁sentence｜>`、`<｜▁pad▁｜>` 和 `<|EOT|>` 被标记为 `special: true`。因此用 `skip_special_tokens=True` 解码**不会**剥离 `<｜tool▁calls▁begin｜>`、`<｜tool▁sep｜>`、`<｜Assistant｜>`、`</think>` 等——它们留在解码后的字符串中供解析器查找。(反之,不要假定特殊 token 过滤会移除它们。)
- **V3.1 没有代码围栏、没有 `type` 字段。**为 R1/V3-0324(`function<｜tool▁sep｜>name` + ` ```json ` 块)编写的解析器无法解析 V3.1,反之亦然。V3.1 是 `name<｜tool▁sep｜>raw_json`。
- **V3.1 的串接没有分隔符。**调用直接紧挨:`…<｜tool▁call▁end｜><｜tool▁call▁begin｜>…`。不要按换行/空白切分;按 `<｜tool▁call▁begin｜>` / `<｜tool▁call▁end｜>` 边界切分。(R1/V3-0324 在每个后续调用前放一个 `\n`。)
- **线上没有工具调用 ID。**按位置把结果与调用匹配。服务器必须为 OpenAI 形态合成 `tool_call_id`。
- **`</think>` 在非思考模式下也会出现。**在把其余部分当作可见回答之前,先剥离开头的 `</think>`(以及前面任何推理);模板在重放存储的轮次时执行 `content.split('</think>', 1)[1]`。
- **工具之后的生成提示词怪癖。**参考 V3.1 聊天模板只在**最后一条消息是 `user`** 时追加 `<｜Assistant｜></think>` 生成前缀。在 `tool` 消息之后它不追加任何内容,模型直接在 `<｜tool▁output▁end｜>` 之后继续。以工具结果结尾的对话重新套模板的 Agent 循环,不应在那里期待(或重复插入)assistant 标记。
- **`arguments` 双重编码风险。**重放时,vLLM 的示例模板应用 `arguments | tojson`。如果 `arguments` 已是 JSON 字符串(OpenAI 惯例),该管道会再次 JSON 编码这个字符串(用引号包裹并转义)。在模板期望 `| tojson` 的地方传对象,在模板逐字内联的地方传字符串——与你实际运行的模板保持一致。
- **流式。**工具调用逐 token 到达;名称直到 `<｜tool▁sep｜>` 才完整,参数在 `<｜tool▁call▁end｜>` 之前都是部分 JSON。按调用边界缓冲;在关闭的工具调用 token 之前不要尝试 `json.loads` 参数。
- **畸形输出。**在 `tool_choice="auto"` 且无结构标签约束(`VLLM_ENFORCE_STRICT_TOOL_CALLING=false`)时,模型可能在 `tool_call_arguments` 中输出无效 JSON,或输出不匹配任何工具的 `tool_call_name`;解析器尽力提取。命名/`required` 工具选择使用 structured-outputs 后端,保证参数符合 schema。

## 版本差异:V3.1 对比 V3-0324 / R1-0528

V3.1 之前的模型(DeepSeek-V3-0324 和 DeepSeek-R1-0528)共享较旧的工具调用编码,在 vLLM 中以 `--tool-call-parser deepseek_v3` 提供。每个调用的主体为:

````text
<｜tool▁call▁begin｜>function<｜tool▁sep｜>{name}
```json
{json_args}
```<｜tool▁call▁end｜>
````

与 V3.1 的差异:

| 方面 | V3.1(`deepseek_v31`)| V3-0324 / R1-0528(`deepseek_v3`)|
| --- | --- | --- |
| 调用中字段顺序 | `{name}<｜tool▁sep｜>{args}` | `function<｜tool▁sep｜>{name}`(字面 `type`,然后名称) |
| 参数包裹方式 | 原始 JSON,内联 | 带围栏的 ` ```json … ``` ` 块(名称和参数以 `\n` 分隔) |
| 调用串接 | 直接紧挨,**无分隔符** | 每个后续调用前加 `\n` |
| 工具结果 | 每条消息一个 `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`,无批次包装 | 包在 `<｜tool▁outputs▁begin｜>…<｜tool▁outputs▁end｜>` 中,结果以换行分隔 |
| User→assistant 边界 | 用户轮次 = `<｜User｜>{q}`;生成时加 `<｜Assistant｜></think>` | 用户轮次 = `<｜User｜>{q}<｜Assistant｜>`(assistant 标记附加在 user 分支中) |
| 思考 | 混合;`thinking` kwarg 切换 `<think>` 与 `</think>` 前缀 | R1-0528 始终推理(裸 `<｜Assistant｜>` 生成前缀,模型自行打开 `<think>`);V3-0324 非推理 |
| vLLM 解析器 | `--tool-call-parser deepseek_v31` | `--tool-call-parser deepseek_v3` |

R1-0528 / V3-0324 并行调用及其结果批次示例:

````text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
```json
{"location": "San Francisco, CA"}
```<｜tool▁call▁end｜>
<｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
```json
{"location": "Seattle, WA"}
```<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜><｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>{"temperature": 18}<｜tool▁output▁end｜>
<｜tool▁output▁begin｜>{"temperature": 14}<｜tool▁output▁end｜><｜tool▁outputs▁end｜>
````

`deepseek_r1` **推理**解析器(`--reasoning-parser deepseek_r1`)适用于 R1 系列**以及** DeepSeek-V3.1;它把 `<think>…</think>` 区间提取到响应的 `reasoning` 字段。它与工具调用解析器相互独立。

## DSML 封装(较新的 DeepSeek 模型)

较新的 DeepSeek 模型(如 `deepseek-v4-pro`)以第二种 XML 风格封装——**DSML**——输出工具调用,而不是 `<｜tool▁calls▁begin｜>` 特殊 token 串。标签名复用同样的全角竖线(`｜`,U+FF5C),但主体是 Anthropic 风格的 `invoke` / `parameter` 块,而非 `name<｜tool▁sep｜>{json}` 对:

```text
<｜DSML｜tool_calls>
<｜DSML｜invoke name="get_weather">
<｜DSML｜parameter name="location" string="true">San Francisco, CA</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

- 一个 `<｜DSML｜tool_calls>…</｜DSML｜tool_calls>` 包装容纳一个或多个 `<｜DSML｜invoke name="…">…</｜DSML｜invoke>` 调用;标签之间的空白无关紧要。
- 每个参数是一个 `<｜DSML｜parameter name="…" string="…">value</｜DSML｜parameter>`。`string` 默认为 `"true"`(值保持为原始字符串);`string="false"` 把值解析为 JSON,因此 `…string="false">15</…>` 解码为数字 `15`。
- 线上还存在 ASCII 竖线变体(`<|DSML|tool_calls>`、`<|DSML|invoke …>`、`<|DSML|parameter …>`),与全角形式并存。
- 多个 OpenAI 兼容宿主(DeepSeek 自有 API、NanoGPT、NVIDIA、Ollama / Ollama Cloud、Fireworks、OpenRouter、OpenCode)会把这种封装泄漏进可见 `content`,而不是返回结构化的 `tool_calls`;解析器必须把它修复回工具调用,并从用户可见文本中剥离这些标记。

## omp / pi 转换器行为

仓库的 `deepseek` 方言是一个**自有的带内转换器**,不是 vLLM 解析器包装。用 `PI_DIALECT=deepseek`(或等效的 Agent 配置)选择它。存在工具时,Agent 会把方言指南和紧凑工具目录追加到系统提示词,从请求中移除原生提供商工具,用这种语法重新编码先前的调用/结果,并把流式 assistant 文本扫描回规范的 pi 工具调用事件。

当前扫描器接受上面描述的全部三种形式:

- V3.1 `name<｜tool▁sep｜>{json}` 调用;
- legacy `function<｜tool▁sep｜>name` 加带围栏的 JSON 主体;以及
- 全角或 ASCII DSML `invoke` / `parameter` 块。

对 V3.1 和 legacy 调用,omp 在头部完整后发出 `toolStart`,但缓冲参数直到 `<｜tool▁call▁end｜>`;随后使用共享的修复式 JSON 解析器。缺失/无效的完整参数对象变成 `{}`。Flush 不会为未完成的调用发出 `toolEnd`,只清除扫描器的私有状态。不过,一旦 `toolStart` 已发出,规范调用就会保留,正常停止的轮次可能派发它:未完成的 V3.1/legacy 调用保留 `{}`,而 DSML 调用保留任何已通过 `toolArgDelta` 发布的参数文本。DSML 是真正的增量式:参数主体文本以这些增量流式输出。DSML 参数默认是原始字符串,除非 `string="false"`;后者在完整关闭时用修复式 JSON 解码,解码失败则回退为原始文本。无 ID 的 DeepSeek 形式的调用 ID 合成为 `ptc_…`。

扫描器还会从可见文本中移除泄漏的 DeepSeek 聊天模板控制 token,并默认把 `<think>…</think>` 映射为思考事件。其渲染器输出 V3.1 调用,无分隔符地串接并行调用,并把多个结果渲染为以换行分隔的单数输出块。DSML 语法被接受用于修复泄漏的提供商输出,但不是自有方言发出的历史格式。

## 来源

- DeepSeek-V3.1 模型卡(Chat Template / ToolCall 章节):<https://huggingface.co/deepseek-ai/DeepSeek-V3.1>
- DeepSeek-V3.1 `assets/chat_template.jinja`:<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/assets/chat_template.jinja>
- DeepSeek-V3.1 `tokenizer_config.json`(`chat_template`,与 jinja 逐字节相同):<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/tokenizer_config.json>
- DeepSeek-V3.1 `tokenizer.json`(`added_tokens` → token ID 和 `special` 标志):<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/tokenizer.json>
- DeepSeek-V3.1 `config.json`(`bos_token_id`、`eos_token_id`、`vocab_size`):<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/config.json>
- DeepSeek-R1-0528 模型卡和 `tokenizer_config.json`(较旧的工具格式):<https://huggingface.co/deepseek-ai/DeepSeek-R1-0528> · <https://huggingface.co/deepseek-ai/DeepSeek-R1-0528/resolve/main/tokenizer_config.json>
- DeepSeek-R1 模型卡:<https://huggingface.co/deepseek-ai/DeepSeek-R1>
- DeepSeek-V3-0324 `tokenizer_config.json`(较旧的工具格式):<https://huggingface.co/deepseek-ai/DeepSeek-V3-0324/resolve/main/tokenizer_config.json>
- V3.1 的 vLLM 工具调用模板(`## Tools` 注入 + `| tojson`):<https://github.com/vllm-project/vllm/blob/main/examples/tool_chat_template_deepseekv31.jinja>
- vLLM 工具调用文档(`deepseek_v3`、`deepseek_v31` 解析器标志):<https://docs.vllm.ai/en/latest/features/tool_calling/>
- vLLM 推理输出文档(`deepseek_r1` 推理解析器;V3.1 思考默认):<https://docs.vllm.ai/en/latest/features/reasoning_outputs/>
