# @oh-my-pi/pi-coding-agent

`oh-my-pi` monorepo 中 `omp` 编码 Agent 的核心实现包。

安装、设置、提供商配置、模型角色、斜杠命令与完整 CLI 参考,见:
- [Monorepo README(本地)](../../README.md)
- [Monorepo README(GitHub)](https://github.com/can1357/oh-my-pi#readme)

包专属参考:
- [CHANGELOG](./CHANGELOG.md)
- [MCP 配置指南](../../docs/mcp-config.md)
- [MCP 运行时生命周期](../../docs/mcp-runtime-lifecycle.md)
- [MCP 服务器/工具编写](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## 记忆后端

Agent 支持三种互斥的记忆后端,通过 `memory.backend` 设置选择(设置 → 记忆 标签页,或 `~/.omp/config.yml`):

- `off`(默认)— 不运行任何记忆子系统。
- `local` — 现有的展开-总结管线;在 agent 目录下写入 `memory_summary.md` 与合并后的产物。
- `hindsight` — 连接 [Hindsight](https://hindsight.vectorize.io) 服务器(云或自托管 Docker),每第 N 个用户轮次保留转录,在会话的第一轮回忆记忆,并暴露 `retain`、`recall` 与 `reflect`。

### Hindsight 快速上手

1. 运行一个 Hindsight 服务器(云或 `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`)。
2. 设置 `memory.backend = "hindsight"` 与 `hindsight.apiUrl = "http://localhost:8888"`(或你的云 URL)。
3. 可选的环境变量覆盖(env 优先于设置):
   - `HINDSIGHT_API_URL`、`HINDSIGHT_API_TOKEN` — 连接
   - `HINDSIGHT_BANK_ID`、`HINDSIGHT_DYNAMIC_BANK_ID`、`HINDSIGHT_AGENT_NAME` — bank 寻址
   - `HINDSIGHT_AUTO_RECALL`、`HINDSIGHT_AUTO_RETAIN`、`HINDSIGHT_RETAIN_MODE` — 生命周期
   - `HINDSIGHT_RECALL_BUDGET`、`HINDSIGHT_RECALL_MAX_TOKENS` — 回忆规模
   - `HINDSIGHT_BANK_MISSION`、`HINDSIGHT_DEBUG`

会话中途切换后端会立即替换活跃的后端、记忆工具、监听器与系统提示词上下文。已有用户若设置了 `memories.enabled = true|false`,会在首次启动时一次性迁移到 `memory.backend = "local"|"off"`;此后,`memory.backend` 是唯一的运行时选择器。
