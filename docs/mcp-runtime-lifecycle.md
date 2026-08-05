# MCP 运行时生命周期

本文档描述 MCP 服务器在 coding-agent 运行时中如何被发现、连接、暴露为工具、刷新和拆除。

## 生命周期概览

1. **SDK 启动**触发 MCP 发现（除非 MCP 被禁用）：headless/SDK 会话等待 `discoverAndLoadMCPTools()`；交互式会话（`hasUI: true`）预先创建管理器，并将 `discoverAndConnect()` 推迟到会话生效后。
2. **发现**（`loadAllMCPConfigs`）从能力来源解析 MCP 服务器配置，过滤已禁用/项目/Exa 条目以及内置浏览器工具启用时的浏览器 MCP 服务器，并保留来源元数据。
3. **管理器连接阶段**（`MCPManager.connectServers`）并行启动每个服务器的连接 + `tools/list`。
4. **快速启动门**最多等待 250ms，然后可能返回：
   - 完全加载的 `MCPTool`，
   - 每个服务器的失败，
   - 或针对仍在等待的服务器返回缓存的 `DeferredMCPTool`。
5. **SDK 接线**将 MCP 工具合并到会话的运行时工具注册表。
6. **连接后富化**尽力加载资源、资源模板、提示词和可选的资源订阅。
7. **活动会话**通过管理器回调接收迟到的工具变更；`/mcp reload` 执行 `disconnectAll` + 重新发现 + `session.refreshMCPTools`，而传输关闭和 `/mcp reconnect` 使用每服务器重连路径。
8. **拆除**发生在显式管理器断开时，并在拥有的 `AgentSession` 被处置时自动发生；子 Agent 不会断开借用的父管理器。

## 发现与加载阶段

### SDK 的入口路径

`src/sdk.ts` 中的 `createAgentSession()` 在 `enableMCP` 为 true（默认）时执行 MCP 启动。有两条路径：

- **Headless/SDK**（无 UI，无提供的管理器）：等待 `discoverAndLoadMCPTools(cwd, { ... })` 并将返回的工具合并到启动 `customTools` 集合中。
- **交互式/TUI**（`hasUI: true`，无提供的管理器）：立即构造 `MCPManager`（带缓存 + 认证存储），将 `discoverAndConnect()` 推迟到会话存在后启动的后台任务，然后通过 `session.refreshMCPTools(...)` 绑定工具（如果会话在连接中途被拆除，则处置管理器）。

两条路径：

- 传递 `authStorage`、缓存存储、`mcp.enableProjectConfig`，以及基于 `browser.enabled` 设置的浏览器 MCP 过滤，
- 总是设置 `filterExa: true`，
- 记录每个服务器的加载/连接错误，
- 将管理器存储在 `toolSession.mcpManager` 和会话结果中。

如果 `enableMCP` 为 false，则完全跳过 MCP 发现。

### 配置发现与过滤

`loadAllMCPConfigs()`（`src/mcp/config.ts`）通过能力发现加载规范 MCP 服务器条目，然后转换为旧版 `MCPServerConfig`。

过滤行为：

- `enableProjectConfig: false` 移除项目级条目（`_source.level === "project"`）。
- `enabled: false` 条目被抑制，除非活动配置文件的用户 `enabledServers` 白名单点名了它们；用户 `disabledServers` 黑名单总是抑制同名条目。
- Exa 服务器默认被过滤掉，API 密钥被提取用于原生 Exa 工具集成；`filterBrowser` 为 true 时过滤浏览器自动化 MCP 服务器。

结果同时包含 `configs` 和 `sources`（稍后用于提供商标签的元数据）。

### 发现级失败行为

`discoverAndLoadMCPTools()` 区分两类失败：

- **发现硬失败**（来自 `manager.discoverAndConnect` 的异常，通常来自配置发现）：返回空工具集和一个合成错误 `{ path: ".mcp.json", error }`。
- **每服务器运行时/连接失败**：管理器以 `errors` 映射返回部分成功；其他服务器继续。

因此，个别 MCP 服务器失败时，启动不会让整个 Agent 会话失败。

## 管理器状态模型

`MCPManager` 用单独的注册表跟踪运行时生命周期：

- `#connections: Map<string, MCPServerConnection>` — 完全连接的服务器。
- `#pendingConnections: Map<string, Promise<MCPServerConnection>>` — 握手进行中。
- `#pendingToolLoads: Map<string, Promise<{ connection, serverTools }>>` — 已初始化连接但其 `tools/list` 仍在飞行中。
- `#tools: CustomTool[]` — 暴露给调用方的当前 MCP 工具视图，保持稳定的名称顺序。
- `#sources: Map<string, SourceMeta>` — 提供商/来源元数据，即使连接尚未完成。
- `#pendingReconnections: Map<string, Promise<MCPServerConnection | null>>` — 传输掉线或显式重连后进行中的重连。
- `#serverConfigs: Map<string, MCPServerConfig>` — 保留的原始未解析配置，以便重连可以在不泄露已解析 token 的情况下重新解析凭据。
- `#reconnectHistory: Map<string, number[]>` 加 `#epoch` — 每服务器崩溃窗口核算，以及使超过全局断开的重连尝试失效。
- 监听器/回调状态，包括有界 pending 通知 FIFO 和跟踪的资源订阅/刷新。

`getConnectionStatus(name)` 从这些映射派生状态：

- 在 `#connections` 中则为 `connected`，
- 有 pending 连接、pending 工具加载或 pending 重连则为 `connecting`，
- 否则为 `disconnected`。

## 连接建立与启动时机

### 每服务器连接管道

对于 `connectServers()` 中发现的每个服务器：

1. 存储/更新来源元数据，
2. 如果已连接/挂起/重连中则跳过，
3. 校验传输字段（`validateServerConfig`），
4. 保存未解析配置以备可能的重连，
5. 解析受管理的 OAuth 凭据和 env/header shell 替换（`#resolveAuthConfig`），
6. 使用管理器通知/请求处理程序调用 `connectToServer(name, resolvedConfig)`，
7. 接线 HTTP OAuth 刷新和传输 `onClose` 重连处理，
8. 调用 `listTools(connection)`，
9. 尽力缓存工具定义（`MCPToolCache.set`），
10. 在工具加载后尽力加载资源、资源模板、提示词和订阅。

`connectToServer()` 行为（`src/mcp/client.ts`）：

- 创建 stdio 或 HTTP/SSE 传输，
- 使用协议版本 `2025-03-26` 执行 MCP `initialize`，并通告 `roots` 能力，
- 应答服务器到客户端的 `ping` 和 `roots/list` 请求；不支持的方法返回 JSON-RPC `-32601`，
- 对于 HTTP/SSE，在 `notifications/initialized` 之前启动后台 SSE 监听器，
- 发送 `notifications/initialized`，
- 使用超时优先级 `OMP_MCP_TIMEOUT_MS`，然后是 `config.timeout`，然后是 30s；`0` 禁用客户端侧超时，
- 初始化失败时关闭传输。

### 快速启动门 + 延迟回退

`connectServers()` 等待以下两者之间的竞争：

- 所有连接/工具加载任务已结算，和
- `STARTUP_TIMEOUT_MS = 250`。

250ms 后：

- 已履行的任务变为活动 `MCPTool`，
- 已拒绝的任务产生每服务器错误，
- 仍在等待的任务：
  - 如果缓存可用（`MCPToolCache.get`），使用缓存的工具定义创建 `DeferredMCPTool`，
  - 否则在启动时不贡献任何工具；它们保持飞行中，后台延续在连接/列表完成后通过 `#onToolsChanged` 注册它们的工具（慢速服务器不再阻塞启动——issue #2100）。

这是一个混合启动模型：有缓存时快速返回并带延迟句柄，没有缓存时在后台迟到注册。

### 后台完成行为

每个 pending `toolsPromise` 也有一个后台延续，最终会：

- 替换管理器状态中该服务器的工具切片并恢复稳定的名称顺序，
- 调用 `#onToolsChanged`，以便活动会话可以重新绑定迟到的工具，
- 写入缓存，
- 只在启动后记录迟到失败（`allowBackgroundLogging`）。

## 工具暴露与活动会话可用性

### 启动注册

`discoverAndLoadMCPTools()` 将管理器工具转换为 `LoadedCustomTool[]` 并装饰路径（已知时为 `mcp:<server> via <providerName>`）。

然后 `createAgentSession()` 将这些工具推入 `customTools`，它们被包装并添加到运行时工具注册表，名称如 `mcp__<server>_<tool>`。

服务器和工具名称组件被小写化并净化（sanitize）为字母/下划线。如果两个不同来源铸造了相同的运行时名称，OMP 会记录冲突并基于原始服务器/工具身份保留一个确定性胜者，因此重连顺序不能改变所有权。

### 工具调用

- `MCPTool` 通过已连接的 `MCPServerConnection` 调用工具。
- `DeferredMCPTool` 在调用前等待 `waitForConnection(server)`；这允许缓存的工具在连接就绪前存在。
- 两者都会为可重试的连接失败尝试重连 + 单次重试。
- 结构化的工具结果认证挑战可以触发配置的认证处理程序、重连和一次重试。交互模式将其接线到 `/mcp` OAuth 控制器；没有处理程序时，该挑战保持为 MCP 错误。

两者都返回结构化工具输出，并将剩余的传输/工具错误转换为 `MCP error: ...` 工具内容（中止保持为中止）。

## 刷新/重载路径（启动 vs 活动重载）

### 初始启动路径

- `sdk.ts` 中的一次性发现/加载，
- 工具注册在初始会话工具注册表中。

### 交互式重载与实时变更路径

`/mcp reload`（`src/modes/controllers/mcp-command-controller.ts`）执行：

1. `mcpManager.disconnectAll()`，
2. 清除过期的 MCP 提示词命令，
3. 使用与启动相同的项目/Exa/浏览器过滤器调用 `mcpManager.discoverAndConnect()`，
4. 调用 `session.refreshMCPTools(mcpManager.getTools())`。

`session.refreshMCPTools()`（`src/session/agent-session.ts`）移除所有 `mcp__` 工具，重新包装最新的 MCP 工具，并重新激活工具集，以便变更无需重启即可生效。拥有的 SDK 会话还安装 `setOnToolsChanged`，因此迟到的初始连接、服务器的 `tools/list_changed` 通知、重连和断开都可以触发相同的重新绑定。显式 `/mcp reconnect <name>` 在管理器重连完成后执行一次最终刷新。

## 服务器发起通知

MCP 服务器可以在 `initialize` 完成后的任何时刻推送 JSON-RPC 通知帧。传输通过 `onNotification` 将其浮出；管理器通过两条路径将其扇出：

1. **已知方法的内部刷新**：
   - `notifications/tools/list_changed` → `refreshServerTools`
   - `notifications/resources/list_changed` → `refreshServerResources`
   - `notifications/resources/updated` → `#onResourcesChanged`（仅针对当前订阅的 URI）
   - `notifications/prompts/list_changed` → `refreshServerPrompts`
2. **监听器扇出**：每次内部刷新后，每条通知（已知的和服务器自定义的）都会被投递。`MCPManager.addNotificationListener(listener)` 返回一个退订函数；多个监听器具有独立的错误隔离。

如果没有附加监听器，管理器最多缓冲 100 帧，溢出时丢弃最旧的，然后将 FIFO 排空到第一个附加的监听器。`sdk.ts` 注册一个每会话监听器，以 `{ server, method, params }` 桥接到扩展运行器的 `mcp_notification` 事件；扩展运行器有自己的有界启动缓冲。监听器和防抖定时器通过会话善后清理释放。

## 健康、重连与部分失败行为

当前运行时行为由连接事件驱动：

- 管理器/客户端中**没有自主轮询健康监视器**。
- **自动重连接线到 `transport.onClose`**，用于受管理连接。
- 重连以退避（`500`、`1000`、`2000`、`4000` ms）重试，重新加载工具，并在成功时通知消费者。崩溃风暴熔断器在 30 秒内超过 5 次重连尝试后暂停服务器的自动重连；手动 `/mcp reconnect` 会重置该历史。
- 看到可重试连接错误的工具调用也会尝试一次重连 + 重试。
- 重连也可以通过 `/mcp reconnect <name>` 或更宽泛的 `/mcp reload` 显式执行。

操作上：

- 一个服务器失败不会移除健康服务器的工具，
- 连接/列表失败按服务器隔离，
- 尝试重连时过期的工具可能仍然可见；如果恢复失败，调用会报告 MCP 错误，
- 工具缓存、资源/提示词加载、订阅和后台更新都是尽力的（警告/错误被记录，没有硬停止）。

## 拆除语义

### 服务器级拆除

`disconnectServer(name)`：

- 移除 pending 连接/工具加载/重连条目、来源元数据、已保存配置、重连历史和资源刷新/订阅状态，
- 分离 `onClose`，以便显式关闭不触发重连，
- 如果已连接则关闭传输，
- 按其精确的 `mcpServerName` 所有者（而非净化名称前缀）移除工具并通知工具消费者，
- 当过期的提示词命令需要移除时通知提示词消费者。

### 全局拆除与所有权

`disconnectAll()`：

- 递增生命周期纪元，使稍后完成的重连尝试无法复活旧连接，
- 分离所有活动传输的 `onClose`，然后用 `Promise.allSettled` 关闭它们，
- 清除 pending 映射、来源、已保存配置、连接、订阅、资源刷新、重连历史和管理器工具。

顶层会话拥有它们创建的管理器。`AgentSession.dispose()` 以 3 秒清理超时断开拥有的管理器并记录清理失败；获得 `options.mcpManager` 的子 Agent/会话借用父管理器且不会断开它。`/mcp reload` 在 `disconnectAll` 之后刻意重用管理器对象，因此已安装的回调/监听器对下一个发现周期仍然可用。

## 失败模式与保证

| 场景                                             | 行为                                                                                                                  | 硬失败 vs 尽力而为       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 发现抛出（能力/配置加载路径）       | 加载器返回空工具 + 合成 `.mcp.json` 错误                                                                  | 会话启动尽力而为    |
| 无效的服务器配置                                | 服务器被跳过并带校验错误条目                                                                                | 每服务器尽力而为         |
| 连接超时/初始化失败                         | 记录服务器错误；其他服务器继续                                                                                    | 每服务器尽力而为         |
| 启动时 `tools/list` 仍 pending 且缓存命中 | 立即返回延迟工具                                                                                       | 快速启动尽力而为       |
| 启动时 `tools/list` 仍 pending 且无缓存  | 启动时无工具；后台延续在就绪时通过 `#onToolsChanged` 注册它们                              | 迟到注册尽力而为  |
| 迟到后台工具加载失败                    | 在启动门之后记录                                                                                                 | 记录尽力而为            |
| 运行时传输掉线                            | 管理器尝试重连；重连期间过期工具保留，未来调用可能重试一次或以 MCP 错误失败 | 自动恢复尽力而为 |
| 30 秒内超过 5 次重连调用         | 熔断器关闭/移除过期连接但保留已注册工具；手动重连重置历史      | 自动重连暂停  |
| 拥有会话的处置                              | 拥有的管理器断开最多等待 3 秒；失败被记录                                                       | 有界尽力而为清理    |

## 公共 API 表面

`src/mcp/index.ts` 重新导出客户端操作、配置加载器/写入器 API、加载器和管理器 API、OAuth 发现、工具桥接/缓存、HTTP 和 stdio 传输、协议类型，以及 `callMCP`/`parseSSE`。`src/sdk.ts` 将 `discoverMCPServers()` 暴露为 `discoverAndLoadMCPTools` 之上的便捷包装；它返回 `{ manager, tools, errors, connectedServers, exaApiKeys }`。

## 实现文件

- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts) — 加载器门面、发现错误规范化、`LoadedCustomTool` 转换。
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts) — 生命周期状态注册表、并行连接/列表流程、刷新/断开。
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts) — 传输设置、initialize 握手、list/call/disconnect。
- [`src/mcp/index.ts`](../packages/coding-agent/src/mcp/index.ts) — MCP 模块 API 导出。
- [`src/sdk.ts`](../packages/coding-agent/src/sdk.ts) — 启动接线到会话/工具注册表。
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts) — 管理器使用的配置发现/过滤/校验。
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts) — `MCPTool` 和 `DeferredMCPTool` 运行时行为。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — `refreshMCPTools` 活动重新绑定。
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts) — 交互式重载/重连流程。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — 通过父管理器连接进行子 Agent MCP 代理。
