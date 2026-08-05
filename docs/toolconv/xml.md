# 通用 XML 自有工具调用格式(`<invoke>` / `<tool_response>`)

OMP 的 `xml` 方言是一种通用的、由提示词驱动的带内协议。模型直接在助手文本中为每次工具调用写入一个 `<invoke>` 元素;OMP 解析这些调用,并在下一个用户轮次中为每个结果返回一个有序的 `<tool_response>` 块。双方都不携带工具调用 id,结果块也不携带工具名,因此顺序就是关联机制。

本参考文档描述 `packages/ai/src/dialect/xml.ts` 实现的转换器。常规 `tools.format: xml` 路径使用共享的 Anthropic 风格 invoke 扫描器。导出的扫描器 API 也可以选择 DeepSeek 的管道包裹 DSML 标签集;该仅扫描器选项在下方单独说明。

## 选择与请求转换

在 `~/.omp/agent/config.yml`、项目配置或覆盖层中选择该方言:

```yaml
tools:
  format: xml
```

`tools.format: xml` 会为会话强制启用通用 XML 自有方言。`auto` **不会**选择通用 XML 作为未知模型家族的回退:当模型 `supportsTools: false` 时,解析器会选择已知的模型家族方言;若没有特定亲和性则选择 GLM。需要此语法时请显式使用 `xml`。参见 [`tools.format`](../settings.md#tools-and-approvals)。

选中后,OMP 会从提供商请求中移除原生结构化工具,将带内工具目录和 XML 指南附加到系统提示词中,把之前的结构化调用/结果转换为文本,并把助手文本重新扫描为结构化工具调用事件。

## 工具定义与提示词注入

OMP 注入共享的 `# Tools` 提示词。可用函数以每行一个紧凑的 OpenAI 风格函数对象的形式出现在 `<tools></tools>` 中,使用每个工具归一化后的线上 schema:

```text
<tools>
{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"count":{"type":"number"}},"required":["path"]}}}
</tools>
```

来自 `packages/ai/src/dialect/xml.md` 的 XML 专用指南位于目录之后。它要求使用已列出的函数名、字面量字符串正文、JSON 非字符串值、有序结果,以及在模型停止前完成全部调用。调用是文本,绝不是原生 `tool_calls` JSON。

## 规范调用格式

一次调用就是一个 invoke:

```text
<invoke name="read"><parameter name="path">src/main.ts</parameter><parameter name="count">40</parameter></invoke>
```

| 元素 | 含义 |
| --- | --- |
| `<invoke name="TOOL">…</invoke>` | 一次工具调用。提示词契约要求使用已列出的工具名。 |
| `<parameter name="ARG">VALUE</parameter>` | 一个命名参数。 |
| `<tool_calls>…</tool_calls>` | 可选的模型发出的包裹层,指南/扫描器接受;OMP 的渲染器不会添加它。 |

`renderAssistantToolCalls` 以换行分隔的方式发出连续的 invoke,不带外层包裹。默认扫描器还接受 `<function_calls>` 作为包裹层别名、Anthropic 标签的 `antml:` 前缀变体,以及裸 invoke。它接受的输入有意比规范渲染器的输出更宽。

OMP 渲染属性时会对工具名和参数名进行 XML 转义。参数正文不进行 XML 转义,因为该格式是分隔符匹配的,而非由 XML DOM 解析。应写 `a & b < c`,而不是 `a &amp; b &lt; c`;只有字面量 `</parameter>` 会与正文的闭合分隔符冲突。

## 参数编码与强制转换

渲染器使用提供的工具 schema 来判断值是否为字面量字符串:

| 声明/值的类型 | 渲染的正文 | 默认扫描器结果 |
| --- | --- | --- |
| schema 声明为字符串且运行时值也是字符串 | 原样保留,空白不变 | 原样字符串 |
| 数字、布尔值、`null`、数组或对象 | JSON | 解析后的 JSON 值 |
| 未被识别为字符串参数的运行时字符串 | JSON 字符串,含引号 | 解析后的字符串 |

示例:

```text
<invoke name="write"><parameter name="path">notes/a & b.txt</parameter><parameter name="options">{"append":false,"tags":["draft","xml"]}</parameter></invoke>
```

默认扫描器接受每个参数上的 `string` 覆盖:

- `string="true"`(或除 `false`、`0`、`no` 之外的任何值)强制原始正文保持为字符串。
- `string="false"`、`string="0"` 或 `string="no"` 强制进行 JSON 解析,即使 schema 声明为字符串。

非字符串正文在解析前会去除首尾空白,并交给 OMP 支持修复的 JSON 解析器。若修复失败,则保留原始正文作为字符串。空正文保持为空字符串。没有可用名称的参数会被丢弃。

## 多个与并行调用

OMP 将一批调用渲染为连续的 invoke:

```text
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
```

模型可以可选地包裹整批调用:

```text
<tool_calls>
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
</tool_calls>
```

扫描器为每个 invoke 生成一个内部调用 id;XML 中没有 id。OMP 可以将这些调用作为一批分发。结果必须保持调用顺序,因为 `<tool_response>` 既没有 id 也没有名称。

## 工具结果格式

OMP 在每个独立块中返回每个结果:

```text
<tool_response>
file contents
</tool_response>
<tool_response>
ENOENT: file not found
</tool_response>
```

连续的结果块以换行分隔,放在一条合成的 `user` 消息中。结果文本原样插入。工具结果中的图像块保留在该消息中渲染文本之后。

通用 XML 协议**没有成功/错误标记**。`renderToolResults` 有意将 `isError: true` 渲染成与成功相同的 `<tool_response>` 形状;错误必须能从其文本中辨认出来。模型绝不能自行生成 `<tool_response>`。

## 思考与可见文本

OMP 将保留的思考渲染为:

```text
<thinking>
reasoning text
</thinking>
```

对于常规的自有工具流,`parseThinking` 已启用。使用默认的 Anthropic 标签集时,`<thinking>`、`<think>` 和 `<scratchpad>`(包括支持的带前缀形式)会成为独立的思考事件,不会出现在可见文本中。将 `parseThinking` 保持为 false 的直接扫描器消费者会把那些标签当作文本。未闭合的思考块在刷新时逻辑上关闭,并保留其内容。

可见的散文可以出现在未包裹的 invoke 之前或之间。在识别出的 `<tool_calls>` 或 `<function_calls>` 包裹层内,非调用文本会被丢弃。

## 扫描器标签集

`XmlInbandScanner` 根据 `InbandScannerOptions.xmlTagset` 委托给两个扫描器之一:

| `xmlTagset` | 扫描器 | 接受的调用语法 | 参数规则 |
| --- | --- | --- | --- |
| 省略或 `anthropic` | `AnthropicInbandScanner` | 普通/`antml:` 前缀的 `<invoke>/<parameter>`,可选地放在 `<tool_calls>` 或 `<function_calls>` 内 | 工具 schema 决定字符串;`string` 属性可覆盖 |
| `dsml` | `DeepSeekInbandScanner` | 管道包裹的 DSML 信封与 invoke(以及该扫描器的 DeepSeek token 语法) | 参数默认为字符串;只有 `string="false"` 请求 JSON 强制转换 |

直接 API 消费者可以请求 DSML 解析:

```ts
import { createInbandScanner } from "@oh-my-pi/pi-ai/dialect";

const scanner = createInbandScanner("xml", {
  xmlTagset: "dsml",
  parseThinking: true,
});
```

DSML 接受全角管道标签:

```text
<｜DSML｜tool_calls>
<｜DSML｜invoke name="read">
<｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>
<｜DSML｜parameter name="count" string="false">2</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

它也接受 ASCII 管道等价形式,如 `<|DSML|tool_calls>`。在 DSML 模式下,`string="false"` 解析修复后的 JSON;无效 JSON 回退为原始字符串。DSML 思考使用 `<think>…</think>`,默认会解析,除非设置 `parseThinking: false`。

`xmlTagset` **只改变扫描器选择**。`xml` 定义的调用、结果、思考和转录渲染器始终发出上文所述的通用纯 XML 形式。常规 `tools.format: xml` 自有流路径不传递 `xmlTagset`,因此使用 Anthropic 标签集。OMP 目前使用 DSML 选择器对泄漏的 DSML 输出进行流标记修复,而不是为了改变 `tools.format: xml` 渲染器。

## 流式、畸形输出与恢复

### 默认 Anthropic 标签集

解析是增量的,并且跨提供商分块边界也是安全的。对于每个非空的 `<invoke name="…">`,扫描器:

1. 在开头的 invoke 标签完整后立即发出 `toolStart`;
2. 在参数正文流式传输时发出带键的 `toolArgDelta` 事件;并且
3. 仅在匹配的 `</invoke>` 之后执行最终强制转换并发出 `toolEnd`。

完成事件包含用于诊断的精确原始 invoke 块。包裹层文本不属于该原始块。

失败行为是明确的:

- 名称缺失/为空的 invoke 不发出任何工具生命周期事件;
- 名称缺失/为空的参数被忽略;
- 畸形 JSON 回退为原始文本;
- 参数内容上限为 1,000,000 个 JavaScript 字符串码元,溢出时追加显式的截断标记;
- 不完整的参数或 invoke 在刷新时不发出 `toolEnd`;并且
- 即使外层包裹从未闭合,完整的 invoke 仍然有效。

OMP 的流投影器在 `toolStart` 时(早于 `toolEnd`)创建规范调用。因此,在正常停止的提供商响应中,未闭合的 invoke 可能作为部分可运行的调用保留:已流式传输的参数文本保持未强制转换状态,或者如果没有参数到达则为 `{}`。提供商的 `length` 停止保持不可运行的 `length`。此行为适用于常规自有 `xml` 路径,在诊断标签中途停止的模型输出时很重要。

### DSML 标签集

DSML 扫描器也以带键的增量方式流式传输每个参数,并且只在 `</｜DSML｜invoke>` 或其 ASCII 等价形式处发出 `toolEnd`。不完整的 DSML 参数会在刷新时重置部分调用,不发出完成事件。由于 `xmlTagset: dsml` 是直接扫描器选项,而非常规自有渲染器路径,消费这些事件的调用方需自行处理不匹配的 `toolStart`。

### 模型虚构的结果

对于通用 XML 方言,第一个由模型生成的 `<tool_response>` 被视为虚构结果的边界。OMP 保留它之前的调用/文本,并在那里停止投影。默认的 `tools.abortOnFabricatedResult: true` 会中止提供商生成;禁用该设置会排空但丢弃虚构的后续内容。

## 端到端示例

注入的目录行:

```text
<tools>
{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"number"}},"required":["city"]}}}
</tools>
```

助手调用批次:

```text
I'll compare both cities.
<invoke name="get_weather"><parameter name="city">Tokyo</parameter><parameter name="days">2</parameter></invoke>
<invoke name="get_weather"><parameter name="city">Oslo</parameter><parameter name="days">2</parameter></invoke>
```

OMP 生成的下一个用户轮次:

```text
<tool_response>
{"forecast":["clear","rain"]}
</tool_response>
<tool_response>
{"forecast":["rain","cloudy"]}
</tool_response>
```

助手随后正常回答,或发出另一组 invoke。

## 解析注意事项与陷阱

- **不是真正的 XML。** 参数正文是分隔符匹配的,并有意的未转义。XML 解析器/实体解码器会改变它们的值。
- **渲染器与扫描器的接受范围不同。** OMP 渲染裸的连续 invoke;默认扫描器额外接受两种包裹层和 `antml:` 变体。
- **没有调用 id 或结果名。** 在并行批次中保持调用/结果顺序。
- **错误只是文本。** 通用 `<tool_response>` 不编码 `isError`。
- **schema 上下文很重要。** 向渲染器/扫描器 API 提供工具定义,使 schema 声明的字符串保持字面量,而不是被 JSON 引号包裹/强制转换。
- **`xmlTagset` 仅作用于扫描器。** 选择 DSML 不会让 XML 渲染器发出 DSML。
- **闭合标签确定调用完成。** `toolStart` 和参数增量提前流式传输,但只有 `</invoke>` 才产生最终强制转换的参数对象和 `toolEnd`。

## 参考来源

- `packages/ai/src/dialect/xml.md` — 注入的通用 XML 格式指南。
- `packages/ai/src/dialect/xml.ts` — 渲染器定义与 Anthropic/DSML 扫描器选择。
- `packages/ai/src/dialect/anthropic.ts` — 默认增量 invoke/参数扫描器、强制转换、思考与不完整调用行为。
- `packages/ai/src/dialect/deepseek.ts` — DSML 信封扫描器与 `string="false"` 强制转换。
- `packages/ai/src/dialect/catalog.ts` 与 `prompt-template.md` — 工具目录与系统提示词注入。
- `packages/ai/src/dialect/rendering.ts`、`history.ts` 与 `owned-stream.ts` — 结果渲染、历史转换、投影与虚构结果处理。
- `packages/ai/src/utils/stream-markup-healing.ts` — 当前 DSML 扫描器集成。
- `packages/coding-agent/src/sdk.ts` — `tools.format` 解析。
- `packages/ai/test/inband-tools.test.ts` 与 `dialect-thinking.test.ts` — 往返、分块参数增量、原始块、结果渲染与思考行为。
