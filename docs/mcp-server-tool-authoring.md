# MCP 服务器与工具编写

本文档解释 MCP 服务器定义如何成为 coding-agent 中可调用的 `mcp__*` 工具，以及当配置无效、重复、禁用或受认证门控时，操作员应该预期什么。

## 架构概览

```text
Config sources (.omp/.claude/.cursor/.vscode/mcp.json, mcp.json, etc.)
  -> discovery providers normalize to canonical MCPServer
  -> capability loader dedupes by server name (higher provider priority wins)
  -> loadAllMCPConfigs applies user enablement overrides and suppresses disabled servers
  -> MCPManager connects/listTools (with auth/header/env resolution)
  -> manager best-effort loads resources/prompts and subscribes to resource updates when enabled
  -> MCPTool/DeferredMCPTool bridge exposes tools as mcp__<server>_<tool>
  -> AgentSession.refreshMCPTools replaces live MCP tools immediately
```

## 1) 服务器配置模型与校验

`src/mcp/types.ts` 定义 MCP 配置写入器和运行时使用的编写形状：

- `stdio`（`type` 缺失时默认）：需要 `command`，可选 `args`、`env`、`cwd`
- `http`：需要 `url`，可选 `headers`
- `sse`：需要 `url`，可选 `headers`（为兼容性保留）
- 共享字段：`enabled`、`timeout`、`requestIdFormat`（`"number"` 或 `"string"`）、`auth`、`oauth`

`validateServerConfig()`（`src/mcp/config.ts`）强制传输基础：

- 拒绝同时设置 `command` 和 `url` 的配置
- stdio 需要 `command`
- http/sse 需要 `url`
- 拒绝未知的 `type`

`config-writer.ts` 对添加/更新操作应用此校验，并且还校验服务器名称：

- 非空
- 最多 100 个字符
- 仅 `[a-zA-Z0-9_.:-]`（冒号允许命名空间插件服务器名称，例如 `cloudflare:cloudflare-api`）

### 传输陷阱

- `type` 省略意味着 stdio。如果你本意是 HTTP/SSE 但省略了 `type`，`command` 就变成必填。
- `sse` 选择旧的协议修订版 2024-11-05 HTTP+SSE 传输：持久 GET 流提供 `endpoint` 事件，其 URL 接收 JSON-RPC POST。它与 `"http"` Streamable HTTP 传输不同。
- 出站 JSON-RPC 请求 ID 默认为递增数字以保持生态系统兼容。只为需要旧版 snowflake 字符串行为的服务器设置 `requestIdFormat: "string"`；无效值在发现期间会被警告并忽略。
- 校验是结构性的，而非可达性：语法有效的 URL 仍可能在连接时失败。

## 2) 发现、规范化与优先级

### 基于能力的发现

`loadAllMCPConfigs()`（`src/mcp/config.ts`）通过 `loadCapability(mcpCapability.id)` 加载规范 `MCPServer` 条目。

能力层（`src/capability/index.ts`）随后：

1. 按优先级顺序加载提供商
2. 按 `server.name` 去重（首个胜出 = 最高优先级）
3. 校验去重后的条目

结果：跨来源的重复服务器名称不会合并。一个定义胜出；较低优先级的重复项被遮蔽。

### `.mcp.json` 和相关文件

`src/discovery/mcp-json.ts` 中的专用回退提供商读取项目根目录的 `mcp.json` 和 `.mcp.json`（低优先级）。

在实践中，MCP 服务器也来自更高优先级的提供商（例如原生 `.omp/...` 和工具特定配置目录）。编写指导：

- 优先使用 `.omp/mcp.json`（项目）或 `~/.omp/agent/mcp.json`（用户）以获得显式控制。
- 需要回退兼容性时使用根目录 `mcp.json` / `.mcp.json`。
- 在多个来源中重用同一服务器名称会导致优先级遮蔽，而不是合并。

### 规范化行为

`convertToLegacyConfig()`（`src/mcp/config.ts`）将规范 `MCPServer` 映射到运行时 `MCPServerConfig`。

关键行为：

- 传输推断为 `server.transport ?? (command ? "stdio" : url ? "http" : "stdio")`
- `requestIdFormat` 被保留；省略意味着数字 ID
- 活动配置文件用户 `disabledServers` 列表中的名称总是被抑制；`enabled === false` 的服务器被抑制，除非同一用户配置在 `enabledServers` 中命名了它
- 存在时保留可选字段

### 发现期间的环境展开

OMP 原生 MCP 配置（`.omp/mcp.json`、`~/.omp/agent/mcp.json` 及其 `.mcp.json` 变体）在转换为运行时配置前递归展开 `${VAR}` 和 `${VAR:-default}` 占位符。它还接受 `enabled` 的布尔/字符串形式（`true`、`false`、`1`、`0`）和 `timeout` 的数字字符串。`requestIdFormat` 只接受 `"number"` 或 `"string"`；其他值会警告并回退到数字 ID。

`src/discovery/mcp-json.ts` 中的独立回退提供商读取项目根目录的 `mcp.json` 和 `.mcp.json`，展开相同的 `${...}` 占位符，并类型检查 `enabled`/`timeout` 而不强制转换字符串值。它应用相同的 `requestIdFormat` 校验。

无效的 `enabled`/`timeout` 值会被忽略并带警告，而不是使整个文件失败。

## 3) 认证与运行时值解析

`MCPManager.prepareConfig()`/`#resolveAuthConfig()`（`src/mcp/manager.ts`）是连接前的最终传递。

### OAuth 凭据注入

对于 `http`/`sse` 服务器，`auth: { type: "oauth", credentialId: "..." }` 块是可选的。当显式的任意或旧版凭据 ID 可解析时，OMP 会尊重它。受管理、配置文件作用域的
`mcp_oauth:profile:<profile>:<url>` ID 只有在配置文件处于活动状态且其 URL 与服务器的展开或字面 URL 匹配时才被接受；不匹配会被忽略。如果被接受的显式 ID 无法解析——或者没有 `auth` 块——OMP 会在从展开和字面服务器 URL 派生的确定性 ID 下查找凭据。这些 url 键凭据作用域到活动配置文件，因此共享的、仅定义的服务器条目可以使用每个配置文件独立存储的 OAuth 凭据。

大小写不敏感的、显式配置的 `Authorization` header 会抑制该 url 键回退。`stdio` 服务器没有可绑定的 URL：其显式任意或旧版凭据 ID 必须解析，url 键、配置文件作用域的 ID 会被忽略。

查找成功时：

- `http`/`sse`：注入 `Authorization: Bearer <access_token>` header
- `stdio`：注入 `OAUTH_ACCESS_TOKEN` env 变量

如果没有凭据可解析，OMP 在不注入 OAuth 值的情况下连接。刷新或凭据解析失败会被记录；在可能时，OMP 继续使用现有的访问 token。

### Header/env 值解析

连接前，管理器通过 `resolveConfigValue()`（`src/config/resolve-config-value.ts`）解析 stdio `env` 值和 HTTP/SSE `headers` 值：

- 以 `!` 开头的值 => 执行 shell 命令，使用修剪后的 stdout（缓存）
- 失败、超时或仅空白的命令产生 `undefined`，因此该条目被省略
- 否则，先将值视为环境变量名称（`process.env[name]`），回退到字面值

操作注意：拼写错误的 `!` 机密命令可以静默移除该 header/env 条目，产生下游 401/403 或服务器启动失败。拼写错误的环境变量名称会按字面发送，除非该字面恰好对服务器有意义。

## 4) 工具桥接：MCP -> Agent 可调用工具

`src/mcp/tool-bridge.ts` 将 MCP 工具定义转换为 `CustomTool`。

### 命名与冲突域

工具名称按以下方式生成：

```text
mcp__<sanitized_server_name>_<sanitized_tool_name>
```

规则：

- 小写化
- 非 `[a-z_]` 字符变为 `_`
- 重复下划线折叠
- 工具名称中冗余的 `<server>_` 前缀被剥离一次

不同的原始名称仍可能净化成相同的标识符（例如 `my-server` 和 `my.server` 会类似地净化）。在注册表插入前，`deduplicateMCPToolsByName()` 通过按字典序比较原始 `<server-name>\0<tool-name>` 来源键选择一个确定性胜者。失败的来源被记录并省略，因此重连或发现顺序不能改变所有权。

### Schema 映射

`tool-bridge.ts` 在将每个 MCP `inputSchema` 注册为 `CustomTool` schema 之前，先通过 `normalizeSchemaForMCP()` 传递它。

### 出站参数规范化

在活动或延迟工具发送 `tools/call` 之前，桥接按以下顺序规范化调用的参数：

1. 顶层的非对象值、`null` 和数组变为空参数对象。
2. 除非 MCP 工具自己的 `inputSchema.properties` 声明了 `i`，否则移除 harness 注入的意图字段 `i`。
3. 对于 MCP schema 声明但未列入 `required` 的属性，值为 `undefined`、空字符串或空非数组对象时会被省略。必填属性、未声明属性、`0`、`false`、`null` 和数组（包括空数组）会被保留。
4. 字符串值递归遍历嵌套对象和数组。可解析的 `local://` 文件 URL 变为外部 MCP 服务器可读取的真实文件系统路径。当没有活动的本地文件解析器存在，或 URL 表示目录/根而非文件时，原始字符串保留；无效、缺失或逃逸的本地文件 URL 在规范化期间失败，而不是到达 `tools/call`。

因此，服务器作者应该针对规范化后的负载进行校验，而不要假设模型生成调用中出现的每个字段都会到达服务器。

### 执行映射

`MCPTool.execute()` / `DeferredMCPTool.execute()`：

- 调用 MCP `tools/call`
- 将 MCP 内容展平为可显示的文本
- 返回结构化细节（`serverName`、`mcpToolName`、提供商元数据）
- 将服务器报告的 `isError` 映射为 `Error: ...` 文本结果
- 为可重试的连接错误尝试重连 + 一次重试
- 将剩余的抛出传输/运行时失败映射为 `MCP error: ...`
- 通过将 AbortError 转换为 `ToolAbortError` 保留中止语义

## 5) 操作员生命周期：添加/编辑/移除与实时更新

交互模式在 `src/modes/controllers/mcp-command-controller.ts` 中暴露 `/mcp`。

支持的操作：

- `add`（向导或快速添加）
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`、`prompts`、`notifications`
- Smithery 搜索/登录/退出登录流程

配置写入是原子的（`writeMCPConfigFile`：临时文件 + 重命名）。

更改后，控制器调用 `#reloadMCP()`：

1. `mcpManager.disconnectAll()`
2. `mcpManager.discoverAndConnect()`
3. `session.refreshMCPTools(mcpManager.getTools())`

`refreshMCPTools()` 替换所有 `mcp__` 注册表条目并立即重新激活最新的 MCP 工具集，因此更改无需重启会话即可生效。

### 模式差异

- **交互式/TUI 模式**：`/mcp` 提供应用内 UX（向导、OAuth 流程、连接状态文本、即时运行时重新绑定）。
- **SDK/headless 集成**：`discoverAndLoadMCPTools()`（`src/mcp/loader.ts`）返回加载的工具 + 每服务器错误；没有 `/mcp` 命令 UX。

## 6) 用户可见错误表面

用户/操作员常见的错误字符串：

- 添加/更新校验失败：
  - `Invalid server config: ...`
  - `Server "<name>" already exists in <path>`
- 快速添加参数问题：
  - `Use either --url or -- <command...>, not both.`
  - `--token requires --url (HTTP/SSE transport).`
- 连接/测试失败：
  - `Failed to connect to "<name>": <message>`
  - 超时帮助文本建议增大超时
  - `401/403` 的认证帮助文本
- 认证/OAuth 流程：
  - `Authentication required ... OAuth endpoints could not be discovered`
  - `OAuth flow timed out. Please try again.`
  - `OAuth authentication failed: ...`
- 禁用服务器使用：
  - `Server "<name>" is disabled. Run /mcp enable <name> first.`

发现中格式错误的源 JSON 通常作为警告/日志处理；配置写入器路径抛出显式错误。

## 7) 实用编写指导

要在此代码库中稳健地编写 MCP：

1. 让服务器名称在所有支持 MCP 的配置来源中全局唯一。
2. 优先选择在 MCP 工具名称净化后仍保持不同的名称，以避免生成的 `mcp__` 冲突。
3. 使用显式 `type` 以避免意外的 stdio 默认值。
4. 需要覆盖已发现服务器的 `enabled: false` 时，使用活动配置文件的用户 `enabledServers` 列表；如果名称同时出现在两个列表中，`disabledServers` 总是胜出。
5. 对于远程 OAuth 服务器，有效的显式 `credentialId` 是可选的：仅定义的 `http`/`sse` 条目可以使用绑定到同一 URL 的活动配置文件凭据。需要抑制该 url 键回退时，使用显式 `Authorization` header。
6. 如果使用基于命令的机密解析（`!cmd`），验证命令输出稳定且非空。

## 实现文件

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts)
- [`src/mcp/config-writer.ts`](../packages/coding-agent/src/mcp/config-writer.ts)
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts)
- [`src/discovery/mcp-json.ts`](../packages/coding-agent/src/discovery/mcp-json.ts)
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/config/resolve-config-value.ts`](../packages/coding-agent/src/config/resolve-config-value.ts)
- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts)
