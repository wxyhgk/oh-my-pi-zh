# 扩展加载(TypeScript/JavaScript 模块)

本文档描述 coding agent 在启动时如何发现和加载扩展模块。被扫描的原生/配置目录自动发现 `.ts` 和 `.js`;显式命名的文件和已安装插件清单条目也可以使用 `.mjs` 和 `.cjs`。

它**不**涵盖 [`gemini-extension.json` 清单扩展](./gemini-manifest-extensions.md),那些单独记录。

## 此子系统做什么

扩展加载构建模块入口文件列表,用 Bun 导入每个模块,执行其工厂,并返回:

- 已加载的扩展定义
- 按路径的加载错误(不中止整个加载)
- 之后由 `ExtensionRunner` 使用的共享扩展运行时对象

## 主要实现文件

- `src/extensibility/extensions/loader.ts` — 路径发现 + 导入/执行
- `src/extensibility/extensions/index.ts` — 公开导出
- `src/extensibility/extensions/runner.ts` — 加载后的运行时/事件执行
- `src/discovery/builtin.ts` — 扩展模块的原生自动发现提供商
- `src/extensibility/plugins/legacy-pi-compat.ts` — 就地模块图加载与主机包兼容性重写
- `src/config/settings.ts` — 加载合并的 `extensions` / `disabledExtensions` 设置

---

## 扩展加载的输入

### 1) 自动发现的原生扩展模块

`discoverAndLoadExtensions()` 首先向发现提供商请求 `extension-module` 能力条目,然后只保留提供商为 `native` 的条目。

原生 `extension-module` 发现来自:

- 项目目录:`<cwd>/.omp/extensions`
- 用户目录:活动 Agent 目录的 `extensions/`(默认 `~/.omp/agent/extensions`)
- 原生遗留/设置 JSON 条目:`<cwd>/.omp/settings.json#extensions` 和活动 Agent 目录的 `settings.json#extensions`

项目根是原生提供商的 `.omp` 目录(`SOURCE_PATHS.native.projectDir`),仅 cwd;它不向上遍历祖先。用户根是通过 `getAgentDir()` 得到的活动 profile 的 Agent 目录,因此在 `omp --profile <name>` 下它变为 `~/.omp/profiles/<name>/agent/extensions`(并尊重 `PI_CODING_AGENT_DIR`)。见 [Profiles](./config-usage.md#profiles)。

说明:

- 原生自动发现目前基于 `.omp`。
- 遗留 `.pi` 在包清单(`pi.extensions`)和项目覆盖查找中仍被接受,但 `.pi/extensions` 这里不是原生根。

### 2) 发现的 JS/TS 钩子工厂

原生自动发现之后,`discoverAndLoadExtensions()` 还追加来自 `hook` 能力的 JS/TS 钩子工厂——任何入口路径为 `.ts`/`.js` 文件的钩子——使它们通过同一个模块流水线加载。

钩子能力加载已应用其自身的钩子特定禁用 id,因此这些路径不会被 `disabledExtensions` 扩展模块名额外过滤。

### 3) 已安装插件的扩展条目

钩子发现之后,`discoverAndLoadExtensions()` 通过 `getAllPluginExtensionPaths(cwd)` 追加来自已启用已安装插件的扩展入口点。

插件扩展条目来自包 `omp.extensions` / `pi.extensions` 清单,包括启用的功能条目。

已安装插件清单解析接受显式 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。对命名目录的清单条目,它识别 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`;扩展目录展开使用同样的四个后缀。这比原生和配置目录自动扫描更宽,后者仍限于 `.ts` 和 `.js`。

### 4) 显式配置的路径

插件扩展条目之后,配置路径被追加并解析。

主会话启动路径(`sdk.ts`)中的配置路径来源:

1. CLI 提供的路径(`--extension/-e`;`--hook` 也被当作扩展路径)
2. 合并设置 `extensions` 数组

设置文件:

- 用户:活动 Agent 目录的 `config.yml`(默认 `~/.omp/agent/config.yml`;带 `--profile <name>` 时为 `~/.omp/profiles/<name>/agent/config.yml`;`PI_CODING_AGENT_DIR` 可覆盖 Agent 目录)
- 项目/原生设置能力:`<cwd>/.omp/config.yml` 和 `<cwd>/.omp/settings.json`

原生扩展模块发现也读取遗留 JSON 扩展列表,来自:

- 活动 Agent 目录的 `settings.json`(默认 `~/.omp/agent/settings.json`)
- `<cwd>/.omp/settings.json`

示例:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/my-exts/safety.ts
  - ./local/ext-pack
```

```json
{
  "extensions": ["./.omp/extensions/my-extra"]
}
```

---

## 启用/禁用控制

### 禁用发现

- CLI:`--no-extensions`
- SDK 选项:`disableExtensionDiscovery`

行为区分:

- SDK:当 `disableExtensionDiscovery=true` 时,环境扩展工厂被
  排除,而 `additionalExtensionPaths` 仍正常解析
  (包括带 `package.json#omp.extensions` 的包目录)。
- CLI:`--no-extensions` 遵循同样的仅显式契约。显式
  `-e/--extension` 和 `--hook` 路径仍加载,只有来自显式命名的
  扩展包的兄弟能力根保持合格。项目/用户
  `extensions:` 设置和已安装的 OMP 扩展包从
  该兄弟表面排除。

此标志管辖扩展工厂和 OMP 扩展包兄弟根;
它不是全进程能力隔离开关。技能、MCP 服务器、
工具、提示和由其他发现子系统拥有的规则保留各自的
启用/禁用控制。

### 禁用特定扩展模块

`disabledExtensions` 设置按扩展 id 格式过滤:

- `extension-module:<derivedName>`

`derivedName` 基于入口路径(`getExtensionNameFromPath`),例如:

- `/x/foo.ts` -> `foo`
- `/x/bar/index.ts` -> `bar`

示例:

```yaml
disabledExtensions:
  - extension-module:foo
```

---

## 路径与条目解析

### 路径规范化

对配置路径:

1. 规范化 Unicode 空格和支持的路径简写(包括 `file://`、`@/absolute/path`,以及绝对/相对路径前的游离 `:`)
2. 展开 `~`
3. 若为相对路径,对照当前 `cwd` 解析
4. 拒绝内部 `local://` 方案;它必须由其协议处理器解析,而非当作文件系统路径

### 若配置路径是文件

它直接被用作模块入口候选。支持显式 `.ts`、`.js`、`.mjs` 和 `.cjs` 文件。

### 若配置路径是目录

解析顺序:

1. 该目录中带 `omp.extensions`(或遗留 `pi.extensions`)的 `package.json` -> 使用声明的条目
2. `index.ts`
3. `index.js`
4. 否则扫描一级扩展条目:
   - 直接 `*.ts` / `*.js`
   - 子目录 `index.ts` / `index.js`
   - 带 `omp.extensions` / `pi.extensions` 的子目录 `package.json`

规则与约束:

- 不递归发现超过一个子目录层级
- 声明的 `extensions` 清单条目相对该包目录解析
- 仅当文件存在/允许访问时包含声明的条目
- 在 `*/index.{ts,js}` 对中,TypeScript 优先于 JavaScript
- 符号链接被视为合格文件/目录

### 忽略行为因来源而异

- 原生自动发现(`discovery helpers` 中的 `discoverExtensionModulePaths`)使用 `gitignore: true` 和 `hidden: false` 的原生 glob。
- `loader.ts` 中的显式配置目录扫描使用 `readdir` 规则,**不**应用 gitignore 过滤。

---

## 加载顺序与优先级

`discoverAndLoadExtensions()` 构建一个有序列表,然后调用 `loadExtensions()`。

顺序:

1. 原生自动发现的模块
2. 发现的 JS/TS 钩子工厂
3. 已安装插件扩展条目
4. 显式配置的路径(按提供顺序)

在 `sdk.ts` 中,配置顺序为:

1. CLI 附加路径
2. 设置 `extensions`

去重:

- 基于绝对路径
- 先见路径胜出
- 之后重复的被忽略

含义:如果同一模块路径既被自动发现又被显式配置,它只在第一个位置(自动发现阶段)加载一次。

---

## 模块导入与工厂契约

每个候选路径通过 `loadLegacyPiModule()`(`src/extensibility/plugins/legacy-pi-compat.ts`)加载:

- 解析入口的 realpath,然后用 `?mtime` 缓存破坏器动态导入,使编辑过的源码重新加载
- 作用域化的 Bun `onLoad` 钩子在求值前把遗留 pi 包说明符(`@mariozechner/*`、`@earendil-works/*`)和裸 `@sinclair/typebox` 重写到主机捆绑副本
- 工厂由 `getExtensionFactory(module)` 选择:模块本身若是函数则用之,否则用 `module.default`
- 工厂必须是函数(`ExtensionFactory`),可返回 `void` 或 promise;加载在继续下一个路径前等待它

如果导出不是函数,该路径以结构化错误失败,加载继续。

---

## 失败处理与隔离

### 加载期间

每个扩展路径的失败被捕获为 `{ path, error }`,不阻止其他路径加载。

常见情况:

- 导入失败 / 文件缺失
- 无效工厂导出(非函数)
- 执行工厂时抛出的异常

### 运行时隔离模型

- 扩展**不沙箱化**(同一进程/运行时)。
- 它们共享一个 `EventBus` 和一个 `ExtensionRuntime` 实例。
- 加载期间,运行时操作方法有意抛出 `ExtensionRuntimeNotInitializedError`;动作接线稍后在 `ExtensionRunner.initialize()` 中发生。

### 加载之后

事件流经 `ExtensionRunner` 时,处理器异常被捕获并作为扩展错误发出,而不是使运行器循环崩溃。

---

## 最小用户/项目布局示例

### 用户级

```text
~/.omp/agent/
  config.yml
  extensions/
    guardrails.ts
    audit/
      index.ts
```

### 项目级

```text
<repo>/
  .omp/
    settings.json
    extensions/
      checks/
        package.json
      lint-gates.ts
```

`checks/package.json`:

```json
{
  "omp": {
    "extensions": ["./src/check-a.ts", "./src/check-b.js"]
  }
}
```

仍接受的遗留清单键:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
