# Providers

提供商是 `omp` 可以路由请求的模型后端:Anthropic、OpenAI、Google Gemini、Groq、OpenRouter、Mistral、xAI、Ollama 等本地引擎、托管网关、自定义 `models.yml` 提供商,以及扩展注册的提供商。

一个**提供商**(provider)是账户或后端命名空间,如 `anthropic`、`openai`、`google` 或 `ollama`。一个**模型**(model)是该提供商下的具体模型,选择为 `provider/model-id`,如 `anthropic/claude-opus-4-6`。禁用提供商会将其下的每个模型从选择中移除;如果你只想收窄个别模型,请改用模型设置。

本页涵盖提供商如何变得可用、凭据如何解析、提供商/环境变量映射、本地引擎、禁用提供商和自定义提供商。关于端点的请求、推理、工具、流、用量和重试约束,参见 [Provider endpoint constraints](./provider-endpoint-constraints.md)。关于模型选择和完整的 `models.yml` schema,参见 [Model and Provider Configuration](./models.md)。关于配置文件位置和合并优先级,参见 [Settings](./settings.md)。关于凭据存储和登录流程的深入内容,参见 [Secrets and credentials](./secrets.md)。关于完整的环境变量参考,参见 [Environment variables](./environment-variables.md)。关于本地引擎设置,参见 [Local models](./local-models.md)。关于上下文文件发现提供商,参见 [Context files](./context-files.md)。

## `omp` 如何决定提供商可用

启动时模型注册表按顺序从四个来源组装其 catalog:

1. 捆绑的模型 catalog(每个内置提供商及其已知模型)。
2. `~/.omp/agent/models.yml` 中的自定义提供商和模型条目。
3. 支持发现的提供商(本地引擎和启用发现的网关)的运行时发现模型。
4. 扩展注册的提供商和模型。

注册表可以持有一个当前不可选择的模型。只有当两个条件同时成立时,模型才变得**可用**:

1. 其提供商 ID **不在**有效的 `disabledProviders` 列表中;**并且**
2. 提供商要么是**无密钥的**(隐式本地提供商,或 `auth: none` 的自定义提供商),**要么**拥有可解析的凭据。

`disabledProviders` 在凭据_之前_被检查。如果提供商 ID 被禁用,任何存储的 key、OAuth 会话、环境变量、`.env` 条目或 `models.yml` `apiKey` 都不会使其可选——无论凭据如何,该提供商的模型都会从可用性中移除。从有效列表中移除该 ID 即可恢复它们。

无密钥本地引擎是一个特例:`ollama`、`llama.cpp` 和 `lm-studio` 在未配置 key 时被视为无密钥,因此只要引擎响应,其发现的模型即可选择——无需登录。参见 [内置本地引擎](#内置本地引擎)。

## 凭据与优先级

当提供商需要 API key 时,`omp` 按此顺序解析(首个匹配者胜出):

1. **运行时覆盖**:为当前进程提供的 key,例如 CLI `--api-key`。从不持久化。
2. **`models.yml` 配置 key**:钉在自定义提供商上的 `apiKey`,注册为配置来源的 bearer。这有意压过存储的 OAuth,因此为自定义 `baseUrl` 或网关提供的 key 会被采纳,而不是转发代理会拒绝的上游 OAuth token。
3. **存储的 OAuth 凭据**:需要时刷新;多个账户自动排名和轮换。对于 Anthropic 和 ChatGPT (Codex),每个组织或工作区计为自己的账户:一个同时持有 Team 或 Enterprise 席位和个人计划的邮箱,可以按订阅登录一次(在浏览器同意页选择工作区),轮换会将它们视为两个账户。
4. **登录来源的存储 API key**:由成功的 `/login` 保存的 API key 凭据。
5. **提供商环境变量**:包括从 `.env` 文件加载的值(参见 [env-var 表](#环境变量与-env-文件))。
6. **其他存储的 API key**:例如,broker 迁移的 key。这是最后手段,以便显式环境变量胜出。
7. **`models.yml` 回退解析器**:未另行注册的自定义提供商的 key。

存储凭据位于认证存储中:本地认证为 `~/.omp/agent/agent.db`,或运行在 broker 模式时的已配置 auth-broker 快照。(`PI_CODING_AGENT_DIR` 重定位 `~/.omp/agent` 基础目录,认证存储随之移动。)

### OAuth 与 API key,以及提供商作用域登录

登录是**提供商作用域**的:认证 `anthropic` 不会认证 `openai`,每个提供商跟踪自己的凭据。即使有有效的存储认证,被禁用的提供商仍保持禁用。

在会话内使用交互式斜杠命令:

- `/login` — 打开 OAuth/key 选择器。`/login <provider>` 直接跳到某个提供商(例如 `/login anthropic`);对于需要粘贴回调的 OAuth 流程,运行 `/login <redirect-url>` 完成它。
- `/logout` — 打开提供商选择器以移除存储凭据。

对于由共享认证 broker 支撑的无头或远程设置,CLI 暴露 `omp auth-broker login <provider>` / `omp auth-broker logout`(以及 `status`、`list`、`import`、`migrate`)。关于 broker 模型参见 [Secrets and credentials](./secrets.md)。

当模型没有凭据时,`omp` 会告诉你运行 `/login` 或设置提供商的环境变量。

### 在 `models.yml` 中钉住 key

自定义提供商的 `apiKey` 解析为**环境变量名或字面量**:如果该值命名了一个现有环境变量,则使用该变量的值;否则字符串本身就是 key。给值加 `!` 前缀会作为 shell 命令运行,并使用裁剪后的 stdout(完整值语法参见 [Model and Provider Configuration](./models.md))。

```yaml
# ~/.omp/agent/models.yml
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY # reads this env var if set, else literal text
    models:
      - id: claude-sonnet
        name: Claude Sonnet via Gateway
        contextWindow: 200000
        maxTokens: 8192
```

如果自定义提供商设置了 `authHeader: true`,解析出的 key 会在对该提供商的每个请求中作为 `Authorization: Bearer <key>` 头注入。

## 环境变量与 `.env` 文件

每个提供商有一个或多个环境变量,在没有存储凭据时提供 key。下表是经过验证的提供商 → 变量映射;完整 catalog 很大,因此拆分为核心和附加提供商。OAuth 支持的提供商除了 API key 之外,还可以接受 token 变量(或替代 API key)。

### 核心提供商

| Provider ID      | Environment variable(s)                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anthropic`      | `ANTHROPIC_OAUTH_TOKEN`,然后 `ANTHROPIC_API_KEY`(Foundry 模式在 `CLAUDE_CODE_USE_FOUNDRY=true` 时优先 `ANTHROPIC_FOUNDRY_API_KEY`)         |
| `openai`         | `OPENAI_API_KEY`                                                                                                                                 |
| `openai-codex`   | `OPENAI_CODEX_OAUTH_TOKEN`                                                                                                                       |
| `google`         | `GEMINI_API_KEY`                                                                                                                                 |
| `google-vertex`  | `GOOGLE_CLOUD_API_KEY`,或 Application Default Credentials(`GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`) |
| `groq`           | `GROQ_API_KEY`                                                                                                                                   |
| `openrouter`     | `OPENROUTER_API_KEY`                                                                                                                             |
| `mistral`        | `MISTRAL_API_KEY`                                                                                                                                |
| `xai`            | `XAI_API_KEY`                                                                                                                                    |
| `xai-oauth`      | `XAI_OAUTH_TOKEN`,然后 `XAI_API_KEY`                                                                                                            |
| `github-copilot` | `COPILOT_GITHUB_TOKEN`                                                                                                                           |
| `cursor`         | `CURSOR_ACCESS_TOKEN`                                                                                                                            |
| `azure`          | `AZURE_OPENAI_API_KEY`                                                                                                                           |
| `amazon-bedrock` | `AWS_PROFILE`,或 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`,或 ECS/IRSA 凭据链                                                 |

### 附加托管提供商

| Provider ID                      | Environment variable(s)                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `aiand`                          | `AIAND_API_KEY`                                                               |
| `cerebras`                       | `CEREBRAS_API_KEY`                                                            |
| `alibaba-token-plan`             | `ALIBABA_TOKEN_PLAN_API_KEY`,然后 `BAILIAN_TOKEN_PLAN_API_KEY`               |
| `baseten`                        | `BASETEN_API_KEY`                                                             |
| `bedrock-mantle`                 | `AWS_BEARER_TOKEN_BEDROCK`                                                    |
| `deepseek`                       | `DEEPSEEK_API_KEY`                                                            |
| `siliconflow`                    | `SILICONFLOW_API_KEY`                                                         |
| `siliconflow-cn`                 | `SILICONFLOW_CN_API_KEY`                                                      |
| `fireworks`                      | `FIREWORKS_API_KEY`                                                           |
| `together`                       | `TOGETHER_API_KEY`                                                            |
| `coreweave`                      | `COREWEAVE_API_KEY`,然后 `WANDB_API_KEY`                                     |
| `nvidia`                         | `NVIDIA_API_KEY`                                                              |
| `devin`                          | `DEVIN_API_KEY`                                                               |
| `gmi-cloud`                      | `GMI_API_KEY`                                                                 |
| `huggingface`                    | `HUGGINGFACE_HUB_TOKEN`,然后 `HF_TOKEN`                                      |
| `moonshot`                       | `MOONSHOT_API_KEY`,然后 `KIMI_API_KEY`                                       |
| `meta`                           | `MODEL_API_KEY`,然后 `META_API_KEY`                                          |
| `nanogpt`                        | `NANO_GPT_API_KEY`                                                            |
| `novita`                         | `NOVITA_API_KEY`                                                              |
| `venice`                         | `VENICE_API_KEY`                                                              |
| `vercel-ai-gateway`              | `AI_GATEWAY_API_KEY`(catalog 发现也支持 `VERCEL_AI_GATEWAY_API_KEY`) |
| `cloudflare-ai-gateway`          | `CLOUDFLARE_AI_GATEWAY_API_KEY`                                               |
| `litellm`                        | `LITELLM_API_KEY`;代理端点可选 `LITELLM_BASE_URL`         |
| `kilo`                           | `KILO_API_KEY`                                                                |
| `zai`                            | `ZAI_API_KEY`                                                                 |
| `zenmux`                         | `ZENMUX_API_KEY`                                                              |
| `zhipu-coding-plan`              | `ZHIPU_API_KEY`                                                               |
| `umans`                          | `UMANS_AI_CODING_PLAN_API_KEY`                                                |
| `qianfan`                        | `QIANFAN_API_KEY`                                                             |
| `qwen-portal`                    | `QWEN_OAUTH_TOKEN`,然后 `QWEN_PORTAL_API_KEY`                                |
| `synthetic`                      | `SYNTHETIC_API_KEY`                                                           |
| `minimax-code`                   | `MINIMAX_CODE_API_KEY`                                                        |
| `minimax-code-cn`                | `MINIMAX_CODE_CN_API_KEY`                                                     |
| `minimax`                        | `MINIMAX_API_KEY`                                                             |
| `alibaba-coding-plan`            | `ALIBABA_CODING_PLAN_API_KEY`                                                 |
| `sakana`                         | `SAKANA_API_KEY`,然后 `FUGU_API_KEY`                                         |
| `aimlapi`                        | `AIMLAPI_API_KEY`                                                             |
| `gitlab-duo`, `gitlab-duo-agent` | `GITLAB_TOKEN`                                                                |
| `opencode-zen`, `opencode-go`    | `OPENCODE_API_KEY`                                                            |
| `firepass`                       | `FIREPASS_API_KEY`                                                            |
| `wafer-serverless`               | `WAFER_SERVERLESS_API_KEY`                                                    |
| `xiaomi`                         | `XIAOMI_API_KEY`                                                              |
| `xiaomi-token-plan-ams`          | `XIAOMI_TOKEN_PLAN_AMS_API_KEY`                                               |
| `xiaomi-token-plan-cn`           | `XIAOMI_TOKEN_PLAN_CN_API_KEY`                                                |
| `xiaomi-token-plan-sgp`          | `XIAOMI_TOKEN_PLAN_SGP_API_KEY`                                               |
| `ollama-cloud`                   | `OLLAMA_CLOUD_API_KEY`                                                        |
| `ollama`                         | `OLLAMA_API_KEY`(可选;本地发现默认无密钥)            |
| `lm-studio`                      | `LM_STUDIO_API_KEY`(可选;默认无密钥)                            |
| `llama.cpp`                      | `LLAMA_CPP_API_KEY`(仅当服务器要求认证时)                      |
| `vllm`                           | `VLLM_API_KEY`(未认证的本地服务器可选)                 |

`anthropic`、`github-copilot`、`cursor`、`ollama-cloud`、`qwen-portal`、`kimi-code`、`xai-oauth`、`wafer-serverless`、`google-gemini-cli` 和 `google-antigravity` 等 OAuth 支持提供商通常通过 `/login` 而不是环境变量访问。此处未列出的搜索工具和配置变量参见 [Environment variables](./environment-variables.md)。

### `.env` 发现与优先级

`omp` 在任何提供商查找之前急切地将 `.env` 文件加载到进程环境中。它读取四个文件,对每个变量,**首个**定义它的来源胜出。有效优先级从高到低:

1. `omp` 继承的进程环境(已设置的变量总是胜出)。
2. `<cwd>/.env`
3. `~/.omp/agent/.env`
4. `~/.omp/.env`
5. `~/.env`

已存在于进程环境中的变量永远不会被 `.env` 文件覆盖。在文件之间,`<cwd>/.env` 中设置的值胜过 `~/.omp/agent/.env`,后者胜过 `~/.omp/.env`,后者胜过 `~/.env`。因此 shell 导出的 `OPENAI_API_KEY` 胜过所有 `.env` 文件,项目的 `<cwd>/.env` 胜过你的主目录 `~/.env`。

项目本地 `.env` 是让一个仓库使用项目特定网关、key 或本地端点的最简单方式:

```dotenv
# <project>/.env
OPENROUTER_API_KEY=sk-or-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`.env` 解析有意保持最小:

- 空行和以 `#` 开头的行被忽略;
- key 必须匹配 `[A-Za-z_][A-Za-z0-9_]*`(shell 标识符形状)——其他名称被丢弃;
- 值可以用单引号或双引号包裹,引号会被剥离;
- 包含 NUL 字节的值被丢弃;
- 带 `OMP_` 前缀的 key 也会镜像为匹配的 `PI_` 前缀名称。

## 内置本地引擎

三个本地引擎无需 `models.yml` 条目即可自动发现。每个都使用一个可由环境变量覆盖的基础 URL:

| Provider ID | Base URL (env override → default)                                                 | Notes                                           |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `ollama`    | `OLLAMA_BASE_URL`,然后 `OLLAMA_HOST`(规范化),否则 `http://127.0.0.1:11434` | 默认无密钥。                             |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`,否则 `http://127.0.0.1:8080`                                | 除非为 `llama.cpp` 存储了 key,否则无密钥。 |
| `lm-studio` | `LM_STUDIO_BASE_URL`,否则 `http://127.0.0.1:1234/v1`                             | 默认无密钥。                             |

这些隐式引擎在以下情况下被**跳过**:

- 同 ID 的提供商已在 `models.yml` 中配置(你的显式配置胜出);或
- 提供商 ID 出现在有效的 `disabledProviders` 列表中。

关于安装和运行这些引擎,参见 [Local models](./local-models.md)。

## 禁用模型提供商

使用 `disabledProviders` 设置将提供商的模型从选择中移除:

```yaml
# ~/.omp/agent/config.yml or <project>/.omp/config.yml
disabledProviders:
  - anthropic
  - openai
  - google
  - groq
```

提供商 ID 精确匹配。禁用 `google` 隐藏 Google Gemini API 提供商;OAuth 支持的 Google 提供商 `google-gemini-cli` 和 `google-antigravity` 是单独的 ID,必须单独禁用。禁用 `ollama`、`llama.cpp` 或 `lm-studio` 以停止该引擎的本地发现。

`disabledProviders` 统一应用于:

- 捆绑 catalog 提供商;
- 自定义 `models.yml` 提供商;
- 运行时发现的提供商模型;
- 扩展注册的提供商;
- 隐式本地引擎。

禁用提供商不会删除其存储的凭据——从有效列表中移除其 ID 即可重新启用。

## 项目特定提供商控制

项目设置位于 `<project>/.omp/config.yml`。当一个仓库必须允许或隐藏与全局默认不同的提供商集时使用:

```yaml
# <project>/.omp/config.yml
disabledProviders:
  - openai
  - openrouter
```

设置数组被更高优先级层**整体替换**,而不是合并或追加。如果全局文件禁用了三个提供商,项目文件禁用一个,项目只看到项目列表:

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai
  - google

# <project>/.omp/config.yml
disabledProviders:
  - groq
```

项目内的有效结果:

```json
["groq"]
```

项目数组为从该项目启动的会话重新启用 `anthropic`、`openai` 和 `google`。如果你希望项目_添加_到全局集合,请在项目文件中重复全局 ID。完整优先级链(包括 `--config` 覆盖和运行时覆盖)参见 [Settings](./settings.md)。

## 路径作用域 `disabledProviders`

`disabledProviders` 可以混用纯字符串条目(到处应用)与路径作用域条目(仅当当前工作目录匹配配置的路径时应用):

```yaml
disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
  - paths:
      - ~/work/client-a
      - ~/work/client-b
    values:
      - openrouter
```

- 裸字符串条目总是应用。
- 作用域条目在当前工作目录**是**配置的路径或位于其**之下**时应用。`~` 展开为主目录。
- 接受的路径 key:`path`、`paths`、`pathPrefix`、`pathPrefixes`。
- 接受的值 key:`providers`、`values`、`items`。

对于上面的示例:

- `ollama` 到处被禁用。
- `anthropic` 和 `openai` 在 `~/projects/sensitive` 之下被额外禁用。
- `openrouter` 在 `~/work/client-a` 和 `~/work/client-b` 之下被额外禁用。

路径作用域在设置合并**之后**解析。因为更高优先级层替换整个数组,项目级 `disabledProviders` 数组会丢弃仅存在于全局数组中的任何作用域条目。`enabledModels` 是唯一支持相同路径作用域形式的其他设置。详情参见 [Settings](./settings.md)。

## 提供商 ID 与发现提供商 ID

`disabledProviders` 使用一个**共享 ID 命名空间**,门控两个不同的子系统:

- **模型提供商** — 本页上的后端(`anthropic`、`openai`、`ollama`、自定义 `models.yml` ID……)。禁用一个会将其模型从选择中移除。
- **发现提供商** — 上下文文件、MCP 服务器、命令、技能、钩子、工具、提示词和设置的来源。禁用一个会停止该来源贡献能力项。

| 条目类型            | 示例                                                                      | 效果                                                          |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 模型提供商 ID     | `anthropic`、`openai`、`google`、`groq`、`openrouter`、`ollama`、`my-gateway` | 将该提供商的模型从可用性中移除。               |
| 发现提供商 ID | `native`、`claude`、`codex`、`gemini`、`agents`、`github`                     | 停止该发现来源贡献能力项。 |

注意相关名称。Google Gemini **API** 模型使用模型提供商 ID `google`;`gemini` 是**发现**提供商 ID(读取 `GEMINI.md` 的来源),不是 Google 模型提供商。只有当你打算禁用整个配置来源时才使用发现 ID。发现提供商一侧参见 [Context files](./context-files.md)。

## `models.yml` 中的自定义提供商

自定义提供商位于 `~/.omp/agent/models.yml` 的 `providers:` 下。在那里定义的提供商 ID 与内置提供商一样参与相同的选择、凭据解析和 `disabledProviders` 规则。

最小 OpenAI 兼容提供商:

```yaml
providers:
  my-openai-compatible:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: MY_OPENAI_COMPATIBLE_KEY # env-var-name or literal
    models:
      - id: fast-chat
        name: Fast Chat
        contextWindow: 128000
        maxTokens: 8192
```

无密钥本地提供商(无需凭据):

```yaml
providers:
  local-proxy:
    baseUrl: http://127.0.0.1:4000/v1
    api: openai-completions
    auth: none
    models:
      - id: local-model
        name: Local Model
        contextWindow: 32768
        maxTokens: 4096
```

启用发现的提供商(运行时从端点获取模型):

```yaml
providers:
  team-proxy:
    baseUrl: https://models.example.com/v1
    apiKey: TEAM_PROXY_API_KEY
    authHeader: true # send Authorization: Bearer <resolved key>
    disableStrictTools: true
    discovery:
      type: proxy
```

完整的 schema、所有允许的 `api` 值、发现 `type`、模型覆盖和等价设置,参见 [Model and Provider Configuration](./models.md)。

要禁用自定义提供商,精确列出其 ID:

```yaml
disabledProviders:
  - my-openai-compatible
  - team-proxy
```

## 故障排查

**提供商的模型不可选择。** 确认提供商有凭据(`/login <provider>`、导出的环境变量或 `models.yml` 的 `apiKey`),且其 ID 不在有效的 `disabledProviders` 列表中。记住规则:未被禁用**且**(无密钥**或**有凭据)。无密钥本地引擎只在引擎实际运行并响应后出现。

**使用了错误的 key(来自 `.env` 的过期 key)。** 解析偏好运行时 `--api-key`,然后 `models.yml` 配置 key、存储的 OAuth、`/login` 保存的 key、环境或 `.env`、其他存储的 API key,最后是 `models.yml` 回退解析器。已设置的进程环境变量也胜过每个 `.env` 文件,`<cwd>/.env` 胜过 `~/.env`。如果意外的 key 胜出,检查导出的 shell 变量和按优先级顺序的四个 `.env` 文件,并清除不应生效的那个。

**即使我禁用了它,提供商仍出现。** `disabledProviders` 数组是被替换,而不是合并:项目的 `<project>/.omp/config.yml` 数组完全覆盖全局数组。验证你所在目录的_有效_列表(路径作用域条目只在其配置的路径处或之下应用),并确认 ID 拼写精确。使用 `omp config get disabledProviders` 检查合并后的值(参见 [Settings](./settings.md))。

**发现提供商名称对模型没有影响(或反之)。** ID 命名空间是共享的。`gemini`、`codex`、`claude`、`native` 和 `agents` 是发现来源 ID;Google 模型后端是 `google`。确保你禁用的是正确类型的提供商。

**自定义 `models.yml` 提供商无法加载。** YAML 或 schema 错误会使注册表跳过自定义文件。用 `omp models` 验证文件(用 `omp models find <substr>` 限定到某个提供商)。带自定义 `models` 的提供商需要 `baseUrl`、认证(`apiKey`,除非 `auth: none`)以及提供商级或每个模型上的 `api`。没有模型的提供商在定义至少一个受支持的覆盖(`baseUrl`、`headers`、`apiKey`、`auth: none`、`compat`、`disableStrictTools`、`remoteCompaction`、`modelOverrides` 或 `discovery`)时也有效。发现提供商可以省略 `models`,但除非 `discovery.type` 是 `proxy`,否则需要提供商级 `api`。显式的 `ollama`、`lm-studio` 或 `llama.cpp` 条目有意替换该 ID 的内置发现。参见 [Model and Provider Configuration](./models.md)。
