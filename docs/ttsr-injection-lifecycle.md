# TTSR 注入生命周期

本文档介绍当前 Time Traveling Stream Rules(TTSR)的运行时路径:从规则发现到流中断、重试注入、扩展通知与会话状态处理。

## 实现文件

- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/export/ttsr.ts`](../packages/coding-agent/src/export/ttsr.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/ttsr-coordinator.ts`](../packages/coding-agent/src/session/ttsr-coordinator.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/prompts/system/ttsr-interrupt.md`](../packages/coding-agent/src/prompts/system/ttsr-interrupt.md)
- [`../src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`../src/extensibility/extensions/types.ts`](../packages/coding-agent/src/extensibility/extensions/types.ts)
- [`../src/extensibility/hooks/types.ts`](../packages/coding-agent/src/extensibility/hooks/types.ts)
- [`../src/extensibility/custom-tools/types.ts`](../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)

## 1. 发现流与规则注册

在创建会话时,`createAgentSession()` 加载已发现的规则,构造 `TtsrManager`,并通过 `bucketRules(...)` 对规则进行分桶:

```ts
const ttsrSettings = settings.getGroup("ttsr");
const ttsrManager = new TtsrManager(ttsrSettings);
const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd });
const { rulebookRules, alwaysApplyRules } = bucketRules(
  rulesResult.items,
  ttsrManager,
  {
    builtinRules: ttsrSettings.builtinRules,
    disabledRules: ttsrSettings.disabledRules,
  },
);
```

`bucketRules(...)` 会丢弃 `ttsr.disabledRules` 中列出的规则名;当 `ttsr.builtinRules === false` 时丢弃内嵌的 `builtin-defaults` 规则;注册被接受的 TTSR 规则,然后将剩余规则路由到 always-apply/rulebook(始终应用/规则书)分桶。

### 注册前去重行为

`loadCapability("rules")` 按 `rule.name` 去重,采用先到先得语义(提供商优先级高的优先)。被遮蔽的重复项在 TTSR 注册前被移除。

### `TtsrManager.addRule()` 行为

以下情况会跳过注册:

- TTSR 被禁用(`ttsr.enabled === false`)
- `rule.condition`(正则)与 `rule.astCondition`(ast-grep 模式)均缺失,或所有正则条件均编译失败且不存在非空 AST 条件
- 同名 `rule.name` 的规则已在本管理器中注册
- 解析后的规则作用域排除了所有被监控的流

无效的正则条件与不可达的作用域会作为警告记录并被忽略,会话启动继续执行。AST 解析/匹配失败会在尝试匹配时记录,并计为不匹配。如果 TTSR 规则定义了 `globs`,这些 glob 会被编译为匹配时的全局文件路径门槛。

未显式指定 `scope` 时,规则监控助手文本与所有工具参数,但不监控思考(thinking)。显式作用域标记可以启用 `text`、`thinking`、任意工具(`tool`/`toolcall`)、具名工具,以及可选的按工具路径 glob。

### AST 条件(`astCondition`)

AST 条件仅在工具暴露了重建的 `matcherDigest` 或按文件的 `matcherEntries` 时,对工具参数流求值,并且仅在候选路径提供了可用于语言推断的文件扩展名时生效。内置的 edit/write 工具提供了这些表面,但协调器会从活动工具中泛化地解析它们。

快照是携带源内容的有效载荷,而非完整的预期文件:预先存在的目标内容不可见,除非调用重复了它。当前的编辑模式暴露了 replace 的 `new_string`、JSON patch/hashline/apply-patch 形式的新增行,以及 create 形式的完整内容;write 暴露其全部 `content`。多文件 hashline/apply-patch 调用被拆分为独立的 `{ path, digest }` 条目,因此 AST 语言、路径作用域/globs、缓冲区与匹配均按文件求值。匹配通过原生 `astMatch` 在内存中完成,使用 Smart 严格度。

### 设置门控

`TtsrSettings.enabled` 对管理器进行门控:当 `ttsr.enabled === false` 时,`addRule()` 拒绝注册,`checkDelta()`/`checkSnapshot()`/`checkAstSnapshot()`/`hasRules()`/`hasAstRules()` 全部返回空/假,因此不会运行任何匹配。

设置省略时管理器的默认值:

| 设置            | 默认值                                          |
| --------------- | ------------------------------------------------ |
| `enabled`       | `true`                                           |
| `contextMode`   | `"discard"`                                      |
| `interruptMode` | `"always"`                                       |
| `repeatMode`    | `"once"`                                         |
| `repeatGap`     | `10` 个已完成的轮次                              |
| `builtinRules`  | `true`(由 `bucketRules` 消费,不参与匹配)          |
| `disabledRules` | `[]`(由 `bucketRules` 消费,不参与匹配)            |

## 2. 流式监控生命周期

TTSR 检测由 `AgentSession.#handleAgentEvent` 委托给会话拥有的 `TtsrCoordinator`。

### 轮次开始

在 `turn_start` 时,流缓冲区被重置:

- `ttsrManager.resetBuffer()`

### 流进行中(`message_update`)

当助手更新到达且存在规则时:

- 监控 `text_delta`、`thinking_delta` 与 `toolcall_delta`
- 按来源或工具调用流键隔离缓冲区
- 如果活动工具暴露了按文件的 `matcherEntries`,则将每个文件作用域缓冲区替换为其摘要并调用 `checkSnapshot`;否则在可用时使用单个 `matcherDigest` 快照,回退到通过 `checkDelta` 追加原始增量
- 当存在 AST 规则时,对相同的重建按文件或单个快照运行 `checkAstSnapshot`;同一流键连续相同的快照会被跳过

`checkDelta()`/`checkSnapshot()` 遍历已注册的规则,返回所有通过作用域、全局路径 glob、正则条件与重复策略检查的匹配规则。`checkAstSnapshot()` 应用相同的作用域/路径/重复门控,从候选文件路径推断语言,然后测试每个候选规则的 AST 模式。正则与 AST 匹配数组送入同一个触发决策处理器。

## 3. 触发决策与立即中止路径

每个规则的 `interruptMode` 在存在时覆盖全局设置:

- `always`:中断任何匹配的来源
- `prose-only`:仅中断 text/thinking 匹配
- `tool-only`:仅中断工具匹配
- `never`:从不中断

如果没有匹配的规则中断,处理将遵循下面按来源区分的延迟路径。

当一条或多条规则匹配且至少一条匹配的规则允许中断时:

1. 匹配的规则去重后进入协调器的待处理注入。
2. 设置待中止标志,并创建 TTSR 恢复门。
3. 立即调用 `agent.abort()`。对于工具匹配,中止原因被限定到该工具调用 id,因此兄弟调用会收到单独的 `TTSR interrupt on another tool call` 原因。
4. 异步发出 `ttsr_triggered`(fire-and-forget,即发即忘)。
5. 通过提示词后任务调度器以 50ms 延迟调度重试工作,并标记当前提示词代次与重试令牌。

中止不会被扩展回调阻塞。

## 4. 重试调度、上下文模式与提醒注入

在 50ms 超时后,调度任务首先验证其重试令牌、提示词代次、待中止状态与目标助手消息仍然有效。如果任何检查失败,它清除待处理的 TTSR 状态并解析恢复门而不重试。否则它会:

1. 清除待中止标志与按工具提醒桶
2. 读取 `ttsrManager.getSettings().contextMode`
3. 如果 `contextMode === "discard"`,用 `agent.replaceMessages(...slice(0, targetAssistantIndex))` 丢弃目标的部分助手输出
4. 使用 `ttsr-interrupt.md` 从待处理规则构建注入内容
5. 追加一条隐藏的运行时自定义消息,并持久化匹配的 `custom_message` 条目,包含 `customType: "ttsr-injection"` 与 `details.rules`
6. 通过 `ttsr_injection` 条目标记/持久化这些规则名,并调用 `agent.continue()` 重试生成

模板载荷为:

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
...
{{content}}
</system-interrupt>
```

待处理注入在生成内容后清除。

### `contextMode` 对部分输出的行为

- `discard`:重试前移除部分/已中止的助手消息。
- `keep`:部分助手输出保留在会话状态中;提醒附加在其后。

### 非中断匹配

非中断匹配按 `matchContext.source` 区分:

- **`source === "tool"`(工具来源匹配)。** 该规则被分桶到 `TtsrCoordinator.#perToolInjections`,以匹配的工具调用的 `id` 为键,并立即在内存中标记为已注入。**没有**延迟的后续轮次,流也不会被中止。当工具实际产生结果时,`afterToolCall` 钩子将一个渲染后的 `ttsr-tool-reminder.md` 块前置到 `ctx.result.content`(在工具自身内容之前插入一个 `text` 块),并持久化包含已消费规则名的 `ttsr_injection` 条目。模板载荷为:

  ```xml
  <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
  ...
  {{content}}
  </system-reminder>
  ```

- **`source === "text"` / `"thinking"`(散文来源匹配)。** 规则进入待处理注入队列。在成功的无错误、未中止的助手消息之后,`TtsrCoordinator` 通过 `agent.followUp()` 将隐藏的 `ttsr-injection` 自定义消息排队,并调度 1ms 后的继续。这些延迟的非中断散文匹配不会发出 `ttsr_triggered`;该事件仅为实际的中断路径与非中断的按工具提醒发出。

在一个匹配批次内,每条规则恰好附加到一个兄弟工具调用:如果多个兄弟调用都能满足同一条规则,第一个认领的桶胜出。多条不同规则仍可合并到同一个工具调用上。

#### 对工具作者与转录阅读者的影响

- 工具自身的 `toolResult` 内容原样保留;提醒作为附加的前导文本块被**前置**。假定 `content[0]` 是工具主要输出的渲染器必须跳过任何文本以 `<system-reminder reason="rule_violation"` 开头的块(或按包装标签过滤),才能找到真正的载荷。
- 提醒位于工具结果带内,不是独立的 `custom_message`/`ttsr-injection` 条目。查找工具来源规则上非中断 TTSR 活动的转录阅读者必须检查工具结果(以及持久化的 `ttsr_injection` 条目列表),而不只是合成注入条目。
- 单个工具结果可能携带多条规则的提醒,渲染后的模板之间以空行连接。
- 如果匹配的工具运行前助手消息以 `stopReason === "aborted"` 或 `"error"` 结束,待处理的按工具桶会被清除,且不持久化 `ttsr_injection` 条目。匹配时的内存注入记录**不会**回滚:在 `once` 模式下它保持抑制直到会话重载;在 `after-gap` 模式下它在配置数量的已完成后轮次后重新符合条件。由于未送达的匹配未被持久化,重载也会使其再次符合条件。

## 5. 重复策略与间隔逻辑

`TtsrManager` 跟踪 `#messageCount` 与每条规则的 `lastInjectedAt`。

### `repeatMode: "once"`

规则在拥有注入记录后只能触发一次。

### `repeatMode: "after-gap"`

规则仅在以下情况才能重新触发:

- `messageCount - lastInjectedAt >= repeatGap`

`messageCount` 在 `turn_end` 时递增,因此间隔以已完成的轮次计,而非流块。

## 6. 事件发出与扩展/钩子表面

### 会话事件

`AgentSessionEvent` 包含:

```ts
{ type: "ttsr_triggered"; rules: Rule[] }
```

### 扩展运行器

`#emitSessionEvent()` 将事件路由到:

- 扩展监听器(`ExtensionRunner.emit({ type: "ttsr_triggered", rules })`)
- 本地会话订阅者

### 钩子与自定义工具类型

- 扩展 API 暴露 `on("ttsr_triggered", ...)`
- 钩子 API 暴露 `on("ttsr_triggered", ...)`
- 自定义工具接收 `onSession({ reason: "ttsr_triggered", rules })`

### 交互模式的渲染差异

交互模式使用 `session.isTtsrAbortPending` 来抑制在 TTSR 中断期间将已中止的助手停止原因显示为可见失败,并在事件到达时渲染 `TtsrNotificationComponent`。

## 7. 持久化与恢复状态(当前实现)

`SessionManager` 持久化已注入规则状态:

- 条目类型:`ttsr_injection`
- 追加 API:`appendTtsrInjection(ruleNames)`
- 查询 API:`getInjectedTtsrRules()`
- 上下文重建包含 `SessionContext.injectedTtsrRules`

`TtsrManager` 通过 `restoreInjected(ruleNames)` 支持恢复。

当前运行时接线:

- 中断的注入追加隐藏的 `custom_message`(含 `customType: "ttsr-injection"`)并追加 `ttsr_injection` 条目
- 延迟的非中断散文来源注入在其排队的自定义消息到达 `message_end` 时被标记/持久化
- 非中断工具来源匹配在分桶时于内存中标记,仅当匹配工具产生结果时才从 `afterToolCall` 持久化
- `createAgentSession()` 将 `existingSession.injectedTtsrRules` 恢复到管理器中

因此,注入规则的抑制状态从当前分支路径恢复。持久化存储的是名称而非原始的轮次年龄:`restoreInjected()` 将每条恢复的规则记录在消息计数为零处。在 `repeatMode: "after-gap"` 下,恢复的规则在 `repeatGap` 个新完成的轮次后重新符合条件,无论重载前经历了多少轮次。

## 8. 竞态边界与排序保证

### 中止与重试回调

- 从 TTSR 处理器的角度看,中止是同步的(`agent.abort()` 被立即调用)
- 重试由定时器延迟(`50ms`)
- 扩展通知是异步的,并且有意在中止/重试调度前不被等待

### 同一流窗口内的多个匹配

`checkDelta()` 返回该作用域缓冲区的所有当前匹配且符合条件的规则。待处理注入在注入前按规则名去重。

### 在中止与继续之间

在定时器窗口期间,状态可能发生变化。重试受重试令牌、提示词代次、中止状态与目标消息身份的保护;过期的任务会清除待处理状态并解析其门。`agent.continue()` 的失败会被捕获并同样解析门。

## 9. 边界情况汇总

- 无效的 `condition` 正则:跳过并发出警告;其他条件/规则继续。
- 能力层的重复规则名:低优先级的重复项在注册前被遮蔽。
- 管理器层的重复名称:第二次注册被忽略。
- `ttsr.disabledRules`:列出的名称在 TTSR 注册前被丢弃,不会通过 always-apply/rulebook 分桶暴露。
- `ttsr.builtinRules: false`:内嵌的 `builtin-defaults` 规则在 TTSR 注册前被丢弃;用户/项目规则仍然加载。
- TTSR 规则上的 `globs` 要求至少有一个候选文件路径匹配其规范化路径或基名。
- 默认作用域监控文本与工具,不监控思考。
- `contextMode: "keep"`:违规的部分输出可以在提醒重试前保留在上下文中。
- `interruptMode: "never"`:散文来源匹配在成功的助手消息后排入延迟的隐藏注入;工具来源匹配通过 `afterToolCall` 钩子将带内的 `<system-reminder>` 折入匹配工具调用的 `toolResult` 内容(不中断流,无独立后续轮次)。
- 当父助手消息以 `stopReason === "aborted"` 或 `"error"` 结束时,工具来源的非中断桶被清除。其匹配时的内存抑制保持,直到重复策略允许再次触发(或重载丢弃未持久化的记录)。
- 间隔后重复依赖于 `turn_end` 处的轮次计数递增;重载后,恢复的注入年龄从零重新开始。
