# Mnemopi 记忆后端

Oh My Pi 可以使用 `@oh-my-pi/pi-mnemopi` 作为本地长期记忆后端。

设置：

```yaml
memory:
  backend: mnemopi
```

示例：

```yaml
memory:
  backend: mnemopi
mnemopi:
  scoping: per-project-tagged
```

启用此后端后，编码 Agent：

1. 根据配置的银行作用域打开一个或多个本地 Mnemopi SQLite 数据库。
2. 在会话的第一个模型轮次将相关记忆召回进 `<memories>` 块，如果召回发生在 `agent_start` 监听器中，则刷新基础提示词。
3. 在 Agent 轮次后将已完成的对话轮次保留到保留银行，频率不超过 `mnemopi.retainEveryNTurns`。
4. 当压缩向记忆后端请求 `preCompactionContext` 时，将召回的记忆作为额外压缩上下文加入。
5. 通过共享记忆后端接口使用常规的 `/memory view`、`/memory stats`、`/memory diagnose`、`/memory clear` 和 `/memory enqueue` 命令。

召回的记忆是后台上下文，而非指令。冲突时，当前用户消息与工具输出优先。

## Agent 工具

选择 Mnemopi 后，以下可发现工具可用：

- `recall` — 搜索作用域内的记忆。结果为预览并包含记忆 ID。
- `retain` — 显式存储持久事实。
- `reflect` — 综合召回的多个记忆回答问题。
- `memory_edit` — 按 ID `update`、`forget` 或 `invalidate` 一条可编辑记忆。事实表行是只读的。

在替换某条召回结果之前，先用 `read memory://<memory-id>` 读取其完整内容与元数据；被裁剪的召回预览不是安全的更新负载。当 `autolearn.enabled: true` 时，可选的 `learn` 工具也能向 Mnemopi 保留内容。

## 设置

| 设置                       | 默认值            | 描述                                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`           | `off`             | 设为 `mnemopi` 以启用此后端。                                                                                                                                                                                                                                                   |
| `mnemopi.dbPath`           | agent 记忆目录    | 可选的 SQLite 数据库路径。                                                                                                                                                                                                                                                      |
| `mnemopi.bank`             | 未设置            | 传给 `Mnemopi` 的可选共享银行基名；编码 Agent 包装器根据 `mnemopi.scoping` 从此基名派生作用域。未设置 → 共享银行 `default`；per-project 模式从工作目录基名加上其绝对路径的稳定哈希派生项目银行。                                                                               |
| `mnemopi.scoping`          | `per-project`     | 记忆可见性模式：`global` = 一个共享银行，`per-project` = 隔离的项目记忆，`per-project-tagged` = 项目本地写入加全局召回可见性。                                                                                                                                                |
| `mnemopi.autoRecall`       | `true`            | 在会话的第一个轮次召回记忆。                                                                                                                                                                                                                                                    |
| `mnemopi.autoRetain`       | `true`            | 自动保留已完成的轮次。                                                                                                                                                                                                                                                          |
| `mnemopi.polyphonicRecall` | `false`           | 启用 4 声部复调召回（向量、图、事实、时序）并配合倒数排名融合；设置 `MNEMOPI_POLYPHONIC_RECALL` 时覆盖。                                                                                                                                                                        |
| `mnemopi.enhancedRecall`   | `false`           | 为重复/相似召回查询启用分层查询结果缓存；设置 `MNEMOPI_ENHANCED_RECALL` 时覆盖。                                                                                                                                                                                               |
| `mnemopi.proactiveLinking` | `false`           | 将新记忆摄入情景图，并在存储时链接到相关实体/记忆；设置 `MNEMOPI_PROACTIVE_LINKING` 时覆盖。                                                                                                                                                                                  |
| `mnemopi.retainEveryNTurns`   | `4`            | 自动保留写入之间的最少用户轮次数。                                                                                                                                                                                                                                              |
| `mnemopi.recallLimit`      | `8`               | 提示词块中最多召回的记忆数。                                                                                                                                                                                                                                                    |
| `mnemopi.recallContextTurns`  | `3`            | 召回查询中包含的先前用户受限轮次数。                                                                                                                                                                                                                                            |
| `mnemopi.recallMaxQueryChars` | `4000`         | 组合后的召回查询最大长度。                                                                                                                                                                                                                                                      |
| `mnemopi.injectionTokenLimit` | `5000`         | 记忆提示词注入的近似 token 预算。                                                                                                                                                                                                                                               |
| `mnemopi.debug`            | `false`           | 为后端失败启用调试日志。                                                                                                                                                                                                                                                        |
| `mnemopi.noEmbeddings`     | `false`           | 向 `Mnemopi` 传递 `noEmbeddings` 并强制仅 FTS 召回。                                                                                                                                                                                                                            |
| `mnemopi.embeddingVariant` | `en`              | 本地嵌入模型变体：`en` = `BAAI/bge-base-en-v1.5`（768 维），`multilingual` = `intfloat/multilingual-e5-large`（1024 维）。`mnemopi.embeddingModel`/`MNEMOPI_EMBEDDING_MODEL` 会覆盖它；更改它会在下一次可写启动时重建已存储的嵌入。                                         |
| `mnemopi.embeddingModel`   | 变体默认值        | 显式嵌入模型 ID；覆盖 `mnemopi.embeddingVariant`。优先级：此设置 > `MNEMOPI_EMBEDDING_MODEL` 环境变量 > 变体默认值。                                                                                                                                                           |
| `mnemopi.embeddingApiUrl`  | 环境变量/默认值    | 传给 `Mnemopi` 的 OpenAI 兼容嵌入端点。                                                                                                                                                                                                                                         |
| `mnemopi.embeddingApiKey`  | 环境变量/默认值    | 传给 `Mnemopi` 的嵌入 API 密钥。                                                                                                                                                                                                                                                |
| `mnemopi.llmMode`          | `smol`             | `smol` 先解析配置的 pi-ai `tiny` 角色再解析 `smol`；`remote` 使用以下设置；`none` 禁用 LLM 调用。                                                                                                                                                                              |
| `mnemopi.llmBaseUrl`       | 环境变量/默认值    | 用于 `llmMode: remote` 的 OpenAI 兼容 LLM 端点。                                                                                                                                                                                                                                |
| `mnemopi.llmApiKey`        | 环境变量/默认值    | 用于 `llmMode: remote` 的 LLM API 密钥。                                                                                                                                                                                                                                        |
| `mnemopi.llmModel`         | 环境变量/默认值    | 用于 `llmMode: remote` 的 LLM 模型 ID。                                                                                                                                                                                                                                         |

## 作用域

编码 Agent 包装器在底层 `Mnemopi` 包之上应用作用域：

- `global` 召回与写入共用一个共享银行。
- `per-project` 仅从当前工作目录派生的银行写入与召回——即其基名加上其绝对路径的稳定哈希，与周围 git 布局无关。
- `per-project-tagged` 写入项目本地银行，并同时从项目本地银行与共享全局银行召回，重复的召回结果会合并。

项目加全局的组合行为位于包装器中。`@oh-my-pi/pi-mnemopi` 包本身仍直接暴露银行与构造函数选项，包括用于选择银行名的 `bank`。共享银行之外的项目本地银行作为兄弟银行数据库存储，由 Mnemopi 的 `BankManager` 管理。

## LLM 与嵌入

FTS 与嵌入路径使用以下设置。基于 LLM 的提取/合并在使用本地设备端记忆模型（`providers.memoryModel`）时使用该模型（若已选择），否则 `llmMode: smol` 先解析 `tiny` 角色再解析 `smol`；`llmMode: remote` 使用 OpenAI 兼容端点设置；`llmMode: none` 禁用 LLM 调用。如果无法解析 tiny/smol 模型或当前凭据，Mnemopi 继续运行但跳过基于 LLM 的工作。

仅 FTS：

```yaml
memory:
  backend: mnemopi
mnemopi:
  noEmbeddings: true
```

等价的构造函数形式：

```ts
new Mnemopi({ noEmbeddings: true });
```

远程嵌入：

```yaml
mnemopi:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

等价构造函数形式：

```ts
new Mnemopi({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

远程 LLM：

```yaml
mnemopi:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

等价的构造函数形式：

```ts
new Mnemopi({ llm: { baseUrl, apiKey, model } });
new Mnemopi({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

用于轮换 OAuth token 的动态函数 LLM：

```ts
new Mnemopi({
  llm: async (prompt, opts) => {
    const token = await getFreshOauthToken();
    return await completeWithPiAi(prompt, {
      token,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });
  },
});
```

pi-ai tiny/smol 角色 LLM：

```yaml
mnemopi:
  llmMode: smol
```

编码 Agent 先解析 `tiny` 再解析 `smol`，并传递动态补全函数，使每次 Mnemopi LLM 调用都能在调用时获取当前提供商凭据：

```ts
new Mnemopi({
  llm: async (prompt, opts) => completeSmolWithCurrentAuth(prompt, opts),
});
```

## 运维说明

- 默认共享数据库位于 agent 记忆目录下的 `mnemopi/mnemopi.db`；项目作用域银行使用该 Mnemopi 目录下的兄弟数据库路径。
- `/memory clear` 删除活动配置的所有作用域 Mnemopi SQLite 数据库及伴生的 WAL/SHM 文件。
- `/memory enqueue` 强制保留当前会话、刷新待处理的事实提取，并运行 Mnemopi 休眠/合并。
- Mnemopi 后端激活时，`/memory stats` 与 `/memory diagnose` 渲染后端特定的银行统计/诊断信息。
- 子代理不拥有独立的 Mnemopi 保留循环；当父级 Mnemopi 状态存在时它们复用父级状态，否则保持惰性。
- 后端启动为尽力而为。如果数据库/模型初始化失败，会话继续运行但 Mnemopi 处于惰性状态并记录警告；记忆工具随后报告后端未初始化。

## 关闭与持久性

正常的交互与 print 模式退出使用一条比 `/memory enqueue` 更轻量的路径：

1. 主状态保留当前转录，禁用新事实提取。
2. 它刷新已在途的提取，但不运行逐会话休眠或完整的跨会话提升。
3. 只有在该排空稳定后，才关闭其拥有的 SQLite 银行句柄；嵌入 worker 在状态销毁后关闭，因为排空可能仍在使用它。

被复用的子代理状态不拥有也不关闭共享银行；父级状态拥有最终保留、刷新与句柄关闭。

交互与 print 退出给此排空 1.5 秒。如果预算到期，关闭会分离在途排空，并安排在排空稳定后关闭句柄，而不是与已关闭的数据库竞速写入。进程可能先行退出。已写入的工作记忆行保持持久，但最后几轮次的提升或嵌入可能不完整；Agent 结束时的更早轮次保留不受影响。

`/memory enqueue` 是显式的更强持久性边界：它强制保留、刷新待处理的提取，并在拥有的银行上运行完整休眠/合并。在退出前，当最新材料必须被提升而非依赖受限的正常关闭路径时，请使用它。
