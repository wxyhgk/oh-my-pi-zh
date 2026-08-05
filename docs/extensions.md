# 扩展

在 `packages/coding-agent` 中编写运行时扩展的主要指南。

本文档涵盖以下文件中的当前扩展运行时：

- `src/extensibility/extensions/types.ts`
- `src/extensibility/extensions/runner.ts`
- `src/extensibility/extensions/wrapper.ts`
- `src/extensibility/extensions/index.ts`
- `src/modes/controllers/extension-ui-controller.ts`

有关发现路径和文件系统加载规则,请参阅 [`extension-loading.md`](./extension-loading.md)。

有关面向用户的打包扩展 CLI/功能(如 `packages/swarm-extension`),请参阅 [`user-facing-packages.md`](./user-facing-packages.md)。

## 扩展是什么

扩展是一个导出默认工厂函数的 TS/JS 模块。工厂函数可以同步初始化,也可以返回 promise:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // register handlers/tools/commands/renderers
}
```

扩展可以在一个模块中组合以下所有功能:

- 事件处理器(`pi.on(...)`)
- 可供 LLM 调用的工具(`pi.registerTool(...)`)
- 斜杠命令(`pi.registerCommand(...)`)
- 键盘快捷键和标志位
- 自定义消息渲染
- 会话/消息注入 API(`sendMessage`、`sendUserMessage`、`appendEntry`)

## 运行时模型

1. 扩展被导入并执行其工厂函数。
2. 在加载阶段,注册方法是有效的;运行时操作方法尚未初始化。
3. `ExtensionRunner.initialize(...)` 为当前模式接入实时的操作/上下文。
4. 会话/Agent/工具生命周期事件会派发给处理器。
5. 每次工具执行都会被扩展拦截包装(`tool_call` / `tool_result`)。

```text
Extension lifecycle (simplified)

load paths
   │
   ▼
import module + run factory (registration only)
   │
   ▼
ExtensionRunner.initialize(mode/session/tool registry)
   │
   ├─ emit session/agent events to handlers
   ├─ wrap tool execution (tool_call/tool_result)
   └─ expose runtime actions (sendMessage, setActiveTools, ...)
```

来自 `loader.ts` 的重要约束:

- 在扩展加载期间调用 `pi.sendMessage()` 等操作方法会抛出 `ExtensionRuntimeNotInitializedError`
- 先注册;通过事件/命令/工具执行运行时行为

## 快速开始

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const { z } = pi.zod;

  pi.setLabel("Safety + Utilities");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Extension loaded in ${ctx.cwd}`, "info");
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Blocked by extension policy" };
    }
  });

  pi.registerTool({
    name: "hello_extension",
    label: "Hello Extension",
    description: "Return a greeting",
    parameters: z.object({ name: z.string() }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}` }],
        details: { greeted: params.name },
      };
    },
  });

  pi.registerCommand("hello-ext", {
    description: "Show queue state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pending=${ctx.hasPendingMessages()}`, "info");
    },
  });
}
```

## 扩展 API 表面

## 1) 注册与操作(`ExtensionAPI`)

核心方法:

- `on(event, handler)`
- `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`
- `registerMessageRenderer`, `registerAssistantThinkingRenderer`
- `setLabel`, `getFlag`
- `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`
- `getActiveTools`, `getAllTools`, `setActiveTools`
- `getCommands`
- `getSessionName`, `setSessionName`
- `setModel`, `getThinkingLevel`, `setThinkingLevel`
- `getServiceTiers`, `setServiceTier`
- `registerProvider`
- `events`(共享事件总线)

`getServiceTiers()` 返回会话当前各模型家族层级映射的独立快照。`setServiceTier(family, tier)` 为后续请求修改某一家族的层级;传入 `undefined` 可清除该会话的覆盖设置。OpenAI 接受 `auto`、`default`、`flex`、`scale` 或 `priority`;Anthropic 接受 `priority`;Google 接受 `flex` 或 `priority`。在响应流式传输期间所做的更改不会影响正在进行的请求。

在交互模式下,`input` 处理器先于内置的首条消息自动标题检查运行。扩展在 `input` 中调用 `await pi.setSessionName(...)` 可以设置持久化的会话名称,并阻止该会话执行默认的自动生成标题。

另外还暴露了:

- `pi.logger`
- `pi.arktype`(ArkType `Type` 运行时;这不是 ArkType 的 `type(...)` schema 构建器)
- `pi.zod`(注入的 `zod/v4` 模块,用于编写 Zod 工具参数 schema)
- `pi.typebox`(基于 zod 的兼容垫片,用于旧式 TypeBox 风格 schema)
- `pi.pi`(包导出)

### 消息投递语义

`pi.sendMessage(message, options)` 支持:

- `deliverAs: "steer"`(默认)— 中断当前运行
- `deliverAs: "followUp"` — 排队在当前运行结束后执行
- `deliverAs: "nextTurn"` — 存储并在下一次用户提示词时注入
- `triggerTurn: true` — 空闲时启动一个轮次(与 `deliverAs: "nextTurn"` 配合也生效:空闲时立即提示;流式传输期间,排队的消息会调度一次内部续接)

`pi.sendUserMessage(content, { deliverAs })` 始终走提示词流程。省略 `deliverAs` 时,空闲状态下会启动常规提示词;流式传输期间,省略 `deliverAs` 会将消息作为 steer 排队。设置 `deliverAs: "followUp"` 可等待当前运行结束。

## 2) 处理器上下文(`ExtensionContext`)

处理器和工具 `execute` 会收到包含以下内容的 `ctx`:

- `ui`
- `hasUI`
- `cwd`
- `sessionManager`(只读)
- `modelRegistry`, `model`
- `models`(只读模型查询 — 见下文)
- `localProtocolOptions`(可选,调用会话的 `local://` 根映射,用于外部工具桥接)
- `getContextUsage()`
- `getAsyncJobSnapshot()` 返回当前会话的只读异步任务快照;当没有会话持有该上下文时返回 `null`
- `compact(...)`
- `isIdle()`, `hasPendingMessages()`, `abort()`
- `shutdown()`
- `getSystemPrompt()`
- `memory`(可选的结构化记忆运行时 — 跨已配置后端进行状态查询/搜索/保存)
- `setInterval(fn, ms, ...args)` / `setTimeout(fn, ms, ...args)` / `clearTimer(timer)` — 受管理的定时器(见下文)

### 后台任务(`ctx.setInterval` / `ctx.setTimeout`)

扩展**在进程内运行,没有隔离**。原生 `setInterval`/`setTimeout`/分离 promise 的回调若抛出异常,会在处理器派发的 try/catch 之外运行,表现为进程级 `uncaughtException`,全局事后处理器会将其视为致命错误 — **整个会话会被拆除**,而不只是出问题的扩展。

对任何周期性或延迟的后台任务,请使用 `ctx.setInterval` / `ctx.setTimeout`。它们与平台签名一致,但有以下区别:

- 以与处理器派发相同的隔离方式运行回调 — 同步抛出或被拒绝的 promise 会被记录并通过扩展错误通道报告,会话继续运行;
- 返回一个句柄,可传给 `ctx.clearTimer(handle)`;
- 已 `unref`(本身不会让进程保持存活),并在 `session_shutdown` 时自动清除。

```ts
pi.on("session_start", async (_event, ctx) => {
  const timer = ctx.setInterval(() => {
    // A throw here is contained — it will not crash the session.
    ctx.ui.notify("tick", "info");
  }, 60_000);
  // Optional: clear it yourself; otherwise it is cleared on shutdown.
  pi.on("session_shutdown", () => ctx.clearTimer(timer));
});
```

如果你改用原生 `setInterval`/`setTimeout` 或分离 promise,隔离责任由你自己承担:用你自己的 `try/catch` 包裹回调体(未处理的抛出会导致会话崩溃),并在 `session_shutdown` 时清除定时器。

### 模型选择(`ctx.models`)

`ctx.models` 是一个只读门面,用于以与核心相同的方式选择和比较模型:

- `list()` — 本次会话可用的已认证模型。
- `current()` — 当前会话模型(惰性读取,因此能反映 `/model` 切换)。
- `resolve(spec)` — 模型字符串(`provider/id`、裸 id)或角色别名(`@slow` 等已配置角色)→ `Model`,遵循与 `--model` 相同的基于设置的别名和匹配偏好。无匹配时返回 `undefined`。
- `family(model)` — 用于“同家族?”判断的不透明谱系令牌(Claude 小版本共享同一令牌;Claude 与 GPT 不同)。只用于比较,不要持久化(词汇表会随新版本更新)。

```ts
// Pick a model from a different family than the current one (e.g. a cross-family reviewer).
const current = ctx.models.current();
const contrasting = ctx.models
  .list()
  .find((m) => current && ctx.models.family(m) !== ctx.models.family(current));
```

## 3) 命令上下文(`ExtensionCommandContext`)

命令处理器还额外获得:

- `waitForIdle()`
- `newSession(...)`
- `switchSession(...)`
- `branch(entryId)`
- `navigateTree(targetId, { summarize })`
- `reload()`

命令上下文用于会话控制流程;这些方法被有意与通用事件处理器分离。

## 事件表面(当前名称与行为)

规范的事件联合类型和载荷类型定义在 `types.ts` 中。

### 会话生命周期

- `session_start`
- `session_before_switch` / `session_switch`
- `session_before_branch` / `session_branch`
- `session_before_compact` / `session.compacting` / `session_compact`
- `session_before_tree` / `session_tree`
- `session_shutdown`

可取消的前置事件:

- `session_before_switch` → `{ cancel?: boolean }`
- `session_before_branch` → `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_before_compact` → `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_before_tree` → `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`

### 提示词与轮次生命周期

- `input`
- `before_agent_start`
- `before_provider_request`(可以替换提供商请求载荷)
- `after_provider_response`
- `context`
- `agent_start` / `agent_end` — Agent 循环生命周期通知;`agent_end` 仍仅为通知
- `session_stop` — 主会话停止钩子,在结算前等待;可通过 `{ continue: true, additionalContext }` 继续,或通过 `{ decision: "block", reason }` 阻止;最多连续续接 8 次,且绝不会为任务/子 Agent 会话触发
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`

### 工具生命周期

- `tool_call`(执行前触发,可以阻止或修改工具的执行 `input`;对于模型发起的调用,它在 Agent 循环中的参数准备阶段触发,因此修订会被重新验证,并被并发调度、执行事件、持久化的助手消息以及批准门一并看到)
- `tool_result`(执行后触发,可以修补 content/details/isError)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`(可观测性)
- `tool_approval_requested` / `tool_approval_resolved`(可观测性;仅当工具需要批准且已注册批准处理器时,由 `wrapper.ts` 发出)

`tool_result` 是中间件风格:处理器按扩展顺序运行,每个处理器都能看到之前的修改。

### 可靠性/运行时信号

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `goal_updated`
- `credential_disabled`

### MCP 通知

- `mcp_notification` — 每收到一条来自已连接 MCP 服务器的 JSON-RPC 通知都会触发,且发生在管理器自身处理已知的列表/更新方法(`notifications/tools/list_changed`、`notifications/resources/list_changed`、`notifications/resources/updated`、`notifications/prompts/list_changed`)之后。未知或服务器自定义的方法也会被投递。载荷:`{ server: string; method: string; params: unknown }`。多个扩展可以订阅;某个处理器抛出异常不会阻止其他处理器触发。在任何监听器挂载之前收到的通知会被缓冲(有界 FIFO,上限 100,丢弃最旧的),并在第一个订阅者接入时排空 — 因此即使扩展在 MCP 发现之后才绑定,启动阶段的帧也不会丢失。

将支持推送的 MCP 桥接到会话 steer:

```ts
pi.on("mcp_notification", (event) => {
  if (event.server !== "peer-bus") return;
  if (event.method !== "notifications/peer_message") return;
  const params = event.params as { from: string; text: string };
  pi.sendUserMessage(`[from ${params.from}] ${params.text}`, {
    deliverAs: "steer",
  });
});
```

运行时先处理 JSON-RPC 传输和自身的列表/更新刷新;处理器随后运行,可以通过 `pi.sendMessage` / `pi.sendUserMessage` 注入轮次中间的 steer。

### 用户命令拦截

- `user_bash`(可用 `{ result }` 覆盖)
- `user_python`(可用 `{ result }` 覆盖)

### `resources_discover`

`resources_discover` 存在于扩展类型和 `ExtensionRunner` 中。
当前运行时说明:`ExtensionRunner.emitResourcesDiscover(...)` 已实现,但当前代码库中没有 `AgentSession` 调用点调用它。

## 工具编写细节

`registerTool` 使用 `types.ts` 中的 `ToolDefinition`。其 `parameters` 字段接受 ArkType 或 Zod schema;注入的 TypeBox 兼容垫片对旧式扩展仍然可用。

当前 `execute` 签名:

```ts
execute(
	toolCallId,
	params,
	signal,
	onUpdate,
	ctx,
): Promise<AgentToolResult>
```

### 委托给原生内置工具(`ctx.invokeTool`)

重新注册内置工具名的工具(例如包装 `write` 以添加日志或策略检查)可以运行原实现,而不必重新实现。当你注册的工具遮蔽了内置工具时,传给 `execute` 的 `ctx` 会携带:

```ts
ctx.invokeTool?<TDetails>(
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback },
): Promise<AgentToolResult<TDetails>>
```

它会运行与你工具同名的**原生**内置实现(委托仅限同工具,因此无法触达任意目标,也无法绕过本次调用已授予的批准权限),并返回其结果,包括原生工具自身的副作用和内部簿记。仅当存在同名的原生内置工具时它才会出现 — 对于未遮蔽任何内置工具的纯新增工具,`ctx.invokeTool` 为 `undefined`。原生调用不会重新触发批准门,因为它是你已被批准的同名工具;委托深度受保护,以防意外的自我递归。

模板:

```ts
const { z } = pi.zod;

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",
  parameters: z.object({}),
  hidden: false,
  defaultInactive: false,
  deferrable: false,
  async execute(_id, _params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return { content: [{ type: "text", text: "Done" }], details: {} };
  },
  onSession(event, ctx) {
    // reason: start|switch|branch|tree|shutdown
  },
  renderCall(args, options, theme) {
    // optional TUI render
  },
  renderResult(result, options, theme, args) {
    // optional TUI render
  },
});
```

一旦注册表在 `sdk.ts` 中被包装,`tool_call`/`tool_result` 会拦截所有工具,包括内置工具和扩展/自定义工具。`ToolDefinition` 还支持可选的 `hidden`、`defaultInactive`、`loadMode`(默认 `"discoverable"`,或 `"essential"`)、`deferrable`、`approval`(默认 `"exec"`)、`strict`、`mcpServerName`、`mcpToolName`、`renderCall` 和 `renderResult` 字段。

## UI 集成点

`ctx.ui` 实现了 `ExtensionUIContext` 接口。不同模式下的支持程度不同。

### 交互模式(`extension-ui-controller.ts`)

支持:

- 对话框:`select`, `confirm`, `input`, `editor`
- 输入编辑:`setEditorText`, `getEditorText`, `pasteToEditor`, `editor`
- 自动补全堆叠:`addAutocompleteProvider(factory)` 包装内置编辑器提供商(工厂按注册顺序应用,并在每次斜杠命令刷新时重新应用)
- 终端标题和工作消息(`setTitle`, `setWorkingMessage`)
- 通知/状态/编辑器文本/终端输入/自定义覆盖层
- 按名称列出/加载主题(`setTheme` 支持字符串名称)
- 工具展开开关

该控制器中当前为 no-op 的方法:

- `setFooter`
- `setHeader`

`setEditorComponent` 已接入实时编辑器(`ctx.setEditorComponent(factory)`)。`setWidget` 通过 `setHookWidget(...)` 在编辑器上方或下方渲染真实的组件(`placement: "aboveEditor" | "belowEditor"`;字符串数组内容上限 10 行)。

### RPC 模式(`rpc-mode.ts`)

`ctx.ui` 由 RPC `extension_ui_request` 事件支撑:

- 对话框方法(`select`, `confirm`, `input`, `editor`)往返到客户端响应
- fire-and-forget 方法发出请求(`notify`, `setStatus`, `setWidget` 用于字符串数组,`setEditorText`;`setTitle` 仅在 `PI_RPC_EMIT_TITLE=1` 时发出)

RPC 实现中不支持/no-op 的:

- `onTerminalInput`
- `custom`
- `setFooter`, `setHeader`, `setEditorComponent`, `addAutocompleteProvider`
- `setWorkingMessage`
- 主题切换/加载(`setTheme` 返回失败)
- 工具展开控制无效

### 打印/无头/子 Agent 路径

当运行器初始化时未提供 UI 上下文,`ctx.hasUI` 为 `false`,方法为 no-op/返回默认值。

### ACP 模式

ACP 安装了一个基于 elicitation 桥接的 UI 上下文(`acp-agent.ts` 中的 `createAcpExtensionUiContext`)。`ctx.hasUI` 为 `true`,而 `select`/`confirm`/`input`/`editor` 往返(作为 ACP elicitation;当客户端缺少 `elicitation.form` 能力时返回默认值)。非 elicitation 表面(组件、主题、终端输入、自动补全堆叠)被存根为 no-op。

## 会话与状态模式

对于持久的扩展状态:

1. 使用 `pi.appendEntry("com.example.my-extension.state", data)` 持久化。`customType` 命名空间是全局的:使用包限定或反向域名限定的值,并避免 [`custom` 会话条目参考](./session.md#custom) 中核心保留的值。
2. 在 `session_start`、`session_branch`、`session_tree` 时从 `ctx.sessionManager.getBranch()` 重建状态。
3. 当状态需要从工具结果历史中可见/可重建时,保持工具结果 `details` 结构化。

示例重建模式:

```ts
pi.on("session_start", async (_event, ctx) => {
  let latest;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === "com.example.my-extension.state"
    ) {
      latest = entry.data;
    }
  }
  // restore from latest
});
```

## 渲染扩展点

## 自定义消息渲染器

```ts
pi.registerMessageRenderer("my-type", (message, { expanded }, theme) => {
  // return pi-tui Component
});
```

在交互式渲染显示自定义消息时使用。

## 助手思考渲染器

```ts
import { Container, Text } from "@oh-my-pi/pi-tui";

pi.registerAssistantThinkingRenderer((context, theme) => {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0),
  );
  return container;
});
```

在交互式渲染中用于在每个可见的助手思考块下方添加仅显示的补充 UI。渲染器会收到已可见的思考文本、内容/思考索引、主题,以及供异步渲染器使用的 `requestRender()` 回调。所有返回组件的已注册渲染器按注册顺序追加。渲染器不得修改消息;原始思考块仍是提供商/会话的事实来源。

## 工具调用/结果渲染器

在 `registerTool` 定义上提供 `renderCall` / `renderResult`,用于 TUI 中的自定义工具可视化。

## 约束与陷阱

- 运行时操作在扩展加载期间不可用。
- `tool_call` 错误会阻止执行(失败关闭)。
- 与内置命令重名的命令会被跳过并给出诊断信息。
- 保留快捷键会被忽略(`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `ctrl+q`, `alt+m`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`)。
- 将 `ctx.reload()` 视为当前命令处理器帧的终结操作。

## 扩展 vs 钩子 vs 自定义工具

选择正确的表面:

- **扩展**(`src/extensibility/extensions/*`):统一系统(事件 + 工具 + 命令 + 渲染器 + 提供商注册)。
- **钩子**(`src/extensibility/hooks/*`):独立的旧式事件 API。
- **自定义工具**(`src/extensibility/custom-tools/*`):以工具为中心的模块;与扩展一起加载时会被适配,并仍通过扩展拦截包装器。

如果你需要一个包同时拥有策略、工具、命令 UX 和渲染,请使用扩展。
