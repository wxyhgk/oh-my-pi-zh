# rewind

> 通过修剪探索性上下文并保留简洁报告来结束活动检查点。

## 来源
- 入口:`packages/coding-agent/src/tools/checkpoint.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/rewind.md`
- 主要协作者:
  - `packages/coding-agent/src/session/agent-session.ts` — 校验待处理的 rewind 状态、应用实际 rewind,并注入保留的报告。
  - `packages/coding-agent/src/session/session-manager.ts` — 分支持久化会话树,并追加持久化的摘要/报告条目。
  - `packages/coding-agent/src/session/session-context.ts` — `buildSessionContext()` 将持久化的 `branch_summary` 条目转换为重建上下文上 LLM 可见的 `branchSummary` 消息。
  - `packages/coding-agent/src/tools/index.ts` — 注册工具并共享 `checkpoint.enabled` 门控。

## 注册 / 可见性
- 工具元数据:`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。执行为一次性;rewind 副作用被延迟,而不是作为进度更新流式输出。
- 注册要求 `checkpoint.enabled = true`(默认 `false`)。
- 顶层会话在启用时接收该工具。子代理默认不发现它,但可能通过显式 `tools:`/请求工具列表接收。
- `checkpoint` 和 `rewind` 是一对安全组合:在功能启用时显式请求任一工具会自动包含另一个。
- 在普通 `tools.xdev` 会话中,可发现的构建工具可能以 `xd://rewind` 形式呈现;显式请求的工具保持顶层。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `report` | `string` | 是 | 调查发现。`execute()` 修剪它并拒绝空结果。 |

## 输出
工具返回单个文本结果加结构化 details:

- 文本正文:
  - `Rewind requested.`
  - `Report captured for context replacement.`
- `details`:
  - `report: string` — 修剪后的报告文本
  - `rewound: true`

返回的工具结果不是最终 rewind。`AgentSession` 等到 `turn_end`,然后异步应用 rewind 副作用。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 中的工具注册强制 `checkpoint.enabled` 以及顶层/显式子代理可见性规则。`RewindTool.createIf()` 本身总是构建工具。
2. 无活动检查点时,`execute()` 区分两种状态:
   - 存在保留的已完成 rewind:`ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")`
   - 无已完成 rewind:`ToolError("No active checkpoint. Create a checkpoint before calling rewind.")`
3. 它修剪 `params.report`;如果为空,抛出 `ToolError("Report cannot be empty.")`。
4. 它返回带 `details.report` 和 `details.rewound = true` 的 `toolResult()`。
5. 在成功的 rewind 工具结果上,`AgentSession` 从 `details.report` 或第一个文本内容块提取报告,并存储在 `#pendingRewindReport`。
6. 在 `turn_end`,`#extractRewindReport()` 找到待处理或成功的 rewind 结果,并调用 `#applyRewind()`。
7. `#applyRewind()` 首先调用 `sessionManager.branchWithSummary(checkpointEntryId, report, { startedAt })`,在检查点分支点记录 `branch_summary`。如果该条目不再解析,它记录警告并从根分支。
8. 它追加隐藏的持久化 `rewind-report` 自定义消息。其内容从 `prompts/system/rewind-report.md` 渲染,告知下一轮检查点已完成、不要再次调用 `rewind`,并包含报告;details 包含 `{ report, startedAt, rewoundAt }`。
9. 它设置 `#lastCompletedRewind`,从新的活动分支重建显示/LLM 会话上下文,并替换该轮的活动消息数组和 `agent.state.messages`。探索分支和成功的 rewind 工具结果因此不出现在下一个提供商调用中。
10. 它重置 advisor 会话状态同时保留成本,从新分支同步 todo 状态,并关闭历史被重写的提供商会话。
11. 最后它清除 `#checkpointState` 和 `#pendingRewindReport`。在稍后恢复或树导航时,持久化的保留报告重新水合 `#lastCompletedRewind`。

## 模式 / 变体
- 正常 rewind:检查点条目存在;会话历史从该确切条目分支。
- 回退 rewind:检查点条目 ID 在当前会话树中缺失;rewind 从根分支并记录警告。
- 延迟轮末应用:工具结果仅请求 rewind;分支和上下文替换在周围助手轮结束后发生。
- 恢复的检查点:活动持久化分支上未完成的成功检查点工具结果重新水合检查点状态,允许进程恢复后 rewind。

## 副作用
- 会话状态(转录、记忆、作业、检查点、注册表)
  - 从检查点分支加保留的摘要/报告重建活动会话历史;它不恢复文件或进程状态。
  - 添加携带渲染恢复指引和报告的隐藏自定义消息 `rewind-report`。
  - 记录 `#lastCompletedRewind`,清除活动检查点和待处理报告,重置 advisors,重新同步 todo 状态,并关闭被历史重写失效的提供商会话。
  - 将持久化会话叶子重新定位到检查点分支点,并追加新的会话条目。
- 文件系统
  - 通过正常 `SessionManager` 追加持久化,将新的 `branch_summary` 和 `custom_message` 条目持久化到会话 `.jsonl` 文件。
  - 会话文件在会话目录中命名为 `<ISO-timestamp-with-:-and-.-replaced>_<uuidv7>.jsonl`;无覆盖传递时,默认目录选择是 `~/.omp/agent/sessions/<encoded-cwd>/`。
- 用户可见提示词 / 交互 UI
  - 工具结果在轮末应用前可见。
  - 持久化的 `branch_summary` 在上下文重建时变为 LLM 可见的 `branchSummary` 消息;压缩渲染将其呈现为用户角色 `<summary>` 块。
  - 隐藏的 `rewind-report` 自定义消息变为下一个提供商调用的开发者角色保留指引。
- 后台工作 / 取消
  - Rewind 应用延迟到 `turn_end`。没有单独的作业对象或取消句柄。

## 限制与上限
- 可用性由 `checkpoint.enabled` 门控,默认 `false`。
- 子代理需要显式请求工具条目;请求任一 checkpoint 工具会自动包含其姊妹工具。
- 会话至多有一个活动检查点;没有命名或选择多个检查点的路径。
- 报告文本在 `trim()` 后必须非空。
- Rewind 只恢复活动会话/会话树上下文;没有文件、产物、blob、进程或 git 恢复路径。
- 持久化报告/摘要内容受全局会话持久化上限 `MAX_PERSIST_CHARS = 500_000` 约束。

## 错误
- `ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")` — 活动分支已包含保留完成时抛出。
- `ToolError("No active checkpoint. Create a checkpoint before calling rewind.")` — 既无活动检查点也无已完成 rewind 时抛出。
- `ToolError("Report cannot be empty.")` — 修剪后的报告为空时抛出。
- 应用期间缺失检查点条目 ID 不会使已完成的工具调用失败;`#applyRewind()` 记录 `Rewind branch checkpoint missing, falling back to root` 并从根分支。

## 注释
- 检查点选择是隐式的。`rewind` 总是针对捕获或从最后一个未完成成功 `checkpoint` 重新水合的单个 `#checkpointState`;没有检查点列表、标签或 ID 参数。
- 恢复的状态是活动会话/会话树上下文:
  - 持久化分支重置为 `checkpointEntryId` 或根回退
  - 被放弃探索路径的分支摘要
  - 保留的 `rewind-report` 自定义消息
  - 从该分支重建的内存消息
- 不恢复:
  - 文件系统或 git 状态
  - `packages/coding-agent/src/session/artifacts.ts` 下的产物
  - `packages/coding-agent/src/session/blob-store.ts` 下的 blob 存储负载
  - `packages/coding-agent/src/session/history-storage.ts` 中的提示词历史行
  - `packages/coding-agent/src/session/agent-storage.ts` 中的认证或其他 Agent 存储
- 没有并发编辑协调。Rewind 既不合并也不回退代码或会话相邻的外部状态。
- Rewind 对持久化会话历史无破坏性。`branchWithSummary()` 追加新的 `branch_summary` 条目并移动叶子;被放弃的条目留在 `.jsonl` 日志中,但离开活动分支。
