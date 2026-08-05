# AI 工具 schema 归一化

`@oh-my-pi/pi-ai` 暴露一个统一的 schema 归一化器,提供商在工具上线前消费它。所有 walker 位于 `packages/ai/src/utils/schema/normalize.ts`;操作契约是 `packages/ai/src/utils/schema/CONSTRAINTS.md`。

不再有单独的 `strict-mode.ts` 模块 —— OpenAI strict-mode 净化、OpenAI Responses `oneOf` 重写、Google/Vertex/Gemini-CLI 净化、Cloud Code Assist Claude 净化和 MCP 净化都共享同一个选项驱动的 walk。

## 入口点

所有导出都位于 `@oh-my-pi/pi-ai/utils/schema` 下:

- `normalizeSchema(value, options)` — 通用选项驱动 walker。
- `normalizeSchemaForGoogle(value)` — Gemini / Vertex / Gemini CLI。
- `normalizeSchemaForCCA(value)` — Cloud Code Assist Claude(Antigravity + GCA)。
- `normalizeSchemaForMCP(value)` — MCP `inputSchema`,在它们进入自定义工具注册表之前。`tool-bridge.ts` 让每个 MCP `inputSchema` 都经过这个分派器。
- `sanitizeSchemaForOpenAIResponses(schema)`(别名 `normalizeSchemaForOpenAIResponses`)— 递归将 `oneOf` 重写为 `anyOf`,给对象 schema 添加空 `properties`,并移除 Responses API 拒绝的正则环视。
- `sanitizeSchemaForStrictMode(schema)` 与 `enforceStrictSchema(schema)` / `tryEnforceStrictSchema(schema)` — OpenAI strict-mode 流水线(净化 → 强制)。三者都从 `normalize.ts` 导出。
- `./adapt` 的 `adaptSchemaForStrict(schema, strict)` — 薄组合器,把 draft-07 输入升级到 2020-12,并为提供商调用点包装 `tryEnforceStrictSchema`。`./adapt` 还导出 `NO_STRICT` 全局旁路标志(环境变量 `PI_NO_STRICT`),每个发出 `strict: true` 的提供商都遵循它。
- `normalizeSchemaForMoonshot(value)` — Moonshot/Kimi 的 MFJS 子集。
- `sanitizeSchemaForOllama(schema)` — 为 Ollama 的 Go schema 解析器重写布尔子 schema、类型数组和布尔对象开放性关键字。
- `sanitizeSchemaForGrammar(schema)` — 为受语法约束的 OpenAI 兼容后端加宽布尔子 schema,同时保留布尔 `additionalProperties` / `unevaluatedProperties`。

统一流程重构中移除的内容:

- `strict-mode.ts`(并入 `normalize.ts`)。
- `sanitize-google.ts` 和 `normalize-cca.ts`(被 `normalizeSchemaFor*` 分派器取代)。
- `StringEnum` 辅助器 —— 直接使用 `z.enum([...])`;Zod 发出的 JSON Schema 已与 Google 和其他提供商线上兼容。
- `sanitizeSchemaFor{Google,CCA,MCP}` / `prepareSchemaForCCA` — 重命名为 `normalizeSchemaFor{Google,CCA,MCP}`。

## 分派器映射

| 提供商传输                              | 分派器                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `openai-completions`                                               | `adaptSchemaForStrict`(启用 strict 模式时净化 + 强制)      |
| `openai-responses`, `openai-codex-responses`                       | strict 模式适配前的 `sanitizeSchemaForOpenAIResponses`             |
| `azure-openai-responses`                                           | `sanitizeSchemaForOpenAIResponses`;发出 `strict: false` 且不做适配 |
| 使用 MFJS 的 Moonshot/Kimi 原生宿主                              | `normalizeSchemaForMoonshot`                                                 |
| 语法风格的 OpenAI 兼容宿主                           | `sanitizeSchemaForGrammar`                                                   |
| `ollama`                                                           | `sanitizeSchemaForOllama`                                                    |
| `google-generative-ai`, `google-vertex`, Gemini CLI                | `normalizeSchemaForGoogle`                                                   |
| Cloud Code Assist Claude(Antigravity + GCA,`claude-*` 模型 id) | `normalizeSchemaForCCA`                                                      |
| MCP `inputSchema` 摄入                                        | `normalizeSchemaForMCP`                                                      |
| `anthropic-messages`(原生,非 CCA)                             | `anthropic.ts` 中的逐提供商白名单                                     |

Gemini CLI / Antigravity CCA 必须运行完整的 `normalizeSchemaForCCA` 流水线(而不仅仅是第一遍关键字剥离),以保持与共享 Google Claude 路径的一致性。

## walk 语义

`normalizeSchema` 首先对序列化的 Zod 实例形状输入进行解毒,将其升级到 JSON Schema 2020-12,解引用树,然后用分派器固定的选项集 walk。每个节点:

1. 将 `snake_case` 组合器/属性键重命名为 camelCase(`any_of` → `anyOf`,等;冲突遵循 python-genai 的 `pop(from)`/`set(to)` 语义 —— snake_case 胜出)。
2. 在递归进子节点之前,应用 `handle_null_fields` 对可空联合的坍缩。
3. 剥离目标提供商不支持的键,可选地将人类可理解的键(`pattern`、`format`、min/max、`default`、`examples`、…)通过 spill 格式化器(`spill.ts`)提升到兄弟 `description` 中。结构性/元键(`$ref`、`$defs`、`additionalProperties`)不会被 spill。
4. 归一化类型联合(`type: ["T", "null"]` → Google 上为 `type: "T"` + 可空标记,CCA 上为普通 `type: "T"`)。
5. 坍缩仅对象/同类型组合器,可选有损坍缩混合类型组合器(仅 CCA),并运行残差组合器不动点。
6. 当设置 `validateAndFallback`(CCA 路径)时,用内部结构验证器(`meta-validator.ts` 的 `isValidJsonSchema`)验证,并在残差不兼容 —— `type` 数组、`type: "null"`、`nullable` 键或任何剩余的 `anyOf`/`oneOf`/`allOf` —— 时发出逐工具回退 `{ "type": "object", "properties": {} }`。

## OpenAI strict-mode 流水线

`adaptSchemaForStrict(schema, strict)` 运行 `tryEnforceStrictSchema`,它组合:

1. **净化**(`sanitizeSchemaForStrictMode`):剥离非结构性关键字(`format`、`pattern`、min/max、`examples`、`default`、`if`/`then`/`else`、`not`、`unevaluated*`、`patternProperties`、`dependent*`、`content*`、`min/maxProperties`、`$dynamicRef`,等)。`default` 值在被丢弃前以内联 ` (default: X)` 形式并入兄弟 `description`,除非 `description` 已包含 `(default:` 或不存在 `description`。
2. **强制**(`enforceStrictSchema`):每个对象节点获得 `additionalProperties: false`,每个属性进入 `required`,可选属性变成可空联合(`anyOf: [<original>, { "type": "null" }]`)。元组 `prefixItems` 递归严格化。

两遍都使用缓存/循环守卫,因此 refs、`allOf` 和可空包装保持确定性而不会无限递归。`tryEnforceStrictSchema` 是失败开放:任何抛出都返回 `{ strict: false, schema: upgraded }`,因此调用方只有在强制实际成功时才必须发出 `strict: true`。

### strict 模式归一化器处理的边界情况

- **本地 `$ref` 内联。** OpenAI strict 模式拒绝带兄弟键的 `{ "$ref": "...", "description": "..." }`。净化器预解析针对根的本地 `#/...` refs,并与 **兄弟键胜出** 于解析出的 def 合并 —— 与 `openai-python` 的 `_ensure_strict_json_schema` 优先级相同。递归 refs 由每次 walk 的 epoch 守卫。
- **单项 `allOf`。** `{ "allOf": [X], ...siblings }` 坍缩为 `{ ...X, ...siblings }`,内联条目的键胜出于原始兄弟键(匹配 `openai-python` 的 `_pydantic.py:79-83`)。多项 `allOf` 保持原样,由下游验证器在需要时拒绝。
- **类型数组分支与可空联合。** 当节点有 `type: ["T", "U"]` 时,净化器为每个类型发出一个变体 schema,剪除类型特定关键字(例如 `properties`/`required` 只保留在 `object` 变体上,`items` 只在 `array` 变体上)。共享的 `description` 被**提升到 `anyOf` 包装器上**,而不是在每个分支上重复 —— 因此严格可空联合变成 `{ anyOf: [T, { type: "null" }], description: "..." }`,而不是 `anyOf: [{ ..., description }, { ..., description }]`。
- **无 `type` 的 Enum/const。** 净化和强制路径都调用 `inferStrictPrimitiveTypeFromEnumOrConst` 从 `enum` / `const` 值推断原始 `type`。混合原始类型枚举(`[1, "two", null]`)、包含对象/数组的枚举,以及非原始 `const` 值(`{a:1}`、`[1,2,3]`)无法由单个 `type` 关键字描述,会触发 strict 模式失败开放路径 —— 发出无类型 schema 只会被 OpenAI 在线上拒绝。

## 性能:静态指纹缓存

`packages/catalog/src/model-manager.ts` 的 `resolveProviderModels` 与 `packages/catalog/src/model-cache.ts` 的 `readModelCache`/`writeModelCache` 通过 `model_cache` SQLite 表上的 `static_fingerprint` 列协作(当前缓存 schema 版本 12)。

- `fingerprintStatic(staticModels, dynamicModelsAuthoritative)` 对静态目录切片做哈希(`Bun.hash(JSON.stringify(models))` 的 base36 表示),前缀指纹格式/版本和权威模式,并通过给数组打符号属性来记忆非权威结果。端点迁移丢弃 id 也折叠进缓存身份。
- 当跳过网络抓取、缓存新鲜且权威、恢复的头完整且静态指纹匹配时,`resolveProviderModels` 返回恢复的缓存模型,而不重建静态/动态合并。
- `mergeModelSources` 和 `mergeDynamicModels` 对空源输入短路,避免不必要的 `Map` 构建。

来自每个更旧缓存 schema 版本的行都会被删除。新添加的缓存列使用保守默认值,但一行只有在存储的版本恰好是当前版本时才被复用。

## 相关

- `docs/models.md` — 注册表、等价、兼容标志(`supportsStrictMode`、`toolStrictMode`、`disableStrictTools`)。
- `docs/provider-streaming-internals.md` — 归一化 schema 在提供商流循环期间如何在下游使用。
- `docs/mcp-server-tool-authoring.md` — 通过 `normalizeSchemaForMCP` 的 MCP `inputSchema` 摄入。
- `packages/ai/src/utils/schema/CONSTRAINTS.md` — 每个归一化规则的操作契约。
