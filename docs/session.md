# 会话存储与条目模型

本文档是 coding-agent 会话在运行时如何表示、持久化、迁移和重建的权威说明。

## 范围

涵盖:

- 会话 JSONL 格式与版本控制
- 条目分类与树语义(`id`/`parentId` + 叶指针)
- 加载旧文件或损坏文件时的迁移/兼容行为
- 上下文重建(`buildSessionContext`)
- 持久化保证、失败行为、截断/blob 外部化
- 存储抽象(`FileSessionStorage`、`MemorySessionStorage`)及相关的工具函数

不涵盖 `/tree` UI 渲染行为,只涉及影响会话数据的语义。

## 实现文件

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — 编排:树/叶、追加、持久化、blob、生命周期工厂
- [`src/session/session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts) — 条目/头部类型、`SessionEntry` 联合类型、`CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../packages/coding-agent/src/session/session-migrations.ts) — 版本迁移
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — 文件加载 + blob 引用解析
- [`src/session/session-context.ts`](../packages/coding-agent/src/session/session-context.ts) — `buildSessionContext`
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — 截断 + 图片 blob 外部化
- [`src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts) — 磁盘布局、目录编码、终端面包屑
- [`src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts) — 发现(列出/最近/解析)
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts) — 存储抽象
- [`src/session/session-title-slot.ts`](../packages/coding-agent/src/session/session-title-slot.ts) — 固定宽度的当前标题槽
- [`src/session/indexed-session-storage.ts`](../packages/coding-agent/src/session/indexed-session-storage.ts) — 本地索引 + 有序远程后端存储适配器
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) — 自定义消息转换器
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — 内容寻址的 blob 存储
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) — 提示词历史(独立子系统)

## 磁盘布局

默认的文件会话位置:

```text
~/.omp/agent/sessions/<scope>-<project-basename>-<sha256(canonical-cwd)>/<timestamp>_<sessionId>.jsonl
```

`<scope>` 为 `home`、`tmp` 或 `abs`,在规范化 cwd 之后选择(因此符号链接别名共享同一个桶)。可读的 basename 会被清理并限制在 80 个字符以内;完整的规范化 cwd 摘要避免了旧的替换分隔符方案可能产生的冲突。

访问时,旧的 home 相对(`-<relative>`)、tmp 相对(`-tmp-<relative>`)和绝对(`--<encoded-absolute>--`)桶会被尽力迁移到哈希桶。发生冲突的旧桶会在迁移前根据每个会话头部中记录的 cwd 拆分。

Blob 存储位置:

```text
~/.omp/agent/blobs/<sha256>
```

终端面包屑文件写入:

```text
~/.omp/agent/terminal-sessions/<terminal-id>
```

面包屑内容是原始 cwd 和会话文件路径,外加可选的第三行 `fresh`。fresh 面包屑保留了一个 `/new` 边界,其惰性创建的 JSONL 文件尚不存在,从而防止 `continueRecent()` 重新打开上一个会话。写入是同步、有序且尽力而为的。

## 文件格式

会话文件是 JSONL:每行一个 JSON 对象。当前文件物理上以一个固定宽度、256 字节的 `type: "title"` 槽开头,后面跟会话头部,然后是 `SessionEntry` 值。旧版文件可能直接以头部开头。加载器会剥离物理槽,并将其当前标题/来源折叠进逻辑头部。

- 逻辑上的第一条记录始终是会话头部(`type: "session"`)。
- 其余逻辑记录是 `SessionEntry` 值。
- 条目在运行时只追加;分支导航移动指针(`leafId`)而不是修改现有条目。

### 头部(`SessionHeader`)

```json
{
  "type": "session",
  "version": 3,
  "id": "1f9d2a6b9c0d1234",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "additionalDirectories": ["/work/shared"],
  "previousSessionFiles": ["/old/location/session.jsonl"],
  "providerPromptCacheKey": "optional inherited cache identity",
  "parentSession": "optional lineage marker"
}
```

说明:

- `additionalDirectories` 记录 `cwd` 之外已规范化、去重的工作区根目录。
- `previousSessionFiles` 在成功移动后记录之前的绝对位置。
- `providerPromptCacheKey` 为符合条件的完整 fork 携带继承的提供商提示词缓存身份。
- `parentSession` 是一个不透明的谱系字符串。当前代码根据流程(`fork`、`forkFrom`、`createBranchedSession` 或显式 `newSession({ parentSession })`)写入会话 id 或会话路径。将其视为元数据,而不是类型化的外键。

- `titleSource` 为 `auto` 或 `user`;自动重命名不能覆盖用户标题。

### 条目基类(`SessionEntryBase`)

所有非头部条目都包含:

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

`parentId` 对于根条目可以是 `null`(首次追加,或 `resetLeaf()` 之后)。

## 条目分类

`SessionEntry` 是以下类型的联合:

- `message`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `reset_boundary`
- `custom`
- `custom_message`
- `label`
- `title_change`
- `ttsr_injection`
- `credential_pin`
- `session_init`
- `mode_change`

### `message`

直接存储一个 `AgentMessage`。

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "timestamp": 1760000000000
  }
}
```

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role` 是可选的;缺失时在上下文重建中被视为 `default`。

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier` 是按提供商家族划分的映射,键为 `openai`/`anthropic`/`google`(每个值为 `auto`/`default`/`flex`/`scale`/`priority`),没有活跃服务档位时为 `null`。旧条目存储的单个字符串(`"flex"`、`"openai-only"`、`"claude-only"` 等)在读取时被规范化为该映射。

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

`configured` 还可以保留用户选择的选择器(`"auto"` 或具体的思考级别)。读取旧条目的代码回退到 `thinkingLevel`。

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

如果从根分支(`branchFromId === null`),`fromId` 是字面字符串 `"root"`。

### `reset_boundary`

由 `/clear` 追加的无载荷标记。折叠后的实时记录和重建的模型上下文从最近的有效边界之后开始;完整历史的记录导出仍会保留其之前的条目。

### `custom`

核心子系统或扩展拥有的不透明、非 LLM 记录。`buildSessionContext` 不会直接将它们转换为模型消息,但子系统特定的重放代码可以消费 `customType` 值来恢复运行时状态或诊断被中断的轮次。

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "com.example.my-extension.state",
  "data": { "state": 1 }
}
```

当前核心拥有的值包括:

| `customType`             | `data` schema                                                                                                                                                                                                                                            | 写入方与消费方                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_execution_start`   | `{ toolCallId: string, toolName: string, startedAt: string, args?: { command?: string, path?: string }, intent?: string }`                                                                                                                               | `AgentSession` 在工具实现启动前立即写入一个标记。退出诊断会将其与助手工具调用和工具结果结合,以重建仍未完成的调用。参数摘要是截断的投影;读取时接受旧的完整参数对象。                                                                                                                                     |
| `session_exit`           | `{ reason: string, kind: "normal" \| "signal" \| "fatal" \| "process_exit", recordedAt: string, pendingToolCalls?: Array<{ toolCallId?: string, toolName: string, args?: unknown, intent?: string, assistantTimestamp?: number, startedAt?: string }> }` | 正常释放和事后清理会在会话有助手历史或未完成的工具调用时记录退出。写入方立即调用 `flushSync()`,以便后续进程可以检查最后一次持久化的轮次;刷新失败会被记录日志。恢复诊断消费最近的有效记录。                                                                                                                   |
| `user_todo_edit`         | `{ phases: TodoPhase[] }`                                                                                                                                                                                                                                | SDK/UI 的 todo 编辑会持久化完整的阶段快照。Todo 恢复会向后扫描最近的快照(或成功的 `todo` 工具结果)并恢复其阶段。                                                                                                                                                                                           |
| `vibe-session-lifecycle` | Version-1 event with `{ version: 1, id, ownerId, parentSessionId, action, ... }`; `spawn` adds `cli`, `agent`, `childSessionFile`, and `createdAt`; turn events add `turn`; tombstone events add `reason`.                                               | Vibe 运行时持久化并重放子会话派生、轮次开始/结束、墓碑及墓碑撤销的转换,以恢复拥有的子会话和进行中的状态。无效或超出范围的事件会被忽略。                                                                                                                                                                    |
| `autoresearch-control`   | `{ mode: "on" \| "off" \| "clear", goal?: string }`                                                                                                                                                                                                      | 内置的 autoresearch 命令写入模式/目标变更,实验限制关闭时写入 `mode: "off"`。`reconstructControlState()` 在恢复时重放有效记录,以恢复 autoresearch 是否激活及其目标;`clear` 移除目标。                                                                                                                         |

恢复时,如果非终态对话尾部之后存在一条有效的 `session_exit`,加载器会追加一条 `stopReason: "aborted"` 的合成助手消息,并重建展示/Agent 上下文。正常退出只有记录了未完成的工具调用时才会触发该转换;异常退出类型可以不带该列表就触发。这可以防止恢复的记录把被中断的轮次呈现为仍然活跃。

表中的字符串为其核心消费方保留。扩展不得使用它们。扩展记录请使用带命名空间的标识符,如反向域名或包限定的名称;发生冲突时,核心重放逻辑可能把扩展数据解释为生命周期状态。未知的命名空间值对核心会话上下文重建保持不透明。

### `custom_message`

扩展提供的、确实参与 LLM 上下文的消息。`content` 可以是字符串或文本/图片内容块,`attribution` 记录是由用户还是 Agent 发起的。

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined` 会清除 `targetId` 的标签。

### `title_change`

会话重命名的只追加审计条目。它记录 `title`、`source`(`auto` 或 `user`),以及可选的 `previousTitle` 和 `trigger`。当前标题也会在固定宽度的标题槽中更新,这样列出会话就不需要重写整个文件。

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `credential_pin`

记录提供商和一个假名的 SHA-256 账户/作用域哈希,用于将恢复的 OAuth 流量重新固定到服务账户,并保持账户作用域的提示词缓存复用。它不存储原始账户身份;导出的哈希仍可关联,并非匿名。

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": "...",
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" },
  "outputSchemaMode": "strict",
  "restrictToolNames": true,
  "spawns": "*",
  "readSummarize": false
}
```

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFile": "/tmp/plan.md" }
}
```

## 版本与迁移

当前会话版本:`3`。

### v1 -> v2

在头部 `version` 缺失或 `< 2` 时应用:

- 为每个非头部条目添加 `id` 和 `parentId`。
- 按文件顺序重建线性父链。
- 存在时将压缩字段 `firstKeptEntryIndex` 迁移为 `firstKeptEntryId`。
- 设置头部 `version = 2`。

### v2 -> v3

在头部 `version < 3` 时应用:

- 对于 `message` 条目:将旧的 `message.role === "hookMessage"` 重写为 `"custom"`。
- 设置头部 `version = 3`。

### 迁移触发与持久化

- 迁移在会话加载期间运行(`setSessionFile`)。
- 如果运行了任何迁移,内存中的表示会被标记为完整重写,而不是立即重写。
- 下一次持久化操作会先执行完整重写,再继续增量追加。

## 加载与兼容行为

`loadEntriesFromFile(path)` 的行为:

- 文件缺失(`ENOENT`)-> 返回 `[]`。
- 至少 8 MiB 的当前文件使用流式 JSONL 加载器;更小或非文件存储使用完整文本读取。
- 无法解析的行由宽松的 JSONL 解析器处理。
- 可选的固定宽度标题槽被移除并折叠进头部。
- 如果第一条逻辑记录不是有效的会话头部(`type !== "session"` 或缺少字符串 `id`)-> 返回 `[]`。

`SessionManager.setSessionFile()` 的行为:

- 加载器返回的 `[]` 被视为空/不存在的会话,并在该确切路径上替换为新的已初始化会话;其头部会立即物化。
- 有效文件被加载,必要时迁移,解析 blob 引用,然后建立索引。

## 树与叶语义

底层模型是只追加的树 + 可变的叶指针:

- 每个追加方法恰好创建一个新条目,其 `parentId` 为当前 `leafId`。
- 新条目成为新的 `leafId`。
- `branch(entryId)` 只移动 `leafId`;现有条目保持不变。
- `resetLeaf()` 将 `leafId` 设置为 `null`;下一次追加创建一个新的根条目(`parentId: null`)。
- `branchWithSummary()` 将叶设置为分支目标,并追加一个 `branch_summary` 条目。

`getEntries()` 按插入顺序返回所有非头部条目。正常操作中不会删除现有条目;重写会在更新表示(迁移、移动、定向重写辅助函数)的同时保留逻辑历史。

## 上下文重建(`buildSessionContext`)

`buildSessionContext(entries, leafId?, byId?, options?)` 解析发送给模型的内容。`options.transcript: true` 则改为构建展示用记录。完整记录模式在行内保留压缩;`collapseCompactedHistory` 只渲染当前压缩后的尾部,`keepDanglingToolCalls` 在轮次中途的 UI 重建期间保留仍在运行的工具调用。

算法:

1. 确定叶:
   - `leafId === null` -> 返回空上下文。
   - 显式 `leafId` -> 若找到该条目则使用它。
   - 否则回退到最后一条条目。
2. 沿 `parentId` 走到根,遇到重复的 id 即停止以限制损坏的循环,然后反转得到根->叶路径。
3. 在路径上推导运行时状态:
   - 来自最近 `thinking_level_change` 的已解析和已配置思考选择器
   - 来自最近 `service_tier_change` 的服务档位
   - 来自 `model_change` 条目的模型映射(`role ?? "default"`);在显式默认值出现之前,助手消息推断仅是旧版回退
   - 去重后的 `injectedTtsrRules`
   - 来自最近 `mode_change` 的 mode/modeData(默认 mode 为 `"none"`)
4. 选择输出边界:
   - 更晚的 `reset_boundary` 会将该边界之前的所有内容从模型上下文和折叠的实时记录中隐藏
   - 否则最近的压缩输出其摘要加上保留的/压缩后的消息(提供商原生的替换历史可能提供保留的模型上下文)
   - 完整记录导出保留重置前的历史,并按时间顺序渲染压缩
5. 将 `message`、`custom_message` 和 `branch_summary` 条目转换为消息。其他条目类型只影响重放状态或元数据。
6. 从重放中移除悬空的工具调用(除非为轮次中途的记录显式保留),中和重写轮次上的受保护推理元数据;从模型上下文中丢弃不安全的已中止/出错助手轮次及其配对的工具结果。

## 持久化保证与失败模型

### 持久化 vs 内存

- `SessionManager.create/open/continueRecent/forkFrom` -> 持久化模式(`persist = true`)。
- `SessionManager.inMemory` -> 使用 `MemorySessionStorage` 的非持久化模式(`persist = false`)。

### 写入管线

一旦越过惰性文件创建的门槛,已完成的条目会更新内存,并在追加调用中同步交给文件/内存存储。没有 `fsync`,因此保证覆盖软件崩溃,而非断电。流式部分文本在完整消息追加之前不会持久化。

- 新的普通会话在包含助手消息或调用方调用 `ensureOnDisk()` 之前,只保留在内存中。
- 在该门槛之前,条目保留在内存中;越过它会写入完整的标题槽、头部和已累积的条目。
- 之后,条目增量追加。
- 保存编辑器草稿会强制一个可发现的头部,并存储带标记的 `draft.txt`;如果草稿消失而只留下启动元数据,close 会移除这个仅含草稿的会话。显式 `ensureOnDisk()` 的会话仍然可恢复。
- 并发完成的追加会用权威的全文重写取代进行中的原子重写,这样过期的发布不会覆盖它们。

### 持久性操作

- `flush()` 排空异步磁盘/存储队列和打开的写入器(无 `fsync`);`flushSync()` 在支持的地方执行同步排空/完整重写。
- 原子完整重写使用带提交守卫的存储 `writeTextAtomic`;文件存储先暂存再重命名到目标,包括 EPERM 安全的移开回退。
- 重写服务于重命名、条目重写、迁移/清理、移动/fork 和恢复。会话标题变更通常更新固定宽度的标题槽并追加 `title_change` 审计条目,而不是重写正文。

### 错误行为

- 持久化错误被锁存,并由后续的 flush/close/write 操作重新抛出;第一个错误会带会话文件上下文记录一次日志。
- 失败的原子发布会尝试权威修复。如果存储可能已发布了一次写入而修复无法被证明是持久的,`SessionPersistenceIndeterminateError` 会连同原始错误和恢复错误一起失败关闭。
- 写入器关闭会传播第一个有意义的错误。

## 数据大小控制与 Blob 外部化

在持久化条目之前:

- 超过 500,000 个字符的字符串会用 `"[Session persistence truncated large content]"` 截断,但签名/加密的提供商块、签名字段和完整的 Anthropic 原生网络搜索历史块除外,这些必须保持逐字节一致以供重放。
- 临时 `jsonlEvents` 被移除。
- 如果对象同时有字符串 `content` 和数值 `lineCount`,行数会在截断后重新计算。
- `image_url` 字段中的图片 data URL 无论长度如何,总是按内容寻址存入 blob 存储,并替换为 `blob:sha256:<hash>`。其他 base64 图片载荷(图片内容/数据载荷和图片生成结果)在 1,024 个字符处外部化。
- 当权威推理项已存在于 `providerPayload` 中时,多余的 OpenAI Responses `thinkingSignature` 副本会被省略。

加载时,持久化的 blob 引用会被解析回下游传输所期望的行内载荷形状。

## 存储抽象

`SessionStorage` 拥有 `SessionManager` 使用的类文件系统操作:同步的目录/存在性/写入/stat/列表操作;异步读取、切片读取、写入、带守卫的原子写入、重命名、unlink、感知产物的删除、标题更新、写入器创建和后端排空。

实现与适配器:

- `FileSessionStorage`:真实的本地文件
- `MemorySessionStorage`:基于 map/分块的内存存储,用于非持久化会话和测试
- `IndexedSessionStorage`:共享本地索引加有序远程发布,用于 Redis/SQL 后端存储

`SessionStorageWriter` 暴露 `append`、可选的 `appendSync`、`flush`、可选的 `flushSync`、`isOpen`、`close` 和 `getError`。

## 会话发现工具

发现辅助函数位于 `session-listing.ts`;`SessionManager` 暴露项目作用域的包装:

- `getRecentSessions(sessionDir, limit?)` -> 轻量的欢迎元数据,默认限制 4
- `findMostRecentSession(sessionDir)` -> 按 mtime 最新
- `listSessions(sessionDir, storage)` / `SessionManager.list(...)` -> 带生命周期状态的项目作用域
- `listSessionsReadOnly(...)` -> 相同元数据,不做备份恢复
- `listAllSessions(storage)` / `SessionManager.listAll()` -> 所有项目作用域
- `resolveResumableSession(...)` -> 本地查找,然后可选全局回退

最近/最新扫描只读取 4 KiB 前缀。完整列表读取该前缀加一个有界的 32 KiB 尾部,用于生命周期状态。扫描以 stat 为键并缓存;大型集合用有界的并行 worker 处理。常规的按目录扫描还会在主 JSONL 缺失时恢复最新的孤立 EPERM 备份。恢复匹配不区分大小写,接受会话 id 前缀、完整文件名前缀或时间戳之后的 id 后缀。

## 相关但不同:提示词历史存储

`HistoryStorage`(`history-storage.ts`)是独立的 SQLite 子系统,用于提示词回忆/搜索,而非会话重放。

- 数据库:`~/.omp/agent/history.db`
- 表:`history(id, prompt, created_at, cwd, session_id)`
- FTS5 索引:`history_fts`,带触发器维护的同步
- 使用内存中的上次提示词缓存对连续相同的提示词去重
- 插入通过异步排空队列批量处理(约 100 ms 延迟),因此提示词捕获不会阻塞轮次执行

使用会话文件进行对话图/状态重放;使用 `HistoryStorage` 进行提示词历史 UX。
