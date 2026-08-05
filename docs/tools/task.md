# task

> 生成子 Agent——每次调用一个,或每次调用一个 `tasks[]` 批次(`task.batch`,默认开启)。当 `async.enabled=true` 时,普通生成在后台运行;否则调用会阻塞直到它们完成。执行模式按条目决定:自定义 Agent 类型声明了 `blocking: true` 的条目以内联方式运行,而同一调用中的非阻塞条目仍作为后台任务生成。目前没有内置 Agent 声明 `blocking: true`。

## 源码

- 入口:`packages/coding-agent/src/task/index.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/task.md`
- 主要协作者:
  - `packages/coding-agent/src/task/types.ts` — 动态 schema、进度/结果类型、输出上限。
  - `packages/coding-agent/src/task/discovery.ts` — 发现项目/用户/插件/内置 Agent。
  - `packages/coding-agent/src/task/agents.ts` — 内置 Agent 定义与 frontmatter 解析。
  - `packages/coding-agent/src/task/executor.ts` — 创建子会话、运行子 Agent、收集输出,并将已完成的会话交给生命周期管理器。
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — 已完成子 Agent 的空闲 TTL 停放与唤醒。
  - `packages/coding-agent/src/registry/agent-registry.ts` — 进程级全局 Agent 目录(`running | idle | parked | aborted`)。
  - `packages/coding-agent/src/async/job-manager.ts` — 后台任务注册、进度与结果投递。
  - `packages/coding-agent/src/task/parallel.ts` — 用于会话级并发上限的 `Semaphore`。
  - `@oh-my-pi/pi-natives` (`crates/pi-iso`) — 隔离 PAL:`isoResolve` / `isoStart` / `isoStop` 后端解析与回退。
  - `packages/coding-agent/src/task/worktree.ts` — 隔离模式映射(`parseIsolationMode`)与生命周期(`ensureIsolation`/`cleanupIsolation`)、补丁捕获、分支合并。
  - `packages/coding-agent/src/task/output-manager.ts` — 会话级的 `agent://` ID 分配。
  - `packages/coding-agent/src/task/name-generator.ts` — 默认的 AdjectiveNoun 风格 Agent ID。
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts` — 将 `agent://<id>` 解析为已保存的子 Agent 输出。
  - `packages/coding-agent/src/internal-urls/history-protocol.ts` — 将 `history://<id>` 解析为简洁记录。
  - `packages/coding-agent/src/tools/index.ts` — 工具注册与递归深度门控。
  - `packages/coding-agent/src/sdk.ts` — 子会话路由/工具接线与每个子 Agent 的 `AgentOutputManager`。
  - `docs/task-agent-discovery.md` — 更深入的发现与优先级说明。

## 输入

线格式 schema 由 `task.batch`(默认开启)决定形态。一个工作单元是任务条目 `{ name?, agent?, task, effort?, outputSchema?, schemaMode?, isolated? }`。仅当 `task.isolation.mode` 不是 `none` **且计划模式被禁用** 时,`isolated` 才存在;仅当 `task.enableEffort=true`(默认关闭)时,`effort` 才存在。

- **批次形态**(`task.batch` 开启):`{ context, tasks: item[] }` — 每个条目一个子 Agent,全部在相同的扇出规则下运行;没有顶层 Agent 字段。`context` 是**必填**的共享背景,渲染进每个生成的子 Agent 的系统提示词(`CONTEXT` 部分);`agent`、`outputSchema` 与 `schemaMode` 按条目设置。`effort` 仅在其设置启用时添加;`isolated` 还要求计划模式被禁用。
- **扁平形态**(`task.batch` 关闭):`{ ...item }` — 每次调用恰好一次生成。共享背景写入一个 `local://` 文件(例如 `local://ctx.md`),每个生成的 `task` 引用它;子 Agent 共享父级的 `local://` 根。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `context` | `string` | 是(批次) | 通过子 Agent 系统提示词前置到本次调用每次生成中的共享背景。当 `task.batch` 关闭时被拒绝。 |
| `tasks` | `array` | 是(批次) | 每个子 Agent 一个任务条目。提供的名称在本次调用内必须唯一(不区分大小写)。当 `task.batch` 关闭时被拒绝。 |
| `name` | `string` | 否 | 稳定的 Agent 名称——成为注册表/IRC ID。默认为生成的 AdjectiveNoun 名称。由 `AgentOutputManager` 按会话确保唯一。批次形态中是条目字段,扁平形态中是顶层字段。 |
| `agent` | `string` | 否 | 运行该条目的 Agent 类型(例如 `scout`)。默认为生成策略的默认 Agent(通常是 `task`);同一批次调用中的条目可以使用不同的 Agent 类型。批次形态中是条目字段,扁平形态中是顶层字段。 |
| `task` | `string` | 是 | 工作内容——完整、自包含的指令。去除首尾空白后为空会被拒绝。批次形态中是条目字段,扁平形态中是顶层字段。 |
| `effort` | `"lo" \| "med" \| "hi"` | 否 | 仅在 `task.enableEffort=true` 时出现。每次生成的思考力度,映射到已解析模型支持的范围内(其封顶的最低/中间/最高级别,例如 `high`/`xhigh`/`max`)。覆盖 Agent 的默认选择器,包括 `auto`;省略它则保留 Agent 配置的选择器——仅对配置为 `auto` 的 Agent(例如内置的 `task`)按提示词自动分类;`scout`/`sonic` 配置为 `medium`。批次形态中是条目字段,扁平形态中是顶层字段。 |
| `outputSchema` | JSON Schema(在粗粒度线格式验证层为 `object \| boolean \| string \| null`) | 否 | 调用特定的结构化输出契约。优先于 Agent frontmatter 的 `output` 与继承的父会话 schema。批次形态中是条目字段,扁平形态中是顶层字段。 |
| `schemaMode` | `"permissive" \| "strict"` | 否 | 生效输出 schema 的验证模式。覆盖父会话模式;默认为 `permissive`。批次形态中是条目字段,扁平形态中是顶层字段。 |
| `isolated` | `boolean` | 否 | 在隔离的工作区中运行并返回补丁。仅当 `task.isolation.mode` 不是 `none` 且计划模式被禁用时存在;批次形态中按条目设置,扁平形态中是顶层字段。隔离的 Agent 在完成时会被拆除——不可唤醒。 |

没有线格式的 label 字段:TUI/注册表中显示的单行 UI 标签由 tiny/title 模型根据 `task` 文本自动生成(即发即忘),因此调用方从不提供它。

运行时保持宽容:即使 `task.batch` 开启,扁平形态也被接受(内部调用方,如提交流程的 `analyze_files`,以及过期的记录)。模型始终只看到一种形态。

没有遗留的每调用 `schema` 参数。请使用 `outputSchema` 与可选的 `schemaMode`;缺失时,结构化输出回退到 Agent 定义的 `output` frontmatter,然后回退到继承的父会话 schema。

## 输出

工具返回一个文本块外加 `details: TaskToolDetails`。

后台响应(`async.enabled=true`):

- `content`:`` Spawned agent `<id>` (job `<jobId>`). The result will be delivered when it yields. ... `` 外加一个协调提示(启用消息时是 `hub` DM,否则是 `hub` 任务控制)。批次调用则返回 `` Spawned N background agents using <agent types>. ... ``(按条目去重后的 Agent 类型,逗号连接),并带每个 Agent 的 `- `<id>` (job `<jobId>`)` 列表。
- `details`:`{ projectAgentsDir, results, totalDurationMs, progress: [<AgentProgress per spawn>], async: { state, jobId, type: "task" } }`。调用保持一个共享的 `progress[]` 快照;`async.jobId` 是第一个启动的任务,`async.state` 汇总所有异步生成的状态(在每一个任务落地前为 "running",若任一生成失败则为 "failed")——调用返回前已落地的任务已反映在内。混合调用的 `results` 携带阻塞生成的以内联方式执行的 `SingleResult`(纯后台调用返回 `results: []`)。
- 实时进度通过 `onUpdate(...)` 持续流入同一个工具块;每个最终结果稍后以异步结果注入的形式到达父对话。投递文本会附加跟进提示:`` <id> is now idle — message it via `hub` to follow up; transcript at history://<id> ``(中止变体仅指向记录)。

已落地响应(`async.enabled=false`、无任务管理器、每个条目的 Agent 均为 `blocking: true`,或为异步任务体):

- `content`:由 `packages/coding-agent/src/prompts/tools/task-summary.md` 渲染的摘要,预览上限为 5000 个字符;`agent://<id>` 保存完整输出。同步批次会拼接每次生成的摘要。
- `details.results`:每次生成一个 `SingleResult`;`usage`、`outputPaths` 已填充(同步批次跨生成聚合)。

`SingleResult` 包括:

- 身份:`index`、`id`、`agent`、`agentSource`、`task`、`description`,可选的 `assignment`(内部载荷名称;线格式字段为 `name`/`agent`/`task`)
- 状态:`exitCode`,可选的 `error`、`aborted`、`abortReason`、`retryFailure`
- 输出:`output`、`stderr`、`truncated`、`durationMs`、`tokens`、`requests`,可选的 `contextTokens`/`contextWindow`、`usage`
- 模型:可选的 `modelOverride`、`resolvedModel`、`resolvedModelIsFallback`
- 结构化结果:可选的 `structuredOutput`,包含 schema 来源/模式、验证状态、解析后的 `data` 与验证 `error`
- 产物元数据:`outputPath?`、`patchPath?`、`branchName?`、`branchBaseSha?`、`nestedPatches?`、`outputMeta?`
- 提取的工具数据:来自注册的子进程工具处理器(如 `yield`)的 `extractedToolData?`

产物与侧信道:

- 每个拥有产物目录的子 Agent 都会写入 `<id>.md`;`agent://<id>` 解析到该文件。
- 子 Agent 自己的子级以点号限定(`<id>.<child>`);`agent://<id>/<child>` 读取该嵌套输出。当路径未指向嵌套输出且文件为 JSON 时,`agent://<id>/<path>` 与 `agent://<id>?q=<query>` 执行 JSON 提取。
- 当父级持久化产物时,每个子 Agent 都会获得 `<id>.jsonl` 会话历史;`history://<id>` 将其渲染为简洁记录(对活动与已暂停的 Agent 均有效)。
- 隔离补丁模式在合并前写入 `<id>.patch`。

## 流程

1. `TaskTool.create(...)` 通过进程级记忆(`discoverAgentsForCreate`)对每个 cwd 发现一次 Agent,以渲染动态提示词描述。
2. `execute(...)` 修复原始参数(`repairTaskParams`),然后验证:`schema` 始终被拒绝;除非 `task.batch` 开启,否则 `tasks`/`context` 被拒绝;批次调用需要非空的 `tasks`(每个条目一个 `task`,提供的名称唯一)、非空的共享 `context`,且不能在 `tasks` 之外再有顶层 `task`;扁平调用需要 `task`。随后调用被规范化为其生成列表(`resolveSpawnItems`)。
3. 按条目的执行拆分:Agent 类型声明了 `blocking: true` 的条目以内联方式运行;其余成为后台任务。当 `async.enabled=false`、会话没有 `AsyncJobManager`(孤儿主机)或每个条目都是阻塞时,整个调用同步运行;内联生成在会话级信号量下通过 `#executeSync(...)` 运行。
4. 后台执行(任意非阻塞条目且 `async.enabled=true` 并有 `AsyncJobManager`):
   - Agent ID 预先通过 `AgentOutputManager.allocate(...)` 分配——每个条目的 `name`,或生成的 AdjectiveNoun 名称——每次生成一个;
   - 每次生成向 `session.asyncJobManager` 注册一个 `type: "task"` 任务(`id` = Agent ID,`queued: true`,`ownerId` = 调用方 Agent ID),工具立即返回;
   - 每个任务体获取会话级 `Semaphore`(每个 `TaskTool` 实例一个,在每次获取与释放前根据实时的 `task.maxConcurrency` 设置原地调整大小),将任务标记为运行中,用该生成的参数运行 `#executeSync(...)`,并通过共享的 `buildAsyncDetails`/`onUpdate` 报告进度;
   - 失败或被中止的运行抛出 `TaskJobError`,使任务落地为 `failed`,但 Agent 本身保持注册并可查询;
   - 混合调用先注册异步任务,然后以内联方式运行其阻塞条目,并在它们落地后返回——文本将内联摘要与生成任务列表合并,工具块在内联结果旁持续渲染仍在运行的后台行。
5. `#executeSync(...)` 运行生成路径(`#runSpawn`),它会从磁盘重新发现 Agent,因此运行时解析可能不同于创建时的描述。
6. 它解析每个生成请求的 `agent` 类型,拒绝未知或设置中禁用的 Agent,并强制执行父级生成策略以及 `PI_BLOCKED_AGENT` 自递归防护。
7. 模型优先级:`task.agentModelOverrides` → Agent frontmatter → 配置的 task 角色/会话回退。输出 schema 优先级:每调用 `outputSchema` → Agent frontmatter `output` → 继承的父会话 schema。
8. 计划模式会换入一个带有只读工具子集与计划模式提示词的 `effectiveAgent`;`runSubprocess(...)` 接收该有效 Agent。
9. 若为 `isolated`,它需要一个 git 仓库(`getRepoRoot(...)` / `captureBaseline(...)`),将 `task.isolation.mode` 映射为后端类型提示(`parseIsolationMode`),并通过 natives PAL(`ensureIsolation` → `isoResolve`/`isoStart`)实例化工作区,当后端不可用时遍历候选列表。
10. 产物目录在可用时来自父会话文件,否则为临时目录。当会话正在执行已批准的计划时,计划引用会交给子 Agent。
11. 非隔离生成直接以父级 cwd 调用 `runSubprocess(...)`;隔离生成在隔离工作区内部运行,然后提交到分支(`mergeMode === "branch"`)或捕获补丁,并且始终清理工作区。
12. `runSubprocess(...)` 创建一个带有隔离设置快照的子 Agent 会话(父级设置被继承——`async.enabled` 与 `bash.autoBackground.enabled` 从父级**继承**,不会被强制禁用;`tier.openai`/`tier.anthropic`/`tier.google` 通过 `tier.subagent` 重新解析;`tools.approvalMode` 被强制为 `yolo`,因为无头子 Agent 没有 UI 可用来确认提示词;每次生成的覆盖可禁用读取摘要,并可为隔离运行清除额外的工作区根),子级 `agentId` 等于分配的 ID、子级内部 URL 路由/`AgentOutputManager`、输出 schema、系统提示词 `CONTEXT` 部分中的共享 `context`(批次调用),以及系统提示词中的 IRC 对等名单。
13. 子级工具可用性:若提供则为显式 `agent.tools`;当 Agent 具有 `spawns` 且深度允许时自动添加 `task`;在 `task.maxRecursionDepth` 处剥离 `task`;确保显式工具列表中存在 `hub`;将 `exec` 展开为 `eval` + `bash`;剥离父级所有的 `todo`——除非该生成已启用 prewalk,其计划提示 + todo 门控需要子级在模型交接前提交自己的 todo 列表。
14. 子级必须通过隐藏的 `yield` 工具结束;最多 3 次提醒提示,最后一次在支持时强制 `toolChoice = yield`。`finalizeSubprocessOutput(...)` 协调原始文本、`yield` 载荷、结构化 schema 与中止状态。
15. 运行结束的生命周期(保活,在运行终结器中):
    - 调用方信号、墙钟超时或内部硬中止 → 注册表状态 `aborted`,会话被销毁——终态;
    - 非隔离保活 Agent 上的软请求预算中止 → 视为可恢复:Agent 变为 `idle`,可接收跟进/唤醒;
    - 隔离运行 → 状态 `parked`,无唤醒器(工作区已合并 + 清理,因此会话不可唤醒;记录仍可通过 `history://` 读取),然后会话被销毁并分离;
    - 其余一切(成功与失败一样)→ 状态 `idle` 并附加活动会话,`AgentLifecycleManager.global().adopt(id, { idleTtlMs, revive })` 启动停放计时器。唤醒器会重新打开会话 JSONL。
16. 此后生命周期:`idle`(空闲)Agent 在 `task.agentIdleTtlMs` 之后被停放(会话被销毁;保留 `AgentRef` + 会话文件);消息(`hub`)或 Agent 中心会将它们唤醒回 `idle`。`"Main"` 永不被停放。

## 模式 / 变体

- 执行模式
  - 后台任务 — `async.enabled=true`;非阻塞生成通过 `AsyncJobManager` 进行。
  - 同步内联 — `async.enabled=false`、无任务管理器,或条目的 Agent 声明 `blocking: true`(按条目:混合调用两种模式都运行)。
- 批次模式(`task.batch`,默认开启)
  - 开启 — `{ context, tasks[] }`:每个条目一次独立生成,必填的 `context` 在本次调用的生成间共享,`agent`、`outputSchema` 与 `schemaMode` 按条目设置。`effort` 仅在其设置启用时出现;`isolated` 还要求计划模式被禁用。生命周期、唤醒与并发语义等同于 N 次并行的单次调用。
  - 关闭 — 每次调用单次生成;`tasks`/`context` 被拒绝并从 schema 中移除,附带相同的条件 `effort`/`isolated` 字段。
- 隔离模式(`task.isolation.mode`):`none`、`auto`、`apfs`、`btrfs`、`zfs`、`reflink`、`overlayfs`、`projfs`、`block-clone`、`rcopy`(为向后兼容接受遗留的 `worktree`、`fuse-overlay`、`fuse-projfs`);PAL 带回退解析实际后端。
- 隔离合并策略:补丁模式(捕获/应用根补丁)或分支模式(提交到 `omp/task/<id>`,cherry-pick 进父级)。
- Agent 来源优先级按精确名称先到先得:项目 `.omp/agents`;用户 `.omp/agent/agents`;OMP 扩展包的 `agents/` 根按 CLI → 项目设置 → 用户设置 → 已安装 npm/link 插件的顺序;Claude 市场插件 Agent(项目先于用户);然后是内置(`scout`、`designer`、`reviewer`、`security-reviewer`、`librarian`、`task`、`sonic`)。
- Prewalk:Agent frontmatter 的 `prewalk` 或 `task.agentPrewalk[agentName]` 可以在普通模型上启动,并在第一次 edit/write 时交接给更便宜的已解析模型。`task.prewalk`(默认关闭)为内置的通用 `task` Agent 启用此行为。缺失/未配置的目标以及模型+effort 完全相同的无操作会跳过交接,而不是使生成失败。

## 副作用

- 文件系统
  - 在会话产物目录或临时任务目录下写入 `<id>.jsonl` 与 `<id>.md`;隔离补丁模式写入 `<id>.patch`。
  - 创建/移除 worktree 或 overlay 挂载目录;分支模式创建临时 worktree 与任务分支。
- 网络
  - 子会话可以使用其活动工具集允许的任何联网工具/模型。
  - MCP 代理工具可以调用现有的父级 MCP 连接,超时为 60_000 ms。
- 子进程 / 原生绑定
  - 隔离后端通过 `pi-natives` PAL(`crates/pi-iso`)运行:Linux 上内核 `overlay` 带 `fuse-overlayfs`/`fusermount[3]` 回退、APFS/Btrfs/ZFS/reflink 克隆、Windows 上的 ProjFS、作为最后手段的递归复制。
  - 用于基线捕获、补丁应用、worktree、分支、stash、cherry-pick、提交的 Git 操作。
- 会话状态(记录、内存、任务、检查点、注册表)
  - 创建带有隔离设置快照的子 `AgentSession` 实例;已完成的会话在进程拆除或显式释放前,以 `idle`/`parked` 状态保留在进程级全局 `AgentRegistry` 中。
  - 当 `async.enabled=true` 时,在 `session.asyncJobManager` 中为每次生成注册一个异步任务;完成以异步结果消息的形式注入父级。
  - 在 `AgentLifecycleManager` 中启动空闲 TTL 计时器(unref'd;它们绝不会让进程保持打开)。
  - 在父级事件总线上发出 `task:subagent:event`、`task:subagent:progress` 与 `task:subagent:lifecycle`。
  - 通过 `AgentOutputManager` 分配会话级输出 ID,使 `agent://` 在多次调用间保持唯一。
  - 与子 Agent 共享父级 `local://` 根与 `ArtifactManager`。
- 后台工作 / 取消
  - `hub` 取消(或父级工具调用中止)会取消后台任务;父级工具调用中止通过调用信号取消同步运行。硬中止的运行落地为 `aborted` 并被拆除。
  - 缺失 `yield` 的恢复会向子会话发送最多三条内部提醒提示。

## 限制与上限

- 每次生成的 effort 是选用的:`task.enableEffort` 默认为 `false`;为 false 时,`effort` 会从面向模型的动态 schema 中省略。
- 并发:一个会话级 `Semaphore` 在每次获取与释放前根据实时的 `task.maxConcurrency` 设置原地调整大小,然后限制跨并行 `task` 调用的并发子 Agent——异步任务体与同步回退都会获取它。因此会话中途的设置变更会影响新生成以及已排队在信号量上的工作。
- 空闲 TTL:`task.agentIdleTtlMs`,默认 `420_000` ms(7 分钟);`<= 0` 禁用停放,使空闲会话保持活动直到退出。
- 每个子 Agent 的输出截断:`packages/coding-agent/src/task/types.ts` 中的 `MAX_OUTPUT_BYTES = 500_000` 与 `MAX_OUTPUT_LINES = 5000`(可通过 `PI_TASK_MAX_OUTPUT_BYTES` / `PI_TASK_MAX_OUTPUT_LINES` 覆盖)。完整原始输出仍会写入 `<id>.md`。
- 进度合并:`PROGRESS_COALESCE_MS = 150`;最近输出尾部:`RECENT_OUTPUT_TAIL_BYTES = 8 * 1024`(最后 8 行非空行)。
- 缺失 `yield` 的提醒重试:`MAX_YIELD_RETRIES = 3`;MCP 代理超时:`MCP_CALL_TIMEOUT_MS = 60_000` — 两者都在 `packages/coding-agent/src/task/executor.ts` 中。
- 软请求预算:`task.softRequestBudget` 默认为 200 个请求(`0` 禁用)。当 `task.softRequestBudgetNotice` 启用时,超过它会注入一条收尾通知;达到预算的 1.5× 时,运行会被强制停止以产出部分发现。内置的 scout/sonic Agent 可能施加更低的内置上限。
- 硬墙钟:`task.maxRuntimeMs` 应用于每次生成;默认 `0` 禁用。
- 递归深度门控:`task.maxRecursionDepth`;`packages/coding-agent/src/tools/index.ts` 在达到或超过限制时隐藏 `task` 工具,`runSubprocess(...)` 也会在最大深度处剥离子级 `task` 访问。
- 最终内联摘要预览使用 `packages/coding-agent/src/task/index.ts` 中的 `fullOutputThreshold = 5000` 字符;`agent://<id>` 指向完整产物。

## 错误

- 参数验证失败以普通工具文本返回,`results` 为空:
  - `schema`(从不接受)
  - `task.batch` 禁用时的 `tasks` / `context`
  - 批次调用:缺失/为空的 `tasks`、没有 `task` 的条目、重复的提供名称、缺失共享 `context`、`tasks` 之外的顶层 `task`
  - 扁平调用:缺失/为空的 `task`
  - 未知或设置中禁用的 Agent 类型、生成策略拒绝、在隔离模式为 `none` 时请求 `isolated`
- 无 git 仓库的隔离执行返回 `Isolated task execution requires a git repository. ...`;不可用的后端通过 PAL 候选列表回退(通过 `fellBack`/`fallbackReason` 报告),其他后端错误被重新抛出,耗尽所有候选时会以回退原因报错。
- 任务注册失败返回 `Failed to start background task job(s): ...`;只调度了部分任务的批次会在即时文本中报告失败的 ID,并让已启动的任务继续运行。
- 子级失败表现为 `SingleResult.exitCode = 1`,`stderr`/`error` 已填充;异步任务被标记为失败,但投递文本仍携带输出及跟进/记录提示。
- 若子级省略 `yield`,`finalizeSubprocessOutput(...)` 会注入诸如 `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.` 的警告。
- 当其他工具读取 `agent://<id>` 时,解析错误对模型可见:无会话、无产物目录、ID 缺失、提取语法冲突,或用于提取的 JSON 无效。

## 备注

- 并行是指同一条助手消息中的并行 `task` 调用——或者,使用 `task.batch` 时,一次调用中的 `tasks[]` 批次;无论哪种方式,会话级信号量都限制扇出。当 `async.enabled=true` 时,每次生成都是一个独立的后台任务。
- 无批次模式时的共享背景惯例:将它一次性写入 `local://` 文件,并在每次生成的 `task` 中引用该路径——子 Agent 共享父级的 `local://` 根。使用 `task.batch` 时,必填的 `context` 参数将共享背景直接带入每次生成的系统提示词。
- 跟进工作优先向现有 Agent(`hub`)发消息,而不是重新生成:它已经持有相关上下文。`hub` op:"list" 显示空闲/已暂停候选;向已暂停的 Agent 发消息会唤醒它。`history://<id>` 显示 Agent 已做过什么。
- 对等消息的可用性是派生的,而非配置的(`packages/coding-agent/src/tools/hub/messaging.ts` 中的 `isIrcEnabled`):它恰好在有可消息对象时存在——会话可以生成子 Agent,或者它本身就是子 Agent。消息是联系已完成的子 Agent 的唯一跟进途径,因此没有 hub 消息的 task 会让空闲 Agent 搁浅。
- Agent 发现优先级按精确名称先到先得:项目 `.omp` Agent 先于用户 `.omp`,然后是按 `listOmpExtensionRoots` 顺序的 OMP 扩展包 `agents/` 根(CLI、项目设置、用户设置、已安装 npm/link 插件)、Claude 市场插件 Agent(项目先于用户)以及内置 Agent。直接的 `.claude/agents`、`.codex/agents` 与 `.gemini/agents` 根会被跳过。创建时的发现按 cwd 记忆化用于提示词描述;执行时的发现保持新鲜。
- 子会话不继承对话历史。内置的继承内容是工作区树/skills/context 文件、共享的 `local://` 根,以及存在时的已批准计划引用。
- 当父级传入 `mcpManager` 时,子会话禁用独立的 MCP 发现,并获得复用父级连接的代理工具。
- 分支模式合并在 cherry-pick 前临时 stash 父级仓库;stash-pop 冲突不会取消合并 cherry-picked 的提交——它们保留在 HEAD 上,stash 条目被保留,冲突以 `stashConflict` 单独呈现。补丁模式仅在 `git.patch.canApplyText(...)` 成功时应用合并后的根补丁;失败会留下 `.patch` 产物供手动处理。
- 嵌套的 git 仓库在隔离工作区内部独立计算 diff,并用 `applyNestedPatches(...)` 单独合并。
- `agent://` ID 由 `AgentOutputManager` 基于名称生成(`Task` 优先,仅当名称重复时才为 `Task-2`/`Task-3`,嵌套如 `Parent.Child`);这正是防止重复或嵌套调用间产物冲突的机制。
