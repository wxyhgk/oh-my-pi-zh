# inspect_image

> 将本地图像文件或当前轮次的图像附件发送给支持视觉的模型,并返回文本分析。

## 来源
- 入口:`packages/coding-agent/src/tools/inspect-image.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/inspect-image.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/inspect-image-renderer.ts` — TUI 调用/结果渲染。
  - `packages/coding-agent/src/utils/image-loading.ts` — 路径解析、类型检测、大小门槛、可选缩放。
  - `packages/coding-agent/src/utils/image-resize.ts` — 缩小并重新压缩超大图像。
  - `packages/coding-agent/src/tools/path-utils.ts` — 相对会话 cwd 解析输入路径。
  - `packages/utils/src/mime.ts` — 从文件字节检测受支持的图像格式。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | 本地图像路径(相对 `session.cwd` 解析)、当前轮次的 `Image #N` 标签,或 `attachment://N` / `image://N` URI。附件索引从 1 开始。 |
| `question` | `string` | 是 | 与图像一同作为文本内容块发送的用户提示词。 |

## 输出
该工具返回单个 `AgentToolResult`:

- `content`:一个文本块 `[{ type: "text", text }]`,其中 `text` 是模型响应中拼接后的助手文本内容。
- `details`:
  - `model`:所选模型的 `<provider>/<id>`。
  - `imagePath`:文件输入的解析后文件系统路径,或附件输入的标准附件 URI。
  - `mimeType`:可选缩放/重新编码后实际发送给模型的 MIME 类型。

模型可见的输出是一次性的,不由该工具流式传输。

TUI 渲染会添加来自 `packages/coding-agent/src/tools/inspect-image-renderer.ts` 的纯展示截断:

- 调用预览将 `question` 截断为 100 列,
- 结果视图折叠时显示 4 行,展开时显示 16 行,
- 每条渲染的输出行截断为 120 列,
- 底部元数据在存在时显示 `model · mimeType`。

## 流程
1. 如果会话设置中启用了 `images.blockImages`,`InspectImageTool.execute(...)` 会立即拒绝。
2. 它读取 `session.modelRegistry`;注册表缺失、注册表为空、缺少 API 密钥或模型无法解析,都会从 `packages/coding-agent/src/tools/inspect-image.ts` 抛出 `ToolError`。
3. 模型选择按顺序尝试 `@vision`、`@default`、会话中的活动模型字符串,然后是 `availableModels[0]`。`expandRoleAlias(...)` 与 `resolveModelFromString(...)` 处理每次查找。
4. 所选模型必须声明 `input.includes("image")`;否则在读取文件之前执行就会失败。
5. 该工具将精确的 `Image #N` 标签(包括带方括号的标签)、`attachment://N` 和 `image://N` 解释为对当前轮次图像附件的从 1 开始的引用。其他值作为文件加载:`loadImageInput(...)` 用 `resolveReadPath(...)` 解析路径,用 `readImageMetadata(...)` 检测 MIME 类型,并拒绝大于 `MAX_IMAGE_INPUT_BYTES`(`20 * 1024 * 1024`,即 20 MiB)的文件。附件字节也有相同的 20 MiB 上限。
6. 文件元数据从头部检测。附件输入使用其提供的图像 MIME 类型。受支持的 MIME 类型为 `image/png`、`image/jpeg`、`image/gif` 和 `image/webp`。
7. 加载器使用 `excludeWebP: webpExclusionForModel(model)`(仅对无法解码 WebP 的模型为 `true`,例如 Ollama 系列)。当 `images.autoResize` 为 true,或所选模型必须重新编码 WebP 时,它会调用 `resizeImage(...)`。缩放失败会被吞掉,并保留原始字节。
8. 如果文件头部或附件 MIME 类型不受支持,`execute(...)` 会抛出 `ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.")`。
9. 该工具调用 `instrumentedCompleteSimple(...)`,传入一条包含两个内容部分的用户消息,顺序为:
   - `{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType }`
   - `{ type: "text", text: params.question }`
10. `systemPrompt` 是由 `packages/coding-agent/src/prompts/tools/inspect-image-system.md` 渲染的单元素数组;遥测标记为 oneshot 种类 `inspect_image`。请求携带在解析后的视觉/默认模型角色上选定的思考力度。
11. 模型调用使用调用方信号加上 `inspect_image.timeoutMs`(默认 300,000 ms);`0` 禁用此超时。提供商错误、中止和超时都会变成 `ToolError`。
12. 来自 `packages/coding-agent/src/commit/utils.ts` 的 `extractTextContent(...)` 只拼接助手消息中的 `text` 内容块,修剪结果;如果什么都不剩,该工具会失败。
13. 成功时返回文本加 `details`;`inspectImageToolRenderer` 为 TUI 格式化结果。

## 模式 / 变体
- **原始图像路径**:`images.autoResize` 禁用。原始文件字节被 base64 编码,并以检测到的 MIME 类型发送。
- **自动缩放路径**:`images.autoResize` 启用。`resizeImage(...)` 可能在上传前缩小并重新编码图像。
- **不受支持的图像路径**:文件存在,但头部嗅探无法识别 PNG/JPEG/GIF/WEBP。该工具在任何模型调用之前返回 `ToolError`。
- **超大图像路径**:文件大小在提交前超过 20 MiB。该工具在任何模型调用之前返回 `ToolError`。
- **附件路径**:通过其 `Image #N` 标签或附件 URI 解析当前轮次粘贴/上传的图像,而无需读取文件系统路径。

## 副作用
- 文件系统
  - 对于文件输入,从磁盘解析并读取目标图像。
  - 附件输入从当前轮次的内存图像附件列表中加载。
- 网络
  - 通过 `instrumentedCompleteSimple(...)` / 配置的简单补全实现,将最终的 base64 图像载荷与问题文本发送给所选模型。
- 会话状态
  - 读取会话设置、活动模型偏好、cwd 和模型注册表。
- 后台工作 / 取消
  - 将调用方 `AbortSignal` 传入 `instrumentedCompleteSimple(...)` 和配置的简单补全实现。
  - 图像预处理是本地进行的,在这些辅助函数中不感知取消。

## 限制与上限
- 受支持的检测输入格式:`image/png`、`image/jpeg`、`image/gif`、`image/webp`(`SUPPORTED_IMAGE_MIME_TYPES`,位于 `packages/utils/src/mime.ts`)。
- 元数据嗅探上限:`DEFAULT_IMAGE_METADATA_HEADER_BYTES = 256 * 1024` 字节。格式检测只从文件头部读取最多 256 KiB。
- 可用性由 `packages/coding-agent/src/config/settings-schema.ts` 中的 `inspect_image.mode`(`auto`|`on`|`off`,默认 `auto`)控制,并在 `packages/coding-agent/src/utils/inspect-image-mode.ts` / `packages/coding-agent/src/tools/index.ts` 中结合会话作用域的 `/vision` 覆盖与活动模型的图像能力来解析。`auto` 仅在活动模型缺少原生图像输入时注册该工具;旧的 `inspect_image.enabled` 布尔值会迁移到 `mode`(`true`→`on`,`false`→`off`)。
- 上传输入上限:`MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024` 字节(20 MiB),位于 `packages/coding-agent/src/utils/image-loading.ts`。
- 视觉请求超时:`inspect_image.timeoutMs` 默认为 `300_000` ms(5 分钟);设为 `0` 可禁用。
- `packages/coding-agent/src/utils/image-resize.ts` 中的自动缩放默认值:
  - `maxWidth: 1568`
  - `maxHeight: 1568`
  - `maxBytes: 500 * 1024` 字节(500 KiB 目标)
  - `jpegQuality: 80`
- 缩放快速路径:如果原始图像已在 `1568x1568` 之内且小于 `maxBytes / 4`(默认 125 KiB),`resizeImage(...)` 原样返回原始字节。
- 缩放质量阶梯:第一次编码之后,有损重试使用质量 `[70, 60, 50, 40]`。
- 缩放尺寸阶梯:如果降低质量仍达不到字节目标,重试会按 `[1.0, 0.75, 0.5, 0.35, 0.25]` 缩放尺寸,并在任一边低于 `100` 像素时停止。
- 第一次缩放会编码 PNG、JPEG 和 WebP,然后保留最小的编码缓冲。回退轮次只编码 JPEG 和 WebP,同样保留更小的输出。当 `OMP_NO_WEBP=1`/`true`(或传入了 `excludeWebP`)时,WebP 会从两个阶梯中排除。
- 渲染器上限:
  - `INSPECT_QUESTION_PREVIEW_WIDTH = 100`
  - `INSPECT_OUTPUT_COLLAPSED_LINES = 4`
  - `INSPECT_OUTPUT_EXPANDED_LINES = 16`
  - `INSPECT_OUTPUT_LINE_WIDTH = 120`

## 错误
- 设置门槛:
  - `Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.`
- 模型解析 / 能力:
  - `Model registry is unavailable for inspect_image.`
  - `No models available for inspect_image.`
  - `Unable to resolve a model for inspect_image.`
  - `Resolved model <provider>/<id> does not support image input. Configure a vision-capable model for modelRoles.vision.`
  - `No API key available for <provider>/<id>. Configure credentials for this provider or choose another vision-capable model.`
- 输入文件:
  - `Image file too large: <size> exceeds <limit> limit.`(来自 `ImageInputTooLargeError`,重新映射为 `ToolError`)。
  - `inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.`(当头部嗅探失败时)。
  - `No image attachments are available in this turn...`(当使用了引用但当前轮次没有图像附件时)。
  - `Could not resolve image attachment ... Available image attachments: ...`(当从 1 开始的引用超出范围时)。
- 模型调用:
  - `inspect_image request failed.`(当响应停止原因是 `error` 且没有提供商消息时)。
  - 提供商 `errorMessage` 在存在时原样传递。
  - `inspect_image request aborted.`(响应被中止时)。
  - `inspect_image request timed out after <seconds>s...`(当 `inspect_image.timeoutMs` 到期时)。
  - `inspect_image model returned no text output.`(当过滤后助手消息中没有任何文本块时)。

失败以从 `execute(...)` 抛出的 `ToolError` 呈现;正常的成功返回结构不用于错误报告。

## 备注
- 尽管 `AgentTool.strict` 传输提示为 `false`,ArkType schema 仍显式拒绝未知参数;只接受 `path` 和 `question`。
- 磁盘上的面向模型提示词路径是 `packages/coding-agent/src/prompts/tools/inspect-image.md`;下划线形式不存在。
- 格式支持基于文件内容而非文件扩展名。把非图像文件重命名为 `.png` 并不会使其有效。
- `resolveReadPath(...)` 会尝试 macOS 特有的路径变体:shell 未转义的空格、AM/PM 窄不换行空格文件名、NFD 规范化以及弯引号变体。
- `loadImageInput(...)` 还会计算 `textNote`、`dimensionNote` 和最终的 `bytes`,但 `inspect_image` 不将这些包含在工具输出中。
- 自动缩放可以改变发送给模型的 MIME 类型。JPEG 或 GIF 输入可能以 PNG、JPEG 或 WebP 上传,取决于哪个编码器输出最小。
- 如果 `resizeImage(...)` 抛出异常或无法解码图像,`loadImageInput(...)` 会静默保留原始 base64 载荷,而不是失败。
