# ast_grep

> 通过原生 ast-grep 对受支持的源文件进行结构化代码搜索。

## 来源
- 入口:`packages/coding-agent/src/tools/ast-grep.ts`
- 模型提示词:`packages/coding-agent/src/prompts/tools/ast-grep.md`
- 主要协作方:
  - `crates/pi-natives/src/ast.rs` — 原生扫描、解析、匹配引擎
  - `crates/pi-ast/src/language/mod.rs` — 原生包装器使用的语言别名与扩展名推断
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径/glob 解析与多路径解析
  - `packages/coding-agent/src/tools/render-utils.ts` — 解析错误去重与显示上限
  - `packages/coding-agent/src/tools/match-line-format.ts` — hashline 匹配渲染
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline 与行号输出模式
  - `packages/natives/native/index.d.ts` — JS 可见的原生绑定契约

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `pat` | `string` | 是 | 单个 AST 模式。包装器会修剪它并拒绝空字符串。 |
| `path` | `string` | 否 | 要搜索的文件、目录、glob、内部 URL 或抓取的 Web URL。多个根用 `;` 分隔。省略或为空时默认为 `.`(工作区根)。内部 URL 的 glob 会被拒绝。 |
| `skip` | `number` | 否 | 匹配偏移。默认为 `0`,然后 `Math.floor(...)`;负数与非有限值失败。 |

向模型暴露的模式语法与语言支持:
- `$NAME` — 捕获一个 AST 节点。
- `$_` — 匹配一个 AST 节点而不绑定。
- `$$$NAME` — 捕获零个或多个 AST 节点;ast-grep 在下个可满足节点处惰性停止。
- `$$$` — 匹配零个或多个 AST 节点而不绑定。
- 元变量名必须大写,且必须代表完整 AST 节点,而非部分 token 或字符串片段。
- 模式必须解析为推断目标语言的一个有效 AST 节点。
- 受支持的规范语言来自 `crates/pi-ast/src/language/mod.rs` 中的 `SupportLang::all_langs()`:`astro`, `bash`, `c`, `cmake`, `cpp`, `csharp`, `dart`, `clojure`, `css`, `diff`, `dockerfile`, `emacs-lisp`, `elixir`, `erlang`, `fortran`, `go`, `graphql`, `haskell`, `hcl`, `html`, `ini`, `java`, `javascript`, `json`, `just`, `julia`, `kotlin`, `lua`, `make`, `markdown`, `nix`, `objc`, `ocaml`, `odin`, `php`, `powershell`, `protobuf`, `python`, `r`, `regex`, `ruby`, `rust`, `scala`, `solidity`, `sql`, `starlark`, `svelte`, `swift`, `toml`, `tlaplus`, `tsx`, `typescript`, `verilog`, `vue`, `xml`, `yaml`, `zig`。

`ast_grep` 默认禁用(`astGrep.enabled = false`),启用后为可发现工具。

## 输出
- 单次工具结果。
- 面向模型的 `content` 是一个文本块:
  - 目录/多文件搜索按文件分组,
  - 匹配行在 `[PATH#HASH]` 下渲染为 `*LINE:text`(hashline 模式)或 `*LINE|text`(其他情况),
  - 多行匹配的续行以空格开头渲染,
  - 当 ast-grep 捕获元变量时,每个匹配可选 `meta: NAME=value, …` 行。
- 若无匹配,文本为 `No matches found` 或 `No matches found. Parse issues mean the query may be mis-scoped; narrow paths before concluding absence.` 加格式化解析问题。
- 若包装器截断可见结果,文本以 `Result limit reached; narrow paths or increase limit.` 结尾。
- `details` 包含计数与元数据,而非完整匹配负载:
  - `matchCount`、`fileCount`、`filesSearched`、`limitReached`
  - 可选的 `parseErrors`、`parseErrorsTotal`、`scopePath`、`searchPath`、`cwd`、`files`、`fileMatches`、`displayContent`、`meta`
- 原生范围(`byteStart`、`byteEnd`、`startLine`、`startColumn`、`endLine`、`endColumn`)只存在于原生结果内;包装器不会直接向模型发出它们。

## 流程
1. `AstGrepTool.execute()` 修剪并校验 `pat`,规范化 `skip`,将分号分隔的 `path` 转换为根(默认 `.`),然后委托给 `resolveToolSearchScope()` 解析作用域。
2. 内部 URL 通过共享路由器解析;没有 `sourcePath` 的条目与内部 URL glob 失败。可读的远程 URL 会被物化为不可变的本地文件以供搜索。
3. 对多个路径输入,`partitionExistingPaths()` 仅当至少保留一个幸存基时才丢弃缺失基;若所有基都缺失则调用失败。
4. `parseSearchPathPreferringLiteral()` 将单个路径拆分为 `basePath` 加可选 `glob`。`resolveExplicitSearchPaths()` 将多个输入折叠为公共基加花括号联合 glob,或当公共祖先本身不是所请求路径之一时折叠为单独的 `targets`。
5. 包装器对解析后的基路径执行 stat,以决定输出是否应分组为目录结果。
6. 执行分派到:
   - 单个解析基的一次原生 `astGrep(...)` 调用,或
   - `runMultiTargetAstGrep(...)`,它对每个目标调用一次原生绑定,将路径重新基到公共根,全局排序,然后应用 `skip` 与包装器限制。
7. `crates/pi-natives/src/ast.rs` 中的原生 `ast_grep`:
   - 规范化并去重模式,
   - 解析 `MatchStrictness`(默认 `smart`),
   - 从文件或 gitignore 感知的目录扫描中收集候选文件,
   - 除非提供了 `lang`,否则按扩展名推断每个候选的语言,
   - 为每种存在的语言单独编译模式,
   - 读取每个文件,将语法错误树报告为解析问题,运行 `find_all`,并可选捕获元变量绑定。
8. 原生结果按路径与源位置排序,然后按 `offset`/`limit` 分页。
9. TS 包装器规范化解析错误字符串、去重、按格式化路径分组匹配、渲染锚点行、附加限制/解析提示,并返回 `toolResult(...).text(...).done()`。

## 模式 / 变体
- 单文件:原生路径为文件;输出为渲染匹配行的扁平列表。
- 目录 + 可选 glob:原生扫描遍历目录,然后按编译后的 glob 过滤。
- 多个显式路径/glob:包装器将它们合并为一个合成作用域,或当路径仅在根处相交时按目标运行原生调用。
- 内部 URL 输入:当路由器将其解析为后备文件路径时支持。可读的远程 URL 被物化为不可变的临时文件。
- Hashline 输出模式与普通行号模式:由 `resolveFileDisplayMode()` 控制;hashline 模式需要编辑工具与 hashline 编辑模式,每文件锚点额外需要成功的整文件快照(`recordFileSnapshot()`) — 超限或不可读文件回退为普通输出。

## 副作用
- 文件系统
  - 在 TS 包装器中 stat 输入路径。
  - 原生代码通过 `fs_cache` 读取匹配文件并扫描目录。
- 会话状态(转录、记忆、任务、检查点、注册表)
  - 除正常工具转录/结果元数据外无其他。
- 后台工作 / 取消
  - 原生工作通过 `task::blocking(...)` 在阻塞工作线程上运行。
  - 取消与可选的原生超时通过 `CancelToken::heartbeat()` 协作进行。

## 限制与上限
- 包装器可见的结果上限:`packages/coding-agent/src/tools/ast-grep.ts` 中的 `DEFAULT_AST_LIMIT = 50`。
  - 单目标调用依赖 `crates/pi-natives/src/ast.rs` 中原生默认限制 50。
  - 多目标调用每个目标获取 `skip + 50 + 1` 个匹配,全局排序后重新分页。
- 原生 `limit` 至少钳制为 `1`;省略的 `offset` 在 `crates/pi-natives/src/ast.rs` 中默认为 `0`。
- 解析问题在 `packages/coding-agent/src/tools/render-utils.ts` 中最多渲染 `PARSE_ERRORS_LIMIT = 20` 行;`capParseErrors()` 还将 `details.parseErrors` 限制为这 20 个唯一条目,`details.parseErrorsTotal` 持有限制前的去重总数。
- 目录扫描使用 `include_hidden: true`、`use_gitignore: true`,并跳过 `node_modules`,除非 glob 文本在 `crates/pi-natives/src/ast.rs` 中显式提到 `node_modules`。
- 包装器与原生 `ast_grep` 均不施加硬性文件数上限;候选数即解析路径/glob 在 gitignore 过滤后展开的数量。
- 多路径联合在 `resolveExplicitSearchPaths()` 中于解析前对相同路径输入去重。

## 错误
- TS 包装器对空模式、无效 `skip`、空路径条目、不支持的内部 URL glob、没有 `sourcePath` 的内部 URL 以及缺失路径抛出 `ToolError`。受支持的外部读取 URL 会在搜索前物化,而非被拒绝。
- 原生代码对以下情况返回硬错误:
  - 搜索根不可读或 glob 编译失败,
  - 取消(`Aborted: Signal`)或超时(`Aborted: Timeout`)。
- 文件级解析失败与每种语言模式编译失败是非致命的:它们累积在 `parseErrors` 中并与成功匹配一同呈现;语言没有可编译模式的文件被跳过。
- `no matches` 不是错误,即使记录了解析问题。

## 备注
- `pat` 始终由 TS 工具包装成一元素 `patterns` 数组;即使原生绑定支持多个模式,模型也不能通过 `ast_grep` 发送多个模式。
- `ast_grep` 可以搜索混合语言树,因为原生编译按发现的语言进行,但提示词仍告诉模型在可能时保持调用为单语言,以减少解析噪音。
- 模式编译按候选集中存在的语言进行。一个模式可以在一次运行中对某些语言成功,对其他语言生成每文件解析错误。
- 带 tree-sitter 错误节点的文件仍会被搜索;语法警告是附加性的,不是跳过条件。
- 关于 glob 语义,`*.ts` 只匹配直接子项,而 `**/*.ts` 递归;这在 `crates/pi-natives/src/ast.rs` 的原生测试中覆盖。
- 输出锚点供后续工具使用,但确切锚点格式取决于会话编辑模式(`hashline` 与行号模式)。
