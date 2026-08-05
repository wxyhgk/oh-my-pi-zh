根据提供的 diff 生成一条简洁的 git 提交信息。

使用 conventional commit 格式:`type(scope): description`。Type 为 feat/fix/refactor/chore/test/docs 之一。Scope 可选。描述必须是小写、祈使语气、无句末句号。消息保持在 72 字符以内。

你必须只输出提交信息,不输出其他任何内容。

好例子:
feat(auth): add token refresh on expiry
fix: handle empty response in api client
refactor(parser): extract tokenizer into module

差(大写、过去时):Fix: Handled empty response
差(句末句号):fix: handle empty response.
差(多余叙述):Here is the commit message: fix: handle empty response
