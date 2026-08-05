# @oh-my-pi/snapcompact

面向可看图的 LLM 的位图帧上下文压缩。

与其让 LLM 总结被丢弃的对话历史,snapcompact 会把历史序列化,并把文本渲染成密集的、由像素字体字形组成的 PNG 帧,让视觉模型直接读回。整个过程本地且确定——无需 LLM 调用、无需 API 密钥、除渲染外零延迟。栅格化与 PNG 编码在原生代码中完成(`@oh-my-pi/pi-natives`)。

为 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的压缩管线而建,但渲染 API 可用于任意文本。

## 工作原理

1. 被丢弃的历史序列化为紧凑文本(`serializeConversation`),带按工具结果与按参数的字符上限。
2. 文本针对所选原生字体做归一化(`normalize`):剥离 ANSI 序列、折叠空白、把连续换行折成一个整块字形、把制表符画与兼容符号折成 ASCII、把语义 emoji 折成 ASCII 标签、丢弃装饰性 emoji;当所选字体或内嵌 Silver 回退能渲染时,保留非拉丁字形。
3. 文本页栅格化为 PNG 帧(`render` / `renderMany`)。帧宽按形状固定;高度紧贴实际打印的行,因此未填满的帧不会按空像素行计费。
4. 帧保存在压缩条目的 `preserveData` 中,并在每次上下文重建时重新附加到摘要消息。

帧形状按提供商感知,由针对真实提供商计费的 SQuAD 召回评测(见 `research/`)选定:

| 读取方 | 默认形状 | 说明 |
| --- | --- | --- |
| Anthropic | `11on16-bw` | X.org 8x13 字形,11px 步进;高分辨率 Claude 行得到 1932px 帧 |
| Google | `8on22-bw` @2048 | X.org 8x13 字形,22px 间距;Gemini 按固定每图预算计费,因此更大的帧是免费字符 |
| OpenAI | `8on22-bw` | X.org 8x13 字形,22px 间距,以 `detail: "original"` 发送 |
| 未知 | Anthropic 形状 | 按提供商的图像数量预算可防止网关静默丢弃帧 |

`resolveShape({ api, id })` 匹配模型 id,而不只是 wire API——经 Vertex 或 OpenRouter 路由的 Claude 会保留其 Claude 形状,按实际承载请求的网关计价。

位图形状保留提供商调校的几何,缺失字形通过内嵌 Silver TrueType 回退逐字符绘制;东亚(CJK/Kana/Hangul)字形跨两个单元格全宽渲染,以便在狭窄的 ASCII 网格中保持可读。选择 `silver16-bw` 则整个帧都使用 Silver。

## 安装

```sh
bun add @oh-my-pi/snapcompact
```

直接发布 TypeScript 源码(无构建步骤);要求 Bun ≥ 1.3.14。

## 用法

把任意文本渲染成 LLM 图像块:

```ts
import { renderMany, frames, resolveShape } from "@oh-my-pi/snapcompact";

const images = renderMany(longText, { model }); // ImageContent[],第一页在前
const count = frames(longText, { model });      // 不渲染的帧计数
const shape = resolveShape(model);              // 面向读取方的评测最优 Shape
```

对准备好的消息运行一次完整压缩:

```ts
import { compact } from "@oh-my-pi/snapcompact";

const result = await compact(preparation, { model });
// result.summary        — 简短的"恢复先前对话"引导语、阅读指南与 FILES 区块
// result.preserveData   — 有界的归档来源 + 渲染后的图像中间部分
```

## API 面

- **压缩**:`compact`、`CompactionPreparation`、`CompactionResult`、`getPreservedArchive`、`images`、`historyBlocks`
- **渲染**:`render`、`renderMany`、`frames`、`geometry`
- **形状**:`SHAPES`、`SHAPE_VARIANTS`、`resolveShape`、`resolveShapeForText`、`idealShapeVariant`、`isShape`、`isShapeVariantName`
- **文本**:`serializeConversation`、`normalize`、`scanRenderability`、`renderabilityProbeText`、`dimStopwords`、`wrap`
- **预算**:`providerImageBudget`、`MAX_FRAMES_DEFAULT`、`FRAME_TOKEN_ESTIMATE`、`HQ_EDGE_FRAMES`
- **文件操作**:`createFileOps`、`computeFileLists`、`upsertFileOperations`

## 参考

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [压缩架构](../../docs/compaction.md)
- [CHANGELOG](./CHANGELOG.md)
