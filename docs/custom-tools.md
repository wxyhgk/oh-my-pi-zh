# 自定义工具

自定义工具是可被模型调用的函数,它们插入与内置工具相同的工具执行流水线。

自定义工具是导出工厂函数的 TypeScript/JavaScript 模块。工厂接收主机 API(`CustomToolAPI`)并返回一个工具或一组工具。

## 这是什么(以及不是什么)

- **自定义工具**:模型在轮次期间可调用(`execute` + 参数 schema)。
- **扩展**:可以注册工具并拦截/修改事件的生命周期/事件框架。
- **钩子**:通过扩展运行器加载的遗留事件驱动拦截器 API。
- **技能**:静态指引/上下文包,不是可执行的工具代码。

如果需要模型直接调用代码,请使用自定义工具。

## 当前代码中的集成路径

有两种活动的集成风格:

1. **SDK 提供的自定义工具**(`options.customTools`)
   - 在不受限的 SDK 引导中,转换为扩展工具定义,通过生成的扩展注册,并始终包含在初始活动工具集中。
   - 在受限会话(`restrictToolNames: true`)中,SDK 提供的自定义工具被排除,除非 `allowRestrictedCustomTools: true`;选择加入的工具仅当名称也出现在 `toolNames` 中时才活动。

2. **通过加载器 API 从文件系统发现的模块**(`discoverAndLoadCustomTools` / `loadCustomTools`)
   - 作为库 API 暴露于 `packages/coding-agent/src/extensibility/custom-tools/loader.ts`。
   - 主机代码可以调用它从配置/提供商/插件路径发现并加载工具模块。

```text
Model tool call flow

LLM tool call
   │
   ▼
Tool registry (built-ins + registered custom definitions)
   │
   ▼
CustomTool.execute(toolCallId, params, onUpdate, ctx, signal)
   │
   ├─ onUpdate(...)  -> streamed partial result
   └─ return result  -> final tool content/details
```

## 发现位置(加载器 API)

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames)` 合并:

1. 能力提供商(`toolCapability`),包括:
   - 原生 OMP 配置(`~/.omp/agent/tools`、`.omp/tools`)
   - Claude 配置(`~/.claude/tools`、`.claude/tools`)
   - Codex 配置(`~/.codex/tools`、`.codex/tools`)
   - Claude marketplace 插件缓存提供商
2. 已安装插件清单(`~/.omp/plugins/node_modules/*`,通过插件加载器)
3. 传给加载器的显式配置路径

### 重要行为

- 重复的解析路径被去重。
- 工具名冲突对内置工具和已加载的自定义工具拒绝。
- 某些提供商把 `.md` 和 `.json` 文件发现为工具元数据,但可执行模块加载器拒绝把它们当作可运行工具。
- 相对配置路径从 `cwd` 解析;`~` 被展开。

## 模块契约

自定义工具模块必须导出一个函数(优先默认导出):

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.arktype({
    glob: "string?",
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec(
      "git",
      ["ls-files", params.glob ?? "**/*.ts"],
      { signal, cwd: pi.cwd },
    );
    if (result.killed) {
      throw new Error("Scan was cancelled");
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || "git ls-files failed");
    }

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // cleanup resources if needed
    }
  },
});

export default factory;
```

参数 schema 可以使用 ArkType(`pi.arktype`)、Zod(`pi.zod`)或遗留兼容的 TypeBox 垫片(`pi.typebox`);新工具优先使用 ArkType。Schema 流过共享的校验/线上流水线。

工厂返回类型:

- `CustomTool`
- `CustomTool[]`
- `Promise<CustomTool | CustomTool[]>`

## 传给工厂的 API 表面(`CustomToolAPI`)

来自 `types.ts` 和 `loader.ts`:

- `cwd`:主机工作目录
- `exec(command, args, options?)`:进程执行助手
- `ui`:UI 上下文(无头模式可为 no-op)
- `hasUI`:非交互流程中为 `false`
- `logger`:共享文件日志器
- `arktype`:注入的 ArkType 模块(新 schema 优先)
- `typebox`:遗留 TypeBox 风格 schema 的兼容垫片
- `zod`:注入的 `zod/v4` 模块
- `pi`:注入的 `@oh-my-pi/pi-coding-agent` 导出
- `pushPendingAction(action)`:暂存一个预览动作,通过向 `xd://resolve` 或 `xd://reject` 写入纯文本理由来定案

加载器以 no-op UI 上下文启动,并要求主机代码在真实 UI 就绪时调用 `setUIContext(...)`。如果运行时未提供待定动作存储,调用 `pushPendingAction` 会抛出 `Pending action store unavailable for custom tools in this runtime.`

## 执行契约与类型

`CustomTool.execute` 签名:

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params` 通过 `Static<TParams>` 从其 ArkType、Zod 或 TypeBox schema 静态类型化。
- 运行时参数校验在 Agent 循环中的执行前发生。
- `onUpdate` 为 UI 流式输出发出部分结果。
- `ctx` 包括 `sessionManager`、`modelRegistry`、当前 `model`、`isIdle()`、`hasQueuedMessages()`、`abort()`,以及可选的 `settings`、`fetch`、`localProtocolOptions` 和 `autoApprove`。
- `signal` 携带取消信号,可能为 `undefined`。

会话引导桥把自定义工具转换为扩展 `ToolDefinition`,并以正确的参数顺序转发调用。`CustomToolAdapter` 仍可供直接把自定义工具适配到 Agent 工具接口的库消费者使用。

工具定义还可以声明 `strict`、`hidden`、`loadMode`、`deferrable`、`mcpServerName`、`mcpToolName` 和 `approval`。省略 `loadMode` 时,自定义工具名默认为 `"discoverable"`,但规范的内置核心名(`read`、`write`、`bash`、`edit`、`glob`、`computer`、`eval`、`task`、`hub`、`learn` 和 `manage_skill`)除外,它们默认为 `"essential"`,以免包装或重新注册降级它们。显式 `loadMode` 始终胜出;用 `"essential"` 让任何其他工具保持顶层。虽然公开的 `CustomTool` 类型也声明了 `formatApprovalDetails`,但 SDK/发现桥不会把该回调转发到注册的工具定义中,因此在常规集成路径上它无法定制批准细节。

## 工具如何暴露给模型

- 会话引导把包含的 SDK 提供和发现的自定义工具包装为扩展工具定义;库消费者可以改用 `CustomToolAdapter`。
- 它们按名称插入会话工具注册表。
- 在不受限的 SDK 引导中,自定义和扩展注册的工具被强制包含在初始活动集中。受限会话排除 SDK 提供的自定义工具,除非 `allowRestrictedCustomTools: true`,并且仅当选择加入的自定义工具名称出现在 `toolNames` 中时才暴露。
- CLI `--tools` 目前只校验内置工具名;自定义工具包含通过发现/注册路径和 SDK 选项处理。

## 渲染钩子

可选渲染钩子:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme)`

常规 SDK 和文件系统发现路径把自定义工具包装为扩展。在这些路径上,`renderResult` 只接收上述三个参数;桥不转发原始工具参数。公开的 `CustomTool` 类型为直接 `CustomToolAdapter` 消费者保留可选第四个 `args` 参数。

TUI 中的运行时行为:

- 若存在钩子,工具输出在 `Box` 容器内渲染。
- `renderResult` 接收 `{ expanded, isPartial, spinnerFrame? }` 作为其 `options` 参数。
- 渲染器错误被捕获并记录;UI 回退到默认文本渲染。

## 会话/状态处理

可选 `onSession(event, ctx)` 接收会话生命周期事件,包括:

- `start`、`switch`、`branch`、`tree`、`shutdown`
- `auto_compaction_start`、`auto_compaction_end`
- `auto_retry_start`、`auto_retry_end`
- `ttsr_triggered`、`todo_reminder`

当分支/会话上下文变化时,用 `ctx.sessionManager` 从历史重建状态。

## 失败与取消语义

### 同步/异步失败

- 在 `execute` 中抛出(或被拒绝的 promise)视为工具失败。
- Agent 运行时把失败转换为带 `isError: true` 和错误文本内容的工具结果消息。
- 使用扩展包装时,`tool_result` 处理器可以进一步改写内容/细节,甚至覆盖错误状态。

### 取消

- Agent 中止通过 `AbortSignal` 传播到 `execute`。
- 把 `signal` 转发给子进程工作(`pi.exec(..., { signal })`)以实现协作取消。
- `ctx.abort()` 让工具请求中止当前 Agent 操作。

### onSession 错误

- `onSession` 错误被捕获并作为警告记录;它们不会使会话崩溃。

## 设计时要考虑的真实约束

- 工具名必须在活动注册表中全局唯一。
- 优先在 `details` 中产出确定性、schema 形状的输出,用于渲染器/状态重建。
- 用 `pi.hasUI` 守卫 UI 使用。
- 把工具目录中的 `.md`/`.json` 视为元数据,而非可执行模块。
