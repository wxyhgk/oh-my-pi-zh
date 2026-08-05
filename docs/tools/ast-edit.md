# ast_edit

> 通过原生 ast-grep 预览并应用对源文件的结构化重写。

## 来源
- 入口:`packages/coding-agent/src/tools/ast-edit.ts`
- 模型提示词:`packages/coding-agent/src/prompts/tools/ast-edit.md`
- 主要协作方:
  - `crates/pi-natives/src/ast.rs` — 原生重写规划与文件变更
  - `crates/pi-ast/src/language/mod.rs` — 原生包装器使用的语言别名与扩展名推断
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径/glob 解析与多路径解析
  - `packages/coding-agent/src/tools/resolve.ts` — 预览/应用排队
  - `packages/coding-agent/src/tools/render-utils.ts` — 解析错误去重与显示上限
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline 与行号差异引用
  - `packages/hashline/src/format.ts` — 预览锚点的稳定 hashline 头部格式
  - `packages/natives/native/index.d.ts` — JS 可见的原生绑定契约

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `ops` | `{ pat: string; out: string }[]` | 是 | 一个或多个重写规则。`pat` 必须非空。重复的 `pat` 值会在原生执行前失败。空 `out` 表示删除匹配节点。 |
| `paths` | `string[]` | 是 | 一个或多个文件、目录、glob 或基于路径的内部 URL。至少需要一个非空条目。内部 URL 的 glob 会被拒绝;抓取的远程 URL 是只读的,无法被重写。 |

共享的 AST 模式语法与语言目录:参见 [`ast_grep`](./ast-grep.md#inputs)。

- `ast_edit` 使用相同的 `$NAME`、`$_`、`$$$NAME` 和 `$$$` 元变量语义。
- 工具提示词补充了重写专属约束:
  - 元变量名必须大写,且必须代表完整 AST 节点,
  - `pat` 中的捕获会替换进 `out`,
  - 每次重写都是 1:1 的结构替换;一个捕获不能扩展为多个兄弟节点,除非语法本身在该位置允许这种扩展。

`ast_edit` 默认由 `astEdit.enabled` 启用。它是可发现工具,而非必备工具集的一部分。

## 输出
- `ast_edit` 自身的单次预览结果。非空提案以 `Staged as a proposal — files NOT modified yet...` 开头,并指名 resolve/reject 设备路径。
- 面向模型的 `content` 是一个文本块,展示提议的编辑,目录/多文件运行时按文件分组。
  - 每次变更渲染为两行。Hashline 模式在 `[PATH#TAG]` 头下使用 `-LINE:before` / `+LINE:after`;普通模式使用 `-LINE:COLUMN before` / `+LINE:COLUMN after`。
  - 每个 `before`/`after` 片段只显示第一行,包装器中截断到 120 个字符。
  - 适用时附加 `Limit reached; narrow paths.` 与格式化后的解析问题。
- 若没有重写匹配,文本为 `No replacements made`,存在解析问题时附上格式化解析问题。
- `details` 包含聚合预览元数据:
  - `totalReplacements`、`filesTouched`、`filesSearched`、`applied`、`limitReached`
  - 可选的 `parseErrors`、`parseErrorsTotal`、`scopePath`、`files`、`fileReplacements`、`displayContent`、`searchPath`、`cwd`、`meta`
- 该工具始终先预览(直接结果中 `applied: false`)。实际文件写入只会在稍后通过向 `xd://resolve` 的纯文本 `write` 进行;正文是理由。
- 当预览产生替换时,`ast_edit` 还会排队一个待处理的 resolve 动作。成功应用会返回单独的 resolve 派发结果(在 `write` 调用上),而不是另一个 `ast_edit` 结果。

## 流程
1. `AstEditTool.execute()` 在 `packages/coding-agent/src/tools/ast-edit.ts` 中校验每个 op:
   - 空 `pat` 失败,
   - 至少需要一个 op,
   - 重复的 `pat` 值失败,
   - ops 转换为 `Record<pattern, replacement>`。
2. 包装器通过 `$envpos(..., 1000)` 读取 `PI_MAX_AST_FILES`,并将其用作预览和应用的原生 `maxFiles` 上限。
3. 路径规范化、内部 URL 处理、缺失路径分区与多路径解析与 `ast_grep` 遵循相同的 `path-utils.ts` 流程。
4. 作用域的 `isDirectory` 标志(由 `resolveToolSearchScope` 中的 stat 设置)决定是否渲染分组目录输出。
5. `runAstEditOnce(...)` 在第一遍始终以 `dryRun: true` 和 `failOnParseError: false` 运行原生 `astEdit(...)`。
6. `crates/pi-natives/src/ast.rs` 中的原生 `ast_edit`:
   - 规范化重写映射并按模式字符串排序规则,
   - 解析严格度(默认 `smart`),
   - 从文件或 gitignore 感知的目录扫描中收集候选文件,
   - 除非内部提供了 `lang`,否则为每个候选文件独立推断语言,
   - 为每种发现的语言编译每条重写规则;无法在某语言中解析的规则会跳过该语言的文件并报告解析问题,
   - 解析每个文件,跳过带语法错误树的文件,为每个匹配收集 `replace_by(...)` 编辑,执行替换数与文件数上限,并返回文本化的 before/after 片段与源范围。
7. TS 包装器对解析错误去重并设上限,按文件分组变更,并渲染预览差异行。
8. 若预览发现替换且 `applied` 为 false,`queueResolveHandler(...)` 注册一个非强制的待处理 resolve 调用器。待处理期间,会话呈现一个 `SoftToolRequirement`(`toolName: "write"`,带 `xd://resolve` 或 `xd://reject` 的 `satisfies` 谓词)并携带 resolve 提醒;若模型在该轮拒绝,Agent 运行时注入提醒并强制 `write`。
9. 在 `write xd://resolve` 派发时,排队的回调以 `dryRun: false` 重新运行同一组重写,重新计算计数,若实时结果不再匹配预览则返回错误结果(`stalePreview`)。当前实现比较重跑后的替换总数与每文件计数;若新运行已写入不同计数,结果标记为错误。
10. 在非过期(stale)应用时,回调返回 `Applied N replacements in M files.`(hashline 模式下后面跟根据应用后内容重新记录的 `[path#tag]` 快照头);丢弃(`write xd://reject`)时,派发返回一条丢弃消息而不改动文件。

## 模式 / 变体
- 单文件:对单个文件预览或应用。
- 目录 + 可选 glob:原生扫描遍历目录,然后按编译后的 glob 过滤。
- 多个显式路径/glob:包装器将它们合并为一个合成作用域,或当路径仅在根处相交时按目标运行原生调用。
- 内部 URL 输入:仅当路由器将其解析为后备文件路径时支持。
- 预览模式:始终是 `ast_edit` 工具的直接结果。
- 应用模式:只能通过预览后排队的 resolve 回调(向 `xd://resolve` 或 `xd://reject` 的 `write`)到达。
- Hashline 输出模式与普通行/列模式:由 `resolveFileDisplayMode()` 控制。

## 副作用
- 文件系统
  - 预览读取文件并扫描目录。
  - 应用先在内存中暂存每个变更文件,验证完整一轮后写入暂存文件;后续的计算/重叠失败不会部分改动先前的文件。
- 会话状态(转录、记忆、任务、检查点、注册表)
  - 通过 `queueResolveHandler(...)` 注册非强制的待处理 resolve 调用器。
  - 待处理期间呈现 `SoftToolRequirement`(带 resolve 提醒);Agent 运行时仅在未遵从时强制 `write` — 没有引导消息,也没有每次预览的强制工具选择。
- 用户可见提示 / 交互式 UI
  - 直接 `ast_edit` 结果是预览。
  - 后续应用/丢弃通过向 `xd://resolve` 与 `xd://reject` 的写入暴露。
- 后台工作 / 取消
  - 原生预览/应用工作通过 `task::blocking(...)` 在阻塞工作线程上运行。
  - 取消与可选的原生超时通过 `CancelToken::heartbeat()` 协作进行。

## 限制与上限
- 包装器暴露的文件上限:`PI_MAX_AST_FILES`,默认 `1000`,位于 `packages/coding-agent/src/tools/ast-edit.ts`。
- 原生 `maxFiles` 与 `maxReplacements` 在 `crates/pi-natives/src/ast.rs` 中提供时都至少钳制为 `1`。
- 包装器从不设置 `maxReplacements`;因此原生行为默认对一次运行几乎不限替换数。
- 解析问题在 `packages/coding-agent/src/tools/render-utils.ts` 中通过 `capParseErrors(...)` 去重并限制为 `PARSE_ERRORS_LIMIT = 20` 条;`details.parseErrors` 携带限制后的列表,`details.parseErrorsTotal` 携带限制前的去重计数。
- 目录扫描使用 `include_hidden: true`、`use_gitignore: true`,并跳过 `node_modules`,除非 glob 文本在 `crates/pi-natives/src/ast.rs` 中显式提到 `node_modules`。
- 没有单独的 glob 展开计数上限。候选数即解析路径/glob 在 gitignore 过滤后展开的数量,然后原生 `maxFiles` 在达到配置的触及文件数后停止变更。
- 预览文本在 `packages/coding-agent/src/tools/ast-edit.ts` 中将每个渲染的 `before` 与 `after` 首行截断到 120 个字符。

## 错误
- TS 包装器对空模式、重复的重写模式、空路径条目、不支持的内部 URL glob、没有 `sourcePath` 的内部 URL 以及缺失路径抛出 `ToolError`。
- 原生代码对以下情况返回硬错误:
  - 无法为候选推断受支持的语言(在包装器尽力模式下作为解析问题报告),
  - 内部/原生调用中不支持的显式 `lang`,
  - glob 编译失败或搜索根不可读,
  - 重叠的计算编辑(`Overlapping replacements detected; refine pattern to avoid ambiguous edits`),
  - 越界编辑范围或非 UTF-8 替换文本,
  - 应用期间的写入失败,
  - 取消或超时。
- 使用 `failOnParseError: false`(包装器始终使用)时,模式编译失败与文件解析失败成为 `parseErrors`,而不是中止整个运行。
- 若每条重写模式都编译失败,原生 `ast_edit` 返回成功的零替换结果,并填充 `parseErrors`。
- 包含 tree-sitter 错误节点的文件会跳过重写;它们不会获得部分编辑。
- 若预览变陈旧,应用可能在成功预览后失败。resolve 回调比较替换总数与每文件计数,对不匹配的预览返回错误结果,而不是静默报告成功。

## 备注
- `ast_edit` 不向模型暴露原生 `lang`、`strictness`、`selector`、`maxReplacements`、`failOnParseError` 或 `timeoutMs` 字段。运行时将调用形态固定为预览优先、smart 严格度、尽力解析模式。
- 支持混合语言作用域:原生层推断每个候选的语言,并为每种发现的语言编译每条规则。只对部分语言可解析的模式会重写那些文件,并为不兼容语言报告解析问题。
- 幂等性不在语法上强制。类似 `foo($A) -> foo($A)` 的重写预览为零变更,因为输出等于输入;持续匹配自身输出的重写可能在重复调用时仍然产生替换。
- 重写按文件累积,然后在重叠检查后从文件末尾向前应用。独立匹配可以共存;重叠匹配中止运行。
- 原生重写规则顺序按模式字符串排序,而非原始 `ops` 数组顺序,因为 `normalize_rewrite_map(...)` 对 `(pattern, rewrite)` 对排序。
- 预览/应用一致性通过应用重跑后的总数与每文件计数验证,而非对每个替换负载逐字节比对。
