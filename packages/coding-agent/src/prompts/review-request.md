## 代码审查请求

### 模式

{{mode}}

### 变更文件({{len files}} 个文件,+{{totalAdded}}/-{{totalRemoved}} 行)

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_没有需要审查的文件。_
{{/if}}
{{#if excluded.length}}
### 排除的文件({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### 分发指南

使用 `task` 工具,配合 `agent: "reviewer"` 和 `tasks` 数组。
{{#when agentCount "==" 1}}创建恰好 **1 个 reviewer 任务**。{{else}}并行生成 **{{agentCount}} 个 reviewer Agent**。{{/when}}
{{#if multiAgent}}
按就近原则对文件分组,例如:
- 同一目录/模块 → 同一 Agent
- 相关功能 → 同一 Agent
- 测试与其实现文件 → 同一 Agent
{{/if}}

### Reviewer 指令

Reviewer 必须:
1. 只关注分配的文件
2. {{#if skipDiff}}{{diffInstruction}}{{else}}必须使用下面的 diff hunks(绝不重新运行 git diff){{/if}}
3. {{contextInstruction}}
4. 使用增量式 `yield` 分节提交发现与裁决字段;不要调用单独的 finding 工具

{{#if skipDiff}}
### 差异预览

_完整差异过大({{len files}} 个文件)。每个文件仅显示前 ~{{linesPerFile}} 行。_

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### 差异

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### 附加指令

{{additionalInstructions}}
{{/if}}
