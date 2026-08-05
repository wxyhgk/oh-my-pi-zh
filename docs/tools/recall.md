# recall

> 搜索活动的长期记忆后端并返回匹配的记忆。

## 来源
- 入口:`packages/coding-agent/src/tools/memory-recall.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/recall.md`
- Hindsight 协作者:
  - `packages/coding-agent/src/hindsight/state.ts` — 会话状态、recall 查询默认值、提示词侧自动召回。
  - `packages/coding-agent/src/hindsight/content.ts` — 结果格式化和 UTC 时间戳格式化。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `recall` 调用和错误映射。
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id 和标签筛选作用域。
- Mnemopi 协作者:
  - `packages/coding-agent/src/mnemopi/state.ts` — 带 id 的作用域本地召回和结果格式化。
  - `packages/coding-agent/src/mnemopi/config.ts` — 本地 bank 作用域和召回限制。
  - `docs/tools/retain.md` — 共享后端、存储、作用域和保留行为。

## 注册 / 可见性
- 工具元数据:`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。
- 该工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册;对 `"off"` 和 `"local"` 不存在。
- 在带有显式工具列表的无限制会话中,注册自动包含任一受支持后端的共享 `recall`/`retain`/`reflect` 集合。受限列表不会被扩展。
- 在普通 `tools.xdev` 会话中,可发现的构建工具可能以 `xd://recall` 形式呈现;显式请求的工具保持顶层。
- 执行为一次性。该工具不发出流式参数/结果更新。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `query` | `string` | 是 | 自然语言搜索查询。除 Mnemopi `per-project-tagged` 可能运行内部共享 bank 回退查询外,工具原样传递。 |

## 输出
返回一次性工具结果。

当存在匹配时:
- `content[0].type = "text"`
- `content[0].text = "Found <n> relevant memory/memories (as of YYYY-MM-DD HH:MM UTC):\n\n<bullet list>"`
- `details = {}`

Hindsight 项目符号格式来自 `formatMemories(...)`:
- 每个项目符号为 `- <text> [<type>] (<mentioned_at>)`;类型和时间戳后缀仅在这些字段存在时出现。

Mnemopi 项目符号格式来自 `formatScopedRecallWithIds(...)`:
- 每个项目符号为 `- <content> (id: <id>) [<source>] (<YYYY-MM-DD>) c:<score>`;不可用的 id 渲染为 `(id unavailable)`,source、date 和 score 缺失时省略。
- Mnemopi 召回内容默认截断为 500 字符的预览。截断的预览以 `…` 结尾;在整体 `memory_edit update` 之前用 `read memory://<id>` 获取完整行。
- 尽管内部召回行携带 `truncated` 和 `full_length`,此工具返回格式化的文本且 `details = {}`,不暴露这些字段。

当无匹配时:
- `content[0].text = "No relevant memories found."`
- `details = {}`
- `useless = true`,允许调用方/渲染器将结果视为非贡献上下文。

## 流程
1. `MemoryRecallTool.createIf(...)` 在 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时暴露工具。
2. `execute(...)` 将操作包装在 `untilAborted(...)` 中。
3. 如果后端是 `mnemopi`:
   - 读取 `session.getMnemopiSessionState()` 并在后端未启动时抛错;
   - 调用 `state.recallResultsScoped(params.query)`;
   - 作用域召回用 `recallEnhanced(query, recallLimit, { includeFacts: true, channelId: bank })` 查询每个解析的召回 bank,按 id/内容合并/去重结果、排序,并截断到 `recallLimit`;
   - 每项目模式可能包含安全的遗留 bank,其工作记忆行全部属于活动绝对 cwd;启动扫描上限为 64 个候选 bank 目录;
   - 在 `per-project-tagged` 中,共享 bank 可能收到一次额外的回退查询,剥离项目 bank 字面 token,使广泛的全局记忆仍能匹配;
   - 结果以 id 格式化,供后续整行读取和 `memory_edit` 使用。
4. 如果后端是 `hindsight`:
   - 读取 `session.getHindsightSessionState()` 并在后端未启动时抛错;
   - 用 `bankId`、query、配置的 `budget`、`maxTokens`、`types` 和 bank 作用域标签筛选调用 `state.client.recall(...)`;
   - `HindsightApi.recall(...)` POST `/v1/default/banks/{bank_id}/memories/recall`;
   - 结果用 `formatMemories(...)` 格式化为纯文本列表。
5. 后端失败用 `logger.warn("recall failed", ...)` 记录,需要时以 `Error` 实例重新抛出。

## 模式 / 变体
- 工具路径:显式仅查询召回。它不从最近轮次组合上下文。
- 后端自动召回在 `HindsightSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` 和 `MnemopiSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` 中有更丰富的查询组合路径。
- Hindsight bank 作用域:
  - `global` — 无标签筛选。
  - `per-project` — 每个项目标签独立 bank id(git 主检出根 basename;仓库外的 cwd basename)。
  - `per-project-tagged` — 共享 bank id 加上 `project:<project label>` 筛选,`tagsMatch = "any"`,使带项目标签和无标签的全局记忆都能浮现。
- Mnemopi bank 作用域:
  - `global` — 召回读取共享 bank。
  - `per-project` — 召回读取由绝对 cwd basename 加上该绝对 cwd 的哈希派生的 bank。
  - `per-project-tagged` — 召回读取 cwd 派生的项目 bank 和共享 bank,然后合并结果。
  - 每项目模式也可能读取安全识别的遗留仅 cwd bank,以恢复早期 git 根派生方案下创建的记忆。
- 会话作用域:读取跨会话记忆数据,使用活动会话的缓存配置和作用域。子代理别名使用父级的后端作用域。

## 副作用
- 网络
  - Hindsight:`POST /v1/default/banks/{bank_id}/memories/recall`。
  - Mnemopi:无,除非配置的本地运行时提供者在召回期间执行嵌入/LLM 工作。
- 会话状态
  - 显式工具路径成功时无。与后端自动召回不同,此工具不更新 `lastRecallSnippet` 或刷新系统提示词。
- 后台工作 / 取消
  - 如果工具调用信号被取消,通过 `untilAborted(...)` 中止。

## 限制与上限
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`;默认 `memory.backend` 是 `"off"`。
- Hindsight 客户端对原始 `HindsightApi.recall(...)` 的默认预算为 `"mid"`;此工具从配置覆盖。
- Hindsight 召回设置:
  - `hindsight.recallBudget = "mid"`
  - `hindsight.recallMaxTokens = 1024`
  - `hindsight.recallTypes = ["world", "experience"]`
  - `hindsight.recallTimeoutMs = 30_000`
- Mnemopi 召回设置:
  - `mnemopi.recallLimit = 8`(运行时限制为至少 1)
  - `mnemopi.scoping = "per-project"`
  - 每个结果的内容预览上限为 500 字符
- 显式工具路径不应用 `hindsight.recallContextTurns`、`hindsight.recallMaxQueryChars`、`mnemopi.recallContextTurns` 或 `mnemopi.recallMaxQueryChars`;这些上限只影响后端自动召回查询组合。

## 错误
- 当 `memory.backend == "mnemopi"` 但无状态存在时,抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但无状态存在时,抛出 `Hindsight backend is not initialised for this session.`。
- Hindsight HTTP、fetch 和超时失败变为 `HindsightError`;HTTP 错误在可用时包含 `statusCode` 和解析的 `details`。
- Mnemopi 召回按目标捕获失败并记录。健康目标仍贡献结果;如果每个尝试的目标都失败,抛出原始错误(单目标)或带 bank 详情的 `AggregateError`(多目标),而不是转换为空结果。
- 工具捕获的非 `Error` 失败在重新抛出前规范化为 `new Error(String(err))`。

## 注释
- 共享后端细节在 `docs/tools/retain.md`:存储、子代理别名、bank 作用域、任务设置和心智模型行为。
- Hindsight 心智模型不由此工具获取。它们可能已存在于 Agent 的开发指令中,因为后端单独缓存 `<mental_models>` 块与召回结果。
- Mnemopi 开发指令可能包含来自自动召回的 `<memories>` 块;此显式工具不更新该块。
- 工具返回记忆命中;它不跨它们综合。远程 Hindsight 综合用 `reflect`;Mnemopi 的 `reflect` 变体是本地召回加格式化。
