# todo

> 对会话 todo 列表应用一次变更,并返回文本摘要以及完整的阶段/任务状态。

## 源码

- 入口:`packages/coding-agent/src/tools/todo.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/todo.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/index.ts` — 注册工具、暴露会话钩子、门控可用性。
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` — 在工具完成时更新可见的 todo UI。
  - `packages/coding-agent/src/session/agent-session.ts` — 存储缓存的阶段、在会话恢复时剥离已完成/已放弃的任务、发出失败提醒。
  - `packages/coding-agent/src/modes/controllers/todo-command-controller.ts` — `/todo` 命令路径、自定义条目持久化、记录提醒注入。
  - `packages/coding-agent/src/tools/render-utils.ts` — 渲染器树的折叠预览上限。

## 输入

参数对象**本身**就是单个操作——判别器及其字段位于顶层(没有 `ops` 数组包装)。

| 操作 | 必填字段 | 可选字段 | 效果 |
| --- | --- | --- | --- |
| `init` | `list` **或**扁平 `items` | `phase`(为扁平 `items` 形式命名阶段;默认为 `Tasks`) | 替换整个列表——使用 `list` 时,采用给定的阶段;使用扁平 `items` 数组时,合成一个阶段。每个新任务在规范化前都以 `pending` 开始。 |
| `start` | `task` | 无 | 将一个任务标记为 `in_progress`;任何其他 `in_progress` 任务被降级为 `pending`。 |
| `done` | `task`、`phase` 或均不提供 | 无 | 将目标任务、阶段或所有任务标记为 `completed`。 |
| `drop` | `task`、`phase` 或均不提供 | 无 | 将目标任务、阶段或所有任务标记为 `abandoned`。 |
| `block` | `task` 或 `phase` | `reason` | 将可操作的目标任务标记为 `blocked`;已完成/已放弃的任务保持关闭状态。`reason` 中的空白会被折叠为一行。 |
| `unblock` | `task` 或 `phase` | 无 | 将阻塞的目标任务恢复为 `pending` 并清除它们的阻塞备注。 |
| `rm` | `task`、`phase` 或均不提供 | 无 | 移除目标任务、清空该阶段的任务列表,或清空所有任务列表。 |
| `append` | `phase`、`items` | 无 | 向阶段追加新的 `pending` 任务;若阶段缺失则创建它。 |
| `view` | 无 | 无 | 回显当前列表。`view` 调用是只读的:不规范化、不写入状态。 |

### 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `op` | `"init" \| "start" \| "done" \| "rm" \| "drop" \| "block" \| "unblock" \| "append" \| "view"` | schema 中必填 | 操作判别器。执行时,省略的 op 仅对无歧义的 `list`/`items` 载荷进行修复(见流程)。 |
| `list` | `{ phase: string; items: string[] }[]` | 用于 `init`(除非给出了扁平 `items` 列表) | 完整替换载荷。每个 `items` 数组具有 `minItems: 1`。 |
| `task` | `string` | 用于 `start`;用于以任务为目标的 `done`/`drop`/`block`/`unblock`/`rm` | 精确的任务内容匹配。 |
| `phase` | `string` | 用于 `append`;用于以阶段为目标的 `done`/`drop`/`block`/`unblock`/`rm`;对扁平 `init` 可选 | 精确的阶段名称匹配,但 `append` 会惰性创建缺失的阶段,扁平 `init` 会合成一个(默认 `Tasks`)。 |
| `items` | `string[]` | 用于 `append`;或作为扁平 `init` 载荷 | 要追加的任务,或扁平 `init` 的完整任务列表。操作特定的验证要求至少一个条目;无关操作上多余的空白数组在 schema 上是合法的并被忽略。 |
| `reason` | `string` | 否 | `block` 的可选阻塞备注;规范化为单个去除首尾空白的行。 |

## 输出

工具返回一次性的 `AgentToolResult`:

- `content`:一个文本部分,包含来自 `formatSummary(...)` 的摘要。
  - 无错误的空最终状态:`Todo list cleared.`(纯 `view` 调用为 `Todo list is empty.`)。
  - 非空最终状态:剩余条目列表、当前阶段进度,然后是按阶段的树。
  - 若操作产生了验证/运行时错误,摘要以 `Errors: ...` 开头,结果被标记为 `isError: true`;变更被丢弃——返回与持久化的状态保持在调用前的列表。
- `details`:
  - `phases: TodoPhase[]`
  - `storage: "session" | "memory"`
  - `completedTasks?: TodoCompletionTransition[]` — 当任务在调用期间从非 `completed` 变为 `completed` 时
  - `op?: TodoOperation` — 标识已解析的操作,包括后来产生操作特定错误的变更;在 schema 验证失败与遗留记录条目上缺失。

`TodoPhase` / `TodoItem` 状态模型:

- `TodoPhase`:`{ name: string, tasks: TodoItem[] }`
- `TodoItem`:`{ content: string, status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked", blocker?: string }`

TUI 渲染器(`todoToolRenderer`)将调用与结果合并为一个记录块,并将阶段渲染为树。折叠的记录预览将树条目上限设为 `PREVIEW_LIMITS.COLLAPSED_ITEMS`(`8`)。

## 流程

1. `TodoTool.execute(...)` 从 `session.getTodoPhases?.() ?? []` 克隆当前缓存的阶段(`packages/coding-agent/src/tools/todo.ts`)。
2. `resolveTodoParams(...)` 验证原始的单操作载荷。由于工具启用了 `lenientArgValidation`,它仅在形态无歧义时修复缺失的 `op`:非空 `list` 表示 `init`;非空 `items` 加 `phase` 表示 `append`;单独的非空 `items` 仅在无任何阶段时表示 `init`。有歧义的目标字段与所有其他 schema 失败返回 `Invalid todo arguments: ...`。
3. `applyParams(...)` 用 `applyEntry(...)` 应用已解析的操作。
4. 每个操作都会变更工作阶段数组:
   - `initPhases(...)` 从头重建列表。
   - `start` 按精确 `content` 解析任务,将其他每个 `in_progress` 任务降级为 `pending`,然后将目标标记为 `in_progress`。
   - `done` / `drop` 使用 `getTaskTargets(...)` 定位一个任务、一个阶段或每个任务。
   - `block` 需要任务或阶段目标。它仅将 `pending`、`in_progress` 或已 `blocked` 的目标标记为 blocked,保留已完成/已放弃的任务;重复的 block 可以替换或清除备注。
   - `unblock` 需要任务或阶段目标,且仅将 blocked 目标改为 `pending`。
   - `rm` 移除一个任务、清空一个阶段的 `tasks`,或清空所有阶段的任务数组。
   - `appendItems(...)` 解析或创建目标阶段,并推送新的 `pending` 任务,除非相同任务内容已存在于任何地方。
5. 缺失的任务/阶段引用与操作特定失败被记录在 `errors` 数组中;任何错误都会在最后丢弃该操作的变更。
6. 成功变更后,`normalizeInProgressTask(...)` 强制执行单活动任务不变量:
   - 若多个任务为 `in_progress`,只有第一个保持活动,其余变为 `pending`;
   - 若没有 `in_progress` 任务,按阶段/任务顺序的第一个 `pending` 任务会自动提升为 `in_progress`;
   - 阻塞的任务会被跳过,因此当所有未完成工作都被阻塞时,列表可能没有活动任务。
7. `execute(...)` 仅在操作未产生错误且不是 `view` 时,用 `session.setTodoPhases?.(...)` 存储更新后的阶段;失败的操作被丢弃。当 `session.getSessionFile()` 存在时,`storage` 为 `"session"`,否则为 `"memory"`。
8. `getCompletionTransitions(...)` 比较先前与更新后的阶段(对失败或 `view` 调用跳过);新完成的任务在 `details.completedTasks` 中返回。
9. 详情在成功或操作特定失败时包含已解析的 `op`,包括从省略的输入推断出的操作。无法通过 schema 验证的载荷会在 op 可用之前返回。
10. Agent 运行时在 `packages/coding-agent/src/session/agent-session.ts` 中监视 `todo` 工具结果;成功结果刷新缓存的 todo,失败结果注入一条隐藏的下一轮提醒,告诉模型 todo 进度在重试之前不可见。
11. 事件控制器在成功时根据 `result.details.phases` 更新可见的 todo UI,或在出错时显示警告(`packages/coding-agent/src/modes/controllers/event-controller.ts`)。

## 模式 / 变体

### 状态转换

| 当前状态 | `start` | `done` | `drop` | `block` | `unblock` | `rm` | `append` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pending` | 目标变为 `in_progress` | `completed` | `abandoned` | `blocked` | 无变化 | 已移除 | 新任务以 `pending` 进入 |
| `in_progress` | 目标保持 `in_progress`;非目标的活跃任务变为 `pending` | `completed` | `abandoned` | `blocked` | 无变化 | 已移除 | 状态无变化 |
| `blocked` | 若被定位可设为 `in_progress` | `completed` | `abandoned` | 保持 blocked;备注可变更 | `pending`,备注已清除 | 已移除 | 状态无变化 |
| `completed` | 若被定位可设回 `in_progress` | 保持 `completed` | 若被定位则变为 `abandoned` | 无变化 | 无变化 | 已移除 | 状态无变化 |
| `abandoned` | 若被定位可设回 `in_progress` | 若被定位则变为 `completed` | 保持 `abandoned` | 无变化 | 无变化 | 已移除 | 状态无变化 |

规范化随后在操作运行后重新应用单活动任务规则。

### 操作定位规则

- `done`、`drop`、`rm`:
  - 设置了 `task`:影响一个精确内容的任务。
  - 否则设置了 `phase`:影响该精确名称阶段中的每个任务。
  - 否则:影响每个阶段中的每个任务。
- `block` 与 `unblock` 使用相同的任务或阶段查找,但拒绝省略的目标。
- `append` 是唯一会创建缺失阶段的操作。
- `init` 完全丢弃先前的阶段。

### Markdown 往返辅助函数

同一文件还暴露了 `/todo` 使用的非工具辅助函数:

- `phasesToMarkdown(...)` 将阶段序列化为标题加清单条目(`[ ]`、`[/]`、`[x]`、`[-]`、`[!]`)。阻塞原因保留在末尾的 `<!-- blocker: ... -->` 注释中。
- `markdownToPhases(...)` 解析该格式,将孤立任务默认放入 `Todos` 阶段,还接受 `>` 表示 `in_progress`、`~` 表示 `abandoned`,恢复阻塞备注,并运行相同的规范化步骤。

## 副作用

- 文件系统
  - 工具本身没有。
- 会话状态(记录、内存、任务、检查点、注册表)
  - 通过 `setTodoPhases` 变更会话 todo 缓存。
  - `storage` 报告会话是否有后备会话文件,但工具本身不追加自定义会话条目。
  - 成功的工具结果消息携带 `details.phases`;`getLatestTodoPhasesFromEntries(...)` 之后可以从这些记录条目重建状态。
  - 失败的 `todo` 结果使 `agent-session` 排队一条隐藏的下一轮提醒(`customType: "todo-error-reminder"`)。
- 用户可见的提示 / 交互式 UI
  - 记录块由 `todoToolRenderer` 渲染,并与调用行合并。
  - `event-controller` 根据成功结果更新可见的 todo 面板。
  - 出错时,`event-controller` 显示 `Todo update failed...`;可见面板可能保持过时,直到之后成功的调用。
- 后台工作 / 取消
  - 会话级的 `completed`/`abandoned` 任务自动清除已被移除(该计时器在工具调用之间变更规范阶段);TUI todo 控件在 `tasks.todoClearDelay` 之后仍会清除已关闭的条目(仅显示层,`packages/coding-agent/src/modes/interactive-mode.ts`)。

## 限制与上限

- `init.list`:应用于单个操作(`todoSchema`)。参数对象恰好携带一个操作。
- `init.list[*].items`:schema 级 `minItems: 1`。
- 扁平的 `init.items` 与 `append.items`:共享 schema 允许任意数组长度,但操作特定的执行拒绝缺失/为空的列表。
- 渲染器折叠预览:`PREVIEW_LIMITS.COLLAPSED_ITEMS = 8`(`packages/coding-agent/src/tools/render-utils.ts`)。
- 执行时修复:省略的 `op` 仅对上述无歧义载荷推断;schema 本身仍要求 `op`。
- 自动清除延迟:`tasks.todoClearDelay` 默认 `60` 秒;`< 0` 禁用自动清除,`0` 立即清除。仅显示层——由 TUI 控件应用(`packages/coding-agent/src/modes/interactive-mode.ts`);该设置在会话层面不生效。
- 工具执行模式:`concurrency = "exclusive"`、`strict = true`、`loadMode = "discoverable"`。

## 错误

- 普通的不当操作载荷以人类可读字符串累积在 `errors` 中;结果被标记为 `isError: true`,变更被丢弃——返回与持久化的状态保持在调用前的列表。
- 错误字符串来自 `packages/coding-agent/src/tools/todo.ts` 中的辅助函数,包括:
  - `Missing list for init operation`
  - `Missing task content`
  - `Duplicate phase "..." in init list` / `Duplicate task "..." in init list`
  - `Task "..." not found` — 在适用时附带额外的空列表提示,或当缺失内容看起来像 ID 时,附带任务按内容(而非 `task-N` ID)引用的提示
  - `Missing phase name`
  - `Phase "..." not found`
  - `Missing phase name for append operation`
  - `block requires a task or phase target`
  - `unblock requires a task or phase target`
  - `Missing items for append operation`
  - `Task "..." already exists`
- `todo` 调用携带单个操作;其中的任何错误都会丢弃该操作所做的所有变更。
- 运行时级工具失败在工具体之外处理:`agent-session` 注入隐藏提醒,事件控制器警告用户可见进度可能过时。
- 幂等性按操作而异:
  - `init` 是完整替换;重放相同载荷产生相同状态。
  - `start`、`done`、`drop`、`block` 与 `unblock` 在既有目标状态上实际上是幂等的,尽管 `start` 还会降级另一个活跃任务,重复的 `block` 可以更新其原因。
  - `rm` 对定向移除不是幂等的:第二次调用会因任务或阶段已消失而报错。
  - `append` 不是幂等的:重复的任务内容以 `Task "..." already exists` 被拒绝;`append` 操作会预先验证,因此含任何重复项的操作不会追加任何内容。

## 备注

- 工具内部的任务查找是精确字符串相等。面向模型的提示词说明任务内容与阶段名称是标识符,应保持唯一;`append` 全局强制任务唯一性,`init` 拒绝其载荷中重复的阶段名称与重复的任务内容。
- `findTaskByContent(...)` 返回跨阶段的第一个匹配任务。重复的任务内容会使后续的定向操作产生歧义。
- `normalizeInProgressTask(...)` 在操作之后运行一次,而非操作中途。单个操作(例如 `init`)可以构建一个中间的无效状态,并依赖最终的规范化。
- `storage: "session"` 表示会话有会话文件后备;这并不意味着该工具写入了持久的自定义条目。
- 重新加载的持久化因路径而异:
  - 普通的 `todo` 调用存留在记录工具结果详情中;
  - `/todo` 命令编辑还会追加 `customType: "user_todo_edit"` 条目,并注入一条对模型可见的、描述手动编辑的 `<system-reminder>` 开发者消息。
- 会话恢复时,`AgentSession.#syncTodoPhasesFromBranch()` 在恢复缓存列表前剥离 `completed` 与 `abandoned` 任务。`/todo` 命令通过读取最新的记录/自定义条目状态绕过这一点,因此历史上已完成/已放弃的任务仍对用户可见。
- 工具可用性由 `todo.enabled` 门控,当 `includeYield` 启用时注册表会排除它,除非会话已启用 prewalk(`packages/coding-agent/src/tools/index.ts`)。
- 子 Agent 不继承 `todo`;`packages/coding-agent/src/task/executor.ts` 也将其作为父级所有的工具从活动集中过滤。例外(两层都适用):已启用 prewalk 的子 Agent 保留它——prewalk 计划提示与 todo 门控要求子级在交接前提交自己的 todo 列表。
