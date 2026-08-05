# 环境变量(当前运行时参考)

本参考来自当前代码路径:

- `packages/coding-agent/src/**`
- `packages/ai/src/**`(coding-agent 使用的提供商/认证解析)
- `packages/utils/src/**` 和 `packages/tui/src/**`(这些变量直接影响 coding-agent 运行时的部分)

它只记录活动行为。

## 解析模型与优先级

大多数运行时查找使用 `@oh-my-pi/pi-utils` 的 `$env`(`packages/utils/src/env.ts`)。

`$env` 加载顺序:

1. 现有进程环境(`Bun.env`)
2. 启动工作目录的项目 `.env`,用于当前值为空/未设置的键
3. 活动 Agent `.env`(通常是 `~/.omp/agent/.env`),用于当前值为空/未设置的键
4. 活动配置根 `.env`(通常是 `~/.omp/.env`),用于当前值为空/未设置的键
5. 家目录 `.env`(`~/.env`),用于当前值为空/未设置的键

Agent/根位置尊重 profiles、`PI_CONFIG_DIR`,以及——仅对默认 profile——`PI_CODING_AGENT_DIR`。Dotenv 名称必须是 shell 标识符(`[A-Za-z_][A-Za-z0-9_]*`);不安全的名称/值被丢弃。OMP 的解析器保持值字面;只有 Bun 自己的启动目录 dotenv 自动加载可能在本模块运行前执行 Bun 支持的展开。

每个 `.env` 文件内另有规则:每个 `OMP_*` 键被镜像到其 `PI_*` 别名,且该镜像值替换同文件的 `PI_*` 值。此镜像适用于解析的 dotenv 文件,而非从父进程继承的任意变量。

---

## 1) 模型/提供商认证

这些通过 `getEnvApiKey()`(`packages/ai/src/stream.ts`)消费,除非另有说明。

### 核心提供商凭据

| 变量                        | 用途                                         | 何时必需                                                  | 说明/优先级                                                                                  |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_TOKEN`         | Anthropic API 认证                               | 使用带 OAuth token 认证的 Anthropic                          | 提供商认证解析时优先于 `ANTHROPIC_API_KEY`                              |
| `ANTHROPIC_API_KEY`             | Anthropic API 认证                               | 使用不带 OAuth token 的 Anthropic                            | `ANTHROPIC_OAUTH_TOKEN` 之后的回退                                                              |
| `ANTHROPIC_FOUNDRY_API_KEY`     | 通过 Azure Foundry / 企业网关使用 Anthropic | `CLAUDE_CODE_USE_FOUNDRY` 启用                              | Foundry 模式启用时优先于 `ANTHROPIC_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`  |
| `OPENAI_API_KEY`                | OpenAI 认证                                      | 使用 OpenAI 家族提供商且无显式 apiKey 参数 | 由 OpenAI Completions/Responses 提供商使用                                                      |
| `GEMINI_API_KEY`                | Google Gemini 认证                               | 使用 `google` 提供商模型                                 | Gemini 提供商映射的主密钥                                                             |
| `GOOGLE_API_KEY`                | Gemini 图像工具认证回退                  | 无 `GEMINI_API_KEY` 时使用 `gemini_image` 工具             | 由 coding-agent 图像工具回退路径使用                                                       |
| `GROQ_API_KEY`                  | Groq 认证                                        | 使用 Groq 模型                                              |                                                                                                     |
| `CEREBRAS_API_KEY`              | Cerebras 认证                                    | 使用 Cerebras 模型                                          |                                                                                                     |
| `FIREWORKS_API_KEY`             | Fireworks 认证                                   | 使用 Fireworks 模型                                         |                                                                                                     |
| `FIREPASS_API_KEY`              | Fire Pass 认证                                   | 使用 Fire Pass 模型                                         |                                                                                                     |
| `TOGETHER_API_KEY`              | Together 认证                                    | 使用 `together` 提供商                                      |                                                                                                     |
| `AIMLAPI_API_KEY`               | AIML API 认证                                    | 使用 `aimlapi` 提供商                                       | OpenAI 兼容的 AIML API 端点,位于 `https://api.aimlapi.com/v1`                                 |
| `HUGGINGFACE_HUB_TOKEN`         | Hugging Face 认证                                | 使用 `huggingface` 提供商                                   | Hugging Face token 的主环境变量                                                                  |
| `HF_TOKEN`                      | Hugging Face 认证                                | 使用 `huggingface` 提供商                                   | `HUGGINGFACE_HUB_TOKEN` 未设置时的回退                                                      |
| `SYNTHETIC_API_KEY`             | Synthetic 认证                                   | 使用 Synthetic 模型                                         |                                                                                                     |
| `NVIDIA_API_KEY`                | NVIDIA 认证                                      | 使用 `nvidia` 提供商                                        |                                                                                                     |
| `NANO_GPT_API_KEY`              | NanoGPT 认证                                     | 使用 `nanogpt` 提供商                                       |                                                                                                     |
| `NOVITA_API_KEY`                | Novita 认证                                      | 使用 `novita` 提供商                                        |                                                                                                     |
| `VENICE_API_KEY`                | Venice 认证                                      | 使用 `venice` 提供商                                        |                                                                                                     |
| `LITELLM_API_KEY`               | LiteLLM 认证                                     | 使用 `litellm` 提供商                                       | OpenAI 兼容的 LiteLLM 代理密钥                                                                 |
| `LM_STUDIO_API_KEY`             | LM Studio 认证(可选)                        | 使用带认证主机的 `lm-studio` 提供商            | 本地 LM Studio 通常无需认证运行;需要密钥时任何非空 token 都可用         |
| `OLLAMA_API_KEY`                | Ollama 认证(可选)                           | 使用带认证主机的 `ollama` 提供商               | 本地 Ollama 通常无需认证运行;需要密钥时任何非空 token 都可用            |
| `LLAMA_CPP_API_KEY`             | llama.cpp 认证(可选)                        | 使用带认证主机的 `llama.cpp` 提供商            | 本地 llama.cpp 通常无需认证运行;配置了密钥时任何非空 token 都可用       |
| `XIAOMI_API_KEY`                | Xiaomi MiMo 认证                                 | 使用 `xiaomi` 提供商                                        |                                                                                                     |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | Xiaomi MiMo Token Plan 认证(AMS)                | 使用 `xiaomi-token-plan-ams` 提供商                         |                                                                                                     |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY`  | Xiaomi MiMo Token Plan 认证(CN)                 | 使用 `xiaomi-token-plan-cn` 提供商                          |                                                                                                     |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | Xiaomi MiMo Token Plan 认证(SGP)                | 使用 `xiaomi-token-plan-sgp` 提供商                         |                                                                                                     |
| `MOONSHOT_API_KEY`              | Moonshot 认证                                    | 使用 `moonshot` 提供商                                      |                                                                                                     |
| `XAI_API_KEY`                   | xAI 认证                                         | 使用 xAI 模型或作为 `xai-oauth` 的回退                |                                                                                                     |
| `XAI_OAUTH_TOKEN`               | xAI OAuth/SuperGrok 认证                         | 使用 `xai-oauth` 提供商                                     | 对 `xai-oauth` 优先于 `XAI_API_KEY`                                                 |
| `OPENROUTER_API_KEY`            | OpenRouter 认证                                  | 使用 OpenRouter 模型                                           | 当首选/自动提供商为 OpenRouter 时图像工具也使用                                  |
| `MISTRAL_API_KEY`               | Mistral 认证                                     | 使用 Mistral 模型                                           |                                                                                                     |
| `ZAI_API_KEY`                   | z.ai 认证                                        | 使用 z.ai 模型                                              | z.ai 网络搜索提供商也使用                                                               |
| `ZHIPU_API_KEY`                 | Zhipu Coding Plan 认证                           | 使用 `zhipu-coding-plan` 提供商                             |                                                                                                     |
| `UMANS_AI_CODING_PLAN_API_KEY`  | Umans AI Coding Plan 认证                        | 使用 `umans` 提供商                                         |                                                                                                     |
| `MINIMAX_API_KEY`               | MiniMax 认证                                     | 使用 `minimax` 提供商                                       |                                                                                                     |
| `MINIMAX_CODE_API_KEY`          | MiniMax Code 认证                                | 使用 `minimax-code` 提供商                                  |                                                                                                     |
| `MINIMAX_CODE_CN_API_KEY`       | MiniMax Code CN 认证                             | 使用 `minimax-code-cn` 提供商                               |                                                                                                     |
| `OPENCODE_API_KEY`              | OpenCode 认证                                    | 使用 `opencode-go` / `opencode-zen` 模型                    |                                                                                                     |
| `QIANFAN_API_KEY`               | Qianfan 认证                                     | 使用 `qianfan` 提供商                                       |                                                                                                     |
| `QWEN_OAUTH_TOKEN`              | Qwen Portal 认证                                 | 使用带 OAuth token 的 `qwen-portal`                           | 优先于 `QWEN_PORTAL_API_KEY`                                                         |
| `QWEN_PORTAL_API_KEY`           | Qwen Portal 认证                                 | 使用带 API 密钥的 `qwen-portal`                               | `QWEN_OAUTH_TOKEN` 之后的回退                                                                   |
| `ZENMUX_API_KEY`                | ZenMux 认证                                      | 使用 `zenmux` 提供商                                        | 用于 ZenMux OpenAI 和 Anthropic 兼容路由                                              |
| `VLLM_API_KEY`                  | vLLM 认证/发现选择加入                       | 使用 `vllm` 提供商(本地 OpenAI 兼容服务器)        | 对无认证本地服务器任何非空值都有效                                                 |
| `CURSOR_ACCESS_TOKEN`           | Cursor 提供商认证                             | 使用 Cursor 提供商                                          |                                                                                                     |
| `AI_GATEWAY_API_KEY`            | Vercel AI Gateway 认证                           | 使用 `vercel-ai-gateway` 提供商                             |                                                                                                     |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway 认证                       | 使用 `cloudflare-ai-gateway` 提供商                         | 基础 URL 必须配置为 `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` |
| `ALIBABA_CODING_PLAN_API_KEY`   | Alibaba Coding Plan 认证                         | 使用 `alibaba-coding-plan` 提供商                           |                                                                                                     |
| `ALIBABA_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan 认证                        | 使用 `alibaba-token-plan` 提供商                            | 首选提供商特定名称                                                                    |
| `BAILIAN_TOKEN_PLAN_API_KEY`    | QwenCloud Token Plan 认证                        | 使用 `alibaba-token-plan` 提供商                            | 与 Qwen Code 的 Token Plan 预设兼容                                                       |
| `DEEPSEEK_API_KEY`              | DeepSeek 认证                                    | 使用 DeepSeek 模型                                          |                                                                                                     |
| `SILICONFLOW_API_KEY`           | SiliconFlow 认证                                 | 使用 `siliconflow` 提供商                                   |                                                                                                     |
| `SILICONFLOW_CN_API_KEY`        | SiliconFlow(中国)认证                         | 使用 `siliconflow-cn` 提供商                                |                                                                                                     |
| `KILO_API_KEY`                  | Kilo 认证                                        | 使用 Kilo 模型                                              |                                                                                                     |
| `OLLAMA_CLOUD_API_KEY`          | Ollama Cloud 认证                                | 使用 `ollama-cloud` 提供商                                  |                                                                                                     |
| `WAFER_SERVERLESS_API_KEY`      | Wafer Serverless 认证                            | 使用 `wafer-serverless` 提供商                              | 按用量付费的 Wafer SKU;对照 `https://pass.wafer.ai/v1/models` 校验                        |
| `GITLAB_TOKEN`                  | GitLab Duo 认证                                  | 使用 `gitlab-duo` 提供商                                    |                                                                                                     |

### GitHub/Copilot token

| 变量               | 用途                       | 说明                                     |
| ---------------------- | ------------------------------ | ----------------------------------------- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot 提供商认证   | 此处不使用通用 GitHub token   |
| `GH_TOKEN`             | Web 抓取器中的 GitHub API 认证 | `GITHUB_TOKEN` 之后的 Web 抓取器回退 |
| `GITHUB_TOKEN`         | Web 抓取器中的 GitHub API 认证 | Web 抓取器先检查它再检查 `GH_TOKEN` |

### 认证代理 / 认证网关(远程凭据保管库)

启用代理时,本地 SQLite 凭据存储被绕过,所有 OAuth 刷新 / 访问 token 都存在于代理主机上。完整协议、CLI 表面和 5 分钟/15 秒用量缓存分层见 [`auth-broker-gateway.md`](./auth-broker-gateway.md)。

| 变量                            | 用途                                                                                     | 何时必需                                                                                                             | 说明/优先级                                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OMP_AUTH_BROKER_URL`               | 远程认证代理的基础 URL(如 `https://broker.tailnet:8765`);选择代理模式 | 通过代理解析凭据;`omp auth-gateway serve` 也需要(网关本身是代理客户端) | 胜过 `config.yml` 中的 `auth.broker.url`。设置但无可用 token 时,`resolveAuthBrokerConfig()` 硬错误而不是回退到本地 SQLite。                                                                                                                     |
| `OMP_AUTH_BROKER_TOKEN`             | 除 `/v1/healthz` 外每个代理端点发送的 Bearer token                              | 设置了 `OMP_AUTH_BROKER_URL` 且 `auth.broker.token` 或 `<config-dir>/auth-broker.token` 无可用 token       | 解析:此环境变量 → `auth.broker.token`(支持 `$ENV_NAME` 间接)→ `<config-dir>/auth-broker.token`(模式 `0600`)。`<config-dir>` 是 `~/.omp/`(尊重 `PI_CONFIG_DIR`)。                                                                                           |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | 加密本地代理快照缓存的新鲜度窗口                               | 代理模式中可选                                                                                                   | 默认 `3600000`(1 小时)。新鲜度基于代理 `snapshot.generatedAt`;`0` 禁用缓存读写并强制每次启动进行旧的阻塞式获取。                                                                                                                       |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | 加密本地代理快照缓存的路径                                            | 代理模式中可选                                                                                                   | 默认为 `~/.omp/cache/auth-broker-snapshot.enc`(或 XDG 缓存等价物)。对测试、临时主机或重定位 `0600` 缓存文件有用。                                                                                                                               |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | 受信代理客户端的进程作用域 OAuth 账户路由                             | 代理模式中可选                                                                                                   | 指向把提供商 ID 映射为精确 broker `identityKey` 数组的 JSON 对象的路径。缺失的提供商不受限;`[]` 隐藏该提供商的 OAuth 账户;API 密钥保持可见。启动时解析一次,输入无效时保守失败。这不是服务器授权。 |

网关没有专用环境变量——它继承 `OMP_AUTH_BROKER_*`。它自己的入站 Bearer token 位于 `<config-dir>/auth-gateway.token`,通过 `omp auth-gateway token` 管理。

---

## 2) 提供商特定运行时配置

### 出站代理路由

提供商 HTTP 获取在应用 `NO_PROXY` / `no_proxy` 后按此顺序解析代理:

1. `PI_PROXY_<PROVIDER>`(提供商 ID 大写,非字母数字替换为 `_`,例如 `PI_PROXY_GITHUB_COPILOT`)
2. `PI_PROXY`
3. 对 HTTPS 和 WebSocket 目标使用 `HTTPS_PROXY` / `https_proxy`,对 HTTP 使用 `HTTP_PROXY` / `http_proxy`
4. `ALL_PROXY` / `all_proxy`

提供商代理查找在进程生命周期内缓存。本地主机目标绕过提供商获取包装。

### Anthropic Foundry 网关(Azure / 企业代理)

启用 `CLAUDE_CODE_USE_FOUNDRY` 时,Anthropic 请求切换到 Foundry 模式:

- 基础 URL 从 `FOUNDRY_BASE_URL` 解析(未设置时回退保持模型/默认基础 URL)。
- 提供商 `anthropic` 的 API 密钥解析变为:
  `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`。
- `ANTHROPIC_CUSTOM_HEADERS` 被解析为逗号/换行分隔的 `key: value`
  对并合并进请求头。当
  `ANTHROPIC_BASE_URL` 指向非 Anthropic 主机(如企业 API
  网关)时也会转发,因此需要专有认证头的企业网关无需启用 Foundry
  模式即可工作。
- TLS 客户端/服务器材料可以从环境值注入:
  `NODE_EXTRA_CA_CERTS`、`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`。
  每个都接受:
  - PEM 内容的文件系统路径,或
  - 内联 PEM(包括转义的 `\n` 序列)。

  `NODE_EXTRA_CA_CERTS` 对每个提供商获取都被尊重(OpenAI 兼容、
  Codex、Ollama、Azure Responses、Google、Anthropic),而不仅 Foundry —— Bun 的
  `fetch` 不原生消费该环境变量,因此 bundle 被合并进
  `RequestInit.tls.ca`,与系统根存储一起。`CLAUDE_CODE_*` mTLS
  材料保持 Anthropic-Foundry 专属。

| 变量                    | 值类型                                     | 行为                                                                                                                                                      |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_USE_FOUNDRY`   | 类布尔字符串(`1`、`true`、`yes`、`on`) | 为 Anthropic 提供商启用 Foundry 模式                                                                                                                   |
| `FOUNDRY_BASE_URL`          | URL 字符串                                     | Foundry 模式下的 Anthropic 端点基础 URL                                                                                                                   |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token 字符串                                   | 用于 `Authorization: Bearer <token>`                                                                                                                      |
| `ANTHROPIC_CUSTOM_HEADERS`  | 头列表字符串                             | 额外头;格式 `header-a: value, header-b: value` 或换行分隔。每当 `ANTHROPIC_BASE_URL` 非 Anthropic 时也在 Foundry 之外转发。 |
| `NODE_EXTRA_CA_CERTS`       | PEM 路径或内联 PEM                         | 服务器证书校验的额外 CA 链                                                                                                              |
| `CLAUDE_CODE_CLIENT_CERT`   | PEM 路径或内联 PEM                         | mTLS 客户端证书                                                                                                                                       |
| `CLAUDE_CODE_CLIENT_KEY`    | PEM 路径或内联 PEM                         | mTLS 客户端私钥(必须与证书配对)                                                                                                            |

### Amazon Bedrock

| 变量                                                                        | 默认/行为                                                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`                                                                    | 主要区域来源                                                                                                                           |
| `AWS_DEFAULT_REGION`                                                            | `AWS_REGION` 未设置时的回退                                                                                                                  |
| `AWS_PROFILE`                                                                   | 启用命名 profile 认证路径                                                                                                                 |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`                                   | 启用 IAM 密钥认证路径                                                                                                                       |
| `AWS_BEARER_TOKEN_BEDROCK`                                                      | 最高优先级 Bearer token 认证路径;设置时跳过 AWS profile/凭据链查找                                                   |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | 在提供商检测中把 Bedrock 标记为可用(凭据解析本身涵盖环境键、profiles/SSO/`credential_process`,然后 IMDSv2) |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`                                  | 在提供商检测中把 Bedrock 标记为可用(与上面 ECS 变量相同的注意事项)                                                       |
| `AWS_BEDROCK_SKIP_AUTH`                                                         | 若为 `1`,注入假凭据(代理/无认证场景)                                                                                    |
| `HTTPS_PROXY` / `HTTP_PROXY`                                                    | 通过 Bun 的原生 fetch 代理支持被尊重(提供商不再附带 AWS SDK / 代理-agent 传输)                                  |
| `NO_PROXY`                                                                      | 从 Bun 的原生代理路由排除匹配主机                                                                                         |

提供商代码中的区域回退:`options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`。

原生 Bedrock 解析器实现的额外凭据链控制:

| 变量                                                                      | 行为                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `AWS_SESSION_TOKEN`                                                           | 与 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 配对的会话 token |
| `AWS_SHARED_CREDENTIALS_FILE`、`AWS_CONFIG_FILE`                              | 覆盖共享凭据/配置 INI 路径                        |
| `AWS_SDK_LOAD_CONFIG`                                                         | `1`/`true` 在无显式 profile 时启用共享配置加载    |
| `AWS_ROLE_SESSION_NAME`                                                       | Web 身份角色假设的会话名称                           |
| `AWS_CONTAINER_AUTHORIZATION_TOKEN`、`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | ECS 容器凭据的授权                             |
| `AWS_EC2_METADATA_DISABLED`                                                   | `true` 禁用 IMDSv2                                                  |
| `AWS_EC2_METADATA_SERVICE_ENDPOINT`、`AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE` | 覆盖 IMDS 端点 / 选择 IPv6 回退                       |

### Azure OpenAI Responses

| 变量                           | 默认/行为                                                          |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `AZURE_OPENAI_API_KEY`             | 除非 API 密钥作为选项传入,否则必需                                    |
| `AZURE_OPENAI_API_VERSION`         | 默认 `v1`                                                                |
| `AZURE_OPENAI_BASE_URL`            | 直接基础 URL 覆盖                                                    |
| `AZURE_OPENAI_RESOURCE_NAME`       | 用于构造基础 URL:`https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | 可选映射字符串:`modelId=deploymentName,model2=deployment2`        |

基础 URL 解析:选项 `azureBaseUrl` → 环境变量 `AZURE_OPENAI_BASE_URL` → 选项/环境变量资源名 → `model.baseUrl`。

### Google Vertex AI

| 变量                         | 必需?                      | 说明                                                                                                                     |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | 是(除非在选项中传入) | 主要项目 ID 来源                                                                                                 |
| `GCP_PROJECT`                    | 回退                       | 备用项目 ID 来源                                                                                               |
| `GCLOUD_PROJECT`                 | 回退                       | 备用项目 ID 来源                                                                                               |
| `GOOGLE_CLOUD_PROJECT_ID`        | 仅 OAuth 登录助手        | 由 Gemini CLI OAuth 项目发现使用                                                                                |
| `GOOGLE_VERTEX_LOCATION`         | 是(除非在选项中传入) | 主要 Vertex 位置来源                                                                                            |
| `GOOGLE_CLOUD_LOCATION`          | 回退                       | 备用 Vertex 位置来源                                                                                          |
| `VERTEX_LOCATION`                | 回退                       | 备用 Vertex 位置来源                                                                                          |
| `GOOGLE_CLOUD_API_KEY`           | 条件性                    | 直接 Vertex API 密钥认证;否则设置项目和位置后 ADC 回退可以认证                     |
| `GOOGLE_APPLICATION_CREDENTIALS` | 条件性                    | 若设置,文件必须存在;否则检查 ADC 回退路径(`~/.config/gcloud/application_default_credentials.json`) |

`GOOGLE_CLOUD_ACCESS_TOKEN`(或兼容的 `CLOUDSDK_AUTH_ACCESS_TOKEN` 回退)提供显式 Google OAuth 访问 token,并绕过 ADC token 获取。

### Kimi

| 变量               | 默认/行为                                       |
| ---------------------- | -------------------------------------------------------- |
| `KIMI_CODE_OAUTH_HOST` | 主要 OAuth 主机覆盖                              |
| `KIMI_OAUTH_HOST`      | 回退 OAuth 主机覆盖                             |
| `KIMI_CODE_BASE_URL`   | 覆盖 Kimi 用量端点基础 URL(`usage/kimi.ts`) |

OAuth 主机链:`KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`。

### OpenAI 兼容端点控制

| 变量                            | 默认/行为                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `OPENAI_BASE_URL`                   | 当模型/提供商提供默认值时,OpenAI 兼容请求的基础 URL 回退 |
| `MOONSHOT_BASE_URL`                 | Moonshot 聊天和模型发现端点覆盖                                         |
| `XAI_BASE_URL`                      | xAI HTTP 端点覆盖                                                                  |
| `SAKANA_BASE_URL` / `FUGU_BASE_URL` | Sakana/Fugu 端点覆盖(`SAKANA_BASE_URL` 胜出)                                      |
| `PI_OPENROUTER_RESPONSES`           | 除非设置为 `0`,否则启用 Responses API;`0` 选择 OpenAI Completions 路由        |
| `UMANS_WEBSEARCH_PROVIDER`          | 未显式提供时默认 Umans Anthropic 网络搜索提供商选择          |

### Gemini CLI 与 Antigravity 兼容

| 变量                    | 默认/行为                                              |
| --------------------------- | --------------------------------------------------------------- |
| `PI_AI_GEMINI_CLI_VERSION`  | 覆盖 Gemini CLI 用户代理版本标签(`0.46.0` 若未设置) |
| `PI_AI_ANTIGRAVITY_VERSION` | 覆盖 Antigravity hub 用户代理版本(`2.1.4` 若未设置) |

### GitLab Duo

| 变量                         | 默认/行为                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_CLIENT_ID`               | OAuth 客户端 ID。未设置时使用捆绑的 GitLab OAuth 应用客户端 ID。                                                                                                                                                                                                                               |
| `GITLAB_REDIRECT_URI`            | 向 GitLab 通告的确切 OAuth 重定向 URI。未设置时,本地回调使用 `http://localhost:8080/callback`,带随机端口回退。必须使用 HTTP 或 HTTPS;环回回调必须使用 HTTP 并绑定该 URI 的主机和端口。                                                                         |
| `GITLAB_DUO_NAMESPACE_ID`        | 工作流命名空间覆盖。运行时选项优先;否则命名空间/项目发现使用当前凭据和工作目录。                                                                                                                                                          |
| `GITLAB_DUO_PROJECT_ID`          | 按 ID 的工作流项目覆盖。运行时 `projectId`,然后运行时 `projectPath`,优先;此变量优先于 `GITLAB_DUO_PROJECT_PATH`。                                                                                                                                                |
| `GITLAB_DUO_PROJECT_PATH`        | 无运行时项目或 `GITLAB_DUO_PROJECT_ID` 设置时按路径的工作流项目覆盖。                                                                                                                                                                                                                     |
| `GITLAB_DUO_WORKFLOW_DEFINITION` | 工作流定义覆盖;运行时 `workflowDefinition` 优先。默认为 `ambient`。                                                                                                                                                                                                              |
| `GITLAB_DUO_WORKFLOW_TRACE`      | 仅当值恰好为 `1` 时启用工作流追踪。每个追踪事件按行追加为一个 JSON 对象;追踪写入失败被忽略。                                                                                                                                                      |
| `GITLAB_DUO_WORKFLOW_TRACE_FILE` | 追踪输出路径。值被修剪;未设置或空白默认为从提供商模块解析 `../../../../.tmp/gitlab-duo-workflow-trace.log` 得到的绝对路径(在源码检出中为 `<repo>/.tmp/gitlab-duo-workflow-trace.log`)。缺失的父目录自动创建。 |

`GITLAB_CLIENT_ID` 和 `GITLAB_REDIRECT_URI` 影响 OAuth 登录。四个路由/创建
覆盖(`GITLAB_DUO_NAMESPACE_ID`、`GITLAB_DUO_PROJECT_ID`、
`GITLAB_DUO_PROJECT_PATH` 和 `GITLAB_DUO_WORKFLOW_DEFINITION`)影响
`gitlab-duo-agent` 工作流命名空间/项目解析或工作流创建;它们
不配置 OAuth。上面两个追踪变量只影响本地诊断
输出。非环回
重定向 URI 无法由本地回调监听器直接服务,因此
通过粘贴代码路径完成。

### OpenAI Codex responses(功能/调试控制)

| 变量                                    | 行为                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CODEX_DEBUG`                            | `1`/`true` 启用 Codex 提供商调试日志                                                                                                                                                               |
| `PI_CODEX_WEBSOCKET`                        | `1`/`true` 启用 websocket 传输偏好                                                                                                                                                             |
| `PI_CODEX_RESPONSES_LITE`                   | `1`/`true` 强制 Responses Lite;`0`/`false` 强制标准 Responses 体;未设置使用模型目录默认值                                                                                        |
| `PI_OPENAI_STATEFUL`                        | 覆盖平台 OpenAI Responses API 的状态链默认值(`previous_response_id`,强制 `store: true`):针对 api.openai.com 默认开启,其他位置关闭                             |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS`        | 正整数覆盖(默认 `300000`)                                                                                                                                                                  |
| `PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS` | 首事件超时覆盖(默认 `300000`)                                                                                                                                                               |
| `PI_CODEX_WEBSOCKET_PING_INTERVAL_MS`       | Ping 间隔覆盖(默认 `10000`)                                                                                                                                                                      |
| `PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS`        | Pong 超时覆盖(默认 `60000`)                                                                                                                                                                       |
| `PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY` | 缓冲消息容量覆盖(默认 `4096`)                                                                                                                                                           |
| `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS`      | 连接不复用前的最大空闲时间(默认 `30000`)                                                                                                                                         |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET`           | 非负整数覆盖(默认 `5`)                                                                                                                                                                   |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS`         | 正整数基础退避覆盖(默认 `500`)                                                                                                                                                        |
| `PI_STREAM_FIRST_EVENT_TIMEOUT_MS`          | 通用流首事件超时;`0` 禁用                                                                                                                                                              |
| `PI_STREAM_IDLE_TIMEOUT_MS`                 | 通用流空闲超时;`0` 禁用                                                                                                                                                                     |
| `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS`   | OpenAI 特定首事件超时覆盖;`0` 禁用并优先于通用值。`omp config set providers.streamFirstEventTimeoutSeconds <seconds>` 提供持久化等价物 |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`          | OpenAI 特定空闲超时覆盖;`0` 禁用并优先于通用值。`omp config set providers.streamIdleTimeoutSeconds <seconds>` 提供持久化等价物              |

### Cursor 提供商调试

| 变量           | 行为                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `DEBUG_CURSOR`     | 启用提供商调试日志;`2`/`verbose` 用于详细负载片段 |
| `DEBUG_CURSOR_LOG` | JSONL 调试日志输出的可选文件路径                            |

### 提示缓存兼容开关

| 变量             | 行为                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CACHE_RETENTION` | 支持处的缓存保留覆盖(`anthropic`、`openai-responses`、Bedrock)。接受 `long`、`short` 或 `none`;其他值被忽略 |

---

## 3) 网络搜索子系统

### 搜索提供商凭据

| 变量                                            | 用途                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `EXA_API_KEY`                                       | Exa 搜索/MCP;或者用 `/login exa`                            |
| `BRAVE_API_KEY`                                     | Brave 搜索提供商                                                     |
| `PERPLEXITY_API_KEY`                                | Perplexity 搜索提供商 API 密钥模式                                   |
| `PERPLEXITY_COOKIES`                                | Perplexity cookie 认证搜索模式                                        |
| `PI_PERPLEXITY_RESPONSES`                           | `1` 选择 Perplexity Responses 端点而非 Chat Completions |
| `TAVILY_API_KEY`                                    | Tavily 搜索提供商                                                    |
| `ZAI_API_KEY`                                       | z.ai 搜索提供商(也检查 `agent.db` 中存储的 OAuth)             |
| `OPENAI_API_KEY` / Codex OAuth in DB                | Codex 搜索提供商可用性/认证                                   |
| `PI_CODEX_WEB_SEARCH_MODEL`                         | Codex 搜索提供商模型覆盖                                      |
| `GEMINI_SEARCH_MODEL`                               | Gemini 搜索模型覆盖                                              |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY`   | Kimi/Moonshot 搜索提供商环境认证                                    |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot 搜索端点覆盖                                    |
| `KAGI_API_KEY`                                      | Kagi 搜索提供商                                                      |
| `JINA_API_KEY`                                      | Jina 搜索提供商                                                      |
| `PARALLEL_API_KEY`                                  | Parallel 搜索提供商                                                  |
| `SEARXNG_ENDPOINT`、`SEARXNG_TOKEN`                 | SearXNG 端点和可选 Bearer token                                |
| `SEARXNG_BASIC_USERNAME`、`SEARXNG_BASIC_PASSWORD`  | SearXNG HTTP Basic Auth 凭据                                       |

SearXNG 还从 `~/.omp/agent/config.yml` 读取等价的 `searxng.endpoint`、`searxng.token`、`searxng.basicUsername` 和 `searxng.basicPassword` 设置;环境变量是回退。

### Anthropic 网络搜索认证链

`searchAnthropic()` 按此顺序解析凭据:

1. `ANTHROPIC_SEARCH_API_KEY`
2. `authStorage.getApiKey("anthropic")` 回退凭据(运行时和配置覆盖、存储的 OAuth、登录来源的 API 密钥、通用 Anthropic 环境回退,然后其他存储的 API 密钥;环境回退在 Foundry 模式为 `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`,否则为 `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`)

任一凭据路径的基础 URL 解析:

1. `ANTHROPIC_SEARCH_BASE_URL`
2. 启用 `CLAUDE_CODE_USE_FOUNDRY` 时的 `FOUNDRY_BASE_URL`
3. `ANTHROPIC_BASE_URL`
4. `https://api.anthropic.com`

相关变量:

| 变量                    | 默认/行为                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_SEARCH_API_KEY`  | 专用于 Anthropic 网络搜索提供商的 API 密钥。最高优先级搜索认证;对搜索调用覆盖 `ANTHROPIC_API_KEY` / OAuth / Foundry,而不影响聊天补全。                                         |
| `ANTHROPIC_SEARCH_BASE_URL` | 专用于 Anthropic 网络搜索提供商的基础 URL。应用于 `ANTHROPIC_SEARCH_API_KEY` 或回退 Anthropic 凭据;对搜索调用覆盖 `ANTHROPIC_BASE_URL`(Foundry 模式下还有 `FOUNDRY_BASE_URL`)。 |
| `ANTHROPIC_SEARCH_MODEL`    | 搜索模型覆盖。默认为 `claude-haiku-4-5`。                                                                                                                                                                                     |
| `ANTHROPIC_BASE_URL`        | 未设置搜索特定基础 URL 时 Anthropic 请求的通用回退基础 URL。                                                                                                                                                  |

用 `ANTHROPIC_SEARCH_BASE_URL`(可选搭配 `ANTHROPIC_SEARCH_API_KEY`)让聊天保持经企业网关路由(`ANTHROPIC_BASE_URL` 或 `CLAUDE_CODE_USE_FOUNDRY=true`),同时把网络搜索指向直接 Anthropic 端点,反之亦然。

### Perplexity OAuth 流程行为标志

| 变量            | 行为                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| `PI_AUTH_NO_BORROW` | 若设置,禁用 Perplexity 登录流程中的 macOS 原生应用 token 借用路径 |

---

## 4) Python 工具与内核运行时

| 变量               | 默认/行为                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `PI_PY`                | Python 的类布尔覆盖;未设置时交给 `eval.py`(默认启用)                       |
| `PI_JS`                | JavaScript 的类布尔覆盖;未设置时交给 `eval.js`(默认启用)                   |
| `PI_RB`                | Ruby 的类布尔覆盖;未设置时交给 `eval.rb`(默认禁用)                        |
| `PI_JL`                | Julia 的类布尔覆盖;未设置时交给 `eval.jl`(默认禁用)                       |
| `PI_PYTHON_SKIP_CHECK` | 真值标志跳过 Python 解释器可用性检查(子进程运行器仍按需启动) |
| `PI_RUBY_SKIP_CHECK`   | 真值标志跳过 Ruby 解释器可用性检查                                              |
| `PI_PYTHON_IPC_TRACE`  | 真值标志记录与 Python 运行器子进程交换的 NDJSON 帧                          |
| `PI_RUBY_IPC_TRACE`    | 真值标志记录 Ruby 运行器 IPC 帧                                                             |
| `PI_JULIA_IPC_TRACE`   | 真值标志记录 Julia 运行器 IPC 帧                                                            |
| `VIRTUAL_ENV`          | Python 运行时解析的最高优先级 venv 路径                                            |
| `CONDA_PREFIX`         | `VIRTUAL_ENV` 之后、本地 `.venv` / `venv` 目录之前的 Python 环境回退          |

Python 子进程过滤拒绝常见 API 密钥,并允许安全基础变量加 `LC_`、`XDG_` 和 `PI_` 前缀。

---

## 5) Agent/运行时行为开关

| 变量                     | 默认/行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`              | `smol` 的临时模型角色覆盖(CLI `--smol` 优先)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PI_SLOW_MODEL`              | `slow` 的临时模型角色覆盖(CLI `--slow` 优先)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PI_PLAN_MODEL`              | `plan` 的临时模型角色覆盖(CLI `--plan` 优先)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PI_NO_TITLE`                | 若设置(任何非空值),在首条用户消息时禁用自动会话标题生成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PI_TINY_DEVICE`             | 本地微小模型的 ONNX 执行提供商;覆盖 `providers.tinyModelDevice` 设置(默认:CPU;支持 `cpu`、`gpu`、`metal`/`webgpu`、`auto`、`cuda`、`dml`、`coreml`、`wasm`、`webnn`、`webnn-gpu`、`webnn-cpu`、`webnn-npu`)                                                                                                                                                                                                                                                                                                                                                          |
| `PI_TINY_DTYPE`              | 本地微小模型的 ONNX 量化/精度;覆盖 `providers.tinyModelDtype` 设置(默认:各模型随附的 dtype,当前为 `q4`;支持 `auto`、`fp32`、`fp16`、`q8`、`int8`、`uint8`、`q4`、`bnb4`、`q4f16`、`q2`、`q2f16`、`q1`、`q1f16`)                                                                                                                                                                                                                                                                                                                                     |
| `PI_NO_INTERLEAVED_THINKING` | 若为 `1`,禁用 Anthropic 交错思考预算行为,并对较旧思考模式使用输出 token 膨胀                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_NO_THINKING_LOOP_GUARD`  | 若为 `1`,禁用模型思考循环守卫                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NULL_PROMPT`                | 若为 `true`,系统提示构建器返回空字符串                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PI_BLOCKED_AGENT`           | 在 task 工具中阻止特定子代理类型                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PI_SUBPROCESS_CMD`          | 覆盖子代理生成命令(`omp` / `omp.cmd` 解析绕过)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PI_TASK_MAX_OUTPUT_BYTES`   | 每个子代理捕获的最大输出字节数(默认 `500000`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PI_TASK_MAX_OUTPUT_LINES`   | 每个子代理捕获的最大输出行数(默认 `5000`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PI_TIMING`                  | 若设置(任何非空值),通过 `logger.printTimings()` 向 **stderr** 打印分层计时跨度树。交互模式下,树在 Agent 就绪后打印一次(在 TUI 启动前);打印模式下,在整批提示完成后打印。打印模式提示被包裹在 `print:prompt:initial` / `print:prompt:next` 跨度中,使每条用户消息显示为自己的行。`PI_TIMING=x` 在交互模式打印后立即以代码 0 退出进程(仅用于测量冷启动)。`PI_TIMING=full` 列出每个模块加载条目,而不仅是前 N 个。 |
| `PI_DEBUG_STARTUP`           | 若设置(任何非空值),在每个启动阶段开始/结束时向 **stderr** 流式输出一行同步的 `[startup] <phase>:start` / `:done` 标记——包括命令模块导入(`cli:load:<name>`)和原生插件解包/`dlopen`(`native:*`)。与 `PI_TIMING`(只在启动完成后打印一次)不同,标记能撑过硬挂起:stderr 上最后一行命名进程卡住的阶段。可与 `PI_TIMING` 自由组合;标记和跨度树共享相同的阶段名。                                                                                |
| `PI_PACKAGE_DIR`             | 覆盖包资源基础目录解析(`docs/`、`examples/`、`CHANGELOG.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `OMP_SKIP_SETUP`             | 除 `0`、`false` 或 `no` 外的任何非空值跳过自动交互设置场景;显式强制的设置忽略它                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PI_DISABLE_LSPMUX`          | 若为 `1`,禁用 lspmux 检测/集成并强制直接 LSP 服务器生成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PI_RPC_EMIT_TITLE`          | 在 RPC 模式启用标题事件的类布尔标志                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SMITHERY_URL`               | Smithery Web URL 覆盖(默认 `https://smithery.ai`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SMITHERY_API_URL`           | Smithery API 基础 URL 覆盖(默认 `https://api.smithery.ai`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SMITHERY_API_KEY`           | 托管 MCP 认证查找的 Smithery API 密钥                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PUPPETEER_EXECUTABLE_PATH`  | 浏览器工具 Chromium 可执行文件覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LITELLM_BASE_URL`           | LiteLLM 代理基础 URL 回退(未设置时 `http://localhost:4000/v1`);显式 `providers.litellm.baseUrl` / `models.yml` 配置胜出                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LM_STUDIO_BASE_URL`         | 默认隐式 LM Studio 发现基础 URL 覆盖(未设置时 `http://127.0.0.1:1234/v1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OLLAMA_BASE_URL`            | 默认隐式 Ollama 发现基础 URL 覆盖(未设置时 `OLLAMA_HOST`,然后 `http://127.0.0.1:11434`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `OLLAMA_HOST`                | `OLLAMA_BASE_URL` 未设置时用于隐式 Ollama 发现的 Ollama 主机;接受 `127.0.0.1:11434` 或 `http://host:11434` 等 Ollama 风格值                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OLLAMA_CONTEXT_LENGTH`      | 隐式 Ollama 发现的正整数上下文窗口覆盖;只影响 OMP 上下文预算,不改变 Ollama 运行时的 `num_ctx`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LLAMA_CPP_BASE_URL`         | 默认隐式 Llama.cpp 发现基础 URL 覆盖(未设置时 `http://127.0.0.1:8080`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PI_EDIT_VARIANT`            | 有效时强制编辑工具变体(`patch`、`replace`、`hashline`、`apply_patch`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PI_INTENT_TRACING`          | 工具意图元数据的类布尔覆盖;回退到 `tools.intentTracing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PI_STRICT_EDIT_MODE`        | 若为 `1`,禁用内置的模型特定编辑模式回退,因此使用配置/全局 `edit.mode`,除非 `PI_EDIT_VARIANT` 或 `edit.modelVariants` 覆盖它                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PI_FORCE_IMAGE_PROTOCOL`    | 在使用处强制支持的图像协议(`kitty`、`iterm2`/`iterm`、`sixel`、`none`)。在 tmux 内设置 `kitty` 也选择 Kitty Unicode 占位符放置,除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 禁用                                                                                                                                                                                                                                                                                                                                                       |
| `PI_ALLOW_SIXEL_PASSTHROUGH` | 允许 `PI_FORCE_IMAGE_PROTOCOL=sixel` 时的 SIXEL 直通                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PI_NO_PTY`                  | 若为 `1`,为 bash 工具禁用交互 PTY 路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `OMP_MCP_TIMEOUT_MS`         | 覆盖每个 MCP 服务器的 MCP 客户端请求超时(毫秒)。`0` 禁用客户端侧超时(`AbortSignal` 永不触发)。无效(负数或非数字)值被忽略并带警告,使用每服务器配置或默认值(`30000`)。                                                                                                                                                                                                                                                                                                                                                 |
| `PI_DISABLE_UUTILS_BUILTINS` | 除 `0`/`false` 外的非空值禁用 bash 工具的 uutils 内置;`shell.env.PI_DISABLE_UUTILS_BUILTINS` 胜出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `OMP_NO_WEBP`                | `1` 或 `true`(不区分大小写)在图像缩放格式选择中禁用 WebP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MNEMOPI_EMBEDDING_MODEL`    | 无显式覆盖时 mnemopi 记忆配置的嵌入模型覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Hindsight 记忆后端

`loadHindsightConfig()` 把每个受支持的环境覆盖解析到对应的
`hindsight.*` 设置之上,然后是其内置默认值。字符串值被修剪,空
字符串被忽略。布尔值不区分大小写:只有 `true`、`1` 和 `yes` 表示真;
任何其他已定义值表示假。整数值使用十进制 `parseInt`;非数字值
被忽略,加载器不钳制解析后的整数。枚举值必须与
列出的小写值之一完全匹配;无效值被忽略。

| 变量                           | 被覆盖的设置              | 接受的值 / 内置默认值                                                 |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `HINDSIGHT_API_URL`                | `hindsight.apiUrl`              | 非空字符串;默认 `http://localhost:8888`                                 |
| `HINDSIGHT_API_TOKEN`              | `hindsight.apiToken`            | 非空字符串;默认未设置                                                |
| `HINDSIGHT_BANK_ID`                | `hindsight.bankId`              | 非空字符串;默认未设置,因此选定的作用域模式派生 bank |
| `HINDSIGHT_BANK_MISSION`           | `hindsight.bankMission`         | 非空字符串;默认空字符串                                            |
| `HINDSIGHT_RETAIN_MODE`            | `hindsight.retainMode`          | `full-session` 或 `last-turn`;默认 `full-session`                             |
| `HINDSIGHT_RECALL_BUDGET`          | `hindsight.recallBudget`        | `low`、`mid` 或 `high`;默认 `mid`                                            |
| `HINDSIGHT_AUTO_RECALL`            | `hindsight.autoRecall`          | 布尔;默认 `true`                                                           |
| `HINDSIGHT_AUTO_RETAIN`            | `hindsight.autoRetain`          | 布尔;默认 `true`                                                           |
| `HINDSIGHT_SCOPING`                | `hindsight.scoping`             | `global`、`per-project` 或 `per-project-tagged`;默认 `per-project-tagged`    |
| `HINDSIGHT_DEBUG`                  | `hindsight.debug`               | 布尔;默认 `false`                                                          |
| `HINDSIGHT_RECALL_MAX_TOKENS`      | `hindsight.recallMaxTokens`     | 整数;默认 `1024`                                                           |
| `HINDSIGHT_RECALL_CONTEXT_TURNS`   | `hindsight.recallContextTurns`  | 整数;默认 `1`                                                              |
| `HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `hindsight.recallMaxQueryChars` | 整数;默认 `800`                                                            |
| `HINDSIGHT_RETAIN_EVERY_N_TURNS`   | `hindsight.retainEveryNTurns`   | 整数;默认 `3`                                                              |
| `HINDSIGHT_REQUEST_TIMEOUT_MS`     | `hindsight.requestTimeoutMs`    | 整数毫秒;默认 `30000`                                             |
| `HINDSIGHT_REFLECT_TIMEOUT_MS`     | `hindsight.reflectTimeoutMs`    | 整数毫秒;默认 `120000`                                            |
| `HINDSIGHT_RECALL_TIMEOUT_MS`      | `hindsight.recallTimeoutMs`     | 整数毫秒;默认 `30000`                                             |
| `HINDSIGHT_RETAIN_TIMEOUT_MS`      | `hindsight.retainTimeoutMs`     | 整数毫秒;默认 `60000`                                             |

CLI `--no-pty` 使用时也会内部设置 `PI_NO_PTY`。

---

## 6) 存储与配置根路径

这些影响 coding-agent 把数据存在哪里,以及它加载哪些进程本地设置覆盖。

| 变量                                            | 默认/行为                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `OMP_PROFILE`                                       | 规范命名 profile 选择器;即使显式为空也胜过 `PI_PROFILE`                                        |
| `PI_PROFILE`                                        | 仅当 `OMP_PROFILE` 未定义时使用的遗留 profile 选择器                                                          |
| `PI_CONFIG_DIR`                                     | 家目录下的配置根目录名(默认 `.omp`)                                                                            |
| `PI_CODING_AGENT_DIR`                               | 仅默认 profile 的完整 Agent 目录覆盖;命名 profile 忽略它                                       |
| `PI_CODING_AGENT_SESSION_DIR`                       | 启动参数解析消费的初始会话目录覆盖                                                     |
| `PI_CONFIG_FILES`                                   | 设置覆盖的平台路径列表(Unix 用 `:`,Windows 用 `;`);在显式 `--config` 覆盖之前按序加载 |
| `OMP_AUTORESEARCH_DB_DIR`                           | 每项目 autoresearch DB 和项目产物根目录的目录覆盖                                              |
| `XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` | 在 macOS/Linux 上,仅当目标 `omp` 根(或命名 profile 根)已存在时重定向对应 OMP 路径    |
| `PWD`                                               | 在路径助手中匹配规范当前工作目录时使用                                                     |

---

## 7) Shell/工具执行环境

(来自 `packages/utils/src/procmgr.ts` 与 coding-agent bash 工具集成。)

| 变量                   | 行为                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| `PI_BASH_NO_CI`            | 抑制向生成的 shell 环境自动注入 `CI=true`                |
| `CLAUDE_BASH_NO_CI`        | `PI_BASH_NO_CI` 的遗留别名回退                                      |
| `PI_BASH_NO_LOGIN`         | 禁用登录 shell 模式;shell 参数变为 `['-c']` 而非 `['-l','-c']` |
| `CLAUDE_BASH_NO_LOGIN`     | `PI_BASH_NO_LOGIN` 的遗留别名回退                                   |
| `PI_SHELL_PREFIX`          | 可选命令前缀包装器                                                |
| `CLAUDE_CODE_SHELL_PREFIX` | `PI_SHELL_PREFIX` 的遗留别名回退                                    |
| `VISUAL`                   | 首选外部编辑器命令                                              |
| `EDITOR`                   | 回退外部编辑器命令                                               |

当前实现:`PI_BASH_NO_LOGIN`/`CLAUDE_BASH_NO_LOGIN` 活动;任一设置时,`getShellArgs()` 返回 `['-c']`。

`PI_BASH_NO_CI`、`PI_BASH_NO_LOGIN` 和 `PI_SHELL_PREFIX` 只在规范变量未设置时使用其 `CLAUDE_*` 别名。

---

## 8) UI/主题/会话检测(自动检测的环境)

这些作为运行时信号读取;通常由终端/OS 设置,而非手动配置。

| 变量                                                                           | 用途                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `COLORTERM`、`TERM`、`WT_SESSION`                                                  | 颜色能力检测(主题颜色模式) |
| `COLORFGBG`                                                                        | 终端背景亮/暗自动检测 |
| `TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`TERMINAL_EMULATOR`                        | 系统提示/上下文中的终端身份    |
| `TMUX_PANE`、`CMUX_SURFACE_ID`、`KITTY_WINDOW_ID`、`TERM_SESSION_ID`、`WT_SESSION` | 稳定的每终端会话面包屑 ID    |
| `SHELL`、`ComSpec`、`TERM_PROGRAM`、`TERM`                                         | 系统信息诊断                       |
| `APPDATA`、`XDG_CONFIG_HOME`                                                       | lspmux 配置路径解析                 |
| `HOME`                                                                             | MCP 命令 UI 中的路径缩短                 |

`COPILOT_HOME` 覆盖 GitHub Copilot 配置家目录(默认 `~/.copilot`),`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 提供额外的逗号分隔指令目录。`JS_DEBUG_DAP_SERVER` 选择现有的 JavaScript 调试适配器服务器;`XDG_DATA_HOME` 也参与捆绑调试器发现。

---

## 9) TUI 运行时标志(共享包,影响 coding-agent UX)

| 变量                       | 行为                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_NOTIFICATIONS`             | `off` / `0` / `false` 抑制桌面通知                                                                                                                                                                                               |
| `PI_TUI_WRITE_LOG`             | 若设置,把 TUI 写入记录到文件                                                                                                                                                    |
| `PI_TUI_RAW_BACKSPACE_IS_CTRL` | 若为 `1`,把原始 `0x08` 解释为 Ctrl+Backspace 而非 Backspace;当 SSH/容器跳转隐藏 Windows Terminal 客户端时使用                                                                                                                   |
| `PI_HARDWARE_CURSOR`           | 若为 `1`,启用硬件光标模式                                                                                                                                               |
| `PI_NO_SYNC_OUTPUT`            | 若设置(任何非空值),禁用 DEC 2026 同步输出包装,同时保留 TUI 自动换行守卫                                                                                                                                     |
| `PI_NO_DECCARA`                | 若设置(真值),禁用 Kitty DECCARA 矩形 SGR 背景填充(强制填充字符串渲染)                                                                                                                                          |
| `PI_DEBUG_REDRAW`              | 若为 `1`,启用重绘调试日志                                                                                                                                               |
| `PI_FORCE_IMAGE_PROTOCOL`      | 强制终端图像协议检测(`kitty`、`iterm2`/`iterm`、`sixel`、`none`)。在 tmux 内设置 `kitty` 也选择 Kitty Unicode 占位符放置,除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 禁用 |
| `PI_KITTY_PLACEHOLDERS`        | `1` 强制开启 Kitty Unicode 占位符放置;`0` 强制关闭。在 tmux/screen 下,仅在确认外层终端支持 Kitty `U=1` 占位符后使用 `1`——否则 U+10EEEE 可能渲染为字面 PUA 框                     |
| `PI_NO_KITTY_PLACEHOLDERS`     | `1` 硬禁用 Kitty Unicode 占位符放置,优先于 `PI_KITTY_PLACEHOLDERS`                                                                                                                                            |
| `PI_TUI_RESIZE_IN_PLACE`       | `1`/`true` 强制就地调整大小(不借用 alt-screen,无 ED3 重排);`0`/`false` 强制 alt-screen 快速路径。对 Warp 默认开启,Warp 在 alt-screen 切换时会重新报告其大小                                                           |

### 浏览器启动/代理控制

| 变量                               | 行为                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PUPPETEER_PROXY`                      | 添加 Chromium 的 `--proxy-server` 启动参数                                         |
| `PUPPETEER_PROXY_BYPASS_LOOPBACK`      | 类布尔标志把 `<-loopback>` 添加到绕过列表,使 localhost 也使用代理 |
| `PUPPETEER_PROXY_IGNORE_CERT_ERRORS`   | 类布尔标志让 Chromium 忽略证书错误启动                      |
| `CMUX_WORKSPACE_ID`、`CMUX_SURFACE_ID` | 浏览器打开分屏时目标 cmux 工作区/表面                             |
| `CMUX_RELAY_ID`、`CMUX_RELAY_TOKEN`    | cmux relay 身份/认证回退                                                        |

---

## 10) 提交生成控制

| 变量                  | 行为                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| `PI_COMMIT_TEST_FALLBACK` | 若为 `true`(不区分大小写),强制提交回退生成路径 |
| `PI_COMMIT_NO_FALLBACK`   | 若为 `true`,Agent 未返回建议时禁用回退         |
| `PI_COMMIT_MAP_REDUCE`    | 若为 `false`,禁用 map-reduce 提交分析路径                |
| `DEBUG`                   | 若设置,打印提交 Agent 错误堆栈跟踪                 |

---

## 11) OpenTelemetry 导出

OMP 仅当至少一个信号有端点时初始化 OTLP 导出。`OTEL_SDK_DISABLED=true` 禁用初始化。

| 变量组                                                                                                  | 行为                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                                   | 公共端点回退                                                                        |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`、`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 按信号端点;胜过公共端点                                              |
| `OTEL_TRACES_EXPORTER`、`OTEL_LOGS_EXPORTER`、`OTEL_METRICS_EXPORTER`                                           | 包含 `none` 的列表禁用该信号                                                   |
| `OTEL_EXPORTER_OTLP_PROTOCOL` 和按信号 `..._PROTOCOL` 变体                                            | 此运行时只启用 `http/protobuf`;另一个显式协议禁用该信号 |
| `OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES`                                                                 | OpenTelemetry 资源元数据                                                                 |
| `OTEL_LOG_LEVEL`                                                                                                | 最小导出的 OMP 日志级别                                                                  |

---

## 安全敏感变量

把这些当作机密;不要记录或提交:

- 提供商/API 密钥和 OAuth/bearer 凭据(所有 `*_API_KEY`、`*_TOKEN`、OAuth 访问/刷新 token)
- 云凭据(`AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS` 路径可能暴露服务账户材料)
- 搜索/提供商认证变量(`EXA_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY`、Anthropic 搜索密钥)
- Foundry mTLS 材料(`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`、指向私有 CA 捆绑包时的 `NODE_EXTRA_CA_CERTS`)

Python 运行时还会在生成内核子进程前显式剥离许多常见密钥变量(`packages/coding-agent/src/eval/py/runtime.ts`)。
