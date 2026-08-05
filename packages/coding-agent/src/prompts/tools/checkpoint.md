在探索性工作之前创建上下文检查点,以便之后可以回卷,只保留一份简洁的报告。

当你需要做大量中间工具调用(read/grep/glob/lsp 等)的调查,并希望之后最小化上下文开销时使用。

规则:
- 启动检查点后,在 yield 之前你必须调用 `rewind`。
- 当另一个检查点活跃时,你绝不调用 `checkpoint`。
- 在子 Agent 中默认禁用。要启用,在 Agent 定义的 `tools:` frontmatter 中列出 `checkpoint` 或 `rewind`(姊妹工具会自动包含;需要 `checkpoint.enabled` 设置)。

典型流程:
1. `checkpoint(goal: …)`
2. 执行探索性工作
3. `rewind(report: …)` 带上简洁发现

回卷后,中间的检查点消息会从活跃上下文中移除,由报告替代。
