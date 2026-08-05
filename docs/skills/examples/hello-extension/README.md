# hello-extension

一个最小的 `oh-my-pi` 扩展,演示两种最常见的编写模式:订阅 `session_start` 在加载时发送通知,以及注册一个向对话发送问候语的 `/hello` 斜杠命令。它刻意保持精简——可作为你自己扩展的复制粘贴起点。

## 安装

**方式 A — 放入用户扩展目录:**

```
cp -r . ~/.omp/agent/extensions/hello-extension
```

重启 `omp`。你会立即看到启动通知。

使用 `omp --profile <name>` 时,改用 `~/.omp/profiles/<name>/agent/extensions/hello-extension`。`PI_CODING_AGENT_DIR` 同样会改变 agent 目录。

**方式 B — 在设置中把 `extensions` 数组指向它:**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**方式 C — 通过 CLI 标志临时加载:**

```
omp --extension ./hello-extension
```

## 用法

加载后,在 omp 提示符中输入 `/hello` 或 `/hello Ada`。该命令会向对话发送一条可见的问候自定义消息,并显示“Message sent!”通知。

## 它演示了什么

- 接收 `ExtensionAPI` 的默认导出工厂
- `pi.on("session_start", ...)` — 会话生命周期钩子
- `pi.registerCommand(...)` — 斜杠命令注册
- `ctx.ui.notify(...)` — 面向用户的通知
- `package.json` 中的 `omp.extensions` 清单字段
