在持久 shell 中运行命令。

只用于一个二进制或一条计算事实的短管道(`wc -l`、`sort | uniq -c`、`diff`)。
{{#if hasEval}}内联脚本、heredoc、`$(…)`、复杂控制流/引号和非平凡管道 → `eval`。{{else}}内联脚本、heredoc、`$(…)` 和复杂控制流 → 用专门的工具或已入库的脚本。{{/if}}

<instruction>
- 设置 `cwd` 而不是 `cd`;多行/重引号值用 `env: { NAME: "…" }`。
- `pty: true` 只用于终端交互(`sudo`、`ssh`)。
- 有顺序依赖的命令在同一次调用中用 `&&`;独立调用可以并发运行。
- 内部 URL(`skill://`、`agent://` 等)会自动解析为路径。
{{#if hasShellBuiltins}}- 可用的辅助工具:mkdir、wc、sort、comm、diff、uniq、base64、cmp、md5sum、sha{1,224,256,384,512}sum、b2sum、basename、dirname、readlink、realpath、touch、stat、date、mktemp、seq、yes、printenv、truncate、tac、nproc、uname、whoami、hostname、which、ps、pgrep、pkill、pidwait、top、cut、tee、tr、paste、sed、xargs、jq、rm、mv、ln、ts、sponge、ifne、isutf8、combine{{#unless isWindows}}、errno{{/unless}}{{/if}}
{{#if asyncEnabled}}- `async: true` 会推迟有限命令的结果;它不会延长 `timeout`。{{/if}}
</instruction>

<critical>
{{#if hasGrep}}- 绝不使用 shell `grep`/`rg`;使用内置 `grep`。{{/if}}
{{#if hasRead}}{{#if hasGlob}}- 用 `read` 列目录,用 `glob` 找路径;绝不使用 `ls`/`find`。{{/if}}{{/if}}
- 避免 `head`、`tail` 和重定向:输出会被捕获、截断,并链接为 `artifact://<id>`。
{{#if hasLaunch}}- 服务、监视器、调试器和 REPL 必须使用 `hub`(`op:"start"`)。{{/if}}
</critical>

{{#if autoBackgroundEnabled}}长时间的前台调用可能会自动转入后台并在之后交付。需要内联?提高 `timeout`。{{/if}}
没有截断页脚意味着显示的输出是完整的。
