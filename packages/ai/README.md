# @oh-my-pi/pi-ai

统一 LLM API,带自动模型发现、提供商配置、token 与费用追踪,以及简单的上下文持久化与会话中途交接给其它模型。

**注意**:本库只包含支持工具调用(函数调用)的模型,因为这对 Agent 工作流至关重要。

## 目录

- [支持的提供商](#supported-providers)
- [安装](#installation)
- [快速开始](#quick-start)
- [工具](#tools)
  - [定义工具](#defining-tools)
  - [处理工具调用](#handling-tool-calls)
  - [用部分 JSON 流式输出工具调用](#streaming-tool-calls-with-partial-json)
  - [校验工具参数](#validating-tool-arguments)
  - [完整事件参考](#complete-event-reference)
- [图像输入](#image-input)
- [思考/推理](#thinkingreasoning)
  - [统一接口](#unified-interface-streamsimplecompletesimple)
  - [提供商专属选项](#provider-specific-options-streamcomplete)
  - [流式输出思考内容](#streaming-thinking-content)
- [停止原因](#stop-reasons)
- [错误处理](#error-handling)
  - [中止请求](#aborting-requests)
  - [中止后继续](#continuing-after-abort)
- [API、模型与提供商](#apis-models-and-providers)
  - [提供商与模型](#providers-and-models)
  - [查询提供商与模型](#querying-providers-and-models)
  - [自定义模型](#custom-models)
  - [OpenAI 兼容设置](#openai-compatibility-settings)
  - [类型安全](#type-safety)
- [跨提供商交接](#cross-provider-handoffs)
- [上下文序列化](#context-serialization)
- [浏览器用法](#browser-usage)
  - [环境变量(仅限 Node.js)](#environment-variables-nodejs-only)
  - [检查环境变量](#checking-environment-variables)
- [OAuth 提供商](#oauth-providers)
  - [Vertex AI (ADC)](#vertex-ai-adc)
  - [CLI 登录](#cli-login)
  - [编程式 OAuth](#programmatic-oauth)
  - [登录流程示例](#login-flow-example)
  - [使用 OAuth token](#using-oauth-tokens)
  - [提供商说明](#provider-notes)
- [许可证](#license)

## 支持的提供商

- **OpenAI**
- **OpenAI Codex**(ChatGPT Plus/Pro 订阅,需要 OAuth,见下文)
- **Anthropic**
- **Google**
- **Vertex AI**(通过 Vertex AI 使用 Gemini)
- **Mistral**
- **Groq**
- **Cerebras**
- **Together**
- **Moonshot**(需要 `MOONSHOT_API_KEY`)
- **Qianfan**(需要 `QIANFAN_API_KEY`)
- **NVIDIA**(需要 `NVIDIA_API_KEY`)
- **NanoGPT**(需要 `NANO_GPT_API_KEY`)
- **Novita**(需要 `NOVITA_API_KEY`)
- **Hugging Face Inference**
- **xAI**
- **Venice**(需要 `VENICE_API_KEY`)
- **Wafer Serverless**(需要 `WAFER_SERVERLESS_API_KEY`;按量付费)
- **OpenRouter**
- **Kilo Gateway**(支持 OAuth `/login kilo` 或 `KILO_API_KEY`)
- **LiteLLM**(需要 `LITELLM_API_KEY`)
- **zAI**(需要 `ZAI_API_KEY`)
- **Umans AI Coding Plan**(支持 `/login umans` 或 `UMANS_AI_CODING_PLAN_API_KEY`)
- **MiniMax Token Plan**(需要 `MINIMAX_CODE_API_KEY` 或 `MINIMAX_CODE_CN_API_KEY`)
- **Xiaomi MiMo**(需要 `XIAOMI_API_KEY`)
- **ZenMux**(需要 `ZENMUX_API_KEY`)
- **Qwen Portal**(支持 `QWEN_OAUTH_TOKEN` 或 `QWEN_PORTAL_API_KEY`)
- **QwenCloud Token Plan**(支持 `/login alibaba-token-plan`、`ALIBABA_TOKEN_PLAN_API_KEY` 或 `BAILIAN_TOKEN_PLAN_API_KEY`;交互式登录首先选择区域——国际(新加坡,默认)、中国(北京,用于百炼 Token Plan 密钥)或自定义 base URL——因为区域密钥不可互换,然后可选地存储一个 `home.qwencloud.com` Cookie 请求头,用于尽力而为的 5 小时与 7 天配额上报)
  要启用配额上报,请登录 Token Plan 仪表盘,从浏览器开发者工具中 `home.qwencloud.com` 请求复制 `Cookie` 请求头值,并在第二个登录提示处粘贴。按 Enter 跳过;Cookie 是敏感且随会话存活的,过期后请重新运行登录。
- **Cloudflare AI Gateway**(需要 `CLOUDFLARE_AI_GATEWAY_API_KEY` 与提供商专属的网关 base URL)
- **Ollama**(本地 OpenAI 兼容运行时;可选 `OLLAMA_API_KEY`)
- **Ollama Cloud**(托管的原生 Ollama API;需要 `OLLAMA_CLOUD_API_KEY`)
- **llama.cpp**(本地 OpenAI 与 Anthropic 兼容推理服务器)
- **vLLM**(OpenAI 兼容服务器;安全部署用 `VLLM_API_KEY`)
- **GitHub Copilot**(需要 OAuth,见下文)
- **Google Gemini CLI**(需要 OAuth,见下文)
- **Antigravity**(需要 OAuth,见下文)
- **任意 OpenAI 兼容 API**:LM Studio、自定义代理等。

## 安装

```bash
npm install @oh-my-pi/pi-ai
```

## 快速开始

```typescript
import { z, getModel, stream, complete, Context, Tool } from "@oh-my-pi/pi-ai";

// Fully typed with auto-complete support for both providers and models
const model = getModel("openai", "gpt-4o-mini");

// Define tools with Zod schemas for type safety and validation
const tools: Tool[] = [
	{
		name: "get_time",
		description: "Get the current time",
		parameters: z.object({
			timezone: z
				.string()
				.optional()
				.describe("Optional timezone (e.g., America/New_York)"),
		}),
	},
];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "What time is it?" }],
	tools,
};

// Option 1: Streaming with all event types
const s = stream(model, context);

for await (const event of s) {
	switch (event.type) {
		case "start":
			console.log(`Starting with ${event.partial.model}`);
			break;
		case "text_start":
			console.log("\n[Text started]");
			break;
		case "text_delta":
			process.stdout.write(event.delta);
			break;
		case "text_end":
			console.log("\n[Text ended]");
			break;
		case "thinking_start":
			console.log("[Model is thinking...]");
			break;
		case "thinking_delta":
			process.stdout.write(event.delta);
			break;
		case "thinking_end":
			console.log("[Thinking complete]");
			break;
		case "toolcall_start":
			console.log(`\n[Tool call started: index ${event.contentIndex}]`);
			break;
		case "toolcall_delta":
			// Partial tool arguments are being streamed
			const partialCall = event.partial.content[event.contentIndex];
			if (partialCall.type === "toolCall") {
				console.log(`[Streaming args for ${partialCall.name}]`);
			}
			break;
		case "toolcall_end":
			console.log(`\nTool called: ${event.toolCall.name}`);
			console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
			break;
		case "done":
			console.log(`\nFinished: ${event.reason}`);
			break;
		case "error":
			console.error(`Error: ${event.error}`);
			break;
	}
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter((b) => b.type === "toolCall");
for (const call of toolCalls) {
	// Execute the tool
	const result =
		call.name === "get_time"
			? new Date().toLocaleString("en-US", {
					timeZone: call.arguments.timezone || "UTC",
					dateStyle: "full",
					timeStyle: "long",
				})
			: "Unknown tool";

	// Add tool result to context (supports text and images)
	context.messages.push({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: result }],
		isError: false,
		timestamp: Date.now(),
	});
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
	const continuation = await complete(model, context);
	context.messages.push(continuation);
	console.log("After tool execution:", continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await complete(model, context);

for (const block of response.content) {
	if (block.type === "text") {
		console.log(block.text);
	} else if (block.type === "toolCall") {
		console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
	}
}
```

## 工具

工具让 LLM 能与外部系统交互。本库使用 **Zod** schema 实现类型安全的工具定义与自动校验。Schema 会按需转换为 JSON Schema 提供给提供商。

### 定义工具

```typescript
import { z, Tool } from "@oh-my-pi/pi-ai";

// Define tool parameters with Zod
const weatherTool: Tool = {
	name: "get_weather",
	description: "Get current weather for a location",
	parameters: z.object({
		location: z.string().describe("City name or coordinates"),
		units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
	}),
};

const bookMeetingTool: Tool = {
	name: "book_meeting",
	description: "Schedule a meeting",
	parameters: z.object({
		title: z.string().min(1),
		startTime: z.string().describe("ISO 8601 date-time"),
		endTime: z.string().describe("ISO 8601 date-time"),
		attendees: z.array(z.email()).min(1),
	}),
};
```

### 处理工具调用

工具结果使用内容块,可同时包含文本与图像:

```typescript
import * as fs from "node:fs";

const context: Context = {
	messages: [{ role: "user", content: "What is the weather in London?" }],
	tools: [weatherTool],
};

const response = await complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
	if (block.type === "toolCall") {
		// Execute your tool with the arguments
		// See "Validating Tool Arguments" section for validation
		const result = await executeWeatherApi(block.arguments);

		// Add tool result with text content
		context.messages.push({
			role: "toolResult",
			toolCallId: block.id,
			toolName: block.name,
			content: [{ type: "text", text: JSON.stringify(result) }],
			isError: false,
			timestamp: Date.now(),
		});
	}
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = fs.readFileSync("chart.png");
context.messages.push({
	role: "toolResult",
	toolCallId: "tool_xyz",
	toolName: "generate_chart",
	content: [
		{ type: "text", text: "Generated chart showing temperature trends" },
		{ type: "image", data: imageBuffer.toBase64(), mimeType: "image/png" },
	],
	isError: false,
	timestamp: Date.now(),
});
```

### 用部分 JSON 流式输出工具调用

流式期间,工具调用参数会随到达逐步解析。这可以在完整参数可用之前就实现实时 UI 更新:

```typescript
const s = stream(model, context);

for await (const event of s) {
	if (event.type === "toolcall_delta") {
		const toolCall = event.partial.content[event.contentIndex];

		// toolCall.arguments contains partially parsed JSON during streaming
		// This allows for progressive UI updates
		if (toolCall.type === "toolCall" && toolCall.arguments) {
			// BE DEFENSIVE: arguments may be incomplete
			// Example: Show file path being written even before content is complete
			if (toolCall.name === "write_file" && toolCall.arguments.path) {
				console.log(`Writing to: ${toolCall.arguments.path}`);

				// Content might be partial or missing
				if (toolCall.arguments.content) {
					console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
				}
			}
		}
	}

	if (event.type === "toolcall_end") {
		// Here toolCall.arguments is complete (but not yet validated)
		const toolCall = event.toolCall;
		console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
	}
}
```

**关于部分工具参数的重要说明:**

- 在 `toolcall_delta` 事件期间,`arguments` 包含对部分 JSON 的尽力解析
- 字段可能缺失或不完整——使用前务必检查存在性
- 字符串值可能在一个单词中间被截断
- 数组可能不完整
- 嵌套对象可能只填充了一部分
- 至少,`arguments` 会是空对象 `{}`,绝不会是 `undefined`
- Google 提供商不支持函数调用流式输出。作为替代,你会收到一个携带完整参数的 `toolcall_delta` 事件。

### 校验工具参数

使用 `agentLoop` 时,工具参数会在执行前自动对照你的 Zod 参数 schema 校验。校验失败时,错误会作为工具结果返回给模型,允许它重试。

用 `stream()` 或 `complete()` 实现你自己的工具执行循环时,在把参数传给工具前用 `validateToolCall` 校验:

```typescript
import { stream, validateToolCall, Tool } from "@oh-my-pi/pi-ai";

const tools: Tool[] = [weatherTool, calculatorTool];
const s = stream(model, { messages, tools });

for await (const event of s) {
	if (event.type === "toolcall_end") {
		const toolCall = event.toolCall;

		try {
			// Validate arguments against the tool's schema (throws on invalid args)
			const validatedArgs = validateToolCall(tools, toolCall);
			const result = await executeMyTool(toolCall.name, validatedArgs);
			// ... add tool result to context
		} catch (error) {
			// Validation failed - return error as tool result so model can retry
			context.messages.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: error.message }],
				isError: true,
				timestamp: Date.now(),
			});
		}
	}
}
```

### 完整事件参考

assistant 消息生成期间发出的所有流式事件:

| 事件类型       | 说明              | 关键属性                                                                              |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `start`          | 流开始            | `partial`:初始 assistant 消息结构                                              |
| `text_start`     | 文本块开始        | `contentIndex`:在内容数组中的位置                                                   |
| `text_delta`     | 收到文本块      | `delta`:新文本,`contentIndex`:位置                                                 |
| `text_end`       | 文本块完成      | `content`:完整文本,`contentIndex`:位置                                              |
| `thinking_start` | 思考块开始    | `contentIndex`:在内容数组中的位置                                                   |
| `thinking_delta` | 收到思考块  | `delta`:新文本,`contentIndex`:位置                                                 |
| `thinking_end`   | 思考块完成  | `content`:完整思考,`contentIndex`:位置                                          |
| `toolcall_start` | 工具调用开始         | `contentIndex`:在内容数组中的位置                                                   |
| `toolcall_delta` | 工具参数流式输出 | `delta`:JSON 块,`partial.content[contentIndex].arguments`:部分解析的参数         |
| `toolcall_end`   | 工具调用完成       | `toolCall`:带 `id`、`name`、`arguments` 的完整校验工具调用                     |
| `done`           | 流完成          | `reason`:停止原因("stop"、"length"、"toolUse"),`message`:最终 assistant 消息     |
| `error`          | 发生错误           | `reason`:错误类型("error" 或 "aborted"),`error`:带部分内容的 AssistantMessage |

## 图像输入

具有视觉能力的模型可以处理图像。你可以通过 `input` 属性检查模型是否支持图像。如果向非视觉模型传图像,它们会被静默忽略。

```typescript
import * as fs from "node:fs";
import { getModel, complete } from "@oh-my-pi/pi-ai";

const model = getModel("openai", "gpt-4o-mini");

// Check if model supports images
if (model.input.includes("image")) {
	console.log("Model supports vision");
}

const imageBuffer = fs.readFileSync("image.png");
const base64Image = imageBuffer.toBase64();

const response = await complete(model, {
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "What is in this image?" },
				{ type: "image", data: base64Image, mimeType: "image/png" },
			],
		},
	],
});

// Access the response
for (const block of response.content) {
	if (block.type === "text") {
		console.log(block.text);
	}
}
```

## 思考/推理

许多模型支持思考/推理能力,可以展示内部思维过程。你可以通过 `reasoning` 属性检查模型是否支持推理。如果向非推理模型传推理选项,它们会被静默忽略。

### 统一接口(streamSimple/completeSimple)

```typescript
import { getModel, streamSimple, completeSimple } from "@oh-my-pi/pi-ai";

// Many models across providers support thinking/reasoning
const model = getModel("anthropic", "claude-sonnet-4-20250514");
// or getModel('openai', 'gpt-5-mini');
// or getModel('google', 'gemini-2.5-flash');
// or getModel('xai', 'grok-code-fast-1');
// or getModel('groq', 'openai/gpt-oss-20b');
// or getModel('cerebras', 'gpt-oss-120b');
// or getModel('openrouter', 'z-ai/glm-4.5v');

// Check if model supports reasoning
if (model.reasoning) {
	console.log("Model supports reasoning/thinking");
}

// Use the simplified reasoning option
const response = await completeSimple(
	model,
	{
		messages: [{ role: "user", content: "Solve: 2x + 5 = 13" }],
	},
	{
		reasoning: "medium", // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' (xhigh maps to high on non-OpenAI providers)
	}
);

// Access thinking and text blocks
for (const block of response.content) {
	if (block.type === "thinking") {
		console.log("Thinking:", block.thinking);
	} else if (block.type === "text") {
		console.log("Response:", block.text);
	}
}
```

### 提供商专属选项(stream/complete)

要精细控制,请使用提供商专属选项:

```typescript
import { getModel, complete } from "@oh-my-pi/pi-ai";

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = getModel("openai", "gpt-5-mini");
await complete(openaiModel, context, {
	reasoningEffort: "medium",
	reasoningSummary: "detailed", // OpenAI Responses API only
});

// Anthropic Thinking (Claude Sonnet 4)
const anthropicModel = getModel("anthropic", "claude-sonnet-4-20250514");
await complete(anthropicModel, context, {
	thinkingEnabled: true,
	thinkingBudgetTokens: 8192, // Optional token limit
});

// Google Gemini Thinking
const googleModel = getModel("google", "gemini-2.5-flash");
await complete(googleModel, context, {
	thinking: {
		enabled: true,
		budgetTokens: 8192, // -1 for dynamic, 0 to disable
	},
});
```

### 流式输出思考内容

流式时,思考内容通过专属事件投递:

```typescript
const s = streamSimple(model, context, { reasoning: "high" });

for await (const event of s) {
	switch (event.type) {
		case "thinking_start":
			console.log("[Model started thinking]");
			break;
		case "thinking_delta":
			process.stdout.write(event.delta); // Stream thinking content
			break;
		case "thinking_end":
			console.log("\n[Thinking complete]");
			break;
	}
}
```

## 停止原因

每条 `AssistantMessage` 都包含一个 `stopReason` 字段,指示生成如何结束:

- `"stop"` - 正常完成,模型完成了响应
- `"length"` - 输出达到最大 token 上限
- `"toolUse"` - 模型正在调用工具,期待工具结果
- `"error"` - 生成期间发生错误
- `"aborted"` - 请求通过 abort 信号被取消

## 错误处理

请求以错误结束时(包括中止与工具调用校验错误),流式 API 会发出一个 error 事件:

```typescript
// In streaming
for await (const event of stream) {
	if (event.type === "error") {
		// event.reason is either "error" or "aborted"
		// event.error is the AssistantMessage with partial content
		console.error(`Error (${event.reason}):`, event.error.errorMessage);
		console.log("Partial content:", event.error.content);
	}
}

// The final message will have the error details
const message = await stream.result();
if (message.stopReason === "error" || message.stopReason === "aborted") {
	console.error("Request failed:", message.errorMessage);
	// message.content contains any partial content received before the error
	// message.usage contains partial token counts and costs
}
```

### 中止请求

abort 信号允许你取消进行中的请求。被中止的请求 `stopReason === 'aborted'`:

```typescript
import { getModel, stream } from "@oh-my-pi/pi-ai";

const model = getModel("openai", "gpt-4o-mini");

// Abort after 2 seconds
const signal = AbortSignal.timeout(2000);

const s = stream(
	model,
	{
		messages: [{ role: "user", content: "Write a long story" }],
	},
	{
		signal,
	}
);

for await (const event of s) {
	if (event.type === "text_delta") {
		process.stdout.write(event.delta);
	} else if (event.type === "error") {
		// event.reason tells you if it was "error" or "aborted"
		console.log(`${event.reason === "aborted" ? "Aborted" : "Error"}:`, event.error.errorMessage);
	}
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === "aborted") {
	console.log("Request was aborted:", response.errorMessage);
	console.log("Partial content received:", response.content);
	console.log("Tokens used:", response.usage);
}
```

### 中止后继续

被中止的消息可以加进对话上下文,并在后续请求中继续:

```typescript
const context = {
	messages: [{ role: "user", content: "Explain quantum computing in detail" }],
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: "user", content: "Please continue" });

// Continue the conversation
const continuation = await complete(model, context);
```

### 通用流选项

所有提供商都接受基础 `StreamOptions`(除提供商专属选项外):

- `apiKey`:覆盖提供商 API 密钥
- `headers`:合并到模型定义头之上的额外请求头
- `sessionId`:提供商专属会话标识(提示词缓存/路由)
- `signal`:中止在途请求
- `onPayload`:发送前以提供商请求负载调用的回调

示例:

```typescript
const response = await complete(model, context, {
	apiKey: "sk-live",
	headers: { "X-Debug-Trace": "true" },
	onPayload: (payload) => {
		console.log("request payload", payload);
	},
});
```

## API、模型与提供商

本库实现了 4 个 API 接口,每个都有自己的流式函数与选项:

- **`anthropic-messages`**:Anthropic 的 Messages API(`streamAnthropic`,`AnthropicOptions`)
- **`google-generative-ai`**:Google 的 Generative AI API(`streamGoogle`,`GoogleOptions`)
- **`openai-completions`**:OpenAI 的 Chat Completions API(`streamOpenAICompletions`,`OpenAICompletionsOptions`)
- **`openai-responses`**:OpenAI 的 Responses API(`streamOpenAIResponses`,`OpenAIResponsesOptions`)

### 提供商与模型

**提供商**通过特定 API 提供模型。例如:

- **Anthropic** 模型使用 `anthropic-messages` API
- **Google** 模型使用 `google-generative-ai` API
- **OpenAI** 模型使用 `openai-responses` API
- **Mistral、xAI、Cerebras、Groq 等**模型使用 `openai-completions` API(OpenAI 兼容)

### 查询提供商与模型

```typescript
import { getProviders, getModels, getModel } from "@oh-my-pi/pi-ai";

// Get all available providers
const providers = getProviders();
console.log(providers); // ['openai', 'anthropic', 'google', 'xai', 'groq', ...]

// Get all models from a provider (fully typed)
const anthropicModels = getModels("anthropic");
for (const model of anthropicModels) {
	console.log(`${model.id}: ${model.name}`);
	console.log(`  API: ${model.api}`); // 'anthropic-messages'
	console.log(`  Context: ${model.contextWindow} tokens`);
	console.log(`  Vision: ${model.input.includes("image")}`);
	console.log(`  Reasoning: ${model.reasoning}`);
}

// Get a specific model (both provider and model ID are auto-completed in IDEs)
const model = getModel("openai", "gpt-4o-mini");
console.log(`Using ${model.name} via ${model.api} API`);
```

### 自定义模型

你可以为本地推理服务器或自定义端点创建自定义模型。

对于本地 Ollama,`OLLAMA_API_KEY` 是可选的,主要供经过认证/自托管的网关使用。`ollama` 仍是本地 OpenAI 兼容运行时集成。

```typescript
import { Model, stream } from "@oh-my-pi/pi-ai";

// Example: local Ollama using the OpenAI-compatible API
const ollamaModel: Model<"openai-completions"> = {
	id: "llama-3.1-8b",
	name: "Llama 3.1 8B (Ollama)",
	api: "openai-completions",
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
};

const localResponse = await stream(ollamaModel, context, {
	apiKey: process.env.OLLAMA_API_KEY, // Optional; local Ollama usually runs without auth
});

// Example: Ollama Cloud using the native /api/chat transport
const ollamaCloudModel: Model<"ollama-chat"> = {
	id: "gpt-oss:120b",
	name: "GPT OSS 120B (Ollama Cloud)",
	api: "ollama-chat",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 8192,
};

const cloudResponse = await stream(ollamaCloudModel, context, {
	apiKey: process.env.OLLAMA_CLOUD_API_KEY,
});

// Example: LiteLLM proxy with explicit compat settings
const litellmModel: Model<"openai-completions"> = {
	id: "gpt-4o",
	name: "GPT-4o (via LiteLLM)",
	api: "openai-completions",
	provider: "litellm",
	baseUrl: "http://localhost:4000/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
	compat: {
		supportsStore: false, // LiteLLM doesn't support the store field
	},
};

// Example: Custom endpoint with headers (bypassing Cloudflare bot detection)
const proxyModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4",
	name: "Claude Sonnet 4 (Proxied)",
	api: "anthropic-messages",
	provider: "custom-proxy",
	baseUrl: "https://proxy.example.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
	headers: {
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
		"X-Custom-Auth": "bearer-token-here",
	},
};
```

### OpenAI 兼容设置

`openai-completions` API 被许多提供商实现,且存在细微差异。默认情况下,本库根据已知提供商(Cerebras、xAI、Mistral、Chutes 等)的 `baseUrl` 自动检测兼容设置。对于自定义代理或未知端点,你可以通过 `compat` 字段覆盖这些设置:

```typescript
interface OpenAICompat {
	supportsStore?: boolean; // Whether provider supports the `store` field (default: true)
	supportsDeveloperRole?: boolean; // Whether provider supports `developer` role vs `system` (default: true)
	supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
	maxTokensField?: "max_completion_tokens" | "max_tokens"; // Which field name to use (default: max_completion_tokens)
	extraBody?: Record<string, unknown>; // Extra request-body fields for custom proxy routing or provider-specific options
}
```

如果未设置 `compat`,本库回退到基于 URL 的检测。如果部分设置 `compat`,未指定字段使用检测到的默认值。这对以下场景很有用:

- **LiteLLM 代理**:可能不支持 `store` 字段
- **自定义推理服务器**:可能使用非标准字段名
- **自托管端点**:可能有不同的功能支持

### 类型安全

模型按 API 类型化,确保选项类型安全:

```typescript
// TypeScript knows this is an Anthropic model
const claude = getModel("anthropic", "claude-sonnet-4-20250514");

// So these options are type-checked for AnthropicOptions
await stream(claude, context, {
	thinkingEnabled: true, // ✓ Valid for anthropic-messages
	thinkingBudgetTokens: 2048, // ✓ Valid for anthropic-messages
	// reasoningEffort: 'high'  // ✗ TypeScript error: not valid for anthropic-messages
});
```

## 跨提供商交接

本库支持同一对话内在不同 LLM 提供商之间的无缝交接。这允许你在对话中途切换模型,同时保留上下文,包括思考块、工具调用与工具结果。

### 工作原理

当一个提供商的 message 被发送给另一个提供商时,本库会自动变换它们以兼容:

- **User 与工具结果消息**原样通过
- **来自同一提供商/API 的 assistant 消息**原样保留
- **来自不同提供商的 assistant 消息**把思考块转换为带 `<thinking>` 标签的文本
- **工具调用与普通文本**原样保留

### 示例:多提供商对话

```typescript
import { getModel, complete, Context } from "@oh-my-pi/pi-ai";

// Start with Claude
const claude = getModel("anthropic", "claude-sonnet-4-20250514");
const context: Context = {
	messages: [],
};

context.messages.push({ role: "user", content: "What is 25 * 18?" });
const claudeResponse = await complete(claude, context, {
	thinkingEnabled: true,
});
context.messages.push(claudeResponse);

// Switch to GPT-5 - it will see Claude's thinking as <thinking> tagged text
const gpt5 = getModel("openai", "gpt-5-mini");
context.messages.push({ role: "user", content: "Is that calculation correct?" });
const gptResponse = await complete(gpt5, context);
context.messages.push(gptResponse);

// Switch to Gemini
const gemini = getModel("google", "gemini-2.5-flash");
context.messages.push({ role: "user", content: "What was the original question?" });
const geminiResponse = await complete(gemini, context);
```

### 提供商兼容性

所有提供商都能处理来自其它提供商的消息,包括:

- 文本内容
- 工具调用与工具结果(包括工具结果中的图像)
- 思考/推理块(为跨提供商兼容转换为带标签的文本)
- 带部分内容的中止消息

这支持灵活的工作流,你可以:

- 用快速模型处理初始响应
- 切换到更强模型处理复杂推理
- 为特定任务使用专门模型
- 在提供商故障期间保持对话连续性

## 上下文序列化

`Context` 对象可以用标准 JSON 方法轻松序列化与反序列化,便于持久化对话、实现聊天历史,或在服务之间传递上下文:

```typescript
import { Context, getModel, complete } from "@oh-my-pi/pi-ai";

// Create and use a context
const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "What is TypeScript?" }],
};

const model = getModel("openai", "gpt-4o-mini");
const response = await complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);
console.log("Serialized context size:", serialized.length, "bytes");

// Save to database, localStorage, file, etc.
localStorage.setItem("conversation", serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem("conversation")!);
restored.messages.push({ role: "user", content: "Tell me more about its type system" });

// Continue with any model
const newModel = getModel("anthropic", "claude-haiku-4-5-20251001");
const continuation = await complete(newModel, restored);
```

> **注意**:如果上下文包含图像(如图像输入一节所示以 base64 编码),它们也会被序列化。

## 浏览器用法

本库支持浏览器环境。你必须显式传入 API 密钥,因为浏览器中没有环境变量:

```typescript
import { getModel, complete } from "@oh-my-pi/pi-ai";

// API key must be passed explicitly in browser
const model = getModel("anthropic", "claude-haiku-4-5-20251001");

const response = await complete(
	model,
	{
		messages: [{ role: "user", content: "Hello!" }],
	},
	{
		apiKey: "your-api-key",
	}
);
```

> **安全警告**:在前端代码中暴露 API 密钥是危险的。任何人都能提取并滥用你的密钥。仅在内部工具或演示中使用这种做法。生产应用请使用后端代理来保护 API 密钥。

### 环境变量(仅限 Node.js)

在 Node.js 环境中,你可以设置环境变量以避免传递 API 密钥:

| Provider       | Environment Variable(s)                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| OpenAI         | `OPENAI_API_KEY`                                                             |
| Anthropic      | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN`(或 `CLAUDE_CODE_USE_FOUNDRY=true` 时的 `ANTHROPIC_FOUNDRY_API_KEY`) |
| Google         | `GEMINI_API_KEY`                                                             |
| Vertex AI      | `GOOGLE_CLOUD_PROJECT`(或 `GCLOUD_PROJECT`)+ `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral        | `MISTRAL_API_KEY`                                                            |
| Groq           | `GROQ_API_KEY`                                                               |
| Cerebras       | `CEREBRAS_API_KEY`                                                           |
| Together       | `TOGETHER_API_KEY`                                                           |
| Qianfan        | `QIANFAN_API_KEY`                                                            |
| Hugging Face   | `HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`                                        |
| Synthetic      | `SYNTHETIC_API_KEY`                                                          |
| NVIDIA         | `NVIDIA_API_KEY`                                                             |
| NanoGPT        | `NANO_GPT_API_KEY`                                                          |
| Novita         | `NOVITA_API_KEY`                                                           |
| Venice         | `VENICE_API_KEY`                                                             |
| Moonshot       | `MOONSHOT_API_KEY`                                                           |
| xAI            | `XAI_API_KEY`                                                                |
| OpenRouter     | `OPENROUTER_API_KEY`                                                         |
| LiteLLM        | `LITELLM_API_KEY`                                                            |
| Ollama         | `OLLAMA_API_KEY`(本地部署可选)                            |
| Ollama Cloud   | `OLLAMA_CLOUD_API_KEY`                                                     |
| Qwen Portal    | `QWEN_OAUTH_TOKEN` 或 `QWEN_PORTAL_API_KEY`                                  |
| QwenCloud Token Plan | `ALIBABA_TOKEN_PLAN_API_KEY` 或 `BAILIAN_TOKEN_PLAN_API_KEY`                   |
| zAI            | `ZAI_API_KEY`                                                                |
| Umans AI Coding Plan | `UMANS_AI_CODING_PLAN_API_KEY`                                           |
| MiniMax Code   | `MINIMAX_CODE_API_KEY`(国际)或 `MINIMAX_CODE_CN_API_KEY`(中国) |
| Xiaomi MiMo    | `XIAOMI_API_KEY`                                                             |
| ZenMux         | `ZENMUX_API_KEY`                                                             |
| vLLM           | `VLLM_API_KEY`                                                               |
| Cloudflare AI Gateway | `CLOUDFLARE_AI_GATEWAY_API_KEY`                                      |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` 或 `GH_TOKEN` 或 `GITHUB_TOKEN`                      |

对于 Cloudflare AI Gateway 模型,使用提供商 base URL 格式
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`。

对于 Anthropic Foundry 路由,设置 `CLAUDE_CODE_USE_FOUNDRY=true`,外加:
`FOUNDRY_BASE_URL`、`ANTHROPIC_FOUNDRY_API_KEY`、可选 `ANTHROPIC_CUSTOM_HEADERS`,
以及可选的 mTLS 材料(`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`)。

`NODE_EXTRA_CA_CERTS`(PEM 文件路径或内联 PEM,镜像 Node 的契约)在每次提供商 fetch 时都会被尊重——OpenAI 兼容、Codex、Ollama、Azure Responses、Google 与 Anthropic 一律如此——适用于企业中继或私有 CA 包。Bun 的 `fetch` 不会原生消费该环境变量,因此 omp 把证书包注入 `RequestInit.tls.ca`,并同时把系统根存储一并植入。

当前 OpenAI 兼容集成的提供商端点默认值:

- Together: `https://api.together.xyz/v1`
- Moonshot: `https://api.moonshot.ai/v1`
- Qianfan: `https://qianfan.baidubce.com/v2`
- NVIDIA: `https://integrate.api.nvidia.com/v1`
- NanoGPT: `https://nano-gpt.com/api/v1`
- Novita: `https://api.novita.ai/openai/v1`
- Hugging Face Inference: `https://router.huggingface.co/v1`
- Venice: `https://api.venice.ai/api/v1`
- Xiaomi MiMo: `https://api.xiaomimimo.com/anthropic`
- ZenMux(OpenAI): `https://zenmux.ai/api/v1`
- ZenMux(Anthropic 模型): `https://zenmux.ai/api/anthropic`
- Umans AI Coding Plan: `https://api.code.umans.ai`
- vLLM: `http://127.0.0.1:8000/v1`
- Ollama: 本地 OpenAI 兼容运行时(`http://127.0.0.1:11434/v1`)
- Ollama Cloud: 原生 Ollama API 主机(`https://ollama.com/api`,此处配置为 base URL `https://ollama.com`)
- LiteLLM: `http://localhost:4000/v1`
- Cloudflare AI Gateway: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`
- Qwen Portal: `https://portal.qwen.ai/v1`

设置后,本库会自动使用这些密钥:

```typescript
// Uses OPENAI_API_KEY from environment
const model = getModel("openai", "gpt-4o-mini");
const response = await complete(model, context);

// Or override with explicit key
const response = await complete(model, context, {
	apiKey: "sk-different-key",
});
```

### 检查环境变量

```typescript
import { getEnvApiKey } from "@oh-my-pi/pi-ai";

// Check if an API key is set in environment variables
const key = getEnvApiKey("openai"); // checks OPENAI_API_KEY
```

## OAuth 提供商

几个提供商支持 OAuth 认证(其中一些也支持静态 API 密钥):

- **Anthropic**(Claude Pro/Max 订阅)
- **OpenAI Codex**(ChatGPT Plus/Pro 订阅,可访问 GPT-5.x Codex 模型)
- **GitHub Copilot**(Copilot 订阅)
- **Google Gemini CLI**(通过 Google Cloud Code Assist 使用 Gemini 2.0/2.5;免费档或付费订阅)
- **Antigravity**(通过 Google Cloud 免费使用 Gemini 3、Claude、GPT-OSS)
- **Qwen Portal**(Qwen OAuth token 或 API 密钥)

对于付费 Cloud Code Assist 订阅,设置 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID` 为你的项目 id。

### Vertex AI (ADC)

Vertex AI 模型使用应用默认凭据(ADC):

- **本地开发**:运行 `gcloud auth application-default login`
- **CI/生产**:设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账户 JSON 密钥文件

同时设置 `GOOGLE_CLOUD_PROJECT`(或 `GCLOUD_PROJECT`)与 `GOOGLE_CLOUD_LOCATION`。你也可以在调用选项中传 `project`/`location`。

示例:

```bash
# Local (uses your user credentials)
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/Production (service account key file)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

```typescript
import { getModel, complete } from "@oh-my-pi/pi-ai";

(async () => {
	const model = getModel("google-vertex", "gemini-2.5-flash");
	const response = await complete(model, {
		messages: [{ role: "user", content: "Hello from Vertex AI" }],
	});

	for (const block of response.content) {
		if (block.type === "text") console.log(block.text);
	}
})().catch(console.error);
```

官方文档:[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

通过 [`omp`](https://omp.sh) 编码 Agent CLI 认证,它会在进程内驱动本库的 OAuth/API 密钥流程,并持久化到 `agent.db`:

```bash
omp auth-broker login              # 交互式提供商选择
omp auth-broker login anthropic    # 登录特定提供商
omp auth-broker login vllm         # 存储 vLLM API 密钥(或本地免认证用占位符)
omp auth-broker list               # 列出受支持的提供商
omp auth-broker logout             # 交互式——选择要移除的已存凭据
```

凭据保存到 agent 目录下的 `agent.db`。`/login qianfan` 打开 Qianfan 控制台并存储粘贴的 API 密钥。

`login` 支持 OAuth 提供商(Anthropic、OpenAI Codex、GitHub Copilot、Gemini CLI、Antigravity)与 API 密钥入门流程。

对于当前的 API 密钥入门流程,本库覆盖 Together、Moonshot、Qianfan、NVIDIA、NanoGPT、Novita、Hugging Face、Venice、Xiaomi、vLLM、LiteLLM、Cloudflare AI Gateway、Qwen Portal 与 Ollama Cloud。Ollama 仍是本地运行时集成;仅当你的本地或自托管部署强制 bearer 认证时才设置 `OLLAMA_API_KEY`。

### 编程式 OAuth

本库提供登录与 token 刷新函数。凭据存储是调用方的责任。

```typescript
import {
	// Login functions (return credentials, do not store)
	loginAnthropic,
	loginOpenAICodex,
	loginGitHubCopilot,
	loginGeminiCli,
	loginAntigravity,
	loginCloudflareAiGateway,
	loginHuggingface,
	loginLiteLLM,
	loginMoonshot,
	loginNvidia,
	loginNanoGPT,
	loginQianfan,
	loginQwenPortal,
	loginTogether,
	loginVenice,
	loginVllm,
	loginXiaomi,

	// Token management
	refreshOAuthToken, // (provider, credentials) => new credentials
	getOAuthApiKey, // (provider, credentialsMap) => { newCredentials, apiKey } | null

	// Types
	type OAuthProvider, // includes 'anthropic', 'openai-codex', 'github-copilot', 'google-gemini-cli', 'google-antigravity', 'together', 'moonshot', 'qianfan', 'nvidia', 'nanogpt', 'novita', 'huggingface', 'venice', 'xiaomi', 'vllm', 'litellm', 'cloudflare-ai-gateway', 'qwen-portal', ...
	type OAuthCredentials,
} from "@oh-my-pi/pi-ai";
```

`loginOpenAICodex` 接受一个在 OAuth 流程中使用的可选 `originator` 值:

```typescript
await loginOpenAICodex({
	onAuth: ({ url }) => console.log(url),
	originator: "my-cli",
});
```

### 登录流程示例

```typescript
import { loginGitHubCopilot } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs";

const credentials = await loginGitHubCopilot({
	onAuth: (url, instructions) => {
		console.log(`Open: ${url}`);
		if (instructions) console.log(instructions);
	},
	onPrompt: async (prompt) => {
		return await getUserInput(prompt.message);
	},
	onProgress: (message) => console.log(message),
});

// Store credentials yourself
const auth = { "github-copilot": { type: "oauth", ...credentials } };
fs.writeFileSync("credentials.json", JSON.stringify(auth, null, 2));
```

### 使用 OAuth token

用 `getOAuthApiKey()` 获取 API 密钥,过期时自动刷新:

```typescript
import { getModel, complete, getOAuthApiKey } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs";

// Load your stored credentials
const auth = JSON.parse(fs.readFileSync("credentials.json", "utf-8"));

// Get API key (refreshes if expired)
const result = await getOAuthApiKey("github-copilot", auth);
if (!result) throw new Error("Not logged in");

// Save refreshed credentials
auth["github-copilot"] = { type: "oauth", ...result.newCredentials };
fs.writeFileSync("credentials.json", JSON.stringify(auth, null, 2));

// Use the API key
const model = getModel("github-copilot", "gpt-4o");
const response = await complete(
	model,
	{
		messages: [{ role: "user", content: "Hello!" }],
	},
	{ apiKey: result.apiKey }
);
```

### 提供商说明

**OpenAI Codex**:需要 ChatGPT Plus 或 Pro 订阅。提供对带扩展上下文窗口与推理能力的 GPT-5.x Codex 模型的访问。当流选项中提供 `sessionId` 时,本库自动处理基于会话的提示词缓存。

**GitHub Copilot**:如果遇到 "The requested model is not supported" 错误,请在 VS Code 中手动启用模型:打开 Copilot Chat,点击模型选择器,选择该模型(带警告图标),然后点击 "Enable"。

**Google Gemini CLI / Antigravity**:它们使用 Google Cloud OAuth。`getOAuthApiKey()` 返回的 `apiKey` 是同时包含 token 与项目 id 的 JSON 字符串,本库会自动处理。

## 许可证

MIT
