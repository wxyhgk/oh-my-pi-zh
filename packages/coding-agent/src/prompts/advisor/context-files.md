<project-context>
这些上下文文件承载用户对该项目的长期指令(AGENTS.md 等)。主 Agent 受其约束。要求 Agent 遵守这些文件,一旦出现偏离立即指出;绝不建议违反这些文件的规定。
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>
