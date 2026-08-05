# 自主记忆

Oh My Pi 支持四种记忆模式。记忆默认禁用；通过 `/settings` 或 `config.yml` 选择一种后端：

| `memory.backend` | 存储与行为                                                   | 指南                                                   |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `off`            | 无记忆后端                                                    | —                                                      |
| `local`          | 由持久化会话生成的项目级摘要与经验                            | 本页                                                   |
| `hindsight`      | 远程、银行作用域的 Hindsight 记忆                             | [Hindsight](#hindsight-remote-backend)                 |
| `mnemopi`        | 本地 Mnemopi SQLite 记忆                                      | [Mnemopi 记忆后端](./mnemosyne-memory-backend.md)      |

启用本地摘要流水线：

```yaml
memory:
  backend: local
```

## 用法

### 注入内容

会话启动时，如果当前项目存在合并摘要或手动捕获的经验，则会作为 **Memory Guidance（记忆指引）** 块注入系统提示词。摘要与经验共用 `memories.summaryInjectionTokenLimit`。

- 将记忆视为启发式上下文——有助于了解流程与先前的决策，但不能作为当前仓库状态的权威依据。
- 当记忆改变计划时，引用记忆产物路径，并在行动前结合当前仓库证据。
- 当记忆与仓库状态、用户指令冲突时，优先仓库状态与用户指令；将冲突的记忆视为过期数据。

### 读取记忆产物

Agent 可以使用 `read` 工具直接通过 `memory://` URL 读取记忆文件：

| URL                                    | 内容                              |
| -------------------------------------- | --------------------------------- |
| `memory://root`                        | 启动时注入的紧凑摘要               |
| `memory://root/MEMORY.md`              | 完整长期记忆文档                   |
| `memory://root/learned.md`             | 由 `learn` 工具捕获的经验          |
| `memory://root/skills/<name>/SKILL.md` | 生成的技能手册                     |

### `/memory` 斜杠命令

| 子命令            | 作用                                                    |
| ----------------- | ------------------------------------------------------- |
| `view`            | 显示当前后端的注入负载                                   |
| `stats`           | 显示后端特定的记忆统计（受支持时）                       |
| `diagnose`        | 显示后端特定的诊断信息（受支持时）                       |
| `clear` / `reset` | 删除活动后端的记忆数据/产物                              |
| `enqueue` / `rebuild` | 强制活动后端执行合并/保留工作                        |

### 捕获经验

启用 `autolearn.enabled` 以使 `learn` 工具可用：

```yaml
autolearn:
  enabled: true
```

本地后端激活时，`learn` 将显式的持久经验保存到项目的 `learned.md`。经验按最新优先排列、去重、脱敏，上限 100 条，并自下一个会话起注入；`learn` 调用不会改变活动会话的提示词缓存前缀。每条经验的内容上限为 2,000 字符，可选上下文上限为 400 字符。本地后端不提供结构化记忆搜索、`recall`、`retain`、`reflect` 和 `memory_edit`。

## 工作原理

本地摘要记忆由启动时运行的后台流水线构建；`/memory enqueue` 标记合并工作，由下一次启动接管。子代理以及未持久化到会话文件的会话会跳过该流水线。

**阶段 1 — 逐会话提取：** 对每个自上次处理后发生变化的过往会话，模型读取会话历史并提取持久信号：技术决策、约束、已解决的失败、重复出现的工作流。过新、过旧、当前活动、或超出配置的扫描/期限限制的会话会被跳过。每次提取为该会话生成一个原始记忆块和一段简短概要。

**阶段 2 — 合并：** 提取之后，第二轮模型处理读取所有逐会话提取结果，生成三个写入磁盘的输出：

- `MEMORY.md` — 经整理的长期记忆文档
- `memory_summary.md` — 会话启动时注入的紧凑文本
- `skills/` — 可复用的程序性手册，各自位于独立子目录

单独维护的 `learned.md` 不会被合并覆盖。

阶段 2 使用租约（lease）与心跳（heartbeat）机制，防止多个进程同时启动时重复运行。先前运行留下的过期技能目录会被自动清理。

合并输出在写入 `MEMORY.md`、`memory_summary.md` 或生成的技能之前，会针对常见密钥/令牌模式进行脱敏。

### 提取行为

记忆提取与合并行为由 `packages/coding-agent/src/prompts/memories/` 中的静态提示词文件驱动。

| 文件                      | 用途                                         | 变量                                           |
| ------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `stage_one_system.md`     | 逐会话提取的系统提示词                        | —                                              |
| `stage_one_input.md`      | 包装会话内容的用户轮次模板                    | `{{thread_id}}`, `{{response_items_json}}`     |
| `consolidation_system.md` | 跨会话合并的系统提示词                        | —                                              |
| `consolidation.md`        | 跨会话合并的用户轮次提示词                    | `{{raw_memories}}`, `{{rollout_summaries}}`    |
| `read-path.md`            | 注入实时会话的记忆指引                        | `{{memory_summary}}`, `{{learned}}`            |

### 模型选择

记忆复用模型角色系统。

| 阶段                   | 角色                                                                | 用途                          |
| ---------------------- | ------------------------------------------------------------------- | ----------------------------- |
| 阶段 1（提取）         | `default`                                                           | 逐会话知识提取                |
| 阶段 2（合并）         | `smol`（回退到 `default`，再到当前/注册表中的首个模型）             | 跨会话综合                    |

如果请求的记忆角色未配置，记忆模型解析会回退到 `default` 角色，然后是活动会话模型，最后是注册表中的第一个模型。

## 配置

| 设置                               | 默认值 | 描述                                                                                                                              |
| ---------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                   | `off`  | 选择 `local` 以启用此流水线；未显式设置后端时，旧版 `memories.enabled: true` 会迁移为 `memory.backend: local`                     |
| `memories.maxRolloutAgeDays`       | `30`   | 早于该期限的会话不处理                                                                                                            |
| `memories.minRolloutIdleHours`     | `12`   | 更近期处于活动的会话会被跳过                                                                                                      |
| `memories.maxRolloutsPerStartup`   | `64`   | 单次启动处理的会话数上限                                                                                                          |
| `memories.threadScanLimit`         | `300`  | 启动时扫描的最近会话记录数上限                                                                                                    |
| `memories.maxRawMemoriesForGlobal` | `200`  | 提供给全局合并的逐会话提取结果数上限                                                                                              |
| `memories.stage1Concurrency`       | `8`    | 并发的逐会话提取任务数                                                                                                            |
| `memories.stage1LeaseSeconds`      | `120`  | 提取任务租约时长                                                                                                                  |
| `memories.stage1RetryDelaySeconds` | `120`  | 失败的提取可重新认领前的延迟                                                                                                      |
| `memories.phase2LeaseSeconds`      | `180`  | 合并租约时长                                                                                                                      |
| `memories.phase2RetryDelaySeconds` | `180`  | 失败的合并重试前的延迟                                                                                                            |
| `memories.phase2HeartbeatSeconds`  | `30`   | 合并租约心跳间隔                                                                                                                  |
| `memories.rolloutPayloadPercent`   | `0.7`  | 所选模型上下文预算中可供 rollout 负载使用的比例                                                                                   |
| `memories.phase1InputTokenLimit`   | `4000` | 逐会话提取的输入上限                                                                                                              |
| `memories.fallbackTokenLimit`      | `16000`| 模型未声明有限上下文窗口时使用的 token 预算                                                                                       |
| `memories.summaryInjectionTokenLimit` | `5000` | 注入系统提示词的摘要与捕获经验的近似共用 token 上限                                                                             |

## Hindsight 远程后端

Hindsight 需要一个可达的 [Hindsight](https://hindsight.vectorize.io/) 服务器。默认端点为 `http://localhost:8888`；服务器要求认证时设置一个 token：

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` 环境变量覆盖 `hindsight.*` 设置，后者再覆盖内置默认值。全部 18 个受支持的覆盖项、可接受值、解析规则、优先级与默认值见[完整 Hindsight 环境变量表](./environment-variables.md#hindsight-memory-backend)。

默认情况下，Hindsight 使用 `per-project-tagged` 作用域：写入进入带项目标签的共享银行，而召回同时包含带项目标签与不带标签的全局记忆。`per-project` 将每个工作目录项目隔离在自己的银行中；`global` 使用一个共享银行。显式设置 `hindsight.bankId` 可选择银行基座。银行 ID、前缀或作用域的变更会重建主会话状态，使后续操作使用新作用域。

主会话在其第一个模型轮次召回（`hindsight.autoRecall: true`），默认每三个用户轮次自动保留已完成的对话轮次。`/memory enqueue` 刷新排队的工具保留并强制保留当前会话。Agent 结束时，主状态按节奏安排保留并刷新保留队列；会话销毁会在释放状态前排空该队列。请求失败与配置的超时会被记录，且不会影响编码会话可用性。子代理对显式的 `recall`、`retain` 和 `reflect` 调用复用父级的客户端、银行与作用域，但不会运行自己的自动召回或保留。

召回作为后台上下文（而非指令）注入，召回的记忆在压缩期间也可作为额外上下文使用。选择 Hindsight 会暴露 `recall`、`retain` 和 `reflect`；`memory_edit` 不可用，因为上游 Hindsight 记忆不通过此后端编辑。

`/memory view`、`/memory stats`、`/memory diagnose` 和 `/memory enqueue` 通过活动的 Hindsight 状态运行。`/memory clear` 首先排空待处理的保留，然后仅清除本地会话状态与召回缓存。它**不会删除服务器端银行**；请使用 Hindsight UI 或 API 删除该银行。

## 关键文件

- `packages/coding-agent/src/memories/index.ts` — 流水线编排、注入、clear/enqueue 入口（`/memory` 命令经 `packages/coding-agent/src/memory-backend/local-backend.ts` 路由到这里）
- `packages/coding-agent/src/memories/storage.ts` — 基于 SQLite 的任务队列与线程注册表
- `packages/coding-agent/src/prompts/memories/` — 记忆提示词模板
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL 处理器
