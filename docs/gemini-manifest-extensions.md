# Gemini Manifest 扩展(`gemini-extension.json`)

本文档介绍 coding-agent 如何发现并解析 Gemini 风格的 manifest 扩展(`gemini-extension.json`),并将其纳入 `extensions` 能力。

本文档**不**涵盖 TypeScript/JavaScript 扩展模块加载(`extensions/*.ts`、`index.ts`、`package.json omp.extensions`),相关内容在 [Extension Loading](./extension-loading.md) 中说明。

## 实现文件

- [`packages/coding-agent/src/discovery/gemini.ts`](../packages/coding-agent/src/discovery/gemini.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/capability/extension.ts`](../packages/coding-agent/src/capability/extension.ts)
- [`packages/coding-agent/src/capability/extension-module.ts`](../packages/coding-agent/src/capability/extension-module.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts)

---

## 会发现什么

Gemini 提供商(`id: gemini`,优先级 `60`)注册了一个 `extensions` 加载器,扫描两个固定根目录:

- 用户:`~/.gemini/extensions`
- 项目:`<cwd>/.gemini/extensions`

路径解析通过 `getUserPath()` / `getProjectPath()` 直接从 `ctx.home` 和 `ctx.cwd` 进行。

重要的作用域规则:项目查找**仅限当前 cwd**。它不会向上遍历父目录。

---

## 目录扫描规则

对于每个根目录(`~/.gemini/extensions` 和 `<cwd>/.gemini/extensions`),发现过程执行:

1. `readDirEntries(root)`
2. 只保留直接子目录(`entry.isDirectory()`)
3. 对每个子目录 `<name>`,尝试精确读取:
   - `<root>/<name>/gemini-extension.json`

超过一个目录级别没有递归扫描。

### 隐藏目录

Gemini manifest 发现**不会**筛选掉以点开头的目录名。如果存在隐藏子目录且包含 `gemini-extension.json`,它会被考虑。

### 缺失/不可读的文件

如果 `gemini-extension.json` 缺失或不可读,该目录会被静默跳过(无警告)。

---

## Manifest 形状(按实现)

能力类型定义了此 manifest 形状:

```ts
interface ExtensionManifest {
  name?: string;
  description?: string;
  mcpServers?: Record<string, Omit<MCPServer, "name" | "_source">>;
  tools?: unknown[];
  context?: unknown;
}
```

发现时的行为有意宽松:

- 文件必须非空,且 `tryParseJson()` 必须返回真值。
  因此无效 JSON 和语法有效的 JSON 字面量 `null`、`false`、`0` 或 `""` 走相同的警告路径。
- 在该门槛之后,对字段类型/内容没有运行时 schema 验证。
- 解析后的值作为 `manifest` 存储在能力项上。

### 名称规范化

`Extension.name` 设置为:

1. 如果 `manifest.name` 不为 `null`/`undefined`,则使用它
2. 否则使用扩展目录名

此处不强制字符串类型。

---

## 物化为能力项

一个有效解析的 manifest 会创建一个 `Extension` 能力项:

```ts
{
	name: manifest.name ?? <directory-name>,
	path: <extension-directory>,
	manifest: <parsed-json>,
	level: "user" | "project",
	_source: {
		provider: "gemini",
		providerName: "Gemini CLI" // attached by capability registry
		path: <absolute-manifest-path>,
		level: "user" | "project"
	}
}
```

注意:

- `_source.path` 由 `createSourceMeta()` 规范化为绝对路径。
- 注册表级别对 `extensions` 的能力验证只检查 `name` 和 `path` 的存在。
- Manifest 内部(`mcpServers`、`tools`、`context`)在发现期间不被验证。

---

## 错误处理与警告语义

### 会警告

- 非空 manifest 文件中的无效 JSON,或语法有效但为假值的 JSON 字面量:
  - 警告格式:`Invalid JSON in <manifestPath>`

### 不警告(静默跳过)

- `extensions` 目录缺失
- 子目录没有 `gemini-extension.json`
- manifest 文件不可读或为空
- manifest JSON 为真值但在语义上奇怪/不完整

这意味着语义有效性不被强制;警告门槛是 `tryParseJson()` 的真值性,而不是 `ExtensionManifest` 运行时验证器。

---

## 与其他来源的优先级和去重

`extensions` 能力由能力注册表跨提供商聚合。

此能力的当前提供商:

- `native`(`packages/coding-agent/src/discovery/builtin.ts`)优先级 `100`
- `gemini`(`packages/coding-agent/src/discovery/gemini.ts`)优先级 `60`

去重键是 `ext.name`(`extensionCapability.key = ext => ext.name`)。

### 跨提供商优先级

重复的扩展名由优先级较高的提供商胜出。

- 如果 `native` 和 `gemini` 都发出名为 `foo` 的扩展,则保留 native 项。
- 较低优先级的重复项仅以 `_shadowed = true` 保留在 `result.all` 中。

### 提供商内部顺序效应

因为去重是“先见者胜”,提供商内部的项顺序很重要。

- Gemini 加载器**先追加用户项**,然后追加**项目项**。
- 因此,`~/.gemini/extensions` 与 `<cwd>/.gemini/extensions` 之间的重名会保留用户条目,并遮蔽项目条目。

相比之下,native 提供商按不同的顺序构建配置目录(`getConfigDirs()` 中先 `project` 后 `user`),因此 native 提供商内部的遮蔽方向相反。

---

## 用户与项目行为总结

具体到 Gemini manifest:

- 每次加载都会扫描用户和项目两个根目录。
- 项目根目录固定为 `<cwd>/.gemini/extensions`(不向上遍历祖先)。
- Gemini 来源内部的重名解析为用户优先。
- 与更高优先级提供商(尤其是 native)的重名会因优先级而落败。

---

## 边界:manifest 元数据 vs 运行时扩展模块

`gemini-extension.json` 发现服务于 `extensions` 元数据能力。它**不**标识可运行的 TS/JS 入口点。

Gemini 提供商通过扫描相同的两个扩展根目录,寻找直接的 `.ts`/`.js` 文件、`<name>/index.ts` / `index.js` 以及 `package.json` 中的 `omp`/`pi` 扩展条目,另行填充 `extension-module` 能力。这些模块记录与 `gemini-extension.json` 相互独立。

`discoverExtensionPaths()` 中的启动环境路径目前只请求 `native` 提供商,因此 Gemini 发现的模块记录不会在那里自动执行。显式配置的扩展路径仍可加载。

实际含义:Gemini manifest 是可发现的元数据,但仅凭 manifest 本身或相邻模块出现在 `.gemini/extensions` 下,并不会自动执行。
