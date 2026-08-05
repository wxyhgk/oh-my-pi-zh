# MiniMax 自有工具调用格式(`<minimax:tool_call>`)

OMP 的 `minimax` 方言是 MiniMax 家族模型的提示词驱动、带内工具协议。调用是普通的助手文本:一个 `<minimax:tool_call>` 信封包含一个或多个 `<invoke>` 元素。OMP 执行解析出的调用,并在下一个用户轮次中返回一个 `<function_results>` 块。该格式不携带工具调用 id,因此调用和结果按顺序关联。

本参考文档描述 OMP 实现的转换器,而不是 MiniMax 提供商原生的结构化工具 API。它已对照 `packages/ai/src/dialect/minimax.ts`、`packages/ai/src/dialect/anthropic.ts` 中的共享 XML 扫描器、`packages/ai/src/dialect/catalog.ts` 中的提示词组装,以及 `packages/ai/src/dialect/owned-stream.ts` 中的流式投影验证。

## 选择与请求转换

在 `~/.omp/agent/config.yml` 或项目/覆盖层配置中显式设置格式:

```yaml
tools:
  format: minimax
```

`tools.format: minimax` 会为会话强制启用此自有方言。在 `auto` 模式下,OMP 保留提供商原生工具调用,除非所选模型显式 `supportsTools: false`;对于 MiniMax 家族模型 id,该回退解析为 `minimax`。参见 [`tools.format`](../settings.md#tools-and-approvals)。

当自有方言激活时,OMP:

1. 从提供商请求中移除原生结构化 `tools` 字段;
2. 将带内工具目录和 MiniMax 格式指南附加到系统提示词;
3. 把之前的结构化助手调用和工具结果消息改写成这种文本协议;并且
4. 把模型的文本流扫描回结构化工具调用事件。

## 工具定义与提示词注入

注入的提示词以 `# Tools` 开头,说明调用是文本而非原生提供商工具消息,并在 `<tools></tools>` 内列出可用函数。每行是一个紧凑的 OpenAI 风格函数对象,包含归一化后的线上 schema:

```text
<tools>
{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"count":{"type":"number"}},"required":["path"]}}}
</tools>
```

目录之后是来自 `packages/ai/src/dialect/minimax.md` 的 MiniMax 专用指南。其契约要求使用已列出的函数名、字面量字符串/标量正文、JSON 列表/对象、一批调用一个信封,以及不允许模型生成结果块。

## 工具调用信封

单个调用是:

```text
<minimax:tool_call>
<invoke name="read"><parameter name="path">src/main.ts</parameter><parameter name="count">40</parameter></invoke>
</minimax:tool_call>
```

确切结构:

| 元素 | 含义 |
| --- | --- |
| `<minimax:tool_call>…</minimax:tool_call>` | 提示词契约中要求的模型输出信封。 |
| `<invoke name="TOOL">…</invoke>` | 一次调用。`name` 必须是已列出的工具。 |
| `<parameter name="ARG">VALUE</parameter>` | 一个命名参数。参数直接出现在 invoke 内部。 |

渲染器对属性中的工具名和参数名进行 XML 转义。参数正文特意**不**做 XML 转义:此协议是分隔符匹配而非按 XML 解析。例如,字符串正文是 `a & b < c`,而不是 `a &amp; b &lt; c`。字面 `</parameter>` 是唯一保留序列,因为它会闭合该参数。

扫描器比提示词契约更宽容。它接受上述带命名空间的信封、不带前缀的 `<tool_call>` 信封,或信封外的裸 `<invoke>`。模型仍应发出规范的 `<minimax:tool_call>` 形式,使行为不依赖恢复路径。

## 参数编码与强制转换

编码使用所选工具 schema:

| 声明/值的类型 | 渲染的参数正文 | 解析值 |
| --- | --- | --- |
| schema 声明为字符串且运行时值也是字符串 | 原样文本,含前导/尾随空格和换行 | 原样字符串 |
| 数字、布尔值、`null`、数组或对象 | JSON | 解析后的 JSON 值 |
| 没有匹配字符串 schema 的值 | JSON,字符串含引号 | 有效时解析为 JSON |

示例:

```text
<invoke name="write"><parameter name="path">notes/a & b.txt</parameter><parameter name="options">{"append":false,"tags":["x","y"]}</parameter></invoke>
```

扫描器根据提供的工具 schema 解析字符串参数。参数属性可以覆盖该决定:

- `string="true"`(以及除 `false`、`0`、`no` 之外的任何值)强制按原样字符串处理。
- `string="false"`、`string="0"` 或 `string="no"` 强制进行 JSON 解析,即使对 schema 声明的字符串也如此。

对于非字符串参数,仅在进行 JSON 解析时去除首尾空白。OMP 使用支持修复的 JSON 解析器;如果解析仍然失败,则保留原始正文作为字符串,而不是丢弃参数。空正文也保持为空字符串。没有可用 `name` 的参数被忽略。

## 多个与并行调用

并行调用是一个信封内的同级 `<invoke>` 元素,按发出顺序排列:

```text
<minimax:tool_call>
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
</minimax:tool_call>
```

由于线上格式没有 id,扫描器为每个 invoke 铸造一个内部 id。OMP 可以将产生的调用作为一批分发。工具结果必须按相同顺序返回;结果协议没有可用来修复乱序的调用 id。

## 工具结果信封

OMP 将连续的工具结果批量放入一个 `<function_results>` 块。成功和失败使用不同的记录:

```text
<function_results>
<result>
<tool_name>read</tool_name>
<stdout>file contents</stdout>
</result>
<error>
<tool_name>read</tool_name>
<stderr>ENOENT: file not found</stderr>
</error>
</function_results>
```

对每个结果:

- 成功是带 `<stdout>` 的 `<result>`;
- `isError: true` 是带 `<stderr>` 的 `<error>`;
- `<tool_name>` 做 XML 文本转义;
- stdout/stderr 原样插入;并且
- 没有调用 id,因此模型按调用顺序读取记录。

OMP 将此文本放在一条合成的 `user` 消息中。一个工具结果中的文本块被拼接;图像结果块在渲染文本之后仍保持为图像块。模型绝不能自行发出 `<function_results>` 或 `<tool_response>`。

## 思考与可见文本

OMP 将保留的推理块渲染为:

```text
<thinking>
reasoning text
</thinking>
```

在常规自有工具流中,思考解析已启用。MiniMax 扫描器识别 `<thinking>`、`<think>` 和 `<scratchpad>`(包括支持的带前缀形式),发出独立的思考事件,并把内容排除在可见助手文本之外。如果直接扫描器消费者禁用了 `parseThinking`,这些标签会保持为可见文本。未闭合的思考块在流刷新时逻辑上关闭,其累积内容被保留。

可见散文可以出现在工具信封之前。调用之外的文本仍是助手文本;信封内非调用文本会被扫描器丢弃。

## 流式、畸形输出与恢复

扫描器是增量的,并且跨块边界安全:开/闭标签和参数正文可能出现在不同的提供商增量中。其可观察生命周期是:

1. 非空 `<invoke name="…">` 立即发出 `toolStart`;
2. 每个命名参数正文在文本块到达时发出带键的 `toolArgDelta` 事件;并且
3. 匹配的 `</invoke>` 执行最终强制转换,并发出带完整参数和精确原始 invoke 块的 `toolEnd`。

重要的失败行为:

- **缺少调用名:** 该 invoke 不发出任何工具生命周期事件。
- **缺少参数名:** 该参数被忽略。
- **畸形 JSON:** 回退为原始参数文本。
- **超大参数:** 输入上限为 1,000,000 个 JavaScript 字符串码元;溢出时替换为已接受前缀加显式截断标记。
- **不完整 invoke:** 刷新时重置扫描器本地调用状态,不发出 `toolEnd`。但 OMP 的流投影器已经由 `toolStart` 实体化了一个调用;在正常停止的响应上,它保留该部分调用,将轮次标记为工具使用,并可能分发它。已流式传输的参数文本保持未强制转换,无参数文本的调用为 `{}`。提供商的 `length` 停止保持 `length`,而不是变成可运行的工具使用。
- **完整 invoke 之后不完整信封:** 已闭合的 invoke 仍然有效;不要求信封闭合才发出它们的 `toolEnd` 事件。
- **不完整思考:** 保留为思考,并在刷新时逻辑结束。

OMP 还防止模型在其调用之后虚构工具输出。对于此方言,第一个 `<function_results>` 或 `<tool_response>` 边界会停止投影。默认 `tools.abortOnFabricatedResult: true` 会立即中止生成;禁用时,OMP 排空提供商流但丢弃虚构的后续内容。

## 端到端示例

注入的工具定义(缩写为相关的目录行):

```text
<tools>
{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"},"units":{"type":"string"}},"required":["city"]}}}
</tools>
```

助手调用:

```text
I'll check both cities.
<minimax:tool_call>
<invoke name="get_weather"><parameter name="city">Tokyo</parameter><parameter name="units">celsius</parameter></invoke>
<invoke name="get_weather"><parameter name="city">Oslo</parameter><parameter name="units">celsius</parameter></invoke>
</minimax:tool_call>
```

OMP 生成的下一个用户轮次:

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>{"temperature":28,"condition":"clear"}</stdout>
</result>
<result>
<tool_name>get_weather</tool_name>
<stdout>{"temperature":14,"condition":"rain"}</stdout>
</result>
</function_results>
```

助手随后可以正常回答,或发出另一个完整的 MiniMax 调用信封。

## 解析注意事项与陷阱

- **不是真正的 XML。** 不要对参数正文做实体转义,也不要让它们经过 XML DOM 解析器;匹配基于协议分隔符。
- **一个信封,多个 invoke。** 并行是 `<minimax:tool_call>` 内的同级调用,不是 JSON `tool_calls`,也不是每个需要的批次一个信封。
- **schema 决定字符串。** 没有工具 schema 时,即使是 JavaScript 字符串渲染器值也会被 JSON 引号包裹;请向渲染器/扫描器 API 提供工具定义以保证往返。
- **线上没有 id。** OMP 生成的 id 是内部的。保持调用/结果顺序。
- **错误是一等记录。** 使用 `<error>/<stderr>`,而不是包含带外错误标志的成功 `<result>`。
- **规范信封 vs 可接受的恢复语法。** 解析器接受裸 invoke 和 `<tool_call>`,但注入的契约要求 `<minimax:tool_call>`。
- **停止前完成 invoke。** 承诺要调用工具的自然语言不是调用;闭合的 `</invoke>` 才是完成强制转换和常规生命周期的关键。

## 参考来源

- `packages/ai/src/dialect/minimax.md` — 注入的 MiniMax 格式指南。
- `packages/ai/src/dialect/minimax.ts` — 调用、结果、思考和转录渲染器,以及扫描器配置。
- `packages/ai/src/dialect/anthropic.ts` — 共享增量 invoke/参数扫描器和强制转换行为。
- `packages/ai/src/dialect/catalog.ts` 与 `prompt-template.md` — 工具目录和系统提示词注入。
- `packages/ai/src/dialect/history.ts` 与 `owned-stream.ts` — 历史转换、流式投影、不完整调用行为和虚构结果边界。
- `packages/catalog/src/identity/dialect.ts` 与 `packages/coding-agent/src/sdk.ts` — MiniMax 家族亲和性和 `tools.format` 解析。
- `packages/ai/test/inband-tools.test.ts` — 提示词渲染、调用往返、分块参数增量、原始块、MiniMax 信封恢复和结果渲染。
