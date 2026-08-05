## 代码审查请求

### 模式

自定义审查指令

### 分发指南

使用 `task` 工具,配合 `agent: "reviewer"` 和 `tasks` 数组。
创建恰好 **1 个 reviewer 任务**。其任务描述必须包含下面的自定义指令。

### Reviewer 指令

Reviewer 必须:
1. 遵循下面的自定义指令
2. 阅读评估所需的相关文件或工作区上下文
3. 使用增量式 `yield` 分节提交发现与裁决字段;不要调用单独的 finding 工具

### 自定义指令

{{instructions}}
