# Blob 与产物存储架构

本文档描述 coding-agent 如何在会话 JSONL 之外存储大/二进制负载,截断的工具输出如何持久化,以及内部 URL(`artifact://`、`agent://`)如何解析回存储的数据。

## 为什么存在两套存储系统

运行时对不同数据形状使用两种不同的持久化机制:

- **内容寻址的 blob**(`blob:sha256:<hash>`):全局存储,用于把大型图像 base64 负载和提供商图像 data URL 从持久化的会话条目中外部化。
- **会话作用域的产物**(`<sessionFile-without-.jsonl>/` 下的文件):每个会话的文本文件,用于完整工具输出和子代理输出。

它们刻意分离:

- blob 存储按内容哈希优化去重和稳定引用,
- 产物存储按本地 id 优化只追加的会话工具以及人/工具检索。

## 存储边界与磁盘布局

### Blob 存储边界(全局)

`SessionManager` 构造 `BlobStore(getBlobsDir())`,因此 blob 文件位于共享的全局 blob 目录,而非会话文件夹。

Blob 文件命名:

- 文件路径:`<blobsDir>/<sha256-hex>`
- 规范文件无扩展名;提供了有效扩展名(图像 MIME 类型)时,一个带类型的伴生文件 `<sha256-hex>.<ext>` 被硬链接或复制到它旁边,使 OS 打开器可以按类型检测
- 条目中存储的引用字符串:`blob:sha256:<sha256-hex>`,其中哈希必须恰好是 64 个小写十六进制字符

含义:

- 跨会话的相同二进制内容解析到相同的哈希/路径,
- 写入在内容层面是幂等的,
- blob 可以比任何单个会话文件活得更久。

## 产物边界(会话本地)

`ArtifactManager` 从会话文件路径派生产物目录:

- 会话文件:`.../<timestamp>_<sessionId>.jsonl`
- 产物目录:`.../<timestamp>_<sessionId>/`(去掉 `.jsonl`)

产物类型共享此目录:

- 截断工具输出文件:`<numericId>.<toolType>.log`(用于 `artifact://`)
- 子代理输出文件:`<outputId>.md`(用于 `agent://`)
- 子代理会话 JSONL 伴生文件:task 执行收到产物目录时的 `<outputId>.jsonl`

子代理可以采用父级 `ArtifactManager`;这种情况下父级和子代理树共享一个产物目录和数字产物 id 空间。

## ID 与名称分配方案

### Blob ID:内容哈希

`BlobStore.put()` / `putSync()` 对它收到的字节计算 SHA-256,并返回:

- `hash`:十六进制摘要,
- `path`:`<blobsDir>/<hash>`,
- `displayPath`:提供扩展名时为 `<blobsDir>/<hash>.<ext>`,否则为规范路径,
- `ref`:`blob:sha256:<hash>`。

不使用会话本地计数器。

### 产物 ID:会话本地单调整数

`ArtifactManager` 惰性创建目录,并在首次目录支撑的分配时扫描现有 `*.log` 文件以找最大数字 ID,设置 `nextId = max + 1`。并发首次分配共享同一个初始化 promise,因此它们无法重播种计数器并发出重复。

分配行为:

- 文件格式:`{id}.{sanitizedToolType}.log`
- 工具类型把 `[A-Za-z0-9_-]` 之外的字符坍缩为 `_`,修剪周围下划线,上限 64 字符,回退为 `tool`
- ID 是顺序字符串(`"0"`、`"1"`, ...)
- 恢复不会覆盖现有产物,因为扫描发生在分配之前

产物目录缺失时,初始化创建它,分配从 `0` 开始。

没有采用管理器的非持久会话可以在内存中以数字 ID 存储 `saveArtifact(...)` 内容,但 `artifact://` 解析是通过注册的产物目录进行文件支撑的。

### Agent 输出 ID(`agent://`)

`AgentOutputManager` 从请求的名称分配 ID,首次原样使用,仅在重复时加后缀(`-2`、`-3`, …)。嵌套输出使用点限定的父前缀(例如 `Parent.Child`)。初始化扫描 `.md` 输出和 `.jsonl` 子会话文件,因此恢复不会覆盖任一种;保留的 advisor 转录词干从不原样分配。

## 持久化数据流

### 1) 会话条目持久化重写路径

在写入会话条目之前 —— 增量追加(`#appendToSessionFile`)或全文件重写(`#rewriteSynchronously` / `#rewriteAtomically`)—— `SessionManager` 通过 `#lineFor()` 序列化它,后者在截断流水线上运行 `prepareEntryForPersistence()`。

关键行为:

1. **大字符串截断**:过大的字符串被切断并加后缀 `"[Session persistence truncated large content]"`;签名字段(`thinkingSignature`、`thoughtSignature`、`textSignature`)被清除而非截断。
2. **瞬态字段剥离**:`partialJson` 和 `jsonlEvents` 从持久化条目中移除。
3. **图像外部化为 blob**:
   - 当 `data` 还不是 blob 引用且 base64 长度至少达到阈值(`BLOB_EXTERNALIZE_THRESHOLD = 1024`)时,`content` 数组中的图像块被外部化,
   - 当提供商风格的 `image_url` data URL 以 `data:image/` 开头且包含 `;base64,` 时被外部化,
   - 图像块的 `data` 存储为解码后的二进制字节,
   - 提供商 data URL 存储为原始 UTF-8 data URL 字符串,
   - 持久化的值被替换为 `blob:sha256:<hash>`。

这使会话 JSONL 保持紧凑,同时保留可恢复性。

### 2) 会话加载再水化路径

打开会话(`setSessionFile`)时,迁移后 `SessionManager` 运行 `resolveBlobRefsInEntries()`。

对于带 `blob:sha256:<hash>` 的消息/自定义消息图像块,以及带 blob 引用的持久化提供商 `image_url` 字段:

- 从 blob 存储读取 blob 字节,
- 把图像块字节转换回 base64,
- 把提供商 `image_url` blob 转换回原始字符串,
- 为运行时消费者修改内存中的条目字段。

blob 缺失时:

- 图像块解析记录警告,并在内存中保留原始 `blob:sha256:` 引用字符串,
- 提供商 `image_url` 解析记录警告,并保留原始引用字符串,
- 加载继续。

### 3) 工具输出溢出/截断路径

`OutputSink` 为 bash/python/ssh 及相关执行器的流式输出提供动力。

行为:

1. 每个块用 `sanitizeWithOptionalSixelPassthrough(..., sanitizeText)` 净化,并追加到内存记账。
2. 可选实时 `onChunk` 接收净化后的列上限前块,按配置节流。
3. 逐行列上限可以从面向 LLM 的缓冲区丢弃长行字节;发生时,产物镜像开始,使磁盘文件保持完整净化流。
4. 内存尾部缓冲区将超过溢出阈值(`DEFAULT_MAX_BYTES`,50KB)时,接收器标记输出截断,并在产物路径可用时开始产物镜像。
5. 文件接收器打开时,先写入当前缓冲区,然后写入所有排队/后续的净化块。
6. 内存缓冲区被修剪为尾部窗口,或配置头部保留时为头部 + 省略标记 + 尾部。
7. `dump()` 返回摘要,仅在文件接收器创建成功时包含 `artifactId`。

实际效果:

- UI/工具返回显示有界输出,
- 完整净化输出保存在产物文件中,并在文件支撑的产物镜像成功时以 `artifact://<id>` 引用。

文件接收器创建失败(IO 错误、路径缺失等)时,接收器回退到仅内存截断;完整输出不持久化。

## URL 访问模型

### `blob:` 引用

`blob:sha256:<hash>` 是会话条目负载内部的持久化引用,不是由路由器处理的内部 URL 方案。`SessionManager` 在加载期间解析它。格式错误的后缀在任何路径连接前被 `parseBlobRef()` 拒绝、记录,并保持原样,而不是从 blob 目录读取。

### `artifact://<id>`

由 `ArtifactProtocolHandler` 在注册的活动会话产物目录上处理:

- 需要数字 ID
- 优先调用会话的钉住产物目录,而不是其他注册会话,因为数字 ID 是会话本地的
- 搜索文件名前缀 `<id>.`
- 内联解析返回原始 `text/plain`
- 缺失时报告可用的数字产物 ID
- 拒绝物化大于 8 MiB 的完整产物;搜索/复制工作流使用有界 `read` 选择器或报告的底层路径

仅路径的消费者可以按任意大小解析底层文件,而不加载其字节。

失败行为:

- 没有注册的产物目录:抛出 `No session - artifacts unavailable`,
- 注册目录存在但磁盘上都不存在:抛出 `No artifacts directory found`,
- ID 不是数字:抛出 `artifact:// ID must be numeric, got: <id>`。

### `agent://<id>`

由 `AgentProtocolHandler` 在注册的活动会话产物目录和 `<artifactsDir>/<id>.md` 上处理:

- `agent://<id>` 返回 markdown 文本
- `agent://Parent/Child` 先尝试嵌套输出 `Parent.Child.md`
- 仅当没有嵌套输出匹配时,斜杠路径才回退到从基础输出做 JSON 提取
- `?q=` 总是执行 JSON 提取
- 路径和查询提取不能组合
- 提取需要有效 JSON 并返回 `application/json`

失败行为:

- 没有注册的产物目录:抛出 `No session - agent outputs unavailable`,
- 注册目录存在但磁盘上都不存在:抛出 `No artifacts directory found`,
- 缺失输出抛出 `Not found: <id>`,目录列表成功时附带可用的 `.md` 输出 ID。

Read 工具集成:

- `read` 支持对非提取内部 URL 读取的行范围与原始选择器
- `agent://` URL 包含路径或查询提取语法时,行选择器被拒绝;提取直接返回,不分页

## 恢复、分叉与移动语义

### 恢复

- `ArtifactManager` 在首次分配时扫描现有 `{id}.*.log` 文件并继续编号。
- `AgentOutputManager` 扫描现有 `.md` 和子 `.jsonl` ID,并继续名称后缀。
- `SessionManager` 在加载时把 blob 引用再水化为 base64/data URL。

### 分叉

`SessionManager.fork()` 创建带新会话 ID 和 `parentSession` 链接的新会话文件,然后返回旧/新文件路径。产物复制由 `AgentSession.fork()` 处理:

- 先刷新当前会话,
- 尝试把旧产物目录递归复制到新产物目录,
- 缺失旧目录被容忍,
- 非 ENOENT 复制错误被记录为警告,分叉仍完成。

分叉后的 ID 含义:

- 复制成功时,新会话中的产物计数器在新 `ArtifactManager` 首次扫描后,从最大复制 ID 之后继续,
- 复制失败/跳过时,新会话产物 ID 从 `0` 开始。

分叉后的 blob 含义:

- blob 是全局且内容寻址的,因此不需要 blob 目录复制。

### 移动到新 cwd

`SessionManager.moveTo()` 把会话文件和产物目录都重命名到新的默认会话目录,后续步骤失败时有回滚逻辑。这在重定位会话作用域的同时保留产物身份。

## 失败处理与回退路径

| 情形                                                      | 行为                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 图像块再水化期间 blob 文件缺失          | 警告并在内存中保留 `blob:sha256:` 引用字符串                                      |
| 提供商 `image_url` 再水化期间 blob 文件缺失 | 警告并在内存中保留 `blob:sha256:` 引用字符串                                      |
| 通过 `BlobStore.get` 读取 blob 时 ENOENT                      | 返回 `null`                                                                         |
| 产物目录缺失(`ArtifactManager.listFiles`)  | 返回空列表(分配可以重新开始)                                        |
| 无注册产物目录(`artifact://`)               | 抛出 `No session - artifacts unavailable`                                            |
| 无注册产物目录(`agent://`)                  | 抛出 `No session - agent outputs unavailable`                                        |
| 注册产物目录在磁盘上缺失                  | 抛出显式 `No artifacts directory found`                                         |
| 产物 ID 未找到                                     | 抛出并附可用 ID 列表                                                      |
| 完整 `artifact://` 解析超过 8 MiB               | 拒绝内联物化;有界选择器/仅路径工作流仍可用 |
| OutputSink 产物写入器初始化失败                     | 仅以有界内存输出继续                                           |
| 非持久 `saveArtifact`                             | 把文本存储在 `SessionManager` 内存映射中;不是文件支撑的 URL 数据                   |

## 二进制 blob 外部化与文本输出产物

- **Blob 外部化** 用于持久化会话条目内容内部的图像负载和提供商图像 data URL;它把 JSONL 中的内联负载字符串替换为稳定内容引用。
- **产物** 是执行输出和子代理输出的纯文本文件;文件支撑的产物可通过内部 URL 按会话本地 ID 寻址。

两套系统只间接相交:两者都减少会话 JSONL 膨胀,但身份、生命周期和检索路径不同。

## 实现文件

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob 引用格式、哈希、put/get、外部化/再水化辅助器。
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — 会话产物目录模型和数字产物 ID/路径分配。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink` 截断/溢出到文件行为和摘要元数据。
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — `BlobStore`/`ArtifactManager` 构造、持久化变换与 blob 再水化调用点、会话分叉/移动交互。
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — `prepareEntryForPersistence()`:大字符串截断、瞬态字段剥离和同步图像 blob 外部化。
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — `resolveBlobRefsInEntries()`:加载时 blob 引用再水化为 base64 / data URL。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 交互式分叉期间的产物目录复制。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://` 解析器。
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` 解析器 + JSON 提取。
- [`src/internal-urls/router.ts`](../packages/coding-agent/src/internal-urls/router.ts) — 内部 URL 路由器接线。
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — `agent://` 的会话作用域 Agent 输出 ID 分配。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — 子代理输出产物写入(`<id>.md`)和会话 JSONL 伴生文件。
