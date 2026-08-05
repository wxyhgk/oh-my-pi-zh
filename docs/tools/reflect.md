# reflect

> 在活动的长期记忆后端之上综合答案。

## 来源
- 入口:`packages/coding-agent/src/tools/memory-reflect.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/reflect.md`
- Hindsight 协作者:
  - `packages/coding-agent/src/hindsight/bank.ts` — 尽力而为的首次使用 bank/任务设置(`ensureBankExists`)。
  - `packages/coding-agent/src/hindsight/state.ts` — 会话状态、共享 bank 作用域、recall/reflect 配置。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `reflect` 调用和错误映射。
- Mnemopi 协作者:
  - `packages/coding-agent/src/mnemopi/state.ts` — 作用域本地召回和上下文格式化。
  - `docs/tools/retain.md` — 共享后端、存储、作用域和心智模型行为。

## 注册 / 可见性
- 工具元数据:`approval = "read"`、`strict = true`、`loadMode = "discoverable"`。
- 该工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册;对 `"off"` 和 `"local"` 不存在。
- 在带有显式工具列表的无限制会话中,注册自动包含共享 `recall`/`retain`/`reflect` 集合。受限列表不会被扩展。
- 在普通 `tools.xdev` 会话中,可发现的构建工具可能以 `xd://reflect` 形式呈现;显式请求的工具保持顶层。
- 执行为一次性,且不发出进度更新。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `query` | `string` | 是 | 要从长期记忆回答的问题。 |
| `context` | `string` | 否 | 额外指引。Hindsight 将其作为 `context` 发送;Mnemopi 将修剪后的上下文以 `Additional context:` 追加到召回查询。 |

## 输出
返回一次性工具结果。

Hindsight:
- `content[0].type = "text"`
- `content[0].text = response.text?.trim() || "No relevant information found to reflect on."`
- `details = {}`
- 工具直接返回 Hindsight 服务器的综合文本;它不暴露原始召回命中。

Mnemopi:
- 如果不存在作用域召回结果:`content[0].text = "No relevant information found to reflect on."`
- 否则:`content[0].text = "Based on recalled memories:\n\n<formatted context>"`
- `details = {}`
- 本地路径执行召回加格式化;它不调用综合模型或单独的综合端点。因此其结果可能是原始召回上下文,而不是混合答案。

## 流程
1. `MemoryReflectTool.createIf(...)` 在 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时暴露工具。
2. `execute(...)` 在 `untilAborted(...)` 下运行。
3. 如果后端是 `mnemopi`:
   - 读取 `session.getMnemopiSessionState()` 并在后端未启动时抛错;
   - 如果 `context` 有非空白内容,用 `<query>\n\nAdditional context:\n<context>` 召回;否则用 `query` 召回;
   - 调用 `state.recallResultsScoped(...)`,使用与 `recall` 相同的本地作用域和合并行为;
   - 如果存在结果,通过 `state.formatContextScoped(...)` 渲染,并加前缀 `Based on recalled memories:`。
4. 如果后端是 `hindsight`:
   - 读取 `session.getHindsightSessionState()` 并在后端未启动时抛错;
   - 用当前 `bankId`、配置和会话状态的 `banksSet` 调用 `ensureBankExists(...)`;
   - `ensureBankExists(...)` 尽力而为地对每个会话状态的每个 bank 执行一次 `PUT /v1/default/banks/{bank_id}`(`createBank`),带可选 `reflect_mission` / `retain_mission`;失败被吞掉;
   - 用 `query`、可选 `context`、配置的召回预算和 bank 作用域标签筛选调用 `state.client.reflect(...)`;
   - `HindsightApi.reflect(...)` POST `/v1/default/banks/{bank_id}/reflect`,调用方省略时默认自己的预算为 `"low"`;此工具始终传递配置的预算;
   - 空白或仅空白响应替换为 `No relevant information found to reflect on.`
5. 后端失败用 `logger.warn("reflect failed", ...)` 记录,需要时以 `Error` 实例重新抛出。

## 模式 / 变体
- Hindsight 工具路径:一个远程 reflect 请求,可选由 `context` 聚焦。
- Mnemopi 工具路径:一次本地作用域召回,随后进行上下文格式化。
- Hindsight bank 作用域:
  - `global` — 无标签筛选。
  - `per-project` — 每个项目标签独立 bank id(git 主检出根 basename;仓库外的 cwd basename)。
  - `per-project-tagged` — 共享 bank id 加上 `project:<project label>` 筛选,`tagsMatch = "any"`。
- Mnemopi bank 作用域:
  - `global` — 读取共享 bank。
  - `per-project` — 读取由绝对 cwd basename 加上该 cwd 的哈希派生的 bank。
  - `per-project-tagged` — 读取 cwd 派生的项目 bank 和共享 bank,然后合并结果。
  - 每项目模式也可能包含启动时发现的安全 cwd 匹配遗留 bank。
- 会话作用域:读取跨会话记忆数据,但不持久化本地输出。子代理别名使用父级的后端作用域。

## 副作用
- 网络
  - Hindsight:`ensureBankExists(...)` 的可选 `PUT /v1/default/banks/{bank_id}`,然后 `POST /v1/default/banks/{bank_id}/reflect`。
  - Mnemopi:无,除非配置的嵌入或 LLM 提供者在召回期间被本地运行时使用。
- 会话状态
  - 仅读取会话持有的后端作用域和配置。不更新 `lastRecallSnippet`、Hindsight 心智模型缓存或 retain 队列。
- 后台工作 / 取消
  - 如果工具调用信号被取消,通过 `untilAborted(...)` 中止。

## 限制与上限
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`;默认 `memory.backend` 是 `"off"`。
- 工具级参数:仅 `query` 必填;`context` 可选。两者都是普通字符串,无 schema 级最小长度。
- Hindsight 预算来自 `hindsight.recallBudget`,默认 `"mid"`。
- Hindsight `reflect` 此处无客户端 token 上限参数;其请求截止时间默认为 `hindsight.reflectTimeoutMs = 120_000`。
- Hindsight bank 初始化跟踪每个会话状态最多 `MISSION_SET_CAP = 10_000` 个 bank id,然后丢弃排序集合的一半。
- Mnemopi 结果数由 `mnemopi.recallLimit` 限制,默认 `8` 且运行时限制为至少 1;每个召回内容预览默认上限为 500 字符。

## 错误
- 当 `memory.backend == "mnemopi"` 但无状态存在时,抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但无状态存在时,抛出 `Hindsight backend is not initialised for this session.`。
- Hindsight HTTP、fetch 和超时失败变为 `HindsightError`;HTTP 错误在可用时包含 `statusCode` 和解析的 `details`。
- Hindsight `ensureBankExists(...)` 失败在 debug 级别记录并对调用方隐藏;只有后续的 reflect 请求可以可见地失败。
- Mnemopi 召回按目标捕获失败并记录。健康目标仍贡献;如果每个尝试的目标都失败,抛出原始错误或多 bank `AggregateError`,而不是转换为无信息文本。
- 工具捕获的非 `Error` 失败在重新抛出前规范化为 `new Error(String(err))`。

## 注释
- 共享后端细节在 `docs/tools/retain.md`:存储、子代理别名、bank 作用域、种子心智模型和提示词注入。
- Hindsight `reflect` 不直接读取缓存的 `<mental_models>` 块。它基于 bank 内容查询 Hindsight 服务器。同一会话可能单独在开发指令中有心智模型上下文。
- Hindsight reflect 和 retain 任务是 bank 级服务器设置,不是每请求负载。工具仅在 reflect 前尽力而为地确保它们。
- Mnemopi `reflect` 是本地召回加格式化。它不实现通用模型面向 `reflect` 提示词承诺的综合。
