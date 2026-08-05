# `/handoff` 生成流水线

本文档描述 coding-agent 如何实现 `/handoff`:触发路径、一次性生成、会话切换、上下文重新注入、持久化以及 UI 行为。

## 范围

涵盖:

- 交互式 `/handoff` 命令分发
- `AgentSession.handoff()` 生命周期与状态转换
- `generateHandoffFromContext(...)` 请求形状与兼容性重试
- 旧/新会话如何以不同方式持久化 handoff 数据
- 成功、取消和失败时的 UI 行为

不涵盖:

- 通用的树导航/分支内部机制
- 非 handoff 的会话命令(`/new`、`/fork`、`/resume`)

## 实现文件

- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/session/session-handoff.ts`](../packages/coding-agent/src/session/session-handoff.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/agent/src/compaction/compaction.ts`](../packages/agent/src/compaction/compaction.ts)
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)

## 触发路径

1. `/handoff` 在内置斜杠命令注册表中声明,带有可选的内联提示 `[focus instructions]`。
2. 注册表的 TUI 处理器清空编辑器并调用 `handleHandoffCommand(customInstructions?)`。
3. `CommandController.handleHandoffCommand` 在当前响应流式传输期间拒绝执行,然后统计 `type === "message"` 的条目数。
4. 如果计数 `< 2`,它警告 `Nothing to hand off (no messages yet)` 并返回。

相同的最小内容守卫存在于 `SessionHandoff.handoff()` 内部,违反时会抛出异常。RPC 会在流式传输期间单独拒绝 handoff。直接 SDK 调用方必须避免在活跃响应期间调用该会话方法。

## 端到端生命周期

### 1) 开始 handoff 生成

`AgentSession.handoff()` 委托给 `SessionHandoff.handoff(customInstructions?, options?)`:

- 在 vibe 模式活跃时拒绝会话转换。
- 读取当前分支并验证至少两条消息条目。
- 创建 `#handoffAbortController`,并将调用方提供的任何中止信号链接到它。
- 要求已选择模型以及该模型的 API key/解析器。
- 通过**与实时轮次相同的侧请求流水线**构建 handoff 请求,与临时轮次共享:
  1. 渲染 handoff 提示词(`renderHandoffPrompt(...)`,带可选 focus,在密钥混淆之后),并将其作为 Agent 归属的 `user` 消息追加到 `agent.state.messages` 的快照中。
  2. 用 `convertMessagesToLlm(...)` 转换快照(会话 `transformContext`、LLM 转换和混淆)。
  3. 用 `agent.buildSideRequestContext(llmMessages, baseSystemPrompt)` 构建提供商 `Context` — 规范化工具和提供商上下文转换与循环保持一致。基础系统提示词被固定,因此新会话不会继承逐轮次的 `before_agent_start` 覆盖。
  4. 构建 simple-stream 选项,包含实时提供商缓存键、唯一的侧 `sessionId`(`<sid>:side:<snowflake>`)、服务层级/载荷钩子、`preferWebsockets: false`、`initiatorOverride: "agent"` 和中止信号。
- 混淆最终的提供商上下文,并通过主机侧流传输调用 `generateHandoffFromContext(...)`。
- 在持久化或显示之前去混淆返回的 handoff 文本。

### 2) 生成并捕获输出

`generateHandoffFromContext(...)` 位于 `packages/agent/src/compaction/compaction.ts`,与摘要功能相邻。它对调用方构建的 `Context` 发起一次带 OTEL 插桩的 `completeSimple` 等价一次性请求,并用受限的压缩推理和 `toolChoice: "none"` 覆盖提供的流选项。

如果提供商因只支持自动工具选择而拒绝显式的 `toolChoice: "none"`,该函数会用 `toolChoice: "auto"` 重试一次。工具保留以保持缓存前缀兼容性,但返回的工具调用块会被忽略;只拼接文本块。

```ts
await generateHandoffFromContext(context, model, {
  streamOptions,
  completeImpl,
  telemetry,
  thinkingLevel,
});
```

`generateHandoff(messages, …)` 仍会导出供下游调用方使用。它从 `systemPrompt`、`tools` 和 `convertToLlm` 构建基本上下文,然后委托给 `generateHandoffFromContext`;coding-agent 使用上下文感知的函数,以使主机转换、混淆、侧流路由和缓存键与实时轮次一致。

重要的生成属性:

- 请求共享实时提供商缓存前缀,因为 `Context` 由循环使用的相同转换 + 规范化流水线构建,并使用轮次使用的相同 `promptCacheKey` 路由。
- handoff 指令是尾部 `user` 消息,而不是 developer 消息,因此缓存前缀与前一轮次保持对齐(尾部消息是唯一的分歧点)。
- `toolChoice: "none"` 在普通提供商上防止有意的工具分派;兼容性重试仅在显式工具选择被拒绝后才使用 `"auto"`。
- 返回的助手内容被筛选为文本块并用 `\n` 拼接;工具调用块被忽略。
- 兼容性重试后若 `stopReason === "error"`,会抛出生成错误。

捕获直接来自一次性响应;不涉及 Agent 循环事件或最新助手消息扫描。

### 3) 取消检查

取消会抛出 `Error("Handoff cancelled")`;无文本的已完成生成返回 `undefined`。

- 调用方信号中止 `#handoffAbortController`
- `completeSimple(...)` 收到中止信号
- 被中止的 handoff 信号或提供商 `AbortError` 被规范化为 `Error("Handoff cancelled")`
- 空生成的文本返回 `undefined`

`AgentSession.handoff()` 总是在 `finally` 中清除 `#handoffAbortController`。

### 4) 创建新会话

如果生成了文本且未被中止:

1. 以 `handoff` 作为原因发出 `session_before_switch`;扩展可以取消切换,此时不会创建新会话。
2. 刷新挂起的 bash 输出和当前会话写入器。
3. 在 advisor 记录器仍指向旧会话时排空/分离它们。
4. 开始 bash 会话转换,并取消会话拥有的异步任务。
5. 当存在上一会话文件时,启动一个全新的会话,其 `parentSession` 指向该文件。
6. 清除 advisor 费用、会话级工具/检查点状态和陈旧的提供商会话状态。
7. 跨 `agent.reset()` 保留 steer 和 follow-up 队列,使 handoff 期间到达的消息在新会话中存活。
8. 重新绑定 Agent 会话 id,重新生成/重置记忆跟踪,清除排队的下一轮次上下文,并重置 todo 周期。

### 5) Handoff 上下文注入

生成的 handoff 文档由 coding-agent 会话胶水包装,并作为 `custom_message` 条目追加到新会话:

```text
<handoff-context>
...handoff text...
</handoff-context>

The above is a handoff document from a previous session. Use this context to continue the work seamlessly.
```

插入调用:

```ts
this.sessionManager.appendCustomMessageEntry(
  "handoff",
  handoffContent,
  true,
  undefined,
  "agent",
);
```

语义:

- `customType`: `"handoff"`
- `display`: `true`(在 TUI 重建中可见)
- attribution: `"agent"`
- 条目类型:`custom_message`(参与 LLM 上下文)

### 6) 重建活跃 Agent 上下文

注入之后:

1. `buildDisplaySessionContext()` 解析新叶子的消息。
2. `agent.replaceMessages(sessionContext.messages)` 激活注入的 handoff 上下文。
3. Advisor 运行时状态和 todo 阶段为新分支重置。
4. 以 `handoff` 作为原因和上一会话文件发出 `session_switch`。
5. 返回 `{ document: handoffText, savedPath? }`。

此时,新会话中的活跃 LLM 上下文包含注入的 handoff 消息,而不是旧会话记录。

## 持久化模型:旧会话 vs 新会话

### 旧会话

Handoff 生成是一次性请求,不是可见的 Agent 轮次。生成的 handoff 文本不会作为助手消息追加到旧会话。

结果:原始会话保持其先前的记录不变,除了 handoff 开始前已持久化的数据。

### 新会话

会话重置后,handoff 以 `customType: "handoff"` 的 `custom_message` 持久化。

`buildSessionContext()` 通过 `createCustomMessage(...)` 将此条目转换为运行时 custom/user 上下文消息,因此它会被包含在新会话未来的提示词中。

当 `compaction.handoffSaveToDisk` 启用时,自动触发的 handoff 还可以在**新**会话的产物目录下写入带时间戳的 `handoff-*.md` 产物。手动 `/handoff` 不写入该产物。注入的自定义消息在方法返回前被强制写入磁盘。

### 自动 handoff

手动 `/handoff` 与上下文维护策略无关地工作。要为此流水线启用自动维护,设置 `compaction.strategy: handoff`(策略默认为 `snapcompact`)。常规阈值触发的 handoff 推迟到提示词后的任务;`incomplete` 输出恢复可能会内联执行 handoff。输入 `overflow` 总是回退到就地上下文满维护,因为 handoff 请求会携带相同的超大输入。

如果自动生成不返回文档,维护回退到上下文满压缩。中止或 `session_before_switch` 钩子取消不会触发该回退。`compaction.handoffSaveToDisk` 默认为 `false`;启用后,只有自动触发的 handoff 会写入额外的 markdown 产物。

## 控制器/UI 行为

`CommandController.handleHandoffCommand` 行为:

- 当 `session.isStreaming` 时拒绝并警告(与 `/fork` 和 `/move` 一致)— 用户必须先完成或中止响应,然后才能 handoff。
- 显示状态加载器:`Generating handoff… (esc to cancel)`。
- 调用 `await session.handoff(customInstructions)`。
- 如果结果为 `undefined`:`showError("Handoff cancelled")`。
- 成功时:
  - 清除瞬态会话 UI 并渲染新会话消息,包括注入的 handoff
  - 使状态行和编辑器边框失效
  - 重新加载 todos
  - 追加 `New session started with handoff context`
  - 当结果包含 `savedPath` 时显示它(手动 `/handoff` 通常没有)
- 异常时:
  - 如果消息是 `"Handoff cancelled"` 或错误名是 `AbortError`:`showError("Handoff cancelled")`
  - 否则:`showError("Handoff failed: <message>")`
- 结束时停止加载器,清除状态容器,并请求渲染。

手动 `/handoff` 不再将生成的文档流式传输到聊天中。一次性请求运行期间会显示一个可取消的加载器,生成完成后重建聊天。

## 取消语义

### 会话级取消原语

`AgentSession` 暴露:

- `abortHandoff()` → 中止 `#handoffAbortController`
- `isGeneratingHandoff` → 控制器存在时为 true

使用此中止路径时,中止信号被传给 `completeSimple(...)`;`handoff()` 将取消规范化为 `Error("Handoff cancelled")`,命令控制器将其映射为取消 UI。

### 交互式 `/handoff` 路径

`InputController` 的全局 `editor.onEscape` 处理器根据实时会话状态分派,而不是交换处理器:当 `isGeneratingHandoff` 为 true 时,按 Escape 会调用 `session.abortHandoff()`,它通过 `#handoffAbortController` 中止 `completeSimple(...)` 请求。

## 已中止 vs 失败的 handoff

当前 UI 分类:

- **已中止/已取消**
  - `abortHandoff()` 路径触发 `"Handoff cancelled"`,或
  - 抛出的 `AbortError`
  - UI 显示 `Handoff cancelled`
- **失败**
  - 会话转换或提供商请求路径抛出的任何其他错误
  - UI 显示 `Handoff failed: ...`

额外的细微差别:空生成的文本或扩展取消的 `session_before_switch` 返回 `undefined`,交互式控制器当前将其报告为**已取消**,而不是**失败**。

## 短会话与最小内容守卫

两个守卫防止低信号 handoff:

- UI 层(`handleHandoffCommand`):对 `< 2` 条消息条目警告并提前返回
- 会话层(`handoff()`):将相同条件作为错误抛出

这避免了创建带空/近乎空 handoff 上下文的新会话。

## 状态转换总结

高层状态流:

1. 内置注册表分发交互式斜杠命令。
2. 流式传输和消息计数预检守卫。
3. 创建 `#handoffAbortController`(`isGeneratingHandoff = true`)。
4. `generateHandoffFromContext(...)` 发送一次缓存对齐的侧请求,必要时带一次性的 `"auto"` 工具选择兼容性重试。
5. 拼接助手文本块;丢弃工具调用块;在本地恢复密钥占位符。
6. 如果文本缺失或扩展取消切换 → 返回 `undefined`;如果中止 → 取消错误。
7. 如果存在:
   - 刷新 bash/会话持久化并分离 advisor 记录器
   - 取消异步任务并创建新的子会话
   - 在保留 steer/follow-up 队列的同时重置运行时/工具/检查点/记忆状态
   - 追加并持久化 `custom_message(handoff)`
   - 可选保存自动触发的 handoff 产物
   - 重建 Agent 上下文、advisor 和 todos,然后发出 `session_switch`
8. 控制器重建聊天 UI 并宣布成功。
9. `#handoffAbortController` 在 `finally` 中清除;提交前失败的转换会重新连接 advisor 记录器馈送。

## 已知假设与限制

- 没有结构验证检查生成的 markdown 是否符合请求的章节格式。
- 文本缺失和扩展取消的切换在交互式控制器中被报告为取消。
- 手动 handoff 没有流式可见性;UI 更新前会显示一个可取消的加载器。
- 自动触发的产物写入失败会被记录,不会使已创建的 handoff 会话失败。
