# glob

> 通过 glob 查找文件系统路径;需要按内容匹配而非路径匹配时,请使用 `grep`。

## 来源
- 入口:`packages/coding-agent/src/tools/glob.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/glob.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/path-utils.ts` — 规范化输入;拆分基路径与 glob。
  - `packages/coding-agent/src/tools/list-limit.ts` — 应用结果数量上限。
  - `packages/coding-agent/src/session/streaming-output.ts` — 按字节上限截断文本输出。
  - `packages/coding-agent/src/tools/tool-result.ts` — 构建 `content` 与 `details.meta`。
  - `packages/coding-agent/src/tools/output-meta.ts` — 编码限制/截断元数据。
  - `packages/coding-agent/src/tools/tool-errors.ts` — 映射面向用户的工具错误。
  - `packages/coding-agent/src/tools/index.ts` — 注册内置的本地实现。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | `string` | 否 | Glob、文件、目录或基于路径的内部 URL。多个目标用 `;` 分隔;省略或为空时默认为 `.`。已存在且包含分隔符的路径保持原样。每个目标都会成为独立的遍历根,多目标扫描并发执行。仅 `memory://` 支持内部 URL 的 glob 模式;`ssh://` 因没有本地后备路径而被拒绝。 |
| `hidden` | `boolean` | 否 | 是否包含隐藏文件。默认为 `true`。 |
| `gitignore` | `boolean` | 否 | 本地原生 glob 扫描时是否遵循 `.gitignore`。默认为 `true`;设为 `false` 可包含被 gitignore 忽略的文件。 |
| `limit` | `number` | 否 | 返回路径的最大数量。默认为 `200`;有限的正常输入会先向下取整,再钳制到 `1..200`。 |

`glob` 默认启用(`glob.enabled = true`),是必备工具。

## 输出
该工具返回单个文本块以及结构化 `details`。

- 成功文本:匹配路径以多层、前缀折叠的目录树形式分组(`formatGroupedPaths()`):每层嵌套一个 `#`,单子目录链折叠为一个头部(`# a/b/c/`),文件在最深层的所属头部下列出;根级匹配不带头部列出。目录匹配带尾部 `/`。精确文件输入将该文件路径作为一行返回。
- 空结果文本:`No files found matching pattern`,可选地后跟超时或缺失路径提示。
- 多路径部分缺失:在结果块之后(或空结果行之后)追加 `Skipped missing paths: ...`。
- `details` 可能包含:
  - `scopePath`:所搜索根目录或合并后根目录的显示形式。
  - `fileCount`:结果限制后返回的路径数量。
  - `files`:以数组形式返回的路径。
  - `truncated`:是否发生了结果数量或字节截断。
  - `resultLimitReached`:是否已达到结果限制。
  - `missingPaths`:多路径调用中跳过的缺失输入。
  - `truncation` / `meta.limits`:供渲染器使用的结构化截断与限制元数据。
- 流式输出:当运行时提供 `onUpdate` 时,本地实现在 glob 扫描期间发出增量、换行分隔的文本快照,节流为 200 ms。最终输出是分组的;流式快照则不是。

## 流程

1. `GlobTool.execute()` 将可选的分号分隔的 `path` 字符串转换为根目录(默认为 `.`),保留已存在的包含分隔符的路径。除非注入了自定义操作,否则它会用 `expandDelimitedPathEntries(..., parseFindPattern)` 展开这些根目录。
2. 该工具用 `normalizePathLikeInput()` 规范化每个条目,并执行 `/\\/g -> "/"`。空白的规范化条目会以 `` `path` must contain non-empty globs or paths `` 失败。
3. 对于多路径本地调用,`partitionExistingPaths(..., parseFindPattern)`(`packages/coding-agent/src/tools/path-utils.ts`)会对每个基路径执行 stat。缺失条目会被跳过;若全部缺失,该工具抛出 `Path not found: ...`。单一路径缺失仍会硬性失败。
4. 该工具为多条目调用调用 `resolveExplicitFindPatterns()`;它将每个条目解析为独立的 `(basePath, globPattern, hasGlob)` 目标,使每个路径都作为自己的根目录被遍历(折叠到共享祖先会扫描无关的兄弟目录)。单条目调用直接用 `parseFindPattern()` 解析。
5. `parseFindPattern()` 确定 `(basePath, globPattern, hasGlob)`:
   - 没有 glob 字符(`*`、`?`、`[`、`{`)⇒ 用隐式 `**/*` 搜索该路径。
   - 第一个段含有 glob ⇒ 从 `.` 开始搜索,并且除非模式已以 `**/` 开头,否则为其加上 `**/` 前缀。
   - 路径后面含有 glob ⇒ 在第一个含 glob 的段处拆分。
6. `resolveToCwd()` 将基路径转换为会话 cwd 下的绝对路径。解析为 `/` 时以 `Searching from root directory '/' is not allowed` 拒绝。
7. `limit` 默认为 `DEFAULT_LIMIT`(`200`),必须为正且有限,先向下取整,再钳制到 `MAX_LIMIT`(`200`)。`hidden` 和 `gitignore` 均默认为 `true`。内部超时 `5` 秒(`5000` ms)通过 `AbortSignal.timeout(...)` 构建。
8. 随后执行分支:
   - **自定义操作分支**:如果存在 `GlobToolOptions.operations.glob`,该工具先用 `operations.exists()` 检查存在性,可用时通过 `operations.stat()` 对精确文件输入短路处理,然后调用 `operations.glob(globPattern, searchPath, { ignore: ["**/node_modules/**", "**/.git/**"], limit })`。
   - **内置本地分支**:该工具对每个目标的 `searchPath` 执行 stat。精确文件输入立即返回。目录输入以 `hidden`、`maxResults: effectiveLimit`、`sortByMtime: true`、`gitignore: useGitignore`、`recursive: false`(递归来自 `parseFindPattern()` 添加的 `**/` 前缀)以及组合后的中止信号调用 `natives.glob()`;多目标调用并发执行各自的 glob。
9. 在本地分支中,可选的 `onMatch` 回调将每个匹配转换为相对 cwd 的显示路径,并发出节流后的进度更新。
10. 原生 glob 返回后,JS 合并各目标的结果,对重复的显示路径去重,并在格式化路径之前按 `mtime` 降序对合并列表排序。
11. `buildResult()` 应用 `applyListLimit()` 将数组再次限制在 `effectiveLimit`,用 `formatGroupedPaths()`(来自 `@oh-my-pi/pi-utils`)格式化路径,追加提示,然后以 `maxLines: Number.MAX_SAFE_INTEGER` 运行 `truncateHead()`。实际上这保留了 50 KB 字节上限,同时禁用了默认的 3000 行上限。
12. `toolResult()` 将文本与 `details` 打包,并为渲染器记录结果限制/截断元数据。

## 模式 / 变体
- **精确文件路径**:如果解析后的输入没有 glob 且解析路径 stat 为文件,则输出该单一路径。
- **目录路径**:如果解析后的输入没有 glob 且 stat 为目录,该工具用隐式 `**/*` 搜索它。
- **单一 glob 路径**:由 `parseFindPattern()` 解析的单个输入。
- **多路径搜索**:由 `resolveExplicitFindPatterns()` 将多个输入解析为逐条目目标,每个目标作为自己的根并发遍历,之后再合并。
- **含缺失输入的部分多路径搜索**:本地多路径调用会跳过缺失的基路径,并将其作为 `missingPaths` / `Skipped missing paths: ...` 呈现。
- **内部 URL 输入**:支持精确的基于路径的 URL。`memory://` 还支持针对其后备树的 glob 模式。其他内部 URL glob 以及所有 `ssh://` 输入均被拒绝。
- **自定义委托搜索**:使用注入的 `GlobOperations` 而非本地 fs + 原生 glob。

## 副作用
- 文件系统
  - 对解析后的基路径执行 stat;在本地多路径模式下,会预先对所有候选基路径执行 stat。
  - 不写文件。
- 子进程 / 原生绑定
  - 内置本地模式调用原生 `@oh-my-pi/pi-natives` glob 实现。
- 会话状态(记录、记忆、任务、检查点、注册表)
  - 提供 `onUpdate` 时发出结构化进度更新。
  - 向工具结果添加截断/限制元数据。
- 后台工作 / 取消
  - 本地 glob 扫描可通过调用方的中止信号以及内部超时来取消。

## 限制与上限
- 默认结果限制:`200`(`DEFAULT_LIMIT`,位于 `packages/coding-agent/src/tools/glob.ts`)。
- 最大结果限制:`200`(`MAX_LIMIT`);更大的输入会被钳制。
- 本地 glob 超时:固定为 `5000` ms。
- 输出字节上限:`50 * 1024` 字节(`DEFAULT_MAX_BYTES`,位于 `packages/coding-agent/src/session/streaming-output.ts`)。
- `truncateHead()` 中的默认通用行数上限为 `3000`,但 `glob` 将 `maxLines` 覆盖为 `Number.MAX_SAFE_INTEGER`,因此实际的输出截断上限是字节数而非行数。
- 流式更新节流:`onUpdate` 两次发出之间间隔 `200` ms。
- 排序顺序:内置本地分支按最近的 `mtime` 优先排序,提示词中也有此承诺。即使原生 glob 收到 `sortByMtime: true`,该工具仍会在 JS 中重新排序,这样原生代码仍可在 `maxResults` 处提前停止。

## 错误
- 来自 `GlobTool.execute()` 的面向用户的 `ToolError` 包括:
  - `` `path` must contain non-empty globs or paths ``
  - `Path not found: ...`
  - `Searching from root directory '/' is not allowed`
  - `Limit must be a positive number`
  - `Path is not a directory: ...`
  - 超时结果文本为 `glob timed out after <seconds>s; returning <N> partial matches — narrow the pattern instead of retrying blindly`,并作为成功但截断的部分结果返回,而非错误。
  - `find cannot operate on a remote ssh:// path: ...`,用于 SSH 输入。
  - `Glob patterns are not supported for internal URLs: ...`,`memory://` 模式除外。
  - `Cannot find internal URL without a backing file: ...`,用于纯虚拟资源。
- 如果调用方中止,本地分支将 `AbortError` 转换为 `ToolAbortError`。
- 非 `ENOENT` 的 stat 失败及其他意外错误会被重新抛出。
- 空匹配不是错误;它们返回无文件文本结果。

## 备注
- 文件名/路径发现请使用 `glob`。当选择标准是文件内容或正则匹配时请使用 `grep`;`grep` 接受 `pattern` 并返回带锚点的内容匹配,而 `glob` 只返回匹配的路径(`packages/coding-agent/src/prompts/tools/glob.md`、`packages/coding-agent/src/prompts/tools/grep.md`)。
- 裸的顶层 glob 会变为递归。`*.ts` 解析为基 `.` 加上 glob `**/*.ts`;`src/*.ts` 保持在 `src` 根下,带非递归的 `*.ts` 段;`src/**/*.ts` 保留显式递归。
- 在内置本地分支中,`.gitignore` 默认启用。使用 `gitignore: false` 可在原生遍历中禁用它。
- `hidden` 默认为 `true`;排除隐藏文件是默认行为,可通过显式设置关闭(opt-out 而非 opt-in)。
- 多路径缺失输入容忍在两个分支中都适用,但只有内置本地分支会呈现 `missingPaths` / `Skipped missing paths: ...`。自定义操作分支仅在单输入调用中对缺失的 `searchPath` 硬性失败;在多输入调用中,缺失目标会静默地不贡献任何结果。
- 自定义 `GlobOperations.glob()` 钩子接收 `ignore` 和 `limit`,但不接收 `hidden` 标志或显式的 `.gitignore` 开关。远程委托若想与本地分支保持一致,必须自行处理这一点。
- 内置本地 glob 扫描不强制 `fileType: File`;它可以从原生 glob 返回文件和目录。目录输出也可能通过精确路径直通或返回目录的自定义委托产生。
