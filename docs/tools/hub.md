# hub

> 统一的 Agent 协调入口:基于进程全局邮箱总线的对等方消息传递、后台任务控制,以及共享长生命周期进程的监管。

由原先的 `irc`、`job` 和 `launch` 工具合并而来;每个操作族都保留其旧行为与渲染。

## 来源
- 入口:`packages/coding-agent/src/tools/hub/index.ts`(schema、`HubTool`、统一的 `wait`、渲染器分发)
- 消息半边:`packages/coding-agent/src/tools/hub/messaging.ts`
- 任务半边:`packages/coding-agent/src/tools/hub/jobs.ts`
- 启动半边:`packages/coding-agent/src/tools/hub/launch.ts`
- 共享类型:`packages/coding-agent/src/tools/hub/types.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/hub.md`
- 主要协作者:
  - `packages/coding-agent/src/irc/bus.ts` — 进程全局 `IrcBus`:每个 Agent 的邮箱、投递、等待者匹配。
  - `packages/coding-agent/src/registry/agent-registry.ts` — 进程全局的 Agent 目录与状态。
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — 直接发送时对已暂停接收者的复活。
  - `packages/coding-agent/src/session/agent-session.ts` — `deliverIrcMessage(...)`:接收者侧注入与唤醒轮次。
  - `packages/coding-agent/src/async/job-manager.ts` — 任务注册表、取消、投递抑制、智能轮询阶梯。
  - `packages/coding-agent/src/launch/client.ts` / `broker.ts` / `presence.ts` / `protocol.ts` — 进程监管 broker。
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.timeoutMs`、`async.pollWaitDuration`、`launch.enabled`。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `op` | `"send" \| "wait" \| "inbox" \| "list" \| "jobs" \| "cancel" \| "start" \| "ps" \| "logs" \| "stop" \| "restart" \| "describe"` | 是 | 操作。 |
| `to` | `string` | `send`(对等方) | 接收者 Agent id,或 `"all"` 表示广播。与 `name` 互斥。 |
| `message` | `string` | `send`(对等方) | 消息正文。修剪后为空会被拒绝。 |
| `replyTo` | `string` | 否 | `send`:被回复的消息 id。 |
| `await` | `boolean` | 否 | 对等 `send`:投递后阻塞,直到收到来自该对等方的下一条消息。与 `to: "all"` 一起使用无效。 |
| `from` | `string` | 否 | `wait`:只接受来自该 Agent id 的消息(纯消息等待)。 |
| `ids` | `string[]` | 否 | `wait`:要监视的任务 id(省略 = 所有运行中的任务);`cancel`:要终止的任务 id(必填)。 |
| `timeoutMs` | `number` | 否 | 带 `await` 的对等 `send` 以及消息/任务 `wait`:毫秒;`0` 表示无限等待。回复/纯消息等待默认为 `irc.timeoutMs`,监视任务时默认为轮询窗口。 |
| `peek` | `boolean` | 否 | `inbox`:将消息留在进程全局总线邮箱中。注意:当前实现仍会把已在活跃接收者会话上缓冲的消息排入此结果。 |
| `name` | `string` | 进程操作 | 稳定的项目作用域启动名(1-48 个字符)。在 `send`/`wait` 上,它将操作路由到进程 broker。 |
| `application`、`args`、`env`、`cwd`、`pty`、`ready`、`restart`、`persist`、`detached` | — | `start` | 启动规格,与原先的 `launch` 工具一致。 |
| `lines`、`head`、`grep`、`follow`、`cursor` | — | `logs` | 日志窗口控制,保持不变。 |
| `for`、`pattern` | — | `wait`(name) | 进程生命周期条件 / 输出正则。 |
| `text`、`enter`、`keys`、`signal` | — | `send`(name) | 进程 stdin / 终端按键 / 信号。 |
| `timeout` | `number` | 否 | `logs`/`stop`/带 `name` 的 `wait`:秒;默认 30(stop 为 5)。 |

## 操作族与分发
- **消息** — `send`(带 `to`)、`inbox`、`list` 以及带 `from` 的 `wait`。即发即忘的发送会返回投递回执(`injected`/`woken`/`revived`/`failed`);直接发送可以复活已暂停的 Agent,而广播只面向可见的活跃对等方,不会复活每个已暂停的 Agent。`await: true` 在投递后等待一条回复。禁用异步执行的忙碌接收者可能会自动回复,而不是让等待中的发送者搁浅。
- **任务** — `wait`(裸用或带 `ids`)、`cancel`、`jobs`。属主作用域可见性、监视/取消监视投递抑制、返回完成上的 `acknowledgeDeliveries`、等待期间的 500 ms `onUpdate` 快照,以及 `async.pollWaitDuration` 固定/智能等待窗口。`jobs` 是原先的任务列表快照,外加没有运行中任务条目的运行中子代理名册。
- **进程** — `start`、`ps`、`logs`、`stop`、`restart`、`describe`,以及带 `name` 的 `send`/`wait`。行为与原先的 `launch` 工具完全一致;`ps` 即 broker 的 `list`。参见下方启动相关章节。

同时带 `to` 和 `name` 的 `send` 会因歧义而被拒绝。`wait` 按目标路由:`name` → 进程等待;否则为统一的协调等待。

## 统一的 wait
一个阻塞原语。它解析任务腿(显式 `ids`,属主作用域且静默过滤,或调用方拥有的每个运行中任务),并且——当会话可以向对等方发消息时——停放一个总线等待者,然后竞争:
- 每个被监视运行中任务的 `job.promise`,
- 第一条匹配的入站消息(给出 `from` 时按其过滤),
- 等待窗口——若传入则为显式 `timeoutMs`(`0` = 无窗口),否则在 `smart` 下为 `manager.nextPollWaitMs(...)`,或固定 `async.pollWaitDuration`,
- 工具调用中止信号。

结果:
- 消息胜出(即使是千钧一发:被总线等待者消费的消息绝不会丢弃)→ 消息的返回方式与原先的 `irc wait` 完全相同(`details.waited`),任务继续运行;其结果仍会自动投递。
- 任务结束或窗口到期 → 返回与原先 `job` 轮询完全相同的任务快照(`details.jobs`,`## Completed` / `## Still Running` 区块)。全部运行中的快照会被标记为 `useless`,并渲染为可被替换的等待帧,下一次 `hub` 调用会取代它。
- 没有任务腿:纯消息等待,带对等方活跃性(受 `irc.timeoutMs` 限制);如果也没有运行中的对等方,则立即返回 `No running background jobs to wait for.`(若存在无任务运行中的 Agent 名册,则一并返回)。
- 显式 `ids` 未匹配到任何可见项 → `No matching jobs found for IDs: ...`,带每个 id 的 Agent 提示(`history://<id>`),绝不会挂起。
- 已在会话上缓冲的消息会在任何监视之前满足该等待。

智能阶梯记账(`recordPollWaitEnd`)仅在实际使用了智能窗口(未传显式 `timeoutMs`)时运行。

## 输出
- 消息与任务结果:单个文本块外加 `details: CoordinationDetails` — `{ op, from?, to?, receipts?, waited?, inbox?, peers?, jobs?, cancelled?, agents? }`。形状与原先工具一致,只是任务操作的 details 现在带有 `op`(`"wait" | "cancel" | "jobs"`)。
- 进程结果:`details: LaunchToolDetails` — `{ op, daemon?, daemons?, cursor?, timedOut?, state?, terminalRows?, matched?, spec? }`,与原先的 `launch` 工具一致(内部 `ps` 存储 broker 操作 `list`)。
- 流式输出:监视任务的等待每 500 ms 发出带最新快照的 `onUpdate`;其余均为一次性输出。

## 可用性
- 该工具始终注册(`loadMode: "essential"`)。
- 消息操作需要 `AgentRegistry` 和调用方 Agent id;否则返回 `Peer messaging is unavailable in this session.`(`isIrcEnabled` 仍控制对等名册提示区块:对每个子代理以及任何仍可派生子代理的会话为 true)。
- 任务操作需要 `session.asyncJobManager`;否则返回 `Async execution is disabled; no background jobs are available.`。
- 进程操作需要 `launch.enabled`;否则返回 `Process supervision is disabled (launch.enabled=false).`。

## 批准
`hubApproval`(每次调用):`start`、`stop`、`restart` 以及发送到进程的 `send` 为 `exec`;其余一切——消息、任务控制、`ps`/`logs`/`describe`/`wait`——均为 `read`。

## 启动与就绪(进程)
`application` 和 `args` 是分开的字段,因此调用方无需 shell 引号:

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": { "log": "Local:.*http", "port": 5173, "timeout": 30 }
}
```

默认值:`cwd` = 会话目录,`args: []`、`env: {}`、`pty: true`、`restart: "no"`、`persist: false`、`detached: false`,就绪超时 30 秒。`detached: true` 蕴含 `persist`,强制 `pty: false`,并禁用 stdin。`ready.log` 是对捕获输出的正则;`ready.port` 探测 `ready.host`(默认 `127.0.0.1`)上的 TCP;两者同时给出时,必须都通过。就绪超时会让进程继续运行,并报告其状态。

名称在一个项目目录内稳定且唯一。活动中的名称必须先停止或重启;启动一个已完成名称会创建新的启动,并轮换其先前的输出日志。

## 日志、输入、信号(进程)
```json
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```
每个 logs 结果返回一个字节游标;`follow: true` 会等待输出推进超过该游标、进程退出或超时到期。broker 保留 25 MiB 的当前日志外加一个轮换日志。按键:`ENTER`、`TAB`、`ESCAPE`、`CTRL_C`、`CTRL_D`、方向键。信号:`SIGINT`、`SIGTERM`、`SIGHUP`、`SIGQUIT`、`SIGKILL`。所有项目客户端共享同一个输入流。

## 跨实例生命周期(进程)
与原先的 `launch` 工具一致:第一个进程操作会在 `~/.omp/run/daemons/<project-hash>/` 下的私有 socket 上启动一个分离的 broker;项目中的每个 omp 实例共享名称、日志和状态。最后一个 omp 进程退出后,broker 停止非持久进程并退出。`persist: true` 选择不参与最后客户端拆除;重启策略(`no`/`on-failure`/`always`)使用上限 30 秒的有界指数退避。

## 限制与上限
- 邮箱:每个 Agent 100 条消息(`MAILBOX_CAP`);超过上限时丢弃最旧的。
- `irc.timeoutMs` 默认 `120_000`;`0` 禁用;负数/非有限值回退到默认值。
- 轮询窗口:`async.pollWaitDuration` — `5s`/`10s`/`30s`/`1m`/`5m`/`smart`(默认);智能阶梯 `[5s..5m]` 随连续等待逐级攀升,60 秒未等待后重置。
- 任务保留 5 分钟;管理器最大并行回退 15;`async.maxJobs` 钳制在 1..100。
- 启动名 1-48 个字符;`ready.port` 1..65535;`logs`/`wait`/`stop` 超时上限为一小时。

## 错误
- 大多数校验/可用性失败是以 `isError: true` 返回的文本结果:消息不可用、缺少 `to`/`message`、自我发送(`Cannot send a message to yourself.`)、`await` 与 `to:"all"` 一起使用、一次发送同时带 `to`+`name`、`cancel` 缺少 `ids`,以及启动被禁用。异步禁用的 `jobs`/`cancel` 响应是例外:它返回 `Async execution is disabled; no background jobs are available.`,带空任务列表且不带 `isError` 标志。
- 启动校验(缺少 `name`/`application`、`ready.port` 无效、不支持的键)抛出 `ToolError`,与之前完全相同。
- `wait` 超时是正常结果(`waited: null` 或标记为 `useless` 的全运行快照),绝不是错误。
- 每个接收者的投递失败以 `failed` 回执呈现;只有当什么都没投递时,`send` 才为 `isError`。

## 备注
- IRC 总线、Agent 注册表、任务管理器与启动 broker 都是未更改的子系统;只有工具表面被合并。
- 运行中的接收者仍会以不打断的旁白形式收到注入的消息(`irc:incoming` 自定义消息,`prompts/system/irc-incoming.md`);回复是真实的轮次。
- 向已暂停的 Agent 发消息会复活它——这是唯一的恢复原语;task 工具没有 `resume` 参数。
- TUI 渲染按族保留:消息卡片(`IRC ➤ / ⟵` 头部)、任务等待帧(可替换、微光行)与启动帧的渲染与合并前的工具逐字节一致;`hub` 渲染器只做分发。
