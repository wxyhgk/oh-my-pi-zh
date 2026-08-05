# 内置本地微型模型实验

本文档总结可选的 **local** 微型模型路径背后的实验:会话标题生成(`providers.tinyModel`)、Mnemopi 记忆提取/整合(`providers.memoryModel`)以及 `auto` 思考层级难度分类器(`providers.autoThinkingModel`,使用记忆模型注册表)。这是给维护者的事实性工程记录:我们测量了什么、哪些配方胜出、我们发布了哪些模型。三个设置默认均为 `online`,因此现有用户不会产生下载或设备端推理成本,除非他们选择启用。在在线路径上,优先使用配置的 `tiny` 角色,当该角色未设置时使用任务特定的在线回退。

## 运行时/环境发现

- **技术栈**:`@huggingface/transformers`(transformers.js)v4,运行于 Bun 之下。在 Bun 中,库加载**原生 `onnxruntime-node` 后端**(而非 WASM 构建)。
- **设备策略**:本地微型模型默认仅 CPU 推理,如果显式的加速提供商无法初始化,会在 CPU 上重试一次。
  - 用 `providers.tinyModelDevice` 设置持久选择提供商(`default` 保持 CPU),或用 `PI_TINY_DEVICE` 环境变量按次选择(它覆盖设置)。
  - 可接受值为 `cpu`, `gpu`, `metal`/`webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`, `webnn`, `webnn-gpu`, `webnn-cpu` 和 `webnn-npu`。
  - 直接使用 `coreml` 仍需通过 `PI_TINY_DEVICE=coreml` 选择启用;它不是默认选项的一部分,因为缓存的 decoder-LLM ONNX 加载在会话初始化期间可能失败。
  - WebGPU/Metal 在单进程评估测试台上有效,但生产 worker 会将 Darwin 的 `gpu`/`webgpu`/`auto` 请求强制回退到 CPU,因为 ONNX Runtime/Bun 当前在 WebGPU 推理后的 worker 拆除阶段会硬崩溃。
  - 仅在显式退出 CPU 默认值时使用 `providers.tinyModelDevice` 或 `PI_TINY_DEVICE`。
- **量化:q4 是甜点** — 磁盘上更小、加载更快、推理也快。q8/int8 在 CPU 上加载更慢_且_推理更慢。每个发布的模型默认 `q4`;用 `providers.tinyModelDtype` 设置持久覆盖精度(`default` 保持 `q4`,例如 `fp16` 用于更高保真度),或用 `PI_TINY_DTYPE` 按次覆盖(它覆盖设置)。接受 `auto`, `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16`;无法识别的值会在 worker 启动时大声失败。
- **加载时间修正(重要)。** 早先认为“q4 >=1B 模型需要几分钟加载”是**测量伪影**,由并行运行约 5 个多 GB 的 HuggingFace 下载(I/O 饱和)造成。干净、隔离的**热**加载都在 3 秒以内:
  - TinyLlama-1.1B q4:约 0.5s
  - Llama-3.2-1B q4:约 2.8s(`graphOpt=all`)/ 约 0.5s(`disabled`)
  - LFM2-1.2B q4:约 0.36s
  - Qwen2.5-1.5B q4:约 1.5s
  - Qwen3-1.7B q4:约 1.6s
  - gemma-3-1b q4:约 1.1s
  - 结论:**1B–1.7B 模型在 CPU 上可行。**
- **`session_options.graphOptimizationLevel`** 在加载与推理速度之间权衡:`disabled` = 加载最快,推理略慢;`all` = 默认。
- **首次运行**从 HF Hub 下载权重到缓存目录(q4 权重约 200MB–1.1GB,视模型而定);后续**热**加载为亚秒到约 3s。推理是异步的,适合后台记忆任务;标题则是半交互的。

## 任务 1:会话标题生成(`providers.tinyModel`)

**任务**:把第一条用户消息变成 3–6 个词的标题。微型模型(1B 以下)就足够。

**胜出配方**:

- 纯系统提示词(无 few-shot)。
- 用 `<title>` **预填充**助手轮次并在 `</title>` **停止**,然后取第一行。
- 贪心解码(`do_sample:false`),聊天模板中 `enable_thinking:false`。

**我们学到的东西**:

- **few-shot 示例会伤害 0.6B 以下模型**的标题;标签预填充甚至能挽救 270M 模型。
- **token 偏置(`bad_words_ids`)在这里确认无效** — 预填充已经控制了开头。

**排行榜**(标签技巧,CPU,热):

| 模型         | 结论                             |
| ------------- | ----------------------------------- |
| LFM2-350M     | 速度/质量平衡最佳(约 212MB) |
| Qwen3-0.6B    | 最稳健                         |
| gemma-3-270m  | 最小可用                     |
| Qwen2.5-0.5B  | 可接受                          |
| SmolLM2-135M  | 太小                           |
| flan-t5-small | 拒绝 — 只是回显输入    |

**发布的本地选项**:`lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`。
**默认设置**:`online`。`omp tiny-models` 的默认本地下载是 `lfm2-700m`。

## 任务 2:Mnemopi 记忆(`providers.memoryModel`)

Mnemopi 运行两个小型 LLM 任务:

1. **提取** — 从单条消息中抽取持久、结构化的条目。
2. **整合** — 将记忆列表总结为 1–3 句忠实的话。

这些需要**比标题更大的模型:1B–1.7B**。我们通过四个并行 Agent 测试了 LFM2-1.2B、Qwen2.5-1.5B、Qwen3-1.7B 和 gemma-3-1b(q4,CPU),每个 Agent 运行 27–31 个实验。

### 提取发现

标准的 5 类别 JSON 提示词在小模型上以两种方式失败:

1. 全空示例 `{"facts":[],...}` 被**逐字复制** → 提取出 0 条事实。
2. 有能力的模型会在**数组内发出 JSON 对象**,Mnemopi 的 `String(item)` 将其强转为字面量字符串 `[object Object]`。

稳健的修复是**每行一个条目的输出格式**(由 Mnemopi 解析器的行回退消费)或**扁平字符串 JSON 数组**。每个模型还会过度提取纯闲聊;显式的 chit-chat → NONE 示例是最好的缓解。

### 与标题相比的技巧极性翻转

- 在 1B 以上,**few-shot 是主导质量杠杆**:例如 Qwen2.5-1.5B 提取 F1 从 0.52 → 0.83(1 → 3 shots);gemma 召回率从 0.65 → 0.92(2 shots)。
- **预填充会伤害提取** — 它强制在闲聊上输出,产生误报。
- **系统分离**(指令放在 system 角色中)对有 system 角色的模型有帮助。
- 两个任务都是**贪心 >= 温度采样**。
- **token 偏置**再次无效。

### 各模型结论(正面交锋,16 夹具集)

- **Qwen3-1.7B** — 最自律的提取:闲聊时返回空,无埋藏事实泄漏,保留语言,干净的扁平 JSON。弱点:粒度粗,漏掉一次多轮值更新。
- **Qwen2.5-1.5B** — 提取粒度最佳(原子事实),抓住了值更新,零闲聊泄漏。弱点:整合最弱(冗长,不去重),一次退化的埋藏事实输出。
- **gemma-3-1b** — 整合最佳(去重有效,忠实,干净的单条记忆)。弱点:泄漏闲聊并翻译了德语。
- **LFM2-1.2B** — 扎实且加载最快。弱点:`Label: value` 噪音、闲聊 + 埋藏泄漏、一条臃肿的单记忆总结。

### 推荐与当前可用性

实验倾向于 **Qwen3-1.7B** 的提取精度,但发布的 ONNX 导出当前无法在 `onnxruntime-node` 下运行:其 RotaryEmbedding 缓存更新不受支持。运行时会加载模型前拒绝该选择,而不是在推理期间失败。

在可运行的选项中,注册表将 `lfm2-1.2b` 标记为推荐的本地记忆模型。`gemma-3-1b` 偏向整合质量,而 `qwen2.5-1.5b` 偏向细粒度提取。

**配置的本地选项**:`llama3.2:3b`, `qwen3-1.7b`(当前按上述说明禁用),`gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`。
**默认设置**:`online`。

### 已知的 Mnemopi 解析器缺陷(由这些实验暴露)

- `String(item)` 对对象数组条目产生 `[object Object]`。
- 行回退会丢弃 `<=10` 字符的条目,因此像 `Name: Can` 这样正确的短事实会被丢弃。

## 集成说明

- `providers.tinyModel`、`providers.memoryModel` 和 `providers.autoThinkingModel` 默认 `online`,因此现有用户**不会产生下载或设备端推理成本**,除非他们选择启用。
- 本地推理在**worker** 中运行(离开主线程);模型缓存在磁盘上,首次使用时下载。
- 记忆本地路径通过 Mnemopi 提示词覆盖应用精炼配方(行格式 + 闲聊防护提取提示词、加固的整合提示词);**在线路径不变**。
- `providers.autoThinkingModel` 使用与 `providers.memoryModel` 相同的发布本地选项。
