# 面向用户的包

本页收录仅在 README 中介绍、且需要在包本地 README/清单之外获得根文档覆盖的面向用户的包 CLI 与功能。

## 根文档策略

- **收录**用户可以直接运行或通过 `omp` 运行的包本地 CLI、扩展功能、仪表板与基准运行器的根文档覆盖。
- 当包/crate 仅为内部实现时**明确排除**;指向拥有它的架构文档。
- 包 README 与清单仍是包本地设置与标志的权威来源;根文档让功能可被发现,并链接到确切的源码路径。
- 内部 Rust crates 仍由原生架构文档覆盖,除非被提升为独立的面向用户命令或 API。面向贡献者的地图位于 [`native-crates.md`](./native-crates.md);目前每个 `crates/*` 条目都是 `@oh-my-pi/pi-natives` 与内嵌 shell 的内部内容,因此由 [`natives-architecture.md`](./natives-architecture.md) 及周边的原生文档负责。

## 包 CLI 与功能

### `python/robomp` —— 自托管 GitHub 分诊与修复服务

Sources: [`python/robomp/README.md`](../python/robomp/README.md), [`python/robomp/pyproject.toml`](../python/robomp/pyproject.toml), [`python/robomp/.env.example`](../python/robomp/.env.example), [`python/robomp/docker-compose.yml`](../python/robomp/docker-compose.yml).

- Python 包:`robomp`(Python 3.11 或更新);可执行文件:`robomp`,带 `serve`、`triage`、`replay`、`status` 与 `cleanup` 命令。
- 功能:自托管服务,接收白名单仓库的 GitHub webhook,对 issue 分类,为每个 issue 恢复一个 `omp --mode rpc` 会话,评论或开启修复 PR,并处理后续的 issue 与 PR 对话。
- 仪表板/API:FastAPI 在 `/` 提供操作员仪表板,以及健康、事件、issue 与重放端点。捆绑的 Compose 部署将其发布在 `http://localhost:6543/`;`bun run robomp:web:dev` 以开发模式运行仪表板前端,`bun run robomp:web:build` 重建其静态包。
- 输入/存储:配置来自 `python/robomp/.env` 与挂载的 `~/.omp/agent/models.container.yml`;GitHub webhook 事件送入 SQLite 支持的队列。Compose 部署将数据库、按 issue 的工作树、会话转录与日志持久化在 `/data` 下的 `robomp_data` 卷中。
- 根命令:`bun run robomp:install` 为主机开发安装 Python 包;`bun run robomp:serve` 在主机上运行它;`bun run robomp:build`/`bun run robomp:rebuild`、`bun run robomp:up`、`bun run robomp:down`、`bun run robomp:restart`、`bun run robomp:logs`、`bun run robomp:dev` 与 `bun run robomp:reset` 管理容器部署。
- 前置条件:Docker Compose v2、主机可达的 LiteLLM 风格模型代理、容器模型配置、GitHub webhook 端点,以及对每个白名单仓库具有写权限的机器人 PAT。默认的双容器部署将 PAT 保存在经 HMAC 认证的 `gh-proxy` 边车中,而非编排器中。

### `packages/swarm-extension` —— swarm 编排

Sources: [`packages/swarm-extension/README.md`](../packages/swarm-extension/README.md), [`packages/swarm-extension/package.json`](../packages/swarm-extension/package.json), [`packages/swarm-extension/src/cli.ts`](../packages/swarm-extension/src/cli.ts), [`packages/swarm-extension/src/extension.ts`](../packages/swarm-extension/src/extension.ts).

- 包:`@oh-my-pi/swarm-extension`;可执行文件:`omp-swarm`。
- 功能:基于 YAML swarm 的多 Agent DAG 编排,支持 `pipeline`、`parallel` 与 `sequential` 模式。
- 独立 CLI:`omp-swarm path/to/swarm.yaml` 运行至完成或进程终止。
- TUI 扩展模式:将包路径添加到 `extensions`,然后使用 `/swarm run <file.yaml>`、`/swarm status <name>` 或 `/swarm help`。
- 输入:顶层 `swarm` 下的 YAML,含 `name`、`workspace`、`mode`,可选的 `target_count`/`model`,以及带 `role`、`task`、可选 `model`、`waits_for` 与 `reports_to` 的 `agents`。
- 副作用/输出:在需要时创建工作区,并将状态/日志持久化在 `<workspace>/.swarm_<name>/` 下。
- 限制/错误:在执行前验证 YAML 定义、依赖图与环;独立运行没有内置超时。

### `packages/stats` —— 本地用量仪表板

Sources: [`packages/stats/README.md`](../packages/stats/README.md), [`packages/stats/package.json`](../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts).

- 包:`@oh-my-pi/omp-stats`;可执行文件:`omp-stats`;主要用户路径:`omp stats`。
- 功能:基于会话 JSONL 日志的 AI 用量统计本地可观测性仪表板。
- CLI 模式:`omp stats` 启动仪表板服务器,打开 `http://localhost:3847` 并持续运行;`omp stats --port <port>` 更改端口;`omp stats --summary` 打印控制台摘要;`omp stats --json` 打印 JSON 并退出。
- 编程 API:导出 `syncAllSessions()` 与 `getDashboardStats()` 等辅助函数供嵌入使用。
- 输入/存储:读取 `~/.omp/agent/sessions/`;将聚合存储在 `~/.omp/stats.db` 中。
- 输出:仪表板指标与 API 端点,包括 `/api/stats`、`/api/stats/models`、`/api/stats/folders`、`/api/stats/timeseries` 与 `/api/sync`。
- 副作用/限制:输出前同步会话文件;长时间运行的仪表板在 `Ctrl+C` 时停止并关闭统计数据库。

### `packages/omptype` —— schema 验证库

Sources: [`packages/omptype/README.md`](../packages/omptype/README.md), [`packages/omptype/package.json`](../packages/omptype/package.json), and the repository [omptype authoring guide](./omptype-guide.md).

- 包:公开的 `@oh-my-pi/omptype`;用 `bun add @oh-my-pi/omptype` 安装;需要 Bun 1.3.14 或更新。
- 功能:可调用的 ArkType 兼容 schema,具有廉价的解释型启动、惰性热路径编译、验证错误、默认值与 morph,以及 JSON Schema 输出。
- 公开表面:`@oh-my-pi/omptype` 用于原生编写,`@oh-my-pi/omptype/typebox` 与 `/zod` 用于兼容性构建器,`/ark` 用于无别名的 ArkType 兼容门面。
- 运行时行为:schema 调用返回验证后的值或 `type.errors`;`.assert()` 返回值或抛出;`.allows()` 执行布尔检查。
- 限制:这是刻意聚焦的兼容表面,而非 ArkType、TypeBox 或 Zod 每个 API 的完整实现。

### `packages/typescript-edit-benchmark` —— TypeScript 编辑夹具引擎

Sources: [`packages/typescript-edit-benchmark/package.json`](../packages/typescript-edit-benchmark/package.json), [`packages/typescript-edit-benchmark/src/generate.ts`](../packages/typescript-edit-benchmark/src/generate.ts), [`packages/typescript-edit-benchmark/src/tasks.ts`](../packages/typescript-edit-benchmark/src/tasks.ts), [`packages/typescript-edit-benchmark/src/verify.ts`](../packages/typescript-edit-benchmark/src/verify.ts), and the runner in [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts).

- 包:私有的 `@oh-my-pi/typescript-edit-benchmark`;无独立可执行文件的支撑库。
- 功能:生成、加载、格式化并验证由 metaharness 编辑适配器消费的 TypeScript 变更夹具。
- 夹具生成:从仓库根目录运行 `bun packages/typescript-edit-benchmark/src/generate.ts --typescript-dir <path> [generator options]`。
- 基准执行:`bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [options]`,或从 metaharness 仪表板/API 启动 `edit` 运行。
- 运行器输入包括提供商/模型、思考级别、每任务运行次数、超时、并发、任务 ID、夹具目录或 `.tar.gz`、编辑策略、引导模式、重试/轮次限制、输出路径/格式,以及夹具验证/列出标志。
- 夹具包含任务元数据、提示词、输入文件与预期文件。运行器将每个夹具复制到隔离的工作树,记录可选的对话转储,并写入 Markdown 或 JSON 结果。

### `packages/metaharness` —— 统一基准管理器

Sources: [`packages/metaharness/README.md`](../packages/metaharness/README.md), [`packages/metaharness/package.json`](../packages/metaharness/package.json), [`packages/metaharness/src/server.ts`](../packages/metaharness/src/server.ts), [`packages/metaharness/src/runner.ts`](../packages/metaharness/src/runner.ts), and [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts).

- 包:私有的 `@oh-my-pi/pi-metaharness`;可执行文件:`metaharness`。
- 功能:一个仪表板、SQLite 存储、REST/SSE API,以及针对 Harbor 数据集(默认 `terminal-bench@2.0`)、TypeScript 编辑与 SnapCompact 基准的规范化实验 → 运行 → 跟踪模型。
- 仪表板/API:`bun run --cwd packages/metaharness serve -- --port 4700`;启动表单与 `POST /api/runs` 支持全部三个基准适配器。
- 直接运行器:`bun packages/metaharness/src/runner.ts --model <provider/model> [Harbor options]` 与 `bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [edit options]`。
- Harbor 源码模式绑定挂载仓库与缓存的 Linux 依赖树,而提供商凭据保留在认证网关之后的主机上。本地 tarball、已发布包与预构建二进制安装模式也可用。
- 存储:规范化状态位于 `<jobs-dir>/_manager/metaharness.sqlite` 下;基准原生产物仍是文件系统权威来源,历史运行会被自动发现。
- 输出包括 Harbor 试验目录、`_bench/<jobName>/report.md`、每次运行的日志、编辑报告、规范化跟踪、仪表板指标与 REST/SSE 更新。
- 限制:删除实验或运行也会删除其作业目录,且在目标运行中会被拒绝。Harbor 需要 Docker 或 Apple Container 加 Harbor CLI;后端特定的网络与挂载约束记录在包 README 中。

### `packages/browser-relay` —— 驱动现有的 Chrome 标签页

Sources: [`packages/browser-relay/README.md`](../packages/browser-relay/README.md), [`packages/browser-relay/package.json`](../packages/browser-relay/package.json), [`packages/coding-agent/src/tools/browser/relay/`](../packages/coding-agent/src/tools/browser/relay/).

- 包:私有的 `@oh-my-pi/browser-relay`;用户命令:`omp browser-relay`。
- 设置:运行 `omp browser-relay install`,从 `~/.omp/browser-relay/extension` 加载未打包的扩展,然后设置 `browser.relay` 或使用 `app.relay: true`。
- 行为:中继通过全局守护进程代理自动启动;`app.target` 按 URL/标题子串选择标签页,否则采用可见标签页。
- 安全/限制:它绑定回环;当本地进程不受信任时使用 `--token`。Chrome 内部页面、DevTools、Web Store、扩展页面以及打开 DevTools 的标签页无法附加。

### `packages/collab-web` —— 协作会话的浏览器客户端

Sources: [`packages/collab-web/README.md`](../packages/collab-web/README.md), [`packages/collab-web/package.json`](../packages/collab-web/package.json), [`docs/collab.md`](./collab.md).

- 包:私有的 `@oh-my-pi/collab-web`;生产客户端:<https://my.omp.sh/>。
- 功能:`/collab` 会话的浏览器访客 UI,包括流式转录、工具卡片、子 Agent 视图、提示词与主机中断。
- 本地路径:`bun run dev` 在 3000 端口提供 UI;`bun run mock-host` 运行离线中继与脚本化主机;`bun run build` 在 `dist/` 下生成静态 SPA。
- 约束:非本地部署需要 HTTPS 与可达的安全 WebSocket 中继。房间密钥保留在 URL 片段中,不会发送到中继。

### `packages/snapcompact` —— 位图上下文压缩 API

Sources: [`packages/snapcompact/README.md`](../packages/snapcompact/README.md), [`packages/snapcompact/package.json`](../packages/snapcompact/package.json), [`packages/snapcompact/src/index.ts`](../packages/snapcompact/src/index.ts).

- 包:公开的 `@oh-my-pi/snapcompact`;用 `bun add @oh-my-pi/snapcompact` 安装;需要 Bun 1.3.14 或更新。
- 功能:将丢弃的对话历史进行确定性本地序列化与 PNG 渲染,用于视觉模型上下文压缩;无需模型调用或 API 密钥。
- 公开入口包括 `compact`、`render`、`renderMany`、`frames`、形状选择、文本规范化/序列化、图像预算与文件操作辅助函数。
- 运行时约束:栅格化与 PNG 编码需要 `@oh-my-pi/pi-natives`。

### `packages/mnemopi` —— 独立的本地记忆 CLI

Sources: [`packages/mnemopi/README.md`](../packages/mnemopi/README.md), [`packages/mnemopi/package.json`](../packages/mnemopi/package.json), [`packages/mnemopi/src/cli.ts`](../packages/mnemopi/src/cli.ts), and the coding-agent [Mnemopi memory backend guide](./mnemosyne-memory-backend.md).

- 包:公开的 `@oh-my-pi/pi-mnemopi`;可执行文件:`mnemopi`;需要 Bun 1.3.14 或更新。用 `bun add --global @oh-my-pi/pi-mnemopi` 全局安装,然后运行 `mnemopi <command>`。在源码检出中,`bun packages/mnemopi/src/cli.ts <command>` 运行同一入口。
- 存储与搜索:`store`/`remember`、`recall`/`search`、`update`/`edit` 与 `delete`/`forget`。
- 检查与维护:`stats`、`sleep`/`consolidate`、`diagnose`/`doctor`、JSON `export` 与 `import`、带 `read`、`write` 或 `clear` 的 `scratchpad`/`sp`,以及带 `list`、`create` 或 `delete` 的 `bank`。
- 集成:`mcp` 启动包的 MCP 服务器。独立 CLI 直接操作 Mnemopi 存储;当将记忆集成到 OMP 会话时,按后端指南所述改用 `memory.backend: mnemopi`。
- 发现与错误:`mnemopi --help` 列出主要命令形式。未知命令与无效参数打印简洁错误并返回非零退出码。
