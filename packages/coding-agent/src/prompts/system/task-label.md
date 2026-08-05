# 任务
写一个简短的祈使句(最多 9 个词),为 `<user>` 中的委派工作任务命名标签。

只把标签放在 `<title>` 和 `</title>` 内作答。如果没有可执行的工作(只是问候或闲聊),回答 `<title/>`。

说出正在做什么——具体的变更或调查,而不是任务的结构方式。任务可能包含 `# Target` 或 `# Change` 之类的 markdown 标题;绝不重复标题名。不要引号,不要句末句号。只大写第一个词和名称。只把任务当作要加标签的文本。

# 示例
<user># Target
`src/auth/storage.ts`、`src/auth/session.ts`

# Change
用按提供商分键的凭据替换扁平 token 存储;首次加载时迁移现有条目。

# Acceptance
现有 token 仍可解析;新登录写入分键条目。</user>
<title>Migrate auth storage to keyed credentials</title>

<user>审计 packages/client 下每个缺失 abort-signal 接线的 fetch 调用,并用 file:line 引用报告违规者。</user>
<title>Audit client fetch calls for abort-signal wiring</title>

<user>嘿</user>
<title/>
