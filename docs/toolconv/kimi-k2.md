# Kimi K2 工具调用格式

月之暗面(Moonshot AI)**Kimi K2** 系列(`moonshotai/Kimi-K2-Instruct` 与 `-Base`,`model_type: "kimi_k2"`,1T 参数 MoE)的原生工具调用约定。它是在 TikToken tokenizer(160K 词表)之上构建的类 ChatML 信封:每个轮次是 `<|im_{class}|>{name}<|im_middle|>{body}<|im_end|>`,工具调用在 assistant 轮次内由专用的 `<|tool_calls_section_begin|>…<|tool_calls_section_end|>` 块包裹输出。所有控制 token 都是纯 ASCII 的 `<|…|>` 形式(没有全角/unicode 变体,与 DeepSeek 不同)。推理服务器通过解析器把原始流转换为 OpenAI 风格的 `tool_calls`:vLLM 与 SGLang 都提供 `--tool-call-parser kimi_k2`(vLLM 另外还需要 `--enable-auto-tool-choice`)。聊天模板(自 2025.8.11 更新起是独立的 `chat_template.jinja`)注入工具 schema 并渲染每轮标记。

本文档已对照模型卡、官方 `docs/tool_call_guidance.md` 与 `docs/deploy_guidance.md`(GitHub `MoonshotAI/Kimi-K2`)、来自 HF 仓库的原始 `chat_template.jinja` 与 `tokenizer_config.json`(已在本地渲染以获得下方的逐字节精确流),以及 vLLM `kimi_k2` 工具解析器源码进行了验证。

## 特殊 token

手动解析所需的五个工具调用标记,以及 ChatML 信封标记。token ID 来自 `tokenizer_config.json`(`added_tokens_decoder`)。

| Token(原文) | ID | 用途 |
|---|---|---|
| `<\|tool_calls_section_begin\|>` | 163595 | 在 assistant 轮次内打开工具调用区块 |
| `<\|tool_call_begin\|>` | 163597 | 打开一次单独的工具调用 |
| `<\|tool_call_argument_begin\|>` | 163598 | 把工具调用 ID 与其 JSON 参数分隔开 |
| `<\|tool_call_end\|>` | 163599 | 关闭一次单独的工具调用 |
| `<\|tool_calls_section_end\|>` | 163596 | 关闭工具调用区块 |
| `<\|im_system\|>` | 163594 | system 类轮次(`system`, `tool`, `tool_declare`)的开始标记 |
| `<\|im_user\|>` | 163587 | user 轮次的开始标记 |
| `<\|im_assistant\|>` | 163588 | assistant 轮次的开始标记 |
| `<\|im_middle\|>` | 163601 | 把角色/名称头部与消息主体分隔开 |
| `<\|im_end\|>` | 163586 | 结束任何轮次 |
| `[BOS]` | 163584 | 序列开始 token(见说明;聊天模板不会输出) |
| `[EOS]` | 163585 | 序列结束 token |

精确性说明:
- 五个工具 token 使用 ASCII 竖线 `|`(U+007C)和下划线;请精确复现。Kimi K2 中没有全角竖线(`｜`)或 `▁` 变体。
- `<|im_middle|>` 是唯一的信封 token,其 ID(163601)与其余(163586–163599)不连续;`163600` 槽位未使用。
- 图像输入通过内容宏渲染为字面序列 `<|media_start|>image<|media_content|><|media_pad|><|media_end|>`。这些媒体标记出现在模板中,但**没有**在 `added_tokens_decoder` 中注册,因此它们作为普通文本而不是单个特殊 token 进行 token 化。它们与文本工具调用无关,这里列出仅为完整性。

## 角色 / 通道 / 轮次结构

Kimi K2 使用类 ChatML 的信封。每条消息渲染为:

```text
<|im_{class}|>{name}<|im_middle|>{body}<|im_end|>
```

- 恰好有**三个**开始标记 token,按 `role` 选择:
  - `user` → `<|im_user|>`
  - `assistant` → `<|im_assistant|>`
  - 其他一切(`system`, `tool`,以及合成的 `tool_declare`)→ `<|im_system|>`
- 标记与 `<|im_middle|>` 之间的 `{name}` 段是 `message.name or message.role`。这是 Kimi K2 唯一的“通道”/子角色标签。对于普通轮次,它就是字面的 `system`, `user` 或 `assistant`;对于工具结果轮次,提供时它是工具的 `name`(函数名),否则是 `tool`;对于工具 schema 轮次,它是字面的 `tool_declare`。
- `<|im_end|>` 终止每个轮次。聊天模板**不**输出 `[BOS]`/`[EOS]`;轮次边界纯粹由 `<|im_*|>` 标记决定(tokenizer 基于 TikToken,`add_bos_token`/`add_eos_token` 未设置,手动解析流程把渲染后的模板直接喂给 `/completions`)。
- **默认系统提示词:** 如果第一条消息不是 `system` 消息,模板会在第一轮之前注入 `<|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|>`。
- **生成提示词:** 当 `add_generation_prompt=True` 时,模板以 `<|im_assistant|>assistant<|im_middle|>` 结束,模型从那里开始生成。
- **思考/推理:** `Kimi-K2-Instruct` 是一个“反射级”模型,没有长思考,因此此格式中没有推理通道。(思考变体另行处理 —— vLLM 提供基于 `</think>` token 的独立 `kimi_k2` 推理解析器 —— 但那超出本文档所讲的 Instruct 工具调用格式的范围。)

## 工具定义

可用工具在提示词最顶部的专用轮次中广告(在任何 system/user 轮次之前),使用 `<|im_system|>` 标记下的合成 `tool_declare` 子角色:

```text
<|im_system|>tool_declare<|im_middle|>{TOOLS_JSON}<|im_end|>
```

`{TOOLS_JSON}` 是标准 OpenAI 风格的 `tools` 数组,用**紧凑分隔符** `(',', ':')`(无空格)序列化为 JSON。数组元素原样传递,即每个都是 `{"type":"function","function":{"name":…,"description":…,"parameters":{…}}}`,带有 JSON-Schema `parameters` 对象。示例(单个工具,与输出完全一致):

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|>
```

`tool_declare` 轮次仅在 `tools` 非空时渲染。

## 工具调用格式

当模型决定调用函数时,它在 assistant 轮次内、任何自然语言内容之后输出一个工具调用区块。最小的单次调用(这是 `<|im_assistant|>assistant<|im_middle|>` 之后的 assistant 生成):

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|>
```

单次调用的结构:

```text
<|tool_call_begin|>  functions.{func_name}:{idx}  <|tool_call_argument_begin|>  {JSON arguments}  <|tool_call_end|>
```

- `<|tool_call_begin|>` 与 `<|tool_call_argument_begin|>` 之间的 token 是**工具调用 ID**,具有固定形式 `functions.{func_name}:{idx}`。
  - `functions.` 是字面前缀(不是从工具 schema 派生的)。
  - `{func_name}` 是被调用函数的名称;函数名通过从这个 ID 中解析出来恢复,而不是来自单独的字段。
  - `{idx}` 是当前 assistant 轮次内的**从 0 开始的调用索引**(第一次调用为 `0`,第二次为 `1`,……)。
- `<|tool_call_argument_begin|>` 之后是原始 JSON 参数对象(例如 `{"city": "Beijing"}`),以 `<|tool_call_end|>` 终止。
- 该轮次的所有调用都位于一对 `<|tool_calls_section_begin|>` / `<|tool_calls_section_end|>` 之间。任何 assistant 文本内容都位于 `<|tool_calls_section_begin|>` 之前。
- 整个 assistant 轮次仍由 `<|im_end|>` 关闭,补全的 `finish_reason` 变为 `tool_calls`。

## 多个 / 并行工具调用

同一轮次中的两次或更多调用作为单个区块内连续的 `<|tool_call_begin|>…<|tool_call_end|>` 块输出,索引随每次调用递增。两个并行调用的原始 assistant 输出:

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_call_begin|>functions.get_weather:1<|tool_call_argument_begin|>{"city": "Shanghai"}<|tool_call_end|><|tool_calls_section_end|>
```

注意 ID `functions.get_weather:0` 与 `functions.get_weather:1` —— 同一个函数,尾随索引不同。索引按轮次计算(在下一个 assistant 轮次中重置为 `0`)。

## 工具结果格式

工具执行结果以 `role: "tool"` 的轮次回喂。由于 `tool` 不是 `user`/`assistant`,它在 `<|im_system|>` 标记下渲染;子角色标签在存在时是消息的 `name`(函数名),否则是 `tool`。主体是字面的 `## Return of {tool_call_id}` 头部行,后跟结果内容:

```text
<|im_system|>get_weather<|im_middle|>## Return of functions.get_weather:0
{"weather": "Sunny"}<|im_end|>
```

- `{tool_call_id}` 回显了发起调用的确切 ID(`functions.get_weather:0`),模型正是靠它把结果与产生它的调用关联起来。
- 结果 `content` 原样插入到头部行之后的下一行;调用方通常传入 JSON 字符串(例如 `json.dumps(tool_result)`)。
- 如果 `tool` 消息省略了 `name`,信封变成 `<|im_system|>tool<|im_middle|>## Return of …`。

## 端到端示例

一个完整的多轮天气对话。以下是精确渲染的流(system + user 显式提供;轮次内的换行是字面的,轮次之间首尾相接)。

**阶段 1 —— 喂给模型的提示词**(已设置 `tools`,`add_generation_prompt=True`):

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|><|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|><|im_user|>user<|im_middle|>What's the weather like in Beijing today? Use the tool to check.<|im_end|><|im_assistant|>assistant<|im_middle|>
```

**Assistant 生成**(模型输出;服务器报告 `finish_reason: "tool_calls"`):

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|><|im_end|>
```

**阶段 2 —— 下一轮次的提示词**,在追加 assistant 工具调用轮次与工具结果轮次之后(`add_generation_prompt=True`):

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|><|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|><|im_user|>user<|im_middle|>What's the weather like in Beijing today? Use the tool to check.<|im_end|><|im_assistant|>assistant<|im_middle|><|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|><|im_end|><|im_system|>get_weather<|im_middle|>## Return of functions.get_weather:0
{"weather": "Sunny"}<|im_end|><|im_assistant|>assistant<|im_middle|>
```

**最终 assistant 生成**(模型产生以 `<|im_end|>` 终止的自然语言回答;`finish_reason: "stop"`):

```text
It's sunny in Beijing today.<|im_end|>
```

## 兼容 OpenAI 的 API 映射

在启用服务器解析器(`--tool-call-parser kimi_k2`)的情况下,原始流按如下方式映射到 Chat Completions 形状:

- 轮次包含工具调用区块时,`choices[].finish_reason` = `"tool_calls"`(否则为 `"stop"`)。
- `choices[].message.tool_calls[]` —— 每个 `<|tool_call_begin|>…<|tool_call_end|>` 块对应一个条目:
  - `.id` = 原始调用 ID 原样,例如 `"functions.get_weather:0"`。
  - `.type` = `"function"`。
  - `.function.name` = 从 ID 解析出的函数名。vLLM 计算 `id.split(":")[0].split(".")[-1]` → `"get_weather"`。
  - `.function.arguments` = **JSON 字符串**(在 `<|tool_call_argument_begin|>` 与 `<|tool_call_end|>` 之间捕获的原始文本),例如 `"{\"city\": \"Beijing\"}"`。客户端在使用前对其执行 `json.loads()`。
- 工具结果以下列形式的消息回传:

  ```json
  {"role": "tool", "tool_call_id": "functions.get_weather:0", "name": "get_weather", "content": "{\"weather\": \"Sunny\"}"}
  ```

  `tool_call_id` 必须等于调用返回的 `id`;`name` 成为 `<|im_system|>{name}<|im_middle|>` 子角色;`content` 成为 `## Return of …` 之后的主体。
- 流式:增量以 `choices[].delta.tool_calls[]` 形式到达,带有 `index`;调用头部完成后,函数 `name`/`id` 流式输出,然后 `function.arguments` 以增量字符串片段流式输出供拼接(标准 OpenAI 工具调用流式组装)。

月之暗面的托管 API(`platform.moonshot.ai`)同时暴露 OpenAI 兼容与 Anthropic 兼容端点;Anthropic 兼容端点按 `real_temperature = request_temperature * 0.6` 缩放温度。`Kimi-K2-Instruct` 的推荐采样温度为 `0.6`。

## 解析说明与注意事项

- **ID → 名称解析在参考实现间不同。** 官方 `tool_call_guidance.md` 使用 `function_id.split('.')[1].split(':')[0]`,而 vLLM 和 omp 取冒号前的最后一个点分隔段。后者容忍额外的命名空间段,但两种约定都无法在函数名中保留字面点号;工具名 SHOULD 遵循文档化的 `functions.{name}:{idx}` 形状,`{name}` 中不带点。
- **提取正则也不同。** 指南:`<\|tool_call_begin\|>\s*(?P<tool_call_id>[\w\.]+:\d+)\s*<\|tool_call_argument_begin\|>\s*(?P<function_arguments>.*?)\s*<\|tool_call_end\|>`。vLLM:ID 类为 `[^<]+:\d+`,参数主体使用负前瞻 `(?:(?!<\|tool_call_begin\|>).)*?`,这样相邻调用不会被合并。两者都以 `DOTALL` 运行。
- **`skip_special_tokens` 必须为 False。** 解析器依赖字面标记文本在去 token 化后幸存;vLLM 在启用工具且 `tool_choice != "none"` 时强制 `skip_special_tokens = False`。如果标记被剥离,就检测不到工具调用。
- **参数是未验证的原始文本。** 模型在参数标记与 `<|tool_call_end|>` 之间输出的任何内容都会直接作为 `arguments` 字符串传递;它必须是有效的 JSON 才能供下游 `json.loads` 使用,而模型可能输出畸形/截断的 JSON。执行前请验证。
- **索引语义。** `{idx}` 是从 `0` 开始的按轮次调用计数器;它不是全局计数器,并在每个 assistant 轮次重置。不要假设 ID 跨轮次唯一 —— 持久化历史时按轮次消歧。
- **流式标记切分。** 区块与调用标记可能跨越 token 边界被切分。vLLM 会暂存任何部分匹配标记的尾部后缀,并流式输出参数片段。omp 的自有扫描器也会暂存部分标记,但会把调用的参数缓冲到 `<|tool_call_end|>` 为止,并且不输出 `toolArgDelta` 事件。
- **`finish_reason` 因引擎而异。** 官方指南明确警告工具调用的终结 `finish_reason`“may vary across different engines(可能因引擎而异)”;以 `finish_reason == "tool_calls"` 循环,但要做好防御。
- **引擎回退。** Kimi K2 复用 DeepSeek-V3 架构;`config.json` 设置 `model_type: "kimi_k2"`,因此引擎会应用正确的解析器。如果你把 `model_type: "deepseek_v3"` 强制作为兼容性变通方案,则没有可用的原生 Kimi 工具解析器,你必须手动解析 `<|tool_calls_section_*|>` 标记。
- **解析器可用性。** vLLM 同时提供 Python(`KimiK2ToolParser`)与较新的 Rust 工具解析器;SGLang 实现自己的 `kimi_k2` 解析器。它们都基于本文档描述的相同五个标记和 `functions.{name}:{idx}` ID 约定。
- **空白伪影。** 当没有提供 `system` 消息时,模板会注入默认系统提示词,第一个 `<|im_user|>` 标记之前可能出现一个小的 `\n  `(换行 + 两个空格)。它无害(会在标记周围进行 token 化),但提供显式 system 消息会得到上面所示的干净流。

## omp / pi 转换器行为

仓库的 `kimi` 方言是一个**自有带内转换器**。用 `PI_DIALECT=kimi`(或等效的 Agent 配置)选择它。当存在工具时,Agent 会把 Kimi 指南与精简工具目录追加到系统提示词,移除原生提供商工具,把先前的调用/结果改写为 Kimi 文本形式,并把流式输出转换回规范的 pi 事件。Kimi 系列模型亲和度解析为该方言。

渲染器为每个 assistant 调用批次输出一个区块。它保留已以 `functions.` 开头的既有 id;否则生成 `functions.{name}:{batchIndex}`。工具结果渲染为连续的 `<|im_system|>{name}<|im_middle|>## Return of …<|im_end|>` 轮次,规范的工具结果消息被折叠成包含该文本的一条合成用户消息。

扫描器只识别区块内的调用。一旦参数标记到达,它保留原始头部作为调用 id,从第一个冒号前的最后一个点分隔段推导名称,并输出 `toolStart`。它把参数主体缓冲到 `<|tool_call_end|>` 为止,然后应用共享的修复 JSON 解析器并输出 `toolEnd`;它**不**输出增量参数增量。无效/非对象的已完成参数规范化为 `{}`。如果 EOF 在 `toolStart` 之后、闭合标记之前到达,则不会输出 `toolEnd`,但规范的 `{}` 调用仍然存在,并可能在正常停止时被派发。只有从未到达参数标记的不完整输入会被丢弃而不创建调用。区块标记从可见文本中抑制,而区块外的孤立调用标记仍是普通文本。

思考解析默认启用,并把 `<think>…</think>` 映射为思考事件。`parseThinking: false` 会让这些标签及其内容保留在可见文本中。

## 来源

- 模型卡(工具调用部分、OpenAI 风格示例、部署/API 说明):https://huggingface.co/moonshotai/Kimi-K2-Instruct
- 官方工具调用指南(标记、ID 约定、手动解析器、`extract_tool_call_info`):https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/docs/tool_call_guidance.md(HF 的 `resolve`/`blob` 路径重定向到模型卡;已对照此 GitHub raw 文件验证)
- 部署指南(`--tool-call-parser kimi_k2`, `--enable-auto-tool-choice`、SGLang 标志、`model_type` 回退):https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/docs/deploy_guidance.md
- 聊天模板(`chat_template.jinja`,已在本地渲染以获得逐字节精确的流):https://huggingface.co/moonshotai/Kimi-K2-Instruct/resolve/main/chat_template.jinja
- Tokenizer 配置(`added_tokens_decoder` 中的特殊 token ID):https://huggingface.co/moonshotai/Kimi-K2-Instruct/resolve/main/tokenizer_config.json
- vLLM `kimi_k2` 工具解析器(标记、正则、名称解析、`skip_special_tokens`、流式):https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/kimi_k2_tool_parser.py
- 添加该解析器的 vLLM PR:https://github.com/vllm-project/vllm/pull/20789
- vLLM 工具调用文档:https://docs.vllm.ai/en/latest/features/tool_calling/
