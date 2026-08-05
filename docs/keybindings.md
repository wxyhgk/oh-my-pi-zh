# 快捷键

在 `omp` 会话中运行 `/hotkeys` 可查看当前构建的活跃按键组合。该列表反映从磁盘加载的任何重映射以及扩展添加的任何绑定。

## 自定义快捷键

用户重映射位于 `~/.omp/agent/keybindings.yml`。该文件是一个 YAML 映射,键为快捷键 action ID,值为单个组合键字符串或组合键字符串数组。它不会从 `~/.omp/agent/config.yml` 读取,也没有嵌套的 `keybindings` 对象。

使用命名配置文件时,首先加载默认配置文件 Agent 目录中的绑定,然后活跃配置文件的 `keybindings.yml` 逐 action 覆盖它们。继承的文件在该配置文件的启动期间是只读的。

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
```

组合键名称大小写不敏感,并使用 UI 中显示的相同记法,例如 `Ctrl+P`、`Alt+Shift+P`、`Shift+Enter` 和 `Ctrl+Backspace`。

将 action 设置为空数组以禁用它:

```yaml
app.history.search: []
```

## 常用 action ID

| Action ID                    | 默认值                                                               | 含义                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.model.cycleForward`     | `Ctrl+P`                                                              | 向前循环角色模型                                                                                                                                                            |
| `app.model.cycleBackward`    | `Shift+Ctrl+P`                                                        | 向后循环角色模型                                                                                                                                                           |
| `app.model.selectTemporary`  | `Alt+P`                                                               | 为本次会话临时选择模型                                                                                                                                            |
| `app.model.select`           | `Alt+M`                                                               | 打开模型选择器并设置角色                                                                                                                                                |
| `app.plan.toggle`            | `Alt+Shift+P`                                                         | 切换计划模式                                                                                                                                                                     |
| `app.history.search`         | `Ctrl+R`                                                              | 搜索提示词历史                                                                                                                                                                |
| `app.tools.expand`           | `Ctrl+O`                                                              | 切换工具输出展开                                                                                                                                                         |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O`                                                        | 显示或隐藏工具活动                                                                                                                                                           |
| `app.thinking.toggle`        | `Ctrl+T`                                                              | 切换思考块可见性                                                                                                                                                     |
| `app.thinking.cycle`         | `Shift+Tab`                                                           | 循环思考层级                                                                                                                                                                 |
| `app.editor.external`        | `Ctrl+G`                                                              | 在 `$VISUAL` / `$EDITOR` 中编辑草稿                                                                                                                                              |
| `app.message.followUp`       | `Ctrl+Q`, `Ctrl+Enter`                                                | 排队一条后续消息                                                                                                                                                            |
| `app.message.dequeue`        | `Alt+Up`, `Shift+Up`                                                  | 将排队的消息取回编辑器                                                                                                                                        |
| `app.retry`                  | `Alt+R`                                                               | 重试最后失败的助手轮次                                                                                                                                                 |
| `app.display.reset`          | `Alt+L`                                                               | 重置终端显示                                                                                                                                                               |
| `app.clipboard.copyLine`     | `Alt+Shift+L`                                                         | 复制当前行                                                                                                                                                                |
| `app.clipboard.copyPrompt`   | `Alt+Shift+C`                                                         | 复制整个提示词                                                                                                                                                                |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`, `Alt+Shift+V`                                         | 粘贴剪贴板文本而不折叠它                                                                                                                                           |
| `app.clipboard.pasteImage`   | Linux: `Ctrl+V`;macOS: `Ctrl+V`, `Cmd+V`;Windows: `Ctrl+V`, `Alt+V` | 从剪贴板粘贴(图像优先,文本回退)                                                                                                                            |
| `app.stt.toggle`             | 未绑定(按住 `Space`)                                                | 切换语音转文本。默认没有按键组合 — 按住空格录制(按住说话)并释放转写;可在此绑定组合键作为按一下切换的替代方案 |
| `app.live.toggle`            | `Ctrl+L`                                                              | 开始或停止实时语音模式(与 `/live` 相同)                                                                                                                                      |
| `app.agents.hub`             | `Alt+A`                                                               | 打开 Agent 中心                                                                                                                                                                   |

在 Windows Terminal 中,`Ctrl+V` 可能在 `omp` 看到它之前就被终端粘贴命令处理;当剪贴板图像粘贴似乎无效时,使用 `Alt+V` 回退。当剪贴板不包含图像时,`app.clipboard.pasteImage` 会粘贴剪贴板文本,因此只投递该组合键的主机(VS Code 集成终端配置为转发 `Ctrl+V` 时、通过 `Win+V` 的 Windows 剪贴板历史)两种载荷都可用。Windows Terminal 还会吞掉 `Ctrl+Enter`,因此 `app.message.followUp` 组合键也绑定 `Ctrl+Q` — 与 GitHub Copilot CLI 使用的相同组合键 — 同一组合键还提交 Agent 仪表板的新 Agent 描述和钩子编辑器提示。如果你现有的 `keybindings.yml` 已将 `Ctrl+Q` 分配给其他 action,该用户重映射优先,follow-up 保留 `Ctrl+Enter`,除非你显式绑定 `app.message.followUp`。

实现 OSC 5522 增强粘贴的终端可以直接向 `omp` 发送剪贴板 MIME 数据;图像粘贴以 `[Image #N]` 附加,而 text/plain 粘贴事件保持正常粘贴行为。当 OSC 5522 不可用时,带括号粘贴仍处理文本,并且当文件可从 `omp` 主机读取时,粘贴的单个图像文件路径会作为图像加载。

旧的未限定 action 名称会在加载 `keybindings.yml` 时迁移,但新文档和新配置应使用上面的命名空间 action ID。现有的 `keybindings.json` 文件仍被接受并迁移到 `keybindings.yml`;`keybindings.yaml` 也被接受。
