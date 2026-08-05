# manage_skill

> 创建、更新或删除隔离的受管技能。

## 来源
- 入口:`packages/coding-agent/src/tools/manage-skill.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/manage-skill.md`
- 受管技能辅助:`packages/coding-agent/src/autolearn/managed-skills.ts`
- 技能发现:`packages/coding-agent/src/extensibility/skills.ts`

## 注册 / 可见性
- 工具元数据:`approval = "write"`、`strict = true`、`loadMode = "essential"`。它保持顶层注册,而不是挂载在 `xd://` 下。
- 注册要求 `autolearn.enabled = true`(默认 `false`),但与 `memory.backend` 无关。
- 已启用的顶层会话会在普通显式工具列表中自动包含它。子代理不会自动发现或接收它,但当其 requested-tools/frontmatter 列表显式包含它时可以使用。
- 执行是单次触发的,不会发出进度更新。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `action` | `"create" \| "update" \| "delete"` | 是 | 受管技能变更操作。 |
| `name` | `string` | 是 | 短横线命名(kebab-case)的受管技能名称。 |
| `description` | `string` | 创建/更新 | 用于技能发现的一行描述。 |
| `body` | `string` | 创建/更新 | `SKILL.md` 的 Markdown 正文;不要包含 frontmatter。 |

## 输出
- `delete`:`content[0].text = "Deleted managed skill \"<name>\"."`,`details = { action: "delete", name }`
- `create`:`content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`,`details = { action: "create", name }`
- `update`:`content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`,`details = { action: "update", name }`
- 创建时与创作技能同名冲突返回 `isError: true`,`details = { action: "create", name, shadowed: true }`。

## 流程
1. `ManageSkillTool.createIf(...)` 仅在 `autolearn.enabled` 为 true 时暴露该工具,并捕获会话的可选 `refreshSkills` 回调。
2. schema 校验要求 `create` / `update` 同时提供 `description` 和 `body`;`delete` 只需要 `name`。
3. `delete` 调用 `deleteManagedSkill(name)`,然后在回调存在时刷新活动技能。
4. `create` 规范化名称,并检查活动的创作技能是否已占用该名称;如果是,则返回错误结果而不写入。
5. `create` / `update` 调用 `writeManagedSkill(...)`,它会规范化/校验名称、清理生成的 frontmatter、串行化进程内同名的写入,并在 managed-skills 根目录下写入 `SKILL.md`。
6. 创建/更新成功后,工具在回调存在时刷新活动技能,使交互式会话能立即发现该变更。

## 模式 / 变体
- `create`:以独占创建语义原子地创建 `SKILL.md`;已存在时失败。
- `update`:覆盖现有的常规单链接受管 `SKILL.md`;不存在时失败。
- `delete`:递归删除现有的受管技能目录;不存在时失败。
- 同一规范化名称的变更按提交顺序在进程内串行化;不同名称可以并行进行。跨进程的竞争不会被串行化。

## 副作用
- 文件系统:写入或删除 `<agent-dir>/managed-skills/<name>/SKILL.md`;默认 Agent 目录为 `~/.omp/agent`。
- 网络:无。
- 会话状态:在工具创建时读取 `autolearn.enabled`,并在 `refreshSkills` 可用时于成功变更后刷新活动技能列表。
- 后台工作:无。

## 限制与上限
- 可用性要求 `autolearn.enabled = true`。
- 名称会被去除首尾空白并转为小写,然后必须匹配 `[a-z0-9][a-z0-9-]{0,63}`。
- 描述会被清理为一行,并去除控制/格式字符、尖括号、反引号和重复的波浪号。
- 正文会被去除首尾空白且必须保持非空;生成的 frontmatter 只包含规范化后的 `name` 和清理后的 `description`。
- 最终的受管 `SKILL.md` 内容上限为 `64_000` 个 UTF-8 字节,包括 frontmatter 和描述。
- managed-skills 根目录、技能目录和文件都会检查以防止符号链接逃逸;`update` 还会拒绝非常规文件或具有多个硬链接的文件。

## 错误
- 无效名称抛出 `Invalid skill name "<raw>"...`。
- 缺少 `description` 或 `body` 的创建/更新会被 schema 校验拒绝;执行时的防御性错误为 `"<action>" requires both "description" and "body".`。
- 清理后为空的描述抛出 `Managed skill "<name>" needs a non-empty description.`。
- 去除首尾空白后为空的正文抛出 `Managed skill "<name>" needs a non-empty body.`。
- 过大的最终文件抛出 `Managed skill is <bytes> bytes; the limit is 64000.`。
- 对已存在的受管文件执行 `create`、对缺失目标执行 `update`/`delete` 会抛出操作特定的辅助错误。
- `create` 的创作名称遮蔽是普通工具结果,`isError: true` 且 `details.shadowed = true`;不会写入任何文件。
- 不安全的根目录、符号链接的目录/文件、非常规文件以及具有多个硬链接的更新文件会抛出安全错误。

## 说明
- 受管技能在 `<agent-dir>/managed-skills` 下生成,永远不会编辑创作技能。
- 不要在 `body` 中包含 YAML frontmatter;`writeManagedSkill(...)` 会生成规范化 `name` 和清理后 `description` 的 frontmatter。
- `update` 不会绕过创作技能的优先级:如果创作技能同名,受管技能在发现时仍会被遮蔽。
