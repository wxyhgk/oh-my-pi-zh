# 市场插件系统

市场系统让你可以从 Git、本地或直接目录源发现、安装和管理插件。它与 Claude Code 插件注册表格式兼容。

## 快速开始

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

在 TUI 中，不带参数的 `/marketplace` 会打开交互式插件浏览器。在 ACP/RPC 命令处理中，`/marketplace` 列出已配置的市场；使用 `/marketplace discover` 浏览。

## 概念

**市场（marketplace）** 是一个 Git 仓库（或本地目录），其中包含位于 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容回退）的目录文件。目录列出可用的插件及其来源、描述和元数据。

**插件（plugin）** 是一个包含 Claude/OMP 插件内容的目录，如技能、命令、Agent、钩子、工具、MCP 服务器或 LSP 服务器。市场安装还会加载 `package.json` 中 `omp.extensions` 声明的扩展模块：安装会将缓存的插件符号链接到作用域的 `node_modules` 树中，并记录在 `omp-plugins.lock.json` 中——这与 npm 安装和 `omp plugin link` 插件使用的运行时表面相同。插件以 `name@marketplace` 标识（例如 `code-review@claude-plugins-official`）。

**作用域**：市场插件可以安装在两个作用域：

- **user**（默认）——在所有项目中可用，存储在用户插件数据根的 `installed_plugins.json` 中（默认为 `~/.omp/plugins/installed_plugins.json`）
- **project**——仅在活动项目中可用，存储在最近的项目 `.omp/plugins/installed_plugins.json` 中

已启用的项目级安装会遮蔽同一插件的已启用用户级安装。已禁用的项目安装不会遮蔽用户安装。

在 Linux 和 macOS 上，`omp config init-xdg` 会创建 XDG data、state 和 cache 根目录；它不会移动现有数据。一旦相关根目录存在且设置了 `XDG_DATA_HOME`、`XDG_STATE_HOME` 和 `XDG_CACHE_HOME`，新的用户级市场/插件状态会解析到 `$XDG_DATA_HOME/omp` 下（包括 `marketplaces.json` 和 `plugins/`）。下面的 `~/.omp` 路径是非 XDG 默认值。

## 命令

### 交互模式

| 命令          | 效果                                    |
| -------------- | ----------------------------------------- |
| `/marketplace` | 打开交互式插件浏览器（安装） |

### 市场管理

| 命令                      | 效果                                       |
| ---------------------------- | -------------------------------------------- |
| `/marketplace add <source>`  | 添加市场来源                     |
| `/marketplace remove <name>` | 移除市场                         |
| `/marketplace update [name]` | 重新获取目录；省略名称则更新全部 |
| `/marketplace list`          | 列出已配置的市场                 |

### 插件操作

| 命令                                                                   | 效果                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `/marketplace discover [marketplace]`                                     | 浏览可用插件                           |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | 安装插件                                   |
| `/marketplace uninstall [--scope user\|project] name@marketplace`         | 卸载插件；无参数时打开 TUI 选择器 |
| `/marketplace installed`                                                  | 列出已安装的市场插件                 |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]`         | 升级一个或全部插件                         |
| `/plugins list`                                                           | 列出 npm/link 和市场插件              |
| `/plugins enable [--scope user\|project] name@marketplace`                | 启用市场插件                        |
| `/plugins disable [--scope user\|project] name@marketplace`               | 禁用市场插件                       |

### CLI 等价命令

同样的操作可从命令行使用：

```
omp plugin marketplace add <source>
omp plugin marketplace remove <name>
omp plugin marketplace update [name]
omp plugin marketplace list
omp plugin discover [marketplace]
omp plugin install [--force] [--scope user|project] name@marketplace
omp plugin uninstall [--scope user|project] name@marketplace
omp plugin upgrade [--scope user|project] [name@marketplace]
omp plugin enable [--scope user|project] name@marketplace
omp plugin disable [--scope user|project] name@marketplace
omp plugin list

```

TUI 市场变更（显式命令和选择器）会更新磁盘状态并使发现缓存失效，但不会刷新活动会话。运行 `/reload-plugins` 刷新技能、斜杠命令和 MCP 服务器；新安装的工具、钩子或扩展模块需要重启会话。ACP/RPC 市场处理程序会自动刷新技能和斜杠命令，但同样不会重建每个已初始化的能力集。

## 市场来源

运行 `/marketplace add <source>` 时，系统会对来源进行分类：

| 来源格式                   | 类型                                               | 示例                                |
| ------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `owner/repo`                    | GitHub 简写                                   | `anthropics/claude-plugins-official`   |
| `https://...*.json`             | 直接目录 URL                                 | `https://example.com/marketplace.json` |
| `https://...` / `http://...`    | Git 仓库，除非 URL 路径以 `.json` 结尾 | `https://github.com/org/repo`          |
| `git@...` / `ssh://...`         | Git 仓库                                     | `git@github.com:org/repo.git`          |
| `./path` 或 `~/path` 或 `/path` | 本地目录                                    | `./my-marketplace`                     |

Git 和本地来源必须包含 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容回退）中的目录。直接目录 URL 只缓存 JSON 目录；URL 来源目录中的插件不能使用 `"./plugins/foo"` 这样的相对字符串来源。

## 目录格式（marketplace.json）

市场目录位于仓库根目录的 `.omp-plugin/marketplace.json`。当 omp 是唯一预期消费者时，优先使用此路径。要保持 Claude Code 兼容（omp 从任一路径加载相同结构），请改为发布到 `.claude-plugin/marketplace.json`——当 `.omp-plugin/marketplace.json` 不存在时，omp 将其用作回退。仓库可以同时发布两者：omp 读取 `.omp-plugin/` 副本，Claude Code 读取 `.claude-plugin/` 副本。两种方式目录格式相同：

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "metadata": {
    "description": "A collection of plugins",
    "version": "1.0.0",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### 必填字段

| 字段        | 描述                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`       | 市场名称。小写字母数字、连字符和点。必须以字母数字开头和结尾。最多 64 个字符。 |
| `owner.name` | 市场所有者名称                                                                                           |
| `plugins`    | 插件条目数组                                                                                          |

顶层 `metadata.description`、`metadata.version` 和 `metadata.pluginRoot` 可选。设置 `metadata.pluginRoot` 后，它会作为前缀加到相对插件 `source` 路径之前。

### 插件条目字段

| 字段         | 必填 | 描述                                                                                    |
| ------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`        | 是      | 插件名称（规则与市场名称相同）                                                   |
| `source`      | 是      | 在哪里找到插件（见下文）                                                           |
| `description` | 否       | 简短描述                                                                              |
| `version`     | 否       | 版本字符串；安装版本回退到插件清单、来源 SHA，然后是 `0.0.0`        |
| `author`      | 否       | `{ name, email? }`                                                                             |
| `homepage`    | 否       | URL                                                                                            |
| `repository`  | 否       | 仓库 URL/字符串                                                                          |
| `license`     | 否       | 许可证字符串                                                                                 |
| `keywords`    | 否       | 字符串关键词数组                                                                       |
| `category`    | 否       | 类别字符串（例如 `development`、`productivity`、`security`）                               |
| `tags`        | 否       | 字符串标签数组                                                                           |
| `strict`      | 否       | 布尔元数据标志；保留但不被安装/运行时逻辑使用                         |
| `commands`    | 否       | 命令元数据；保留，但运行时命令从已安装的插件树中发现 |
| `agents`      | 否       | Agent 元数据；保留但不被市场安装消费                         |
| `hooks`       | 否       | 钩子元数据；保留，但运行时钩子从已安装的插件树中发现       |
| `mcpServers`  | 否       | MCP 元数据；此处保留；运行时 MCP 配置来自插件清单/树    |
| `lspServers`  | 否       | 内联映射或插件内路径；安装期间复制到 `.lsp.json`                        |
| `dapAdapters` | 否       | 内联映射或插件内 JSON/YAML 路径；复制到 `.dap.json`、`.dap.yaml` 或 `.dap.yml`      |

### 插件来源格式

`source` 字段支持以下格式。字符串来源必须以 `./` 开头，并在可选的 `metadata.pluginRoot` 前缀之后在市场根目录内解析：

**相对路径**（市场仓库内）：

```json
"source": "./my-plugin"
```

**Git 仓库 URL**：

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub 简写**：

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git 子目录**（monorepo）：

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm 包**（可解析但尚不可安装）：

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

当前安装器会以 `npm plugin sources are not yet supported` 拒绝 npm 市场来源；请使用相对、GitHub、URL 或 git-subdir 来源。

无效的目录 JSON 或无效的必填顶层字段会拒绝该目录。无效的插件条目会被记录并跳过，以便其他有效条目保持可用。

## 更新、移除和作用域

- `/marketplace update [name]` 只刷新目录；不会重新安装插件。
- 省略 `--scope` 时，`omp plugin upgrade name@marketplace` 会重新安装每个已安装的作用域。当插件在两个作用域中都存在时，`/marketplace upgrade name@marketplace`、卸载以及启用/禁用需要 `--scope user|project`。
- 升级全部插件只比较声明了 `version` 的目录条目。Semver 版本必须更新；非 semver 版本在不相同时视为已更改。单个插件的失败会被跳过，因此全插件升级可能部分成功。
- `marketplace.autoUpdate` 控制启动检查：`off`、`notify`（默认）或 `auto`。超过 24 小时的目录会在版本检查前尽力刷新。尽管名称如此，当前的 `notify` 模式只将更新可用性写入调试日志；它不会显示面向用户的通知。
- 移除市场会移除其注册表条目和目录缓存；不会卸载已缓存并注册的插件。

## 磁盘布局

```
~/.omp/
  marketplaces.json              # 已添加市场的注册表
  plugins/
    installed_plugins.json       # 用户作用域市场插件（版本：2）
    omp-plugins.lock.json         # 运行时启用/功能状态
    node_modules/<package>        # 指向缓存插件的符号链接
    cache/
      marketplaces/<name>/       # 缓存的市场克隆/目录
      plugins/<marketplace>___<plugin>___<version>/  # 缓存的插件目录

<project>/.omp/
  plugins/
    installed_plugins.json       # 项目作用域市场插件（版本：2）
    omp-plugins.lock.json         # 项目运行时启用/功能状态
    node_modules/<package>        # 指向缓存插件的符号链接
```

## 命名规则

市场和插件名称必须：

- 以小写字母或数字开头和结尾
- 只包含小写字母、数字、连字符和点
- 最多 64 个字符

插件 ID（`name@marketplace`）总共最多 128 个字符。

有效示例：`my-plugin`、`code-review`、`wordpress.com`、`ai-firstify`
无效示例：`-bad`、`bad-`、`.bad`、`Bad`、`under_score`
