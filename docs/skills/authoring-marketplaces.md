---
name: authoring-marketplaces
description: 创建新的 omp 市场时使用。涵盖 marketplace.json 模式、来源类型、安装命令和发布。
---

# 编写市场

市场是一个 Git 仓库(或本地目录),其中包含位于 `.omp-plugin/marketplace.json`(面向 omp 专用目录,推荐)或 `.claude-plugin/marketplace.json`(兼容 Claude Code;用作回退)的目录文件。任何人都可以编写市场。用户通过 `/marketplace add owner/repo` 添加它,然后从中安装单个插件。

## 最小可用市场

```
my-marketplace/
  .claude-plugin/
    marketplace.json
  plugins/
    my-plugin/
      skills/
        my-skill/
          SKILL.md
```

```json
{
  "name": "my-marketplace",
  "owner": { "name": "Your Name" },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What it does",
      "source": "./plugins/my-plugin"
    }
  ]
}
```

推送到 GitHub。用户通过以下命令安装:

```
/marketplace add your-github-username/my-marketplace
/marketplace install my-plugin@my-marketplace
```

## marketplace.json 模式

目录文件位于仓库根目录下的 `.omp-plugin/marketplace.json` 或 `.claude-plugin/marketplace.json`。omp 优先使用 `.omp-plugin/` 路径,回退到 Claude 路径;一个仓库可以同时发布两者,以便从单一源码树暴露工具专用目录。

### 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 市场名称。小写字母数字、连字符、点号。必须以字母数字开头和结尾。最长 64 个字符。 |
| `owner` | 是 | 至少包含 `owner.name`(字符串)的对象 |
| `owner.name` | 是 | 市场所有者名称 |
| `owner.email` | 否 | 所有者的联系邮箱 |
| `plugins` | 是 | 插件条目数组(见下文) |
| `metadata.description` | 否 | 市场的简短描述 |
| `metadata.version` | 否 | 目录元数据版本字符串 |
| `metadata.pluginRoot` | 否 | 添加到所有相对插件来源路径前面的字符串 |
| 其他顶层字段 | 否 | 解析器会保留,但市场安装/运行时逻辑不使用 |

### 插件条目字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 插件名称(命名规则与市场名称相同) |
| `source` | 是 | 在哪里找到插件——字符串或对象(见下文来源类型) |
| `description` | 否 | 插件的简短描述 |
| `version` | 否 | 版本字符串;依次回退到 `.claude-plugin/plugin.json`、`package.json`、来源 SHA,最后是 `0.0.0` |
| `author` | 否 | `{ name, email? }` |
| `homepage` | 否 | URL |
| `category` | 否 | 例如 `development`、`productivity`、`security` |
| `tags` / `keywords` | 否 | 字符串标签/关键字数组 |
| `repository` | 否 | 仓库 URL |
| `license` | 否 | 许可证字符串 |
| `strict` | 否 | 布尔元数据标志;保留但安装/运行时逻辑不使用 |
| `commands`、`agents`、`hooks`、`mcpServers` | 否 | 解析器保留的目录元数据;运行时发现来自已安装的插件树和清单 |
| `lspServers` | 否 | 插件内的内联服务器映射或路径;安装时写入 `.lsp.json` |
| `dapAdapters` | 否 | 插件内的内联适配器映射或 JSON/YAML 路径;安装时写入 `.dap.json`、`.dap.yaml` 或 `.dap.yml` |

### 完整目录示例

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "acme-plugins",
  "owner": {
    "name": "Acme Corp",
    "email": "plugins@acme.example"
  },
  "metadata": {
    "description": "Official Acme plugins for oh-my-pi"
  },
  "plugins": [
    {
      "name": "acme-linter",
      "description": "Enforce Acme coding standards",
      "category": "development",
      "source": "./plugins/linter"
    },
    {
      "name": "acme-deploy",
      "description": "One-command deploy to Acme cloud",
      "category": "devops",
      "source": {
        "source": "github",
        "repo": "acme-corp/omp-deploy-plugin",
        "ref": "main"
      }
    }
  ]
}
```

## 插件来源类型

### 1. 相对路径字符串

指向市场仓库内部的子目录。必须以 `./` 开头。

```json
"source": "./plugins/my-plugin"
```

该路径相对于市场仓库根目录解析。超出仓库根的路径穿越会被拒绝。

使用 `metadata.pluginRoot` 可避免重复公共前缀:

```json
{
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    { "name": "plugin-a", "source": "./plugin-a" },
    { "name": "plugin-b", "source": "./plugin-b" }
  ]
}
```

### 2. Git URL

完整的 Git 仓库 URL。可选择固定到分支/标签(`ref`)或精确提交(`sha`):

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/my-plugin.git",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

### 3. GitHub 简写

GitHub 仓库的简写形式。功能上等同于 Git URL,但更简洁:

```json
"source": {
  "source": "github",
  "repo": "org/my-plugin",
  "ref": "v2.1.0",
  "sha": "a1b2c3d4..."
}
```

### 4. Git 子目录(monorepo)

适用于位于较大仓库子目录中的插件。`url` 接受完整的 HTTPS URL 或 GitHub `owner/repo` 简写:

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "packages/my-plugin",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

`path` 必须解析到克隆仓库内部——目录逃逸会被拒绝。

### 5. NPM 包

将插件声明为 npm 包。`version` 可选:

```json
"source": {
  "source": "npm",
  "package": "@acme/omp-plugin",
  "version": "1.2.0"
}
```

> 注意:npm 插件来源会被目录解析接受,但安装时会以 `npm plugin sources are not yet supported` 拒绝。目前请使用相对路径或基于 Git 的来源。

## 插件结构

插件目录(无论来源类型)将内容放在约定位置,全部可选:

```
my-plugin/
  skills/<name>/SKILL.md         ← skills
  commands/*.md                  ← slash commands
  agents/*.md                    ← subagent definitions
  hooks/pre/, hooks/post/        ← hooks
  tools/                         ← custom tools
  .mcp.json                      ← MCP server definitions (default location)
  .claude-plugin/plugin.json     ← optional paths for skills/commands and other manifest metadata
  package.json                   ← optional version and `omp.extensions`
  README.md                      ← recommended: description + usage
```

> 注意:MCP 服务器也可以通过清单的 `mcpServers` 字段声明——可以是内联服务器映射,也可以是插件根目录内配置文件的路径(`{ "mcpServers": "./mcp-omp.json" }`)。omp 先读取 `.omp-plugin/plugin.json`,再读取 `.claude-plugin/plugin.json`;清单声明会替换默认的 `.mcp.json` 而不是与之合并,因此一个发布树可以携带针对不同运行环境的 MCP 配置。

> 注意:通过 `package.json` 的 `omp.extensions` 声明的扩展模块**确实会**从市场安装中加载——安装时会把缓存的插件符号链接到作用域的 `node_modules` 中,并记录到 `omp-plugins.lock.json`,这与 npm 安装和 `omp plugin link` 安装的插件使用相同的运行时表面。

## 安装命令

```
/marketplace install name@marketplace-name
/marketplace install --force name@marketplace-name     # reinstall
/marketplace install --scope project name@marketplace  # project-scoped
```

CLI 等价命令:

```
omp plugin marketplace add owner/repo
omp plugin install name@marketplace-name
```

作用域行为:

- **user**(默认)——安装在用户插件数据根目录的 `installed_plugins.json` 中(默认为 `~/.omp/plugins/installed_plugins.json`),在所有项目中可用。在 Linux 和 macOS 上,`omp config init-xdg` 会创建 XDG 根目录(但不会把数据迁移进去);一旦相关根目录存在且设置了 XDG 变量,新的用户状态将使用 `$XDG_DATA_HOME/omp/plugins/installed_plugins.json`。
- **project**——安装在 `<project>/.omp/plugins/installed_plugins.json` 中,仅在该项目中可用。

同一 `name@marketplace` ID 下,已启用的项目级安装会遮蔽已启用的用户级安装。被禁用的项目副本会保留用户副本处于激活状态。

安装与发现细节:

- 无效的插件条目会被记录并跳过;无效的 JSON 或缺少必需的顶层字段会使目录被拒绝。
- `skills/` 和 `commands/` 可以通过 `.claude-plugin/plugin.json` 重新映射。声明的技能路径通常添加到默认路径之上;对于目录来源恰好为 `"./"` 的插件,它们会替换默认路径。声明的 `commands`(推荐)或 `slash-commands` 会替换默认路径,除非显式包含 `./commands`。插件根目录之外的路径会被忽略并给出警告。
- 目录中的 `lspServers` 和 `dapAdapters` 值会在安装期间物化。目录中的 `commands`、`agents`、`hooks` 和 `mcpServers` 除此之外只是元数据;它们不会重新映射运行时发现。

## 命名规则

市场名称和插件名称必须:

- 只能包含小写字母、数字、连字符(`-`)和点号(`.`)
- 以小写字母或数字开头和结尾
- 长度最多 64 个字符

插件 ID(`name@marketplace`)总长度最多 128 个字符。

有效:`my-plugin`、`code-review`、`acme.tools`、`ai-v2`
无效:`-bad-start`、`bad-end-`、`.dot-start`、`Under_score`、`HAS_CAPS`

## 发布工作流

1. 在新 Git 仓库中,于 `.omp-plugin/marketplace.json`(仅 omp)或 `.claude-plugin/marketplace.json`(与 Claude Code 共享)创建 `marketplace.json`。
2. 添加指向子目录(或外部来源)的插件条目。
3. 推送到 GitHub。
4. 分享 `owner/repo` 字符串。用户通过 `/marketplace add owner/repo` 添加它。
5. 当你更新目录后,用户运行 `/marketplace update your-marketplace-name` 拉取最新版本。

发布前可在本地测试:

```
/marketplace add ./path/to/my-marketplace
```

本地路径来源也接受 `~/` 和绝对路径。

## 延伸阅读

- `docs/marketplace.md` — 市场系统内部机制、磁盘布局、命令参考
- `docs/skills/authoring-extensions.md` — 如何编写插件内的扩展模块
- `docs/skills/examples/mini-marketplace/` — 最小可用的市场示例
