# 模型与提供商配置（`models.yml` / `models.yaml`）

本文档介绍编码 Agent 当前如何加载模型、应用覆盖、解析凭据以及如何在运行时选择模型。

## 控制模型行为的要素

主要实现文件：

- `packages/coding-agent/src/config/model-registry.ts` — 加载内置 + 自定义模型、提供商覆盖、运行时发现、认证集成
- `packages/coding-agent/src/config/model-resolver.ts` — 解析模型模式并选择初始/smol/slow 模型
- `packages/coding-agent/src/config/settings-schema.ts` — 模型相关设置（`modelRoles`、提供商传输偏好）
- `packages/coding-agent/src/session/auth-storage.ts` — 从 `@oh-my-pi/pi-ai` 重新导出 `AuthStorage`；API 密钥 + OAuth 解析顺序
- `packages/catalog/src/models.ts` 与 `packages/catalog/src/types.ts` — 内置提供商/模型与公共模型类型

## 配置文件位置与旧版行为

默认配置路径，按优先级顺序：

- `~/.omp/agent/models.yml`
- `~/.omp/agent/models.yaml`

仍保留的旧版行为：

- 如果两个 YAML 文件都不存在且同一位置存在 `models.json`，则将其迁移为 `models.yml`。
- 以编程方式向 `ModelRegistry` 传入显式 `.json` / `.jsonc` 配置路径时仍受支持。

## `models.yml` / `models.yaml` 结构

```yaml
providers:
  <provider-id>:
    # provider-level config
```

`provider-id` 是选择与认证查找所用的规范提供商键。

根对象目前只包含 `providers`；未知的根键会失败模式校验。

## 提供商级字段

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false # set true for Anthropic-compatible endpoints that reject the strict field
    discovery:
      type: ollama
      timeoutMs: 10000 # optional per-provider HTTP probe timeout in milliseconds
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
```

### 允许的提供商/模型 `api` 值

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `bedrock-converse-stream`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

### 允许的 auth/discovery 值

- `auth`：`apiKey`（默认）、`none` 或 `oauth`；对于 `models.yml` 自定义模型，schema 接受 `oauth`，但不豁免 `apiKey` 要求
- `discovery.type`：`ollama`、`llama.cpp`、`lm-studio`、`openai-models-list`、`proxy` 或 `litellm`
- `transport`：仅 `pi-native`。设置后，该提供商下的每个模型都通过 `POST /v1/pi/stream` 发送到兼容 `omp auth-gateway` 的 `baseUrl`；`apiKey` 即网关的 bearer 凭据。

## 校验规则（当前）

### 完整自定义提供商（`models` 非空）

必需：

- `baseUrl`
- `apiKey`（除非 `auth: none`）
- 提供商级或每个模型的 `api`

### 仅覆盖提供商（`models` 缺失或为空）

必须至少定义以下一项：

- `baseUrl`
- `apiKey`
- `auth: none`
- `headers`
- `compat`
- `disableStrictTools`
- `modelOverrides`
- `discovery`
- `remoteCompaction`

### Discovery

- `discovery.timeoutMs` 以毫秒为单位覆盖该提供商的运行时 HTTP 探测超时。必须是正有限数。
- `discovery` 需要提供商级 `api`，但 `discovery.type: proxy` 除外（每模型线上格式自动检测）。

### 远程压缩

`remoteCompaction` 对仅覆盖提供商而言独立充分。
它支持 `enabled`、`api`、`endpoint`、`model`、`v2StreamingEnabled`、
`v2Endpoint` 和 `streamingEndpoint`。

### 模型值检查

- `id` 必需
- 若提供，`contextWindow` 与 `maxTokens` 必须为正数

### 命令解析的密钥

提供商 `apiKey` 值与提供商/模型 `headers` 值可以 `!` 开头，从命令 stdout 读取密钥。命令以 10 秒超时运行，stdout 会去除首尾空白，空输出/失败的命令被忽略：

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password omp-team-key"
```

成功的命令输出在进程生命周期内缓存，因此不会为每个模型重复运行该命令。

## 合并与覆盖顺序

ModelRegistry 流水线（刷新时）：

1. 从 `@oh-my-pi/pi-catalog` 加载内置提供商/模型（`getBundledProviders` / `getBundledModels`）。
2. 加载 `models.yml` / `models.yaml` 自定义配置。
3. 将提供商覆盖（`baseUrl`、`headers`、`disableStrictTools`）应用到内置模型。
4. 应用 `modelOverrides`（按提供商 + 模型 ID）。
5. 合并自定义 `models`：
   - 相同的 `provider + id` 替换现有项
   - 否则追加
6. 加载缓存/运行时发现的模型（Ollama、llama.cpp、LM Studio 及内置提供商管理器），然后重新应用模型覆盖。

### 提供商模型缓存与静态指纹

按提供商缓存的模型列表持久化在模型缓存 SQLite
数据库（当前 schema 版本 12）中，带 `static_fingerprint` 列，
该列对合并进该行的静态目录切片做哈希。当 `resolveProviderModels`
跳过网络获取且内存中静态目录的指纹与缓存匹配时，缓存行被原样返回——
静态 + 动态合并被完全绕过。指纹通过给静态模型数组打上 symbol
属性按进程记忆化，因此重复的冷启动调用不会重新哈希。

## 提供商与模型身份

注册表保留具体的 `provider` + `id` 身份。当同一模型 ID 存在于多个提供商下时，使用精确的
`provider/modelId` 选择器。会话状态与转录记录执行该轮次的具体提供商/模型。

提供商默认值 vs 每模型覆盖：

- 提供商 `headers`、`compat` 与 `remoteCompaction` 是基线。
- 模型 `headers` 覆盖提供商 header 键。
- `modelOverrides` 可以覆盖模型元数据（`name`、`reasoning`、`thinking`、`input`、
  `supportsTools`、`cost`、`premiumMultiplier`、`contextWindow`、`maxTokens`、
  `omitMaxOutputTokens`、`headers`、`compat`、`contextPromotionTarget`、`compactionModel` 与
  `remoteCompaction`）。
- `compat` 对嵌套路由块（`openRouterRouting`、`vercelGatewayRouting`、
  `extraBody` 与 `whenThinking`）做深度合并。

## 运行时发现集成

### 隐式 Ollama 发现

如果 `ollama` 未显式配置，注册表会添加一个隐式可发现提供商：

- provider：`ollama`
- api：`openai-responses`
- base URL：`OLLAMA_BASE_URL`，或 `OLLAMA_HOST`，或 `http://127.0.0.1:11434`
- context window：已设置则为 `OLLAMA_CONTEXT_LENGTH`，否则为 Ollama `/api/show` 元数据，再否则为 `128000`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现调用 Ollama 端点，并将发现的 OpenAI 兼容模型规范化为 `openai-responses`。

`OLLAMA_CONTEXT_LENGTH` 不会配置 Ollama 运行时的 `num_ctx`；请另行在 Ollama/模型配置中设置。

### 隐式 llama.cpp 发现

如果 `llama.cpp` 未显式配置，注册表会添加一个隐式可发现提供商：

- provider：`llama.cpp`
- api：`openai-responses`
- base URL：`LLAMA_CPP_BASE_URL` 或 `http://127.0.0.1:8080`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现调用 llama.cpp 模型端点，并用本地默认值合成模型条目。

### 隐式 LM Studio 发现

如果 `lm-studio` 未显式配置，注册表会添加一个隐式可发现提供商：

- provider：`lm-studio`
- api：`openai-completions`
- base URL：`LM_STUDIO_BASE_URL` 或 `http://127.0.0.1:1234/v1`
- auth 模式：无密钥（`auth: none` 行为）

运行时发现获取模型（`GET /models`）并用本地默认值合成模型条目。

此路径也适用于非 LM Studio 的本地 OpenAI 兼容服务器。例如，如果 oMLX 绑定在 Ollama 常用的端口上，设置 `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1` 即可通过现有 `/v1/models` 流程发现它。oMLX 与 Ollama 并行运行需要为其中一个分配不同端口。不要将 oMLX 配置为 `ollama`：Ollama 发现使用原生 `/api/tags` 与 `/api/show` 端点，而非 OpenAI 的 `/v1/models`。

### LiteLLM 提供商发现

当 `litellm` 激活时（例如通过 `LITELLM_API_KEY` 或存储的认证），运行时发现使用 LiteLLM 代理：

- provider：`litellm`
- api：`openai-completions`
- base URL：显式提供商 `baseUrl` / `models.yml` 配置，否则 `LITELLM_BASE_URL`，再否则 `http://localhost:4000/v1`
- auth 模式：代理需要密钥时为 `LITELLM_API_KEY` 或存储的 LiteLLM 认证

运行时发现按顺序探测 LiteLLM 管理元数据：`GET /model_group/info`、`GET /v2/model/info`、`GET /model/info` 与 `GET /v1/model/info`。配置的密钥必须被授权读取至少一条此类路由；在限制管理端点的部署上，通过 LiteLLM 的 `allowed_routes` 访问控制授予该路由，或使用 master/admin 密钥进行发现。

如果所有元数据路由均不可用，发现回退到 OpenAI 兼容的 `GET /models` 列表。被禁止或失败的元数据请求会连同其端点与状态记录一次日志；`404` 视为路由不存在。富元数据映射每个模型的上下文与能力字段，而裸回退 ID 在可用时用捆绑的参考元数据充实。因此，未出现在捆绑目录中的模型在回退后可能上下文与定价未知。

### 显式提供商发现

你可以自行配置发现：

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

自定义 LiteLLM 网关可以使用相同的富发现路径：

```yaml
providers:
  litellm-gateway:
    baseUrl: http://gateway.example:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

LiteLLM 元数据端点使用配置的 base URL，仅在发现时剥离末尾的 `/v1`，保留前面的任何代理路径。运行时模型调用保持配置的 OpenAI 兼容 `/v1` base URL。

### 代理发现（`discovery.type: proxy`）

适用于在同一主机后同时暴露 `/v1/messages` 与 `/v1/chat/completions`
的 Anthropic+OpenAI 兼容代理（new-api / one-api / 类似项目）。发现访问 `GET /v1/models`
（10 秒超时，OpenAI 风格负载），并根据条目的 `supported_endpoint_types` 推导每个模型的 `api`：

- 包含 `"anthropic"` → `api: anthropic-messages`（经 `/v1/messages` 路由）
- 包含 `"openai"` → `api: openai-completions`（经 `/v1/chat/completions` 路由）
- 否则 → 已设置则回退到提供商级 `api`，否则丢弃该模型

使用 `discovery.type: proxy` 时，提供商级 `api` 是**可选的**，因为
每模型线上格式是自动检测的。Anthropic SDK 在追加 `/v1/messages` 之前会从 `baseUrl` 剥离末尾的 `/v1`，因此单个发现 `baseUrl`（以 `/v1` 结尾）可以正确往返于两条线上。

```yaml
providers:
  newapi-reseller:
    baseUrl: https://api.example.com/v1
    apiKey: xxxx
    authHeader: true # injects Authorization: Bearer for openai models
    disableStrictTools: true # most anthropic-fronted proxies reject `strict`
    discovery:
      type: proxy
```

### 扩展提供商注册

扩展可以在运行时注册提供商（`pi.registerProvider(...)`），包括：

- 为提供商替换/追加模型
- 为新 API ID 注册自定义流处理器
- 注册自定义 OAuth 提供商

## 认证与 API 密钥解析顺序

为提供商请求密钥时，有效顺序为：

1. 运行时覆盖（CLI `--api-key`）
2. 配置覆盖（`models.yml` `providers.<name>.apiKey`）
3. 存储的 OAuth 凭据（带刷新）
4. 登录来源的存储 API 密钥
5. 环境变量映射（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）
6. 其他存储的 API 密钥，例如 broker 迁移的副本
7. ModelRegistry 回退解析器（`models.yml` 自定义提供商，使用环境变量名或字面量语义）

`models.yml` `apiKey` 行为：

- 值首先被视为环境变量名。
- 如果不存在该环境变量，则使用字面量字符串作为 token。

如果 `authHeader: true` 且设置了提供商 `apiKey`，模型会获得：

- 注入 `Authorization: Bearer <resolved-key>` header。

无密钥提供商：

- 标记 `auth: none` 的提供商视为无需凭据即可使用。
- 对它们 `getApiKey*` 返回 `kNoAuth`。

### Broker 模式

当设置 `OMP_AUTH_BROKER_URL`（或 `auth.broker.url`）时，本地 SQLite 凭据存储替换为 `RemoteAuthCredentialStore`。上述第 3、4、6 层（存储的 OAuth 与 API 密钥凭据）由 broker 提供的快照服务，其 `refresh` token 被脱敏；过期时触发 broker 上的 `POST /v1/credential/:id/refresh`，而非本地刷新。

`AuthStorage.setConfigApiKey` 允许 `models.yml` 的 `apiKey` 胜过 broker 解析的 OAuth token，而不覆盖运行时 `--api-key`。完整的 broker / 网关设计与环境变量面见 [`auth-broker-gateway.md`](./auth-broker-gateway.md)（`OMP_AUTH_BROKER_URL`、`OMP_AUTH_BROKER_TOKEN`、`auth.broker.url`、`auth.broker.token`）。

## 模型可用性 vs 全部模型

- `getAll()` 返回已加载的模型注册表（内置 + 合并的自定义 + 发现的）。
- `getAvailable()` 筛选为无密钥或可解析认证的模型。

因此，模型可以存在于注册表中，但在认证可用之前不可选择。

## 运行时模型解析

### CLI 与模式解析

`model-resolver.ts` 支持：

- 精确的 `provider/modelId`
- 精确模型 ID（推断提供商）
- 模糊/子串匹配
- `--models` 中的 glob 作用域模式（例如 `openai/*`、`*sonnet*`）
- 可选的 `:thinkingLevel` 后缀（`off|minimal|low|medium|high|xhigh|max`）

`--provider` 是旧版；优先使用 `--model`。精确的 `provider/modelId` 无歧义；裸 ID
与模糊模式针对可用的具体模型解析。

### 初始模型选择优先级

`findInitialModel(...)` 使用以下顺序：

1. 显式 CLI 提供商+模型
2. 第一个作用域内模型（若非恢复会话）
3. 保存的默认提供商/模型
4. 可用模型中已知的提供商默认值（例如 OpenAI/Anthropic 等）
5. 第一个可用模型

### 角色别名与设置

受支持的模型角色：

- `default`、`smol`、`slow`、`vision`、`plan`、`designer`、`commit`、`tiny`、`task`、`advisor`

`tiny` 角色覆盖用于轻量后台任务的在线模型（会话标题、记忆、`auto` 思考难度分类、意外停止检测）；未设置时，这些回退到 `@smol`。在 `/models` 中选择一个。

`@smol` 之类的角色别名通过 `settings.modelRoles` 展开；`*` 选择 `@default`。在 YAML 值中给 `@` 别名加引号（`fable: "@slow"`）。每个角色值还可以追加思考选择器，如 `:minimal`、`:low`、`:medium` 或 `:high`。

如果某个角色指向另一个角色，目标模型仍正常继承，且引用角色上的任何显式后缀在该角色特定用途中优先。

相关设置：

- `modelRoles`（record）
- `enabledModels`（作用域模式列表）
- `modelProviderOrder`（当等价具体选择共享同一 id 时的提供商优先级）
- `providers.kimiApiFormat`（`openai` 或 `anthropic` 请求格式）
- `providers.openaiWebsockets`（OpenAI Codex 传输的 `auto|off|on` websocket 偏好）

`modelRoles` 存储 `provider/modelId` 之类的模型选择器；`enabledModels` 与 CLI `--models`
接受精确选择器、glob 与模糊匹配。

全局 `enabledModels` 与 `disabledProviders` 条目也可以限定到路径前缀：

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/claude-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

字符串条目适用于所有位置。作用域条目在当前工作目录为配置路径或其子目录时适用。使用 `path`、`paths`、`pathPrefix` 或 `pathPrefixes`；`enabledModels` 使用 `models`，`disabledProviders` 使用 `providers`，两者都可以用 `values`。

## `/model` 与 `omp models`

两个界面都保持提供商前缀的具体模型可见且可选。选择提供商
行会存储其显式的 `provider/modelId`。

## 上下文提升（模型级回退链）

上下文提升是针对小上下文变体（例如 `*-spark`）的溢出恢复机制：当 API 因上下文长度错误拒绝请求时，自动提升到上下文更大的兄弟模型。

### 触发与顺序

当一轮次因上下文溢出错误（例如 `context_length_exceeded`）失败时，`AgentSession` 在回退到压缩**之前**尝试提升：

1. 如果 `contextPromotion.enabled` 为 true，解析提升目标（见下文）。
2. 如果找到目标，切换到它并重试请求——无需压缩。
3. 如果没有可用目标，回退到当前模型上的自动压缩。

### 目标选择

选择是显式且由模型驱动的：

1. `currentModel.contextPromotionTarget`（若已配置）

只考虑配置的目标；上下文提升不会自动选择同提供商/API 的更大兄弟模型。除非凭据可解析（`ModelRegistry.getApiKey(...)`），否则配置的目标被忽略。

### OpenAI Codex websocket 交接

如果从/向 `openai-codex-responses` 切换，会话提供商状态键 `openai-codex-responses` 会在模型切换前关闭。这会丢弃 websocket 传输状态，使下一轮次在提升后的模型上干净启动。

### 持久化行为

提升使用临时切换（`setModelTemporary`）：

- 在会话历史中记录为临时的 `model_change`
- 不重写保存的角色映射

### 配置显式回退链

直接在模型元数据中通过 `contextPromotionTarget` 配置回退。

`contextPromotionTarget` 接受：

- `provider/model-id`（显式）
- `model-id`（在当前提供商内解析）

示例（`models.yml`）为显式 OpenAI 回退：

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.5:
        contextPromotionTarget: openai-codex/gpt-5.4
```

内置模型策略目前将 OpenAI `codex-spark` 变体链接到 `gpt-5.5`，`gpt-5.5` 链接到 `gpt-5.4`（当该目标存在于同一提供商/API 时）。

## 兼容性与路由字段

提供商或模型上的 `compat` 块覆盖 `packages/catalog/src/compat/openai.ts`（`buildOpenAICompat`）中基于 URL 的自动检测。它由 `packages/coding-agent/src/config/models-config-schema.ts` 中的 `OpenAICompatSchema` 校验，并被每个 `openai-completions` 传输（`packages/ai/src/providers/openai-completions.ts`）消费。规范类型是 `packages/catalog/src/types.ts` 中的 `OpenAICompat`。

与这些字段交互的端点特定例外收录于[提供商端点约束](./provider-endpoint-constraints.md)。

`models.yml` 接受以下键（全部可选；未设置时回退到 URL 检测）：

请求塑形：

- `supportsStore` — 在请求中发送 `store: false`。默认：自动（非标准端点关闭）。
- `supportsDeveloperRole` — 对推理模型使用 `developer` 系统角色而非 `system`。默认：自动。
- `supportsMultipleSystemMessages` — 保留独立的开头 system/developer 消息而非合并。默认：自动（已知的 OpenAI 兼容托管 API 保留；严格模板/本地主机合并）。
- `supportsUsageInStreaming` — 发送 `stream_options: { include_usage: true }` 以在流式响应中接收 token 用量。默认：`true`。
- `maxTokensField` — `"max_completion_tokens"` 或 `"max_tokens"`。默认：自动。
- `supportsToolChoice` — 调用方强制特定工具时发送 `tool_choice` 参数。默认：`true`。对 `tool_choice` 返回 400 的端点（例如开启推理时的 DeepSeek）设为 `false`。
- `supportsForcedToolChoice` — 接受需要特定工具的强制 `tool_choice`。默认：`true`。为 `false` 时，强制选择器降级为 `auto`，使工具对拒绝强制工具调用的端点（例如一些需要思考的 OpenAI 兼容模型）仍然可用。
- `disableReasoningOnForcedToolChoice` — 每当 `tool_choice` 强制调用时丢弃 `reasoning_effort` / OpenRouter `reasoning`。默认：自动（Kimi/Anthropic 前端端点）。
- `disableReasoningOnToolChoice` — 每当发送任何 `tool_choice` 时丢弃推理字段。默认：自动（DeepSeek 推理模型）。
- `alwaysSendMaxTokens` — 调用方未提供时始终发送 max-token 字段。默认：自动（Kimi 系列模型从 `max_tokens` 推导 TPM 限制）。
- `strictResponsesPairing` — Responses API 工具调用/结果历史必须严格配对。默认：自动（Azure OpenAI、GitHub Copilot）。
- `streamIdleTimeoutMs` — 慢速推理主机的流看门狗空闲超时下限（毫秒）。默认：自动（GLM 编码计划主机、直接 DeepSeek 推理）。
- `cacheControlFormat` — `"anthropic"` 以在 chat-completions 负载中包含 Anthropic 风格提示词缓存标记。默认：自动（OpenRouter `anthropic/*` 模型）。
- `supportsLongPromptCacheRetention` — 主机在 Responses API 上支持 `prompt_cache_retention: "24h"`。默认：自动（api.openai.com）。
- `supportsImageDetailOriginal` — 允许 Responses API 的非标准 `detail: "original"` 图像模式（端点支持时）。
- `extraBody` — 合并到每个请求体中的额外顶级字段（网关提示、控制器选择器等）。

推理 / 思考：

- `supportsReasoningEffort` — 接受 `reasoning_effort`。默认：自动（Grok、Z.ai/Zhipu 与小米 MiMo 关闭）。
- `supportsReasoningParams` — 请求塑形是否可以发送推理参数。默认：自动（GitHub Copilot chat-completions 关闭）。
- `reasoningEffortMap` — 从内部努力级别（`minimal|low|medium|high|xhigh|max`）到提供商特定字符串的偏映射（例如 Fireworks GLM 映射 `minimal -> "none"`）。
- `thinkingFormat` — 思考的请求形状：`"openai"`（`reasoning_effort`）、`"openrouter"`（`reasoning: { effort }`）、`"zai"`（`thinking: { type: "enabled" }`）、`"qwen"`（顶层 `enable_thinking`）或 `"qwen-chat-template"`（`chat_template_kwargs.enable_thinking`）。默认：`"openai"`。
- `reasoningContentField` — 携带思维链的助手字段：`"reasoning_content"`、`"reasoning"` 或 `"reasoning_text"`。默认：自动。
- `requiresReasoningContentForToolCalls` — 助手工具调用轮次必须往返推理字段（DeepSeek-R1、Kimi、开启推理的 OpenRouter）。默认：`false`。
- `allowsSyntheticReasoningContentForToolCalls` — 当先前的助手工具调用轮次缺少提供商推理内容时，允许占位推理字段。默认：`true`；对校验精确推理值的提供商设为 `false`。
- `requiresAssistantContentForToolCalls` — 助手工具调用轮次必须包含非空文本内容（Kimi）。默认：`false`。
- `whenThinking` — 仅在请求实际启用思考模式时应用的偏 compat 覆盖（在基线 compat 之上深度合并）。

工具 / 消息规范化：

- `requiresToolResultName` — 工具结果消息需要 `name` 字段（Mistral）。默认：自动。
- `requiresAssistantAfterToolResult` — 工具结果之后的用户消息需要其间的助手轮次。默认：自动。
- `requiresThinkingAsText` — 将思考块转换为以 `<thinking>` 分隔符包裹的文本（Mistral）。默认：自动。
- `requiresMistralToolIds` — 将工具调用 ID 规范化为恰好 9 个字母数字字符。默认：自动。
- `supportsStrictMode` — 在工具 schema 上接受逐工具的 `strict` 字段。默认：按提供商/baseUrl 保守自动检测。
- `toolStrictMode` — `"all_strict"` 强制每个工具严格，`"none"` 强制关闭；未设置保持现有的逐工具混合行为。

网关路由（仅当 `baseUrl` 匹配网关时应用）：

- `openRouterRouting.only` / `openRouterRouting.order` — 在 `openrouter.ai` 上的提供商路由（见 <https://openrouter.ai/docs/provider-routing>）。
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — 在 `ai-gateway.vercel.sh` 上的提供商路由（见 <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>）。

提供商级 `compat` 是基线；每模型 `compat` 在其上深度合并，
`openRouterRouting`、`vercelGatewayRouting`、`extraBody` 与 `whenThinking` 作为嵌套对象合并。

### Anthropic 兼容性（`anthropic-messages`）

对于 `anthropic-messages` 模型，运行时使用单独的 `AnthropicCompat` 形状
（`packages/catalog/src/types.ts`）。`models.yml` schema 将严格工具退出开关暴露为
提供商级顶层字段，外加 `compat` 中的 `requiresToolResultId`、`replayUnsignedThinking`、
`supportsEagerToolInputStreaming` 与 `allowAnthropicHeaderOverrides`。其他
Anthropic 侧旋钮由内置目录元数据提供，此处不可配置。

### Bedrock 兼容性（`bedrock-converse-stream`）

同一个 `compat` 槽接受 Bedrock 模型的 `promptCacheMode`（`none`、`automatic` 或 `explicit`）、
`supportsLongPromptCacheRetention`、`promptCacheMinimumTokens` 与
`promptCacheMaximumCheckpoints`。

### 严格工具 schema（`disableStrictTools`）

Anthropic 的 API 支持工具定义上的 `strict` 字段，强制模型始终严格遵循所提供的 schema。OMP 默认对一小部分高频率内置 `anthropic-messages` 工具（`bash`、`python`、`edit` 与 `find`）启用它，这些工具的 schema 符合 Anthropic 的严格语法限制；其他工具仍发送规范化 schema，但省略 `strict`。

前端使用 Anthropic API 的第三方提供商（AWS Bedrock、Azure、自托管代理）并非都实现此字段，包含它的请求会被拒绝。在提供商级设置 `disableStrictTools: true` 以对白名单工具退出严格模式：

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools` 是提供商级标志，适用于该提供商的所有模型。它只对 OMP 原本会标记为 strict 的工具禁用 Anthropic `strict` 标记；不改变运行时工具参数校验。当 Anthropic 在首个流式 token 前报告 strict 语法过大错误时，OMP 可以自动无 strict 工具重试，但出于其他原因拒绝 `strict` 字段的代理应显式设置此标志。

上线工具 schema 由 `packages/ai/src/utils/schema/normalize.ts` 中的统一流程规范化
（Google/CCA/MCP 分发器加上 OpenAI strict 模式清理+强制管道）。strict 模式的
边界情况（本地 `$ref` 内联、单项 `allOf` 折叠、
`anyOf` 包装描述上提、enum/const 原始类型推断）与逐提供商分发器映射
见 [`ai-schema-normalize.md`](./ai-schema-normalize.md)。

## 实用示例

### 本地 OpenAI 兼容端点（无认证）

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

对于 oMLX 或另一个具有可发现 `/v1/models` 端点的本地 OpenAI 兼容服务器，优先使用发现而非手工列出模型。将 `api` 设置为你服务器实际暴露的端点族：`openai-completions` 使用 `/v1/chat/completions`；暴露 `/v1/responses` 的服务器需要 `openai-responses`。

```yaml
providers:
  omlx:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

内置 vLLM 提供商可以指向非默认端点，无需声明自定义发现类型。OMP 使用 vLLM 的 `/v1/models` 元数据，并将 vLLM 的 `max_model_len` 字段保留为发现的上下文窗口。

```yaml
providers:
  vllm:
    baseUrl: http://192.168.5.3:8085/v1
    auth: none
```

对于多个 vLLM 端点，使用任意提供商 ID 配合通用 OpenAI 兼容发现路径。本地无认证服务器设置 `auth: none`，认证服务器设置 `apiKey`。通用发现先读取 `max_model_len`，再读取 `context_length` 作为通用 OpenAI 兼容回退。

```yaml
providers:
  vllm-fast:
    baseUrl: http://host-a:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
  vllm-long:
    baseUrl: http://host-b:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

### 带环境变量密钥的托管代理

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true # if the proxy doesn't support strict tool schemas
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

### 覆盖内置提供商路由与模型元数据

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/claude-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

## 旧版消费者注意事项

大多数模型配置现在通过 `ModelRegistry` 流经 `models.yml` / `models.yaml`。显式 `.json` / `.jsonc` 路径仅在以编程方式传给 `ModelRegistry` 时受支持；默认用户配置优先 `~/.omp/agent/models.yml`，然后回退到 `~/.omp/agent/models.yaml`。

## 失败模式

如果 `models.yml` / `models.yaml` 未通过 schema 或校验检查：

- 注册表继续使用内置模型运行
- 错误通过 `ModelRegistry.getError()` 暴露，并在 UI/通知中呈现
