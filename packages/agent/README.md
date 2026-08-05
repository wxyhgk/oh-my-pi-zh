# @oh-my-pi/pi-agent

带工具执行与事件流的有状态 Agent。构建于 `@oh-my-pi/pi-ai` 之上。

## 安装

```bash
npm install @oh-my-pi/pi-agent
```

## 快速开始

```typescript
import { Agent } from "@oh-my-pi/pi-agent";
import { getModel } from "@oh-my-pi/pi-ai";

const agent = new Agent({
	initialState: {
		systemPrompt: ["You are a helpful assistant."],
		model: getModel("anthropic", "claude-sonnet-4-20250514"),
	},
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		// Stream just the new text chunk
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await agent.prompt("Hello!");
```

## 核心概念

### AgentMessage 与 LLM Message

Agent 使用 `AgentMessage`,一个灵活的、可包含以下内容的类型:

- 标准 LLM 消息(`user`、`assistant`、`toolResult`)
- 通过声明合并得到的自定义应用专属消息类型

LLM 只理解 `user`、`assistant` 与 `toolResult`。`convertToLlm` 函数通过在每次 LLM 调用前筛选并变换消息来弥合这一差距。

### 消息流

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (可选)                           (必需)
```

1. **transformContext**:修剪旧消息、注入外部上下文
2. **convertToLlm**:过滤仅 UI 消息,把自定义类型转换为 LLM 格式

## 事件流

Agent 为 UI 更新发出事件。理解事件序列有助于构建响应式界面。

### prompt() 事件序列

当你调用 `prompt("Hello")` 时:

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // 你的提示词
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM 开始响应
├─ message_update  { message: partial... }       // 流式块
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // 完整响应
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 带工具调用

如果 assistant 调用工具,循环继续:

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // 如果工具流式输出
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // 下一轮
├─ message_start      { assistantMessage }           // LLM 响应工具结果
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

### continue() 事件序列

`continue()` 从现有上下文恢复,不添加新消息。用于出错后的重试。

```typescript
// 出错后,从当前状态重试
await agent.continue();
```

上下文中的最后一条消息必须是 `user` 或 `toolResult`(不能是 `assistant`)。

### 事件类型

| 事件                   | 说明                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `agent_start`           | Agent 开始处理                                          |
| `agent_end`             | Agent 完成,携带所有新消息                           |
| `turn_start`            | 新一轮开始(一次 LLM 调用 + 工具执行)                |
| `turn_end`              | 一轮完成,携带 assistant 消息与工具结果          |
| `message_start`         | 任意消息开始(user、assistant、toolResult)                |
| `message_update`        | **仅 assistant。**包含带 delta 的 `assistantMessageEvent` |
| `message_end`           | 消息完成                                               |
| `tool_execution_start`  | 工具开始                                                     |
| `tool_execution_update` | 工具流式输出进度                                           |
| `tool_execution_end`    | 工具完成                                                  |

## Agent 选项

```typescript
const agent = new Agent({
  // 初始状态
  initialState: {
    systemPrompt: string[],
    model: Model,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // 把 AgentMessage[] 转换为 LLM Message[](自定义消息类型时必需)
  convertToLlm: (messages) => messages.filter(...),

  // 在 convertToLlm 之前变换上下文(用于修剪、压缩)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // 如何处理排队消息:"one-at-a-time"(默认)或 "all"
  queueMode: "one-at-a-time",

  // 自定义流函数(用于代理后端)
  streamFn: streamProxy,

  // 动态的模型作用域 API 密钥解析(用于过期 OAuth token)
  getApiKey: async (model) => tokenForModel(model),

  // 工具执行上下文(延迟绑定的 UI/会话访问)
  getToolContext: () => ({ /* app-defined */ }),
});
```

## Agent 状态

```typescript
interface AgentState {
	systemPrompt: string[];
	model: Model;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamMessage: AgentMessage | null; // Current partial during streaming
	pendingToolCalls: Set<string>;
	error?: string;
}
```

通过 `agent.state` 访问。流式期间,`streamMessage` 包含部分 assistant 消息。

## 方法

### 提示

```typescript
// 文本提示词
await agent.prompt("Hello");

// 带图像
await agent.prompt("What's in this image?", [{ type: "image", data: base64Data, mimeType: "image/jpeg" }]);

// 直接 AgentMessage
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// 从当前上下文继续(最后一条消息必须是 user 或 toolResult)
await agent.continue();
```

### 状态管理

```typescript
agent.setSystemPrompt("New prompt");
agent.setModel(getModel("openai", "gpt-4o"));
agent.setThinkingLevel("medium");
agent.setTools([myTool]);
agent.replaceMessages(newMessages);
agent.appendMessage(message);
agent.clearMessages();
agent.reset(); // 清空一切
```

### 控制

```typescript
agent.abort(); // 取消当前操作
await agent.waitForIdle(); // 等待完成
```

### 事件

```typescript
const unsubscribe = agent.subscribe((event) => {
	console.log(event.type);
});
unsubscribe();
```

## 引导与跟进

在工具执行期间注入排队消息(引导),或在 Agent 本会停止之后注入(跟进):

```typescript
agent.setSteeringMode("one-at-a-time");
agent.setInterruptMode("immediate");

// 当 Agent 正在运行工具时
agent.steer({
	role: "user",
	content: "Stop! Do this instead.",
	timestamp: Date.now(),
});

// 排入一条跟进消息,在当前轮完成后运行
agent.followUp({
	role: "user",
	content: "After that, summarize the changes.",
	timestamp: Date.now(),
});
```

默认在每次工具调用后检查引导消息。把 `interruptMode` 设为 `"wait"` 可把引导推迟到当前轮完成。

## 自定义消息类型

通过声明合并扩展 `AgentMessage`:

```typescript
declare module "@oh-my-pi/pi-agent" {
	interface CustomAgentMessages {
		notification: { role: "notification"; text: string; timestamp: number };
	}
}

// 现在合法
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型:

```typescript
const agent = new Agent({
	convertToLlm: (messages) =>
		messages.flatMap((m) => {
			if (m.role === "notification") return []; // Filter out
			return [m];
		}),
});
```

## 工具

使用带 Zod 参数 schema 的 `AgentTool` 定义工具(通过 `@oh-my-pi/pi-ai` 的 `z`)。

```typescript
import { z } from "@oh-my-pi/pi-ai";

const readFileTool: AgentTool = {
	name: "read_file",
	label: "Read File", // For UI display
	description: "Read a file's contents",
	parameters: z.object({
		path: z.string().describe("File path"),
	}),
	execute: async (toolCallId, params, signal, onUpdate, context) => {
		const content = await fs.readFile(params.path, "utf-8");

		// Optional: stream progress
		onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

		return {
			content: [{ type: "text", text: content }],
			details: { path: params.path, size: content.length },
		};
	},
};

agent.setTools([readFileTool]);
```

### 错误处理

工具失败时**抛出错误**。不要把错误消息作为 content 返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
	if (!fs.existsSync(params.path)) {
		throw new Error(`File not found: ${params.path}`);
	}
	// Return content only on success
	return { content: [{ type: "text", text: "..." }] };
};
```

抛出的错误会被 Agent 捕获,并以 `isError: true` 作为工具错误报告给 LLM。

## 代理用法

面向通过后端代理的浏览器应用:

```typescript
import { Agent, streamProxy } from "@oh-my-pi/pi-agent";

const agent = new Agent({
	streamFn: (model, context, options) =>
		streamProxy(model, context, {
			...options,
			authToken: "...",
			proxyUrl: "https://your-server.com",
		}),
});
```

## 底层 API

不需要 Agent 类时的直接控制:

```typescript
import { agentLoop, agentLoopContinue } from "@oh-my-pi/pi-agent";

const context: AgentContext = {
	systemPrompt: ["You are helpful."],
	messages: [],
	tools: [],
};

const config: AgentLoopConfig = {
	model: getModel("openai", "gpt-4o"),
	convertToLlm: (msgs) => msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)),
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

for await (const event of agentLoop([userMessage], context, config)) {
	console.log(event.type);
}

// 从现有上下文继续
for await (const event of agentLoopContinue(context, config)) {
	console.log(event.type);
}
```

## 运行级遥测

每次 `invoke_agent` 在 OTEL span 之外还会产出两个值:

- **`AgentRunSummary`** — 按状态分桶的 chat / tool / usage / cost / error 计数器,带按工具名的细分。纯聚合,可安全持久化、做 diff 或断言。
- **`AgentRunCoverage`** — 排序+去重后的 `toolsAvailable` / `toolsInvoked` / `toolsUnused` / `modelsUsed` / `providersUsed` 数组。对快照测试稳定。

三种投递通道(任选合适的):

### `agent_end` 事件(增量式)

```typescript
for await (const event of agentLoop([userMessage], context, {
	...config,
	telemetry: {},
})) {
	if (event.type === "agent_end" && event.telemetry) {
		console.log("tokens:", event.telemetry.usage.totalTokens);
		console.log("unused tools:", event.coverage?.toolsUnused);
	}
}
```

`messages` 字段不变。忽略 `telemetry`/`coverage` 的消费者继续正常工作。

### `onRunEnd` 钩子(非致命)

```typescript
const stream = agentLoop([userMessage], context, {
	...config,
	telemetry: {
		onRunEnd: (summary, coverage) => {
			await persistRunSummary(summary, coverage);
		},
	},
});
```

从 `onRunEnd` 抛出的异常会被捕获并通过 `console.warn` 记录;一个行为异常的遥测消费者**永远不可能**把一次成功的 Agent 运行变成失败的。

### `agentLoopDetailed`(带类型的 `detailed()` 结果)

便捷包装,保留现有流 API,并把汇总暴露为带类型的值:

```typescript
const { stream, detailed } = agentLoopDetailed([userMessage], context, {
	...config,
	telemetry: {}, // 填充 telemetry/coverage 所需
});

for await (const event of stream) {
	// 现有事件处理
}

const { messages, telemetry, coverage } = await detailed();
```

`stream.result()` 仍解析为 `AgentMessage[]`——无破坏性变更。

### 多运行聚合

多次驱动循环的调用方(验证阶段、基准测试 harness)用 `aggregateAgentRunSummaries` / `aggregateAgentRunCoverage` 折叠 N 份摘要:

```typescript
import {
	aggregateAgentRunSummaries,
	aggregateAgentRunCoverage,
} from "@oh-my-pi/pi-agent";

const summaries: AgentRunSummary[] = [];
const coverages: AgentRunCoverage[] = [];
for (const target of targets) {
	const { detailed } = agentLoopDetailed(/* ... */);
	const result = await detailed();
	if (result.telemetry) summaries.push(result.telemetry);
	if (result.coverage) coverages.push(result.coverage);
}
const runSummary = aggregateAgentRunSummaries(summaries);
const runCoverage = aggregateAgentRunCoverage(coverages);
```

### 工具状态上报

`execute_tool` span 携带 `pi.gen_ai.tool.status` ∈ `"ok" | "error" | "skipped" | "blocked" | "timeout" | "aborted"`。`beforeToolCall` 块内部抛出可区分的 `ToolCallBlockedError`;捕获路径报告 `status: "blocked"`,而不是与一般工具错误混淆。运行前中断与尾部清扫跳过记录为 `"skipped"`,尽管它们从不启动 span。

## 许可证

MIT
