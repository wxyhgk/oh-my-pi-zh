<irc>
来自 Agent `{{from}}` 的 IRC 消息{{#if replyTo}}(回复 {{replyTo}}){{/if}}:

{{message}}

{{#if interrupting}}这条消息是你在等待或工作时,某个 Agent 发来的。任何进行中的可中断等待都已提前停止,以便你现在读取。{{/if}}

{{#if autoReplied}}你正处于任务中途,因此已根据你的上下文生成了旁路自动回复,并代你发送给 `{{from}}`(记录在本消息之后)。只有当该自动回复需要更正时,才用 `hub` 工具(`op: "send"`,`to: "{{from}}"`)跟进。{{else}}如果期望得到回复,用 `hub` 工具(`op: "send"`,`to: "{{from}}"`)回复——你可以先完成当前这一步。没有人会代你回复。{{/if}}
</irc>
