# 斜杠命令内部机制

本文档介绍 `coding-agent` 中斜杠命令是如何被发现、去重、在交互模式下呈现,并在提示词输入时展开的。

## 实现文件

- [`src/extensibility/slash-commands.ts`](../packages/coding-agent/src/extensibility/slash-commands.ts)
- [`src/capability/slash-command.ts`](../packages/coding-agent/src/capability/slash-command.ts)
- [`src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts)
- [`src/discovery/claude.ts`](../packages/coding-agent/src/discovery/claude.ts)
- [`src/discovery/codex.ts`](../packages/coding-agent/src/discovery/codex.ts)
- [`src/discovery/claude-plugins.ts`](../packages/coding-agent/src/discovery/claude-plugins.ts)
- [`src/discovery/agents.ts`](../packages/coding-agent/src/discovery/agents.ts)
- [`src/discovery/opencode.ts`](../packages/coding-agent/src/discovery/opencode.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/slash-commands/acp-builtins.ts`](../packages/coding-agent/src/slash-commands/acp-builtins.ts)
- [`src/slash-commands/available-commands.ts`](../packages/coding-agent/src/slash-commands/available-commands.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## 1) 发现模型

斜杠命令是一种能力(`id: "slash-commands"`),以命令名为键(`key: cmd => cmd.name`)。

能力注册表会加载所有已注册的提供商,按提供商优先级降序排序,并按**先到先得**语义按键去重。

### 提供商优先级

当前斜杠命令提供商及优先级:

1. `native` (OMP) — 优先级 `100`
2. `omp-plugins` (扩展包) — 优先级 `90`
3. `claude` — 优先级 `80`
4. `claude-plugins` — 优先级 `70`
5. `agents` (`.agent`/`.agents` 标准目录) — 优先级 `70`
6. `codex` — 优先级 `70`
7. `opencode` — 优先级 `55`

同级行为:优先级相同的提供商按注册顺序保留。当前导入顺序是先注册 `claude-plugins`、再 `agents`、最后 `codex`,因此在名称冲突时插件命令优先于两者。

### 名称冲突行为

对于 `slash-commands`,冲突严格按能力去重规则解决:

- 优先级最高的项保留在 `result.items` 中
- 低优先级的重复项只保留在 `result.all` 中,并标记为 `_shadowed = true`

这适用于跨提供商的情况,也适用于同一提供商内返回重复名称的情况。

内置命令不是该文件能力中的条目。它们位于统一的内置注册表中,在 TUI 和 ACP/RPC 模式下于会话级扩展/自定义/文件展开之前被分发。自动补全/ACP 可用性也会先预留内置名称和别名。

### 文件扫描行为

提供商大多使用 `loadFilesFromDir(...)`,它目前:

- 默认非递归匹配(`*.md`)
- 使用原生 glob,`gitignore: true`, `hidden: false`, `fileType: File`
- 并行读取匹配的文件并将其转换为 `SlashCommand` 条目

因此隐藏文件/目录不会被加载,被忽略的路径会被跳过,文件顺序遵循原生 glob 结果顺序,除非提供商自带排序。

## 2) 各提供商源路径与本地优先级

## `native` 提供商(`builtin.ts`)

搜索根来自 `.omp` 目录:

- 项目:`<cwd>/.omp/commands/*.md`
- 用户:当前配置文件中的 Agent 目录 `commands/*.md`(默认配置为 `~/.omp/agent/commands/*.md`;命名配置为 `~/.omp/profiles/<name>/agent/commands/*.md`)

`getConfigDirs()` 先返回项目再返回用户,因此名称冲突时**项目原生命令优先于用户原生命令**。

## `omp-plugins` 提供商(`omp-plugins.ts`)

扫描配置的扩展包根目录以及已启用的 npm/link 插件中的 `commands/*.md`。根目录优先级为:调用/CLI、项目设置、用户设置,然后是已安装插件。市场根目录在此处被排除以避免重复发现,由 `claude-plugins` 处理。

## `claude` 提供商(`claude.ts`)

受 `commands.enableClaudeUser` 和 `commands.enableClaudeProject` 设置约束,加载:

- 用户:`~/.claude/commands/**/*.md`(递归)
- 项目:`<cwd>/.claude/commands/**/*.md`(递归)

子目录中的命令额外获得一个带命名空间的别名:`foo/bar.md` 同时以 `bar` 和 `foo:bar` 注册(`addClaudeCommandNamespaceAliases`)。

该提供商先推送用户条目再推送项目条目,因此该提供商内部同名冲突时**用户 Claude 命令优先于项目 Claude 命令**。

## `codex` 提供商(`codex.ts`)

加载:

- 用户:`~/.codex/commands/*.md`
- 项目:`<cwd>/.codex/commands/*.md`

两侧加载后按用户优先的顺序展平,因此冲突时**用户 Codex 命令优先于项目 Codex 命令**。

Codex 命令内容通过去除 frontmatter(`parseFrontmatter`)解析,命令名可由 frontmatter 中的 `name` 覆盖;否则使用文件名。

## `opencode` 提供商(`opencode.ts`)

受 `commands.enableOpencodeUser` 和 `commands.enableOpencodeProject` 设置约束,加载:

- 用户:`~/.config/opencode/commands/*.md`
- 项目:`<cwd>/.opencode/commands/*.md`

两侧加载后按用户优先的顺序展平,因此冲突时**用户 OpenCode 命令优先于项目 OpenCode 命令**。OpenCode 命令内容通过去除 frontmatter 解析,命令名可由 frontmatter 中的 `name` 覆盖;否则使用文件名。

## `claude-plugins` 提供商(`claude-plugins.ts`)

通过 `listClaudePluginRoots(...)` 加载插件命令根,该函数读取 `~/.claude/plugins/installed_plugins.json`、`~/.omp/plugins/installed_plugins.json`,以及从 cwd 解析出的最近项目级注册表。对每个根扫描 `<pluginRoot>/commands/*.md`(该目录可通过插件配置键 `commands`/`slash-commands` 重映射),命令名以插件名作为前缀:`<plugin>:<command>`。

三个注册表之间,根按优先级合并而非排序:`--plugin-dir` 注入的根在前,然后是项目级条目(同一插件 ID 下会遮蔽用户条目),再是用户条目,同一插件 ID 下 OMP 注册表对 Claude 的注册表具有权威性。每个注册表内保留 JSON 数据中的插件条目顺序,没有额外的排序步骤。

## `agents` 提供商(`agents.ts`)

从 cwd 向上到仓库根目录扫描 `.agent/` 和 `.agents/` 下的非递归 `commands/*.md`,然后是 `~/.agent/commands` 和 `~/.agents/commands`。在该提供商内部,最近的项目根优先;`.agent` 先于 `.agents`;项目条目先于用户条目。

## 3) 物化为运行时 `FileSlashCommand`

`src/extensibility/slash-commands.ts` 中的 `loadSlashCommands()` 将能力条目转换为提示词输入时使用的 `FileSlashCommand` 对象。

对每个命令:

1. 解析 frontmatter/正文(`parseFrontmatter`)
2. 描述来源:
   - 存在 `frontmatter.description` 时使用它
   - 否则取正文第一个非空行(最多 60 字符,超出加 `...`)
3. 保留解析后的正文作为可执行模板内容
4. 计算类似 `via Claude Code Project` 的显示来源字符串

frontmatter 解析的严重级别取决于层级:

- 发现的用户/项目命令使用警告级解析,并带键/值回退解析
- 显式标记为 `native` 的能力条目使用致命级解析
- 内置回退模板使用致命级解析

### 内置回退命令

在文件系统/提供商命令之后,如果名称尚未出现,则追加内置命令模板(`EMBEDDED_COMMAND_TEMPLATES`)。

当前内置集合来自 `src/task/commands.ts`,用作回退(`source: "bundled"`)。

## 4) 交互模式:命令列表的来源

交互模式组合多个命令来源用于自动补全和命令路由。

在构造时,它从以下来源构建待处理命令列表:

- 内置命令(`BUILTIN_SLASH_COMMANDS`,包含部分命令的参数补全和内联提示)
- 扩展注册的斜杠命令(`extensionRunner.getRegisteredCommands(...)`)
- TypeScript 自定义命令(`session.customCommands`),映射为斜杠命令 label
- 可选的技能命令(`/skill:<name>`,当 `skills.enableSkillCommands` 启用时)

然后 `init()` 调用 `refreshSlashCommandState(...)` 加载基于文件的命令,并安装一个自动补全提供商(`createPromptActionAutocompleteProvider`,一个包装 `CombinedAutocompleteProvider` 的 `PromptActionAutocompleteProvider`),包含:

- 上述待处理命令
- 发现的基于文件的命令
- 名称未被内置/钩子/自定义/技能/文件命令占用的已发现提示词模板命令

`refreshSlashCommandState(...)` 还会更新 `session.setSlashCommands(...)`,使提示词展开使用同一组发现的文件命令。

### 刷新生命周期

斜杠命令状态在以下时机刷新:

- 交互模式初始化期间
- `/move` 更改工作目录之后(`applyCwdChange` 重置能力并针对新 cwd 刷新)
- 编辑器组件被替换时
- 显式插件重载流程,如 `/reload-plugins`

命令目录没有持续的文件监视器。

### 其他呈现途径

扩展(Extensions)仪表盘也会加载 `slash-commands` 能力并显示活动/被遮蔽的命令条目,包括 `_shadowed` 重复项。

## 5) 路由与提示词流水线位置

在 TUI 和 ACP/RPC 模式下,统一的内置注册表在 `AgentSession.prompt(...)` 之前被检查。内置命令可以消耗输入或返回残余提示词文本。仅 TUI 的内置命令从 ACP 可用性和分发中排除;ACP 可见的内置命令是那些具有文本模式 `handle` 的条目。

越过该边界后,当 `expandPromptTemplates !== false` 时,`AgentSession.prompt(...)` 按以下顺序处理斜杠输入:

1. **扩展命令**(`#tryExecuteExtensionCommand`)  
   如果 `/name` 匹配扩展注册的命令,其处理器立即执行并返回提示词。
2. **TypeScript 自定义命令和 MCP 提示词命令**(`#tryExecuteCustomCommand`)
   匹配可能返回:
   - `string` -> 用该字符串替换提示词文本
   - `void/undefined` -> 视为已处理;不产生 LLM 提示词
3. **基于文件的斜杠命令**(`expandSlashCommand`)  
   如果文本仍以 `/` 开头,尝试 markdown 命令展开。
4. **提示词模板**(`expandPromptTemplate`)  
   在斜杠/自定义处理之后应用。
5. **投递**
   - 空闲:提示词立即发送给 Agent
   - 流式:提示词根据 `streamingBehavior` 作为 steer/后续消息排队

这就是为什么内置命令在文件命令被考虑之前预留其名称,斜杠命令展开先于提示词模板展开,以及自定义命令可以在文件命令匹配之前转换掉前导斜杠。

## 6) 基于文件的斜杠命令的展开语义

`expandSlashCommand(text, fileCommands)` 行为:

- 仅当文本以 `/` 开头时运行
- 从 `/` 后的第一个 token 解析命令名
- 通过 `parseCommandArgs` 从剩余文本解析参数
- 在已加载的 `fileCommands` 中查找精确名称匹配
- 匹配时应用:
  - 位置替换:`$1`、`$2`、...
  - 切片替换:`$@[start]` / `$@[start:length]`,使用从 1 开始的位置
  - 聚合替换:`$ARGUMENTS` 和 `$@`
  - 通过 `prompt.render` 以 `{ args, ARGUMENTS, arguments }` 渲染模板
  - 当模板未使用内联参数占位符时,追加内联参数回退

### `parseCommandArgs` 注意事项

解析器是简单的引号感知切分:

- 支持 `'single'` 和 `"double"` 引号以保留空格
- 去除引号定界符
- 不实现反斜杠转义规则
- 不匹配的引号不是错误;解析器会一直消费到末尾

## 7) 未知 `/...` 行为

未知斜杠输入**不会被**核心斜杠逻辑拒绝。

如果没有内置、扩展、自定义或文件命令处理它,`expandSlashCommand` 返回原始文本,字面 `/...` 提示词继续经过提示词模板展开并投递给 LLM。

TUI 和 ACP/RPC 在 `session.prompt(...)` 之前分发共享的内置注册表。仅 TUI 的内置命令在 ACP 中既不会公布也不会处理,因此未处理的拼写在那里仍可作为普通提示词文本落入。

## ACP/RPC 可用性

`buildAvailableSlashCommands(...)` 按以下顺序发布先到先得的命令:支持文本的内置命令、可选技能命令、扩展命令、TypeScript/MCP 自定义命令,然后是发现的文件命令。内置主名称和别名被预留;扩展名称(如 `model:foo`,其前缀会被解析为内置命令)从 ACP 可用性中过滤掉。相同的文件命令加载会更新会话展开集。

## 8) 流式与空闲时的差异

## 空闲路径

- `session.prompt("/x ...")` 运行命令流水线,并立即执行命令或直接发送展开后的文本。

## 流式路径(`session.isStreaming === true`)

- `prompt(...)` 仍先运行扩展/自定义/文件/模板转换
- 然后要求 `streamingBehavior`:
  - `"steer"` -> 排队中断消息(`agent.steer`)
  - `"followUp"` -> 排队轮次后消息(`agent.followUp`)
- 如果省略 `streamingBehavior`,提示词抛出错误

### 重要的命令特定流式行为

- 扩展命令即使在流式期间也会立即执行(不作为文本排队)。
- `steer(...)`/`followUp(...)` 辅助方法拒绝扩展命令(`#throwIfExtensionCommand`),避免为必须同步运行的处理器排队命令文本。
- 压缩队列重放使用 `isKnownSlashCommand(...)` 决定排队的条目应通过 `session.prompt(...)` 重放(用于已知斜杠命令)还是使用原始 steer/follow-up 方法。

## 9) 错误处理与失败面

- 提供商加载失败被隔离;注册表收集警告并继续处理其他提供商。
- 无效的斜杠命令条目(缺少名称/路径/内容或层级无效)会被能力验证丢弃。
- frontmatter 解析失败:
  - 原生命令:致命解析错误向上冒泡
  - 非原生命令:警告 + 键/值回退解析
- 扩展/自定义命令处理器的异常被捕获并通过扩展错误通道报告(没有扩展运行器的自定义命令回退到记录器),并视为已处理(不会意外回退执行)。

## 10) 内置命令说明:`/pause`

`/pause` 仅在交互式 TUI 中可用。它为主 Agent、进程内子代理和顾问启用进程全局门控。每个 Agent 在其下一个安全边界暂停:进行中的调用完成,不会中止任何操作,在门控解除前不会启动新工作。

在暂停界面按 Esc、Enter、空格或 Ctrl+C 恢复。Ctrl+C 恢复而非中止任何 Agent。
