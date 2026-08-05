搜索网页,获取超出知识截止日期的最新信息。

<instruction>
- 你应该优先一手来源(论文、官方文档),并用多个来源佐证关键主张
- 你必须在最终回复中为引用的来源包含链接
- 绝不用它获取可编程访问的内容或你已知 URL 的内容(GitHub 仓库/issue、已知的 arXiv 论文、维基百科页面、官方文档)——直接 `read` 该 URL
- `query` 在每个提供商上都支持 Google 风格指令:`site:`/`-site:`、`after:`/`before:`(`YYYY-MM-DD`)、`inurl:`、`intitle:`、`filetype:`、`"exact phrase"`、`-term`、`OR`。约束在可用时映射到原生提供商过滤器;否则结果会被宽松过滤——匹配不到任何内容的约束会被放宽并报告,而不是返回零结果。
</instruction>
