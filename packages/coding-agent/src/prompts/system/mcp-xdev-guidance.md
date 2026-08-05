## MCP 工具路由

{{#if tools.length}}
通过向每个挂载工具的挂载路径写入 JSON 参数来执行它:
{{#each tools}}
- {{mcpToolName}} → `{{path}}`
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
为保持此提示词有界,其他已挂载的 MCP 工具映射被省略。请检查 `xd://` 获取确切的最新路径。
{{/if}}
