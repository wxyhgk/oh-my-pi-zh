# lsp

> 查询语言服务器,获取诊断、导航、符号、重命名、代码操作、能力与原始请求。

## 来源
- 入口:`packages/coding-agent/src/lsp/index.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/lsp.md`
- 主要协作方:
  - `packages/coding-agent/src/lsp/client.ts` — 客户端进程生命周期与 JSON-RPC
  - `packages/coding-agent/src/lsp/config.ts` — 配置加载、自动检测、服务器选择
  - `packages/coding-agent/src/lsp/lspmux.ts` — 可选的 `lspmux` 命令包装
  - `packages/coding-agent/src/lsp/mux/daemon.ts` — broker 共享的 LSP 传输与私有进程回退
  - `packages/coding-agent/src/lsp/edits.ts` — 应用 `WorkspaceEdit` 与文本编辑
  - `packages/coding-agent/src/lsp/utils.ts` — URI 转换、符号解析、格式化、glob 展开
  - `packages/coding-agent/src/lsp/types.ts` — 工具 schema 与协议类型
  - `packages/coding-agent/src/lsp/clients/index.ts` — 自定义 linter 客户端缓存/工厂
  - `packages/coding-agent/src/lsp/clients/lsp-linter-client.ts` — 基于 LSP 的 linter 适配器
  - `packages/coding-agent/src/lsp/clients/biome-client.ts` — Biome CLI 诊断/格式化适配器
  - `packages/coding-agent/src/lsp/clients/swiftlint-client.ts` — SwiftLint CLI 诊断适配器
  - `packages/coding-agent/src/tools/index.ts` — 工具注册与 `lsp.enabled` 门控
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 超时默认值与钳制
  - `packages/coding-agent/src/lsp/defaults.json` — 用于自动检测的内置服务器定义

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `action` | string enum | 是 | 以下之一:`diagnostics`、`definition`、`references`、`hover`、`symbols`、`rename`、`rename_file`、`code_actions`、`type_definition`、`implementation`、`status`、`reload`、`capabilities`、`request`。 |
| `file` | string | 否 | 文件路径;对 `diagnostics` 也可以是 glob;工作区形式使用 `"*"`;对 `rename_file` 这是源路径。 |
| `line` | number | 否 | 基于位置的操作使用的从 1 开始编号的行号。在单文件操作路径上默认为 `1`。 |
| `symbol` | string | 否 | 用于在 `line` 上解析列位置的子串。支持 `name#N` 出现次数选择器;`N` 从 1 开始编号,默认为 `1`。对项目感知服务器执行 `definition`/`references`/`rename` 且给定 `line` 时必填。 |
| `query` | string | 否 | 工作区符号查询、代码操作选择器/筛选器,或 `action=request` 时的 LSP 方法名。 |
| `new_name` | string | 否 | `rename` 和 `rename_file` 必填。 |
| `apply` | boolean | 否 | 对 `rename`/`rename_file`,除非显式为 `false` 否则应用;对 `code_actions`,除非显式为 `true` 否则列出。 |
| `timeout` | number | 否 | 秒,默认 `20`;`clampTimeout("lsp", ...)` 先应用正的 `tools.maxTimeout` 上限,再应用工具自身的 `5..300` 范围(因此 5 秒下限仍优先于更低的全局上限)。 |
| `payload` | string | 否 | `action=request` 时的 JSON 字符串;覆盖自动构建的参数。 |

## 输出
- 单次触发的 `AgentToolResult`;`content` 始终是一个文本块:`[{ type: "text", text: string }]`。
- `details` 为 `LspToolDetails`:`action`、`success`、可选的 `serverName`、可选的原始 `request`。
- 诸如 `No definition found` 之类的空导航/符号查找结果还会被标记为 `useless: true`,以便上下文压缩可以省略它们;干净的诊断结果会保留作为验证证据。
- 没有流式更新、产物 URI 或后台任务。内联 TUI 渲染器合并调用与结果,添加感知操作的格式,并支持折叠/展开视图。
- 该工具是"可发现"而非"预加载"。只读操作(`diagnostics`、导航、hover、symbols、`status`、`capabilities`)请求读批准;`rename`、`rename_file`、`code_actions`、`reload` 和 `request` 无论 `apply` 如何都请求写批准。
- 许多校验失败会以普通文本结果返回(`details.success: false`);中止则抛出 `ToolAbortError`。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 注册 `lsp: LspTool.createIf`。仅当 `session.enableLsp !== false` 且 `lsp.enabled`(默认 `true`)都允许时,该工具才存在。带有 `lspReadOnly` 的会话会拒绝 `LSP_READONLY_ACTIONS` 之外的每个操作;受限会话默认 LSP 为禁用,若显式重新启用则为只读。
2. `packages/coding-agent/src/lsp/index.ts` 中的 `LspTool.execute()` 使用 `clampTimeout("lsp", ...)` 钳制 `timeout`(包括可选的全局 `tools.maxTimeout` 上限),构建 `AbortSignal.timeout(...)`,并与调用方信号合并。
3. `getConfig()` 按 cwd 加载并缓存 `LspConfig`,通过 `setIdleTimeout()` 应用空闲超时配置,并在后续调用中复用缓存的配置。工作区 `reload` 是显式例外:它先清除并重建该 cwd 的配置缓存,再重新加载新选定的服务器。
4. `packages/coding-agent/src/lsp/config.ts` 中的配置加载将 `defaults.json` 与来自项目、项目配置目录、用户配置目录、插件根/市场元数据和主目录的 JSON/YAML 覆盖合并;如果没有覆盖,则根据根标记加可执行文件发现来自动检测服务器。文件名、优先级和服务器字段参见 [LSP 配置](../lsp-config.md)。
5. 服务器路由使用 `config.ts` 中的 `getServersForFile()` / `getServerForFile()`:扩展名或基名匹配,然后将主服务器排在 linter 之前。`index.ts` 进一步用 `getLspServersForFile()` / `getLspServerForFile()` 把自定义 linter 客户端从导航/重构路径中过滤掉。
6. `getOrCreateClient()` 按 `command:cwd` 缓存一个客户端。启用 `lsp.shared`(SDK 会话中默认 `true`)时,它先向 broker 管理的项目 mux 请求共享传输;失败则回退到私有的 `ptree.spawn()`。外部 `lspmux` 包装优先于 broker 共享。随后客户端启动消息读取器,发送 `initialize`,存储能力,并发送 `initialized`。
7. `client.ts` 中的消息读取器解析 LSP 帧、解析挂起的请求、缓存 `publishDiagnostics`、跟踪 `$/progress` token 以判断项目加载完成、应答 `workspace/configuration`,并通过 `applyWorkspaceEdit()` 应用 `workspace/applyEdit` 请求。
8. 文件作用域的操作在请求前调用 `ensureFileOpen()`。列解析使用 `utils.ts` 中的 `resolveSymbolColumn()`:读取目标文件,省略 `symbol` 时取第一个非空白字符,否则在目标行上查找精确或忽略大小写的匹配,并遵循 `#N` 出现次数选择器。
9. `LspTool.execute()` 通过专用分支分发操作:仅工作区的分支(`status`、部分 `diagnostics`、工作区 `symbols`、工作区 `reload`、`capabilities`、`request`)在单文件 switch 之前运行;所有其他单文件操作共享一次客户端查找和 `switch(action)`。
10. 请求经由 `client.ts` 中的 `sendRequest()` 发送,它会分配递增的 JSON-RPC id、安装中止与超时处理、在中止时发送 `$/cancelRequest`,并在超时或进程退出时拒绝。
11. 返回编辑的操作要么用 `edits.ts` 中的 `formatWorkspaceEdit()` 预览,要么用 `applyWorkspaceEdit()` 应用;`rename_file` 还会执行文件系统重命名,然后发送 `workspace/didRenameFiles`。
12. 单文件操作块内的非中止失败会转换为 `LSP error: ...`;许多前置条件失败返回显式文本而不抛出异常。

## 模式 / 变体
### 路由与工作区作用域
- `file: "*"` 仅对 `diagnostics`、`symbols` 和 `reload` 特殊。
- `status` 忽略 `file`。
- 省略 `file` 或使用 `"*"` 时,`capabilities` 检查所有非自定义 LSP 服务器;给出具体文件时,它限定到匹配的非自定义服务器。
- 省略 `file` 或使用 `"*"` 时,`request` 选择第一个可用的非自定义 LSP 服务器;给出具体文件时,它选择该文件的主非 linter 服务器。
- `rename_file` 向 `getLspServers(config)` 中 `fileTypes` 匹配源、目标或任何枚举重命名对的每个非自定义 LSP 服务器发送 `workspace/willRenameFiles` 和 `workspace/didRenameFiles`——而不仅仅是单个文件作用域的服务器。
- 诊断是唯一同时查询普通 LSP 服务器和自定义 linter 客户端(`BiomeClient`、`SwiftLintClient` 或 `LspLinterClient`)的工具操作。

### `diagnostics`
**输入**
- 必填:`file`,除非使用带 `file: "*"` 的工作区模式。
- 可选:`timeout`。

**执行**
- `file: "*"`:`runWorkspaceDiagnostics()` 按 Rust → TypeScript → Go 工作区/模块 → Python 的顺序选择第一个匹配的项目类型。它运行 Rust 的 `cargo check --message-format=short`、TypeScript 的 `npx tsc --noEmit`、Python 的 `pyright` 或 Go 的 `go build`:`go.mod` 使用 `./...`,而 `go.work` 先读取 `go work edit -json`,再构建每个 `Use[].DiskPath/...` 模式(回退到 `./...`)。未知项目返回受支持标记消息,而不启动检查器。
- 具体文件或 glob:`resolveDiagnosticTargets()` 把非 glob 视为一个目标,否则展开 `Bun.Glob`,最多 `MAX_GLOB_DIAGNOSTIC_TARGETS`。
- 对每个文件,每个匹配的服务器都会运行:自定义客户端调用 `lint(file)`;真正的 LSP 服务器可选地等待项目加载、捕获 `diagnosticsVersion`、调用 `refreshFile()`,然后 `waitForDiagnostics()` 等待新的 `publishDiagnostics`(以最新发布为准;版本精确匹配则立即接受)。
- 结果按 range+message 去重,并按严重程度排序。

**输出文本**
- 单个目标无问题:`OK`。
- 单个目标有问题:`<summary>:\n<grouped diagnostics>`。
- 批处理/glob 目标:每个文件一个区块,当 glob 超过文件上限时附加开头的截断警告。
- 工作区模式:`Workspace diagnostics (<detected description>):\n<command output>`。

### `definition`
**输入**
- 必填:`file`。
- 可选:`line`、`symbol`、`timeout`。

**执行**
- 发送带 `{ textDocument, position }` 的 `textDocument/definition`。
- 接受 `Location`、`Location[]`、`LocationLink` 或 `LocationLink[]`;`normalizeLocationResult()` 将 `LocationLink` 转换为 `targetSelectionRange ?? targetRange`。
- 对项目感知服务器给定 `line` 时需要 `symbol`(此操作禁用首个非空白列回退)。
- 在请求前等待项目加载。

**输出文本**
- `No definition found` 或 `Found N definition(s):`,后跟 `file:line:col` 以及每个位置上方/下方的一行上下文。

### `type_definition`
使用与 `definition` 相同的位置规范化和输出形状,但发送 `textDocument/typeDefinition` 并报告 `type definition(s)`。与 `definition` 不同,该实现提供 `line` 时不要求显式 `symbol`;没有时它解析首个非空白列。

### `implementation`
使用与 `definition` 相同的位置规范化和输出形状,但发送 `textDocument/implementation` 并报告 `implementation(s)`。与 `definition` 不同,该实现提供 `line` 时不要求显式 `symbol`;没有时它解析首个非空白列。

### `references`
**输入**
- 必填:`file`。
- 可选:`line`、`symbol`、`timeout`。

**执行**
- 发送带 `includeDeclaration: true` 的 `textDocument/references`。
- 对项目感知服务器给定 `line` 时需要 `symbol`(此操作禁用首个非空白列回退)。
- 对项目感知服务器,当唯一命中就是所查询的声明时,最多重试 `REFERENCES_RETRY_COUNT` 次;重试之间等待项目加载并休眠 `REFERENCES_RETRY_DELAY_MS`。
- 前 `REFERENCE_CONTEXT_LIMIT` 个引用包含周围上下文;其余仅含位置。

**输出文本**
- `No references found` 或 `Found N reference(s):`,先列出带上下文的条目,截断时再显示 `... M additional reference(s) shown without context`。

### `hover`
**输入**
- 必填:`file`。
- 可选:`line`、`symbol`、`timeout`。

**执行**
- 发送 `textDocument/hover`。
- `extractHoverText()` 将字符串、markup 内容、marked-string 对象或数组展平为纯文本。

**输出文本**
- `No hover information` 或提取到的 hover 文本。

### `symbols`
**输入**
- 工作区模式:必填 `file: "*"`,外加必填 `query`。省略 `file` 目前会在工作区符号分发之前返回 `Error: file parameter required...`。
- 文档模式:必填 `file`。
- 可选:`timeout`。

**执行**
- 工作区模式向每个非自定义 LSP 服务器发送 `workspace/symbol`,用 `filterWorkspaceSymbols()` 后置筛选匹配,用 `dedupeWorkspaceSymbols()` 去重,然后截断到 `WORKSPACE_SYMBOL_LIMIT`。
- 文档模式向主服务器发送 `textDocument/documentSymbol`。如果第一个条目有 `selectionRange`,则格式化层级化的 `DocumentSymbol`;否则格式化扁平的 `SymbolInformation`。

**输出文本**
- 工作区模式:`Found N symbol(s) matching "query":` 加格式化的 `name @ file:line:col`,超过上限时附带省略行。
- 文档模式:`Symbols in <file>:` 加层级化或扁平的符号行。

### `rename`
**输入**
- 必填:`file`、`new_name`。
- 可选:`line`、`symbol`、`apply`、`timeout`。

**执行**
- 对项目感知服务器给定 `line` 时需要 `symbol`,然后等待项目加载,发送 `textDocument/rename`,接收 `WorkspaceEdit`。
- `apply !== false` 时用 `applyWorkspaceEdit()` 立即应用编辑。
- `apply === false` 时用 `formatWorkspaceEdit()` 渲染预览。

**输出文本**
- `Rename returned no edits`、`Applied rename:` 加已应用的变更行,或 `Rename preview:` 加汇总的编辑。

### `rename_file`
**输入**
- 必填:`file` 源路径、`new_name` 目标路径。
- 可选:`apply`、`timeout`。

**执行**
- 解析绝对源路径和目标路径,拒绝相同路径、源缺失、目标已存在、空重命名集,或文件数超过 `MAX_RENAME_PAIRS` 的目录。
- `enumerateRenamePairs()` 对文件返回一个 `{oldUri,newUri}` 对,或遍历目录树中的每个常规文件。
- 向 `fileTypes` 匹配受影响路径的每个非自定义 LSP 服务器发送带 `{ files: pairs }` 的 `workspace/willRenameFiles`;收集返回的 `WorkspaceEdit` 和服务器备注。
- 预览模式(`apply === false`)只格式化这些编辑。
- 应用模式按 URI 合并返回的文本编辑(重叠时项目感知服务器的编辑优先;其他服务器重叠的编辑被丢弃并附备注),从单个快照对每个 URI 应用一次,创建目标父目录并在磁盘上重命名源路径,对每个已重命名的打开文件发送 `textDocument/didClose`,删除这些 `openFiles` 条目,然后发送 `workspace/didRenameFiles`。

**输出文本**
- 预览:`Rename preview: <file-count label> → <dest>` 加每个服务器的编辑汇总和可选的服务器备注。
- 应用:`Renamed <file-count label> → <dest>` 加已应用的编辑汇总、文件系统重命名行和可选的服务器备注。

### `code_actions`
**输入**
- 必填:`file`。
- 可选:`line`、`symbol`、`query`、`apply`、`timeout`。

**执行**
- 从 `client.diagnostics` 读取打开 URI 的缓存诊断,并在解析位置处以零宽度范围发送 `textDocument/codeAction`。
- 当 `apply !== true` 时,`query` 作为 `context.only: [query]` 传入;这是服务器端的种类筛选器。
- 当 `apply === true` 且 `query` 非空时,它是客户端选择器:零起始数字索引或操作标题的忽略大小写子串。
- 当 `apply === true` 但省略 `query` 时,当前实现会落入列表模式而不应用操作。
- 应用 `CodeAction` 使用 `applyCodeAction()`:可选 `codeAction/resolve`,然后 `applyWorkspaceEdit(edit)`,再可选 `workspace/executeCommand`。
- 应用裸 `Command` 只运行 `workspace/executeCommand`。

**输出文本**
- 列表模式:`N code action(s):` 加 `index: [kind] title` 行。
- 应用模式成功:`Applied "title":` 加 `Workspace edit:` 和/或 `Executed command(s):` 区块。
- 应用模式未命中:`No code action matches "query". Available actions:`。
- 应用模式无编辑/命令:`Action "title" has no workspace edit or command to apply`。

### `status`
**输入**
- 无。

**执行**
- 从缓存的 `LspConfig` 读取配置的服务器,并与 `getActiveClients()` 交叉引用,使每个服务器标记为 `(configured, not started)` 或显示其活动客户端状态。
- 调用 `detectLspmux()`,当安装了 `lspmux` 时附加状态文本。

**输出文本**
- `Language servers: <name (configured, not started) | name (<status>)>` 加一行解释性说明,或 `No language servers configured for this project`,可选后跟 `lspmux: active (multiplexing enabled)` 或 `lspmux: installed but server not running`。

### `reload`
**输入**
- 工作区模式:`file: "*"` 或省略 `file`。
- 单文件模式:必填 `file`。
- 可选:`timeout`。

**执行**
- 工作区模式先使按 cwd 的配置缓存失效,从磁盘重新加载配置,然后重新加载每个新配置的非自定义 LSP 服务器。
- 单文件模式保留缓存配置,并重新加载该文件的主服务器。
- 两种模式在启动服务器前都会清除匹配的近期初始化失败。然后 `reloadServer()` 尝试 `rust-analyzer/reloadWorkspace` 请求,回退到带 `{ settings: {} }` 的 `workspace/didChangeConfiguration` 通知,最后拆除客户端,使下一个请求冷启动它。对于共享 mux 客户端,拆除会先发送 mux 重启通知,以便替换共享服务器——而不仅仅是本会话的链接。

**输出文本**
- 每个服务器一行:`Reloaded <server>`、`Restarted <server>` 或 `Failed to reload <server>: ...`。

### `capabilities`
**输入**
- 可选:`file`、`timeout`。

**执行**
- 给出具体 `file` 时,检查该文件的匹配非自定义服务器。
- 省略 `file` 或使用 `"*"` 时,检查每个非自定义配置的服务器。
- 按需启动服务器,并将 `client.serverCapabilities ?? {}` 以美化 JSON 输出。

**输出文本**
- 每个服务器:`<server>:` 后跟缩进的 `capabilities: { ... }`,或 `<server>: failed to start (...)`。

### `request`
**输入**
- 必填:`query` 方法名。
- 可选:`file`、`line`、`symbol`、`payload`、`timeout`。

**执行**
- 选择一个非自定义服务器:文件作用域的主服务器,否则为第一个配置的非自定义服务器。
- 参数构建优先级:
  1. 若提供了 `payload`,解析 JSON 并原样使用。
  2. 否则若 `file` 具体且提供了 `line`,使用 `resolveSymbolColumn()` 构建 `{ textDocument: { uri }, position: { line: line - 1, character } }`。
  3. 否则若 `file` 具体,构建 `{ textDocument: { uri } }`。
  4. 否则使用 `{}`。
- `file` 具体时先打开文件。

**输出文本**
- 成功:`<server> ← <method>:\n<formatted result>`,其中非字符串结果为 `JSON.stringify(..., null, 2)`,空值(nullish)变为 `null`。
- 失败:`LSP error from <server> on <method>: ...`,后跟回显请求参数的 `  params: <preview>`(截断到 400 个字符)。

## 副作用
- 文件系统
  - 读取配置文件、目标文件和根标记。
  - `rename` 和 `code_actions` 可能通过 `applyWorkspaceEdit()` 编辑/创建/删除/重命名文件。
  - `rename_file` 在应用模式下始终在磁盘上重命名源路径。
  - 服务器发起的 `workspace/applyEdit` 请求也会通过 `applyWorkspaceEdit()` 修改文件。
- 网络 / IPC
  - 启用 `lsp.shared=true`(默认)时,SDK 会话尝试通过本地 Unix socket 或 Windows 命名管道连接 broker 管理的按项目 LSP mux。如果无法到达或启动 mux,客户端会静默回退到私有子进程。
  - 私有和外部多路复用的服务器通过本地 stdio JSON-RPC 通信;工具本身不发出远程网络请求。
- 子进程 / 原生绑定
  - 私有回退用 `ptree.spawn()` 启动语言服务器;共享模式请求 broker 为每个项目维护一个服务器。
  - 工作区诊断启动 `cargo`、`npx`、`go` 或 `pyright`。
  - `BiomeClient` 和 `SwiftLintClient` 启动 CLI 工具。
  - 可选的外部 `lspmux` 检测会启动 `lspmux status`;受支持的服务器可通过 `lspmux client` 包装。
- 会话状态(转录、记忆、任务、检查点、注册表)
  - 在 `configCache` 中按 cwd 缓存配置;工作区 `reload` 使该条目失效。
  - 按 `command:cwd` 缓存 LSP 客户端,包含 `pendingRequests`、`diagnostics`、`openFiles`、`serverCapabilities` 和项目加载状态。传输可能表示共享的 mux 链接而非自有进程。
  - 按 `serverName:cwd` 缓存自定义 linter 客户端。
  - 更新客户端 `lastActivity`;可选的空闲超时清理由 `setIdleTimeout()` 驱动。
- 后台工作 / 取消
  - 每个请求都有可中止的超时信号。
  - 中止进行中的 LSP 请求会发送 `$/cancelRequest`。
  - 后台消息读取器在每个活动客户端上持续存在,直到进程退出/关闭。

## 限制与上限
- 工具超时钳制:默认 `20` 秒,最小 `5` 秒,最大 `300` 秒——`packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `TOOL_TIMEOUTS.lsp`。
- `sendRequest()` 内 LSP 请求默认超时:`30_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `DEFAULT_REQUEST_TIMEOUT_MS`。
- 预热 initialize 默认超时:`5_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `WARMUP_TIMEOUT_MS`。
- 项目加载等待回退:`15_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `PROJECT_LOAD_TIMEOUT_MS`。
- 启用时空闲客户端清扫间隔:`60_000ms`——`packages/coding-agent/src/lsp/client.ts` 中的 `IDLE_CHECK_INTERVAL_MS`。
- 初始化失败退避:`3 * 60 * 1000ms`——`INIT_FAILURE_BACKOFF_MS`;匹配的单文件或工作区 `reload` 会清除此负缓存,因此重试立即可行。
- 诊断消息输出上限:前 `50` 条消息——`packages/coding-agent/src/lsp/index.ts` 中的 `DIAGNOSTIC_MESSAGE_LIMIT`。
- 单文件诊断等待:`3_000ms`——`SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS`。
- 批处理/glob 诊断每文件等待:`400ms`——`BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS`。
- glob 诊断目标上限:前 `20` 个匹配——`MAX_GLOB_DIAGNOSTIC_TARGETS`。
- 工作区符号上限:前 `200` 条——`WORKSPACE_SYMBOL_LIMIT`。
- 引用上下文上限:前 `50` 个引用包含源上下文——`REFERENCE_CONTEXT_LIMIT`。
- 引用重试次数:`2` 次重试,`250ms` 退避——`REFERENCES_RETRY_COUNT`、`REFERENCES_RETRY_DELAY_MS`。
- 目录重命名上限:`1_000` 个文件对——`MAX_RENAME_PAIRS`。
- `detectLspmux()` 状态缓存 TTL:`5 * 60 * 1000ms`;存活检查超时:`1_000ms`——`packages/coding-agent/src/lsp/lspmux.ts` 中的 `STATE_CACHE_TTL_MS`、`LIVENESS_TIMEOUT_MS`。
- 工作区诊断输出上限:子进程的前 `50` 行。

## 错误
- 缺失或无效的输入通常以文本返回(`details.success: false`),而不是抛出:
  - 缺失 `file`/`query`/`new_name`
  - `payload` 中的 JSON 无效
  - 没有匹配的服务器
  - `rename_file` 源/目标条件无效
- `resolveSymbolColumn()` 对缺失文件、缺失符号和越界的 `#N` 选择器抛出显式错误;这些以 `LSP error: ...` 或请求特定的错误文本呈现。
- `sendRequest()` 超时以 `LSP request <method> timed out after <ms>ms` 拒绝。
- 客户端进程退出会用 `getOrCreateClient()` 中组装的退出码/stderr 错误拒绝所有挂起请求。
- 主 `try` 块内的单文件操作失败变成 `LSP error: <message>`。
- `request` 有自己的错误封装:`LSP error from <server> on <method>: <message>`。
- 某些服务器失败会被有意弱化:
  - 一个服务器失败时,诊断继续
  - `rename_file` 抑制 `workspace/willRenameFiles` 的 "method not found" 错误,并把其他服务器错误记录为备注
  - `code_actions` 忽略 `codeAction/resolve` 失败,并在可能时应用未解析的操作
- 调用方中止不会转换为文本:`ToolAbortError` 被重新抛出。没有调用方中止的墙钟工具超时则抛出 `ToolError`:`LSP <action> timed out after <N>s on <server>. ...`。

## 说明
- `status` 从 `LspConfig` 报告配置的服务器,并通过 `getActiveClients()` 标记每个服务器:`(configured, not started)` 表示二进制文件在 PATH 上可解析,但还没有请求启动它;活动客户端报告其状态。
- `getLspServerForFile()` 排除 `createClient` 适配器和仅 linter 的服务器;导航/重构操作永远不会以 Biome/SwiftLint 自定义客户端为目标。
- `getServersForFile()` 既匹配 `fileTypes` 中的文件扩展名,也匹配精确的基名;配置可以针对诸如 `Dockerfile` 之类的名称(如果存在)。
- `symbol` 匹配先精确,再忽略大小写,并且只在指定行上回退到第 N 次出现;它从不扫描其他行。
- 对项目感知服务器执行 `definition`、`references` 和 `rename` 时,传入 `line` 却省略 `symbol` 会被 `ToolError` 拒绝,而不是静默回退到首个非空白列。
- `code_actions` 以两种不同方式使用 `query`:列表模式下是服务器端 `context.only` 筛选器;当 `apply: true` 且 `query` 非空时是客户端标题/索引选择器。尽管模型提示词要求选择器,但当 `apply: true` 省略 `query` 时,当前实现是列出操作而不是应用一个。
- `rename` 和 `rename_file` 默认应用。预览需要 `apply: false`。
- 带 `file: "*"` 的 `request` 与省略 `file` 的处理相同:它不构建特定于工作区的参数。
- `reload` 在终止客户端后不会立即重新创建它;下一个请求触发重新初始化。
- `workspace/applyEdit` 可以应用服务器在直接工具操作结果路径之外发起的编辑。
- `detectLspmux()` 可以通过 `PI_DISABLE_LSPMUX=1` 禁用;`DEFAULT_SUPPORTED_SERVERS` 中只有 `rust-analyzer`。
- 启动时 LSP 发现(`sdk.ts` 中的 `discoverStartupLspServers(cwd)`)在 `enableLsp && options.hasUI` 时运行;后台预热还要求 `!settings.get("lsp.lazy")`。`lsp.lazy` 默认为 `true`,因此默认情况下被发现的服务器以状态 `"available"`(欢迎界面中的灰点)呈现,并在首次使用时通过 `getOrCreateClient()` 冷启动(lsp 工具调用或对匹配文件类型执行 edit/write)。Print/RPC/ACP/脚本会话完全跳过发现和预热。参见 `docs/sdk.md` § 启动性能。
- `configCache` 是进程级的,不会自动失效。使用工作区 `reload`(省略 `file` 或 `file: "*"`)重新读取配置、根标记和插件配置;具体文件的 reload 只重新加载该服务器,并保留缓存的配置。
