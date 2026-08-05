# Auth Broker 与 Auth Gateway

auth broker 和 auth gateway 是两个协作的 HTTP 服务,把 OAuth 刷新 token 和提供商访问 token 从开发者笔记本搬到一个单独的 broker 主机上。

- **`omp auth-broker serve`** 持有规范的 SQLite 凭据库,执行 OAuth 刷新,并在 `/v1` 下暴露快照、凭据、阻止、用量和健康 API。
- **`omp auth-gateway serve`** 是一个正向代理。它接受 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 和 pi-native 流请求,解析 broker 支撑的凭据,并通过 `pi-ai` 提供商逻辑分派。客户端(容器化的 omp、llm-git、macOS 用量 widget,……)永远看不到访问 token。

操作员、broker 和 gateway 之间的传输安全委托给操作员(Tailscale / Wireguard / 反向代理 + TLS)。除 `/v1/healthz`(broker)和 `/healthz`(gateway)之外的每个端点都需要 bearer token。

来源:`packages/ai/src/auth-broker/`、`packages/ai/src/auth-gateway/`、`packages/coding-agent/src/cli/auth-broker-cli.ts`、`packages/coding-agent/src/cli/auth-gateway-cli.ts`、`packages/coding-agent/src/session/auth-broker-config.ts`。

## 数据流

```
                ┌────────────────────────────────────────────────────────────┐
                │ broker host                                                │
                │                                                            │
  developer ──▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  laptop /      │  │  omp auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI / robomp   │  │  - holds refresh tokens  │    │  (canonical writer)│    │
                │  │  - background refresher  │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  omp auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  receives snapshot stream,   │
                │  │  /v1/usage,/v1/models    │  refreshes credentials by id │
                │  │  /v1/credentials/check   │  via the broker on expiry    │
                │  └─────────┬────────────────┘                              │
                └────────────┼───────────────────────────────────────────────┘
                             │  bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  gateway clients
                  (llm-git, macOS widget, robomp containers, IDE plugins, …)
                                │
                                ▼ provider request with broker-resolved credential
                  api.anthropic.com / api.openai.com / …
```

broker 是 OAuth 刷新 token 的唯一写入者。客户端(包括 gateway 本身)加载一个脱敏快照,其中每个 `refresh` 字段已被替换为 `REMOTE_REFRESH_SENTINEL`;访问 token 过期时,客户端调用 `POST /v1/credential/:id/refresh`,broker 在服务端执行刷新。`RemoteAuthCredentialStore` 拒绝本地的 replace/upsert/按提供商删除修改,错误指向 `omp auth-broker login` / `omp auth-broker logout`。

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port]                    # boot the broker
omp auth-broker token     [--regenerate] [--json]               # print or rotate the bearer token
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve` 在 `getAgentDbPath()` 打开本地 SQLite 存储,并绑定一个 HTTP 监听器(默认 `127.0.0.1:8765`)。启动时确保 `<config-dir>/auth-broker.token` 处有 token(模式 `0600`,`0700` 父目录)。后台刷新器每隔 `refreshIntervalMs`(默认 60 秒)刷新任何 `expires - Date.now() < refreshSkewMs`(默认 5 分钟)的 OAuth 凭据。
- `token` 打印缓存的 bearer 或生成新 bearer。`--regenerate` 轮换它。
- `login [<provider>]` 在本地运行逐提供商 OAuth 流程 —— 未提供提供商时,回退到交互式编号选择器。用 `--via=user@host` 时,它执行 `ssh -L <callback-port>:127.0.0.1:<callback-port> user@host omp auth-broker login <provider>`,使 OAuth 回调命中本地浏览器,但凭据写在 broker 主机上(`--via` 需要 `<provider>`)。内置回调端口:`anthropic:54545`、`openai-codex:1455`、`google-gemini-cli:8085`、`google-antigravity:51121`、`gitlab-duo:8080`、`devin:59653`、`gitlab-duo-agent:8080`、`zai-coding-plan:54548`。OAuth 舞步通过 `AuthStorage.login()` 在进程内驱动 —— 不再有要派生的 `pi-ai` bin。
- `logout [<provider>]` 删除 `<provider>` 的每个凭据行。无参数时显示当前存储提供商的交互式编号选择器。
- `list` 枚举每个注册的 OAuth 提供商 id/name(内置 + `registerOAuthProvider` 自定义提供商的并集)。`--json` 发出机器可读数组。
- `import <file|dir>` 将 CLIProxyAPI 风格的 JSON 凭据导入本地 SQLite 存储。映射 `type` 字段 → omp 提供商(`claude → anthropic`、`codex → openai-codex`、`gemini → google-gemini-cli`、`antigravity → google-antigravity`、`gemini-cli → google-gemini-cli`)。
- `migrate --from-local` 将本地 SQLite 凭据上传到配置的 broker(`POST /v1/credential`)。默认包含本地 API key;本地 OAuth 行在设置 `--include-oauth` 前被跳过;环境派生的 API key 在设置 `--include-env` 前被跳过。重复运行对 broker 快照是幂等的。
- `status` 对配置的远程 broker 做健康 ping。

### 端点

| 方法   | 路径                         | 认证   | 用途                                                            |
| -------- | ---------------------------- | ------ | ------------------------------------------------------------------ |
| `GET`    | `/v1/healthz`                | 无   | 活性 + 版本                                                 |
| `GET`    | `/v1/snapshot`               | bearer | 脱敏快照(刷新 token 被哨兵替换)            |
| `GET`    | `/v1/snapshot/stream`        | bearer | 带增量事件和 keepalive 的 SSE 快照流               |
| `POST`   | `/v1/credential`             | bearer | Upsert 一个 OAuth 或 API-key 凭据                             |
| `POST`   | `/v1/credential/:id/refresh` | bearer | 强制刷新一个 OAuth 凭据                                 |
| `POST`   | `/v1/credential/:id/disable` | bearer | 禁用一个凭据并记录原因                       |
| `GET`    | `/v1/credentials/disabled`   | bearer | 列出禁用的凭据;可选的 `provider` 查询过滤        |
| `POST`   | `/v1/credential/:id/block`   | bearer | Upsert 一个提供商/范围限流阻止                           |
| `DELETE` | `/v1/credential/:id/blocks`  | bearer | 删除一个凭据的所有限流阻止                      |
| `GET`    | `/v1/usage`                  | bearer | 跨凭据聚合当前 `UsageReport[]`      |
| `GET`    | `/v1/usage/history`          | bearer | 持久化的用量历史;可选的 `sinceMs` 和 `provider` 过滤 |
| `POST`   | `/v1/usage/observed`         | bearer | 记录 broker 客户端观察到的用量                           |
| `GET`    | `/v1/usage/clients`          | bearer | 汇总自可选 `sinceMs` 以来客户端观察到的用量           |
| `POST`   | `/v1/usage/stale`            | bearer | 使 broker 当前的用量缓存失效                        |

请求使用 `Authorization: Bearer <token>`。服务器与内存中的 token 允许列表比较;gateway 的实现使用时序安全比较。

#### 条件快照长轮询

`GET /v1/snapshot?wait=<ms>` 支持基于代次的条件轮询。
在 `If-None-Match` 中发送上一次响应的代次。broker
接受非负整数代次作为裸标签、带引号的标签如
`"42"`,或弱引号标签如 `W/"42"`。

`wait` 被解析为数字,截断为整毫秒,并钳制在
0–30,000 ms 范围内;缺失或非数值按 `0` 处理。响应状态机是:

- 如果标签缺失/无效、与当前代次不同,或 `wait <= 0`,立即以 `200` 返回当前脱敏快照。
- 如果标签匹配且 `wait > 0`,等待代次变化。变化时以 `200` 返回新快照,等待到期未变化时返回空 `304`,调用方断开时返回空 `499`。

每个 `200`、`304` 和 `499` 快照响应都携带当前代次作为带引号的 `ETag`,外加 `Cache-Control: no-store` 和 `Vary: OMP-Auth-Broker-Capabilities`。

### Codex 阻止范围兼容

理解逐计量器 Codex 阻止的客户端发送 `OMP-Auth-Broker-Capabilities: codex-meter-block-scopes`。快照响应随后携带规范的 `chat` 和 `spark` 范围。没有该能力时,broker 把这些行在线路上投影为旧版 `shared` 范围。

本地 SQLite schema 7 保持 `chat` 和 `spark` 作为当前存储 API 暴露的规范范围。它还维护一个物理 `shared` 兼容镜像,供直接读取 `agent.db` 的预计量二进制使用。SQLite 触发器独立于计量器行派生该镜像的截止时间和更新时间,并把旧版进程的 `shared` 写回复制到两个计量器。当前存储 API 省略物理镜像,因此 broker 快照和模型选择不会重复计数它。

在此能力之前发布的客户端(包括 17.1.4)在被升级前收到保守的 `shared` 投影。这些客户端在现有线路上无法区分,因此混合版本部署倾向于保持受限流凭据被阻止,而不是允许重复提供商请求和 429 响应。

能力相关响应包括 `Vary: OMP-Auth-Broker-Capabilities`,使中介不会为一个客户端复用另一种表示。加密客户端快照缓存也使用新的格式版本:更旧的缓存文件被忽略并重新抓取,防止旧版和计量器范围的表示在客户端版本间混合。

### 后台刷新器

`AuthBrokerRefresher` 以 `refreshIntervalMs` 节奏迭代活动 OAuth 凭据,并刷新任何在到期 `refreshSkewMs` 内的凭据。每个凭据 id 的刷新是单飞行的,因此慢刷新不会被重新触发。刷新器区分:

- **确定性失败**(`invalid_grant`、`invalid_token`、`revoked`、未授权刷新 token、非网络抖动导致的 401/403)— 凭据传给 `AuthStorage.disableCredentialById(id, cause)`,使下一次快照拉取在客户端表面出干净的删除;
- **瞬时失败**(超时 / ECONNREFUSED / 抓取失败)— 原地保留,等待下一轮扫描。

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth]
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
```

- `serve` 需要 `OMP_AUTH_BROKER_URL`(或 `config.yml` 中的 `auth.broker.url`)— gateway 本身就是一个 broker 客户端。它调用 `AuthBrokerClient.fetchSnapshot()`,将其包装在 `RemoteAuthCredentialStore` 中,并构造一个通过 broker 解析访问 token 的 `AuthStorage`。默认绑定是 `127.0.0.1:4000`。gateway token 存储在 `<config-dir>/auth-gateway.token`(`0600`);`--no-auth` 完全禁用 bearer 检查(仅回环使用)。
- `token` / `status` 管理和检查 gateway bearer token 及上游 broker 就绪状态。
- `check` 通过 gateway 存储探测 broker 支撑的凭据。不带 `--strict` 时使用提供商用量探测;`--strict` 还针对每个凭据的 chat-completion 端点测试它,可能消耗少量配额。

### 端点

| 方法 | 路径                    | 认证   | 用途                                                      |
| ------ | ----------------------- | ------ | ------------------------------------------------------------ |
| `GET`  | `/healthz`              | 无   | 活性 + 版本                                           |
| `GET`  | `/v1/usage`             | bearer | 聚合 `UsageReport[]`(通过 `AuthStorage` 代理)    |
| `GET`  | `/v1/models`            | bearer | 过滤为有凭据提供商的捆绑模型目录 |
| `GET`  | `/v1/credentials/check` | bearer | 逐凭据认证健康探测                             |
| `POST` | `/v1/chat/completions`  | bearer | OpenAI Chat Completions 线上格式                          |
| `POST` | `/v1/messages`          | bearer | Anthropic Messages 线上格式                               |
| `POST` | `/v1/responses`         | bearer | OpenAI Responses 线上格式                                 |
| `POST` | `/v1/pi/stream`         | bearer | 原生 `pi-ai` 流线上格式                            |

模型 id 从外部线上格式的顶层 `model` 字段读取,从 pi-native 请求体为 `/v1/pi/stream` 读取。gateway 选择匹配该 id 的第一个捆绑 `Model<Api>`,把入站线上格式解析为 omp `Context`,从 broker 支撑的 `AuthStorage` 解析提供商凭据,通过 `streamSimple()` 分派,并把结果重新编码为入站格式(流式响应为 SSE)。

没有原始提供商直通路径。所有受支持路由都经过 `pi-ai` 提供商逻辑,使凭据特定的请求整形、认证错误时的 OAuth 刷新和提供商怪癖保持集中。

底层 `Bun.serve` 上的 `idleTimeout` 设为 `255 s`,使长思考预算的调用不会被 Bun 的默认空闲超时杀死。

## 用量缓存:服务端 5 分钟抖动 + 客户端 15 秒单飞行

两层缓存聚合提供商用量报告。两者都是有意叠加的。

### 服务端缓存(broker `AuthStorage`)

`AuthStorage` 在 broker 的 SQLite 存储中以**5 分钟每凭据 TTL 加 ±25 % 抖动**缓存每个凭据的 `UsageReport`。Anthropic 和 OpenAI 按源 IP 激进限流 `/usage`,同步的 5 凭据扇出每个周期都会触发 429;抖动在几个周期内去相关刷新时间。抓取失败时,存储保持**最后良好**报告最多 24 小时,带短抖动重轮询窗口 —— 因此上游瞬时抖动永远不会让 widget 变空。

常量:`USAGE_REPORT_TTL_MS = 5 * 60_000`、`USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000`(`packages/ai/src/auth-storage.ts`)。

### 客户端单飞行(`RemoteAuthCredentialStore`)

gateway(或任何其他 broker 客户端)调用 `fetchUsageReports()` / `getUsageReport(provider, credential)` 时,`RemoteAuthCredentialStore` 将并发调用合并为单次 `GET /v1/usage` 往返,并在内存中缓存结果 **15 秒**。

- `USAGE_CACHE_TTL_MS = 15_000`(`packages/ai/src/auth-broker/remote-store.ts`)。
- 单个 `#usageInflight` promise 在所有调用方之间共享;每个调用方的 `AbortSignal` 与共享 promise **竞争**,而不是穿入其中,因此一个调用方的中止不会级联到对等方的在途请求。
- 抓取失败时,被拒绝的 promise 被记录,等待的值是 `null` — 调用方(`AuthStorage.fetchUsageReports`、`#getUsageReport`)把 `null` 报告视为"本周期无用信号"并继续。**这是 15 秒 TTL 回退**:客户端通过抑制错误、向排序返回 `null` 并在 15 秒窗口后重试,来吸收 broker 瞬时中断。

15 秒客户端窗口刻意低于 broker 的 5 分钟服务端缓存,因此几乎每次客户端轮询都从 broker 已缓存的值服务;客户端缓存的存在是为了把 `AuthStorage.#rankOAuthSelections` 生成的并行扇出吸收成单次 broker 往返。

## 客户端快照缓存

`discoverAuthStorage()` 在初始 `/v1/snapshot` 抓取后以及后续 broker 来源的完整快照后,把 broker 快照持久化到 `~/.omp/cache/auth-broker-snapshot.enc`。该文件用 `SHA-256(OMP_AUTH_BROKER_TOKEN)` 做 AES-256-GCM 加密,并用 broker URL 作为附加数据认证,因此更改 token 或 URL 都会使缓存不可读。文件以模式 `0600` 原子写入。

新鲜度锚定在 broker 盖戳的 `snapshot.generatedAt`,而不是本地写入时间。默认 TTL 为 1 小时(`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`);`0` 禁用缓存读写。新鲜缓存用 500 ms 启动预算对可达 broker 重新验证,因此导入、撤销或轮换的凭据对一次性命令立即可见。如果重新验证因 broker 不可用或慢而失败,`omp` 从缓存启动,`RemoteAuthCredentialStore` 在后台继续正常 SSE / 长轮询同步。过期的 OAuth 访问 token 仍通过 `POST /v1/credential/:id/refresh` 刷新。

如果启动时 broker 宕机且存在新鲜缓存,启动从缓存快照成功。认证失败(401/403)不被缓存掩盖;瞬时服务器错误回退到它。如果缓存缺失、过期、损坏、为不同 URL 写入或用不同 token 加密,启动回退到实时抓取,并在 broker 不可达时失败。

## 客户端账户池(路由,非授权)

broker 客户端可以通过设置 `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` 为 JSON 文件来限制其可见的 OAuth 账户。该文件把提供商 id 映射到 broker 快照协议中的精确 `identityKey` 值:

```json
{
  "anthropic": ["email:alice@example.com|org:org-team"],
  "openai-codex": []
}
```

`identityKey` 是每个已认证 `/v1/snapshot` 凭据条目已携带的无 token 身份字段。操作员工具应只投影 `provider` 和 `identityKey`;它不得保留或打印伴随的凭据负载。专门的账户列表 CLI 刻意不在该路由功能的范围内。

SDK 宿主可以在 `discoverAuthStorage()` 或 `RemoteAuthCredentialStore` 中提供相同的提供商到身份映射作为 `accountPool`。显式程序化池优先于环境文件。

- 缺失的提供商不受限制。
- 空数组隐藏该提供商的每个 OAuth 凭据。
- 非空数组只暴露精确身份匹配,包括组织/工作区限定符。
- API-key 凭据保持可见;池只适用于 OAuth 账户。

文件在 broker 支撑的认证存储启动时解析一次。不可读文件、格式错误的 JSON 或无效提供商条目中止初始化,而不是静默扩大池。完整快照、SSE 更新、刷新响应和聚合用量被一致过滤。对于池中列出的提供商,只有报告可归因于可见 OAuth 身份时才返回聚合报告;只可归因于 API key 或缺少匹配身份元数据的报告失败关闭。加密快照缓存保持原始 broker 快照,因此共享该缓存的可信进程可以应用不同的池。

这是**可信客户端路由策略,不是授权边界**。客户端仍持有 broker bearer token,在应用本地视图前接收原始 broker 响应,并且可以直接调用 broker 端点。需要防止客户端检索其他凭据时,使用服务端授权 —— 而不是账户池。

## 操作员选择加入

除非设置 `OMP_AUTH_BROKER_URL`(或 `config.yml` 中的 `auth.broker.url`),否则 broker **关闭**。设置后,`packages/coding-agent/src/sdk.ts` 中的 `discoverAuthStorage` 把本地 SQLite 凭据存储换成 `RemoteAuthCredentialStore`,每个 API 调用都通过 broker 解析凭据。

### 环境变量

| 变量                            | 用途                                                                                                                                                                | 何时必需                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `OMP_AUTH_BROKER_URL`               | 远程 auth-broker 的基础 URL(例如 `https://broker.tailnet:8765`)。选择它使客户端进入 broker 模式 —— 本地 SQLite 被旁路。                     | 任何 omp 客户端应通过 broker 解析凭据时(且 `omp auth-gateway serve` 必需)。           |
| `OMP_AUTH_BROKER_TOKEN`             | 除 `/v1/healthz` 外每个 broker 端点使用的 bearer token。                                                                                                      | 设置了 `OMP_AUTH_BROKER_URL` 且 `auth.broker.token` 或 `<config-dir>/auth-broker.token` 没有可用 token 时。 |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | 加密本地快照缓存的新鲜度窗口。默认 `3600000`(1 小时);`0` 禁用缓存读写。                                                 | broker 模式下可选。                                                                                                  |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | 加密本地快照缓存的路径覆盖。默认 `~/.omp/cache/auth-broker-snapshot.enc`(或 XDG 缓存等价)。                                       | broker 模式下可选。                                                                                                  |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | JSON 文件,把提供商 id 映射到该可信客户端可见的 OAuth `identityKey` 值。解析一次;无效文件中止初始化。API key 不受影响。 | broker 模式下可选。                                                                                                  |

`resolveAuthBrokerConfig()` 中的解析顺序:

1. `OMP_AUTH_BROKER_URL` 环境变量(否则 `config.yml` 的 `auth.broker.url`,通过 `resolveConfigValue` 解析);
2. `OMP_AUTH_BROKER_TOKEN` 环境变量(否则 `config.yml` 的 `auth.broker.token`,否则 `<config-dir>/auth-broker.token`);
3. URL 已设置但无法解析 token → 硬错误,指向 token 文件路径。

gateway 没有专用环境变量 — 它继承 `OMP_AUTH_BROKER_*`,因为它本身就是一个 broker 客户端。

### `config.yml` 键

| 键                 | 默认 | 用途                                                                                                                                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.broker.url`   | 未设置   | 与 `OMP_AUTH_BROKER_URL` 相同;环境变量胜出。对设置 UI 隐藏。值解析为字面量、环境变量名,或 `!<shell command>` 以使用修剪后的 stdout。 |
| `auth.broker.token` | 未设置   | 与 `OMP_AUTH_BROKER_TOKEN` 相同;环境变量胜出。值以相同方式解析。                                                                                                       |

### Token 文件

| 路径                              | 所有者                                                | 模式                          |
| --------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `<config-dir>/auth-broker.token`  | `omp auth-broker serve`(首次启动时创建)     | `0600`,位于 `0700` 父目录内 |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway serve`(`--no-auth` 下跳过) | `0600`,位于 `0700` 父目录内 |

`<config-dir>` 解析为 `~/.omp/`(尊重 `PI_CONFIG_DIR`)。

## 与本地 API-key 解析顺序的交互

broker 只拥有已上传给它的 OAuth 凭据和提供商 API-key 凭据。`models.md` 中的标准凭据阶梯(`Auth and API key resolution order`)被保留,并随 gateway 一起提交了一个新增:

- `AuthStorage.setConfigApiKey / removeConfigApiKey / clearConfigApiKeys` 让 `models.yml` 的 `apiKey` **不**覆盖显式 `--api-key` 的情况下压过已存储的 OAuth token。这就是允许 broker 解析的 OAuth 凭据在两者都存在时被按环境的 `models.yml` 配置键可靠遮蔽的方式。

## 另见

- [`secrets.md`](./secrets.md) — 围绕_确实_泄漏通过的 token 的机密混淆(例如 shell 输出中的 `OMP_AUTH_BROKER_TOKEN`)。
- [`models.md`](./models.md) — 提供商认证解析顺序;broker 提供已存储凭据层。
- [`environment-variables.md`](./environment-variables.md) — 完整环境变量参考,包括 `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`。
