# 会话树架构(当前)

参考:[session.md](../docs/session.md)

本文档描述会话树导航当前的工作方式:内存树模型、叶移动规则、分支行为,以及扩展/事件集成。

## 这个子系统是什么

会话存储为只追加的条目日志,但运行时行为基于树:

- 每个非头部条目都有 `id` 和 `parentId`。
- 活动位置是 `SessionManager` 中的 `leafId`。
- 追加条目总是在当前叶下创建一个子条目。
- 分支**不会**重写历史;它只改变下一次追加前叶的指向。

关键文件:

- `src/session/session-manager.ts` — 树数据模型、遍历、叶移动、分支/会话提取
- `src/session/session-context.ts` — `buildSessionContext` 上下文重建(已解析的根→叶 LLM 上下文、压缩/分支摘要重放)
- `src/session/agent-session.ts` — `/tree` 导航流程、摘要生成、钩子/事件发射
- `src/modes/components/tree-selector.ts` — 交互式树 UI 行为与筛选
- `src/modes/controllers/selector-controller.ts` — `/tree` 和 `/branch` 的选择器编排
- `src/slash-commands/builtin-registry.ts` — 命令路由(`/tree`、`/branch`)
- `src/modes/controllers/input-controller.ts` — 双击 Escape 行为和 `app.session.tree`/`app.session.fork` 快捷键接线
- `src/session/messages.ts` — 将 `branch_summary`、`compaction` 和 `custom_message` 条目转换为 LLM 上下文消息

## `SessionManager` 中的树数据模型

运行时索引位于 `SessionEntryIndex` 辅助类中,作为 `SessionManager` 上的 `#index` 持有,并与日志数组 `#entries` 保持同步:

- `#entriesById: Map<string, SessionEntry>` — 任意条目的快速查找
- `#children: Map<string | null, SessionEntry[]>` — 父→子邻接
- `#labels: Map<string, string>` — 按目标条目 id 解析的标签
- `#leaf: string | null` — 树中的当前位置
- `#usage` — 累计用量

树 API:

- `getBranch(fromId?)` 沿父链接走到根,返回根→节点路径
- `getTree()` 返回 `SessionTreeNode[]`(`entry`、`children`、`label`)
  - 父链接变成子数组
  - 父条目缺失的条目被视为根
  - 子条目按时间戳从旧到新排序
- `getChildren(parentId)` 返回直接子条目
- `getLabel(id)` 从索引的 `#labels` 映射解析当前标签

`getTree()` 是运行时投影;持久化仍是只追加的 JSONL 条目。

## 叶移动语义

有三种叶移动原语:

1. `branch(entryId)`
   - 验证条目存在
   - 设置 `leafId = entryId`
   - 不写入新条目

2. `resetLeaf()`
   - 设置 `leafId = null`
   - 下一次追加创建一个新的根条目(`parentId = null`)

3. `branchWithSummary(branchFromId, summary, details?, fromExtension?)`
   - 接受 `branchFromId: string | null`
   - 设置 `leafId = branchFromId`
   - 在该叶下追加一个 `branch_summary` 条目
   - 当 `branchFromId` 为 `null` 时,`fromId` 持久化为 `"root"`

## `/tree` 导航行为(同一会话文件)

`AgentSession.navigateTree()` 是导航,不是文件分叉。

流程:

1. 验证目标并计算被放弃的路径(`collectEntriesForBranchSummary`)。
2. 对于 `ask` 工具结果的可恢复原始问题的交互式选择,返回 `reopenAsk` 请求而不修改树。选择器重新打开问题 UI,然后用替换的结果再次调用 `navigateTree`;第二次调用在原始答案的父条目下追加一个新的兄弟 `toolResult`。
3. 携带 `TreePreparation` 发出 `session_before_tree`。
4. 可选地对被放弃的条目进行摘要(钩子提供的摘要或内置摘要器)。
5. 计算新的叶目标:
   - 选择 **user** 消息:叶移动到其父条目,消息文本和图片附件被返回用于编辑器草稿恢复
   - 选择非技能提示词注入的 **custom_message**:同样的父条目/预填充规则(仅文本)
   - 选择技能提示词自定义消息或任何其他条目:叶 = 所选条目 id
6. 应用叶移动:
   - 有摘要:`branchWithSummary(newLeafId, ...)`
   - 无摘要且 `newLeafId === null`:`resetLeaf()`
   - 否则:`branch(newLeafId)`
7. 从新叶重建 Agent 上下文,重置分支作用域的 todo/advisor/checkpoint 状态,关闭历史被重写的 Codex 提供商会话,并发出 `session_tree`。

重要:摘要条目附加在**新的导航位置**,而不是被放弃的分支尾部。

## `/branch` 行为(默认配置下新建会话文件)

`/branch` 和 `/tree` 通常不同:

- `/tree` 在当前会话文件内导航。
- `/branch` 打开用户消息选择器,并创建一个新的会话分支文件(非持久化模式下是内存替换)。

默认面向用户的 `/branch` 流程(`SelectorController.showUserMessageSelector` → `AgentSession.branch`):

- 分支来源必须是 **user 消息**。
- 选中的用户文本和图片附件会被恢复到编辑器草稿中。
- 如果选中的用户消息是根(`parentId === null`):通过 `newSession({ parentSession: previousSessionFile })` 启动新会话,携带之前的会话标题和标题来源。
- 否则:`createBranchedSession(selectedEntry.parentId)` 分叉到所选提示词边界为止的历史。

配置注意事项:当 `doubleEscapeAction=tree` 时,`/branch` 注册条目打开与 `/tree` 相同的树选择器;因此选择使用 `navigateTree()` 并留在当前文件中。这不仅仅是 `AgentSession.branch()` 的另一种 UI。

`SessionManager.createBranchedSession(leafId)` 细节:

- 通过 `getBranch(leafId)` 构建根→叶路径;缺失时抛出异常。
- 从复制的路径中排除现有的 `label` 条目。
- 为仍在路径中的条目,从已解析的标签映射(`labelsInEffect()`)重建新的标签条目。
- 持久化模式:写入新的 JSONL 文件并将管理器切换到它;返回新文件路径。
- 内存模式:替换内存条目;返回 `undefined`。

## 上下文重建与摘要/自定义集成

`buildSessionContext()`(位于 `session-context.ts`,通过 `SessionManager.buildSessionContext()` 暴露)解析活动的根→叶路径并构建有效的 LLM 上下文状态:

- 跟踪路径上最新的已配置/有效思考、角色模型、按提供商家族的服务档位、mode/data 和注入的 TTSR 状态。
- 处理路径上最近的压缩:
  - 先输出压缩摘要
  - 从 `firstKeptEntryId` 重放到压缩点的保留消息
  - 然后重放压缩后的消息
- 将 `branch_summary` 和 `custom_message` 条目作为 `AgentMessage` 对象包含。

然后 `session/messages.ts` 将这些消息类型映射为模型输入:

- `branchSummary` 和 `compactionSummary` 变成 user 角色的模板化上下文消息
- `custom`/`hookMessage` 变成 developer 角色的内容消息(通过 agent-core 的 `convertMessageToLlm`)

因此树移动通过改变活动叶路径来改变上下文,而不是修改旧条目。

## 标签与树 UI 行为

标签持久化:

- `appendLabelChange(targetId, label?)` 在当前叶链上写入 `label` 条目。
- `#labels`(在 `SessionEntryIndex` 中)会立即更新(设置或删除)。
- `getTree()` 将当前标签解析到每个返回的节点上。

树选择器行为(`tree-selector.ts`):

- 为导航展平树,保持活动路径高亮,并优先先显示活动分支。
- 支持筛选模式:`default`、`no-tools`、`user-only`、`labeled-only`、`all`。
  - `default` 隐藏 `label`、`custom`、`model_change` 和 `thinking_level_change`;它不是一个完整的“隐藏所有内部条目”筛选器。
- 支持对渲染的语义内容进行自由文本搜索。
- `Shift+L` 打开内联标签编辑,并通过 `appendLabelChange` 写入。

命令路由:

- `/tree` 总是打开树选择器。
- `/branch` 通常打开用户消息/文件分支选择器。当 `doubleEscapeAction=tree` 时,它改为打开树选择器并在同一文件内导航。

## 树操作的扩展与钩子触点

命令时扩展 API(`ExtensionCommandContext`):

- `branch(entryId)` — 创建分支会话文件;返回 `{ cancelled }`
- `navigateTree(targetId, { summarize? })` — 在当前树/文件内移动;返回 `{ cancelled }`

`HookCommandContext` 暴露相同的 `branch` 和 `navigateTree` 动作,但有意省略仅扩展可用的会话切换/重载/压缩动作。
树导航周围的事件:

- `session_before_tree`
  - 接收 `TreePreparation`:
    - `targetId`
    - `oldLeafId`
    - `commonAncestorId`
    - `entriesToSummarize`
    - `userWantsSummary`
  - 可以取消导航
  - 可以提供摘要载荷,取代内置摘要器
  - 接收中止 `signal`(Escape 取消路径)
- `session_tree`
  - 发出 `newLeafId`、`oldLeafId`
  - 创建摘要时包含 `summaryEntry`
  - `fromExtension` 表示摘要来源

相邻但相关的生命周期钩子:

- 用于 `/branch` 流程的 `session_before_branch` / `session_branch`
- 用于稍后影响树上下文重建的压缩条目的 `session_before_compact`、`session.compacting`、`session_compact`

## 实际约束与边界条件

- `branch()` 不能以 `null` 为目标;首个条目之前的根状态使用 `resetLeaf()`。
- `branchWithSummary()` 支持 `null` 目标并记录 `fromId: "root"`。
- 选择当前叶通常是空操作。交互式 `ask` 重新回答是例外:两阶段协议可能以当前 ask 结果叶为目标来重新打开或提交兄弟答案。
- 摘要需要活动模型和 API 密钥;任一缺失都会在导航前失败。
- 如果摘要被中止,导航被取消,叶保持不变。
- 内存会话永远不会从 `createBranchedSession` 返回分支文件路径,但其内存条目会被替换。
- 树上下文重建包括角色模型、已配置/有效思考、按提供商家族的服务档位、mode 数据和注入的 TTSR 状态;状态条目本身不会变成 LLM 消息。

## 计划批准时的会话命名

当用户从计划模式批准计划(`InteractiveMode.#approvePlan`)时,分发路径会用计划标题来设定会话名称,因此产生的新建、保留或压缩会话不会保持未命名。

触发:

- 计划批准到达 `#approvePlan(...)`,`options.title` 从计划批准详情填充。
- 这适用于每个到达执行分发的批准选项。如果批准时的压缩被显式取消,执行不会分发,命名块也不会到达;下一个操作员轮次从保留的计划引用继续。

命名来源:

- 规范化后的计划标题通过 `humanizePlanTitle(title)` 人性化(`packages/coding-agent/src/plan-mode/approved-plan.ts`):
  - 将连续的 `-`/`_` 替换为单个空格
  - 去除首尾空白
  - 将首字符大写
  - 对仅空白/仅分隔符的输入返回 `""`
- 人性化名称只在当前会话没有名称(`!sessionManager.getSessionName()`)时应用。然后它调用 `sessionManager.setSessionName(name, "auto")`,这同样拒绝覆盖用户命名的会话。
- 应用成功后,终端标题(`setSessionTerminalTitle`)和编辑器边框颜色会刷新以反映新名称。

示例(来自 `humanizePlanTitle`):

- `migrate-mcp-loader` → `Migrate mcp loader`
- `fix_session_naming` → `Fix session naming`
- `foo--bar__baz` → `Foo bar baz`
- `RefactorRouter` → `RefactorRouter`(没有可展开的分隔符)
- `""` / `"---"` → `""`(不应用名称)

## 仍然存在的旧版兼容

加载时仍会运行会话迁移:

- v1→v2 添加 `id`/`parentId`,并将压缩索引锚点转换为 id 锚点
- v2→v3 将旧的 `hookMessage` 角色迁移为 `custom`

当前运行时行为是迁移后的版本 3 树语义。
