# generate_image

> 生成或编辑图像,并将生成的图像文件写入临时路径。

## 来源
- 入口:`packages/coding-agent/src/tools/image-gen.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/image-gen.md`
- 会话注入:`packages/coding-agent/src/sdk.ts`(`getImageGenTools()`)

仅当 `generate_image.enabled=true`(默认 `false`)且会话的显式工具筛选器(如有)请求 `generate_image` 时,该自定义工具才会被注册。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `subject` | `string` | 是 | 主要图像提示词。用于编辑时,请描述期望结果及每张输入图像的作用。 |
| `action` | `string` | 否 | 主体正在进行的动作。 |
| `scene` | `string` | 否 | 地点或环境。 |
| `composition` | `string` | 否 | 拍摄角度与取景。 |
| `lighting` | `string` | 否 | 灯光设置。 |
| `style` | `string` | 否 | 艺术风格。 |
| `text` | `string` | 否 | 要在图像中渲染的文字。保持简短,必要时注明清晰度要求。 |
| `changes` | `string[]` | 否 | 针对输入图像的编辑指令。 |
| `aspect_ratio` | `"1:1" \| "3:4" \| "4:3" \| "9:16" \| "16:9" \| "3:2" \| "2:3"` | 否 | 请求的输出宽高比。 |
| `image_size` | `"1024x1024" \| "1536x1024" \| "1024x1536"` | 否 | 请求的输出尺寸(当所选提供商支持时)。 |
| `input` | `Array<{ path?: string; data?: string; mime_type?: string }>` | 否 | 通过本地路径或内联 base64 数据提供的输入图像。 |
| `provider` | `"auto" \| "openai" \| "openai-codex" \| "antigravity" \| "xai" \| "openrouter" \| "gemini"` | 否 | 单次请求的提供商偏好。优先尝试具体值;`auto` 或省略时使用配置/会话排序。 |

## 输出
- 成功且带图像数据:
  - `content[0].type = "text"`
  - `content[0].text` 汇总提供商/模型与已保存的图像路径。
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, revisedPrompt?, promptFeedback?, usage? }`
- 不带图像数据的提供商响应返回 `imageCount: 0`、空的 `imagePaths` / `images`,以及可用的提供商文本/反馈。

## 流程
1. 仅当功能开关与工具筛选器允许时,SDK 才会通过 `getImageGenTools()` 将 `generate_image` 作为自定义工具注入。
2. 提供商顺序为:请求中指定的具体 `provider`、`providers.imageOrder` 中的条目、当前会话模型对应的图像提供商,然后是内置顺序 `openai`、`openai-codex`、`antigravity`、`xai`、`openrouter`、`gemini`;重复项会被移除。`provider: "auto"` 不会添加提供商。
3. 工具会跳过没有可用凭据的提供商。有凭据的提供商的 HTTP 失败会被收集,然后尝试下一个提供商;校验、解析、本地 I/O、取消与超时失败不属于回退条件。
4. 输入图像在找到第一个可用提供商之后解析一次。`path` 相对会话 cwd 解析并进行内容嗅探。内联 `data` 可以是原始 base64(需要 `mime_type`)或 `data:<mime>;base64,...` URL。
5. 提供商特定的宽高比支持在提供商选定后进行检查。
6. 提供商分发:
   - OpenAI:在处于活动状态的兼容 GPT Responses 模型上进行托管的 Responses 图像生成。
   - OpenAI Codex:在兼容的已连接 ChatGPT/Codex 订阅模型上进行托管的 Responses 图像生成,即使当前聊天模型来自其他提供商。
   - Antigravity:Google Antigravity SSE 端点。
   - OpenRouter:支持图像的聊天补全端点。
   - xAI:Grok Imagine 生成或编辑端点。
   - Gemini:Gemini `generateContent`,并带 `responseModalities: ["IMAGE"]`。
7. 成功提供商响应中的内联图像会保存到临时文件;返回路径及 base64/MIME 图像元数据。不含图像数据的响应返回正常的零图像结果,而非 `isError`。

## 模式 / 变体
- 文生图:提供 `subject` 及可选的 style/composition 字段,不提供 `input`。
- 图像编辑:提供一个或多个 `input` 图像、`changes`,以及能标明每张图像作用的主体描述。
- 文字渲染:使用 `text`;提示词要求调用方请求清晰、易读、拼写正确的短文本。
- 提供商选择:为单次请求设置 `provider` 以优先使用某个后端;在发生有凭据的 HTTP 失败后,回退仍遵循剩余的配置/会话/内置顺序。

## 副作用
- 文件系统:读取本地输入图像,并将生成的输出图像写入 OS 临时目录下的 `omp-image-<snowflake>.<ext>` 文件。
- 网络:将提示词与可选的图像发送到所选图像提供商。响应中的 OpenRouter/xAI 图像 URL 会在保存前先下载。
- 会话状态:读取活动模型、会话 id、cwd、凭据、`providers.imageOrder`、Antigravity 端点设置以及可选注入的 `fetch`。
- 后台工作/取消:提供商调用使用调用方的中止信号,并配合 3 分钟超时。

## 限制与上限
- 本地路径输入上限为 `35 * 1024 * 1024` 字节(`MAX_IMAGE_SIZE`)。内联 base64 输入没有单独的工具级大小上限。
- 路径输入必须存在,且具有受支持的内容嗅探图像类型。每个输入对象必须包含 `path` 或 `data`;两者同时存在时以 `path` 为准。
- 原始 base64 `data` 需要 `mime_type`;data URL 自带 MIME 类型。
- 提供商超时为 `3 * 60 * 1000` 毫秒。
- OpenAI 托管的输出以 WebP 格式请求。其他响应文件使用由 MIME 派生的扩展名(`png`、`jpg`、`gif` 或 `webp`;未知 MIME 类型回退为 `.png`)。
- 常见宽高比为 `1:1`、`3:4`、`4:3`、`9:16` 与 `16:9`;只有 xAI 还接受 `3:2` 和 `2:3`。
- `image_size` 接受 `1024x1024`、`1536x1024` 与 `1024x1536`。在 xAI 上它们分别映射为 `1k`、`2k`、`2k`;省略时默认为 `1k`。
- xAI 编辑请求最多接受 3 张输入图像。

## 错误
- 没有可用的提供商凭据:`No image API credentials found...`;该消息会列出受支持的登录/API 密钥途径。
- 无效输入:文件不存在、文件超过 35 MiB、不受支持的内容嗅探图像类型、缺少 `path`/`data`、图像数据为空,或原始 base64 缺少 `mime_type`。
- OpenAI 路径缺少兼容的 GPT 模型:`Missing active GPT model for OpenAI image generation`。
- Antigravity 凭据缺少 `projectId`:`Missing projectId in antigravity credentials`。
- xAI 编辑引用超过三张:`xAI image edits accept up to 3 reference images...`。
- 如果未能到达任何可用的 xAI 路由,`3:2` 或 `2:3` 请求会失败。
- 有凭据的提供商的 HTTP 失败会继续传递给后续提供商。如果所有这些提供商都失败,工具会抛出 `AggregateError`,其中列出所有尝试过的提供商并包含各自的提供商特定 HTTP 错误。
- 取消、三分钟超时、格式错误的提供商响应与本地 I/O 错误会直接抛出。

## 说明
- 该工具是自定义工具,而非内置的 `AgentTool` 类,因此它的根文档位于此处,尽管面向模型的提示词在 `src/prompts/tools/image-gen.md`。
- 多张输入图像应在 `subject` 中命名为 `Image 1`、`Image 2` 等,以便提供商收到无歧义的编辑指令。
