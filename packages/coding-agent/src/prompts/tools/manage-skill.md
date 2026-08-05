创建、更新或删除一个托管技能——一个写入隔离目录(`~/.omp/agent/managed-skills`)并在未来会话中像普通技能一样呈现的 `SKILL.md`。

托管技能用于值得固化的可重复流程:设置序列、调试配方、项目特定工作流。它们与用户编写的技能分开保存,此工具绝不编辑那些。

- `action: "create"` — 技能已存在时失败。
- `action: "update"` — 覆盖正文;技能不存在时失败。
- `action: "delete"` — 技能不存在时失败。

`name` 是 kebab-case(小写字母、数字、连字符)。`description` 驱动发现,所以要具体。不要在 `body` 中包含 frontmatter;它由 `name` 和 `description` 生成。
