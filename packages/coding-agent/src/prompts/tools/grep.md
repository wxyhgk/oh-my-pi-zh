用 Rust 正则加 PCRE2 回退搜索文件和内部 URL。

<instruction>
- 把 `path` 限定到已知的文件、目录、glob 或内部 URL;多个根用 `;` 分隔。
- 宽泛搜索可能超时;窄范围限定,或先用 `glob`。
- 单文件行选择器:`src/foo.ts:50-100`(选择器绝不选择搜索根)。
- 字面 `\n` 或 `\\n` 启用跨行模式。
</instruction>

<critical>
- 必须用它替代 shell `grep`/`rg`。
- 开放式多轮搜索必须用{{#if scoutAvailable}}Task + scout,{{else}}Task,{{/if}}而不是链式调用。
</critical>
