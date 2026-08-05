<omfg>
用户对反复出现的 Agent 行为感到不满。
编写一条时移流规则(TTSR),它本可以更早地在本对话中拦截违规行为。

TTSR 机制:
- 规则是带 YAML frontmatter 的 markdown 文件。
- `condition` 是一个或多个针对 Assistant 流式输出进行测试的 JavaScript 正则模式。
- `scope` 是以逗号分隔的允许列表。如果存在,只检查列出的流。
- `text` = 仅 Assistant 的散文。`thinking` = 隐藏的推理摘要。`tool` = 每个工具的参数。
- `tool:<name>(<glob>)` = 单个工具,仅当路径类参数匹配 glob 时。示例:`tool:write(*.rb)`、`tool:edit(*.ts)`。
- 对于代码投诉,应该使用特定文件的工具范围。通过 `write` 生成的 Ruby 代码 → `tool:write(*.rb)`,而不是裸的 `tool` 或 `text`。
- 工具参数可能在流式传输时被序列化。针对包含引号的代码的 condition 应该容忍 JSON 转义。
- 当 `condition` 在 `scope` 内匹配时,流会被中断,markdown 正文会作为纠正指导被注入。

输出契约:
- 只输出一个 JSON 对象,不输出其他任何内容。
- JSON 字段:`name`、`description`、`condition`、`scope`、`body`。
- `name` 必须是 kebab-case。
- `description` 必须是一行摘要。
- `condition` 必须是字符串或 JavaScript 正则模式的字符串数组。
- `condition` 必须匹配本对话中较早出现的具体违规 Assistant 输出。
- 正则反斜杠的 JSON 转义只做一次:使用 `"\\beval\\s*\\("`,绝不使用 `"\\\\beval\\\\s*\\\\("`。
- 保持 `condition` 精准;绝不使用宽泛的 catch-all。
- `scope` 必须是字符串或字符串数组。
- 让 `scope` 尽量窄,与投诉相称。除非同样的不良行为同时出现在工具参数和 Assistant 散文中,绝不使用 `tool, text`。
- `body` 必须是简洁解释正确行为的 markdown 指导。
- 调用方负责组装 YAML frontmatter。绝不在 JSON 周围输出 markdown frontmatter 或围栏代码块。

示例形状:
{
  "name": "ts-no-any",
  "description": "Never use `any` in TypeScript — use `unknown`, a generic, or the real type",
  "condition": ": any|as any",
  "scope": ["tool:edit(*.ts)", "tool:edit(*.tsx)", "tool:write(*.ts)", "tool:write(*.tsx)"],
  "body": "Never use `: any` or `as any`. Use `unknown`, a domain type, a generic, or a type guard."
}

投诉:
{{complaint}}

{{#if feedback}}
到目前为止失败的尝试或要求的修改:
{{feedback}}

最新的候选 JSON:
{{previousRule}}

重新生成一条修正后的规则。修复列出的验证失败或用户的修改要求。绝不重复失败的 scope 或 condition。
{{/if}}
</omfg>
