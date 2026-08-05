# RPC 协议参考

RPC 模式通过 stdio 以换行分隔的 JSON 协议运行编码 Agent。

- **stdin**:命令(`RpcCommand`)、扩展 UI 响应,以及宿主工具更新/结果
- **stdout**:ready 帧、命令响应(`RpcResponse`)、会话/Agent 事件、扩展 UI 请求、宿主工具请求/取消

主要实现:

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## 启动

```bash
omp --mode rpc [regular CLI options]
```

行为说明:

- `@file` CLI 参数在 RPC 模式中被拒绝。
- RPC 模式默认禁用自动会话标题生成,以避免额外的模型调用。
- RPC/ACP 宿主默认覆盖任务隔离/执行、内存、advisor、层级、异步作业和 bash 自动后台设置。它们仅在路径未显式配置时应用;项目/全局配置、`--config` 和隔离设置保持权威。Todo 设置不做宿主默认。
- 进程在扩展发现之前声明 stdin,然后一次解析一行非空 JSONL。格式错误的 JSON 发出可恢复的 `command: "parse"` 失败,不会终止循环。
- 启动时在处理命令之前写入 `ready` 帧。该帧宣传支持的协议版本和传输限制。
- 当 stdin 关闭时,待处理的扩展 UI、宿主工具和宿主 URI 请求被拒绝;已接受的命令被排空,会话被处置,进程以代码 `0` 退出。
- 响应/事件作为每行一个 JSON 对象写入。

## 传输与帧

协议 v1 stdout 帧是一个后跟 `\n` 的 JSON 对象。服务器将每个物理 stdout 帧上限为 1 MiB。入站命令始终是一个不分块的 JSONL 对象;客户端 SHOULD 将其保持在宣传的物理帧限制内。

初始 ready 帧使用协议 v1,并宣传可选的无损传输:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

支持协议 v2 的客户端 SHOULD 立即发送:

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

成功响应之后,超大的 stdout 对象作为不间断的 `rpc_chunk` 帧序列无损发出。每个 chunk 携带原始 UTF-8 JSON 对象的一个 base64 段:

```json
{
  "type": "rpc_chunk",
  "chunkId": "rpc-1",
  "index": 0,
  "count": 7,
  "byteLength": 1600042,
  "data": "eyJ0eXBlIjoicmVzcG9uc2UiLC4uLn0="
}
```

客户端 MUST 验证 `chunkId`、`index`、`count` 和 `byteLength`,拒绝交错或中断的序列,强制执行宣传的重组限制,按索引顺序连接解码字节,将它们解码为严格 UTF-8,并将结果解析为一个 JSON 对象。TypeScript `RpcFrameDecoder` 从 `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame` 导出,实现此验证。捆绑的 TypeScript 和 Python `RpcClient` 实现在 ready 帧宣传 v2 时自动协商 v2。

旧客户端可以忽略新增的 ready 字段并停留在 v1。V1 保留其对超大输出的有界回退行为。超过 v2 重组上限的帧仍然显式失败;大型历史 API 应使用分页,而不是依赖任意大的逻辑帧。

### 出站帧类别(stdout)

1. Ready 帧(`{ type: "ready" }`)
2. `RpcResponse`(`{ type: "response", ... }`)
3. `AgentSessionEvent` 对象(`agent_start`、`message_update` 等)
4. `RpcExtensionUIRequest`(`{ type: "extension_ui_request", ... }`)
5. 宿主工具请求/取消(`host_tool_call`、`host_tool_cancel`)
6. 宿主 URI 请求/取消(`host_uri_request`、`host_uri_cancel`)
7. 扩展错误(`{ type: "extension_error", extensionPath, event, error }`)
8. 可用命令更新(`{ type: "available_commands_update", commands }`),在启动时和命令元数据变化时发出
9. 提示词生命周期提示(`{ type: "prompt_result", id?, agentInvoked }`),用于稍后未调用 Agent 就解析的定时提示词
10. 子代理帧(`subagent_lifecycle`、`subagent_progress`、`subagent_event`),由 `set_subagent_subscription` 门控
11. 内置斜杠命令侧信道(`command_output`、`session_info_update`、`config_update`)

### 入站帧类别(stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse`(`{ type: "extension_ui_response", ... }`)
3. 宿主工具更新/结果(`host_tool_update`、`host_tool_result`)
4. 宿主 URI 结果(`host_uri_result`)

## 请求/响应关联

所有命令接受可选的 `id?: string`。

- 提供时,正常命令响应回显相同的 `id`。
- `RpcClient` 依赖此进行待处理请求解析。

来自运行时的关键边界行为:

- 未知命令响应以 `id: undefined` 发出(即使请求有 `id`)。
- 格式错误的 JSON 和同步分派失败发出 `command: "parse"`,带 `id: undefined`。处理已识别命令时的异常发出失败,带该命令的 `type` 和 `id`。
- `prompt` 和 `abort_and_prompt` 返回即时成功,然后如果异步提示词调度失败,可能稍后发出带**相同** id 的错误响应。
- `prompt` 成功响应可能包含 `data.agentInvoked`。`false` 表示提示词在本地完成,没有 Agent 轮次;`true` 表示提示词产生了 Agent 生命周期事件;省略表示宿主必须依赖会话事件来确定完成。
- `abort_and_prompt` 目前不发出 `data.agentInvoked` 或 `prompt_result`;宿主应将其视为旧的 abort-then-schedule 路径,并依赖会话事件或同 id 调度错误。

## 命令 Schema(规范)

`RpcCommand` 定义于 `packages/coding-agent/src/modes/rpc/rpc-types.ts`:

### 提示

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### 协议

- `{ id?, type: "negotiate_protocol", protocolVersion: 2 }`

### 状态

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_fast_mode", enabled: boolean }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`

### 模型

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### 思考

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### 队列模式

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### 压缩

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### 重试

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

`bash` 被并发分派:RPC 服务器在 shell 命令运行时继续读取命令,因此在长时间运行的 `bash` 期间发送的 `abort_bash`(或任何其他命令)会在不等待其自行完成的情况下被处理。`bash` 响应在命令完成时发出;宿主通过 `id` 关联它。并发命令之间的排序不保证——客户端 MUST 按 `id` 匹配响应,而不是按发出顺序。

### 会话

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

### 消息

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` 返回一个稳定的按时间顺序的页,带 `messages`、`totalMessages` 和剩余消息时的不透明 `nextCursor`。游标绑定到会话 ID、持久叶子节点和消息计数。如果会话在请求之间变化,服务器拒绝过期游标,并且拒绝在会话流式或压缩时开始分页遍历。失败的页请求在错误响应上携带机器可读的 `code` —— `session_busy`(会话正在流式或压缩)或 `stale_cursor`(游标背后的快照已变化,例如后台 bash 在页之间追加了一条消息)——因此客户端可以在不匹配错误消息文本的情况下反应。页最多包含 256 条消息,通常保持在 v1 物理帧上限以下。v1 调用者可以为普通历史分页,但单条消息的响应超过该上限会产生溢出错误;要无损取回它,需要协商 v2 帧。

捆绑的 TypeScript `RpcClient.getMessages()` 和 Python `RpcClient.get_messages()` 在协商 v2 后自动排空此分页端点。它们连接到 v1 服务器时保留旧的整体式命令,并且在 `session_busy` 或 `stale_cursor` 时丢弃部分页并回退到旧的最佳努力快照。直接的 `getMessagesPage()` 和 `get_messages_page()` 调用保持严格,因此增量宿主永远不会静默混合快照。

### 登录

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

## 响应 Schema

所有命令结果使用 `RpcResponse`:

- 成功:`{ id?, type: "response", command: <command>, success: true, data?: ... }`
- 失败:`{ id?, type: "response", command: string, success: false, error: string, code?: string }`

数据负载是命令特定的,定义于 `rpc-types.ts`。

### `prompt` 负载

`prompt` 在命令被接受后确认,而不是在模型轮次结束后:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` 是仅本地提示词的完成信号,包括产生输出但不启动 Agent 轮次的斜杠命令。`data.agentInvoked: true` 表示提示词产生了 Agent 生命周期事件;这些事件可以根据命令路径在提示词响应之前或之后发出。较旧的运行时可能省略 `data`;宿主应随后依赖 `agent_end`、自定义消息完成或 `prompt_result`。

当提示词被立即接受但后来解析为仅本地时,发出 `prompt_result`:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": false }
```

仅本地斜杠命令可以在通过 `data.agentInvoked: false` 或稍后的 `prompt_result` 完成前发出 `command_output` 帧。它们不发出 `agent_end`。

### `get_state` 负载

`tokensPerSecond` 在输出吞吐可用时是数字,否则为 `null`。`fastModeEnabled` 报告会话设置,而 `fastModeActive` 报告实际计算出的活动状态。对于 Fireworks,`providers.fireworksTier: priority` 是独立于 `/fast` 家族设置的提供商级设置,因此不支持的 Fireworks 模型的 `fastModeActive` 可能保持 `true`。

对于直接 Anthropic,提供商拒绝 `speed: "fast"` 使用按已解析端点和精确模型作用域的粘性回退:`fastModeEnabled` 可能保持 `true`,而 `fastModeActive` 为 `false`。显式 `set_fast_mode` 启用表达重试意图并清除该回退,以便提供商尝试重新武装。

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "fastModeEnabled": false,
  "tokensPerSecond": null,
  "fastModeActive": false,
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  }
}
```

### `set_fast_mode` 负载

`set_fast_mode` 更改会话是否启用快速模式。请求是:

```json
{ "id": "req_fast_on", "type": "set_fast_mode", "enabled": true }
```

成功时,`data` 总是同时包含 `enabled` 和 `active`。这些是实际计算出的值:`enabled` 报告会话设置,`active` 报告结果的活动状态,包括任何提供商级 Fireworks 优先级设置:

对于直接 Anthropic,即使快速模式已经启用,显式启用也会在粘性拒绝回退后重新武装提供商尝试。

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": true, "active": true }
}
```

在没有服务层级家族的模型上启用快速模式会以下面的精确错误失败:

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": false,
  "error": "Fast mode is unavailable for the current model."
}
```

禁用快速模式是幂等的,包括在不支持的模型上。它作为关闭/no-op 结果成功,但禁用 `/fast` 不会覆盖提供商级设置,因此成功禁用不保证 `active: false`。例如,使用不支持的 `fireworks/deepseek-v4-flash` 模型和 `providers.fireworksTier: priority`,响应报告会话设置已禁用,而提供商优先级使计算出的活动状态保持为 true:

```json
{
  "id": "req_fast_off",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": false, "active": true }
}
```

对应的 `get_state` 结果报告相同的计算状态:

```json
{
  "fastModeEnabled": false,
  "fastModeActive": true
}
```

### `set_todos` 负载

替换当前会话的内存中 todo 状态,并返回规范化的阶段列表:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

这对于想在第一次提示词前预置计划的宿主很有用。

### `set_host_tools` 负载

替换 RPC 服务器可以通过 stdio 回调的当前宿主拥有工具集:

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

响应负载是:

```json
{
  "toolNames": ["echo_host"]
}
```

这些工具在下次模型调用前被添加到活动会话工具注册表。重新发送 `set_host_tools` 替换先前的宿主拥有集合。

定义也接受 `hidden?: boolean` 和 `loadMode?: "essential" | "discoverable"`。显式模式胜出。省略时,已知的必要内置名称保持 `"essential"`;其他宿主工具默认为 `"discoverable"`。响应中的 `toolNames` 列出注册的名称。

### `set_host_uri_schemes` 负载

替换 RPC 服务器应通过其分派读/写的当前宿主拥有 URL scheme 集:

```json
{
  "id": "req_4",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

响应负载是:

```json
{
  "schemes": ["db"]
}
```

Scheme 在线上不区分大小写,并在响应发送前规范化为小写。重新发送 `set_host_uri_schemes` 替换整个先前的集合——不在新列表中的 scheme 被注销。

`security://` 保留给 OMP 的生产者中立软件安全资源存储。RPC 宿主不能注册或遮蔽该 scheme。

## 事件流 Schema

RPC 模式从 `AgentSession.subscribe(...)` 转发 `AgentSessionEvent` 对象。

常见事件类型:

- `agent_start`、`agent_end`
- `turn_start`、`turn_end`
- `message_start`、`message_update`、`message_end`
- `tool_execution_start`、`tool_execution_update`、`tool_execution_end`
- `auto_compaction_start`、`auto_compaction_end`
- `auto_retry_start`、`auto_retry_end`
- `retry_fallback_applied`、`retry_fallback_succeeded`
- `model_changed`、`thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder`、`todo_auto_clear`
- `irc_message`、`notice`、`goal_updated`

扩展 runner 错误作为单独帧发出:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` 在 `assistantMessageEvent` 中包含流式增量(文本/思考/工具调用增量)。

`agent_end` 有这个会话级形状(除可选遥测字段外):

```ts
{
  type: "agent_end";
  messages: AgentMessage[];
  isTerminal?: boolean;
}
```

`isTerminal: false` 意味着维护或异步交付已调度更多工作,因此会话将在真正最终静止前恢复。只有 `isTerminal !== false` 时才将 `agent_end` 视为运行完成;该字段是可选的,因此来自较旧运行时(其中它缺失)的帧保持终端兼容。

### 可用命令

`get_available_commands` 返回 `{ commands }`,相同的数组在启动时和命令元数据变化后推入 `available_commands_update` 帧。每个命令有 `name`、`source`,以及可选的 `aliases`、`description`、`input.hint` 和 `subcommands`。

### 子代理订阅

子代理转发默认为 `"off"`。`set_subagent_subscription` 选择:

- `"off"`:不转发子代理帧
- `"progress"`:生命周期和进度帧
- `"events"`:生命周期、进度和完整子代理事件帧

`get_subagents` 返回按子代理索引和 id 排序的注册表快照。`get_subagent_messages` 按 `subagentId` 或 `sessionFile` 选择转录本;`fromByte` 支持增量读取。其结果包含 `sessionFile`、`fromByte`、`nextByte`、`reset`、原始转录本 `entries` 和转换后的 `messages`。如果 `fromByte` 超过当前文件大小,读取从字节零重新开始并报告 `reset: true`。

## 提示词/队列并发与排序

这是最重要的操作行为。

### 即时确认与完成

`prompt` 和 `abort_and_prompt` 被**立即确认**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

这意味着:

- 命令接受 != 运行完成
- Agent 轮次只在 `isTerminal !== false` 的 `agent_end` 帧上完成
- 仅本地提示词通过响应上的 `data.agentInvoked: false` 或稍后的 `prompt_result` 完成

### 流式期间

`AgentSession.prompt()` 在活动流式期间要求 `streamingBehavior`:

- `"steer"` => 排队的 steering 消息(中断路径)
- `"followUp"` => 排队的后续消息(轮次后路径)

流式期间省略时,prompt 失败。

### 队列默认

来自 `packages/agent/src/agent.ts` 的默认值:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### 模式语义

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`:每轮出队一条排队消息
  - `"all"`:一次出队整个队列
- `set_interrupt_mode`
  - `"immediate"`:工具执行在工具调用之间检查 steering;待处理的 steering 可以中止轮次中剩余的工具调用
  - `"wait"`:将 steering 推迟到轮次完成

## 扩展 UI 子协议

RPC 模式中的扩展使用请求/响应 UI 帧。

### 出站请求

`RpcExtensionUIRequest`(`type: "extension_ui_request"`)方法:

- `select`、`confirm`、`input`、`editor`、`cancel`
- `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`
- `open_url`(由 RPC 登录流程发出)

运行时说明:

- RPC 模式禁用自动会话标题生成,`setTitle` UI 请求也默认被抑制,因为大多数宿主没有有意义的终端标题面。设置 `PI_RPC_EMIT_TITLE=1` 可重新选择仅接收 UI 事件。

示例:

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### 入站响应

`RpcExtensionUIResponse`(`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`

如果对话框有超时,RPC 模式在超时/中止触发时解析为默认值。

## 宿主工具子协议

RPC 宿主可以通过发送 `set_host_tools` 向 Agent 暴露自定义工具,然后在同一传输上服务执行请求。

### 出站请求

当 Agent 希望宿主执行其中一个工具时,RPC 模式发出:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

如果工具执行稍后被中止,RPC 模式发出:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### 入站更新与完成

宿主可以选择性地流式传输进度:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

完成使用:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

在 `host_tool_result` 上设置顶层 `isError: true` 以拒绝待处理的宿主工具调用,并将返回的文本内容作为工具错误浮出。

## 宿主 URI 子协议

RPC 宿主也可以拥有自定义 URL scheme(虚拟文件)。在 `set_host_uri_schemes` 之后,对 `<scheme>://…` 的每次读和(注册为 `writable` 时)`<scheme>://…` 的写都会在同一传输上弹回宿主。

### 出站请求

当会话工具解析宿主拥有的 URL 时,RPC 模式发出:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

写入看起来相同,带 `"operation": "write"` 和携带完整替换字节的额外 `"content": "..."` 字段。

如果请求稍后被中止(调用者取消、会话结束),RPC 模式发出:

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_1"
}
```

### 入站结果

对于成功读:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

对于成功写,省略 content:

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

要拒绝请求,设置 `isError: true`,并填充 `error` 消息或回退到 `content` 以进行文本错误浮出:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "isError": true,
  "error": "row 42 not found"
}
```

### 约束

- Agent 的 `edit` 工具不针对宿主 URI。想要变更虚拟文件的宿主暴露 `write`,并让模型使用带替换内容的 `write` 工具。
- Scheme 对进程是全局的;`set_host_uri_schemes` 替换先前的集合,注销不在新列表中的任何内容。
- Scheme 在注册前规范化为小写。
- 成功读要求 `content`。`contentType` 默认为 `text/plain`,提供时是 `"text/plain"`、`"text/markdown"` 或 `"application/json"`。结果级 `immutable` 覆盖注册 scheme 对该读的值。

## 错误模型与可恢复性

### 命令级失败

失败是 `success: false` 带字符串 `error`。

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### 可恢复性预期

- 大多数命令失败是可恢复的;进程保持存活。
- 格式错误的 JSONL / 解析循环异常发出 `parse` 错误响应并继续读取后续行。
- 空的 `set_session_name` 被拒绝(`Session name cannot be empty`)。
- 带未知 `id` 的扩展 UI 响应被忽略。
- 进程终止条件是 stdin 关闭,或当前命令后扩展触发的显式关闭。

## 压缩命令流程

### 1) 提示词并流式

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout 序列(典型):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [], "isTerminal": true }
```

### 2) 流式期间带显式队列策略提示词

stdin:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) 检查并调整队列行为

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) 扩展 UI 往返

stdout:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## 客户端库

### TypeScript 辅助

`packages/coding-agent/src/modes/rpc/rpc-client.ts` 是一个便利包装,不是协议定义。

当前辅助特征:

- 派生 `bun <cliPath> --mode rpc`
- 通过生成的 `req_<n>` id 关联响应
- 将已识别的核心 `AgentEvent` 类型分派给监听器
- 通过 `setCustomTools()` 和 `host_tool_call` / `host_tool_cancel` 的自动处理支持宿主拥有自定义工具
- 包装常见协议命令,包括 OAuth `getLoginProviders()` / `login(...)`;对辅助未包装的任何面使用原始协议帧。

### Python 包

捆绑的 [`omp-rpc`](../python/omp-rpc/pyproject.toml) 发行版提供进程支撑的 Python 客户端。其导入包是 `omp_rpc`;包 API、类型化命令和事件、宿主工具/宿主 URI 辅助,以及编排示例维护在 [`omp-rpc` README](../python/omp-rpc/README.md) 中。

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

默认情况下,`RpcClient` 启动 `omp --mode rpc`;传入 `command=[...]` 以拥有确切的子命令。它处理请求关联、类型化通知、v2 协商和 chunk 重组、消息分页、扩展 UI,以及宿主拥有的工具和 URI scheme。Python 包拥有该客户端 API 和进程生命周期;本文档和 `rpc-types.ts` 保持为规范 wire 契约。当客户端库不包装你需要的面时,使用原始协议帧。
