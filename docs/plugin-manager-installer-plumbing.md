# 插件管理器与安装器内部机制

本文档描述 `omp plugin` 的 npm/git/link 与市场操作如何改变磁盘上的插件状态并成为运行时能力。市场安装保留自己的注册表与缓存,然后通过 npm/git/link 安装使用的相同 `node_modules` 与 `omp-plugins.lock.json` 运行时表面注册缓存插件;参见 `docs/marketplace.md`。

## 范围与架构

代码库中有两个插件管理实现:

1. **CLI 命令使用的活动路径**:`PluginManager`(`src/extensibility/plugins/manager.ts`)
2. **旧版辅助模块**:安装器函数(`src/extensibility/plugins/installer.ts`)

`omp plugin` 的 npm/git/link 操作通过 `PluginManager`;市场操作通过 `MarketplaceManager`。`install` 分类每个目标(`cli/classify-install-target.ts` 中的 `classifyInstallTarget`):`name@marketplace` 路由到市场管理器,本地路径路由到 `PluginManager.link()`,git 与 npm spec 路由到 `PluginManager.install()`。

`installer.ts` 仍记录重要的安全检查与文件系统行为,但它不是 `src/commands/plugin.ts` + `src/cli/plugin-cli.ts` 使用的路径。

## 生命周期:从 CLI 调用到运行时可用

```text
omp plugin <npm/link 操作> ...
  -> src/commands/plugin.ts
  -> runPluginCommand(...) in src/cli/plugin-cli.ts
  -> PluginManager 方法 (install/list/uninstall/link/...)
  -> 变更用户插件数据根 {package.json,node_modules,omp-plugins.lock.json}
  -> 启用插件枚举发现用户与最近的项目插件根
  -> 直接加载器解析 manifest 声明的工具/扩展条目
  -> `omp-plugins` 能力发现扫描惯例 skills/hooks/tools/commands/rules/prompts/MCP 内容;任务发现扫描 `agents/`

omp plugin install name@marketplace / omp install name@marketplace
  -> MarketplaceManager
  -> 变更作用域注册表与共享缓存
  -> 将缓存包符号链接进作用域的 node_modules 并更新 omp-plugins.lock.json
  -> `claude-plugins` 发现加载市场 skills/commands/hooks/tools/MCP;任务发现加载 `agents/`;扩展加载器导入 `package.json#omp.extensions`
```

### 命令入口点

- `src/commands/plugin.ts` 定义命令/标志并转发给 `runPluginCommand`。
- `src/cli/plugin-cli.ts` 将 npm/link 子命令映射到 `PluginManager` 方法:
  - `install`、`uninstall`、`list`、`link`、`doctor`、`features`、`config`、`enable`、`disable`
- `discover`、`upgrade` 与 `marketplace ...` 子命令使用 `MarketplaceManager`。
- 不存在显式 npm 插件 `update` 操作;更新通过用新包/版本 spec 重新运行 `install` 完成。

## 磁盘模型

用户插件状态位于插件数据根(`~/.omp/plugins` 默认)下。在 Linux 与 macOS 上,`omp config init-xdg` 创建 XDG data、state 与 cache 根,但不移动现有数据;相关根存在且 XDG 变量设置后,新用户插件状态解析到 `$XDG_DATA_HOME/omp/plugins` 下:

- `package.json` — 用于 npm 安装插件的 `bun install`/`bun uninstall` 依赖 manifest
- `node_modules/` — 已安装 npm 包加 link 与市场缓存符号链接
- `omp-plugins.lock.json` — npm/link/市场插件的运行时状态:
  - 每个插件的启用/禁用
  - 每个插件选定的功能集
  - 持久化的插件设置

当项目锚点(`.omp/` 或 `.git/`)存在于 cwd 或以上时,项目运行时插件位于 `<anchor>/.omp/plugins/{node_modules,omp-plugins.lock.json}`。市场项目安装填充此根;启用的项目包遮蔽同名用户包。

项目本地覆盖通过项目配置目录搜索为 `plugin-overrides.json`(通常 `<project>/.omp/plugin-overrides.json`)。从管理器/加载器角度看,覆盖是只读的,可禁用插件或覆盖功能/设置。

市场安装在这些运行时条目旁添加注册表与缓存状态:

- 用户数据根 `marketplaces.json`(`~/.omp/marketplaces.json` 默认)— 配置的市场目录
- 用户插件数据根 `installed_plugins.json`(`~/.omp/plugins/installed_plugins.json` 默认)— 用户作用域的市场安装
- `<anchor>/.omp/plugins/installed_plugins.json` — 项目作用域的市场安装
- 用户插件数据根 `cache/{marketplaces,plugins}/` — 缓存的目录与插件目录
- `<scope>/plugins/node_modules/<package>` — 指向缓存插件的符号链接,使其 `package.json` 的 `omp.extensions` 与工具可加载
- `<scope>/plugins/omp-plugins.lock.json` — 与运行时插件加载器共享的启用与功能状态

## 插件 spec 解析与元数据解释

## 安装 spec 语法

`parsePluginSpec`(`parser.ts`)支持:

- `pkg` -> `features: null`(默认行为)
- `pkg[*]` -> 启用所有 manifest 功能
- `pkg[]` -> 不启用可选功能
- `pkg[a,b]` -> 启用指定功能
- `@scope/pkg@1.2.3[feat]` -> 带显式功能选择的 scoped + 版本化包

`PluginManager.install` 也接受 git 源(由 `validateGitSpec` 验证,而非 npm 正则):带命名空间的简写 `github:user/repo[#ref]`、`gitlab:`、`bitbucket:`、`codeberg:`、`sourcehut:`/`srht:`,与完整 git URL(`https://github.com/user/repo`、`git@github.com:user/repo`、`ssh://…`、`git+https://…`)。Git spec 不编码包名,因此 install 对 `bun install` 前后的 `plugins/package.json#dependencies` 做差异以解析它。

`extractPackageName` 剥离版本后缀以在安装后做磁盘路径查找。

## Manifest 源与必填字段

Manifest 按以下顺序解析:

1. `package.json.omp`
2. 回退 `package.json.pi`
3. 回退 `{ version: package.version }`

含义:

- 管理器/加载器中没有严格 schema 验证。
- 缺少 `omp`/`pi` 的包仍可安装与列出。
- 运行时插件加载(`getEnabledPlugins`)跳过无 `omp`/`pi` manifest 的包。
- `manifest.version` 总是从包 `version` 覆盖。

畸形 `package.json` JSON 在读取时是硬失败;畸形 manifest 形状可能仅在消费特定字段时稍后失败。

## 安装/更新流程(`PluginManager.install`)

1. 从安装 spec 解析功能括号语法。
2. 验证 spec:git spec 通过 `validateGitSpec`;npm spec 对照包名正则 + shell 元字符拒绝列表。
3. 确保插件 `package.json` 存在(`omp-plugins`、私有依赖映射)。
4. 在 `~/.omp/plugins` 中运行 `bun install <packageSpec>`。
5. 解析已安装包名(npm:通过 `extractPackageName` 剥离版本;git:对 `dependencies` 做前后差异)并读取 `node_modules/<name>/package.json`。
6. 解析 manifest 并计算 `enabledFeatures`:
   - `[*]`:所有声明功能(无功能映射则为 `null`)
   - `[a,b]`:验证每个功能存在于 manifest 功能映射中
   - `[]`:空功能列表
   - 裸 spec:`null`(稍后在加载器中使用默认策略)
7. 验证声明的扩展条目(`#validateInstalledExtensions`):每个 manifest `extensions` 条目必须解析到磁盘并导入为工厂函数。失败时回滚安装 —— 恢复之前的 `plugins/package.json`、移除新装包,并从 `bun install` 前拍摄的备份恢复任何先前版本 —— 然后中止。
8. 更新锁文件运行时状态:`{ version, enabledFeatures, enabled: true }`。

### 更新语义

因为更新由安装驱动:

- `omp plugin install pkg@newVersion` 更新依赖与锁文件版本。
- 现有设置保留在单独设置映射中;插件状态条目被新版本/功能与启用状态替换。
- 安装快照先前的包树、`package.json` 与 `bun.lock`。任何安装后失败,包括功能验证、扩展验证或运行时配置保存,都尝试恢复三者。
- 不存在单独的 npm 插件“检查更新”或迁移操作。

## 移除流程(`PluginManager.uninstall`)

1. 验证包名。
2. 在插件目录中运行 `bun uninstall <name>`。
3. 从锁文件移除插件运行时状态:
   - `config.plugins[name]`
   - `config.settings[name]`

如果卸载命令失败,运行时状态不变。

## 列出流程(`PluginManager.list`)

1. 读取依赖映射与锁文件运行时条目;其并集包括 npm 安装与仅 link 插件。
2. 加载项目覆盖。
3. 从 `node_modules` 解析每个包;跳过市场运行时符号链接,因为市场摘要单独列出。
4. 构建 `InstalledPlugin` 记录并合并有效状态:
   - 基础来自锁文件(或默认值)
   - 项目覆盖可替换功能选择
   - 项目 `disabled` 列表将插件遮蔽为禁用

`omp plugin list` 将该结果与 `MarketplaceManager.listInstalledPlugins()` 组合。

## 链接流程(`PluginManager.link`)

`link` 通过将本地包符号链接进 `~/.omp/plugins/node_modules/<pkg.name>` 支持本地插件开发。

行为:

1. 针对管理器 cwd 解析 `localPath`。
2. 要求本地 `package.json` 与 `name` 字段。
3. 确保插件目录存在。
4. 对 scoped 名称,创建作用域目录。
5. 移除目标链接位置处的现有路径。
6. 创建符号链接。
7. 添加启用且功能为默认(`null`)的运行时锁文件条目。

注意事项:当前 `PluginManager.link` 不强制旧版 `installer.ts` 中存在的 `cwd` 路径边界检查(`normalizedPath.startsWith(normalizedCwd)`),因此信任是调用方的责任。

## 运行时加载:从已安装插件到可调用能力

## 发现门

`getEnabledPlugins(cwd)`(`plugins/loader.ts`)读取:

- 插件依赖 manifest(`package.json`),与锁文件插件条目并集,使仅 `plugin link` 而无依赖条目的插件仍被发现
- 锁文件运行时状态
- 通过 `getConfigDirPaths("plugin-overrides.json", { user: false, cwd })` 的项目覆盖

筛选:

- 无插件 package.json 则跳过
- 无 manifest(`omp`/`pi`)则跳过
- 锁文件中全局禁用则跳过
- 项目禁用则跳过

## 能力路径解析

对每个启用插件:

- `resolvePluginExtensionPaths(plugin)`
- `resolvePluginToolPaths(plugin)`
- `resolvePluginHookPaths(plugin)`
- `resolvePluginCommandPaths(plugin)`

每个解析器包含基础条目加功能条目:

- 基础条目总是包含
- 显式功能列表 -> 仅选定功能
- `enabledFeatures === null` -> 启用标记 `default: true` 的功能

Manifest 条目可指向文件或包含 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs` 的目录。缺失文件静默跳过(`statSync`/`existsSync` 守卫)。

## 当前运行时接线

- Manifest 声明的**工具**通过 `getAllPluginToolPaths(cwd)` 提供给 `discoverAndLoadCustomTools`。
- Manifest 声明的**扩展**通过 `getAllPluginExtensionPaths(cwd)` 提供给 `discoverAndLoadExtensions`。
- `omp-plugins` 能力提供商在启用 npm/link 插件根下单独扫描惯例的 `skills/`、`hooks/pre|post/`、`tools/`、`commands/`、`rules/`、`prompts/` 与 `.mcp.json`。任务 Agent 发现扫描相同根的 `agents/`。市场根在那里被排除,改由 `claude-plugins` 加市场任务 Agent 发现处理。
- Manifest 钩子/命令路径解析器保持导出,但运行时钩子/斜杠发现使用惯例能力提供商扫描,而非 `getAllPluginHookPaths()` 或 `getAllPluginCommandPaths()`。
- 直接自定义工具与扩展路径列表按解析的绝对路径去重(`seen`,先到先得)。

## 锁/状态管理细节

`PluginManager` 按实例在内存中缓存运行时配置(`#runtimeConfig`),并惰性加载一次。

管理器加载行为:

- 锁文件缺失 -> `{ plugins: {}, settings: {} }`
- 锁文件读取/解析失败 -> 警告 + 相同的空默认值

启用插件发现独立加载每个用户/项目根:缺失锁文件为空,而非 ENOENT 的读取/解析失败则传播。

保存行为:

- 每次变更以 pretty-printed 形式写入完整锁文件 JSON

不存在跨进程锁定或合并策略;并发写入者可互相覆盖。

## 安全检查与信任边界

## 输入/包验证

活动管理器路径强制包名验证:

- npm spec:scoped/unscoped spec 的包名正则(`VALID_PACKAGE_NAME`),可选带版本。
- npm shell 元字符拒绝列表:`;`、`&`、`|`、反引号、`$`、`(`、`)`、`{`、`}`、`[`、`]`、`<`、`>`、`\` —— 在 `parsePluginSpec` 剥离功能括号后应用,因此普通 `pkg[feat]` spec 永远不会到达它。
- git spec:`validateGitSpec` 只拒绝共享的 `SHELL_METACHARS` 集合(`;`、`&`、`|`、反引号、`$`、`(`、`)`、`{`、`}`、`<`、`>`、`\`、换行、CR、tab),而非 npm 正则,因此允许 `:`、`/`、`#`、`+`、`.`、`-`、`_`、`~`、`@`。

这限制了调用 `bun install/uninstall` 时的命令注入风险。

## 文件系统信任边界

- 导入自定义工具模块时插件代码在进程内执行;无沙箱。
- Manifest 相对路径针对插件包目录连接,仅做存在性检查。
- 一旦安装,插件包本身是被信任的代码。

## 仅旧版安装器的检查

`installer.ts` 包含 `PluginManager.link` 未镜像的额外链接时检查:

- 本地路径必须解析在项目 cwd 内
- 符号链接目标命名的额外包名/路径遍历守卫

因为 CLI 使用 `PluginManager`,这些更严格的链接守卫当前不在主路径上。

## 失败、部分成功与回滚行为

插件管理器不是事务性的。

| 操作阶段                                      | 失败行为                  | 回滚                                                                 |
| --------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| `bun install` 或后续 git `bun update` 失败    | 安装以 stderr 中止        | 恢复之前的 `package.json`、`bun.lock` 与包快照                       |
| 功能或扩展验证失败                            | 命令失败                  | 相同安装回滚                                                         |
| 运行时锁文件写入失败                          | 命令失败                  | 相同安装回滚;回滚失败附加到报告的错误                                |
| `bun uninstall` 成功,锁文件写入失败           | 命令失败                  | 包已移除,过期运行时状态可能保留                                      |
| `link` 移除旧目标后符号链接创建失败           | 命令失败                  | 不恢复之前的链接/目录                                                 |

操作上,`doctor --fix` 可修复一些漂移(`bun install`、孤儿配置清理、无效功能清理),但它是尽力而为。

## 畸形/缺失 manifest 行为摘要

- 缺失 `omp`/`pi` 字段:
  - 安装/列出:容忍(最小 manifest)
  - 运行时启用插件发现:作为非插件跳过
- 安装 spec 或 `features --set/--enable` 引用缺失功能:带可用功能列表的硬错误
- 无效 `plugin-overrides.json`:忽略并在管理器与加载器路径中回退为 `{}`
- Manifest 引用的缺失工具/钩子/命令文件路径:解析器展开期间静默忽略;仅由 `doctor` 标记为错误

## 模式差异与优先级

- `--dry-run`(安装):返回合成安装结果,无 `bun install`、无网络、无锁文件/运行时状态写入(仍确保插件 `package.json` 骨架存在)。
- `--json`:仅输出格式,无行为变化。
- 项目覆盖在功能/设置视图上总是优先于全局锁文件。
- 有效启用的状态是 `runtimeEnabled && !projectDisabled`。

## 实现文件

- [`src/commands/plugin.ts`](../packages/coding-agent/src/commands/plugin.ts) — CLI 命令声明与标志映射
- [`src/cli/plugin-cli.ts`](../packages/coding-agent/src/cli/plugin-cli.ts) — 操作分派、面向用户的命令处理器
- [`src/extensibility/plugins/manager.ts`](../packages/coding-agent/src/extensibility/plugins/manager.ts) — 活动安装/移除/列出/链接/状态/doctor 实现
- [`src/extensibility/plugins/installer.ts`](../packages/coding-agent/src/extensibility/plugins/installer.ts) — 旧版安装器辅助函数与额外链接安全检查
- [`src/extensibility/plugins/loader.ts`](../packages/coding-agent/src/extensibility/plugins/loader.ts) — 启用插件发现与 manifest 工具/钩子/命令/扩展路径解析
- [`src/extensibility/plugins/parser.ts`](../packages/coding-agent/src/extensibility/plugins/parser.ts) — 安装 spec 与包名解析辅助函数
- [`src/extensibility/plugins/types.ts`](../packages/coding-agent/src/extensibility/plugins/types.ts) — manifest/运行时/覆盖类型契约
- [`src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts) — npm/link 扩展包的惯例能力发现
- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts) — 扩展与市场插件根的惯例 `agents/` 发现
- [`src/discovery/claude-plugins.ts`](../packages/coding-agent/src/discovery/claude-plugins.ts) — 市场插件能力发现
- [`src/extensibility/custom-tools/loader.ts`](../packages/coding-agent/src/extensibility/custom-tools/loader.ts) — manifest 声明插件工具模块的运行时接线
- [`src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts) — 插件扩展模块的运行时接线
