# SDK

SDK 是 `@oh-my-pi/pi-coding-agent` 的进程内集成界面。当你想从 Bun 进程中直接访问 Agent 状态、事件流、工具接线和会话控制时,请使用它。

如果你需要跨语言/进程隔离,请改用 RPC 模式。

## 安装

```bash
bun add @oh-my-pi/pi-coding-agent
```

需要 Bun 1.3.14 或更高版本。在第一次基于模型的提示词之前,请为提供商配置凭据,或运行无密钥的本地提供商;参见 [Providers](./providers.md)。会话构造可以在没有可用模型的情况下成功,但提示词不行。

## 入口点

包根 `@oh-my-pi/pi-coding-agent` 是完整的嵌入界面。它包含 `createAgentSession` 和聚焦的 `/sdk` 导出,以及更底层的会话、认证、模型、模式、扩展和工具 API。

从包根导入这些核心嵌入 API:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `AgentRegistry`
- `discoverAuthStorage`
- 发现辅助函数(`discoverExtensions`、`discoverSkills`、`discoverContextFiles`、`discoverPromptTemplates`、`discoverSlashCommands`、`discoverCustomTSCommands`、`discoverMCPServers`)
- 工具工厂界面(`createTools`、`BUILTIN_TOOLS`、工具类)

更窄的 `@oh-my-pi/pi-coding-agent/sdk` 子路径导出 `createAgentSession`、其选项/结果类型、`Settings`、`AgentRegistry`、发现与系统提示词辅助函数、工作区树辅助函数、精选的扩展/MCP/工具类型,以及精选的工具类/工厂。它**不**导出 `SessionManager`、`AuthStorage` 或 `ModelRegistry`;与下文示例一样,这三个需要从包根导入。

## 快速开始(自动发现默认值)

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

## `createAgentSession()` 默认发现什么

`createAgentSession()` 遵循“提供则覆盖,省略则发现”的原则。

如果省略,它会解析:

- `cwd`:`getProjectDir()`
- `agentDir`:`~/.omp/agent`(通过 `getAgentDir()`)
- `authStorage`:`discoverAuthStorage(agentDir)`
- `modelRegistry`:`new ModelRegistry(authStorage)` + 未提供注册表时的后台 `refreshInBackground()`
- `settings`:`await Settings.init({ cwd, agentDir })`
- `sessionManager`:`SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))`(文件后端)
- 技能/规则/上下文文件/提示词模板/斜杠命令/扩展/自定义 TS 命令
- 通过 `createTools(...)` 提供的内置工具
- MCP 工具(默认启用;Exa MCP 服务器并入原生 Exa 集成,内置浏览器工具启用时,浏览器自动化 MCP 服务器会被过滤)
- LSP 集成(默认启用)
- `eventBus`:未提供时新建 `EventBus()`

### 必需与可选输入

通常你只需提供想要控制的内容:

```ts
function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>;
```

- **必须提供**:最小会话无需任何内容
- **嵌入方通常显式提供**:
  - `sessionManager`(如果你需要内存或自定义位置)
  - `authStorage` + `modelRegistry`(如果你负责凭据/模型生命周期)
  - `model` 或 `modelPattern`(如果确定性的模型选择很重要)
  - `settings`(如果你需要隔离/测试配置)

对于同一进程中的多个并发顶层会话,请为每个会话传入私有的 `AgentRegistry`。默认的进程全局注册表在每个 generation 中只允许一个 `"Main"` 身份。

## 会话管理器行为(持久化 vs 内存)

`AgentSession` 始终使用 `SessionManager`;行为取决于你使用哪个工厂。

### 文件后端(默认)

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

console.log(session.sessionFile); // absolute .jsonl path
```

- 将会话/消息/状态差异持久化到会话文件。
- 支持恢复/打开/列出/分叉工作流。
- `session.sessionFile` 已定义。

### 内存模式

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

console.log(session.sessionFile); // undefined
```

- 无文件系统持久化。
- 适用于测试、临时 worker、请求作用域的 Agent。
- 会话方法仍然有效,但持久化特有的行为(文件恢复/分叉路径)自然受限。

### 恢复/打开/列出辅助函数

```ts
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

## 模型与认证接线

`createAgentSession()` 使用 `ModelRegistry` + `AuthStorage` 进行模型选择和 API 密钥解析。

如果同时提供 `authStorage` 和 `modelRegistry`,`modelRegistry.authStorage` 必须是同一实例;会话创建会拒绝不一致的存储。

### 显式接线

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const available = modelRegistry.getAvailable();
if (available.length === 0)
  throw new Error("No authenticated models available");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model: available[0],
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(),
});
```

### 省略 `model` 时的选择顺序

当未提供显式的 `model`/`modelPattern` 时:

1. 从现有会话恢复模型(如果可恢复且密钥可用)
2. 设置的默认模型角色(`default`)
3. 按可用性顺序选择已认证的提供商默认模型(当不存在提供商默认值时,回退到第一个已认证的可用模型)

如果恢复失败,`modelFallbackMessage` 会解释回退情况。

### 认证优先级

`AuthStorage.getApiKey(...)` 按此顺序解析:

1. 运行时覆盖(`setRuntimeApiKey`,由 CLI `--api-key` 使用)
2. 来自配置的 API 密钥覆盖(`models.yml` 提供商的 `apiKey`)
3. 已存储的 OAuth 凭据,包括需要时刷新
4. 成功的 `/login` 持久化的 API 密钥
5. 提供商环境变量
6. `agent.db` / broker 后端存储中的其他已存 API 密钥凭据
7. 自定义提供商解析器回退

## 事件订阅模型

使用 `session.subscribe(listener)` 订阅;它会返回一个取消订阅函数。

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "tool_execution_start":
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
  }
});
```

`AgentSessionEvent` 包含核心 `AgentEvent` 以及会话级事件:

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `retry_fallback_applied` / `retry_fallback_succeeded`
- `model_changed`
- `thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder` / `todo_auto_clear`
- `irc_message`
- `notice`
- `goal_updated`

`agent_end` 包含 `messages`、可选的遥测字段,以及 `isTerminal?: boolean`。当 `isTerminal` 为 `false` 时,维护或异步投递会在会话真正最终落定之前恢复它。将 `agent_end` 用作完成信号的订阅者必须等待 `isTerminal !== false`。为与旧运行时兼容,应将缺失的字段视为终态。

## 提示词生命周期

`session.prompt(text, options?)` 是主要入口点。

行为:

1. 可选的命令/模板展开(`/` 命令、自定义命令、文件斜杠命令、提示词模板)
2. 如果当前正在流式输出:
   - `streamingBehavior: "steer" | "followUp"` 选择 `prompt()` 的排队方式
   - 扩展 `sendUserMessage(content)` 在省略 `deliverAs` 时默认为 steer
   - 排队中的消息会被保留,而不是丢弃
3. 如果空闲:
   - 验证模型 + API 密钥
   - 追加用户消息
   - 启动 Agent 轮次

相关 API:

- `sendUserMessage(content, { deliverAs? })`
- `steer(text, images?)`
- `followUp(text, images?)`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

## `AgentSession` 生命周期与销毁

当嵌入方完全使用完一个会话时,调用 `await session.dispose()`。`dispose()` 会自行启动销毁流程,并且是幂等的:重复或并发的调用会收到同一个拆除 promise,因此关闭事件和拥有的资源不会被重复清理。

`beginDispose()` 是那些必须在调用 `dispose()` 之前等待自身拆除的包装器的同步准入屏障。请在包装器的第一次 `await` 之前调用它;否则延迟工作可能进入这个空档。它会立即将会话标记为已销毁,取消内存启动、标题生成和自动学习捕获,清空排队的 yield/aside,停止顾问运行时,分离 aside 投递,并拒绝新的 eval 执行。延迟的会话工作会检查已销毁状态并被丢弃或跳过。`beginDispose()` 也是幂等的,并且仍然需要后续的 `dispose()` 调用来完成异步清理。

```ts
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

async function closeEmbeddedSession(
  session: AgentSession,
  closeHostInputAndUi: () => Promise<void>,
): Promise<void> {
  session.beginDispose(); // no new deferred work may enter after this point
  await closeHostInputAndUi();
  await session.dispose();
}
```

在异步销毁期间,会话会记录并同步刷新其退出诊断,发出一次 `session_shutdown`,停止扩展回退定时器,中止重试、压缩和活动中的 Agent 轮次,并给提示词后处理和自动学习工作有限的时间来落定。然后它并发地拆除会话拥有的异步任务、eval 内核、浏览器标签页、原生 computer 会话、MCP 连接、顾问状态和内存状态。这些子系统清理在适用处是尽力而为且有界;失败会被记录,而不会阻止其余子系统的清理。

只有在能够追加会话条目的工作落定之后,销毁才会清理空的已迁移会话、关闭 `SessionManager`、关闭提供商会话状态、断开 Agent 并移除监听器。最终持久化清理或 `SessionManager.close()` 的失败会使共享的销毁 promise 被拒绝;单个提供商会话关闭失败则会被记录。

## 工具与扩展集成

### 内置工具与筛选

- 内置工具来自 `createTools(...)` 和 `BUILTIN_TOOLS`。
- `toolNames` 请求指定的工具,并且可以启用默认禁用的工具;它本身**不是**允许列表。
- 设置 `restrictToolNames: true` 将会话限制为 `toolNames` 中的名称。受限会话默认禁用环境 MCP、扩展、自定义命令和 LSP。
- 在受限会话中,SDK 提供的 `customTools` 会被排除,除非 `allowRestrictedCustomTools: true` 且它们的名称也出现在 `toolNames` 中。
- 隐藏工具(例如 `yield`)是可选加入的,除非选项要求。

```ts
const { session } = await createAgentSession({
  toolNames: ["read", "grep", "glob", "write"],
  restrictToolNames: true,
  requireYieldTool: true,
});
```

### 扩展

- `extensions`:内联的 `ExtensionFactory[]`
- `additionalExtensionPaths`:加载额外的扩展文件
- `disableExtensionDiscovery`:禁用环境扫描;显式路径和内联工厂仍会加载
- `preloadedExtensions`:复用同一会话拥有进程早期加载的扩展集。切勿将已加载的扩展实例从父进程传给另一个会话;请使用 `preloadedExtensionPaths`,以便每个会话获得自己的 `ExtensionAPI` 绑定。

### 运行时工具集变更

`AgentSession` 支持运行时激活更新:

- `getActiveToolNames()`
- `getAllToolNames()`
- `setActiveToolsByName(names)`
- `refreshMCPTools(mcpTools)`

系统提示词会重建以反映活动工具的变化。

## 发现辅助函数

当你想在不重建内部发现逻辑的情况下获得部分控制时,请使用这些:

- `discoverAuthStorage(agentDir?)`
- `discoverExtensions(cwd?)`
- `discoverSkills(cwd?, _agentDir?, settings?)`
- `discoverContextFiles(cwd?, _agentDir?, disabledExtensions?)`
- `discoverPromptTemplates(cwd?, agentDir?)`
- `discoverSlashCommands(cwd?)`
- `discoverCustomTSCommands(cwd?, agentDir?)`
- `discoverMCPServers(cwd?)`
- `buildSystemPrompt(options?)`

## 面向子 Agent 的选项

对于构建编排器(类似于任务执行器流程)的 SDK 消费者:

- `outputSchema`:将结构化输出期望传入工具上下文
- `outputSchemaMode`:选择宽松或严格的结构化输出强制
- `requireYieldTool`:强制包含 `yield` 工具
- `taskDepth`:嵌套任务会话的递归深度上下文
- `parentTaskPrefix`:嵌套任务输出的产物命名前缀

对于常规的单 Agent 嵌入,这些是可选的。

## `createAgentSession()` 返回值

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: Array<{
    name: string;
    status: "connecting" | "ready" | "error" | "available";
    fileTypes: string[];
    error?: string;
  }>;
  eventBus: EventBus;
};
```

仅当你的嵌入方提供工具/扩展应调用的 UI 能力时,才使用 `setToolUIContext(...)`。

## 启动性能

`createAgentSession()` 运行两项后台优化,使 I/O 与会话设置的其他部分重叠:

- **模型主机预连接。** 一旦模型解析完成,SDK 就会发出尽力而为的 `fetch.preconnect(model.baseUrl)`,使到提供商主机的 DNS + TCP + TLS + HTTP/2 与扩展/技能加载、工具注册表构建和系统提示词组装并行进行。第一次真正的 `fetch(...)` 随后复用这条已预热连接,在跨洲跳转(例如住宅 IP → `api.anthropic.com`)上节省 100–300 毫秒。实现位于 `packages/coding-agent/src/sdk.ts` 的 `preconnectModelHost()` 中。如果 `fetch.preconnect` 不可用(非 Bun 运行时)或调用抛出异常,该优化会被静默跳过——绝不是硬性依赖。适用于每种模式(交互、print、RPC、ACP)。
- **条件式 LSP 预热。** 启动时 LSP 服务器(即 `discoverStartupLspServers(cwd)` 返回的那些)仅在**全部**满足以下条件时才预热:
  - 会话选项上的 `enableLsp !== false`,**并且**
  - `options.hasUI === true`(交互式 TUI),**并且**
  - `lsp.lazy` 设置被禁用(默认值为 `true`)。

  启用 `lsp.lazy`(默认)时,启动时完全不会启动任何语言服务器;每个服务器在首次使用时冷启动,即当 Agent 调用 `lsp` 工具,或 edit/write 触碰到扩展名与服务器 `fileTypes` 匹配的文件时。Print / script / RPC / ACP 调用(`hasUI=false`)无论该设置如何都会跳过预热:它们不渲染预热状态指示器,而且通常在语言服务器稳定之前就已完成,因此预热只会浪费 CPU,在 LLM 流消费者并发运行时解析大型 `initialize` 响应,并造成感知延迟抖动。实际需要 LSP 服务器的工具仍会通过 `getOrCreateClient()` 按需启动一个——只有_启动时_的预热被跳过。`CreateAgentSessionResult` 中返回的 `lspServers` 字段在惰性模式下仍会为 UI 会话填充——已识别的服务器会被发现(不启动任何进程)并以 `"available"` 状态报告,因此欢迎界面和 `/status` 可以列出它们;只有 `enableLsp === false` 或 `hasUI === false` 时它才是 `undefined`。

## 最小受控嵌入示例

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
  "compaction.enabled": true,
  "retry.enabled": true,
});

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  sessionManager: SessionManager.inMemory(),
  toolNames: ["read", "grep", "glob", "edit", "write"],
  enableMCP: false,
  enableLsp: true,
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Find all TODO comments in this repo and propose fixes.");
await session.dispose();
```
