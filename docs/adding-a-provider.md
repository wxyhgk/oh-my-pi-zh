# 添加提供商

提供商由两半组成:

- **目录半**(`packages/catalog`):`CATALOG_PROVIDERS` 表
  (`packages/catalog/src/provider-models/descriptors.ts`) 中的一条记录,携带
  `id`、`defaultModel`、运行时模型发现工厂和目录生成接线。`KnownProvider`、`PROVIDER_DESCRIPTORS` 和
  `DEFAULT_MODEL_PER_PROVIDER` 均由此表派生。
- **认证半**(`packages/ai`):注册表中一个声明式的 `ProviderDefinition`,携带环境变量键回退和登录/刷新流程。`OAuthProvider` 联合类型、环境变量键映射、`/login` 提供商列表、`refreshOAuthToken` / `AuthStorage.login` 分派,以及 coding-agent 回调映射均从注册表派生。

**范围。** 本文面向复用现有线上 API(`openai-completions`、`anthropic-messages`、`google-generative-ai`、…)的提供商 —— 这是网关和 API-key 提供商的常见情形,因为流式分派以 `model.api` 为键,而不是 `model.provider`。添加_新的线上协议_(新的 `KnownApi`)是另一项任务,还需要改动 `stream.ts` 分派、`api-registry.ts` 和目录的 `types.ts`。

## 形态

对于常见情形,一个提供商 = **一条目录记录 + 一个 def 文件 + 一行注册表**:

1. 在 `packages/catalog/src/provider-models/descriptors.ts` 的 `CATALOG_PROVIDERS` 中**添加一条记录**,包含 `id`、`defaultModel`、作为 `envVars` 的普通 API-key 环境变量,以及(通常)一个 `createModelManagerOptions` 工厂。对于简单的 OpenAI 兼容网关,在 `packages/catalog/src/provider-models/openai-compat.ts` 中构建工厂,或用导出的 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` 内联构建。
2. **创建 `packages/ai/src/registry/<id>.ts`**,导出一个 `export const <camelId>Provider = { … } as const satisfies ProviderDefinition;`,带认证字段(`login`、…)。普通环境变量名放在目录记录的 `envVars` 中;只为计算型解析器(Foundry/ADC/Bedrock 式探测)设置 `envKeys`。
3. **将其添加到 `packages/ai/src/registry/registry.ts` 的 `ALL` 数组**(一个 import + 一个数组条目)。`ALL` 的顺序就是可登录提供商的 `/login` 列表顺序。

以上就是以下情形的全部改动:

- 仅环境变量 key 的提供商,
- 带简单内联 API-key 登录流程的提供商,
- 大多数 OpenAI 兼容网关。

对于**非平凡的提供商本地 OAuth 流程**,把实现放在 `packages/ai/src/registry/oauth/<vendor>.ts`,并从 def 文件懒加载它。它所基于的共享 OAuth 流程基础设施位于同一个 `registry/oauth/` 目录。

描述符、默认模型映射、环境变量键映射、登录列表和刷新分派都会自动更新;`KnownProvider` 联合类型从目录表获得新 id,`OAuthProvider` 从注册表获得。

## 字段参考

**目录表记录**(`ProviderCatalogEntry`,JSDoc 见 `packages/catalog/src/provider-models/descriptor-types.ts`):

| 字段                          | 作用                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | 必填。`KnownProvider` 的成员。                                                                                                                                                                                          |
| `defaultModel`               | 必填。未显式选择时优先使用的模型。                                                                                                                                                                 |
| `envVars`                    | 环境变量名(按顺序),用于运行时 API-key 回退(`getEnvApiKey`)。                                                                                                                                                 |
| `createModelManagerOptions`  | 运行时模型发现工厂。存在(且不是 `specialModelManager`)⇒ 出现在 `PROVIDER_DESCRIPTORS` 中。                                                                                                                 |
| `allowUnauthenticated`       | 即使没有 key,运行时也创建模型管理器。                                                                                                                                                                           |
| `dynamicModelsAuthoritative` | 成功的发现会替换捆绑模型。                                                                                                                                                                                 |
| `catalogDiscovery`           | 用于离线目录生成(`generate-models.ts`)的 `{ label, envVars?, oauthProvider?, allowUnauthenticated? }`。当生成使用不同凭据时(例如 `cursor`),这里的 `envVars` 会覆盖记录级列表。 |
| `specialModelManager`        | 定制运行时工厂(`google-antigravity` / `google-gemini-cli` / `openai-codex`);被排除在 `PROVIDER_DESCRIPTORS` 之外。                                                                                                  |

**注册表定义**(`ProviderDefinition`,见 `packages/ai/src/registry/types.ts`):

| 字段                   | 作用                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`            | 必填。当定义有可见登录流程时,`name` 显示在 `/login` 列表中。                                                                                                                 |
| `available`             | 可选的登录列表可用性标志。                                                                                                                                                                    |
| `showInLoginList`       | 设为 `false` 可将带 `login` 流程的提供商排除在交互式列表之外。                                                                                                                        |
| `envKeys`               | `getEnvApiKey` 的计算型环境变量回退,覆盖目录记录的 `envVars`:一个变量名字符串或 `() => string \| undefined` 解析器。`envVars` 已覆盖时省略。                           |
| `allowsMissingApiKey`   | 提供商传输层可以在没有解析出的 API-key 字符串的情况下完成认证。                                                                                                                                |
| `prepareRequest`        | 提供商在通用 API 分派之前的请求整形。返回要分派的模型和流式选项。                                                                                             |
| `mapSimpleOptions`      | 将通用简单流式选项包投影为提供商自有选项。                                                                                                                                |
| `prepareModelDiscovery` | 提供商自有的运行时模型发现的认证或端点设置。                                                                                                                              |
| `login`                 | 交互式登录。存在 ⇒ 为 `OAuthProvider` 成员,可通过 `AuthStorage.login` 分派,并显示在 `/login` 中(除非 `showInLoginList` 为 false)。返回 API-key `string` 或 `OAuthCredentials`。 |
| `refreshToken`          | OAuth 刷新器;静态 token 提供商省略(分派原样返回凭据)。                                                                                                            |
| `getApiKey`             | 将存储的 OAuth 凭据转换为传输层使用的 API-key/token 字符串。                                                                                                                    |
| `storeCredentialsAs`    | 在另一个提供商 id 下存储凭据(例如 `openai-codex-device` ⇒ `openai-codex`)。                                                                                                            |
| `callbackPort`          | 存在 ⇒ 进入 auth-broker 的 `CALLBACK_PORTS` 映射。                                                                                                                                                  |
| `pasteCodeFlow`         | OAuth 流程需要粘贴的代码/重定向 URL ⇒ 为 `PASTE_CODE_LOGIN_PROVIDERS` 成员。                                                                                                                     |

## 约定

- 使用 `... as const satisfies ProviderDefinition`,使字面量 `id` 保留下来,用于联合类型派生。
- 简单 API-key 或基于校验的流程的 `login` / `refreshToken` 可以直接放在提供商 def 文件中(在那里导出命名登录函数,便于测试直接导入)。
- 重型的提供商本地 OAuth 流程的 `login` / `refreshToken` 必须通过动态导入 thunk(`const { loginX } = await import("./oauth/x"); return loginX(cb);`)触达相邻的 `registry/oauth/*` 模块,使这些流程不进入急切启动图。
- 所有 OAuth 代码位于 `registry/oauth/` 下:共享流程基础设施(`callback-server`、`pkce`、`google-oauth-shared`、`types`、运行时 API `index`)以及每个提供商流程,包括被流式层和用量层复用的 `github-copilot` / `kimi` / `openai-codex` 辅助器。非 OAuth 的 API-key 辅助器(`api-key-login`、`api-key-validation`)位于 `registry/` 中 def 文件旁边,因为它们支撑简单的粘贴 API-key 登录。
- 对于简单的 OpenAI 兼容网关,用导出的 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` 内联构建管理器 —— 无需改动 `openai-compat.ts`。
- `ProviderDefinition` 也可以由扩展在运行时通过 `registerOAuthProvider` 注册(`AuthStorage.login` 分派器对内置和扩展走同一条路径)。
