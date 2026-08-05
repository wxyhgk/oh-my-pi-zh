# @oh-my-pi/pi-mnemopi

面向 Oh My Pi Agent 的本地 SQLite 记忆引擎。

本包是 Mnemosyne 记忆引擎的 Bun/TypeScript 移植。它提供:

- `Mnemopi`,一个覆盖 remember/recall/stats/sleep 工作流的小门面。
- `BeamMemory`,更底层的工作/情景记忆引擎。
- MCP 工具定义与供宿主集成的分发器。
- 通过 `fastembed` 的可选本地 ONNX embeddings,以及可选的 OpenAI 兼容 embedding/LLM 端点。

本包不捆绑也不下载本地 GGUF LLM。LLM 路径仅限宿主后端或 OpenAI 兼容远程;未配置 LLM 时,使用确定性启发式路径。

## 基本用法

```ts
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";

const memory = new Mnemopi({ dbPath: "./mnemopi.db", bank: "project" });
const id = memory.remember("The deployment target is stable-cluster.", {
	source: "notes",
	importance: 0.8,
	veracity: "true",
});

const results = memory.recall("deployment target", 5);
console.log(id, results[0]?.content);

memory.close();
```

## 配置

`Mnemopi` 直接接受 LLM 与 embedding 选项。省略对应构造函数选项时,`MNEMOPI_*` 环境变量仍作为回退/默认值。

```ts
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import type { Model } from "@oh-my-pi/pi-ai";

const ftsOnly = new Mnemopi({ noEmbeddings: true });

const remoteEmbeddings = new Mnemopi({
	embeddingModel: "text-embedding-3-small",
	embeddingApiUrl: "https://api.openai.com/v1",
	embeddingApiKey: process.env.OPENAI_API_KEY,
});

const remoteLlm = new Mnemopi({
	llm: {
		baseUrl: "https://api.openai.com/v1",
		apiKey: process.env.OPENAI_API_KEY,
		model: "gpt-4.1-mini",
	},
	// 等价别名:llmBaseUrl、llmApiKey、llmModel。
});

declare const smolModel: Model;
const piAiLlm = new Mnemopi({ llm: smolModel });
const dynamicLlm = new Mnemopi({
	llm: async (prompt, opts) => {
		const token = await getFreshOauthToken();
		return await completeWithPiAi(prompt, {
			token,
			maxTokens: opts?.maxTokens,
			temperature: opts?.temperature,
		});
	},
});
```

### Banks 与宿主作用域

`Mnemopi` 本身通过 `bank` 等构造函数选项直接暴露 banks;它不硬编码 coding-agent 的项目作用域。

Oh My Pi coding-agent 包装器在这些构造函数选项之上添加了 `mnemopi.scoping`:

- `global`:一个共享 bank
- `per-project`:隔离的项目记忆
- `per-project-tagged`:项目本地写入 + 全局召回可见性

在 `per-project-tagged` 中,包装器负责把项目本地保留与全局召回可见性结合起来。本包仍然只是暴露 banks 加上构造函数级的 LLM 与 embedding 选项。

常见环境变量回退:

- `MNEMOPI_DATA_DIR` / `MNEMOPI_DB_PATH`:默认存储位置。
- `MNEMOPI_DB_PAGE_SIZE`:新建文件型数据库的可选 SQLite 页大小;使用从 512 到 65536 的合法 2 的幂,或 `os` 来请求检测到的系统页大小。未设置则保留 SQLite 默认值。
- `MNEMOPI_NO_EMBEDDINGS=1`:强制仅 FTS 召回。
- `MNEMOPI_EMBEDDING_MODEL`:默认为 `BAAI/bge-small-en-v1.5`。
- `MNEMOPI_EMBEDDING_API_URL` 与 `MNEMOPI_EMBEDDING_API_KEY`:OpenAI 兼容 embedding 端点。
- `MNEMOPI_LLM_ENABLED=1`、`MNEMOPI_LLM_BASE_URL`、`MNEMOPI_LLM_API_KEY`、`MNEMOPI_LLM_MODEL`:OpenAI 兼容 LLM 端点。

本地 embeddings 使用 `fastembed` npm 包。它的默认 `BGESmallENV15` 模型是 384 维,使用该包的 CLS pooling 加向量归一化路径。本包不提供本地 GGUF LLM。

## 命令

```sh
mnemopi remember "Use stable-cluster for production deploys"
mnemopi recall "production deploy target"
mnemopi stats
mnemopi sleep
```

## 测试

```sh
bun --cwd packages/mnemopi test
bun --cwd packages/mnemopi run check
```
