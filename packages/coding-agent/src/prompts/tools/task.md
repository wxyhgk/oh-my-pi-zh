{{#if asyncEnabled}}{{#if batchEnabled}}通过在单个 `tasks[]` 批次中传多个条目,把工作委派给后台子 Agent。
执行不阻塞——你立即收到 ID。{{else}}每次调用把一个工作委派给**一个**后台子 Agent。
执行不阻塞——你立即收到一个 ID。{{/if}}{{#if hasBlockingAgents}}
标记为 BLOCKING 的 Agent 内联运行——结果在这次调用中返回;同一批次中的非阻塞条目仍作为后台作业生成。{{/if}}{{else}}{{#if batchEnabled}}通过在 `tasks[]` 批次中传条目,同步运行子 Agent。执行阻塞直到所有工作完成。{{else}}同步运行**一个**子 Agent。执行阻塞直到工作完成。{{/if}}{{/if}}
{{#if asyncEnabled}}

# 异步作业契约
- 结果自动交付。已落定的 `hub jobs`/`hub wait` 快照就是交付;不会有重复的 `async-result` 跟随。
- 作业 ID 是进程本地的,落定后大约五分钟过期。之后,用 `hub send`、`agent://<id>` 或 `history://<id>` 加上 Agent ID。
- `completed` 意味着成功的 yield/作业退出,不是产物验收。核实声称的变更。
{{/if}}

# 任务设计
- **Agent 类型:** 为每个条目选择 `agent` 类型。{{#if scoutAvailable}}只读研究必须用 `agent: "scout"`(更快的模型)。{{/if}}只有在没有专家合适时才用默认 worker。
- **无开销:** 每个 `task` 必须指示其 Agent 跳过格式化器、linter 和项目级测试套件。那些在结尾运行一次。
- **单遍:** 优先让 Agent 在单遍中调查**并**编辑;{{#if scoutAvailable}}只有当受影响文件确实未知时才生成只读 scout。{{/if}}
- **重叠是安全的:** 对同一文件的并发编辑会自动解决{{#if ircEnabled}};最坏情况下,Agent 直接通过 IRC 协调{{/if}}。绝不为避免文件重叠而缩小或串行化批次。两个前提:
  1. 每个任务都必须跳过验证(构建/lint/测试)——中途验证会阻塞 Agent 相互的编辑。
  2. 提前定好跨任务契约(例如 A 实现而 B 消费的接口),并在{{#if batchEnabled}}批次 `context`{{else}}任务{{/if}}中说明,而不是留给 Agent 协商。

# 输入
{{#if batchEnabled}}
- `context`:共享的项目状态、约束和契约。适用于整个批次;不要把这个背景重复进单个任务。
- `tasks[]`:要生成的子 Agent 数组。
  - `name`:稳定的 CamelCase 标识符(≤32 字符),用于称呼该 Agent(IRC、作业 ID)。省略时自动生成。
  - `agent`:运行此项的 Agent 类型(例如 {{#if scoutAvailable}}`scout`、{{/if}}`reviewer`)。省略则给你通用 worker(`{{defaultAgent}}`)——绝不显式传那个名字。只有在检查下面的 Agent 列表、发现没有专家合适之后才省略。{{#if allowedAgentsText}}当前生成策略允许:{{allowedAgentsText}}。{{/if}}
  - `task`:完整、自包含的指令。一行式或缺少验收标准是被禁止的。
{{#if effortEnabled}}  - `effort`:按此任务的复杂度伸缩:`"lo"`|`"med"`|`"hi"`
{{/if}}
  - `outputSchema`:调用特定的 JSON Schema。覆盖所选 Agent 和父会话的 schema。
  - `schemaMode`:`"permissive"`(默认)接受重试耗尽后的无效结果并附警告;`"strict"` 使其失败。
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
  - `isolated`:在专用工作树中运行;成功的变更会自动应用到父检出。
{{else}}
  - `isolated`:在专用工作树中运行;变更作为补丁或分支产物保留,不修改父检出。
{{/if}}
{{/if}}
{{else}}
- `name`:稳定的 CamelCase 标识符(≤32 字符),用于称呼该 Agent(IRC、作业 ID)。省略时自动生成。
- `agent`:要生成的 Agent 类型(例如 {{#if scoutAvailable}}`scout`、{{/if}}`reviewer`)。省略则给你通用 worker(`{{defaultAgent}}`)——绝不显式传那个名字。只有在检查下面的 Agent 列表、发现没有专家合适之后才省略。{{#if allowedAgentsText}}当前生成策略允许:{{allowedAgentsText}}。{{/if}}
- `task`:完整、自包含的指令。一行式或缺少验收标准是被禁止的。
{{#if effortEnabled}}- `effort`:按此任务的复杂度伸缩:`"lo"`|`"med"`|`"hi"`
{{/if}}
- `outputSchema`:调用特定的 JSON Schema。覆盖所选 Agent 和父会话的 schema。
- `schemaMode`:`"permissive"`(默认)接受重试耗尽后的无效结果并附警告;`"strict"` 使其失败。
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
- `isolated`:在专用工作树中运行;成功的变更会自动应用到父检出。
{{else}}
- `isolated`:在专用工作树中运行;变更作为补丁或分支产物保留,不修改父检出。
{{/if}}
{{/if}}
{{/if}}

# 通信
子 Agent 从空白开始——没有对话历史。{{#if ircEnabled}}父到子的 IRC 会作为转向立即投递。{{/if}}
大载荷通过 `local://<path>` URI 传递,绝不内联文本。

# 格式契约
{{#if batchEnabled}}
`context` 格式:
# Goal         ← 批次要完成什么
# Constraints  ← 规则和会话决定
# Contract     ← 共享接口
{{/if}}

`task` 格式:
# Target       ← 确切的文件和符号;明确的非目标
# Change       ← 一步步的添加/移除/重命名;API 和模式
# Acceptance   ← 可观察的结果;无项目级命令

# 可用 Agent
{{#if spawningDisabled}}
Agent 生成当前被禁用。
{{else}}
选择最具体的 Agent;只有没有专家合适时才用默认 worker。
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (只读){{/if}}{{#if blocking}} (BLOCKING:内联结果){{/if}}
{{description}}
{{#if readOnly}}只用于调查;编辑自己做或交给写作者 Agent。{{/if}}
{{/list}}
{{/if}}
