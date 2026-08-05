# memory_edit

> 按 id 更新、遗忘或使 Mnemopi 长期记忆失效。

## 来源
- 入口:`packages/coding-agent/src/tools/memory-edit.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/memory-edit.md`
- 后端协作方:`packages/coding-agent/src/mnemopi/state.ts`(`editScopedMemory(...)`)

## 注册 / 可见性
- 工具元数据:`approval = "read"`、`strict = true`、`loadMode = "discoverable"`,尽管成功的调用会修改本地记忆。
- 注册要求 `memory.backend = "mnemopi"`;对 `"off"`、`"local"` 和 `"hindsight"` 该工具不存在。
- 在带显式工具列表的不受限会话中,注册会自动为 Mnemopi 包含 `memory_edit`。受限列表不会被扩展。
- 在普通的 `tools.xdev` 会话中,可发现的内置工具可能以 `xd://memory_edit` 呈现;显式请求的工具保持顶层。
- 执行是同步且单次触发的,没有进度回调或取消参数。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `op` | `"update" \| "forget" \| "invalidate"` | 是 | 要应用的编辑操作。 |
| `id` | `string` | 是 | `recall` 返回的记忆 id。 |
| `content` | `string` | 否 | `update` 的替换记忆文本。 |
| `importance` | `number` | 否 | `update` 的替换重要性;钳制到 `0..1`。 |
| `replacement_id` | `string` | 否 | 为 `invalidate` 记录的取代记忆 id。 |

## 输出
- `content[0].type = "text"`
- 成功的变更渲染 `Memory <id> updated|deleted|invalidated in bank <bank> (<store>).`
- 未知或不符合操作条件的 id 渲染 `Memory <id> was not found...`;这是状态为 `not_found` 的普通结果。
- 事实 id 渲染 `Memory <id> is a read-only fact...; it cannot be edited. Read it with memory://<id>.`;这是状态为 `not_editable` 的普通结果。
- `details` 为 `{ status, bank?, store? }`,其中 status 为 `"updated" | "deleted" | "invalidated" | "not_found" | "not_editable"`,当解析到行时 store 为 `"working" | "episodic" | "fact"`。

## 流程
1. `MemoryEditTool.createIf(...)` 仅在 `memory.backend == "mnemopi"` 时暴露该工具。
2. `execute(...)` 获取 `session.getMnemopiSessionState()`,如果后端未初始化则失败。
3. `update` 至少需要 `content` 或 `importance` 之一。
4. `importance` 在后端调用前被钳制到 `0..1`。
5. 工具调用 `state.editScopedMemory(op, id, { content, importance, replacementId })`。
6. 后端按去重后的 retain、recall 和 global 目标的顺序搜索。它返回第一个成功的可编辑结果,否则返回第一个解析到但不符合条件的结果,再否则返回 `not_found`。
7. 工具渲染返回的状态,并在 `details` 中原样传递后端结果。

## 模式 / 变体
- `update` 替换工作记忆文本和/或重要性。内容替换是整体替换,不是补丁式。
- `forget` 永久删除工作记忆行。
- `invalidate` 软性地取代工作或情景记忆行,并可能记录 `replacement_id`。
- 事实行可读但不可变;每个操作都返回 `not_editable`。
- 对情景记忆 id 执行 `update`/`forget` 会返回 `not_found` 及其 bank/store 位置,因为这些操作只支持工作记忆。

## 副作用
- 文件系统:修改包含已解析行的本地 Mnemopi SQLite 数据库,该数据库可能是 retain、recall、shared 或安全发现的 legacy bank。
- 网络:无;编辑操作不会调用 embedding 或提取提供商。
- 会话状态:读取活动会话的作用域 Mnemopi 状态;不会重写已注入的 `<memories>` 上下文。

## 限制与上限
- 可用性要求 `memory.backend = "mnemopi"`;Hindsight 和本地文件支持的记忆不会暴露此工具。
- `id` 必须直接提供;工具不按内容搜索。
- recall 预览默认上限为 500 个字符。`update` 之前始终先获取 `read memory://<id>`;该 URL 在相同作用域的 bank 中解析完整行。
- 既无 `content` 也无 `importance` 的 `update` 在任何后端写入前就被拒绝。
- `0..1` 之外的 `importance` 值会被钳制而不是拒绝。

## 错误
- 工具已暴露但会话状态缺失时抛出 `Mnemopi backend is not initialised for this session.`。
- 空更新时抛出 `memory_edit update requires content or importance.`。
- 缺失、情景记忆的 update/forget 以及事实 id 是普通结果而不是抛出的错误;请检查 `details.status`。
- 当没有作用域 bank 包含该行时,`read memory://<id>` 抛出 `Mnemopi memory <id> not found`。

## 说明
- 每次 update 之前读取完整的 `memory://<id>` 行。把截断的 recall 预览复制到 `content` 会删除看不到的尾部。
- 对历史可能仍有用的过期工作/情景记忆,优先使用 `invalidate`。
- 仅当工作记忆行应被硬删除时才使用 `forget`。
