# 钩子

本文档描述 `packages/coding-agent/src/extensibility/hooks/*` 中的**当前钩子子系统代码**。

## 运行时中的当前状态

默认 CLI 运行时初始化**扩展运行器**路径。在当前启动流程中:

- `--hook` 被视为 `--extension` 的别名(CLI 路径被合并到 `additionalExtensionPaths`)
- 通过 `hookCapability` 发现的 JS/TS 钩子工厂(例如 `.omp/hooks/pre/*.ts`)作为扩展模块加载,因此它们的 `pi.on(...)` 处理器绑定到运行时事件总线
- 工具由 `ExtensionToolWrapper` 包装,而不是 `HookToolWrapper`
- 上下文转换和生命周期事件通过 `ExtensionRunner` 发出

因此,本文档记录的是旧式钩子子系统实现本身(类型/加载器/运行器/包装器),以及当扩展运行器加载已发现的钩子路径时仍接受的工厂形状。

## 关键文件

- `packages/coding-agent/src/extensibility/hooks/types.ts` — 钩子上下文、事件类型和结果契约
- `packages/coding-agent/src/extensibility/hooks/loader.ts` — 模块加载和钩子发现桥接
- `packages/coding-agent/src/extensibility/hooks/runner.ts` — 事件分发、命令查找、错误信号
- `packages/coding-agent/src/extensibility/hooks/tool-wrapper.ts` — 前/后工具拦截包装器
- `packages/coding-agent/src/extensibility/hooks/index.ts` — 导出/再导出

## 钩子模块是什么

钩子模块必须默认导出一个工厂:

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      String(event.input.command ?? "").includes("rm -rf")
    ) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

工厂可以:

- 用 `pi.on(...)` 注册事件处理器
- 用 `pi.sendMessage(...)` 发送持久化的自定义消息
- 用 `pi.appendEntry(...)` 持久化非 LLM 状态
- 通过 `pi.registerCommand(...)` 注册斜杠命令
- 通过 `pi.registerMessageRenderer(...)` 注册自定义消息渲染器
- 通过 `pi.exec(...)` 运行 shell 命令,并通过 `pi.logger` 记录日志
- 使用注入的 `pi.zod`、旧式兼容的 `pi.typebox` 以及通过 `pi.pi` 的包导出;`pi.arktype` 是 ArkType `Type` 运行时,不是 `type(...)` schema 构建器

## 发现与加载

默认会话通过扩展运行器加载由 `hookCapability` 发现的 JS/TS 钩子工厂。`discoverExtensionPaths(configuredPaths, cwd)` 执行:

1. 从能力注册表加载原生扩展模块
2. 从钩子能力注册表加载可导入的 `.ts`/`.js` 钩子工厂
3. 追加插件扩展入口点
4. 追加显式配置的路径

旧式 `discoverAndLoadHooks(configuredPaths, cwd)` 辅助函数仍然存在,执行:

1. 从能力注册表加载发现的钩子(`loadCapability("hooks")`)
2. 追加显式配置的路径(按绝对路径去重)
3. 调用 `loadHooks(allPaths, cwd)`

`loadHooks` 随后导入每个路径,并期望一个 `default` 函数。

### 路径解析

`loader.ts` 将钩子路径解析为:

- 绝对路径:按原样使用
- `~` 路径:展开
- 相对路径:相对 `cwd` 解析

## 事件表面

钩子事件在 `types.ts` 中强类型化。

### 会话事件

- `session_start`
- `session_before_switch` → 可以返回 `{ cancel?: boolean }`
- `session_switch`
- `session_before_branch` → 可以返回 `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_branch`
- `session_before_compact` → 可以返回 `{ cancel?: boolean; compaction?: CompactionResult }`
- `session.compacting` → 可以返回 `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`
- `session_compact`
- `session_before_tree` → 可以返回 `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`
- `session_tree`
- `session_shutdown`

### Agent/上下文事件

- `context` → 可以返回 `{ messages?: Message[] }`
- `before_agent_start` → 可以返回 `{ message?: { customType; content; display; details; attribution } }`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `auto_compaction_start`
- `auto_compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

### 工具事件(模型前/后)

- `tool_call`(执行前)→ 可以返回 `{ block?: boolean; reason?: string; input?: Record<string, unknown> }`。返回 `input` 的非阻止处理器会替换工具执行的参数(原始执行输入,而非规范化的 `event.input` 视图);当 `block` 为 true 时被忽略,且不适用于 `computer` 工具调用。
- `tool_result`(执行后)→ 可以返回 `{ content?; details?; isError? }`

这是钩子子系统的核心前/后拦截模型。

```text
Hook tool interception flow

tool_call handlers
   │
   ├─ any { block: true }? ── yes ──> throw (tool blocked)
   │
   └─ no
      │
      ▼
   execute underlying tool
      │
      ├─ success ──> tool_result handlers can override { content, details }
      │
      └─ error   ──> emit tool_result(isError=true) then rethrow original error
```

## 执行模型与变更语义

### 1) 执行前:`tool_call`

`HookToolWrapper.execute()` 在工具执行前发出 `tool_call`。

- 如果任何处理器返回 `{ block: true }`,执行停止
- 如果处理器抛出异常,包装器失败关闭并阻止执行
- 返回的 `reason` 成为抛出的错误文本

### 2) 工具执行

如果未被阻止,底层工具正常执行。

### 3) 执行后:`tool_result`

成功之后,包装器发出带有以下内容的 `tool_result`:

- `toolName`, `toolCallId`, `input`
- `content`
- `details`
- `isError: false`

如果处理器返回覆盖:

- `content` 可以替换结果内容
- `details` 可以替换结果细节

工具失败时,包装器发出 `isError: true` 且内容为错误文本的 `tool_result`,然后重新抛出原始错误。

### 钩子可以变更什么

- 通过 `context`(`messages` 替换链)变更单次调用的 LLM 上下文
- 通过从 `tool_call` 返回 `input` 变更原始工具执行参数(除了 `computer` 调用)
- 在成功的工具调用上变更工具输出内容/细节(`tool_result` 路径)
- 通过 `before_agent_start` 注入 Agent 前消息
- 通过 `session_before_*` 和 `session.compacting` 实现取消/自定义压缩/树行为

### 此实现中钩子不能变更什么

- `computer` 工具调用的原始参数
- 工具错误抛出后的执行继续(错误路径重新抛出)
- 包装器行为中的最终成功/错误状态(返回的 `isError` 有类型,但 `HookToolWrapper` 不应用它)

## 排序与冲突行为

### 发现级排序

能力提供商按优先级排序(高者在前)。按能力键去重,先见者胜。

对于 `hooks`,能力键是 `${type}:${tool}:${name}`。来自较低优先级提供商的被遮蔽重复项会被标记,并从有效的发现列表中排除。

### 加载顺序

`discoverAndLoadHooks` 构建扁平的 `allPaths` 列表,按解析后的绝对路径去重,然后 `loadHooks` 按该顺序迭代。
每个已发现目录内的文件顺序取决于 `readdir` 输出;钩子加载器不执行额外排序。

### 运行时处理器顺序

在 `HookRunner` 内部,顺序由注册序列确定:

1. 钩子数组顺序
2. 每个钩子/事件的处理器注册顺序

按事件类型的冲突行为:

- `tool_call`:最后一个返回的结果胜出,除非处理器阻止;第一个阻止会短路。返回的 `input`(执行参数覆盖)遵循相同的最后胜出规则;处理器看不到彼此的修订
- `tool_result`:最后一个返回的覆盖胜出(不短路)
- `context`:链式;每个处理器收到前一个处理器的消息输出
- `before_agent_start`:保留第一个返回的消息;后续消息被忽略
- `session_before_*`:跟踪最新的返回结果;`cancel: true` 立即短路
- `session.compacting`:最新的返回结果胜出

命令/渲染器冲突:

- `getCommand(name)` 跨钩子返回第一个匹配(先加载者胜出)
- `getMessageRenderer(customType)` 返回第一个匹配
- `getRegisteredCommands()` 返回所有命令(不去重)

## UI 交互(`HookContext.ui`)

`HookUIContext` 包含:

- `select`, `confirm`, `input`, `editor`
- `notify`
- `setStatus`
- `custom`
- `setEditorText`, `getEditorText`
- `theme` 获取器

`ctx` 包含 `hasUI`、`cwd`、`sessionManager`、`modelRegistry`、当前 `model`、`isIdle()`、`abort()` 和 `hasQueuedMessages()`。

在没有 UI 的情况下运行时,默认的 no-op 上下文行为是:

- `select/input/editor` 返回 `undefined`
- `confirm` 返回 `false`
- `notify`, `setStatus`, `setEditorText` 是 no-op
- `getEditorText` 返回 `""`

### 状态行行为

通过 `ctx.ui.setStatus(key, text)` 设置的钩子状态文本:

- 按 key 存储
- 按 key 名称排序
- 经过消毒(剥离 ANSI/VT 转义序列;控制字符映射为空格;连续空格折叠;修剪)
- 拼接并截断宽度后显示

## 错误传播与回退

### 加载时

- 无效模块或缺少默认导出 → 捕获在 `LoadHooksResult.errors` 中
- 其他钩子的加载继续

### 事件时

`HookRunner.emit(...)` 捕获大多数事件的处理器错误,向监听器发出 `HookError`(`hookPath`, `event`, `error`),然后继续。

`emitToolCall(...)` 更严格:那里的处理器错误不会被吞掉;它们会传播给调用方。在 `HookToolWrapper` 中,这会阻止工具调用(故障安全)。

## 实际的 API 示例

### 阻止不安全的 bash 命令

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    if (!cmd.includes("rm -rf")) return;

    if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
    const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
    if (!ok) return { block: true, reason: "user denied command" };
  });
}
```

### 执行后对工具输出脱敏

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;

    const redacted = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replaceAll(/API_KEY=\S+/g, "API_KEY=[REDACTED]"),
      };
    });

    return { content: redacted };
  });
}
```

### 每次 LLM 调用修改模型上下文

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (msg) => !(msg.role === "custom" && msg.customType === "debug-only"),
    );
    return { messages: filtered };
  });
}
```

### 用命令安全的上下文方法注册斜杠命令

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a new session with setup message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [
              { type: "text", text: "Continue from prior session summary." },
            ],
            timestamp: Date.now(),
          });
        },
      });
    },
  });
}
```

## 导出表面

`packages/coding-agent/src/extensibility/hooks/index.ts` 和包子路径 `@oh-my-pi/pi-coding-agent/extensibility/hooks` 导出:

- 加载 API(`discoverAndLoadHooks`, `loadHooks`)
- 运行器和包装器(`HookRunner`, `HookToolWrapper`)
- 所有钩子类型
- `execCommand` 再导出

包根(`@oh-my-pi/pi-coding-agent`)不再导出 `HookAPI`;从 hooks 子路径导入旧式钩子类型。
