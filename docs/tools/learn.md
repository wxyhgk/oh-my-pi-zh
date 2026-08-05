# learn

> 将可复用的经验捕获到长期记忆中,并可选择创建或更新受管技能。

## 来源
- 入口:`packages/coding-agent/src/tools/learn.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/learn.md`
- 受管技能辅助:`packages/coding-agent/src/autolearn/managed-skills.ts`
- 本地记忆后端:`packages/coding-agent/src/memory-backend/local-backend.ts`
- 本地经验持久化:`packages/coding-agent/src/memories/index.ts`(`saveLearnedLesson(...)`)

## 注册 / 可见性
- `loadMode = "essential"` 且 `strict = true`,因此该工具保持顶层注册,而不是挂载在 `xd://` 下。
- 批准是动态的:包含 `skill` 的调用,或在 `memory.backend = "local"` 时的任何调用,`approval = "write"`;仅记忆的 Hindsight/Mnemopi 调用为 `approval = "read"`。
- 注册要求 `autolearn.enabled = true`(默认 `false`)且 `memory.backend` 为 `"hindsight"`、`"mnemopi"` 或 `"local"`。
- 已启用的顶层会话会在普通显式工具列表中自动包含 `learn`。子代理不会自动发现或接收它,但当其 requested-tools/frontmatter 列表显式包含它时可以使用。
- 执行是单次触发的,不会发出进度更新。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `memory` | `string` | 是 | 要记住的持久、自包含经验:是什么、何时、为什么。该 schema 没有最小长度;后端特定的清理/存储逻辑决定空值是否成功。 |
| `context` | `string` | 否 | 该经验的来源上下文。 |
| `skill` | `{ action: "create" \| "update"; name: string; description: string; body: string }` | 否 | 经验保存成功后要创建或增强的受管技能。`body` 为不含 frontmatter 的 Markdown。 |

## 输出
- 仅经验:
  - `content[0].text = "Lesson stored."` 或 `"Lesson queued for retention."`
  - `details = { skill: null }`
- 经验加技能:
  - `content[0].text = "<lesson result>. Created managed skill \"<name>\"."` 或 `"... Updated ..."`
  - `details = { skill: "<name>" }`
- 与创作技能同名冲突时,在存储/排队经验后返回 `isError: true`,并报告 `details = { skill: null, shadowed: true }`。

## 流程
1. `LearnTool.createIf(...)` 仅在 `autolearn.enabled` 为 true 且 `memory.backend` 为 `"hindsight"`、`"mnemopi"` 或 `"local"` 时才暴露该工具。
2. `execute(...)` 在任何技能变更之前先存储经验:
   - Mnemopi:以 `source: "coding-agent-learn"`、`importance: 0.8`、`scope: "bank"`、启用提取、`veracity: "tool"`、`memoryType: "fact"` 以及会话/cwd/上下文元数据调用 `rememberScoped(...)`;返回的 id 缺失则视为失败。
   - 本地后端:调用 `localBackend.save(...)`,它会规范化并写入项目作用域的 `learned.md`;`stored === 0` 视为失败。
   - Hindsight:通过 `state.enqueueRetain(memory, context)` 将保留操作排队,并把经验报告为已排队。
3. 若 `skill` 缺失,工具在记忆写入/排队后返回。
4. 若 `skill.action == "create"`,工具会以小写化/校验后的名称与活动的创作技能比对。若经验已存储或排队后发生冲突,则返回错误结果。
5. 否则调用 `writeManagedSkill(...)`。由于经验持久化已经发生,技能写入失败会作为部分结果重新抛出。
6. 与 `manage_skill` 不同,`learn` 在写入后不会调用会话的 `refreshSkills` 回调。受管技能会在之后的技能刷新/会话中被发现。

## 模式 / 变体
- 仅记忆的经验捕获。
- 经验加受管技能创建/更新,用于值得固化为 `SKILL.md` 的可重复流程。
- 后端特定的持久化:排队的 Hindsight、作用域化的 Mnemopi SQLite,或项目作用域的本地 `learned.md`。
- 受管技能文件已存在时 `create` 失败;不存在时 `update` 失败。进程内同名的变更操作会被串行化。

## 副作用
- 文件系统:
  - 本地后端写入 `<agent-dir>/memories/<encoded-cwd>/learned.md`。
  - 受管技能写入 `<agent-dir>/managed-skills/<sanitized-name>/SKILL.md`;默认 Agent 目录为 `~/.omp/agent`。
  - Mnemopi 写入其作用域化的 SQLite 数据库。
- 网络:Hindsight 队列稍后刷新到配置的服务器。Mnemopi 可以在同步写入行之后调度已配置的 embedding/事实提取提供商工作;本地文件存储本身是离线的。
- 会话状态:读取后端状态、设置、cwd 和会话 id。此处创建的技能不会立即注入活动技能列表。
- 后台工作:Hindsight 保留和 Mnemopi 提取/embedding 可在工具结果返回后继续进行。

## 限制与上限
- 可用性要求 `autolearn.enabled` 加上受支持的记忆后端;两个设置默认都是禁用/关闭。
- 受管技能名称会被去除首尾空白并转为小写,然后必须匹配 `[a-z0-9][a-z0-9-]{0,63}`。
- 受管描述会被压缩为一行,并去除控制/格式字符、尖括号、反引号和重复的波浪号。
- 最终的受管 `SKILL.md` 内容(包括生成的 frontmatter 和描述)上限为 `64_000` 个 UTF-8 字节。
- 受管技能永远不会覆盖创作技能;创作名称在发现时优先。
- 本地经验按最新优先排序,并按规范化后的渲染行去重,最多 100 条经验条目。在提示词注入中和与机密信息脱敏之后,经验内容上限为 2,000 个字符,上下文为 400 个。

## 错误
- Mnemopi 状态缺失时:`Mnemopi backend is not initialised for this session.`
- 本地 Mnemopi 写入未返回 id 时:`Mnemopi did not store the lesson (no memory id returned).`;不会尝试可选的技能。
- 本地后端规范化未产生经验时:`Lesson was empty after sanitization; nothing stored.`;不会尝试可选的技能。
- Hindsight 状态缺失时:`Hindsight backend is not initialised for this session.`
- 在经验成功后,`skill.action = "create"` 的创作名称冲突返回 `isError: true`、`details = { skill: null, shadowed: true }`。
- 在经验成功后,受管技能的校验、创建/更新、安全或大小失败会抛出 `<lesson result>, but the managed skill could not be written: <reason>`。

## 说明
- 请谨慎使用此工具。一条精确可复用的经验胜过几条含糊的记忆。
- 仅在可重复的流程上使用 `skill`;普通事实应保持仅记忆。
- 受管技能 frontmatter 由规范化后的名称和清理后的描述生成;`body` 不得包含 frontmatter。
- 受管技能与创作技能相互隔离。`learn` 写入它们供后续的发现刷新使用;若活动会话必须在变更后立即刷新,请使用 `manage_skill`。
