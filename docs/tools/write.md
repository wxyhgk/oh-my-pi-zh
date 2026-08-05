# write

> 创建或覆盖文件、可写的内部资源、归档条目、SQLite 行,或解决合并冲突。

## 来源
- 入口:`packages/coding-agent/src/tools/write.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/write.md`
- 主要协作模块:
  - `packages/coding-agent/src/utils/zip.ts` — 解析归档选择器并原子性地重写 ZIP/tar 容器。
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — 检测 SQLite 路径并执行行插入/更新/删除。
  - `packages/coding-agent/src/tools/conflict-detect.ts` — 解析 `conflict://` URI、注册/验证区域并展开侧 token。
  - `packages/coding-agent/src/internal-urls/router.ts` / `packages/coding-agent/src/tools/xdev.ts` — 可写的内部资源与 `xd://` 工具设备分发。
  - `packages/coding-agent/src/lsp/index.ts` — 写入时格式化与诊断写回。
  - `packages/coding-agent/src/tools/auto-generated-guard.ts` — 阻止覆盖生成的文件。
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — 写入后使共享 FS 扫描缓存失效。
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — 解析路径并强制执行计划模式的写入策略。

## 输入
| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | 目标路径。普通路径写入文件。可写的内部 URL 委托给它们的处理程序。`xd://<device>` 使用 `content` 中的 JSON 分发挂载的工具。`archive.ext:inner/path` 为 `.tar`、`.tar.gz`、`.tgz`、`.zip`、`.jar`、`.war`、`.ear` 或 `.apk` 写入归档条目。`db.sqlite:table` 插入一行;`db.sqlite:table:key` 更新/删除一行。`conflict://<id>` 解决一个已注册的冲突,`conflict://*` 执行批量解决。接受并移除复制的 `[path#TAG]` 包装。 |
| `content` | `string` | 是 | 完整的替换文件/归档/内部资源内容、冲突替换或 SQLite 行负载。SQLite 非删除写入必须解析为 JSON5 对象;空或仅空白的 `content` 删除带键的行。对于 `xd://`,这是挂载工具的 JSON 参数对象。 |

示例:

```text
path: "src/generated/config.json"
content: "{\n  \"enabled\": true\n}\n"
```

```text
path: "fixtures/archive.zip:templates/email.txt"
content: "hello\n"
```

```text
path: "data/app.sqlite:users:42"
content: "{name: 'Ada', active: true}"
```

## 输出
单次结果。

- 成功总是返回至少一个文本块,但 `xd://` 分发保留挂载工具自身的内容/错误结果。
  - 普通文件写入:`Successfully wrote <chars> bytes to <relative-path>`(计数为 `cleanContent.length`,不是编码后的字节长度)。
  - 内部 URL 写入:`Successfully wrote <chars> bytes to <url>`。
  - 归档写入:`Successfully wrote <chars> bytes to <relative-archive-path>:<entry-path>`。
  - SQLite 写入:`Inserted row into <table>`、`Updated row '<key>' in <table>`、`No row updated ...`、`Deleted row ...`、`No row deleted ...` 之一。
  - 冲突解决:冲突特定的成功文本,适用时带新的 hashline 快照头部。批量解决可以在部分文件成功、部分失败后返回 `isError: true`。
- 执行期间,`onUpdate` 可能输出 `Writing <chars> bytes to <path>...`;`xd://` 转发挂载工具的更新。
- 如果从 `read` 输出复制了 hashline 前缀并先剥离,第一个文本块会得到一个额外说明。
- 在 hashline 显示模式下,普通文件写入(包括 ACP 桥接写入)和冲突解决会前置一个新的 `[<relative-path>#TAG]` 头部,以便下一次 `edit` 无需额外 `read` 就有当前的快照标签。批量冲突解决追加一个 `Snapshots:` 块,列出每个成功写入文件的头部。
- 当启用 LSP 写入时诊断时,普通文件写入还可能返回 `details.diagnostics` 以及 `details.meta.diagnostics`,以及当新写入的 shebang 文件被 chmod 为可执行时返回 `details.madeExecutable`。
- 由文件支持的普通/归档/冲突结果会设置 `details.resolvedPath`。SQLite 写入额外通过 `sourcePath(...)` 将 `details.meta.source` 设置为数据库文件。内部 URL 写入返回空的 `details`;设备分发设置 `details.xdev`。

## 流程
1. `WriteTool.execute()` 解包复制的 `[path#TAG]` 参数,并从内部 URL 剥离有效的读取选择器,以便写入和读取指向同一资源。可写 URL 上的格式错误/范围选择器被拒绝。
2. 在 hashline 显示模式下,它从 `content` 剥离粘贴的 `[PATH#HASH]` 头部和 `LINE:` 前缀。
3. 它验证类 URI 目标。未知 scheme 和常见的 `xd://` 拼写错误会失败,而不是成为本地文件名;以 `./` 为前缀可有意创建看起来像 URI 的 POSIX 文件名。
4. 如果 `path` 是暴露 `write` 的内部 URL,工具委托给它。`xd://` 验证并将 JSON 分发给挂载的工具,同时保留其结果和批准级别;`local://` 改为落入会话本地文件系统路径。
5. 接下来处理 `conflict://...`。范围读取,如 `conflict://<id>/ours`,是只读的;可写的冲突 URI 省略范围。注册的磁盘标记在替换前会重新验证。
6. 它调用 `#resolveArchiveWritePath()`。候选归档文件按最长优先检查;当都不存在时,使用最短的候选归档路径来创建新容器。
7. 归档写入调用 `enforcePlanModeWrite(..., { op: exists ? "update" : "create" })`,然后调用 `#writeArchiveEntry()`。
   - 父目录会被递归创建。
   - 现有条目通过 `readArchiveEntries()` 加载,目标在条目映射中被替换,`writeArchive()` 序列化一个完整的替换。
   - 替换被写入同级临时路径并重命名覆盖目标。现有归档符号链接首先被解析,以便更新目标而不是替换符号链接。
   - ZIP 格式别名保持为 ZIP。tar gzip 压缩为 `.tar.gz`/`.tgz` 选择。
   - `invalidateFsScanAfterWrite()` 在归档文件路径上运行。
8. 如果不是归档,它尝试 SQLite 候选。现有的非 SQLite 文件抑制 SQLite 解释。
9. SQLite 写入调用 `enforcePlanModeWrite(..., { op: "update" })`,然后调用 `#writeSqliteRow()`。
   - 数据库必须已经存在。
   - 它以 `{ create: false, strict: true }` 和 `PRAGMA busy_timeout = 3000` 打开 Bun SQLite。
   - 带行键的纯空白 `content` 删除一行。
   - 非空 `content` 用 `Bun.JSON5.parse()` 解析,必须是对象,并路由到插入/更新辅助函数。
   - 扫描缓存失效,连接在 `finally` 中关闭。
10. 否则它将 `path` 视为普通文件系统文件。
    - 它拒绝高置信度的错误分发读取目标:缺失的选择器形状文件名且内容为空,或缺失的分号连接的路径选择器列表。现有字面路径优先;非空内容是对单个有意选择器形状文件名的逃生通道。
    - 计划模式策略和路径解析在变更之前运行。现有文件通过生成文件守卫。
    - 可用时首先尝试 ACP 桥接 `writeTextFile`;否则会话写回写入内容。LSP 设置可以格式化、同步和诊断该写入。
    - 前导 shebang 可能添加执行位。文件系统扫描缓存被失效。
11. 工具返回文本以及可选的诊断、可执行、解析路径或设备分发元数据。

## 模式 / 变体
### 普通文件路径
- 目标是任何不解析为归档选择器、也不解析为现有或新建 SQLite 选择器的路径。
- 现有文件被覆盖。
- `write.ts` 不在该路径上调用 `fs.mkdir()`;显式父目录创建只存在于归档分支,但 `Bun.write()` 本身会为普通文件写入创建缺失的父目录。

示例:

```text
path: "tmp/output.txt"
content: "hello\n"
```

### 归档条目写入
- 选择器语法:`archive.ext:inner/path`。
- 支持的扩展名:`.tar`、`.tar.gz`、`.tgz`、`.zip` 以及 ZIP 格式的 `.jar`、`.war`、`.ear`、`.apk`。
- 内部路径规范化为 `/`,剥离空段和 `.` 段,拒绝 `..`,并拒绝以 `/` 结尾的目录目标。
- 替换一个条目后,通过临时文件和重命名重写整个归档。
- 需要时为归档文件创建父目录。

示例:

```text
path: "build/assets.tar.gz:css/app.css"
content: "body { color: black; }\n"
```

### SQLite 表插入
- 选择器语法:`db.sqlite:table`。
- `content` 必须解析为 JSON5 对象。
- 允许空对象,变为 `INSERT INTO <table> DEFAULT VALUES`。
- SQLite 写入拒绝查询参数。

示例:

```text
path: "data/app.db:users"
content: "{name: 'Ada', active: true}"
```

### SQLite 行更新 / 删除
- 选择器语法:`db.sqlite:table:key`。
- 非空 `content` 更新该行。
- 空或仅空白的 `content` 删除该行。
- 行查找在存在时使用单列主键;否则回退到 `rowid`。复合主键和 `WITHOUT ROWID` 表被拒绝用于基于键的写入。

更新示例:

```text
path: "data/app.sqlite:users:42"
content: "{email: 'ada@example.com'}"
```

删除示例:

```text
path: "data/app.sqlite:users:42"
content: ""
```

### 可写的内部资源与工具设备
- 具有 `write` 钩子的已注册内部处理程序拥有其资源语义(例如 `vault://`)。`local://` 改为解析到会话本地的产物沙箱,并遵循普通文件路径。
- `xd://` 列出/分发挂载在 `write` 后面的工具设备。先读取 `xd://<name>` 获取其生成的输入文档,然后传入一个 JSON 对象作为 `content`。设备自身的 schema、更新、结果块、错误标志、渲染器元数据和批准级别都被保留。
- 未知的类 URI scheme 被拒绝,以防止静默创建本地文件。仅当该文件名是有意的时候才使用 `./scheme://...`。

### 合并冲突解决
- 首先读取 `<file>:conflicts`;这会注册会话稳定的 id。`conflict://<N>` 只替换该记录的标记块,并拒绝过时/缺失的区域。
- 与 `@ours`、`@theirs`、`@base` 或 `@both` 完全相等的行展开为记录的侧(`@both` 是先 ours 后 theirs)。`@base` 需要 diff3 基础。其他内容是字面的。
- 带普通内容的 `conflict://*` 将相同的替换/token 展开应用于每个已注册的冲突。每 id 指令内容,如 `1: @ours\n2: @theirs`,只解决列出的 id;每个非空指令行必须使用一个侧 token,且 id 不得重复。
- 批量处理按文件全有或全无,自下而上应用。其他文件仍然可以成功;部分跨文件成功返回 `isError: true`,而全部失败的通道抛出异常。成功的 id 被失效,失败文件的 id 保持注册以供重试。
- `/ours`、`/theirs`、`/base` 和 `/both` URI 范围是只读的。

## 副作用
- 文件系统
  - 创建或覆盖普通文件。
  - 写入条目时,通过临时同级文件和重命名原子性地重写整个归档文件。
  - 为归档文件显式创建父目录;普通文件后端也支持缺失的父目录。
  - 修改现有的 SQLite 数据库;从不创建新的 SQLite 数据库。
  - 为 `conflict://...` 写入解决文件中的冲突标记。
  - 普通文件写入成功后可能将 shebang 文件 chmod 为可执行。
- 子进程 / 原生绑定
  - 通过 `bun:sqlite` 使用 Bun SQLite 绑定。
  - 使用统一的归档工具:Bun Archive 用于 tar 序列化/索引,`node:zlib` 支持的框架用于 ZIP。
  - 可能通过 `packages/coding-agent/src/lsp/index.ts` 与配置的 LSP 服务器通信。
- 会话状态
  - 通过 `invalidateFsScanAfterWrite()` 使共享文件系统扫描缓存条目失效。
  - 在变更目标之前强制执行计划模式的写入限制。
  - 更新普通文件和冲突解决的变更/快照状态;已解决的冲突 id 被失效。
  - `xd://` 分发挂载的工具,因此可能有该工具的文档化副作用。
- 后台工作 / 取消
  - 在 `WriteTool` 中标记工具 `concurrency = "exclusive"`。
  - 写入主体用 `untilAborted` 包装;LSP 写回可以在超时后调度延迟诊断获取。

## 限制与上限
- 普通/内部文件内容除了内存处理之外没有工具级字节上限。归档重写继承归档工具的容量上限:tar/tgz 输入 `256 MiB`,每个现有成员 `64 MiB`,ZIP 输出必须适合非 ZIP64 的 32 位条目/计数/偏移限制。
- 生成文件检测最多读取 `CHECK_BYTE_COUNT = 1024` 字节和 `HEADER_LINE_LIMIT = 40` 行头部,来自 `packages/coding-agent/src/tools/auto-generated-guard.ts` 中的现有文件。
- SQLite 写入设置 `PRAGMA busy_timeout = 3000`。
- LSP 写回在 `runLspWritethrough()` 中使用 `5_000` ms 操作超时,并可能在 `scheduleDeferredDiagnosticsFetch()` 中用 `AbortSignal.timeout(25_000)` 调度延迟诊断获取。
- shebang 可执行处理取决于主机文件系统 chmod 支持。

## 错误
- 无效的归档子路径抛出 `ToolError`,消息如下:
  - `Archive write path must target a file inside the archive`
  - `Archive write path must target a file, not a directory`
  - `Archive path cannot contain '..'`
- SQLite 路径解析在不支持的形式上抛出:
  - `SQLite write paths do not support query parameters`
  - `SQLite write path must target a table`
  - `SQLite row writes require a non-empty row key`
- 缺失的 SQLite 数据库表现为 `SQLite database '<path>' not found`。
- SQLite 内容错误包括无效 JSON5、非对象负载、未知列、非标量值、空更新对象、复合主键和 `WITHOUT ROWID` 键查找。
- 当现有普通文件看起来是生成的时,可能被 `assertEditableFile()` 拒绝。
- 未知的类 URI 目标和格式错误/缺失的 `xd://` 设备会失败,而不是写入本地文件;挂载的设备透出它们自己的 schema/工具错误。
- 对缺失的选择器形状目标和分号连接的路径选择器列表的空写入被拒绝,视为可能的读/写错误分发。
- 冲突范围写入是只读的;无效/过时的 id、格式错误的批量指令、缺失的 `@base` 和过时的标记位置表现为 `ToolError`。
- 归档读/写失败和意外的 SQLite 异常被包装在 `ToolError(error.message)` 中。
- 如果没有匹配的 LSP 服务器,或 LSP 格式化/诊断超时,文件写入仍然完成;诊断可能被省略。

## 备注
- 归档路径检测在 SQLite 检测之前运行。匹配归档选择器的路径永远不会被视为 SQLite。
- 当现有文件带有 `.sqlite` / `.db` 后缀但缺少 SQLite 魔数时,SQLite 检测会拒绝;该路径回退为普通文件写入。
- 归档重写使用统一的 `readArchiveEntries()` / `writeArchive()` 边界和临时文件重命名。字符串成员编码为 UTF-8。
- 提示词禁止两个常见的反模式:将 `write` 用于应该使用 `edit` 的常规编辑,以及除非明确要求否则创建 `*.md` / `README` 文件。它还禁止未要求的 emoji。
- 普通文件和内部 URL 写入将 `cleanContent.length` 报告为“bytes”,这是 JS 中的 UTF-16 代码单元,而不是磁盘上的字节度量。
- `stripWriteContent()` 仅在会话的文件显示模式启用 `hashLines` 时移除 hashline 前缀;否则内容原样写入。

- 该工具有 `strict = true`、`loadMode = "essential"` 和排他并发。其渲染器默认显示 12 行流式预览和 6 行完成预览;`xd://` 结果将渲染委托给挂载的设备。
