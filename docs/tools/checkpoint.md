# checkpoint

> 标记当前顶层会话状态,以便稍后的 `rewind` 可以把探索性上下文压缩成一份报告。

## 源码
- 入口:`packages/coding-agent/src/tools/checkpoint.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/checkpoint.md`
- 主要协作者:
  - `packages/coding-agent/src/session/agent-session.ts` — 在工具成功后捕获活动检查点。
  - `packages/coding-agent/src/session/session-manager.ts` — 持久化正常会话条目流;不持久化活动检查点标记。
  - `packages/coding-agent/src/tools/index.ts` — 注册该工具,并将其门控在 `checkpoint.enabled` 之后。
  - `packages/coding-agent/src/config/settings-schema.ts` — 定义默认禁用的功能标志。

## 注册 / 可见性
- 工具元数据:`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。执行是单发的;该工具不流式推送进度更新。
- 注册要求 `checkpoint.enabled = true`(默认 `false`)。
- 启用后,顶层会话会收到该工具。子代理默认不会发现它,但可以通过显式的 `tools:`/请求工具列表收到它。
- `checkpoint` 和 `rewind` 是一对安全组合:功能启用期间显式请求任一名称时,注册会自动包含另一个。
- 在普通 `tools.xdev` 会话中,可发现的 built-in 可能以 `xd://checkpoint` 呈现;显式请求的工具保持顶层。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `goal` | `string` | 是 | 调查目标。模式必需,并在工具结果中原样回显;实现不会修剪它,也不会拒绝空字符串。 |

## 输出
该工具返回单个文本结果以及结构化 details:

- 文本主体:
  - `Checkpoint created.`
  - `Goal: <goal>`
  - `Run your investigation, then call rewind with a concise report.`
- `details`:
  - `goal: string`
  - `startedAt: string` — 在 `CheckpointTool.execute()` 内部创建的 ISO 时间戳

不返回检查点 ID、产物 URI、任务句柄、文件路径或恢复 token。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 中的工具注册强制执行 `checkpoint.enabled` 以及顶层/显式子代理可见性规则。`CheckpointTool.createIf()` 本身总是构造该工具。
2. 当 `session.getCheckpointState?.()` 已设置时,`CheckpointTool.execute()` 以 `ToolError("Checkpoint already active.")` 拒绝嵌套检查点。
3. 它创建 `startedAt = new Date().toISOString()` 并返回普通 `toolResult()` 载荷。工具方法本身不改变检查点状态。
4. 在随后的成功 checkpoint 工具结果事件中,`AgentSession` 捕获三个运行时字段:
   - `checkpointMessageCount` — 当前的 `agent.state.messages.length`,此时检查点工具结果已追加
   - `checkpointEntryId` — `sessionManager.getEntries().at(-1)?.id ?? null`,即检查点时刻最后持久化的会话条目 ID
   - `startedAt` — 从工具 details 复制或重新生成
5. `AgentSession` 把该对象存入 `#checkpointState`,清除 `#pendingRewindReport`,并清除之前的 `#lastCompletedRewind`。
6. 恢复、切换会话或树导航时,`#rehydrateCheckpointRewindState()` 扫描当前持久化分支。最近一次成功的检查点若之后没有保留的 rewind 报告,则重建活动检查点边界和守卫。

## 副作用
- 会话状态(记录、内存、任务、检查点、注册表)
  - 在内存中设置 `AgentSession.#checkpointState`。
  - 把检查点边界记录为消息计数加上持久化的检查点工具结果条目 ID。
  - 普通的成功工具结果条目足以在恢复后重建未完成的检查点;没有单独的检查点标记条目。
  - 启用后续 settle 守卫:如果检查点处于活动状态且没有挂起的 rewind 报告,`#enforceRewindBeforeYield()` 注入一条 developer 角色警告并安排另一轮次。
- 面向用户的提示 / 交互 UI
  - 工具结果告诉模型在调查后调用 `rewind`。
  - 如果 agent 先尝试 `yield`,`AgentSession` 注入:

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.
</system-warning>
```

## 限制与上限
- 可用性由 `checkpoint.enabled` 门控,默认 `false`。
- 每个会话或子代理只允许一个活动检查点。
- 子代理需要显式的请求工具条目;请求任一 checkpoint 工具会自动包含其姊妹工具。
- 检查点状态不持久化为专用条目。它从活动分支上成功的 checkpoint 工具结果条目重建,包括进程恢复之后。
- 会话持久化适用于普通的 checkpoint 工具调用/结果消息。全局会话持久化截断是 `packages/coding-agent/src/session/session-persistence.ts` 中的 `MAX_PERSIST_CHARS = 500_000`。

## 错误
- `ToolError("Checkpoint already active.")` — 当之前的检查点尚未被 rewind 或清除时抛出。
- 工具主体没有本地 `try/catch`;意外异常原样传播。

## 备注
- 尽管摘要字符串为 `Create a git-based checkpoint to save and restore session state`,实现不会调用 git,也不会快照文件系统状态。
- 捕获的状态只是对话/会话元数据:
  - 内存中的消息计数
  - 会话树中持久化的检查点工具结果条目 ID
  - 时间戳
- 不捕获:
  - 工作树内容或暂存更改
  - 产物或 blob 存储内容
  - 来自 `packages/coding-agent/src/session/history-storage.ts` 的 SQLite 提示词历史行
  - 来自 `packages/coding-agent/src/session/agent-storage.ts` 的认证或 agent 记录
