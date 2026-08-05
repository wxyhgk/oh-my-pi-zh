# retain

> 通过活动的长期记忆后端存储持久事实。

## 来源
- 入口:`packages/coding-agent/src/tools/memory-retain.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/retain.md`
- Hindsight 协作者:
  - `packages/coding-agent/src/hindsight/state.ts` — 每会话队列、flush、自动 retain。
  - `packages/coding-agent/src/hindsight/backend.ts` — 会话引导、提示词注入、子代理别名。
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id 派生、标签作用域、首次使用 bank/任务设置。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` 调用。
  - `packages/coding-agent/src/hindsight/content.ts` — 保留转录整形、记忆标签剥离。
  - `packages/coding-agent/src/hindsight/mental-models.ts` — bank 作用域心智模型种子和缓存渲染。
  - `packages/coding-agent/src/hindsight/seeds.json` — 内置心智模型种子定义。
  - `packages/coding-agent/src/hindsight/transcript.ts` — 为自动 retain 提取用户/助手轮次。
- Mnemopi 协作者:
  - `packages/coding-agent/src/mnemopi/backend.ts` — 本地后端引导、提示词注入、子代理别名、入队/清除。
  - `packages/coding-agent/src/mnemopi/state.ts` — 作用域 recall/retain 状态和本地写入。
  - `packages/coding-agent/src/mnemopi/config.ts` — 本地 SQLite 路径、bank、作用域、提供商设置。
  - `packages/mnemopi/src/core/memory.ts` — `remember(...)` 使用的本地记忆运行时。

## 注册 / 可见性
- 工具元数据:`approval = "read"`、`strict = true`、`loadMode = "discoverable"`,尽管成功的调用会入队或执行记忆写入。
- 该工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册;对 `"off"` 和 `"local"` 不存在。
- 在带有显式工具列表的无限制会话中,注册自动包含任一受支持后端的共享 `recall`/`retain`/`reflect` 集合。受限列表不会被扩展。
- 在普通 `tools.xdev` 会话中,可发现的构建工具可能以 `xd://retain` 形式呈现;显式请求的工具保持顶层。
- 执行返回一个最终结果,无进度回调或取消参数。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `items` | `Array<{ content: string; context?: string }>` | 是 | 要存储的一条或多条记忆。`minItems: 1`。每个条目必须自包含;`context` 是每条目可选的来源信息。 |

## 输出
输出取决于活动的 `memory.backend`。

Hindsight:
- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` 或 `"<count> memories queued."`
- `details = { count: number }`
- 写入在工具返回前未确认。队列稍后 flush;flush 失败发出会话警告通知,且不返回给模型。

Mnemopi:
- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` 或 `"<count> memories stored."`
- `details = { count: number }`
- 工具同步调用本地写入,但 `rememberScoped(...)` 捕获每个写入失败并返回 `undefined`;`retain` 忽略该返回并仍报告请求的计数。因此响应不是逐条持久性收据。

## 流程
1. `MemoryRetainTool.createIf(...)` 在 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时暴露工具。
2. `execute(...)` 重新读取 `memory.backend`,并分派到匹配的会话状态。
3. 如果后端是 `mnemopi`:
   - 获取 `session.getMnemopiSessionState()` 并在后端未启动时抛错;
   - 对每个条目,用 `source: "coding-agent-retain"`、`importance: 0.75`、`scope: "bank"`、`extract: true`、`extractEntities: true`、`veracity: "tool"`、`memoryType: "fact"` 和元数据 `{ session_id, cwd, context, tool: "retain" }` 调用 `state.rememberScoped(item.content, ...)`;
   - 写入进入作用域 retain bank;同一会话中的精确重复内容更新 Mnemopi 核心中现有的工作记忆行。
4. 如果后端是 `hindsight`:
   - 获取 `session.getHindsightSessionState()` 并在后端未启动时抛错;
   - 每个输入条目交给 `HindsightSessionState.enqueueRetain(...)`;
   - `HindsightRetainQueue.enqueue(...)` 追加条目,队列达到 `RETAIN_FLUSH_BATCH_SIZE` 时立即 flush,否则启动 `RETAIN_FLUSH_INTERVAL_MS` 的防抖计时器;
   - flush 时,`HindsightRetainQueue.#doFlush(...)` 验证所有权,通过 `ensureBankExists(...)` 尽力而为地确保 bank 存在,将条目映射到带 `context ?? config.retainContext`、`metadata.session_id` 和 bank 作用域标签的 `MemoryItemInput`,然后发送一个异步 `retainBatch(...)` 请求。

## 模式 / 变体
- Hindsight 工具路径:仅排队批处理写入。
- Mnemopi 工具路径:直接本地 `remember(...)` 进入作用域 retain bank。
- `computeBankScope(...)` 中的 Hindsight bank 作用域:
  - `global` — 一个共享 bank,无项目标签。
  - `per-project` — bank id 追加 `-<project label>`,标签是 git 主检出根 basename(仓库外的 cwd basename)。
  - `per-project-tagged` — 共享 bank 加上保留记忆上的 `project:<project label>` 标签。
- `computeMnemopiBankScope(...)` 中的 Mnemopi bank 作用域:
  - `global` — retain 和 recall 使用共享 bank。
  - `per-project` — retain 和 recall 使用由绝对 cwd basename 加上该绝对 cwd 的哈希派生的项目 bank。
  - `per-project-tagged` — retain 写入 cwd 派生的项目 bank;recall 也读取共享 bank。
  - 每项目 recall 可能添加存储的工作记忆行都匹配活动 cwd 的安全遗留 bank;扫描上限为 64 个候选 bank 目录。
- 会话作用域:
  - 工具调用的 retain 是活动后端的每会话工作;
  - 持久化的 Hindsight 记忆是跨会话服务器端 bank 数据;
  - 持久化的 Mnemopi 记忆是本地 SQLite 数据;
  - 子代理对两个受支持后端都别名父级记忆状态。

## 副作用
- 文件系统
  - Hindsight:保留记忆无。不写入本地记忆文件。
  - Mnemopi:写入 `mnemopi.dbPath` 下的本地 SQLite,默认在 Agent 记忆目录之下(`mnemopi/mnemopi.db`),需要时为每个作用域 bank 一个数据库文件。
- 网络
  - Hindsight:通过 `retainBatch(...)` 发送 `POST /v1/default/banks/{bank_id}/memories`,加上每个会话状态每个 bank 首次写入前通过 `ensureBankExists(...)` 的可选 `PUT /v1/default/banks/{bank_id}`(该集合用主会话状态创建,并与子代理别名共享)。
  - Mnemopi:无,除非配置的嵌入或 LLM 提供者在提取期间调用。
- 会话状态
  - Hindsight:追加到内存 `HindsightRetainQueue`,包含 `metadata.session_id`,并为子代理共享父级状态。
  - Mnemopi:通过会话的作用域 `Mnemopi` 实例写入,包含 `session_id`、`cwd` 和可选 `context`,并与子代理共享作用域资源。
- 用户可见提示词 / 交互 UI
  - Hindsight 异步 flush 失败发出 `session.emitNotice("warning", ...)`;不告知模型。
  - Mnemopi 写入失败由 `rememberInScope(...)` 记录;工具响应不暴露逐条失败。
- 后台工作 / 取消
  - Hindsight flush 稍后在防抖计时器或队列大小阈值上运行;后端 `enqueue(...)` 和 `clear(...)` 显式排空它。flush 时的会话所有权不匹配记录并丢弃批次。
  - Mnemopi 事实/实体提取和嵌入可能在同步行写入后继续。后端 `enqueue(...)` 请求完整整合;后端 clear 在删除其数据库文件前处置作用域实例。
  - `retain.execute()` 本身无中止信号处理。

## 限制与上限
- 输入 schema 要求 `items.length >= 1`;条目字符串无 schema 级最小长度。
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`;默认 `memory.backend` 是 `"off"`。
- Hindsight 队列 flush 阈值:`RETAIN_FLUSH_BATCH_SIZE = 16`。
- Hindsight 队列防抖:`RETAIN_FLUSH_INTERVAL_MS = 5_000`。
- Hindsight 队列写入使用 `retainBatch(..., { async: true })`;客户端请求超时默认为 `hindsight.retainTimeoutMs = 60_000`,但不等待服务器端整合。
- Hindsight 自动 retain 设置:
  - `hindsight.autoRetain = true`
  - `hindsight.retainEveryNTurns = 3`
  - `hindsight.retainOverlapTurns = 2`
  - `hindsight.retainContext = "omp"`
  - `hindsight.retainMode = "full-session"`
- Mnemopi retain 设置:
  - `mnemopi.autoRetain = true`
  - `mnemopi.retainEveryNTurns = 4`
  - `mnemopi.scoping = "per-project"`

## 错误
- 当 `memory.backend == "mnemopi"` 但无状态存在时,抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但无状态存在时,抛出 `Hindsight backend is not initialised for this session.`。
- 处置状态上的 Hindsight 队列入队抛出 `Hindsight retain queue is closed.`。
- Hindsight flush 时 API 失败被捕获、记录并转换为警告通知,而不是工具错误。
- Hindsight bank/任务创建失败在 `ensureBankExists(...)` 中于 debug 级别记录并吞掉;后续写入仍运行。
- Mnemopi `remember(...)` 失败在 `MnemopiSessionState.rememberInScope(...)` 中捕获、记录,不重新抛给工具调用方。

## 注释
- Hindsight 存储是服务器端。`hindsightBackend.clear(...)` 排空本地队列、清除本地缓存/状态,并警告上游删除必须在 Hindsight UI 或 `deleteBank` 中进行。
- Mnemopi 存储是本地 SQLite。`mnemopiBackend.clear(...)` 删除每个活动作用域 bank 的数据库文件,然后在会话保持活动时重新水合后端。
- Hindsight 自动 retain 使用相同的 bank 但不同的路径:`retainSession(...)` 提取纯用户/助手转录,剥离 `<memories>` / `<mental_models>` 块,并调用单条目 `retain(...)`。
- Mnemopi 自动 retain 用 `source: "coding-agent-transcript"`、`importance: 0.65`、`veracity: "unknown"` 和 `memoryType: "episode"` 存储准备好的转录。
- Hindsight 心智模型引导位于共享后端:`HindsightSessionState.runMentalModelLoad(...)` 可选解析种子、创建缺失模型,然后缓存渲染的 `<mental_models>` 块用于提示词注入。
- 内置 Hindsight 种子是 `user-preferences`、`project-conventions` 和 `project-decisions`。`projectTagged: true` 种子继承活动作用域的 retain 标签;未标记种子读取整个 bank。
- Hindsight 心智模型默认值:`hindsight.mentalModelsEnabled = true`、`hindsight.mentalModelAutoSeed = true`、`hindsight.mentalModelRefreshIntervalMs = 5 * 60 * 1000`、`hindsight.mentalModelMaxRenderChars = 16_000`。首轮加载等待至多 `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500`。
- Hindsight 种子生命周期仅创建。更改 `packages/coding-agent/src/hindsight/seeds.json` 不会变更现有服务器端模型。
- `recall.md` 和 `reflect.md` 依赖相同的后端选择和作用域行为。
