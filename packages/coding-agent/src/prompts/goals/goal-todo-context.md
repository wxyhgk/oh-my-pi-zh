<todo_context>
下面是该目标的当前持久化 todo 状态。目标续行不会有可见的用户提示,所以把它当作实时进度状态,而不是旧的转录装饰。
在继续实质性工作之前,把你接下来的动作与这些 todo 对照。如果某项已过时、已完成或不再是当前指针,先调用 `todo` 工具把它标记为完成或重写列表。处理后续阶段时,不要留下过时的 in_progress 项。

总计:{{closed}}/{{total}} 已完成,{{open}} 项待办。
{{#each phases}}
- {{name}}
{{#each tasks}}
  - [{{status}}] {{content}}
{{/each}}
{{/each}}
</todo_context>
