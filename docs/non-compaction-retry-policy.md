# 非压缩自动重试策略

本文档描述由 `AgentSession` 协调、由 `TurnRecovery` 实现的标准 API 错误重试路径。

它明确排除通过自动压缩进行的上下文溢出恢复。溢出由压缩逻辑处理,并在 [`compaction.md`](../docs/compaction.md) 中单独记录。

## 实现文件

- [`../packages/coding-agent/src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../packages/coding-agent/src/session/turn-recovery.ts`](../packages/coding-agent/src/session/turn-recovery.ts) — 重试分类、退避、凭据轮换与模型回退
- [`../packages/coding-agent/src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)
- [`../packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`../packages/coding-agent/src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-client.ts`](../packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-types.ts`](../packages/coding-agent/src/modes/rpc/rpc-types.ts)

## 与压缩的作用域边界

重试与压缩从同一条 `agent_end` 路径检查,但被有意分离:

1. `agent_end` 检查最后一条助手消息。
2. `TurnRecovery.isRetryableError(...)` 在普通压缩恢复之前运行。
3. 如果启动重试,该轮次跳过压缩检查。
4. 上下文溢出错误通过 `AIError.isContextOverflow(...)` 从重试分类中排除。
5. 因此溢出到达 `SessionMaintenance.checkCompaction(...)` 而非标准重试。

所以:过载/限速/服务器/网络类失败使用此重试策略;上下文窗口溢出使用压缩恢复。

## 重试分类

`TurnRecovery.isRetryableError(...)` 要求满足以下全部条件:

- 助手 `stopReason === "error"`
- 消息**不是**上下文溢出
- 下列之一:
  - stop 是分类器拒绝(`stopDetails.type` 为 `"refusal"` 或 `"sensitive"`)
  - 错误是过期的 OpenAI Responses 重放失败
  - 归一化的 `AIError` 分类可重试(包括瞬时传输/提供商失败与用量限制)

重试分类通过 `AIError.classifyMessage(...)` 运行,存在时使用持久化的 `errorId`/status,并用提供商感知的消息分类对其进行增强。它不纯粹是正则策略,尽管旧版/纯字符串提供商失败仍使用文本分类。

过期重放与可重试错误分支还要求流**尚未**发出重放不安全输出。非空可见文本、图像、工具调用与 Anthropic 服务器工具块阻止重放。仅思考与仅空白的部分输出可安全丢弃并重试。分类器拒绝同样受重放安全检查约束。

当前可重试类别包括:

- 瞬时传输/信封失败,包括 `message_start` 之前的 Anthropic 流信封失败
- 过载/提供商返回错误的措辞
- 限速/用量限制/请求过多
- HTTP 类服务器类别:429、500、502、503、504
- 服务不可用/服务器/内部错误
- 提供商建议重试的措辞,包括 OpenAI `retry your request` 失败
- 网络/连接/套接字失败、拒绝/关闭连接、上游 connect/reset-before-headers、套接字挂起、超时/已超时、fetch 失败、终止、重试延迟措辞,以及意外套接字关闭消息

归一化分类器从结构化标志/状态与提供商感知文本模式识别上述瞬时类别。分类器拒绝仍是独立的类型化 `stopDetails` 决策。

在 `isRetryableError(...)` 之外,当没有用户、dispose 或流式编辑守卫中止正在进行时,空的通用中止可进入同一重试引擎。工具调用已有匹配结果的被中断轮次也可安全继续:失败的助手/工具结果序列被保留,因此已完成副作用不会重放。已解决的流停滞使用相同的保留并继续路径。

重试状态由 `TurnRecovery` 拥有:

- 重试尝试计数器(`0` 表示空闲)
- 重试生命周期 Promise 与解析器
- 重试退避中止控制器

流程(`#handleRetryableError`):

1. 读取 `retry` 设置组,重试禁用时停止(固有的单次 Fireworks Fast-to-base 回退除外)。
2. 递增重试尝试,并在首次尝试时创建共享的重试生命周期 Promise。
3. 计算当前模型的重试预算是否已耗尽。
4. 分类错误、解析重试时机,并计算带上限的抖动退避:`min(retry.baseDelayMs * 2^(attempt-1), 8000ms) * (75–100% 抖动)`。过期的 OpenAI Responses 重放错误会重置提供商会话并使用延迟 `0`。
5. 对用量限制,立即应用成功的凭据切换或银行化 Codex 重置;否则等待提供商提示与下一个暂时被阻塞的兄弟凭据中较早者。
6. 允许时,咨询配置的模型回退链。切换使用延迟 `0`;分类器拒绝仅在应用回退时继续。
7. 当前模型的重试预算耗尽时,除非找到回退模型,否则停止。回退获得全新重试预算。
8. 最终延迟超过 `retry.maxDelayMs` 且未发生凭据/模型切换时,不睡眠直接发出最终失败。
9. 发出 `auto_retry_start`,记录可恢复错误,并从活动上下文中移除失败的助手,除非这是已解决的被中断工具轮次。
10. 带中止支持地睡眠,然后通过提示后任务调度器为同一提示生成调度 `agent.continue()`。

### 什么重置重试计数器

在这些情况下 `#retryAttempt` 重置为 `0`:

- 重试开始后第一条成功的非错误、非中止助手消息(发出 `auto_retry_end { success: true }`)
- 退避睡眠期间的重试取消
- 超过最大重试路径
- 超过最大延迟路径
- 分类器拒绝或未应用回退模型的硬错误
- 稍后错误在没有重试或压缩继续的情况下解决

链结束时重试 Promise 解析并清除。

## 退避与最大尝试语义

设置:

- `retry.enabled`(默认 `true`)
- `retry.maxRetries`(默认 `10`)
- `retry.baseDelayMs`(默认 `500`)
- `retry.maxDelayMs`(默认 `300000`,5 分钟;`<= 0` 禁用快速失败上限)

尝试编号:

- 尝试计数器在 max 检查前递增
- 开始事件使用当前尝试(从 1 开始)
- 超过 max 的结束事件报告 `attempt: this.#retryAttempt - 1`(最后一次尝试的重试次数)

默认设置下、抖动之前的退避序列:

- 尝试 1:500 ms
- 尝试 2:1000 ms
- 尝试 3:2000 ms
- 尝试 4:4000 ms
- 尝试 5+:8000 ms

实际本地睡眠为标称值的 75–100%,匹配 Anthropic 风格的重试抖动,使并发会话不会同步重试。

延迟覆盖输入可来自解析的重试头(`retry-after-ms`、`retry-after`、`x-ratelimit-reset-ms`、`x-ratelimit-reset`)或用量限制退避。凭据/模型回退切换将延迟设为 `0`;否则解析的提示可延长带上限的本地延迟。如果计算延迟大于 `retry.maxDelayMs` 且没有切换成功,重试立即以最终错误结束,而不是睡眠。

## 中止机制

### 显式重试中止

`abortRetry()`:

- 中止 `#retryAbortController`(如果存在)
- 解析重试 Promise(`#resolveRetry()`),使等待者解除阻塞

如果中止发生在睡眠期间,catch 路径发出:

- `auto_retry_end { success: false, finalError: "Retry cancelled" }`
- 重置尝试/控制器

### 全局操作中止交互

`abort()` 在中止活动 Agent 流之前调用 `abortRetry()`。这保证用户发出通用中止时重试退避被取消。

### TUI 交互

在 `auto_retry_start` 时,EventController(`#handleAutoRetryStart`):

- 停止工作加载器并清除状态容器
- 渲染带文本的 `retryLoader`:`Retrying (attempt/maxAttempts) in Ns… (esc to cancel)`

`Esc` 取消在活动会话状态上调度,而非交换的处理器:输入控制器检查 `viewSession.isRetrying` 并调用 `viewSession.abortRetry()`(与压缩/交接中止检查一起)。

在 `auto_retry_end`(`#handleAutoRetryEnd`)时,停止并清除 `retryLoader` 与状态容器。

## 流式与提示完成行为

`prompt()` 最终在 `agent.prompt(...)` 返回后等待 `#waitForPostPromptRecovery()`;该循环与 TTSR 恢复及延迟的提示后任务一起等待重试生命周期 Promise。

效果:

- 提示调用在启动的任何重试链完成(成功/失败/取消)前不会完全解析
- 重试生命周期是一个逻辑提示执行边界的一部分

这防止调用方过早将重试中的轮次视为完成。

## 控制:设置与 RPC

### 配置旋钮

在设置 schema 的 retry 组下定义:

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.maxDelayMs`
- `retry.modelFallback`(默认 `true`;门控重试模型回退切换)
- `retry.fallbackChains`
- `retry.fallbackRevertPolicy`(默认 `"cooldown-expiry"`;`"never"` 禁用自动恢复)
- `retry.usageAwareFallback`(默认 `false`;对受支持的编程计划用量报告运行预检)
- `retry.usageReservePct`(默认 `10`;剩余配额储备阈值)
- `retry.usageReservePolicy`(默认 `"confirm"`;也支持 `"auto"` 与 `"fail-closed"`)

会话中的编程切换:

- `setAutoRetryEnabled(enabled)` 写入 `retry.enabled`
- `autoRetryEnabled` 读取 `retry.enabled`
- `isRetrying` 报告重试生命周期 Promise 是否活动

### RPC 控制

RPC 命令表面:

- `set_auto_retry` -> `session.setAutoRetryEnabled(command.enabled)`
- `abort_retry` -> `session.abortRetry()`

客户端辅助函数:

- `RpcClient.setAutoRetry(enabled)`
- `RpcClient.abortRetry()`

## 事件发射与失败表面化

会话级重试事件:

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage, errorId? }`
- `auto_retry_end { success, attempt, finalError?, recoveredErrors? }`
- `retry_fallback_applied { from, to, role }`
- `retry_fallback_succeeded { model, role }`

传播:

- 通过 `AgentSession.subscribe(...)` 发射
- 作为扩展事件转发给扩展运行器
- 在 RPC 模式中,直接作为 JSON 事件对象转发(`session.subscribe(event => output(event))`)
- 在 TUI 中,由 `EventController` 消费用于加载器/错误 UI

最终失败表面化:

- 超过 max、最大延迟失败或取消时,`auto_retry_end.success === false`
- TUI 显示:`Retry failed after N attempts: <finalError>`
- 扩展/钩子接收相同字段的 `auto_retry_end`
- RPC 消费方在 stdout 流上接收相同事件对象

## 永久停止条件

发生以下任一情况时,重试停止且不会自动继续:

- `retry.enabled` 为 false
- 错误未被分类为可重试
- 错误是上下文溢出(委托给压缩路径)
- 超过最大重试且无可用回退模型
- 提供商请求的延迟超过 `retry.maxDelayMs` 且无可用凭据/模型切换
- 用户取消重试(重试加载器期间的 `abort_retry` 或 `Esc`)
- 全局中止(`abort`)先取消重试

计数器重置后,未来的可重试错误仍可启动新的重试链。

## 操作注意事项

- 分类使用归一化的 `AIError` 标志/状态加提供商感知文本回退;不限于结构化错误或仅正则匹配。
- 重试在重新继续前将失败的助手错误从**运行时上下文**剥离,但会话历史仍保留该错误条目。
- `RpcSessionState` 当前暴露 `autoCompactionEnabled`,但不暴露 `autoRetryEnabled` 字段;RPC 调用方必须自行跟踪切换状态或通过其他 API 查询设置。
- 模型回退更改附加临时的 `model_change` 条目,并可能在其冷却到期后恢复主模型,取决于 `retry.fallbackRevertPolicy`。
- 当 `retry.modelFallback` 与 `retry.usageAwareFallback` 均启用时,用量感知回退在提供商请求之前运行。未知/未映射的用量开放失败。在储备阈值,`"confirm"` 询问交互式会话,拒绝时保留当前模型;没有确认 UI 的会话自动应用符合条件的已配置回退。`"auto"` 不问即应用符合条件的回退。`"fail-closed"` 拒绝储备或耗尽用量,而不是花费它或选择回退。其他策略下耗尽用量时,无需储备确认即应用符合条件的回退。
