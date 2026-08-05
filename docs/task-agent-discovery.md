# 任务 Agent 发现与选择

本文档描述任务子系统如何发现 Agent 定义、合并多个来源,并在执行时解析所请求的 Agent。

它涵盖当前实现的运行时行为,包括优先级、无效定义处理,以及可能使 Agent 实际上不可用的生成/深度约束。

## 实现文件

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent 定义结构

任务 Agent 规范化为 `AgentDefinition`(`src/task/types.ts`):

- 必填 `name`、`description` 与 `systemPrompt`
- 可选 `tools`、`spawns`、优先 `model` 列表、`thinkingLevel`、`output`、`blocking`、`autoloadSkills`、`readSummarize`、`prewalk`
- `source`:`"bundled" | "user" | "project"`(扩展 Agent 按其扩展根的项目/用户级别标记)
- 可选 `filePath`

解析来自 frontmatter,经由 `parseAgentFields()`(`src/discovery/helpers.ts`):

- 缺少 `name` 或 `description` => 无效(`null`),调用方视为解析失败
- `tools` 接受 CSV 或数组;若提供,则自动添加 `yield`
- `spawns` 接受 `*`、CSV 或数组
- 向后兼容行为:若缺少 `spawns` 但 `tools` 包含 `task`,则 `spawns` 变为 `*`
- `output` 作为不透明 schema 数据透传
- `read-summarize: false`(规范化为 `readSummarize`)强制子 Agent 的 `read` 工具返回逐字文件内容,而不是结构摘要 —— `runSubprocess` 将其作为 `read.summarize.enabled: false` 覆盖应用于子 Agent 的隔离设置(`src/task/executor.ts`)。`scout` 和 `librarian` 出厂时禁用该选项。字段缺失时默认启用。
- `model` 接受一个选择器、CSV 或数组。条目在角色别名展开后按顺序尝试。
- `thinking-level` / `thinking` 选择 Agent 配置的 effort。当 `task.enableEffort`(默认 `false`)将其暴露时,任务项的粗略 `effort`(`lo`、`med`、`hi`)在启动时优先。OMP 将该提示映射到所选模型支持的最低、中间或最高 effort,然后将其钳制到 `task.maxEffort`(默认 `max`)。该上限在重试回退模型切换中保持。如果所选模型没有低于或等于上限的支持 effort,生成失败;没有可控 effort 表面的模型则回退到其正常选择器。
- `blocking: true` 使父级在异步任务执行启用时也等待该 Agent
- `autoloadSkills` 从父会话命名要在第一个子提示词之前注入的技能;未知名称被忽略
- `prewalk: true` 让子 Agent 以其解析的模型启动,并在第一次编辑/写入时移交给默认 prewalk 目标(`smol` 角色),与会话级 `--prewalk` 完全一致;字符串值(如 `prewalk: "@smol"` 或 `prewalk: "openai/gpt-5-mini"`)选择自定义目标。`task.agentPrewalk` 设置记录(Agent 名称 → `"on"` / `"off"` / 模式,可在 `/agents` 中用 `P` 按 Agent 切换)覆盖 frontmatter。解析发生在 `runSubprocess`(`src/task/executor.ts`)。不可用的目标会被跳过,而不是使生成失败。解析出的目标仅在以下情况被跳过:其模型身份和有效思考模式/级别在模型钳制后都与起始选择匹配;同模型的 effort 降级是真正的移交,仍会在第一次编辑/写入时布防并切换。

## 基于角色的自定义 Agent

OMP 从 `~/.omp/agent/agents/*.md` 发现用户 Agent,从 `.omp/agents/*.md` 发现项目 Agent。

在 frontmatter 中给 Agent 一个角色别名,然后按名称分发。对于模型路由,任务分发只设置 `agent`;它不设置工作模型:

`~/.omp/agent/agents/reviewer.md`:

```md
---
name: reviewer
description: Review a change for correctness.
model: "@review"
---

Review the assigned change and report concrete findings.
```

在 `~/.omp/agent/config.yml` 中设置角色映射:

```yaml
modelRoles:
  review: openai/gpt-5.4:high
```

`@review` 通过 `modelRoles.review` 解析。每个 `modelRoles.<role>` 值存储一个具体的模型选择器,并可追加思考后缀,如 `:high`(`src/config/model-resolver.ts`)。更改该映射会影响后续的任务解析,无需编辑 Agent 定义。

对于分发,设置 Agent 名称与任务:

```json
{
  "context": "Review the current change in this repository.",
  "tasks": [
    { "agent": "reviewer", "task": "Report concrete correctness findings." }
  ]
}
```

`/model` 的 Roles 视图可以分配并持久化自定义角色映射,如 `review`、`fast` 与 `good`。仅更改活动或默认会话选择不会重新映射这些角色。

### `vibe_spawn` 层级路由

`vibe_spawn` 将 `fast` 映射到内置 `sonic`,将 `good` 映射到内置 `task`。两者都在其内置 Agent 模型默认值之前通过 `task.agentModelOverrides` 解析(`src/vibe/runtime.ts`、`src/task/agents.ts`)。

通过将别名保留在 `task.agentModelOverrides` 中、只将具体选择器放在 `modelRoles` 中来通过这些角色路由层级:

```yaml
task:
  agentModelOverrides:
    sonic: "@fast_worker"
    task: "@good_worker"
modelRoles:
  fast_worker: openai/gpt-5-mini
  good_worker: openai/gpt-5.4:high
```

`vibe_spawn` 的 `cli` 保持为 `fast` 或 `good`;更新 `modelRoles` 以更改工作模型。

## 内置 Agent

内置 Agent 在构建时使用文本导入嵌入(`src/task/agents.ts`)。

`EMBEDDED_AGENT_DEFS` 定义:

- 来自提示文件的 `scout`、`designer`、`reviewer`、`security-reviewer` 与 `librarian`
- 来自共享 `task.md` 正文加注入 frontmatter 的 `task` 与 `sonic`;没有内置 Agent 设置 `prewalk` —— 通用 `task` Agent 的移交由 `task.prewalk` 设置(默认关闭)布防,或通过 `/agents` / `task.agentPrewalk` / 用户 Agent frontmatter 按 Agent 布防

加载路径:

1. `loadBundledAgents()` 用 `parseAgent(..., "bundled", "fatal")` 解析嵌入的 markdown
2. 结果在内存中缓存(`bundledAgentsCache`)
3. `clearBundledAgentsCache()` 是仅测试用的缓存重置

由于内置解析使用 `level: "fatal"`,格式错误的内置 frontmatter 会抛出异常,并可能使整个发现失败。

## 文件系统与插件发现

`discoverAgents(cwd, home)`(`src/task/discovery.ts`)在追加内置定义之前,合并来自 OMP 原生根、OMP 扩展包与 Claude marketplace 插件根的 Agent。直接跨 harness 根(如 `.claude/agents`、`.codex/agents` 与 `.gemini/agents`)被有意跳过 —— 它们的 frontmatter schema 不是 OMP 任务 Agent 契约(`TASK_AGENT_CONFIG_SOURCE = ".omp"` 过滤原生配置目录列表)。

### 发现输入与优先级

1. 来自 `findAllNearestProjectConfigDirs("agents", cwd)` 的最近项目 `.omp/agents` 目录(仅第一个 `.omp` 命中)
2. 来自 `getConfigDirs("agents", { project: false })` 的用户 `.omp/agents` 目录(仅第一个 `.omp` 命中)
3. 由 `listOmpExtensionRoots(...)` 返回的每个已启用 OMP 扩展包的 `<extension-root>/agents`,按此顺序:
   - CLI `--extension` 根
   - 项目 `extensions:` 设置
   - 用户 `extensions:` 设置
   - 已安装的 npm/link 插件
4. Claude marketplace 插件根(`listClaudePluginRoots(home, cwd)`)中带 `agents/` 子目录的 —— 仅当 `isProviderEnabled("claude-plugins")` 时;项目范围插件排在用户范围之前
5. 内置 Agent(`loadBundledAgents()`)

当 `omp-plugins` 能力提供商被禁用时,OMP 扩展包表面被禁用。marketplace 根被排除在 `listOmpExtensionRoots` 之外,仅通过单独门控的 Claude 插件路径进入。

## 合并与冲突规则

发现使用按确切 `agent.name` 的优先胜出去重:

- `Set<string>` 跟踪已见名称。
- 已加载的 Agent 按目录顺序展平,仅保留名称未见过的。
- 内置 Agent 针对同一集合过滤,仅在仍未见过时添加。

含义:

- 项目 `.omp` 覆盖用户 `.omp`。
- 更早的扩展根覆盖更晚的扩展根、Claude marketplace 插件与内置 Agent。
- 非内置 Agent 覆盖同名内置 Agent。
- 名称匹配区分大小写(`Task` 与 `task` 不同)。
- 在一个目录内,markdown 文件在去重前按文件名字典序读取。

## 无效/缺失 Agent 文件行为

按目录(`loadAgentsFromDir`):

- 不可读/缺失目录:视为空(`readdir(...).catch(() => [])`)
- 文件读取或解析失败:记录警告,跳过文件
- 解析路径使用 `parseAgent(..., level: "warn")`

Frontmatter 失败行为来自 `parseFrontmatter`:

- `warn` 级别的解析错误记录警告
- 解析器回退到简单的 `key: value` 行解析器
- 若必填字段仍然缺失,`parseAgentFields` 失败,然后抛出 `AgentParsingError` 并由调用方捕获(跳过文件)

净效果:一个坏的自定义 Agent 文件不会中止其他文件的发现。

## Agent 查找与选择

查找是精确名称线性搜索:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- 不受限制的会话将省略的 `agent` 字段默认为 `task`
- 受限父级 `spawns` 列表将省略的 `agent` 字段默认为列表中的第一个 Agent

`resolveEffectiveSubagentPolicy()` 由任务与 eval 支持的子 Agent 启动共享。在分配产物之前,它:

1. 从父级生成策略解析省略或显式的 Agent 名称
2. 强制深度、阻止自递归与父级生成策略守卫
3. 用 `discoverAgents(session.cwd)` 重新发现 Agent 并执行精确查找
4. 检查 `task.disabledAgents`
5. 解析计划模式限制、输出 schema、模型策略与隔离策略

缺失名称以 `Unknown agent "...". Available: ...` 失败于预检;不运行子进程。

### 描述与执行时发现

`TaskTool.create()` 在构建面向模型的工具描述时,按已解析的工作目录记忆发现结果。执行时重新发现 Agent,因此如果 Agent 或扩展文件在会话中途更改,运行时集合可能与更早的描述不同。阻塞行为在策略解析后确定,而不是来自过时的描述时 Agent 对象。

## 模型与结构化输出优先级

对于任务分发,模型优先级为:

1. `task.agentModelOverrides[agentName]`
2. Agent frontmatter 的优先 `model` 列表
3. 父级的活动模型,然后是父级配置/默认模型回退

前两个来源中的角色别名通过 `modelRoles` 展开。共享 eval 桥还可以在设置覆盖之前提供调用本地模型覆盖;任务 wire schema 不暴露该字段。

运行时输出 schema 优先级为:

1. 任务项的显式 `outputSchema`
2. Agent frontmatter `output`
3. 父会话 `outputSchema`

任务项的可选 `schemaMode` 覆盖父会话模式;默认是 `permissive`。

面向模型的提示(`src/prompts/tools/task.md`)标记只读 Agent,并警告不要将推理外包给 `scout`/`sonic`。

## 命令发现交互

`src/task/commands.ts` 是工作流命令(不是 Agent 定义)的并行基础设施,但它遵循相同的总体模式:

- 先从能力提供商发现
- 按名称以优先胜出去重
- 仍未见过时追加内置命令
- 通过 `getCommand` 精确名称查找

在 `src/task/index.ts` 中,命令辅助函数与 Agent 发现辅助函数一起重新导出。Agent 发现本身在运行时不依赖命令发现。

## 发现之外的可用性约束

Agent 可以被发现但仍因执行护栏而无法运行。

### 禁用 Agent 设置

`resolveEffectiveSubagentPolicy()` 在解析 Agent 后检查 `task.disabledAgents`。禁用的名称在预检失败,并在可用时列出启用的替代。

### 父级生成策略

解析器检查 `session.getSessionSpawns()`:

- `"*"`(也包含 `true`、`null` 或缺失)=> 允许任意;省略的 `agent` 默认为 `task`
- `""` 或 `false` => 全部拒绝
- CSV 列表 => 仅允许列出的名称;省略的 `agent` 默认为其第一个名称

若被拒绝:`Cannot spawn '...'. Allowed: ...`。

### 阻止自递归环境守卫

`PI_BLOCKED_AGENT`(或内部请求覆盖)在发现之前拒绝生成同一被阻止 Agent 的尝试。

### 递归深度门控

`task.maxRecursionDepth` 默认为 `2`;负值禁用上限。当当前任务深度已达上限时,共享策略拒绝生成。当子级达到上限时,`runSubprocess` 也会从其工具列表中移除 `task` 并将其生成策略设为空。

对于受限的 Agent 工具列表,当声明了 `spawns` 且深度允许时,`runSubprocess` 自动添加 `task`。除非会话显式限制工具名称,它还会保留宿主的 `hub` 协作工具。

## 计划模式行为

当父级计划模式启用时,`resolveEffectiveSubagentPolicy()` 在启动子进程前构建 `effectiveAgent`:

- 前置计划模式子 Agent 系统提示词
- 将工具限制为 `read`、`grep`、`glob` 与 `web_search`,加上 Agent 自身工具列表声明时的 `ast_grep`
- 清空子级生成
- 清空 `prewalk`(只读探索不得接收 prewalk 计划/实现提示)

计划模式还拒绝按生成隔离、应用与合并控制。同一 `effectiveAgent` 用于子进程启动、模型/思考覆盖与输出 schema 选择。
