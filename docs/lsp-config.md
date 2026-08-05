# OMP 中的 LSP 配置

本指南介绍如何为 OMP 编码 Agent 配置语言服务器。

代码中的权威来源：

- 服务器配置类型：`packages/coding-agent/src/lsp/types.ts`（`ServerConfig`）
- 配置加载器：`packages/coding-agent/src/lsp/config.ts`
- 内置服务器定义：`packages/coding-agent/src/lsp/defaults.json`

## 自动检测

当没有配置文件提供服务器覆盖时，OMP 通过交集两个条件来自动检测内置服务器：

1. 当前工作目录包含该服务器 `rootMarkers` 中的至少一个。
2. 服务器二进制可用——首先在受支持的项目本地 bin 目录中检查（例如 `node_modules/.bin/`、Python 虚拟环境、Ruby binstubs，以及 Go 项目的 `bin/`），然后检查 `$PATH`。

启动时的根标记检测仅限当前工作目录；它不会搜索父目录。`*.cabal` 之类的通配符标记只匹配 cwd 直接包含的条目，不会递归。常见配置无需任何配置；完整的内置集合参见 [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json)。

## 配置文件位置

OMP 从多个来源合并 LSP 配置，按从低到高的优先级：

| 优先级 | 位置                                                                                                     |
| ---------: | ------------------------------------------------------------------------------------------------------------ |
|     最低 | `~/lsp.json`、`~/.lsp.json`、`~/lsp.yaml`、`~/.lsp.yaml`、`~/lsp.yml`、`~/.lsp.yml`                          |
|            | 插件 LSP 配置（市场 / `--plugin-dir` 根目录）                                                      |
|            | 用户配置目录：活动的原生 Agent 目录，然后 `~/.claude/lsp.*`、`~/.codex/lsp.*`、`~/.gemini/lsp.*` |
|            | cwd 配置目录：`<cwd>/.omp/lsp.*`、`<cwd>/.claude/lsp.*`、`<cwd>/.codex/lsp.*`、`<cwd>/.gemini/lsp.*`      |
|     最高 | cwd 根目录：`<cwd>/lsp.*` 和 `<cwd>/.lsp.*`                                                                   |

每个位置都接受 `.json`、`.yaml` 和 `.yml`，包括隐藏变体。当同一位置存在多个变体时，从高到低的优先级为 `lsp.json`、`.lsp.json`、`lsp.yaml`、`.lsp.yaml`、`lsp.yml`、`.lsp.yml`。

按服务器进行浅合并：更高优先级的服务器对象只覆盖其顶层字段，但 `settings`、`initOptions`、`capabilities` 和 `workspaceReadyTimings` 等对象值字段会整体替换较低值，而不是深度合并。覆盖文件中不存在的服务器保持内置默认值。

原生用户配置目录遵循 `PI_CONFIG_DIR` 和活动配置文件；`~/.omp/agent/lsp.json` 是默认配置文件的拼写。此共享配置查找不使用 `PI_CODING_AGENT_DIR` 作为任意的替代基础。项目和 cwd 来源不会向上遍历祖先目录。

**推荐位置：**

- 用户级偏好 → 活动原生 Agent 目录的 `lsp.json`
- 项目特定覆盖 → `<cwd>/.omp/lsp.json`

> **注意：** 只有当至少一个可读配置贡献了非空的服务器映射时，自动检测模式才会被跳过。只设置了 `idleTimeoutMs` 的配置仍使用内置自动检测。在有服务器覆盖时，OMP 先将它们合并到所有默认值之上，然后保留根标记匹配 cwd、二进制可解析且合并后的配置不是 `disabled` 的服务器。

## 文件结构

JSON 和 YAML 均可接受。顶层对象既可以使用 `servers` 包装键，也可以直接使用扁平映射：

```json
{
  "servers": {
    "server-name": { ... }
  },
  "idleTimeoutMs": 300000
}
```

或（扁平形式，不带 `servers` 包装）：

```json
{
  "server-name": { ... },
  "idleTimeoutMs": 300000
}
```

顶层键：

- `servers` — 服务器名到 `ServerConfig` 的映射（可选包装；扁平形式等价）
- `idleTimeoutMs` — 在此毫秒数之后关闭空闲的语言服务器；省略、为零和负值都表示禁用空闲关闭

不要混用包装和扁平的服务器条目：当存在 `servers` 时，除 `idleTimeoutMs` 之外的兄弟键不会被当作服务器处理。

## ServerConfig 字段

| 字段                   | 类型       | 新服务器是否必需 | 描述                                                                                              |
| ----------------------- | ---------- | ------------------------: | -------------------------------------------------------------------------------------------------------- |
| `command`               | `string`   |                       是 | 二进制名称（通过本地 bin / PATH 解析）或绝对路径                                        |
| `args`                  | `string[]` |                        否 | 传给二进制的参数                                                                           |
| `fileTypes`             | `string[]` |                       是 | 此服务器处理的文件扩展名，例如 `[".ts", ".tsx"]`                                       |
| `languageId`            | `string`   |                        否 | 在 `textDocument/didOpen` 中发送的 LSP 语言 id；省略时从文件路径推断                                 |
| `rootMarkers`           | `string[]` |                       是 | 指示项目根目录的文件/目录；支持 `*.cabal` 这类单级通配符模式 |
| `initOptions`           | `object`   |                        否 | 在 LSP 握手期间作为 `initializationOptions` 发送                                                 |
| `settings`              | `object`   |                        否 | 通过 `workspace/didChangeConfiguration` 推送                                                            |
| `disabled`              | `boolean`  |                        否 | 设置为 `true` 以禁用此服务器                                                                        |
| `warmupTimeoutMs`       | `number`   |                        否 | 此服务器的启动超时（毫秒）                                                          |
| `isLinter`              | `boolean`  |                        否 | 标记为仅限 linter/formatter 的服务器；将其排除在类型智能操作之外                      |
| `capabilities`          | `object`   |                        否 | 选择加入的服务器特定功能；参见[功能](#capabilities)                                       |
| `workspaceReadyTimings` | `object`   |                        否 | 高级 rust-analyzer 工作区就绪时间覆盖；见下文                                   |

必需字段可以从内置服务器的覆盖中省略，因为它们在校验前被继承。真正的新服务器需要全部三个字段。`resolvedCommand` 和 `createClient` 是运行时拥有的字段，不可配置。

### 功能（Capabilities）

`capabilities` 对象启用 OMP 按服务器支持的可选服务器特定功能：

```json
{
  "capabilities": {
    "flycheck": true,
    "ssr": true,
    "expandMacro": true,
    "runnables": true,
    "relatedTests": true
  }
}
```

所有字段均为布尔值且可选。目前由 `rust-analyzer` 使用。

### 高级 rust-analyzer 就绪时间

`workspaceReadyTimings` 调整 rust-analyzer 的工作区就绪轮询：

```json
{
  "servers": {
    "rust-analyzer": {
      "workspaceReadyTimings": {
        "timeoutMs": 30000,
        "pollMs": 250,
        "settleMs": 2000,
        "statusRequestTimeoutMs": 2000
      }
    }
  }
}
```

全部四个字段都是可选的毫秒值。这是一个高级调优面；常规配置应使用默认值。

## 常见配方

### 覆盖内置服务器的设置

部分覆盖会合并到内置默认值之上。你只需指定要更改的字段。

```json
{
  "servers": {
    "typescript-language-server": {
      "args": ["--stdio", "--log-level", "4"]
    }
  }
}
```

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

### 禁用内置服务器

```json
{
  "servers": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### 注册自定义服务器

新服务器需要非空的 `command`、`fileTypes` 和 `rootMarkers`。无效的服务器定义会被忽略并给出警告。不可读的文件或无效的 JSON/YAML 会被忽略；加载器会继续处理其余来源。

```json
{
  "servers": {
    "my-lsp": {
      "command": "my-lsp-server",
      "args": ["--stdio"],
      "fileTypes": [".xyz"],
      "rootMarkers": [".xyz-project", ".git"]
    }
  }
}
```

### 设置全局空闲超时

关闭超过五分钟不活跃的语言服务器：

```json
{
  "idleTimeoutMs": 300000
}
```

### 对单个项目禁用服务器，但全局保留

将覆盖放在 `<project>/.omp/lsp.json` 中：

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

`~/.omp/agent/lsp.json` 中的用户级配置不受影响；pylsp 仅在此项目中受抑制。

## 内置服务器列表

以下服务器随 `defaults.json` 提供，并符合自动检测条件：

| 服务器键                       | 语言                           | 二进制                            |
| ----------------------------- | ----------------------------- | --------------------------------- |
| `rust-analyzer`               | Rust                          | `rust-analyzer`                   |
| `clangd`                      | C、C++、ObjC                  | `clangd`                          |
| `zls`                         | Zig                           | `zls`                             |
| `gopls`                       | Go                            | `gopls`                           |
| `typescript-language-server`  | TypeScript、JavaScript        | `typescript-language-server`      |
| `denols`                      | TypeScript、JavaScript (Deno) | `deno`                            |
| `biome`                       | TS/JS/JSON (linter)           | `biome`                           |
| `eslint`                      | TS/JS/Vue/Svelte (linter)     | `vscode-eslint-language-server`   |
| `vscode-html-language-server` | HTML                          | `vscode-html-language-server`     |
| `vscode-css-language-server`  | CSS、SCSS、Less               | `vscode-css-language-server`      |
| `vscode-json-language-server` | JSON                          | `vscode-json-language-server`     |
| `tailwindcss`                 | HTML、CSS、TS/JS              | `tailwindcss-language-server`     |
| `svelte`                      | Svelte                        | `svelteserver`                    |
| `vue-language-server`         | Vue                           | `vue-language-server`             |
| `astro`                       | Astro                         | `astro-ls`                        |
| `pyright`                     | Python                        | `pyright-langserver`              |
| `basedpyright`                | Python                        | `basedpyright-langserver`         |
| `pylsp`                       | Python                        | `pylsp`                           |
| `ruff`                        | Python (linter)               | `ruff`                            |
| `jdtls`                       | Java                          | `jdtls`                           |
| `kotlin-lsp`                  | Kotlin                        | `kotlin-lsp`                      |
| `metals`                      | Scala                         | `metals`                          |
| `hls`                         | Haskell                       | `haskell-language-server-wrapper` |
| `ocamllsp`                    | OCaml                         | `ocamllsp`                        |
| `elixirls`                    | Elixir                        | `elixir-ls`                       |
| `expert`                      | Elixir                        | `expert`                          |
| `erlangls`                    | Erlang                        | `erlang_ls`                       |
| `gleam`                       | Gleam                         | `gleam`                           |
| `solargraph`                  | Ruby                          | `solargraph`                      |
| `ruby-lsp`                    | Ruby                          | `ruby-lsp`                        |
| `rubocop`                     | Ruby (linter)                 | `rubocop`                         |
| `bashls`                      | Bash、Zsh                     | `bash-language-server`            |
| `lua-language-server`         | Lua                           | `lua-language-server`             |
| `intelephense`                | PHP                           | `intelephense`                    |
| `phpactor`                    | PHP                           | `phpactor`                        |
| `omnisharp`                   | C#                            | `omnisharp`                       |
| `yamlls`                      | YAML                          | `yaml-language-server`            |
| `terraformls`                 | Terraform                     | `terraform-ls`                    |
| `dockerls`                    | Dockerfile                    | `docker-langserver`               |
| `helm-ls`                     | Helm                          | `helm_ls`                         |
| `nixd`                        | Nix                           | `nixd`                            |
| `nil`                         | Nix                           | `nil`                             |
| `ols`                         | Odin                          | `ols`                             |
| `dartls`                      | Dart                          | `dart`                            |
| `marksman`                    | Markdown                      | `marksman`                        |
| `texlab`                      | LaTeX                         | `texlab`                          |
| `graphql`                     | GraphQL                       | `graphql-lsp`                     |
| `prismals`                    | Prisma                        | `prisma-language-server`          |
| `vimls`                       | Vim script                    | `vim-language-server`             |
| `emmet-language-server`       | HTML、CSS、JSX                | `emmet-language-server`           |
| `sourcekit-lsp`               | Swift                         | `sourcekit-lsp`                   |
| `swiftlint`                   | Swift (linter)                | `swiftlint`                       |
| `tlaplus`                     | TLA+                          | `tlapm_lsp`                       |
