# tts

> 从文本生成语音音频文件,并写入 `output_path`。

## 源码

- 入口:`packages/coding-agent/src/tools/tts.ts`
- 本地语音目录:`packages/coding-agent/src/tts/models.ts`
- 本地工作进程客户端:`packages/coding-agent/src/tts/tts-client.ts`
- 会话注入:`packages/coding-agent/src/sdk.ts`(`speechgen.enabled`)

SDK 仅在 `speechgen.enabled=true`(默认 `false`)时注册这个写批准的定制工具。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---:|---|
| `text` | `string` | 是 | 要合成的文本。必须为 `1..15000` 个字符。 |
| `voice_id` | `string` | 否 | 语音 ID。默认为 `eve`;本地后端改用 `tts.localVoice`。 |
| `language` | `string` | 否 | xAI 的语言提示。默认为 `en`。 |
| `output_path` | `string` | 是 | 相对于会话 cwd 解析的目标路径。 |
| `sample_rate` | `number.integer` | 否 | xAI 采样率覆盖。被本地后端忽略。 |
| `bit_rate` | `number.integer` | 否 | xAI MP3 比特率覆盖。对 WAV 与本地后端被忽略。 |

## 输出

- 成功:
  - `content[0].type = "text"`
  - `content[0].text = "Saved <bytes> bytes to <path> (voice=<voice>, codec=<codec>, backend=<backend>...)."`
  - `details = { bytes, voiceId, codec, backend }`
- 缺失凭据、xAI HTTP 以及 `null` 的本地工作进程响应返回 `isError: true`,带一个文本块且无 `details`。其他异常、取消与超时会向上传播。

## 流程

1. SDK 仅在 `speechgen.enabled` 为 true 时注入 `tts`。
2. `output_path` 相对于会话 cwd 解析。请求的编解码器由其不区分大小写的后缀推断:`.wav` 表示 WAV,其他任何后缀表示 MP3。
3. `providers.tts`(默认 `auto`)选择路由:
   - `local` 始终使用本地的设备端后端。
   - `xai` 始终使用 xAI Grok Voice;凭据缺失时返回错误结果。
   - `auto` 优先使用本地,但当存在 xAI 凭据时将 MP3 请求路由到 xAI,因为只有云端路径输出 MP3。
4. 本地合成忽略每次调用的 `voice_id`、`language`、`sample_rate` 与 `bit_rate`;它使用 `tts.localModel` 与 `tts.localVoice`,通过共享的 ONNX tiny-model 工作进程调用 Kokoro-82M,编码 PCM16 WAV,并写入 WAV 文件。
5. xAI 合成解析 Grok Voice 凭据,调用 `<baseURL>/tts`,并直接写入提供商的字节。仅在 WAV、采样率或 MP3 比特率与 xAI 默认值不同时,才发送显式的 `output_format`。

## 模式 / 变体

- 本地后端:完全设备端的 Kokoro-82M,模型权重可用后无网络提供商调用;输出始终为 WAV/PCM16。
- xAI 后端:Grok Voice 云端合成;输出可为 MP3 或 WAV。
- 自动后端:本地,除非 MP3 路径加 xAI 凭据需要云端路由。

## 副作用

- 文件系统:写入 `output_path`,或当本地合成收到非 WAV 目标时写入同级的 `.wav` 路径。
- 网络:xAI 后端调用配置的 xAI/Grok Voice HTTP 端点;本地后端可能通过 tiny-model 栈下载/缓存模型权重。
- 会话状态:读取 cwd、模型注册表以及设置 `providers.tts`、`tts.localModel` 与 `tts.localVoice`。
- 后台工作 / 取消:xAI 调用使用 60 秒超时;本地合成接收调用方的中止信号。
- 流式 / 更新:合成是单次的,不发出 `onUpdate` 进度。

## 限制与上限

- 文本 schema 限制:`1..15_000` 个 JavaScript 字符串字符。
- xAI 默认值:语音 `eve`、语言 `en`、采样率 `24000`、比特率 `128000`;非 `.wav` 路径请求 MP3。
- 描述中列出的内置 xAI 语音:`ara`、`eve`、`leo`、`rex`、`sal`;接受自定义的 xAI 语音 ID。
- 默认本地模型:`kokoro`(`onnx-community/Kokoro-82M-v1.0-ONNX`,q8)。
- 默认本地语音:`af_heart`;支持的本地语音包括 `af_heart`、`af_bella`、`af_nicole`、`af_aoede`、`af_kore`、`af_sarah`、`am_michael`、`am_fenrir`、`am_puck`、`bf_emma`、`bm_george` 与 `bm_fable`。

## 错误

- 缺失 xAI 凭据返回错误结果:`No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+) or set XAI_API_KEY.`
- xAI HTTP 失败返回错误结果,最多包含提供商详情的开头 300 个字符:`xAI TTS failed (<status>): <detail>`。
- 本地工作进程的 `null` 响应返回错误结果,注明模型键以及可能的工作进程/模型下载问题。
- 调用方取消、xAI 60 秒超时、文件系统写入错误以及抛出的本地工作进程失败会向上传播,而不会被包装进 `isError` 结果。

## 备注

- 本地 MP3 输出有意不内置。对 `speech.mp3` 的本地请求会写入 `speech.wav`,并在工具结果中说明。
- `voice_id` 与 `language` 是 xAI 载荷字段;本地语音选择来自设置,因此模型调用不必在每次调用时枚举本地语音 ID。
