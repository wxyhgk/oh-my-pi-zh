# 系统提示词自定义

本文介绍编码 Agent 如何组装其系统提示词,以及用户可以通过 `SYSTEM.md`、`APPEND_SYSTEM.md`、`TITLE_SYSTEM.md` 及对应 CLI 标志控制哪些内容。

主要实现:

- `packages/coding-agent/src/main.ts`(`discoverSystemPromptFile`、`discoverAppendSystemPromptFile`、`applyResolvedSystemPromptInputs`)
- `packages/coding-agent/src/sdk.ts`(`CreateAgentSessionOptions`、提示词构造)
- `packages/coding-agent/src/system-prompt.ts`(`buildSystemPrompt`、`resolvePromptInput`)
- `packages/coding-agent/src/prompts/system/system-prompt.md`(默认指令模板)
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md`(`SYSTEM.md` 生效时使用的模板)
- `packages/coding-agent/src/prompts/system/project-prompt.md`(项目/环境页脚)

## 输入与优先级

| 输入                                   | 来源                 | 效果                                                                                                   |
| --------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `--system-prompt <text-or-file>`        | CLI                    | 使用内置的自定义提示词模板替代默认指令模板。优先级最高。 |
| `SYSTEM.md`                             | 发现的配置文件 | 与标志相同的模板切换;标志缺席时使用。                                          |
| `--append-system-prompt <text-or-file>` | CLI                    | 向渲染后的提示词追加文本。追加优先级最高。                                             |
| `APPEND_SYSTEM.md`                      | 发现的配置文件 | 与追加标志效果相同;标志缺席时使用。                                            |

`SYSTEM.md` 和 `APPEND_SYSTEM.md` 先按项目搜索,再按用户层级搜索。在每个层级,配置基础按 `.omp`、`.claude`、`.codex`、`.gemini` 排序:

1. `<cwd>/.omp/<file>`、`<cwd>/.claude/<file>`、`<cwd>/.codex/<file>`、`<cwd>/.gemini/<file>`
2. `~/.omp/agent/<file>`、`~/.claude/<file>`、`~/.codex/<file>`、`~/.gemini/<file>`

原生用户路径遵循当前配置文件:使用 `omp --profile work` 时,`~/.omp/agent` 变为 `~/.omp/profiles/work/agent`。`PI_CONFIG_DIR` 改变原生配置目录名。此共享配置查找不使用 `PI_CODING_AGENT_DIR` 作为任意替换基础。

发现过程**不会**向上遍历祖先目录。在 `<repo>/packages/api` 启动 OMP 不会发现 `<repo>/.omp/SYSTEM.md`;请从 `<repo>` 启动,把文件放在当前目录的配置基础下,或使用用户级文件。共享配置目录契约参见 [配置用法](./config-usage.md)。

标志胜过所有发现的文件。对每个文件名,项目级胜于用户级,在该层级内按上述顺序第一个配置基础胜出。

### 文本或文件解析

对于单行值,OMP 首先尝试将该值作为文件路径读取。如果读取因路径不存在(或太长而不像路径)而失败,则该值按字面使用。包含换行符的值按字面使用,不进行文件读取。其他文件读取失败会被记录,原始值仍按字面使用。

## `SYSTEM.md` 替换了什么

`SYSTEM.md` 不会成为一条原始的、唯一的系统消息。CLI 将其存储为 `CreateAgentSessionOptions.customSystemPrompt`,`buildSystemPrompt` 渲染 `custom-system-prompt.md` 而非默认的 `system-prompt.md`。

自定义模板保留以下生成面:

- 自定义文本和任何追加文本;
- 发现的上下文文件;
- 发现的技能;
- 始终应用的规则与规则书列表;
- 启用时的机密脱敏指引。

单独的项目/环境页脚保留,携带工作站数据、更深目录上下文指针、可选的工作区信息、当前日期/cwd 以及最终完成要求。可选的其他系统块(如计算机工具安全和活动嵌套仓库上下文)在适用时也保留。

消失的是默认指令模板独有的内容:其内置的角色/个性文本、工具清单和通用工具策略、内部 URL 目录、探索/委派/工作流规则,以及 `xd://` 协议指引。生成的技能和规则**不会**丢失;自定义模板显式渲染它们。

后果:

- 要在保留完整默认提示词的同时添加少量指令,只使用 `APPEND_SYSTEM.md` 或 `--append-system-prompt`。
- 要在保留生成的项目上下文、技能和规则的同时替换默认指令模板,使用 `SYSTEM.md` 或 `--system-prompt`。
- 如果自定义提示词仍需要默认工具策略或工作流,请自行复制并维护所需指引;不支持从 `system-prompt.md` 选择性继承。

### 追加位置

没有 `SYSTEM.md` 时,追加文本渲染在 `project-prompt.md` 末尾,位于默认指令块和项目/环境内容之后。

有 `SYSTEM.md` 时,追加文本在 `custom-system-prompt.md` 中紧接自定义文本之后渲染。上下文、技能和规则紧随其后,独立的项目/环境页脚跟在那一块之后。模板防止追加文本和上下文文件被输出两次。

SDK 生成的追加内容(针对启用的记忆/自动学习功能和 MCP 指引)在用户提供的追加文本之前合并。

## 纯文本契约

`SYSTEM.md`、`APPEND_SYSTEM.md`、`--system-prompt` 和 `--append-system-prompt` 都是纯文本。它们是插入内置 Handlebars 模板的值;其内容不会被作为 Handlebars 递归编译。

例如,如果 `SYSTEM.md` 包含:

```handlebars
Working in
{{cwd}}
on
{{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

这些字符按字面到达模型。`cwd`、`date`、`skills`、`rules`、`toolRefs` 等内部值是私有模板实现细节,不是用户模板 API。

## 示例

### 向默认提示词添加规则

创建 `APPEND_SYSTEM.md`,不创建 `SYSTEM.md`:

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### 提供自定义基础提示词

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

OMP 仍会添加生成的上下文、技能、规则和项目/环境页脚,但不会添加默认指令模板的工具和工作流指引。

### 自定义自动会话标题

`SYSTEM.md` 和 `APPEND_SYSTEM.md` 不影响标题生成调用。使用 `TITLE_SYSTEM.md`:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` 使用相同的项目优先、配置基础发现和无祖先遍历行为。缺席时,OMP 使用其内置标题提示词。该覆盖同时用于初始自动标题和重新规划驱动的标题刷新。

即使使用自定义提示词,生成的标题输出也遵循强制规范化契约。OMP 只考虑第一行去首尾空白的内容,去除两侧引号、`<title>...</title>` 标记和句末标点,并将 `none` 或 `<title/>` 视为"尚无标题"。超过 80 个字符或 12 个词的结果会被拒绝而非截断。空、延迟或拒绝的输出会让会话保持未命名状态,因此后续符合条件的标题尝试可以为其命名。

## 面向提供商的全量替换(仅 SDK)

`CreateAgentSessionOptions.systemPrompt` 是另一个更低层的 API。字符串或数组替换完全渲染后的默认块;回调接收渲染后的块数组并返回其替代品。这可以省略所有生成的上下文和安全块。

CLI 标志和文件**不会**设置此属性:它们设置 `customSystemPrompt` 和 `appendSystemPrompt`,继续经过上述内置模板。

## 快速参考

| 目标                                                                                   | 用法                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 在保留完整默认提示词的同时添加指令                             | `APPEND_SYSTEM.md` 或 `--append-system-prompt`                           |
| 替换默认指令模板,但保留生成的上下文、技能和规则 | `SYSTEM.md` 或 `--system-prompt`                                         |
| 替换所有面向提供商的系统块                                             | SDK `CreateAgentSessionOptions.systemPrompt`                             |
| 自定义自动会话标题                                                     | `TITLE_SYSTEM.md`                                                        |
| 在用户文件中使用 `{{cwd}}` 或其他内部变量                               | 不支持;用户内容按字面插入                         |
| 继承选定的默认模板章节                                             | 不支持;追加到默认提示词或复制所需文本           |
| 按目录覆盖                                                                                 | 启动 OMP 的 cwd 下直接支持配置基础        |
| 全局覆盖                                                                                | 活动的原生 Agent 目录,或其他受支持的用户配置基础 |
