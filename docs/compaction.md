# 压缩与分支摘要

压缩与分支摘要是两种让长会话保持可用、又不丢失先前工作上下文的机制。

- **压缩(Compaction)** 将旧历史改写为当前分支上的摘要。
- **分支摘要(Branch summary)** 在 `/tree` 导航时捕获被放弃的分支上下文。

两者都作为会话条目持久化,并在重建 LLM 输入时转换回用户上下文消息。

## 关键实现文件

- `packages/agent/src/compaction/compaction.ts`(上下文完整摘要与交接文档生成)
- `packages/snapcompact/src/snapcompact.ts`(snapcompact 策略:历史归档为密集位图图像)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts`(提供商原生流式压缩)
- `packages/agent/src/compaction/shake.ts`(机械式内容删减)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts`(自动维护编排)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## 会话条目模型

压缩和分支摘要是头等会话条目,而非普通的助手/用户消息。

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`、可选 `shortSummary`
  - `firstKeptEntryId`(压缩边界)
  - `tokensBefore`
  - 可选 `details`、`preserveData`、`fromExtension`
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`、`summary`
  - 可选 `details`、`fromExtension`

当上下文被重建时(`buildSessionContext`):

1. 活动路径上最新的压缩被转换为一条 `compactionSummary` 消息。
2. 从 `firstKeptEntryId` 到压缩点的保留条目被重新包含。
3. 路径上之后的条目被追加。
4. `branch_summary` 条目被转换为 `branchSummary` 消息。
5. `custom_message` 条目被转换为 `custom` 消息。

这些自定义角色随后在 `convertToLlm()` 中被转换为面向 LLM 的消息:`compactionSummary` 和 `branchSummary` 变成通过静态模板渲染的用户消息

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`

而 `custom` 消息以开发者消息身份、携带原始内容通过(无模板)。

## 压缩流水线

### 触发方式

压缩/上下文维护可以通过六种方式运行:

1. **手动上下文压缩**:`/compact [instructions]` 调用 `AgentSession.compact(...)`。
2. **自动溢出恢复**:同模型助手错误被判定为上下文溢出之后。
3. **自动不完整输出恢复**:同模型助手消息以 `stopReason === "length"` 结尾之后(OpenAI/Codex `response.incomplete`)。
4. **自动阈值维护**:一次成功轮次之后上下文超过已解析阈值时。
5. **轮次中阈值维护**:工具循环轮次越过阈值且 `compaction.midTurnEnabled !== false` 时,在下一次提供商请求之前。
6. **空闲维护**:`runIdleCompaction()` 可以在未流式输出且未在压缩时调用同一条自动维护路径,原因(reason)为 `"idle"`。

### 压缩形态(图示)

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### 溢出/不完整恢复与阈值/空闲维护

自动路径有意不同:

- **溢出恢复**
  - 触发:当前模型的助手错误被判定为上下文溢出,且该错误不早于最近一次压缩。
  - 重试前,失败的助手错误消息会从活动 Agent 状态中移除。
  - 先尝试上下文升级(context promotion);如果配置了更大的模型,Agent 会切换模型并重试而不压缩。
  - 若升级不可用且压缩已启用,则运行上下文完整压缩,`reason: "overflow"` 且 `willRetry: true`;溢出不使用交接(handoff)策略,因为交接请求会复用溢出的输入。
  - 成功后,安排 `agent.continue()` 重试该轮次。

- **不完整输出恢复**
  - 触发:同模型助手消息以 `stopReason === "length"` 结尾,且该消息不早于最近一次压缩。
  - 恢复前,不完整的助手消息会从活动 Agent 状态中移除。
  - 先尝试上下文升级。
  - 若升级不可用且压缩已启用,则运行自动维护,`reason: "incomplete"` 且 `willRetry: true`。
  - 与溢出不同,不完整输出恢复允许 `compaction.strategy: "handoff"`,因为输入上下文仍可用。
  - 上下文完整成功后,安排 `agent.continue()` 重试该轮次。

- **阈值维护**
  - 触发:成功、非错误的助手消息,其调整后上下文 token 超过 `resolveThresholdTokens(...)`。
  - 当 `compaction.midTurnEnabled !== false` 时,轮次中维护还会在下一个提供商请求前检查安全的工具循环边界。
  - 工具输出裁剪可以在阈值比较之前降低测得的 token 数。
  - 轮次后压缩之前先尝试上下文升级。
  - 若升级不可用,则运行自动维护,`reason: "threshold"` 且 `willRetry: false`。
  - 使用 `compaction.strategy: "handoff"` 时,轮次后阈值维护通常安排一个提示后自动交接任务,而不是写入压缩条目;提示前与轮次中检查以内联方式运行,以免与下一轮次竞争。轮次中检查会抑制交接会话重置,并回退到上下文完整压缩。
  - 成功后,若 `compaction.autoContinue !== false`,轮次后维护会安排一个由 Agent 撰写的开发者自动继续提示(来自 `prompts/system/auto-continue.md`);轮次中维护从不安排单独的继续,因为核心循环已拥有下一个提供商请求。

- **空闲维护**
  - 触发:`runIdleCompaction()`,当未在流式输出且未在压缩时。
  - 使用 `reason: "idle"`,之后不自动继续。

### Shake 策略

`compaction.strategy: "shake"` 执行内联的本地缩减,而不是调用摘要模型。它把符合条件的大块工具结果和大型围栏/XML 块替换为可恢复的 `artifact://` 引用,使用受保护的新近 token 窗口和最小节省阈值。自动 shake 以 `action: "shake"` 发出常规自动压缩事件。

当 shake 无法回收足够上下文以降至恢复带以下时,阈值、不完整输出和溢出恢复会落入上下文完整摘要;这防止了重复的无操作 shake 循环。空闲 shake 不使用该回退,因为空闲定时器在再次运行前会重新检查用量。手动 `/shake` 是一个独立的、更激进的命令,可以针对所有符合条件的历史。

### Snapcompact 策略

`compaction.strategy: "snapcompact"` 用本地、确定性的归档流程(`@oh-my-pi/snapcompact` 的 `compact`)替代 LLM 摘要调用:

- 被丢弃的历史被序列化、折叠空白,并使用内置的公有领域像素字体打印到模型感知的 PNG 帧上(帧宽按形状固定;帧高贴合实际打印的行数)。形状——以及帧尺寸——在模型行被测量时由**模型 id** 决定:Claude 以 11px 字距读取 X.org `8x13` 字形(额外字间距、黑色墨水 — `11on16-bw`;高分辨率行 — Opus 4.7+、Fable、Mythos — 在 Anthropic 4,784 视觉 token 上限下得到 1932px 帧,较旧的行保持 1568px),Gemini 以 22px 间距读取 `8x13` 字形(额外行距、黑色墨水 — 2048px 的 `8on22-bw`,因为 Gemini 3.x 对任何像素尺寸的图像都按固定的 1,120-token 预算计费),GPT/Codex 以 1568px 读取同样的 `8on22-bw` 形状(补丁计费与面积成正比,因此更大的帧无法提高每 token 字符数),Kimi/GLM 以 16px 间距读取 `8x13` 字形(1568px 的 `8on16-bw` — kimi 的处理器在超过 1792px 时会降采样)。经由 Vertex 或 OpenRouter 路由的 Claude 保持其 Claude 形状。未测量的模型回退到其线上 API 家族(Anthropic 家族/未知 → `11on16-bw`,Google → `8on22-bw`,OpenAI 兼容 → `8on22-bw`);计费(按家族的补丁/预算公式、OpenAI 的 `detail: "original"` 提示)始终跟随承载请求的 API,并按解析后的帧尺寸计算。`snapcompact.shape` 设置(默认 `auto`)强制使用某个研究评估变体:方形网格(`8x8r`/`8x8u`/`6x6u`/`5x8` × 句子色调/黑色墨水)或逐模型评估胜者(`6x12-dim`、`8x13-bw`、`8on16-bw`、`8on22-bw`、`11on16-bw`,以及双栏自动换行的 `doc-8on16-bw`/`-sent`/`-sent-dim`,其中 `dim` 用灰色打印停用词)。强制变体保持其几何形状,但会按目标提供商的图像计费重新定价。同一设置也管辖内联系统提示/工具结果成像(`snapcompact.systemPrompt`、`snapcompact.toolResults`)。
- 序列化保持归档的对话密度:工具结果按头+尾截断(默认 2,000 字符、0.6 头部比例),工具调用参数值按单值(500)和单次调用(2,000)封顶,工具输出以暗灰色墨水打印,使对话比工具噪音更突出。所有预算与变暗均可通过 `SerializeOptions` 配置(`toolResultMaxChars`、`toolArgMaxChars`、`toolCallMaxChars`、`truncateHeadRatio`、`dimToolResults`)。
- snapcompact 归档以有界源文本加渲染帧的形式持久化在 `CompactionEntry.preserveData.snapcompact` 下。每次上下文重建时,它被重构为有序的压缩块:最旧边缘为纯文本,中间为图像,最新边缘为纯文本。条目的 `summary` 只是简短的恢复引导语加上常规的文件操作列表。
- 之后的压缩从该有界源文本(`Archive.text`)重新渲染,而不是盲目地携带旧 PNG。`maxFrames` 现在默认为 `MAX_FRAMES_DEFAULT`(80),仅作为上限;当图像中间部分很大时,它会在内部进行中央凹采样(foveate)(HQ/LQ/HQ),而两个时间边缘保持逐字文本。
- 不涉及模型、API 密钥或网络,因此 snapcompact 对溢出恢复同样安全。它需要当前模型支持视觉(`model.input` 包含 `"image"`);否则运行回退到上下文完整并发出警告通知(自动和手动路径)。手动 `/compact` 遵循该策略,除非给出了自定义指令(那意味着定向的 LLM 摘要)。
- 理由:形状表来自 `packages/snapcompact` 中的 snapcompact 200k-token 评估,其中位图帧以更低的计费 token 成本保留了 QA 召回率(对支持视觉的模型而言),优于原始文本。

### 展示转录

压缩不再在视觉上重启对话。TUI 渲染**展示转录**(`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`):按时间顺序排列的每个路径条目,每次压缩在触发点内联显示为一条细分隔线 — `── 📷 compacted · ctrl+o ──`。展开(ctrl+o)可查看摘要。只有 LLM 上下文在压缩边界重置;分隔线上方的回滚内容保持完整,包括跨会话恢复。

### 压缩前裁剪

在压缩检查之前,工具结果裁剪可能会运行(`pruneToolOutputs`)。

默认裁剪策略:

- 保护最新 `40_000` 个工具输出 token。
- 要求至少 `20_000` 的估计总节省。
- 从不把低于 `50` token(`MIN_PRUNE_TOKENS`)的结果置空:`[Output truncated - N tokens]` 占位符约耗 8 个 token,因此裁剪低于下限的结果会增大上下文并白白搅动提示缓存。(被取代和无用的结果各有自己的规则——无用收集器已经丢弃零节省候选;被取代的读取无论大小都出于正确性而裁剪。)
- 从不裁剪 `skill` 工具结果、`skill://` 路径的 `read` 结果,或活动计划引用文件的读取(通过 `AgentSession` 的计划保护添加)。

被裁剪的工具结果替换为:

- `[Output truncated - N tokens]`

如果裁剪改变了条目,会话存储会被重写,Agent 消息状态会在压缩决策前刷新。

### 无用结果省略

工具可以把已完成的结果标记为上下文无用——零匹配的搜索、所有东西仍在运行时超时的 `hub` 等待、空的 `hub` 收件箱排空。该标志起源于工具结果(`AgentToolResult.useless`,通过 `ToolResultBuilder.useless()` 或直接在返回对象上设置),由 Agent 循环复制到持久化的 `ToolResultMessage` 上(绝不与 `isError` 同时出现——错误始终优先),并在三处被消费:

- **逐轮次过期结果传递**(`pruneSupersededToolResults`,由 `compaction.dropUseless` 门控,默认开启):被标记的结果被置为精确的占位符 `[Uneventful result elided]`(`USELESS_NOTICE`),采用与取代读取相同的缓存感知时机——仅当候选之后的后缀较小(≤ ~8k token)或会话已空闲超过提供商提示缓存生命周期时。比通知本身还小的结果从不置空(无节省),受保护的工具豁免。
- **阈值裁剪**(`pruneToolOutputs`):被标记的结果绕过新近保护窗口,与取代读取相同,并获得 `USELESS_NOTICE` 而非 token 计数占位符。
- **摘要序列化**:`serializeConversation`(agent 和 snapcompact)把整个工具调用/结果对从摘要器/归档输入中剔除——源区域在摘要后本来就会被丢弃,因此排除它不消耗缓存。

该标志永远不会进入提供商线上格式,被标记的对也从不从历史中移除(只就地置空),因此工具调用/结果配对和提供商原生历史回放保持完好。

### 边界与切点逻辑

`prepareCompaction()` 只考虑自上次压缩条目(若有)以来的条目。

1. 找到上一个压缩索引。
2. 计算 `boundaryStart = prevCompactionIndex + 1`。
3. 在可用时用测得的用量比例调整 `keepRecentTokens`。
4. 在边界窗口上运行 `findCutPoint()`。

有效的切点包括:

- 角色为 `user`、`assistant`、`bashExecution`、`hookMessage`、`branchSummary`、`compactionSummary` 的消息条目
- `custom_message` 条目
- `branch_summary` 条目

硬性规则:绝不在 `toolResult` 处切割。

如果切点正前方有非消息的元数据条目(`model_change`、`thinking_level_change`、标签等),它们会被拉入保留区域——通过向后移动切点索引,直到命中消息或压缩边界。

### 切分轮次处理

如果切点不在用户轮次起点,压缩会将其视为切分轮次(split turn)。

轮次起点检测把这些视为用户轮次边界:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` 条目
- `branch_summary` 条目

切分轮次压缩生成两份摘要:

1. 历史摘要(`messagesToSummarize`)
2. 轮次前缀摘要(`turnPrefixMessages`)

最终存储的摘要合并为:

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### 摘要生成

`compact(...)` 从序列化的对话文本构建摘要:

1. 通过 `convertToLlm()` 转换消息。
2. 用 `serializeConversation()` 序列化。
3. 包裹在 `<conversation>...</conversation>` 中。
4. 可选包含 `<previous-summary>...</previous-summary>`。
5. 可选将扩展钩子上下文和活动记忆后端压缩上下文作为 `<additional-context>` 条目注入。
6. 用 `SUMMARIZATION_SYSTEM_PROMPT` 执行摘要提示。

提示选择:

- 首次压缩:`compaction-summary.md`
- 带先前摘要的迭代压缩:`compaction-update-summary.md`
- 切分轮次第二遍:`compaction-turn-prefix.md`
- 简短 UI 摘要:`compaction-short-summary.md`
- 交接文档:`handoff-document.md`(由 `generateHandoff(...)` 使用,非序列化压缩)

远程摘要模式:

- 若设置了 `compaction.remoteEndpoint` 且启用了远程压缩,本地摘要生成会 POST 两种线上格式之一:
  - 自定义 omp 摘要器端点接收 `{ systemPrompt, prompt }`,必须返回至少包含 `{ summary }` 的 JSON。
  - 路径以 `/chat/completions` 结尾的 OpenAI 兼容端点接收 `{ model, messages, stream: false }`,其中 `messages` 包含一条系统提示和一条用户提示。摘要从 `choices[0].message.content` 读取,这使 llama.cpp 和 vLLM 等自托管服务器无需单独的摘要器垫片即可充当远程压缩器。
- 目录元数据启用 V2 流式压缩的兼容 OpenAI Responses、Azure OpenAI Responses 和 Codex 模型,首先向普通 Responses 流追加一个 `compaction_trigger`。返回的压缩项加上保留的真实用户消息成为替换历史,受 `compaction.v2RetainedMessageBudget` 约束;替换内容持久化在 `preserveData.openaiRemoteCompaction` 下。
- 若 V2 不可用或失败,符合条件的 OpenAI/OpenAI Codex 模型尝试提供商原生 `/responses/compact` 路径。原生失败随后回退到本地摘要。

### 交接文档生成

`packages/agent/src/compaction/compaction.ts` 还导出 `generateHandoff(...)`。交接文档生成使用与摘要相同的 `completeSimple(...)` 一次性风格,但它通过发送活动系统提示、工具数组和真实 LLM 消息历史来保留活动 Agent 缓存前缀,然后追加一条包含交接提示的、以 Agent 归因的 `user` 消息。它强制 `toolChoice: "none"`,并直接返回拼接的文本块。

交接不写入 `CompactionEntry`。`AgentSession.handoff()` 负责会话过渡:它启动一个新会话,把生成的文档作为可见的 `custom_message`(带 `customType: "handoff"`)注入,并从该新会话重建 Agent 消息。

当 `compaction.handoffSaveToDisk` 启用时,**自动触发**的交接还会在持久化会话的产物目录中写入 `handoff-<ISO timestamp>.md`。手动交接不受此设置影响,非持久化会话没有产物目录。

### 摘要中的文件操作上下文

压缩通过助手工具调用跟踪累计文件活动:

- `read(path)` → 读取集
- `write(path)` → 修改集
- `edit(path)` → 修改集

累计行为:

- 仅当先前条目是 pi 生成(`fromExtension !== true`)时才包含先前压缩的细节。
- 在切分轮次中,也包含轮次前缀的文件操作。
- `details.readFiles` 排除也被修改的文件;`details.modifiedFiles` 携带其余部分(持久化形状不变)。

文件列表是分组、前缀折叠的目录树(find-tool 形状),带逐文件访问标记 — `(Read)` 表示只读文件,`(Write)` 表示从未读取的修改文件,`(RW)` 表示同时出现在累计读取集中的修改文件。上限 20 个文件,带 `[…N files elided…]` 行。LLM 摘要策略以 `<files>` 标签追加它(通过 `upsertFileOperations`);snapcompact 改为在其摘要模板内以 `FILES` 节渲染它。

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

早期版本摘要中遗留的 `<read-files>`/`<modified-files>` 标签在重新追加前会被剥离(连同 `<files>` 一起),因此旧摘要会在下次压缩时自愈。

### 持久化与重载

摘要生成(或钩子提供的摘要)之后,Agent 会话:

1. 通过 `appendCompaction(...)` 为上下文完整维护追加 `CompactionEntry`;交接策略则创建新会话并注入交接 `custom_message`。
2. 通过 `buildDisplaySessionContext()` 从活动叶子重建展示上下文。
3. 用重建的上下文替换活动 Agent 消息。
4. 从重建的分支同步活动 todo 阶段,并关闭历史被重写的提供商会话。
5. 发出 `session_compact` 钩子事件。

## 分支摘要流水线

分支摘要与树导航绑定,而非 token 溢出。

### 触发

在 `navigateTree(...)` 期间:

1. 用 `collectEntriesForBranchSummary(...)` 计算从旧叶子到共同祖先的被放弃条目。
2. 若调用方请求摘要(`options.summarize`),在切换叶子前生成摘要。
3. 若摘要存在,用 `branchWithSummary(...)` 将其附加到导航目标。

实际操作中,当 `branchSummary.enabled` 启用时,这通常由 `/tree` 流程驱动。

### 分支切换形态(图示)

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D (abandoned branch, unchanged)
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### 准备与 token 预算

`generateBranchSummary(...)` 按如下方式计算预算:

- `tokenBudget = model.contextWindow - branchSummary.reserveTokens`

`prepareBranchEntries(...)` 然后:

1. 第一遍:收集所有被摘要条目的累计文件操作,包括先前 pi 生成的 `branch_summary` 细节。
2. 第二遍:从最新到最旧遍历,添加消息直到达到 token 预算。
3. 优先保留近期上下文。
4. 为保持连续性,预算边缘附近仍可包含大型摘要条目。

分支摘要输入期间,压缩条目作为消息(`compactionSummary`)被包含。

### 摘要生成与持久化

分支摘要:

1. 转换并序列化选定的消息。
2. 包裹在 `<conversation>` 中。
3. 若提供了自定义指令则使用,否则用 `branch-summary.md`。
4. 用 `SUMMARIZATION_SYSTEM_PROMPT` 调用摘要模型。
5. 前置 `branch-summary-preamble.md`。
6. 追加文件操作标签。

结果存储为 `BranchSummaryEntry`,带可选细节(`readFiles`、`modifiedFiles`)。

## 扩展与钩子触点

### `session_before_compact`

压缩前钩子。

可以:

- 取消压缩(`{ cancel: true }`)
- 提供完整的自定义压缩负载(`{ compaction: CompactionResult }`)

### `session.compacting`

默认压缩的提示/上下文定制钩子。

可以返回:

- `prompt`(覆盖基础摘要提示)
- `context`(注入 `<additional-context>` 的额外上下文行)
- `preserveData`(存储在压缩条目上)

### `session_compact`

压缩后通知,带保存的 `compactionEntry` 与 `fromExtension` 标志。

### `session_before_tree`

在默认分支摘要生成之前的树导航时运行。

可以:

- 取消导航
- 提供自定义 `{ summary: { summary, details } }`,在用户请求摘要时使用

### `session_tree`

导航后事件,暴露新旧叶子及可选摘要条目。

## 运行时行为与失败语义

- 手动压缩首先中止当前 Agent 操作。
- `abortCompaction()` 取消手动压缩、自动压缩和交接生成控制器。
- 自动压缩发出开始/结束会话事件,用于 UI/状态更新。
- 自动压缩可以尝试多个模型候选并重试瞬时失败;长时间重试延迟会优先选择下一个候选(若有)。
- 溢出错误被排除在通用重试路径之外,因为它们由上下文升级/压缩处理。
- 若自动压缩失败:
  - 溢出路径发出 `Context overflow recovery failed: ...`
  - 不完整输出路径发出 `Incomplete response recovery failed: ...`
  - 阈值/空闲路径发出 `Auto-compaction failed: ...`
- 分支摘要可以通过中止信号(如 Esc)取消,返回已取消/已中止的导航结果。

## 设置与默认值

来自 `settings-schema.ts`:

- `compaction.enabled` = `true`
- `compaction.strategy` = `"snapcompact"`(也支持 `"context-full"`、`"handoff"`、`"shake"` 和 `"off"`)
- `compaction.reserveTokens` 默认未设置。压缩层通常应用 `16384`-token 下限以及上下文窗口的至少 15%;在默认值不切实际的小窗口上,预算检查使用 15% 比例保留。显式配置的保留值会被尊重。
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`
- `compaction.handoffSaveToDisk` = `false`
- `compaction.remoteEnabled` = `true`
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` 且 `compaction.thresholdTokens` = `-1`;正的固定 token 限制优先于百分比,否则使用基于保留的阈值。
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `snapcompact.systemPrompt` = `"none"`(`"agents-md"` 和 `"all"` 选择加入瞬时系统提示成像)
- `snapcompact.toolResults` = `false`(大型历史工具结果的瞬时成像)
- `snapcompact.shape` = `"auto"`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

这些值在运行时由 `AgentSession`、`SessionMaintenance` 以及压缩/分支摘要模块消费。
