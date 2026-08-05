---
name: authoring-extensions
description: 创建新的 omp 扩展时使用。涵盖 ExtensionAPI、工厂签名、工具/命令/事件注册以及本地开发测试。
---

# 编写扩展

扩展是为 `oh-my-pi` 添加能力的主要方式。单个扩展模块即可注册 LLM 可调用的工具、用户可调用的斜杠命令,以及在整个会话生命周期中运行的事件处理器——全部来自一个 TypeScript 文件。其默认工厂可以同步初始化,也可以返回 promise。

## 最小可用扩展

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

这就是一个可用的扩展。把它放到 `~/.omp/agent/extensions/hello.ts`,然后重启 omp 即可看到通知。

## 完整示例

下面的扩展注册了一个斜杠命令、一个工具和一个会话启动钩子:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  // Runs once when the session loads
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
  });

  // Slash command: /greet
  pi.registerCommand("greet", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      pi.sendMessage(
        {
          customType: "greeting",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify(`Greeted ${name}`, "info");
    },
  });

  // LLM-callable tool
  pi.registerTool({
    name: "word_count",
    label: "Word Count",
    description: "Count the words in a string",
    parameters: z.object({
      text: z.string().describe("Text to count"),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
```

## 发现路径

omp 从以下来源加载扩展模块:

1. 通过能力系统发现的原生 `.omp` 位置:
   - `<cwd>/.omp/extensions/`
   - `~/.omp/agent/extensions/`
   - 列在 `.omp/settings.json#extensions` 或 `~/.omp/agent/settings.json#extensions` 中的旧版扩展路径
2. 位于 `~/.omp/plugins/node_modules` 或项目插件根目录下的已启用已安装插件——包括 npm、市场以及 `omp plugin link` 安装的插件——通过它们的 `omp.extensions`/`pi.extensions` 清单。
3. CLI 传入的显式配置路径(`omp --extension ./my-ext.ts`,也支持 `-e`;`--hook` 视为其别名)以及配置中的 `extensions:` 设置。

运行时按解析后的绝对路径去重——先出现的优先。

用户目录是当前 profile 的 agent 目录:默认为 `~/.omp/agent`,而 `omp --profile <name>` 使用 `~/.omp/profiles/<name>/agent`(`PI_CODING_AGENT_DIR` 可覆盖它)。

当路径指向目录时,omp 按以下顺序解析入口点:

1. `package.json` 中的 `omp.extensions`(或旧版 `pi.extensions`)字段
2. `index.ts`
3. `index.js`

扫描 `extensions/` 目录时,omp 还会加载直接的 `*.ts`/`*.js` 文件,以及包含 `index.ts`、`index.js` 或清单的一级子目录。

扩展包还可以捆绑同级的能力目录。当包通过 `extensions:` 或 `--extension`/`-e` 加载时,`omp-plugins` 提供商会发现其 `skills/`、`hooks/pre|post/`、`tools/`、`commands/`、`rules/`、`prompts/` 和 `.mcp.json`。

## package.json 清单

要将扩展打包为可安装的插件,请在 `package.json` 中添加 `omp` 字段:

```json
{
  "name": "my-omp-extension",
  "omp": {
    "extensions": ["./src/main.ts"]
  }
}
```

为向后兼容,也接受旧版 `pi` 键:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

支持多个入口点:

```json
{
  "omp": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

已安装插件的清单条目可以是 `.ts`、`.js`、`.mjs` 或 `.cjs`;指向目录的清单条目会解析 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`。对原生/配置的扩展目录的自动扫描仍仅限于 `.ts` 和 `.js`。

## 注册命令

```ts
pi.registerCommand("my-cmd", {
  description: "What the command does",
  handler: async (args, ctx) => {
    // args: everything the user typed after /my-cmd
    // ctx: ExtensionCommandContext — includes ctx.ui, ctx.cwd, session controls
    ctx.ui.notify("Running!", "info");
    await ctx.waitForIdle();
    await ctx.newSession();
  },
});
```

`ExtensionCommandContext` 的会话控制方法(仅可从命令中安全调用):

| 方法 | 作用 |
|---|---|
| `waitForIdle()` | 等待 Agent 完成流式输出 |
| `newSession(opts?)` | 打开一个新会话 |
| `switchSession(path)` | 切换到现有的会话文件 |
| `branch(entryId)` | 从特定的历史条目分叉 |
| `navigateTree(id, opts?)` | 跳转到会话树中的另一个位置 |
| `reload()` | 重新加载会话运行时 |
| `compact(opts?)` | 压缩当前上下文 |

## 注册工具

工具由 LLM 调用。参数定义接受 ArkType 或 Zod 模式;`pi.typebox` 仍可作为旧版 TypeBox 风格扩展的兼容垫片使用。以下示例使用注入的 `zod/v4` 模块:

```ts
const z = pi.zod;

pi.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().default(10).describe("Max results").optional(),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }] });
    // ... do work ...
    return {
      content: [{ type: "text", text: `Found N results for "${params.query}"` }],
      details: { query: params.query, count: 0 },
    };
  },
});
```

工具定义还可以设置 `loadMode: "essential" | "discoverable"`(默认为 `"discoverable"`)、`approval: "read" | "write" | "exec"`(默认为 `"exec"`)以及用于提供商结构化输出语法行为的 `strict`。

## 订阅事件

```ts
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.input, event.toolCallId
  if (event.toolName !== "bash") return;

  const command = String((event.input as { command?: unknown }).command ?? "");
  if (command.includes("rm -rf /")) {
    return { block: true, reason: "Blocked by safety policy" };
  }
});

pi.on("turn_end", async (_event, ctx) => {
  ctx.ui.setStatus("tokens", `~${ctx.getContextUsage()?.tokens ?? "?"} tokens`);
});

pi.on("session_stop", async (event) => {
  if (event.stop_hook_active) return;
  return { continue: true, additionalContext: `Review final status after turn ${event.turn_id}.` };
});
```

完整事件目录:参见[扩展编写指南](../extensions.md)。

## 扩展与钩子——何时使用哪种

| 需求 | 使用 |
|---|---|
| 在单个模块中同时提供工具、命令和事件 | **扩展**(`ExtensionAPI`) |
| 纯事件拦截(策略、脱敏) | **扩展**或**钩子**(两者都可用;优先使用扩展) |
| 已有旧版钩子模块 | **钩子**(来自 `@oh-my-pi/pi-coding-agent/extensibility/hooks` 的 `HookAPI`) |
| 注册提供商、快捷键或 CLI 标志 | **仅限扩展** |
| 作为市场插件发布 | **扩展**(使用 `package.json` 清单) |

扩展是钩子的严格超集。新编写时应使用 `ExtensionAPI`。

## 调试

omp 将结构化日志写入当前状态根目录下的 `logs/` 目录(默认为 `~/.omp/logs/`;debug 级别始终开启,且不会向控制台写入任何内容,因为那会破坏 TUI)。每个文件名都包含进程 ID。跟踪今天默认 profile 的日志可查看扩展加载诊断信息:

```
tail -f ~/.omp/logs/omp.$(date +%F).*.log
```

加载失败的扩展会连同其路径和错误一起记录。已加载的扩展也可以通过 `pi.logger` 输出自己的调试日志。

要按名称临时禁用某个扩展模块而无需删除文件:

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

派生名称是文件名主干(对于 `index.ts` 风格的条目则是目录名):`/path/to/my-ext.ts` → `my-ext`。

## 重要约束

- **加载期间不要调用运行时操作。** 如果在模块求值期间(会话激活之前)同步调用 `pi.sendMessage()` 等方法,会抛出 `ExtensionRuntimeNotInitializedError`。在加载期间注册处理器/工具/命令;只从事件处理器、工具或命令中执行运行时操作。
- **`tool_call` 错误是默认阻断的。** 如果 `tool_call` 处理器抛出异常,该工具将被阻止执行。
- **自行调度的回调在进程内运行,没有隔离。** 原始 `setInterval`/`setTimeout`/分离 promise 回调若抛出异常,会逃过处理器分发的 try/catch 并使整个会话崩溃(`uncaughtException`)。后台工作请使用 `ctx.setInterval` / `ctx.setTimeout`——它们会捕获回调中的异常,并在 `session_shutdown` 时自动清理。使用原始定时器时,你必须自己添加 `try/catch` 和清理逻辑。
- **命令名不得与内置命令冲突。** 冲突的命令会被跳过,并记录一条诊断日志。
- **保留快捷键会被忽略**(`ctrl+c`、`ctrl+d`、`ctrl+z`、`ctrl+k`、`ctrl+p`、`ctrl+l`、`ctrl+o`、`ctrl+t`、`ctrl+g`、`ctrl+q`、`alt+m`、`shift+tab`、`shift+ctrl+p`、`alt+enter`、`escape`、`enter`)。

## 延伸阅读

- `docs/extensions.md` — 运行时内部机制与完整 API 参考
- `docs/extension-loading.md` — 详细的路径解析规则
- `docs/hooks.md` — 钩子子系统内部机制
- `docs/skills/examples/hello-extension/` — 完整可运行的示例
