# read

> 通过一个 `path` 字符串读取文件、目录、归档、SQLite 数据库、内部资源、图片、文档和 URL。

## 来源
- 入口:`packages/coding-agent/src/tools/read.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/read.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/path-utils.ts` — 将 `path` 与尾部选择器拆分;优先按字面文件名处理;规范化本地路径,并恢复误分隔的路径列表。
  - `packages/coding-agent/src/utils/zip.ts` — 统一的 ZIP/tar 封装:检测 `archive.ext:inner/path`、索引归档、列出/读取条目。
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — 检测 SQLite 目标、解析选择器、渲染表。
  - `packages/coding-agent/src/tools/fetch.ts` — URL 解析、fetch/渲染流水线、URL 缓存/产物。
  - `packages/coding-agent/src/internal-urls/router.ts` — 内置内部资源注册表,包括 `ssh://` 和 `xd://`;MCP 可声明其他协议。
  - `packages/coding-agent/src/edit/notebook.ts` — 将 `.ipynb` 转换为可编辑的 `# %% [...] cell:N` 文本。
  - `packages/coding-agent/src/utils/cpuprofile.ts` / `sample-profile.ts` — 汇总可识别的性能分析报告。
  - `packages/coding-agent/src/utils/file-display-mode.ts` — 决定使用 hashline、行号还是原始显示。
  - `packages/coding-agent/src/workspace-tree.ts` — 渲染目录树。
  - `packages/coding-agent/src/edit/file-snapshot-store.ts` — 存储已读行,供后续 hashline 编辑校验/恢复使用。
  - `packages/coding-agent/src/tools/index.ts` — 注册 `read: s => new ReadTool(s)`。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | 文件系统路径、内部 URL 或 Web URL。可带尾部选择器,如 `:50-100` 或 `:raw`。 |

### 选择器语法

对于普通类文件读取,`packages/coding-agent/src/tools/path-utils.ts` 中的 `splitPathAndSel()` 仅在最终后缀匹配以下形式之一时识别它:

| 后缀 | 含义 |
| --- | --- |
| `:raw` | 原始/逐字模式。禁用结构摘要和行前缀。 |
| `:conflicts` | 扫描本地文件中的未解决 Git 合并冲突区域,将其注册到会话冲突历史中,并渲染紧凑的 `#N Lx-Ly` 索引。 |
| `:N` / `:LN` / `:N-` / `:N..` | 从 1 起始的行 `N` 开始,开放结尾。 |
| `:A-B` / `:LA-LB` / `:A..B` | 包含端点的 1 起始行范围(`..` 是宽容别名,规范化为 `-`)。 |
| `:A+C` / `:LA+LC` | 从 `A` 开始的 `C` 行;工具将其转换为结束行 `A + C - 1`。 |
| `:R1,R2,...` | 多个范围,读取前排序并合并(例如 `:5-16,960-973`)。 |
| `:range:raw` 或 `:raw:range` | 相同的行选择,但输出为原始。 |

`parseLineRangeChunk()` 中的校验:
- 行号为 1 起始;`:0` 抛错。
- `+` 计数必须 `>= 1`。
- `-` 结束必须 `>=` 开始。

选择器解析对无法识别的尾部 `:...` 有意回退;归档和 SQLite 路径消费各自的冒号语法。

URL 选择器在 `packages/coding-agent/src/tools/fetch.ts` 中单独解析,但对 `:raw`、`:N`、`:A-B`、`:A+C`、`:5-10,20-30` 以及 `:range:raw` / `:raw:range` 使用相同的行范围解析器。由于 URL 端口也使用 `:`,请在主机/端口 URL 的选择器前添加尾部斜杠,例如 `https://example.com/:80`。字面文件系统路径优先于选择器解释,因此以选择器样式文本结尾的现有 POSIX 文件名按字面读取。

## 输出
- 通过 `packages/coding-agent/src/tools/tool-result.ts` 中的 `toolResult()` 构建一次性 `AgentToolResult`。
- `content` 通常是一个文本块。图片读取可能返回 `[text, image]`。
- `details` 取决于路径。`ReadToolDetails` 可能包含:
  - `kind: "file" | "url"`(URL 路径使用 `kind: "url"`;文件读取通常省略 `kind`)
  - `isDirectory`
  - `resolvedPath`
  - `suffixResolution`
  - URL 字段:`url`、`finalUrl`、`contentType`、`method`、`notes`
  - `truncation`
  - `displayContent`(无前缀文本 + 起始行,用于 TUI 渲染)
  - `summary`(`lines`、`elidedSpans`、`elidedLines`),用于结构摘要
  - `conflictCount`,用于 `<path>:conflicts`
  - `displayReadTargets`,当工具恢复了误分隔的路径列表用于 TUI 显示时
  - `meta`,来自 `packages/coding-agent/src/tools/output-meta.ts`
- `details.meta.source` 设置为底层路径、URL 或内部 URL。
- `details.meta.truncation` 携带显示范围、总行数/字节数、下一个偏移量,以及缓存 URL 输出的可选 `artifactId`。
- 当列表限制触发时,目录/归档列表和 SQLite 表列表也会设置 `details.meta.limits`。

## 流程
1. `ReadTool.execute()` 接受 `{ path }`。`file://...` 输入先用 `expandPath()` 展开。`conflict://<N>[/ours|theirs|base|both]` 在普通 URL 之前处理;`conflict://*` 只写。
2. 它通过 `packages/coding-agent/src/tools/fetch.ts` 中的 `parseReadUrlTarget()` 尝试 Web URL 处理。
   - 普通 URL 读取调用 `executeReadUrl()`。
   - 带行选择器的 URL 读取按需 fetch/渲染到 URL 缓存,然后在本地对渲染文本分页。
3. 它检查内部 URL 路由器,包括内置协议和 MCP 声明的协议。
   - 由实际文件支撑的 `local://` 资源被提升到本地文件路径,使图片、转换、选择器和快照行为与文件系统读取一致。
   - `agent://` 查询提取(`/path` 或 `?q=`)绕过分页,直接返回提取的内容。
   - `artifact://` 使用有界文件支撑读取器,而不是加载完整产物。
   - 其他内部资源由 `#buildInMemoryTextResult()` 在内存中分页。
4. 在将类似选择器的冒号视为归档、SQLite、PDF 图片或行选择器语法之前,它优先使用现有的字面文件系统路径。
5. 接下来它用 `#resolveArchiveReadPath()` 尝试归档解析。
   - `parseArchivePathCandidates()` 在 `:sub/path` 之前识别 `.tar`、`.tar.gz`、`.tgz`、`.zip`、`.jar`、`.war`、`.ear` 和 `.apk`。
   - 成功时,`#readArchive()` 要么列出目录,要么将条目解码为 UTF-8 文本。
6. 它用 `#resolveSqliteReadPath()` 尝试 SQLite 解析。
   - `parseSqlitePathCandidates()` 在任何 `:table`、`:key` 或 `?query` 后缀之前扫描 `.sqlite`、`.sqlite3`、`.db`、`.db3`。
   - `#readSqlite()` 按 `parseSqliteSelector()` 分派。
7. 否则它将输入视为本地文件系统路径。
   - `resolveReadPath()` 展开 `~`,相对于会话 cwd 解析,将裸 `/` 视为会话 cwd,并重试 macOS 截图/NFD/花引号变体。
   - 如果路径不存在,`findUniqueWorkspaceSuffix()` 尝试工作区范围内的唯一后缀匹配(远程挂载跳过)。匹配活动 `local://` 计划 basename 的 cwd 根文件名可能恢复该计划。作为最后的受保护恢复,误分隔的现有路径列表会被逐部分读取;调用方仍应每个路径发出一次 `read`。
8. 目录走 `#readDirectory()`。
9. 非目录按内容类型分支:
   - 图片元数据 / 内联图片
   - 汇总的 macOS `sample` 或 V8 `.cpuprofile` 报告
   - 可编辑的 notebook 文本
   - markit 转换的文档
   - 二进制文件提示,除非显式指定了 `:raw`
   - 可解析代码/散文的结构摘要
   - 流式文本/行范围读取
10. 本地文本读取由 `streamLinesFromFile()` 流式处理,而不是加载整个文件。单个有界非原始文本范围在受限侧添加 `1` 行前导和 `3` 行尾部上下文;原始和多范围读取保持精确。
11. 符合条件的 hashline 本地读取将文件快照记录到会话快照存储中,供后续 hashline 编辑校验/恢复使用。超过快照字节上限的文件不进行快照。
12. 如果发生了后缀解析,第一个文本块以 `[Path '...' not found; resolved to '...' via suffix match]` 为前缀。

## 模式 / 变体

### 本地文本文件
- 无选择器:如果启用了摘要且文件符合条件,`#trySummarize()` 调用 `summarizeCode()`。
  - 默认值:`read.summarize.enabled = true`;散文(`.md` 变体和 `.txt`)保持未摘要,除非 `read.summarize.prose = true`;低于 `read.summarize.minTotalLines = 100` 的文件保持逐字。
  - 硬性保护:文件大小 `<= 2 MiB`(`MAX_SUMMARY_BYTES`),行数 `<= 20_000`(`MAX_SUMMARY_LINES`)。
  - 摘要输出保留选定的声明,并将省略的跨度替换为 `…` 或包含 `{ … }` 的合并花括号对行。当至少省略一个跨度时,文本内容以类似 `[…NNln elided; re-read needed ranges, e.g. <path>:5-16,40-80]` 的页脚结尾,使用实际省略处的具体范围。
  - 当省略块位于匹配的花括号行之间时,`#renderSummary()` 可能将它们合并为一个锚定行,而不是分别输出开/闭花括号行。
- 显式选择器或摘要未命中:流式文本读取。
  - 默认开放结尾限制是 `read.defaultLimit = 300`,限制在 `[1, DEFAULT_MAX_LINES]`。
  - 单个有界非原始文本范围在受限侧添加 `RANGE_LEADING_CONTEXT_LINES = 1` / `RANGE_TRAILING_CONTEXT_LINES = 3` 行。原始和多范围读取精确;目录列表选择器无上下文地切片渲染条目。
  - 非原始输出使用 `resolveFileDisplayMode()`:
    - 当编辑模式为 hashline、读取非原始、源可变且编辑工具存在时,输出 hashline 编号行
    - 否则在 `readLineNumbers === true` 时可选择行号
    - 原始模式抑制两者
- hashline 模式的前缀格式是 `[PATH#TAG]` 头部后跟 `LINE:TEXT`,例如 `[src/foo.ts#0A1B]` 和 `41:def alpha():`,来自会话快照存储加上 `formatNumberedLine()` / `formatHashlineHeader()`。
- `edit`/hashline 路径稍后消费该头部加上裸行号;四十六进制标签是整个规范化文件的内容派生哈希,可通过记录它的会话快照存储解析。不可变源和 `:raw` 有意抑制 hashline 头部。

### 目录列表
- `#readDirectory()` 调用 `buildDirectoryTree()`,参数:
  - `maxDepth = 2`
  - `perDirLimit = 12`
  - `rootLimit = null`
  - 存在行选择器时 `lineCap = limit`,否则此层无限制
- `buildDirectoryTree()` 按最近时间对兄弟项排序,显示文件大小和相对年龄,树截断时可能标记 `limits.resultLimit`。
- 空目录渲染为 `(empty directory)`。

### 归档

- 支持的归档容器:`.tar`、`.tar.gz`、`.tgz`、`.zip`,以及 ZIP 格式别名 `.jar`、`.war`、`.ear` 和 `.apk`。
- 语法:`archive.ext`、`archive.ext:path/inside`、`archive.ext:path/inside:50-60`。
- `openArchive()` 按格式分支:
  - tar/tgz 将整个归档读入内存(上限 `MAX_TAR_ARCHIVE_BYTES = 256 MiB`),并用 `new Bun.Archive(bytes)` 索引
  - ZIP 和 ZIP 别名通过范围化中央目录读取索引;成员按需使用原始 DEFLATE(`node:zlib`)解压,单个提取上限为 `MAX_ARCHIVE_MEMBER_BYTES = 64 MiB`
- 归档路径规范化 `/`,丢弃 `.` 段,拒绝 `..`。
- 目录读取列出直接子项;文件显示 `name`,大小 > 0 时加上 ` (size)`。
- 目录列表默认限制是 `#readArchiveDirectory()` 中的 `500` 个条目。
- 文件条目以 UTF-8 解码。非 UTF-8 条目返回 `[Cannot read binary archive entry '...' (...)]` 而不是字节。
- 文本归档条目复用正常的进程内分页/锚定路径。

### 性能分析报告
- 识别的 macOS `sample` 调用树文件(`*.sample.txt`)和 V8 `.cpuprofile` JSON,在有效且至多 `32 MiB` 时渲染为瓶颈摘要而不是原始转储。
- 行选择器对渲染摘要分页。`:raw` 绕过配置渲染并读取原始文件。
- 仅具有这些名称/扩展名之一、但无法按预期报告解析的文件,回退到普通文本处理。

### SQLite 数据库
- 数据库检测要求同时有匹配的扩展名和有效的 SQLite 文件头(`isSqliteFile()`)。
- `parseSqliteSelector()` 中的选择器形式:

#### `db.sqlite`
- `kind: "list"`
- 列出非 `sqlite_%` 表及其行数。
- `#readSqlite()` 通过 `applyListLimit()` 将渲染列表上限设为 `500` 个表。

#### `db.sqlite:table`
- `kind: "schema"`
- 返回 `sqlite_master.sql` 加上示例行。
- 示例大小为 `DEFAULT_SCHEMA_SAMPLE_LIMIT = 5`。

#### `db.sqlite:table:key`
- `kind: "row"`
- 当表恰好有一个主键列时按主键解析;否则回退到 `rowid` 查找。
- 行查找不允许查询参数。

#### `db.sqlite:table?limit=...&offset=...&order=...&where=...`
- `kind: "query"`
- 默认值:`limit = 20`,`offset = 0`。
- `limit` 上限为 `500`。
- `order` 接受 `column` 或 `column:asc|desc`,且必须命名现有列。
- `where` 仅在 `validateWhereClause()` 拒绝注释、分号以及 `LIMIT`、`OFFSET`、`UNION`、`ATTACH`、`PRAGMA` 等控制关键字后接受。
- 未知查询参数抛错。

#### `db.sqlite?q=SELECT ...`
- `kind: "raw"`
- 不能与表选择器或任何其他查询参数组合。
- 空的 `q` 抛错。
- `executeReadQuery()` 准备 SQL,拒绝绑定参数,并从 `statement.iterate()` 收集行,上限为 `MAX_RAW_QUERY_ROWS = 1000`;它不验证 SQL 以 `SELECT` 开头。

- `packages/coding-agent/src/tools/sqlite-reader.ts` 中的渲染上限:
  - ASCII 表宽度 `120`(`MAX_RENDER_WIDTH`)
  - 每列宽度 `40`(`MAX_COLUMN_WIDTH`)
- `#readSqlite()` 以 `{ readonly: true, strict: true }` 打开 Bun SQLite,并设置 `PRAGMA busy_timeout = 3000`。

### 文档
- `packages/coding-agent/src/tools/read.ts` 中的 `CONVERTIBLE_EXTENSIONS` 涵盖 `.pdf`、`.doc`、`.docx`、`.ppt`、`.pptx`、`.xls`、`.xlsx`、`.rtf`、`.epub`。
- `convertFileWithMarkit()` 将文件转换为文本/markdown;行范围和 `:raw` 选择器随后应用于转换输出(`file.pdf:50-100`、`:5-16,40-80`)。
- 对于 PDF,嵌入图片以可浏览句柄形式呈现。markit 为每个嵌入图片发出 `<!-- image: <id> (page N, WxHpt) -->` 区域;`read.ts` 将其改写为 `read <pdf>:<id>.png` 提示(作为行内代码,路径中的空格/括号不会破坏 markdown)。读取该句柄(`doc.pdf:p11-img0.png`)提取图片 — 向 markit 传递落在会话产物缓存中的 `imageDir`(`<artifacts>/pdf-assets/<key>/`,按大小+mtime 键控,每个文件转换一次)— 并通过正常的图片加载路径返回。`doc.pdf:` 列出可提取成员;未知成员报错并附可用列表。请求的成员与提取的 basename 匹配,因此 `..`/分隔符无法逃出缓存。
- 转换失败返回类似 `[Cannot read .pdf file: ...]` 的文本块。

### Jupyter notebooks
- 除非请求了 `:raw`,`.ipynb` 走 `readEditableNotebookText()`。
- 输出是可编辑的纯文本,带有类似标记:

```text
# %% [code] cell:0
...
```

- 原始模式绕过该转换,回退到文件文本读取。

### 图片
- 图片检测基于元数据(`readImageMetadata()`)。
- 最大接受的图片大小是 `20 MiB`(`MAX_IMAGE_INPUT_BYTES`,重新导出为 `MAX_IMAGE_SIZE`)。更大的文件抛错。
- 如果有效的 `inspect_image` 状态为活动(模式 `on`,或 `auto` 且活动模型缺乏原生图片输入),`read` 只返回元数据(MIME、字节、尺寸、通道、alpha),并附调用 `inspect_image` 的建议。
- 否则它调用 `loadImageInput()` 并返回:
  - 来自图片加载器的文本说明
  - 内联图片块
- 不支持/无法解码的图片格式抛 `ToolError`。

### 内部 URL
- `read` 将内部和 MCP 声明的协议委托给 `InternalUrlRouter`;内置注册表目前包括 `agent://`、`artifact://`、`history://`、`issue://`、`local://`、`mcp://`、`memory://`、`omp://`、`pr://`、`rule://`、`security://`、`skill://`、`ssh://`、`vault://` 和 `xd://`。
  - `security://` 保留给 OMP 拥有的、生产商中立、只读的安全分析存储。
  - `xd://` 列出挂载的工具设备;`xd://<name>` 返回该设备的输入文档。向同一 URI 写入 JSON 会通过 `write` 分派该设备。
  - `ssh://host/<path>` 读取远程 UTF-8 文件或目录;裸 `ssh://` 列出已配置主机。远程路径限制为 1 MiB,需要 POSIX 远程 shell。对路径中的字面 `:`、`?` 或 `#` 进行百分号编码。
- `#handleInternalUrl()` 行为:
  - 用 `parseInternalUrl()` 解析 URL,使主机段内的冒号合法
  - 对 `agent://`,将非根路径提取或 `?q=` 提取视为特殊的无分页模式
  - 将 `artifact://` 路由到有界产物文件读取器和大输出工作流提示
  - 否则在内存中对解析文本分页
  - 将 `immutable` 传递给 `resolveFileDisplayMode()`,使产物、技能、记忆和 Agent 输出等不可变资源的锚点被抑制
  - 对 `skill://` 设置 `ignoreResultLimits: true`,使完整技能文本仅由显式选择器分页,而不受常规默认行限制约束
- `conflict://` 与路由器分开处理。`<path>:conflicts` 注册块;`conflict://<N>` 读取一个已注册的标记块,`/ours`、`/theirs`、`/base` 或 `/both` 选择一侧。`conflict://*` 只写。
- `issue://<N>` / `pr://<N>`(以及长形式 `issue://<owner>/<repo>/<N>` / `pr://<owner>/<repo>/<N>`)通过 `github` 工具写入的同一个 SQLite 缓存路由;`?comments=0` 选择无评论渲染。裸 `issue://` / `pr://`(以及仓库限定变体)用 `?state=`、`?limit=`、`?author=` 和 `?label=` 浏览实时列表。PR 差异使用 `pr://<N>/diff`、`/diff/<i>` 和 `/diff/all`。

### Web URL
- `parseReadUrlTarget()` 接受 `http://`、`https://` 或 `www.` 目标。
- 普通 URL 读取调用 `packages/coding-agent/src/tools/fetch.ts` 中的 `executeReadUrl()`。
- `:raw` 表示原始 HTML/正文回退路径;普通 URL 读取优先渲染/阅读器友好输出。
- `:N`、`:A-B`、`:A+C` 和逗号分隔的多范围在缓存输出可用时不重新获取。它们对先前或当前 URL 渲染的缓存输出分页。
- `renderUrl()` 中的 URL 渲染流水线:
  1. 规范化协议(裸 `www.` 添加 `https://`)
  2. 除非原始模式,尝试已知站点的特殊处理器
  3. 用 `loadPage()` 获取
  4. 如果内容是图片/PDF/DOCX 等,尝试二进制获取 + markit/图片处理
  5. 直接处理 JSON、通过 feed 解析器处理 feed、直接处理纯文本
  6. 对于 HTML 和非原始模式,尝试 markdown 替代、`URL.md`、内容协商、feed 替代、HTML 转文本渲染器、提取的链接文档,然后 `llms.txt`
  7. 回退到原始正文文本/html
- URL 输出带一个小头部:

```text
URL: ...
Content-Type: ...
Method: ...
Notes: ...

---
```

- `method` 记录获胜路径(`json`、`feed`、`text`、`alternate-markdown`、`md-suffix`、`content-negotiation`、`image`、`markit`、`llms.txt`、`raw`、`raw-html` 等)。
- 当获取的资源是支持的图片且能通过大小调整时,URL 读取可能返回内联图片块。

## 副作用
- 文件系统
  - 打开并流式读取本地文件。
  - 索引前将 tar/tgz 归档完整读入内存(256 MiB 上限);ZIP 归档通过范围化中央目录读取索引。
  - 可能从会话产物目录读取 URL 缓存产物文件。
  - 当 URL 输出被截断,或行范围分页需要持久化缓存正文时,写入 URL 输出产物。
- 网络
  - URL 模式执行 HTTP 获取、二进制重新获取和备选端点探测。
- 子进程 / 原生绑定
  - 对 `.db`/`.sqlite*` 使用 Bun SQLite。
  - 对 tar/tgz 使用 `Bun.Archive`;ZIP 在 `node:zlib` DEFLATE 编解码器之上于 `packages/coding-agent/src/utils/zip.ts` 中构建帧。
  - URL HTML 渲染可以委托给 `packages/coding-agent/src/tools/fetch.ts` 中的站点处理器和 HTML 转文本后端。
- 会话状态
  - 将本地文本读取的整文件快照记录到 `session.fileSnapshotStore`,供后续陈旧锚点恢复。
  - 将会话 `cwd`、`settings` 和 `localProtocolOptions` 传递给进程全局 `InternalUrlRouter.instance().resolve()` 用于内部 URL。
  - 使用 `session.allocateOutputArtifact()` 用于缓存/截断的 URL 输出。
- 后台工作 / 取消
  - 只有确定性磁盘读取不可中止:普通文件行/范围读取(`streamLinesFromFile`、多范围)和目录列表(`#readDirectory`)用 `undefined` 而不是 `AbortSignal` 调用,因此读取中途的中断不会在本可即时完成的读取上表面误导性的 "Operation aborted"。每个其他分支保留信号,其辅助函数调用 `throwIfAborted(signal)` 及时停止:URL/内部 URL 读取(网络)、归档、sqlite、文档转换、图片解码、结构摘要、冲突扫描和后缀 glob 路径解析。

## 限制与上限
- `packages/coding-agent/src/session/streaming-output.ts` 中的共享文本截断默认值:
  - `DEFAULT_MAX_LINES = 3000`
  - `DEFAULT_MAX_BYTES = 50 * 1024`
- 本地文本开放结尾默认行限制:`read.defaultLimit`(默认 `300`),限制在 `[1, DEFAULT_MAX_LINES]`。
- 单个有界非原始文本范围在受限侧添加 `1` 行前导和 `3` 行尾部上下文。原始和多范围读取精确。
- 文件流式分块大小:`8 * 1024` 字节(`READ_CHUNK_SIZE`)。
- 行读取的本地流式字节预算:`max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512)`。
- 结构摘要仅在文件大小 `<= 2 MiB` 且行数 `<= 20_000` 时运行。
- 配置摘要仅对至多 `32 MiB` 的识别报告运行;`:raw` 绕过它们。
- 图片输入最大值:`20 MiB`。
- 本地目录的目录树上限:深度 `2`,每目录子项 `12`。
- 归档目录默认列表上限:`500` 个条目;归档成员上限 `64 MiB`,tar/tgz 容器上限 `256 MiB`。
- SQLite:
  - 默认行查询限制 `20`
  - schema 示例限制 `5`
  - 最大查询限制 `500`
  - 原始 `?q=` 行上限 `1000`(`MAX_RAW_QUERY_ROWS`)
  - 表列表上限 `500`
  - 渲染宽度 `120`,列宽 `40`
  - busy 超时 `3000` ms
- 展示给模型的 URL 读取结果在 `executeReadUrl()` 中被截断为 `300` 行和 `50 KiB`;完整缓存输出可附加为产物。
- 内联获取的 URL 图片:
  - 源字节上限 `20 MiB`
  - 调整大小后的内联输出上限 `300 KiB`
- 唯一后缀自动解析 glob 超时:`5000` ms。
- 文件快照存储保存 `30` 个路径,每个最多 `4` 个版本(`packages/hashline/src/snapshots.ts` 中的 `DEFAULT_MAX_PATHS` / `DEFAULT_MAX_VERSIONS_PER_PATH`);超过 `4 MiB`(`SNAPSHOT_MAX_BYTES`)的文件不进行快照。
- 当产物超过 `50 KiB` 时,无界 `artifact://<id>:raw` 读取被拒绝;请使用有界 `:raw:N-M` 范围。

## 错误
- 校验和操作失败以 `ToolError` 形式呈现。
- 选择器错误包括:
  - `Line selector 0 is invalid; lines are 1-indexed. Use :1.`
  - 无效的 `A+B` / `A-B` 形状
  - `Cannot combine query extraction with line selectors`,用于 `agent://.../path:50`
  - 目录/归档目录列表上的多范围
- `conflict://*` 读取被拒绝;未知/过期的冲突 id 需要重新读取 `<path>:conflicts`。
- 缺失的本地/归档/sqlite 路径首先尝试唯一后缀解析;如果没有唯一匹配或受保护恢复则报错。
- 越界行读取不抛错。它们返回解释性文本,并附类似 `Use :1 ...` 或 `Use :<last line> ...` 的建议。
- 可能的二进制本地文件返回提示,除非请求了 `:raw`。
- 二进制归档条目不抛错;它们返回文本提示。
- 文档转换失败返回文本提示。
- 图片超尺寸/不支持/无效情况抛错。
- SQLite 解析器及早拒绝不支持的参数组合;DB/运行时错误被捕获并以 `ToolError(message)` 重新抛出。
- 当 HTTP 获取成功但 `response.ok === false` 时,URL 获取失败不抛错;它返回 `method: "failed"` 的失败 URL 读取和解释性 notes。
- 大型无界原始产物读取返回工作流提示,而不是将产物加载到内存。

## 注释
- hashline 锚点对原始读取和不可变内部资源被抑制,因为后面没有可编辑的后备目标供 `edit` 消费。
- `splitPathAndSel()` 有意将未知尾部 `:...` 视为路径的一部分,使 `archive.zip:inner/file` 和 `db.sqlite:table:key` 仍可用。
- `resolveReadPath()` 包含 macOS 特定的文件名回退,用于截图时间戳、NFD Unicode 规范化和花引号。
- 裸 `/` 解析为会话 cwd,而不是文件系统根。
- URL 缓存键是会话范围的,按请求 URL + 原始/渲染模式规范化;请求的 URL 和最终重定向 URL 都被缓存。
- URL 行范围读取请求 `ensureArtifact: true, preferCached: true`,使后续分页读取可以从产物存储重新打开同一渲染正文。
- 原始 SQLite `q=` 执行除“无绑定参数”外无关键字限制;读取工具依赖周围契约保持只读。
- 文件快照存储不是读取加速缓存。它存在的目的是在读取后文件发生变化时校验和恢复 hashline 编辑。
