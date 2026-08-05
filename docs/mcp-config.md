# OMP 中的 MCP 配置

本指南介绍如何为 OMP 编码 Agent 添加、编辑和校验 MCP 服务器。

代码中的权威来源：

- 运行时配置类型：`packages/coding-agent/src/mcp/types.ts`
- 配置写入器：`packages/coding-agent/src/mcp/config-writer.ts`
- 加载器 + 校验：`packages/coding-agent/src/mcp/config.ts`
- 独立 `mcp.json` 发现：`packages/coding-agent/src/discovery/mcp-json.ts`
- Schema：`packages/coding-agent/src/config/mcp-schema.json`

## 首选配置位置

OMP 可以从多种工具中发现 MCP 服务器（`.claude/`、`.cursor/`、`.vscode/`、`opencode.json` 等），但 OMP 原生配置通常应使用以下主要文件之一：

- 项目：`.omp/mcp.json`
- 用户：`~/.omp/agent/mcp.json`（当有命名配置文件处于活动状态时为 `~/.omp/profiles/<name>/agent/mcp.json`——参见[配置文件](#profiles)）

原生提供商还会读取 `.omp/.mcp.json` 和 `~/.omp/agent/.mcp.json` 以保持兼容，但 OMP 会写入上面主要的 `mcp.json` 路径。

OMP 也接受项目根目录中的回退独立文件：

- `mcp.json`
- `.mcp.json`

当你希望 OMP 拥有配置的所有权时，使用 `.omp/mcp.json` 或 `~/.omp/agent/mcp.json`。只有当你需要一个其他 MCP 客户端也可能读取的可移植回退文件时，才使用根目录的 `mcp.json` / `.mcp.json`。

### 导入的工具配置

OMP 还会转换这些当前工具原生来源：

- Claude Code：`~/.claude.json`、`~/.claude/mcp.json`，以及项目 `.claude/.mcp.json` / `.claude/mcp.json`
- Codex：`~/.codex/config.toml` 和 `.codex/config.toml`（`[mcp_servers.*]`）
- Gemini CLI：`~/.gemini/settings.json` 和 `.gemini/settings.json`
- OpenCode：`~/.config/opencode/opencode.json` 和项目根目录的 `opencode.json`
- Cursor：`~/.cursor/mcp.json` 和 `.cursor/mcp.json`
- Windsurf：`~/.codeium/windsurf/mcp_config.json` 和 `.windsurf/mcp_config.json`
- VS Code：仅项目的 `.vscode/mcp.json`，使用 `mcp.servers`
- 已安装的 Claude 市场插件和声明了 MCP 服务器的 OMP 扩展包

对于同时具有两个作用域的转换提供商，同名用户条目会先于其项目条目被遇到。OMP 原生配置是例外：其项目条目先于活动配置文件的用户条目。跨提供商优先级见[发现与优先级](#discovery-and-precedence)。

### 配置文件（Profiles）

命名配置文件（`omp --profile <name>`、`--alias` 快捷方式或 `OMP_PROFILE`/`PI_PROFILE`）隔离用户级 MCP 配置。当配置文件处于活动状态时，**user** 作用域解析到该配置文件的 Agent 目录而不是默认目录：

- 默认配置文件：`~/.omp/agent/mcp.json`
- 配置文件 `<name>`：`~/.omp/profiles/<name>/agent/mcp.json`

发现、`/mcp` 命令和配置写入器都遵循活动配置文件，因此配置文件**只**看到自己的用户级服务器——绝不会看到默认配置文件的 `~/.omp/agent/mcp.json`。要往配置文件添加服务器，可以在其下启动（`omp --profile <name>`）并运行 `/mcp add` → 用户级别，或直接编辑 `~/.omp/profiles/<name>/agent/mcp.json`。

项目作用域 MCP 配置（`.omp/mcp.json`）绑定工作目录而非配置文件，因此它在每个配置文件下都适用。外部工具配置（`.claude/`、`.cursor/` 等）也与配置文件无关，因为它们属于那些工具而非 OMP 配置文件。

MCP 遵循与 OMP 其余原生配置相同的配置文件规则；参见[配置发现 → 配置文件](./config-usage.md#profiles)。

## 添加 schema 引用

在文件顶部添加这一行以获得编辑器自动补全和校验：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

当 `/mcp add`、`/mcp enable`、`/mcp disable`、`/mcp reauth` 或其他配置写入流程创建或更新 OMP 管理的 MCP 文件时，OMP 现在会自动写入此内容。

## 文件结构

OMP 支持以下顶层结构：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

顶层键：

- `$schema` — 供工具使用的可选 JSON Schema URL
- `mcpServers` — 服务器名到服务器配置的映射
- `disabledServers` — 活动配置文件的用户黑名单；无论来源条目的 `enabled` 值如何，它都按名称隐藏已发现的服务器
- `enabledServers` — 活动配置文件的用户白名单；它可以强制启用来源声明为 `enabled: false` 的同名条目，但 `disabledServers` 仍然优先

配置写入器接受最多 100 个字符的名称，可包含字母、数字、`_`、`-`、`.` 和 `:`。捆绑的 schema 目前在其名称模式中省略了 `:`，因此 `cloudflare:cloudflare-api` 这样的 OMP 管理命名空间插件条目在运行时可能有效，而编辑器会报告 schema 错误。

## 支持的服务器字段

每种传输共有的字段：

- `enabled?: boolean` — 为 `false` 时跳过此服务器，除非活动配置文件的用户 `enabledServers` 白名单点名了它
- `timeout?: number` — MCP 请求超时（毫秒）；`0` 禁用客户端侧 MCP 超时
- `requestIdFormat?: "number" | "string"` — 出站 JSON-RPC 请求 id 编码；默认为每种传输的整数。`"string"` 使用抗冲突的 snowflake ID。此 OMP 特定字段只从 OMP 原生文件、根目录 `mcp.json` / `.mcp.json` 和 OMP 扩展包读取；从其他工具转换的配置会忽略它。
- `auth?: { ... }` — 已存储凭据的元数据；受管理的凭据注入是为 OAuth 实现的
- `oauth?: { ... }` — 在认证/重新认证期间使用的显式 OAuth 客户端和回调设置

`OMP_MCP_TIMEOUT_MS` 具有覆盖每个服务器 `timeout` 的进程级优先级。将其设置为 `0` 可禁用客户端侧超时，或设置为正毫秒值，如 `120000`。如果未设置或无效，OMP 使用服务器值，然后是 30 秒默认值；无效值会被记录并忽略。

### `stdio` 传输

省略 `type` 时 `stdio` 是默认值。

必填：

- `command: string`

可选：

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

这遵循官方 Filesystem MCP 服务器包（`@modelcontextprotocol/server-filesystem`）。

### `http` 传输

必填：

- `type: "http"`
- `url: string`

可选：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

这匹配 GitHub 托管的 GitHub MCP 服务器端点。

### `sse` 传输

必填：

- `type: "sse"`
- `url: string`

可选：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` 仍为兼容性而受支持，但 MCP 规范现在建议新服务器使用 Streamable HTTP（`type: "http"`）。

## 认证字段

OMP 理解两个与认证相关的对象。

### `auth`

```json
{
  "type": "oauth",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

对于受管理的 OAuth，`auth` 告诉 OMP 如何找到并刷新已存储的凭据。虽然 `"apikey"` 是可接受的 `type`，但它不会从认证存储加载或注入 API 密钥。请将 API 密钥直接放入 stdio `env` 或远程 `headers`（优先使用下面描述的环境变量或 `!command` 间接方式）。

你通常不需要编写此块：当 OMP 为 `http`/`sse` 服务器完成 OAuth 流程时，它会在由活动配置文件和服务器 URL 派生的确定性 id（`mcp_oauth:profile:<profile>:<url>`）下存储凭据，并嵌入刷新材料。任何指向同一 URL 的配置——包括共享项目 `mcp.json` 中完全没有 `auth` 块的_仅定义_条目——都会自动解析活动配置文件自己的凭据，即使认证存储由共享认证代理（auth broker）支持。这正是项目作用域服务器跨配置文件安全的原因：提交定义，然后每个配置文件通过 `/mcp reauth <name>` 授权（并保持登录为）自己的账户。显式 `credentialId` 在可解析时仍会被尊重；如果它指向另一个配置文件的记录，OMP 会回退到配置文件作用域的 url 键绑定。

对仅定义条目执行 `/mcp reauth` 不会改动文件——凭据（包括刷新材料）完全存在于活动配置文件的认证存储（本地 `agent.db` 或代理）中，因此提交的项目配置永远不会沾染本地认证状态。显式配置的 `Authorization` 头始终优先于 url 键绑定。

该绑定按配置文件而非按项目生效：一旦某个配置文件授权了一个 URL，_任何_其 `mcp.json` 在该 URL 定义了服务器的检出都会自动使用该配置文件的凭据连接。提交的 MCP 定义是受信任输入——`stdio` 条目已经适用同样规则，它们会运行任意命令——因此在用持有重要凭据的配置文件打开仓库之前，请审查其 `mcp.json`，或为不受信任的检出使用专用配置文件。

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

当 MCP 服务器需要显式 OAuth 客户端或回调设置时使用 `oauth`。回调监听器默认端口 `3000`、路径 `/callback`；HTTP 回环 `redirectUri` 提供自己的端口/路径，除非被显式覆盖。HTTPS 回环重定向需要为 TLS 终止器后面的本地 HTTP 监听器设置不同的 `callbackPort`。

`prompt` 控制 OAuth `prompt` 授权参数。默认情况下 OMP 省略它，除非请求了 `offline_access` 作用域——此时默认为 `"consent"`，以便提供商能签发刷新访问。请显式设置为提供商支持的值，如 `"consent"` 或 `"select_account"`，或设置为 `""` 以强制省略。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Slack 文档中的相关 Slack 端点：

- MCP 端点：`https://mcp.slack.com/mcp`
- 授权端点：`https://slack.com/oauth/v2_user/authorize`
- Token 端点：`https://slack.com/api/oauth.v2.user.access`

## 常用复制粘贴示例

### 通过 stdio 使用 Filesystem 服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### 通过 HTTP 使用 GitHub 托管服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### 通过 Docker 使用 GitHub 本地服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

这匹配 GitHub 官方的本地 Docker 镜像 `ghcr.io/github/github-mcp-server`。

### 通过 OAuth 使用 Slack 托管服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## 机密与变量解析

这是通常让人困惑的部分。

### 发现时的 `${...}` 展开

OMP 在从 OMP 原生文件和独立回退文件发现 MCP 配置时，会展开 `${VAR}` 和 `${VAR:-default}` 占位符。展开递归应用于 `command`、`args`、`env`、`cwd`、`url`、`headers`、`auth` 和 `oauth` 中的字符串值；未解析的占位符保持为字面字符串。

示例：

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

### 连接前的 env/header 解析

在 OMP 启动 stdio 服务器或发出 HTTP/SSE 请求之前，它按如下方式解析 stdio `env` 值和 HTTP/SSE `headers` 值：

1. 如果值以 `!` 开头，OMP 以 10 秒超时将其余部分作为 shell 命令运行，并使用修剪后的 stdout。成功结果在进程生命周期内缓存。
2. 如果命令失败、超时或只输出空白，则省略该 `env`/`headers` 条目。
3. 否则 OMP 检查整个值是否命名了一个环境变量。
4. 如果该环境变量设置为非空值，OMP 使用环境值；否则按字面使用该字符串。

示例：

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

这意味着以下方式对本地机密有效且方便：

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → 从当前 shell 环境复制
- `"Authorization": "Bearer hardcoded-token"` → 使用字面值
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → 从命令构建 header

## 用户级启用和禁用覆盖

活动配置文件的用户文件提供两个跨来源覆盖：

- `disabledServers` 是最高优先级的黑名单。它按名称隐藏任何来源的同名服务器。
- `enabledServers` 强制启用来源为 `enabled: false` 的同名条目；它不能覆盖 `disabledServers`。

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github"],
  "enabledServers": ["tool-owned-server"]
}
```

当定义位于 OMP 拥有的可写文件中时，`/mcp enable` 和 `/mcp disable` 直接更新 `enabled`。OMP 不会修改其他工具的配置：对于此类来源，这些命令改为维护用户级白名单或黑名单，并移除冲突的过期覆盖。

## `/mcp add` 与直接编辑 JSON

需要引导式设置时使用 `/mcp add`。

在以下情况直接编辑 JSON：

- 你需要向导尚未提示的传输或认证选项
- 你想粘贴来自另一个 MCP 客户端的服务器定义
- 你想在编辑器中获得 schema 支持的校验

编辑后使用：

- `/mcp reload` 在当前会话中重新发现并重新连接服务器
- `/mcp list` 查看服务器来自哪个配置文件
- `/mcp test <name>` 测试单个服务器
- `/mcp reconnect <name>` 重新连接一个服务器而不重新发现所有配置
- `/mcp reauth <name>` 替换受管理的 OAuth 凭据，或 `/mcp unauth <name>` 移除它们
- `/mcp resources`、`/mcp prompts` 和 `/mcp notifications` 检查非工具的 MCP 能力

## OMP 执行的校验规则

来自 `packages/coding-agent/src/mcp/config.ts` 的 `validateServerConfig()`：

- `stdio` 需要 `command`
- `http` 和 `sse` 需要 `url`
- 服务器不能同时设置 `command` 和 `url`
- 未知的 `type` 值会被拒绝

实际影响：

- 省略 `type` 意味着 `stdio`
- 如果你粘贴远程服务器配置却忘记 `"type": "http"`，OMP 会将其视为 `stdio` 并抱怨缺少 `command`
- `sse` 仍对兼容性有效，但新的托管服务器通常应配置为 `http`

## 发现与优先级

OMP 按降序优先级加载提供商。支持 MCP 的顺序是：

1. OMP 原生配置
2. OMP 扩展包
3. Claude Code
4. Claude 市场插件和 Codex
5. Gemini CLI
6. OpenCode
7. Cursor 和 Windsurf
8. VS Code
9. 根目录 `mcp.json` / `.mcp.json` 回退文件

第一个定义胜出。重复名称不会合并。当不同名称的定义与更高优先级定义的传输、端点/命令输入、认证和请求 id 模式等价时，它也会被遮蔽。

在 OMP 原生配置内部，项目 `.omp/mcp.json` 先于 `.omp/.mcp.json`，然后是活动配置文件的用户 `mcp.json` 和 `.mcp.json`。根目录回退 `mcp.json` 先于根目录 `.mcp.json`。在实践中：

- 对于 OMP 特定覆盖，优先使用 `.omp/mcp.json` 或活动配置文件的用户 `mcp.json`
- 尽可能让名称和端点定义跨工具唯一
- 当第三方配置不断重新引入不需要的服务器时，使用用户 `disabledServers` 列表
- 设置 `mcp.enableProjectConfig: false` 以在去重前排除所有项目级来源，从而允许同名用户条目存活

## 故障排查

### `Server "name": stdio server requires "command" field`

你可能在远程服务器上省略了 `type: "http"`。

### `Server "name": both "command" and "url" are set`

选择一种传输。OMP 将 `command` 视为 stdio，将 `url` 视为 http/sse。

### `/mcp add` 成功但服务器仍无法连接

JSON 有效，但服务器可能仍不可达。使用 `/mcp test <name>` 并检查：

- 二进制或 Docker 镜像是否存在
- 所需的环境变量是否已设置
- 远程 URL 是否可达
- OAuth 或 API token 是否有效

### 服务器存在于另一个工具的配置中，但在 OMP 中不存在

运行 `/mcp list`。OMP 会发现许多第三方 MCP 文件，但项目级加载也可以通过 `mcp.enableProjectConfig` 设置禁用，用户级 `disabledServers` 条目可以按名称抑制服务器。

### 命名空间服务器可用但编辑器拒绝其名称

运行时/配置写入器接受市场插件名称中的 `:`。捆绑 JSON schema 的 `propertyNames` 模式目前不接受；这是 schema/运行时不匹配，而非连接失败。

### 配置文件从列表中静默缺失

格式错误的 JSON 或缺失/无效的服务器映射会使该提供商无法从文件中贡献任何条目；根据提供商不同，OMP 会记录发现警告或记录解析失败，而不是让会话失败。修正 JSON 结构，然后运行 `/mcp reload` 和 `/mcp list`。

## 参考资料

- MCP 传输规范：https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem 服务器包：https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP 服务器：https://github.com/github/github-mcp-server
- Slack MCP 服务器文档：https://docs.slack.dev/ai/slack-mcp-server/
