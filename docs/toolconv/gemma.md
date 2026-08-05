# Gemma 4 工具调用格式(token 分隔的 `call:NAME{…}`)

Google **Gemma 4** 开源权重家族(`google/gemma-4-*-it`)的工具调用约定。它与 Gemma 3 和托管 Gemini 使用的提示词工程化 Pythonic `tool_code` 形式(见 `gemini.md`)彻底决裂: Gemma 4 引入了**专用特殊 token** 和紧凑的 **token 分隔大括号语法**。调用和响应各有配对标记,每个字符串值都用 `<|"|>` token 包裹,而不是 ASCII 引号。模型发出一个调用为 `<|tool_call>call:NAME{key:value,…}<tool_call|>`;开发者解析它、运行工具,然后追加 `<|tool_response>response:NAME{output:…}<tool_response|>`。

已对照 OMP 的 `gemma` 方言(`packages/ai/src/dialect/gemma.ts`)验证:解析这些代码块的流式扫描器,以及产生它们的 `renderAssistantToolCalls` / `renderToolResults` / `renderTranscript` 渲染器。下面的示例流与该实现一致;示例模型 id 是 `google/gemma-4-E2B-it`。

## 特殊 token

Gemma 4 将每个结构元素包裹在配对 token 中。注意**不对称的管道位置**——开启符的管道在左(`<|x>`),其闭合符的管道在右(`<x|>`):

| 开启 | 闭合 | 用途 |
|---|---|---|
| `<bos>` | — | 序列开始 |
| `<\|turn>` | `<turn\|>` | 一个对话轮次;角色名是正文的第一行 |
| `<\|tool_call>` | `<tool_call\|>` | 模型发出的一次工具**调用** |
| `<\|tool_response>` | `<tool_response\|>` | 回馈给模型的一个工具**结果** |
| `<\|channel>` | `<channel\|>` | 推理通道;`<\|channel>thought` 在可见回复之前打开模型的思维链(由 `<channel\|>` 闭合) |
| `<\|"\|>` | `<\|"\|>` | 字符串字面量分隔符(两端同一 token) |
| `<eos>` | — | 序列结束 |

由于字符串分隔符是一个 token(`<|"|>`),值可以包含原始 ASCII 引号和逗号而无需转义——只有字面 `<|"|>` token 序列不能出现在字符串内部。

思考变体在专用通道中发出推理——`<|channel>thought\n…<channel|>` 位于模型轮次开头、任何回复文本或工具调用之前。`gemma` 扫描器将该通道路由到思考事件(使其不出现在可见回复中),并仍然解析其后的工具调用;`renderThinking` 将思考往返回同一个 `<|channel>thought\n…<channel|>` 代码块。`parseThinking: false` 时,该通道会留在可见文本中。

## 角色 / 轮次结构

每个轮次是 `<|turn>{role}\n{body}<turn|>`,轮次之间无分隔符直接连接。角色为 `system`、`user`、`model`(`developer` 消息渲染为 `system`)。带生成提示词时,流在 `<|turn>model\n` 处结束,模型继续生成。工具调用及其后的工具响应在同一个 `model` 轮次内发出——重新渲染的历史中,响应块紧跟调用块。

## 工具定义

自有 `gemma` 提示词**确实**携带每个工具的归一化线上 schema。`renderInbandToolPrompt` 在 `<tools></tools>` 内每行序列化一个紧凑的 OpenAI 风格对象,后接 Gemma 格式指南:

```text
<tools>
{"type":"function","function":{"name":"get_current_temperature","description":"Gets the current temperature for a given location.","parameters":{"type":"object","properties":{"location":{"type":"string","description":"The city name, e.g. San Francisco"}},"required":["location"]}}}
</tools>
```

`renderToolInventory` 是系统提示词和 `/dump` 使用的独立冗长清单。它发出一个 `## functions` TypeScript `namespace functions { … }` 代码块。工具描述是 `type NAME = (_: PARAMS);` 声明上方的 `//` 注释;配置的示例以 JSDoc 风格 `// @example` 条目出现,其调用使用 Python 关键字参数语法。它不发出逐工具的 Markdown 章节或原生 Gemma `<|tool_call>` 示例。

## 工具调用格式

模型为每个 `<|tool_call>…<tool_call|>` 代码块发出一次调用。正文是 `call:NAME{ARGS}`,其中 `ARGS` 是逗号分隔的 `key:value` 对列表:

```text
<|tool_call>call:get_current_temperature{location:<|"|>London<|"|>}<tool_call|>
```

`{…}` 内部的值语法:

| 值类型 | 编码 | 示例 |
|---|---|---|
| string | `<\|"\|>text<\|"\|>` | `location:<\|"\|>London<\|"\|>` |
| int / float | 裸值 | `count:42` |
| bool | 裸值 | `flag:true` |
| null | 裸值 | `unit:null` |
| list | `[v,v,…]` | `tags:[<\|"\|>a<\|"\|>,<\|"\|>b<\|"\|>]` |
| 嵌套对象 | `{k:v,…}` | `config:{theme:<\|"\|>dark<\|"\|>}` |

OMP 解析器是流式 `GemmaInbandScanner`(`packages/ai/src/dialect/gemma.ts`),不是扁平正则。对每个 `<|tool_call>` 代码块,它:

1. 找到匹配的 `<tool_call|>` 闭合符,跳过任何 `<|"|>…<|"|>` 字符串跨度,使出现在字符串值内部的 `<tool_call|>` 序列不会提前结束代码块;
2. 匹配 `call:NAME{` 开头,然后取大括号正文直至深度匹配的 `}`;
3. 在顶层逗号处把该正文拆成 `key:value` 对——跳过括号深度(`[]`、`{}`)和 `<|"|>` 字符串跨度——并按上述语法解码每个值,因此嵌套列表和对象能正确解析(单层正则做不到)。

调用只在完整的闭合标记到达后才发出;没有部分参数事件。如果流在未闭合的工具代码块处被刷新,OMP 会丢弃该不完整代码块。语法上已闭合但缺少最终参数大括号的代码块仍会从可用正文中解析。

## 多个 / 并行工具调用

并行调用是连续的 `<|tool_call>…<tool_call|>` 代码块(每块一个调用),按顺序返回。应用按相同顺序为每个调用返回一个 `<|tool_response>`。

## 工具结果格式

每个结果是 `<|tool_response>response:NAME{output:VALUE}<tool_response|>`。`renderToolResults` 总是把结果包裹在单个 `output` 键下,并先对工具文本执行 `JSON.parse`——因此 JSON 输出变成大括号语法中的嵌套对象/数组,而普通字符串用 `<|"|>…<|"|>` 包裹:

```text
<|tool_response>response:get_current_weather{output:{temperature:15,weather:<|"|>sunny<|"|>}}<tool_response|>
<|tool_response>response:read{output:<|"|>FILE<|"|>}<tool_response|>
```

Gemma 线上形式没有专用的成功/错误字段。OMP 将 `isError` 结果渲染为与成功结果相同的 `response:NAME{output:…}` 形状,因此任何失败指示都必须出现在结果文本本身中。

## 端到端示例

天气查询的 `renderTranscript` 输出。系统轮次还携带 `<tools>` 目录和格式指南(此处缩写,见*工具定义*);模型的调用与其工具响应合并为一个 `model` 轮次(响应紧跟调用),最终回答是下一个 `model` 轮次。轮次背靠背发出,无分隔符——只有每个角色后的 `\n` 是字面的:

```text
<bos><|turn>system
You are a helpful assistant.<turn|><|turn>user
Hey, what's the weather in Tokyo right now?<turn|><|turn>model
<|tool_call>call:get_current_weather{location:<|"|>Tokyo, JP<|"|>}<tool_call|><|tool_response>response:get_current_weather{output:{temperature:15,weather:<|"|>sunny<|"|>}}<tool_response|><turn|><|turn>model
The current weather in Tokyo is 15 degrees Celsius and sunny.<turn|>
```

## 解析注意事项与陷阱

- **字符串分隔符是 token,不是引号。** 在 `<|"|>…<|"|>` 内部,字节 `"` 和 `,` 是字面数据——示例 `<|"|>The city and state, e.g. "San Francisco, CA"…<|"|>` 两者都包含。只在 `<|"|>…<|"|>` 跨度**之外**按 `,`/`}` 拆分参数。
- **不对称管道。** 闭合符是 `<tool_call|>`,不是 `</tool_call>` 或 `<|tool_call>`。匹配错误的管道侧永远无法闭合代码块。
- **每块一次调用。** 与 JSON `tool_calls[]` 数组不同,并行是"更多代码块",而不是"一个代码块里更多条目"。
- **裸标量。** 未用 `<|"|>` 包裹的值:`true`/`false` → 布尔,`null`/`none` → null,数字 → number,否则为裸字符串(例如未加引号的枚举或类型名,如 `STRING`)。
- **工具调用 id 是合成的。** 该格式不携带 id;收到完整的闭合代码块后,OMP 解析它并发出相邻的 `toolStart`/`toolEnd` 事件,带一个新铸造的 id。渲染的响应通过周围消息顺序/名称关联。
- **不是 Gemma 3 / 托管 Gemini。** 那些使用 `gemini.md` 中的 Pythonic `tool_code` / `default_api` 形式。Gemma 4 用这种 token 语法取代了它;两者不可互换。
- **Gemma 3 自动选择注意事项。** OMP 当前的模型家族亲和性把 Gemma 3 和 Gemma 4 模型 id 都映射到 `gemma`。如果 Gemma 3 模型标记为 `supportsTools: false`,`tools.format=auto` 因此会选择这种 Gemma 4 语法,即使 Gemma 3 需要 `gemini.md` 中的 Pythonic 约定;请显式设置 `tools.format=gemini`。

## 参考来源

- OMP `gemma` 方言实现:`packages/ai/src/dialect/gemma.ts`(扫描器 + 渲染器)、`packages/ai/src/dialect/catalog.ts` + `packages/ai/src/dialect/prompt-template.md`(工具目录)、`packages/ai/src/dialect/gemma.md`(格式指南)。
- Gemma 4 函数调用: https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4
- Gemma 4 提示词格式: https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
