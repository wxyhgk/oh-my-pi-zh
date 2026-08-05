在持久内核中运行一步代码。状态跨调用和子 Agent 持久。

增量工作:导入 → 定义 → 测试 → 使用,每个都是自己的单元格。只在 `reset` 或内核崩溃后重新运行设置。
用 `parallel(thunks)` 在单元格**内**并行,而不是批量。

{{#if py}}顶层 `await` 可用;`asyncio.run(…)` 会抛错。{{/if}}
{{#if js}}JS 在 **Bun** 下运行:全局(`Bun.file`、`Bun.write`、`Bun.$`、`fetch`、`Buffer`)可用;顶层 `await`/`return` 可用。{{/if}}

出错时,只修复并重新运行失败的步骤。

<prelude>
{{#ifAll py js}}Python:同步,kwargs。JS:异步,一个尾部对象字面量,绝不位置参数。{{else}}{{#if py}}同步;kwargs。{{/if}}{{#if js}}异步;一个尾部对象字面量,绝不位置参数。{{/if}}{{/ifAll}}{{#if rb}} Ruby:同步,kwargs。{{/if}}{{#if jl}} Julia:同步,kwargs。{{/if}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    调用任何会话工具;`args` = 它的参数对象。
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict
    一次性、无状态(无历史/工具)。`model`:"smol" 快速 | "default" 会话 | "slow" 最强。`schema`(JSON-Schema)→ 解析后的对象。
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    运行一个子 Agent → 最终输出。`agent` 选择已发现的 Agent;省略则使用 `{{spawnDefaultAgent}}`。{{#if spawnAllowedAgentsText}}允许的 Agent:{{spawnAllowedAgentsText}}。{{/if}} `schema` 覆盖 Agent/会话 schema;`schemaMode`/`schema_mode`:"permissive" | "strict"。有效的 schema 返回解析后的数据。`isolated` 请求一个工作树;`apply`/`merge` 控制其变更。后台通过提示中命名的 `local://` 文件。`handle` → { text, output, handle: "agent://<id>", id, agent },结构化时解析 `data`。
{{#if js}}    JS:一个尾部对象——agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle })。{{/if}}
{{/if}}
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total`(上限或 None)、`budget.spent()`、`budget.remaining()`{{/if}}{{#if js}}`await budget.total()`、`await budget.spent()`、`await budget.remaining()`{{/if}}{{#if rb}}`budget.total`、`budget.spent`、`budget.remaining`{{/if}}{{#if jl}}`budget.total`、`budget.spent()`、`budget.remaining()`{{/if}};上限 `+Nk` 建议性,`+Nk!` 硬性。
```
</prelude>
{{#if spawns}}
<dag>
通过 `agent(…, handle=true)` + `pipeline`/`parallel` 实现无环波次:
- **命名节点。** 捕获 Agent 结果 → `handle`(`agent://<id>`)+ `output`。
- **连接边。** 把上游 `handle`/`output` 放进下游提示。批量:`write("local://<name>.md", …)`。
- **`pipeline`** = 分阶段波次,阶段间有屏障。**`parallel`** = 一个波次。
- **隔离失败。** 用 try/except 包裹有风险的节点;失败只降级它的子树。
- **只允许无环。** 没有节点等待自己的后代。
</dag>
{{/if}}

<critical>
之前的顶层名字会存活到下一个单元格——复用;绝不重新导入/重新声明。只有文件自上次读取以来发生变化时才重新读取。
</critical>
