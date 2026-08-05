# Advisor、WATCHDOG.md 与 WATCHDOG.yml

advisor 子系统为一个会话挂接一个或多个可选审查模型。每个 advisor 审查主 Agent 的转录更新,可以用自己的工具检查工作区,并将简洁的建议注入回主会话。

advisor 不批准动作,也不直接修改主会话状态。其默认调查工具集是 `read`、`grep` 和 `glob`,但 `WATCHDOG.yml` 名单条目可以授予任何内置工具 —— 包括 `edit`、`write`、`bash`、`eval`、`browser` 等可变工具。这些工具在隔离的 advisor `ToolSession` 中运行,但仍遵循会话正常的批准模式和逐工具策略;只在 advisor 模型与工作区可信时才授予它们(见 [工具与隔离](#tools-and-isolation))。

## 实现文件

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/config.ts`](../packages/coding-agent/src/advisor/config.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.md)
- [`src/session/session-advisors.ts`](../packages/coding-agent/src/session/session-advisors.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)

---

## 启用 advisor

该子系统需要 `advisor.enabled: true`。之后模型选择取决于名单:

- 没有任何发现的 `WATCHDOG.yml` advisor 条目时,OMP 创建旧版/默认 advisor,并从 `modelRoles.advisor` 解析其模型。
- 有名单时,每个启用条目在给出显式 `model` 时使用它,否则使用 `modelRoles.advisor`。无法解析的条目被报告为 `no_model`,但不阻止其他条目运行。
- `advisors[].enabled: false` 使条目保持可见但显示为已暂停,不构建其运行时。

示例:

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

模型选择器使用常规的角色/模型解析,包括提供商前缀 id、规范 id、回退列表和可选的思考后缀。

`tier.advisor` 控制所有 advisor 的服务层级。默认 `none`(标准处理);`inherit` 跟随主会话实时的逐族层级,包括 `/fast` 变更。具体值(`auto`、`default`、`flex`、`scale`、`priority`)仅在 advisor 模型的提供商族支持时应用。

### 无头运行

使用 `--advisor` 为单次 print-mode 进程启用 advisor,而不持久化 `advisor.enabled`:

```sh
omp -p --advisor "Review this task."
```

主提示词运行时,advisor 的关注点与阻塞项继续引导该实时轮次。最终提示词结束后,print 模式保留迟到的 advisor 备注而不启动隐藏的主轮次,然后最多等待十分钟让最终审查完成,再销毁会话。错误退出使用 30 秒的排空预算,使失败的自动化能够终止。任一截止时间到期时,OMP 记录销毁将放弃的审查;已完成的审查保留其转录和 token/费用用量。

斜杠命令:

| 命令                | 作用                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/advisor`           | 切换本会话的 advisor 子系统(会话级覆盖;不更改持久化的 `advisor.enabled`)。                |
| `/advisor on`        | 为本会话启用配置的/默认的 advisor 运行时。会话级;不持久化到配置。                            |
| `/advisor off`       | 为本会话禁用 advisor 子系统并停止其运行时。会话级;不持久化到配置。                       |
| `/advisor status`    | 显示每个 advisor 的运行时状态、模型、上下文用量、token 用量和费用。                                                      |
| `/advisor dump`      | 将紧凑转录(有名单时含所有活动 advisor)复制到剪贴板。                                         |
| `/advisor dump raw`  | 复制完整转储,包括系统提示词、工具、思考和调用。                                                             |
| `/advisor configure` | 打开交互式 TUI 编辑器,编辑项目级或用户级 `WATCHDOG.yml`。非 TUI 命令宿主报告该编辑器仅 TUI 可用。 |

如果子系统已启用但没有旧版/默认或名单模型可解析,status 将配置的 advisor 报告为非活动/`no_model`。

## advisor 看到什么

每次主会话更新时,`AdvisorRuntime` 只接收自上次更新以来的新转录增量。增量带推理、工具意图、受监视角色标记和展开的主约束上下文渲染,因此 advisor 既能审查助手推理,也能审查用户可见文本、工具调用和工具结果。提供商绑定的消息与工具参数/结果在到达 advisor 模型之前会经过会话机密混淆器。

大多数隐藏的 `custom` 消息在增量中坍缩为一行摘要。主 Agent 注入的约束上下文(`plan-mode-context` 和 `plan-mode-reference`)则被原样渲染在 XML 转义的 `<primary-context kind="…">` 包装器内,重复副本被去重。advisor 还会在 `<project-context>` 系统提示词块中收到主会话发现的项目上下文文件(`AGENTS.md` 及相关常驻指令)。如果会话 cwd 位于 Git 之外且恰好有一个直接子仓库,额外的 watchdog 块会告诉 advisor 哪个子目录是活动项目。

已注入主转录的 advisor 消息在渲染下一个增量前被过滤掉。这防止 advisor 递归审查自己的建议。

当主转录被重写时,advisor 运行时被重置:

- 压缩
- 会话切换/恢复
- 分支/分叉式历史替换
- 当 advisor 自身上下文放不下时的上下文维护再初始化

重置清除 advisor 私有的内存转录并回卷其游标。下一次 advisor 更新重放当前有界的主转录,而不是从重写前的陈旧上下文继续。

当 advisor 在会话中途启用时,游标以当前主转录长度播种。这避免在启用后的第一个轮次重放整个旧对话。

## 工具与隔离

advisor 是一个完整的 Agent,拥有自己的 `Agent` 实例和一个独立的 `ToolSession`,其 id 后缀为 `-advisor`。它不共享主 Agent 的文件快照、已见行跟踪、冲突状态或摘要缓存。

每个 advisor 都有 `advise` 工具,用于将备注浮现到主转录中。省略 `tools` 时,其调查授权为:

- `read`
- `grep`
- `glob`

`WATCHDOG.yml` 名单条目可以选择会话实际构建出的任何内置工具子集(返回 `null` 的工厂,如不可用的 `lsp`,则缺席)。显式空 `tools: []` 不授予调查工具;`advise` 仍然可用。仅包含未知名称的列表会被丢弃并给出警告,目前回退到默认子集。可授予的名称包括 `edit`、`write`、`bash`、`eval`、`browser`、`debug`、`ast_edit`、`task`、`hub` 和内存工具等可变工具。

advisor 工具针对隔离的 advisor `ToolSession` 构建,并用 `ExtensionToolWrapper` 包装,因此 `tools.approvalMode`、逐工具批准策略和 `autoApprove` 与注册表工具一样适用。Cursor 的服务端 exec 桥使用相同的批准上下文,只在存在相应 advisor 授权时暴露 delete/edit/search 能力。

`advise` 工具接受一条备注和一个可选严重级别:

| 严重级别        | 投递                                                                                                                                                             | 预期用途                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 省略 / `nit` | 不打断的旁注,在下一个步骤边界批量汇入主转录。                                                                               | 清理、简化、低风险边界情况。                                |
| `concern`       | 在下方投递约束允许时作为打断性引导消息。迟到的终端回答 `concern` 则保留为可见卡片。                | 实质性风险、方向可能错误、缺失约束、幻觉 API。 |
| `blocker`       | 在下方投递约束允许时作为打断性引导消息。与 `concern` 不同,单独的终端回答不会阻止它触发轮次。 | 继续下去明显浪费工作或会产生损坏输出。                |

被接受的备注渲染为主转录中的 XML 转义 `<advisory>` 元素。命名名单 advisor 添加 `advisor` 属性:

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

当你刻意中断 Agent(Esc,或来自 collab、ACP、RPC、SDK 或扩展的取消)时,advisor 停止自动恢复它。在运行停止期间提出的打断性 `concern`/`blocker` 被记录为可见的 advisor 卡片,而不是重启轮次;你中断时已在途的 concern 也以同样方式保留,而不是驱动意外恢复。下次你恢复时 —— 新消息、`.`/`c` 继续快捷键或引导/跟进 —— 该建议重新进入上下文。

Agent 自己驱动的正常产出与刻意中断处理方式不同,但也不是一刀切的"总是引导并恢复"。循环状态与已完成的轮次首先决定正常投递路径:

- **循环仍在流式时**(建议在产出前到达,或在你已驱动的恢复期间到达),备注通常会引导进实时轮次。
- **循环已产出并空闲时**,投递取决于轮次如何结束:
  - 如果主会话尾部是**没有排队工作的终端文本回答**,迟到的 `concern` 保留为可见卡片,而不是唤醒 Agent 重述一个已完成轮次 (#4840) —— 它在下一次恢复(新消息、`.`/`c` 或引导/跟进)时重新进入上下文,与中断情形完全一致。`blocker` 是例外:它通常会引导一个触发轮次,因为那意味着 Agent 交付了损坏或未执行的工作,在轮次被认为完成前必须被确认 (#5628)。
  - 否则(Agent 中途产出,无终端回答),空闲的 `concern`/`blocker` 通常会触发一个新轮次,使建议立即得到处理。

两个会话/客户端约束仍可保留一条正常投递路径是引导的备注:

- **计划模式:**每个本会成为 advisor 引导的备注都保留为可见卡片,即使主循环正在流式,因为只有用户驱动的轮次才会收敛到 ask/resolve。
- **启用延迟 Agent 发起轮次的 ACP:**当 `deferAgentInitiatedTurns` 启用且桥尚未允许 Agent 发起轮次时,空闲的本会成为引导的备注被保留,因为客户端无法将触发的轮次表示为忙碌。主循环已在流式时提出的建议仍可引导进该实时轮次。

因此,advisor 可以引导并恢复 Agent 自行结束的运行,**只要它在运行中或中途产出,且当前模式/客户端允许引导**。当引导反而被阻止时,备注要么保留为卡片(上面的终端回答、计划模式和延迟 ACP 情形),要么降级为不打断的旁注(下面的 `advisor.immuneTurns` 冷却);无论哪种方式,它都会等到下一个步骤边界或恢复,而不是唤醒 Agent。

`advisor.immuneTurns` 限制中断频率。advisor 通过引导通道成功投递 `concern` 或 `blocker` 后,后续 concern/blocker 被路由为不打断的旁注,直到配置数量的主轮次完成。默认是 `3`。`nit` 备注不变;用户中断自动恢复抑制生效期间提出的建议仍被保留,而不是重启已停止的运行。

当 advisor 更新仍在审查进行中的工作时,`AdviseTool` 扣留 `nit` 和 `concern` 调用;只有 `blocker` 可以打断部分工作。该工具还会抑制相同空白归一化备注在同等或更低严重级别上的重复,同时允许真实升级(`nit` → `concern` → `blocker`)。

### 发射守卫

每个 advisor 在从 `AdviseTool` 到 YieldQueue/引导通道的路由上都有自己的 `AdvisorEmissionGuard`(`src/advisor/emission-guard.ts`)。它执行系统提示词中"每次更新最多接受一条备注"和无重复规则:

1. **归一化。** 小写、NFKC、把每个非字母数字字符的连续段坍缩为一个空格,然后修剪。`"Stop."`、`"*Stop*"` 和 `"  stop  "` 都键到 `stop`。
2. **无内容短语过滤。** 没有具体理由的短语 —— `stop`、`done`、`complete`、`no issue continue`、`lgtm`、`nothing to add` 等 —— 被抑制。
3. **精确文本去重。** 本会话中该 advisor 已接受的任何归一化备注都会被丢弃。FIFO 历史最多保留 4096 条。
4. **逐更新限流。** 每个 advisor 模型 `prompt()` 周期最多接受一条备注。被抑制的噪音不消耗预算。

守卫级抑制对模型不可见,因为 `AdviseTool` 已经返回 `Recorded.`。该工具更早的同等或更低严重级别重复检查刻意可见,为 `Duplicate advice ignored.`;进行中的非 blocker 返回 `Recorded.` 而不路由。

守卫的完整状态 —— 去重历史和逐更新门 —— 在每次 advisor 重置(压缩、会话切换、`/new`)时清除,因此重新初始化的审查者可以重新提出它已针对重写转录提出过的问题。

## 用 `advisor.syncBacklog` 有界追赶

`advisor.syncBacklog` 不是锁步轮次执行。它是主 Agent 在 advisor 落后时的有界追赶延迟。

允许的值:

- `off` — 从不等待 advisor 追赶
- `1`
- `3`
- `5`

主轮次结束时:

1. 主轮次增量排队给 advisor
2. advisor 排空循环在后台启动或继续
3. 如果 `advisor.syncBacklog` 不是 `off`,主 Agent 只在 advisor 积压达到或超过配置阈值时等待
4. 等待上限为 30 秒
5. 如果 advisor 追赶到阈值以下,主会话立即继续
6. 如果上限到期,主会话无论如何继续

实际解读:

- `off` 偏向最大主吞吐量。
- `1` 是最接近同步审查的模式:每个排队的 advisor 增量后,主会话最多等待 30 秒让积压归零。
- `3` 和 `5` 允许更多 advisor 延迟,主会话才暂停。

advisor 失败不会永久阻塞主会话。宿主首先尝试其凭据/回退恢复。可重试的失败在丢弃该积压前最多尝试三次;三次丢弃积压的周期会使运行时停止,直到显式重置,而永久性请求拒绝可在一次周期后使其停止。配额/用量限制失败会使 advisor 暂停并保留其批次,直到 `/advisor` 重建它、配置被重新加载、新会话开始或进程重启。advisor 一旦失败,追赶等待者立即被释放。

不安全的 Advisor 输出走独立的隔离路径,而不是那种三次尝试的请求重试策略。在工具分派前,运行时隔离一个请求了 Advisor 不可用的非桥工具的轮次。当检测到仅输出的破坏性 shell 指令,或破坏性 shell、指令覆盖、拒绝指令和账户删除声明中至少有三类仅输出危险模式匹配时,它也会隔离生成的文本/建议。与输入中引用的破坏性命令配对的新指令覆盖也符合条件。整个 Advisor 轮次(包括其中的任何建议)在分派前被丢弃。

第一次连续隔离会静默重置并用最新的待处理上下文重新初始化 Advisor。第二次连续隔离会发出一次去重的主机警告,丢弃受影响的批次,并重置 Advisor 上下文以打破循环。任何成功的 Advisor 轮次都会重置隔离计数器。

## WATCHDOG.md

`WATCHDOG.md` 是仅 advisor 的指导。它被追加到 advisor 系统提示词;不会注入主 Agent 的正常上下文,行为也不像 `AGENTS.md`、`RULES.md` 或其他上下文文件。

用它来表达审查优先级:advisor 应留意的风险、项目特定的陷阱、危险 API、架构边界,以及对审查者有用但对主执行者太吵的质量标准。

示例:

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### 发现位置

`discoverWatchdogFiles(cwd, agentDir)` 从这些位置加载每个可读候选:

1. 用户级:`<active agent dir>/WATCHDOG.md`(默认 `~/.omp/agent/WATCHDOG.md`;由 `PI_CODING_AGENT_DIR` 重定位)
2. 从 `cwd` 向上走到 git 仓库根,或找不到仓库根时走到主目录,过程中的项目级位置:
   - `<dir>/WATCHDOG.md`
   - `<dir>/.omp/WATCHDOG.md`

与原生上下文文件不同,watchdog 发现不会在最近的项目文件处停止。多个项目 watchdog 文件可以一起加载。

隐藏所有者目录中的候选会被忽略,除非文件位于 `.omp` 目录内。这避免意外拾取无关的点目录约定,同时仍允许 `.omp/WATCHDOG.md`。

### `@` 导入

`WATCHDOG.md` 内容用与上下文文件相同的 `@` 导入辅助器展开:

- 相对导入从导入文件所在目录解析
- `~/` 从用户主目录解析
- 围栏代码块和内联代码跨度内的导入保持字面量
- 循环被跳过
- 缺失或不可读的导入在原位保留 `@path` 文本

### 提示词顺序

加载的 watchdog 块排序为:

1. 用户级 `WATCHDOG.md`
2. 从更远的祖先向下到 `cwd` 的项目级文件

每个文件被追加到 advisor 系统提示词,形式为:

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

较晚的项目文件更靠近 advisor 提示词末尾,因此更窄的目录指导比更宽泛的祖先指导更突出。

## WATCHDOG.yml

`WATCHDOG.yml`(或 `WATCHDOG.yaml`)是 advisor 名单。`WATCHDOG.md` 提供审查优先级,而 `WATCHDOG.yml` 声明 advisor 本身 —— 每个名称一个条目,各带自己的启用标志、模型、工具授权和专业化提示词。交互式 `/advisor configure` 覆盖层就地编辑此文件。解析失败或 schema 校验失败的文件会被记录并跳过,因此一个坏的项目配置不会杀死会话。

示例:

```yaml
instructions: |
  Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      Watch cross-module coupling and public-API growth.

  - name: Fixer
    enabled: false
    model: anthropic/claude-sonnet-4-5:high
    tools: [read, grep, glob, edit, bash]
    instructions: |
      You may edit and run tests to prove a fix locally, then advise.
```

字段:

- `instructions`(顶层):共享提示词,与 `WATCHDOG.md` 一起前置到每个 advisor 的系统提示词。跨所有发现的 `WATCHDOG.yml` 文件拼接。
- `advisors[].name`:人类可读标签;slug 化用于会话 id 及其 `__advisor.<slug>.jsonl` 文件名。跨文件的重复 slug 由与 `WATCHDOG.md` 发现相同的特异性规则解决(项目叶子 > 项目祖先 > 用户)。
- `advisors[].enabled`:可选的逐 advisor 开关,默认 `true`。`false` 使 advisor 在状态/配置中保持可见但显示为已暂停。
- `advisors[].model`:可选的模型选择器,带可选 `:level` 思考后缀(例如 `x-ai/grok-code-fast:high`)。省略 → advisor 使用 `modelRoles.advisor`。
- `advisors[].tools`:可选的内置工具名列表,用于授权。省略 → 默认 `read`/`grep`/`glob` 子集;显式 `[]` → 无调查工具。[`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) 中的任何名称都被接受,包括可变工具。旧别名(`search`→`grep`、`find`→`glob`)被归一化。未知名称被丢弃并给出警告;如果那使非空输入没有有效名称,实现目前把结果当作省略,使用默认子集。
- `advisors[].instructions`:该 advisor 的专业化,在共享基线之后追加。两个指令字段都像 `WATCHDOG.md` 一样展开 `@path` 导入。

### 发现位置

`WATCHDOG.yml`/`WATCHDOG.yaml` 与 `WATCHDOG.md` 共享相同的用户 + 项目搜索路径:用户级 `<active agent dir>/WATCHDOG.yml`,加上从 `cwd` 走到仓库根(或找不到仓库根时走到主目录)过程中遇到的每个 `WATCHDOG.yml`/`.omp/WATCHDOG.yml`。所有发现的文件一起加载;更具体的文件(项目叶子 > 项目祖先 > 用户)替换具有相同 advisor slug 的较早条目。

## 子代理

`advisor.subagents` 控制派生的 task/eval 子代理是否也获得 advisor 运行时。

- `false`(默认):只有主会话可以运行 advisor。
- `true`:符合条件的子代理会话用相同的设置/模型角色解析构建自己的 advisor 子系统,然后为该子代理会话的 `cwd` 和 agent 目录重新运行 `WATCHDOG.md` 和 `WATCHDOG.yml` 发现。

子代理 advisor 保持与子代理主工具会话隔离,方式与主 advisor 与主 Agent 隔离相同。

## 费用与上下文行为

advisor 用量是独立的模型用量。`/advisor status` 从 advisor Agent 自己的转录报告 advisor token 数和费用。

advisor 有自己的只追加上下文。每次 advisor 提示词前,`AgentSession` 估算传入 token,并可能维护 advisor 上下文:

1. 启用时尝试模型级上下文提升,如果存在更大的兼容模型
2. 如果提升无法容纳足够上下文,压缩 advisor 自己的消息历史
3. 如果压缩没有候选或仍放不下,从当前有界主转录重新初始化

advisor 的实时上下文在内存中且只追加;会话运行期间保留,以便 `/advisor dump` 检查它,并独立提升/压缩/重新初始化(如上)。它不是主持久化转录的替代品。

## 转录持久化与可观测性

advisor 是带自己模型用量的被动审查者,因此 —— 与 task 子代理一样 —— 每个最终确定的 advisor 轮次被追加到所属会话产物目录内的 JSONL:

- 旧版/默认 advisor:`<session>/__advisor.jsonl`
- 命名 advisor:`<session>/__advisor.<slug>.jsonl`
- 子代理 advisor(`advisor.subagents: true`):`<session>/<SubId>/__advisor[.<slug>].jsonl`

路径派生自所属会话文件(而非共享产物根),因此每个主/子代理 advisor 写入一个独立文件。保留的 `__advisor` 词干不会与 task 子代理 id 冲突。

为什么用文件:

- **用量归属。** `omp stats` 递归扫描每个会话文件夹,因此 advisor 助手轮次(及其用量/费用)像任何其他子代理一样归属于同一项目/会话。advisor 的"会话更新"提示词被持久化为 `synthetic`、Agent 归属的用户消息,因此永远不会夸大用户消息指标。
- **可观测性。** Agent 中心打开时发现旧版和命名的 `__advisor*.jsonl` 文件,并将每个显示为其所属会话下的只读 `advisor` 类转录。

文件跟随会话切换:在 `/new`、恢复/切换和分支时,记录器在下一个 advisor 轮次重新打开到新会话路径;在 `/drop` 删除旧产物目录之前,记录器馈送被分离并排空,使排队的写入无法重建已删除的文件。磁盘日志只追加,独立于内存上下文 —— 重新初始化和压缩永远不会截断它。

advisor 永远不是对等方。`advisor` 类注册表引用被排除在每个 Agent 面向的表面之外 —— `hub` 对等名单与广播目标、子代理对等提示词、`history://` 索引/查找/补全 —— 并且不能被消息(`hub` 发送和 collab 聊天拒绝它)或从 Agent 中心或 collab 复活/杀死。无论被授予什么工具,它都不可作为对等方寻址。
