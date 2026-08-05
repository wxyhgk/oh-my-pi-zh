# 解析设备运行时

待处理的预览和计划批准不使用 `resolve` 工具。它们通过纯文本 `write` 调用最终确定,写入 `packages/coding-agent/src/tools/resolve.ts` 中实现的虚拟 `xd://` 设备:

- `xd://resolve` — 应用待处理的分阶段预览;正文 = 一句话理由
- `xd://reject` — 丢弃待处理的分阶段预览;正文 = 一句话理由
- `xd://propose` — 在计划模式激活时提交计划以供批准;正文 = 计划 slug(`<slug>` 对应 `local://<slug>-plan.md`)

这些是内部 URL,不是文件系统路径。`read xd://resolve`、`read xd://reject` 和 `read xd://propose` 返回一行用法提示。完成的设备写入携带 `details.xdev` 元数据;消费者通过 `writeDeviceDispatch()` 和 `resolveDispatchDetails()` 恢复内部结果。

## 预览流程

预览生产者调用 `queueResolveHandler(...)`,带 `apply(reason)` 和可选的 `reject(reason)` 回调。每个预览在 `ToolChoiceQueue` 中接收一个唯一的待处理调用者 ID,因此堆叠的预览不会互相覆盖。

预览待处理时,`AgentSession.nextToolChoiceDirective()` 返回一个软要求:

- `toolName: "write"`
- `satisfies: isPreviewResolutionToolCall`
- 来自 `resolve-device-reminder.md` 的提醒

模型通过写入 `xd://resolve` 或 `xd://reject` 来遵从。其他写入不会解析预览,并被软要求生命周期跳过或升级。

分派通过 `runResolveInvocation(...)` 调用待处理队列头部。

- 成功的应用或丢弃恰好消费该待处理调用者一次。
- 如果 apply 抛出,同一预览被重新注册,以便模型可以在修复原因后拒绝它或重试。
- 无待处理操作时拒绝成功,返回 `Nothing to reject; no pending action remains.`
- 无待处理操作时解析会抛出。
- apply 回调的普通错误变成 `ToolError("Apply failed: ...")`;现有的 `ToolError` 被保留。

## 计划批准

计划模式通过 `setPlanProposalHandler(...)` 安装一个单独的提议处理器。

- 交互模式将 `PlanApprovalDetails` 交给计划审查 UI。
- ACP 模式运行引导/批准并发出模式更新。
- PlanYolo 自动批准并切换到执行目标。

`xd://propose` 将写入的 slug 分派给已安装的计划提议处理器,并且仅在计划模式激活时有效。

## 为什么 `write` 有保证

因为预览和计划批准搭乘 `write`,harness 在需要时保持 `write` 可用:

- `createTools(...)` 在 `ast_edit` 等可推迟工具激活时自动追加 `write`。
- `createAgentSession(...)` 在存在可推迟工具或启用计划模式时保持 `write` 注册。

## 自定义工具

自定义工具仍然通过 `pushPendingAction(...)` 分阶段预览;加载器将它们转发到 `queueResolveHandler(...)`。自定义工具预览 API 除了模型面对的最终确定步骤外没有变化:用纯文本写入 `xd://resolve` 或 `xd://reject` 跟进,而不是 `resolve` 工具调用。
