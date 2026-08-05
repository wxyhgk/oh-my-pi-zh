# safety-hook

一个演示 `tool_call` 拦截的 `oh-my-pi` 扩展。它会拦截 `bash` 工具调用,当命令以普通空白包含 `rm -rf /` 时返回 `{ block: true, reason: "..." }`,阻止工具执行。

## 它演示了什么

- `pi.on("tool_call", ...)` — 执行前拦截
- `return { block: true, reason: "..." }` — 拦截契约
- 对 bash 输入的正则防护(`/\brm\s+-rf\s+\//`)

## 安装

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

重启 `omp`。该钩子对所有会话生效。

或者临时加载:

```
omp --extension ./safety-hook
```

## 工作原理

```
LLM 调用 bash 工具
       │
       ▼
运行 tool_call 处理器
       │
       ├─ 命令匹配 /\brm\s+-rf\s+\// ?
       │       是 → { block: true, reason: "..." }  ←  执行停止,reason 发送给 LLM
       │       否 → undefined                        ←  正常继续执行
       ▼
工具执行(若未被拦截)
```

`reason` 文本就是 LLM 收到的工具错误,因此它能理解调用被拒绝的原因并尝试其他方法。
