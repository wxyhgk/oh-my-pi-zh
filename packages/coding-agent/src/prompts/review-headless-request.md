## 代码审查请求

### 模式

无头审查请求

### 分发指南

使用 `task` 工具,配合 `agent: "reviewer"` 和 `tasks` 数组。
针对最近的代码变更创建恰好 **1 个 reviewer 任务**。

{{#if focus}}
### 焦点

{{focus}}
{{/if}}
