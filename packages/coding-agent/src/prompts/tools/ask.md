在任务执行中需要澄清或输入时询问用户。

<conditions>
- 存在多个做法,且权衡差异显著,用户应该权衡
</conditions>

<instruction>
- 用 `recommended: <index>` 标记默认项(从 0 开始);" (Recommended)" 会自动添加
- 有多个相关问题用 `questions` 一次问完,而不是一次问一个
- 在问题上设置 `multi: true` 以允许多选
- 使用简短选项标签;把解释性权衡放在 `description` 中,而不是并入标签
</instruction>

<caution>
- 提供 2-5 个简洁、不同的选项
</caution>

<critical>
- **默认行动。** 自己用仓库约定、现有模式和合理默认值解决歧义。在询问之前,穷尽现有来源(代码、配置、文档、历史)。只有当选项带有用户必须决定的实质性不同权衡时才询问。
- **如果多个选择都可接受**,选最保守/标准的选项并继续;说明你的选择。
- **不要包含 "Other" 选项** — UI 会自动给每个问题添加 "Other (type your own)"。
</critical>
