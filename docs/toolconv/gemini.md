# Gemini Pythonic 工具调用格式(`tool_code` / `default_api`)

Google 托管的 **Gemini** 模型(当前世代,含 `gemini-3.5-flash` / `*-pro` / `*-preview`)以及 **Gemma 3** 开源权重家族的模型工具调用约定。两者都**完全通过提示词工程**来驱动工具使用——**没有专用的特殊 token**。模型将每次调用以 **Python 源码**的形式发出:一个调用 `default_api.<function_name>(<kwargs>)`,按惯例包裹在 `print(...)` 中并放在围栏 ```` ```tool_code ```` 代码块里;它从 ```` ```tool_outputs ```` 代码块中读回结果。由于该机制是模型经过后训练生成的纯文本,同样的语法会周期性地泄漏到普通输出中(Vertex/AI-Studio 会以 `finish_reason = MALFORMED_FUNCTION_CALL` 呈现)——这种泄漏正是该格式最清晰的公开证据。

验证依据:官方 Gemma 3 函数调用指南(`ai.google.dev/gemma/docs/capabilities/function-calling`——两份推荐提示词,一份 Pythonic、一份 JSON)、Simon Willison 对这两份提示词的转述、Philipp Schmid 的 Gemma 3 教程(`philschmid.de/gemma-function-calling`),以及从 `MALFORMED_FUNCTION_CALL` 报告中逆向还原的托管 Gemini 形式:`google/adk-go#492`(`Malformed function call: print(default_api.`)、`google-gemini/cookbook#929`(`executableCode` 部分 = `print(default_api.get_complaint_number_tool(consumer_number_or_mobile_number='2001234567'))`)、`firebase/genkit#2628`(```` ```tool_code ```` markdown 包裹),以及 Google AI 开发者论坛帖子 "Gemini 2 flash returns raw markdown instead of function call"(71964)。

## “特殊” token

**没有。** 这里没有任何东西是分词器特殊 token 表中的控制 token——下面每个标记都会 BPE 切分成普通文本,并且在 `skip_special_tokens=True` 解码后仍然保留。这是该约定的定义性属性,也是它(a)无需分词器支持即可同时适用于托管 Gemini 和开源 Gemma,以及(b)会泄漏的原因。功能性标记如下:

| 标记(原样) | 作用 |
|---|---|
| ` ```tool_code ` | 打开一个围栏代码块,其正文是应用必须执行的 Python。由裸 ` ``` ` 闭合。 |
| ` ```tool_outputs ` | 打开一个围栏代码块,把执行结果带回给模型。由裸 ` ``` ` 闭合。 |
| `default_api` | 托管栈将未命名空间的工具归入其中的合成模块命名空间。调用形式为 `default_api.<name>(...)`。 |
| `print(...)` | 托管 Gemini 形式中调用周围的惯用包裹(模型被训练为"打印"该调用)。语义上无关紧要——运行时解析调用,并不会执行 Python。 |

线上**没有**每次调用的 id,**也没有**带内推理标记——Gemini 的推理以 API "thought signatures"(思考签名)带外传输,绝不会是 `<think>` 风格的文本。

> **OMP 方言说明:** 由于该约定没有原生的带内推理标记,OMP 的 `gemini` 方言叠加了一个同级围栏 ` ```thinking ` 代码块(由裸 ` ``` ` 闭合,与 ` ```tool_code ` 完全一致),使提示词驱动的 Gemini / Gemma-3 部署可以在带内表达推理。这是 OMP 的约定,不属于 Google 格式的一部分。

## 角色 / 轮次结构

Pythonic 载荷与信封无关,而信封因部署而异:

- **托管 Gemini** 使用常规的 `contents[]` 轮次结构(`role: "user" | "model"`);`tool_code` 块出现在 `model` 轮次的文本中,`tool_outputs` 作为下一轮提供。
- **Gemma 3**(开源权重)使用 Gemma 聊天模板(`<start_of_turn>user … <end_of_turn>` / `<start_of_turn>model`);工具提示词前置到第一个用户轮次,两个代码块位于模型/用户轮次内部。

本文档规定的是**载荷**(两个围栏代码块 + Python 调用形式);外围的轮次 token 属于承载它的任何模板。

## 工具定义

工具以 JSON-Schema 目录的形式在提示词中宣告。Gemma 3 官方指南提供**两个**可互换的系统提示词模板,两者仅在对模型回答方式的说明上不同:

1. **Pythonic**(本规范针对的那个):
   > You have access to functions. If you decide to invoke any of the function(s), you MUST put it in the format of `[func_name1(params_name1=params_value1, params_name2=params_value2...), func_name2(params)]`
   > You SHOULD NOT include any other text in the response if you call a function

2. **JSON**(姊妹约定——相关 Hermes 形态见 `qwen3.md`):
   > … you MUST put it in the format of `{"name": function name, "parameters": dictionary of argument name and its value}`

托管 Gemini 将同样的思路包进 markdown 围栏和 `default_api` 命名空间。函数签名本身以 OpenAI 风格的工具 JSON 传递(`{"type":"function","function":{name,description,parameters}}`)。OMP 的渲染器发出不带 `print` 的 `default_api.NAME(...)`;其扫描器也接受下文所述的包裹与裸调用变体。

## 工具调用格式

一次调用就是一个 Python 调用表达式。托管 Gemini 通常发出对 `default_api` 方法的 `print()`:

````text
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```
````

以下都是实际出现且被接受的等价形式,跨越 Gemma/Gemini 各变体;健壮的解析器会将它们归一化为 `{name, arguments}`:

- `print(default_api.NAME(KWARGS))` — 托管 Gemini 规范形式。
- `default_api.NAME(KWARGS)` — `print`/命名空间是可选的糖。
- `NAME(KWARGS)` — 裸调用(Gemma 3 Pythonic 提示词)。
- `result = NAME(KWARGS)` — 赋值形式(Gemma 3 文档使用 `result = convert(...)`)。

参数值是 **Python 字面量**,不是 JSON:

| Python 字面量 | 示例 | 解码结果 |
|---|---|---|
| string | `'London'` 或 `"London"` | `"London"` |
| int / float | `42`, `3.14` | `42`, `3.14` |
| bool | `True` / `False` | `true` / `false` |
| null | `None` | `null` |
| list | `["a", "b"]` | `["a","b"]` |
| dict | `{"k": 1}` | `{"k":1}` |

字符串使用 Python 转义(`\n`、`\t`、`\\`、`\'`、`\"`);托管 Gemini 发出单引号(`location='London'`),Gemma 示例使用双引号——两者都有效。参数为关键字形式(`name=value`);不使用位置参数,因为运行时映射到命名 schema。

## 多个 / 并行工具调用

单个 `tool_code` 块内出现两种编码:

- **OMP / Gemma 3 Pythonic 形式** — 一个 Python **列表**,包含多个调用表达式。OMP 在两个及以上调用时渲染此形式:
  ````text
  ```tool_code
  [default_api.get_current_temperature(location="London"), default_api.get_temperature_date(location="London", date="2024-10-01")]
  ```
  ````
- **托管 Gemini 变体** — 每行一条 `print(default_api...)` **语句**:
  ````text
  ```tool_code
  print(default_api.get_current_temperature(location="London"))
  print(default_api.get_temperature_date(location="London", date="2024-10-01"))
  ```
  ````

OMP 扫描器从任一形式中按源码顺序提取顶层调用表达式。它为每个解析出的调用铸造一个工具调用 id;该文本约定本身没有 id。

## 工具结果格式

执行结果通过 ```` ```tool_outputs ```` 代码块返回给模型。OMP 按调用顺序为每个结果渲染一个完整代码块;它不单独编码 `isError`。Gemma 3 文档还展示了赋值风格的值(`result = 92.3`),而不透明的输出可以作为文本/JSON 返回:

````text
```tool_outputs
{"temperature": 26.1, "location": "London", "unit": "celsius"}
```
````

模型随后要么以自然语言回答,要么发出另一个 `tool_code` 块。

## 端到端示例

````text
<user>
What's the temperature in London?

<model>
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```

<user>
```tool_outputs
{"temperature": 11.4, "location": "London", "unit": "celsius"}
```

<model>
It's currently 11.4°C in London.
````

## OpenAI 兼容 / 原生 API 映射

- 托管 Gemini 的原生 API 通常返回结构化 `functionCall` 部分(`{name, args}`)。在直接的 Gemini Generative AI 请求上,Gemini 3 调用携带一个 `id`,OMP 会在匹配的 `functionResponse` 中回显它;其 `thoughtSignature` 也必须保留。OMP 的 Vertex 适配器是例外:Vertex GenerateContent 拒绝函数部分的 ID,因此 OMP 从 `functionCall` 和 `functionResponse` 中都省略 `id`,保留原始函数名,并依靠函数名/顺序进行匹配。思考签名仍然保留。
- 从 OpenAI 兼容的 shim 中解析时,每个恢复的调用变成 `tool_calls[i] = {id (server-minted), type:"function", function:{name, arguments:<JSON string>}}` —— Python kwargs 在该边界重新序列化为 JSON 字符串。
- 结果按部署方式回送:托管环境以工具/`functionResponse` 轮次回送,提示词驱动环境在下一个用户轮次中以 `tool_outputs` 代码块回送。

## 解析注意事项与陷阱

- **是 Python,不是 JSON。** `True`/`False`/`None`(而不是 `true`/`false`/`null`)、单引号字符串和尾随逗号都合法。JSON 解析器会拒绝有效调用;请解码 Python 字面量。
- **剥掉包裹。** 在读取调用名前,归一化掉 `print(...)`、`default_api.`(或任何 `module.`)前缀以及 `LHS =` 赋值。`print` 绝不是工具名。
- **扫描时跳过字符串内容。** 像 `search(pattern="foo(")` 这样的调用,字符串里含 `(`;天真的 `\w+\(` 扫描会误把 `foo` 当作被调用者。要跟踪字符串状态,只把顶层的 `(` 当作调用开启符。
- **围栏歧义。** 正文在第一个裸 ` ``` ` 处终止;字符串参数中若字面包含 ` ``` ` 会提前截断代码块(罕见,公认的限制)。
- **它会泄漏。** 因为没有任何特殊 token,当模型"决定"调用工具但结构化解码器失灵时,该格式会原样出现在正常响应中。读取原始文本的生产代码应检测 ` ```tool_code ` 并解析它;基于结构化 API 的生产代码应在 `MALFORMED_FUNCTION_CALL` 上重试。
- **OMP 流式行为。** 扫描器缓冲整个 `tool_code` 正文,只在闭合围栏之后发出工具事件;它不会流式传输部分参数。未闭合的代码块在刷新时被丢弃,而不是作为文本暴露。除普通带引号字符串外,字面量解码器还接受 Python 原始/字节/unicode 前缀、三引号、八进制转义以及 `\x`/`\u`/`\U` 转义。
- **转录渲染。** OMP 将转录包裹在 `<bos>` 和 Gemma 风格的 `<start_of_turn>user|model` 轮次中。`developer` 文本前置到下一个用户轮次(若其后没有用户消息,则作为独立的用户轮次发出);连续的工具结果合并为一个包含各自 `tool_outputs` 代码块的用户轮次。
- **变体分歧。** Gemma **4** 抛弃了这种 Pythonic 形式,改用 token 分隔的大括号语法(`<|tool_call>call:NAME{…}<tool_call|>`)——这是另一种约定,记录在 `gemma.md` 中。本规范涵盖托管 Gemini 和 Gemma 3。
- **Gemma 3 自动选择注意事项。** OMP 当前的模型家族亲和性把每个可识别的 Gemma 版本——包括 Gemma 3——都映射到 `gemma` 方言。因此,当 Gemma 3 模型标记为 `supportsTools: false` 并从原生工具回退时,`tools.format=auto` 会选择不兼容的 Gemma 4 语法。如需本文档记录的 Pythonic Gemma 3 约定,请显式设置 `tools.format=gemini`。

## 参考来源

- Gemma 3 函数调用(两份推荐提示词): https://ai.google.dev/gemma/docs/capabilities/function-calling
- Simon Willison, "Function calling with Gemma": https://simonwillison.net/2025/Mar/26/function-calling-with-gemma/
- Philipp Schmid, "Google Gemma 3 Function Calling Example": https://www.philschmid.de/gemma-function-calling
- Gemini 3 thought signatures + functionCall ids: https://ai.google.dev/gemini-api/docs/gemini-3
- `default_api` / `tool_code` 泄漏证据: https://github.com/google/adk-go/issues/492 · https://github.com/google-gemini/cookbook/issues/929 · https://github.com/firebase/genkit/issues/2628 · https://discuss.ai.google.dev/t/gemini-2-flash-api-returns-raw-markdown-instead-of-function-call/71964
