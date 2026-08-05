# 上下文文件

上下文文件是 `omp` 在会话开始前自动发现并注入 Agent 项目上下文的 Markdown 指令文件。用于仓库约定、架构说明、测试与审查期望,以及应随用户账户或项目传播的指令。

你永远不必要求 Agent 去读 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 或类似文件——相关的文件在会话开始时已被发现、加载并放入上下文。

## 上下文文件与其他概念的关系

四个名字相似的东西行为不同。请区分清楚:

- **上下文文件**作为纯 Markdown 读取,并在生成的项目指令中展示给 Agent(默认提示模板下位于 `<repo-rules>` 内)。它们是会话开场指令和仓库工作的背景。
- **粘性规则**来自顶层原生 `RULES.md`。它们被转换为始终应用的规则,在接近当前轮次处重新附加,因此即使可见对话增长,它们也保持效力。见下文"粘性规则与普通上下文"。
- **发现提供商**是配置源适配器(`native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md`),它们知道每个工具把文件放在哪里。贡献上下文文件的同一提供商也可能贡献 MCP 服务器、斜杠命令、技能、钩子、工具、提示和设置。
- **模型提供商**是推理后端,如 `anthropic`、`openai`、`google`、`groq`、`ollama` 和 `openrouter`。它们与上下文文件无关,除了两类 id 共享同一条 `disabledProviders` 列表——见下文"禁用发现提供商"和 [Providers](./providers.md)。

编写**技能**和**规则**文件(相对于粘性 `RULES.md`)见 [Skills](./skills.md)。用 `SYSTEM.md` 定制系统提示见 [System prompt customization](./system-prompt-customization.md)。

## 原生 `.omp` 文件

原生提供商是新项目的推荐格式。它从你的用户 Agent 目录和项目内的 `.omp/` 目录读取,并且具有最高的发现优先级,因此它的文件在同一作用域下胜过所有其他约定。

| 文件                                          | 作用域   | 行为                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.omp/agent/AGENTS.md`                      | 用户    | 每个会话的用户级上下文,除非 `native` 提供商被禁用。                                                                                                                                                                       |
| `<nearest-non-empty-ancestor>/.omp/AGENTS.md` | 项目 | 项目上下文,但仅当从 cwd 向仓库根遍历时找到的**最近非空 `.omp/` 目录**中存在 `AGENTS.md`。当最近目录缺少该文件时,OMP 不会继续到更远的 `.omp/` 目录。 |
| `~/.omp/agent/RULES.md`                       | 用户    | 用户级粘性规则内容。作为始终应用规则加载,而非上下文文件。                                                                                                                                                               |
| `<nearest-non-empty-ancestor>/.omp/RULES.md`  | 项目 | 项目粘性内容,但仅当遍历选定的同一个最近非空 `.omp/` 目录中存在 `RULES.md`。                                                                                                                        |

两个细节很重要:

- **最近非空 `.omp/` 目录拥有原生项目发现权。** 发现从当前工作目录开始,向仓库根攀升。一旦找到非空 `.omp/`,它就停止;原生 `AGENTS.md` 和 `RULES.md` 都只从该目录读取。文件缺失不会让发现继续向上。
- **空目录和空文件不贡献任何内容。** 遍历中跳过空的 `.omp/` 目录。在选定的非空目录中,空的 `AGENTS.md` 或 `RULES.md` 不贡献任何内容。

`~/.omp/agent` 是活动原生 Agent 目录的简写。`PI_CODING_AGENT_DIR` 重定位它。命名 profile(`omp --profile <name>`、`OMP_PROFILE` 或 `PI_PROFILE`)默认使用 `~/.omp/profiles/<name>/agent`;`~/.claude` 等外部工具用户基础不随 profile 作用域变化。

### Monorepo 示例

```text
repo/
  .omp/
    AGENTS.md
    RULES.md
  packages/api/
    .omp/
      AGENTS.md
```

在 `repo/packages/api` 中启动会话:

- 原生上下文文件是 `repo/packages/api/.omp/AGENTS.md`(最近的那个)。`repo/.omp/AGENTS.md` **不会**同时被包含。
- 因为 `repo/packages/api/.omp/` 是最近的非空原生目录,项目粘性内容只能来自 `repo/packages/api/.omp/RULES.md`。若该文件缺失,`repo/.omp/RULES.md` **不会被**使用。

把广泛、持久的项目背景放在 `AGENTS.md`。把 `RULES.md` 留给必须在长对话中保持可见的简短、硬性要求。

## 其他受支持的上下文约定

`omp` 也发现其他 Agent 工具的上下文和规则文件,使现有项目无需迁移即可继续工作。

| 提供商 id | 约定路径                             | 作用域          | 说明                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `native`    | `.omp/AGENTS.md`                            | 用户 + 项目 | 推荐 OMP 格式。用户文件在活动原生 Agent 目录;项目文件只从向仓库根遍历时最近的非空 `.omp/` 目录读取。                                                                                                                                                                                 |
| `claude`    | `.claude/CLAUDE.md`                         | 用户 + 项目 | 用户文件 `~/.claude/CLAUDE.md`;项目文件仅 `<cwd>/.claude/CLAUDE.md`(无祖先遍历)。                                                                                                                                                                                                                                                          |
| `codex`     | `.codex/AGENTS.md`                          | 用户           | 仅用户文件 `~/.codex/AGENTS.md`。项目级 Codex 上下文来自通过 `agents-md` 提供商的独立 `AGENTS.md`,而非 `<cwd>/.codex/AGENTS.md`。                                                                                                                                                                                        |
| `gemini`    | `.gemini/GEMINI.md`                         | 用户 + 项目 | 用户文件 `~/.gemini/GEMINI.md`;项目文件仅 `<cwd>/.gemini/GEMINI.md`(无祖先遍历)。                                                                                                                                                                                                                                                          |
| `opencode`  | `.config/opencode/AGENTS.md`                | 用户           | 仅用户文件 `~/.config/opencode/AGENTS.md`。                                                                                                                                                                                                                                                                                                               |
| `github`    | `.github/copilot-instructions.md`           | 用户 + 项目 | 项目文件仅 `<cwd>/.github/copilot-instructions.md`(无祖先遍历),加上用户全局 `~/.copilot/copilot-instructions.md`(可用 `COPILOT_HOME` 重定位)。`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 中的 `AGENTS.md` 候选也在用户作用域被考虑,适用常规的单用户文件去重。                                 |
| `agents`    | `.agent/AGENTS.md`、`.agents/AGENTS.md`     | 用户 + 项目 | 用户文件来自 `~/.agent/` 和 `~/.agents/`;项目文件在从当前目录向仓库根向上遍历时发现。                                                                                                                                                                                                                   |
| `agents-md` | `AGENTS.md`                                 | 项目        | 独立(非配置目录)`AGENTS.md` 文件,从当前目录向仓库根(或未知仓库根时的家目录)向上遍历发现。父目录名以 `.` 开头的文件被忽略——它们属于配置目录提供商。                                                                                                                                    |
| `github`    | `.github/instructions/**/*.instructions.md` | 项目规则  | GitHub Copilot / VS Code 指令文件成为规则。`applyTo: '*'`、`applyTo: '**'` 或 `applyTo: '**/*'` 被注入为始终应用内容;其他 `applyTo` glob 按需以生成的描述列在规则簿中,并可作为 `rule://<name>` 读取。缺失 `applyTo` 也会产生规则簿条目和发现警告。 |

标记"(无祖先遍历)"的提供商只在当前工作目录的配置目录中查找。如果需要祖先遍历行为,请优先使用原生 `.omp/AGENTS.md` 格式或独立 `AGENTS.md`(`agents-md` 提供商),或从持有配置目录的目录启动 `omp`。

## 加载顺序与遮蔽

当两个提供商描述**相同**作用域时,更高优先级的提供商胜出。提供商优先级:

| 优先级 | 提供商 id       |
| -------: | ----------------- |
|      100 | `native`          |
|       80 | `claude`          |
|       70 | `agents`、`codex` |
|       60 | `gemini`          |
|       55 | `opencode`        |
|       30 | `github`          |
|       10 | `agents-md`       |

发现的文件随后按作用域去重:

- **跨所有提供商只保留一个用户上下文文件。** 因为 `native` 优先级最高,`~/.omp/agent/AGENTS.md` 遮蔽所有其他用户级上下文文件。
- **每个目录深度保留一个项目上下文文件。** 深度从当前目录度量:cwd 为深度 0,其父目录为深度 1,依此类推。祖先的配置子目录(`.claude/`、`.github/`、`.gemini/`、...)与那个祖先计为同一深度。
- **同一深度下,更高优先级的提供商遮蔽其余。**
- **跨深度,多个文件共存。** 在 monorepo 中,祖先 `AGENTS.md` 和包级的是不同深度,两者都加载。
- **逐字节相同的文件在排序后被折叠。** 项目副本中,最接近 cwd 的存活。唯一存活的用户作用域文件排在项目文件之后,因此当内容与项目内容相同时它存活。

最终注入顺序是**更远的项目祖先在前**,然后更接近 cwd 的项目文件,最后是存活的用户作用域文件。靠后的文件位于生成上下文更靠末尾处,更显眼。

### 遮蔽示例演练

```text
repo/
  AGENTS.md
  packages/api/
    AGENTS.md
    .github/copilot-instructions.md
```

在 `repo/packages/api` 中启动:

- `repo/AGENTS.md` 由 `agents-md` 在深度 2 找到并保留。
- `repo/packages/api/AGENTS.md`(`agents-md`,优先级 10)和 `repo/packages/api/.github/copilot-instructions.md`(`github`,优先级 30)都解析为深度 0。GitHub 的更高优先级遮蔽包级独立 `AGENTS.md`,因此 Copilot 文件在该深度胜出。
- 两个保留文件按根在前、包在后的顺序排列,因此 `packages/api` 的文件更显眼。
- 如果添加 `repo/packages/api/.omp/AGENTS.md`,`native`(优先级 100)直接在深度 0 胜出,遮蔽两个低优先级文件。

## 注入行为

使用默认提示模板时,发现的上下文文件作为一个 `<repo-rules>` 块注入开场项目提示中,按上述排序为每个存活文件一个 `<file>` 元素:

```xml
<repo-rules>
You MUST follow the context files below for all tasks:
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/.github/copilot-instructions.md">
...package content...
</file>
</repo-rules>
```

当 `SYSTEM.md` 选择捆绑的自定义提示模板时,同样的文件被发射到该模板的 `<project>` / `<instructions>` 节。两种模式下,Agent 都能看到每个文件的绝对路径和完整展开的 Markdown 内容(`@` 导入已解析)。

加载是自动的——无需在会话期间指示 Agent 搜索 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules` 或类似文件。

未被自动加载的更深目录 `AGENTS.md` 文件(例如当前目录之下的)会单独以 `<dir-context>` 块浮出,列出其路径并告诉 Agent 在编辑这些目录前先读取它们。这些文件是指针,而非完整注入内容。

## `@` 导入

在任何上下文文件内部,`@path` 令牌在注入前内联展开为被引用文件的内容:

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

确切规则:

- **相对路径从导入文件自己的目录解析**,而不是会话的工作目录。
- **`~/` 和 `~`** 从用户家目录解析;绝对路径原样使用。
- **围栏代码块和内联代码跨度内的令牌保持原样**——当你想_写_一个 `@token` 而不展开它时很有用。
- **`git@github.com:org/repo.git` 和 `user@example.com` 风格的令牌不被视为导入。** 只有当 `@` 位于行首或空格/制表符之后时才算令牌。
- **句末标点会被修剪**出路径(`. , ; : ! ? ) ] } " '`),因此 `@docs/setup.md.` 导入 `docs/setup.md`。
- **导入最多递归五跳。** 导入的文件本身可包含 `@` 导入,总深度上限为五。
- **循环被跳过。** 已被拉入当前展开树的文件不会重新展开,因此相互导入干净终止。
- **缺失或不可读的目标保留原 `@token` 文本**,而不是报错。

## 粘性规则与普通上下文

用普通上下文文件(`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.github/copilot-instructions.md`、...)承载大部分指引:仓库概览、代码风格、构建与测试命令、审查期望和本地约定。它们加载进开场生成的项目上下文。

用顶层 **`RULES.md`** 承载少数即使在长对话把开场上下文推到转录很远处之后仍必须保持活动的硬性要求:

```markdown
# ~/.omp/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` 很特殊:

- 它**只**在原生位置读取:活动用户 Agent 目录,以及 cwd 到仓库根遍历选定的最近非空项目 `.omp/` 目录。若该项目目录没有 `RULES.md`,OMP 不会回退到更远的 `.omp/RULES.md`。
- 它作为**始终应用规则**加载,而非上下文文件,因此它会在接近当前轮次处重新附加,并在长会话中保持效力。
- 它**始终粘性**:frontmatter 不能让它不粘。若需要条件或选择加入行为,改写普通规则文件(见 [Skills](./skills.md))。
- 两个顶层候选都以规则名 `RULES` 合成,规则去重基于名称。通常用户 `RULES.md` 遮蔽项目 `RULES.md`;它们不拼接。避免把 `.omp/rules/` 或用户 `rules/` 目录下的常规文件命名为 `RULES.md`,因为原生常规规则加载更早,可能遮蔽两个粘性候选。

保持 `RULES.md` 简短。长的背景属于 `AGENTS.md`,在那里它只消耗一次上下文预算。

## 禁用发现提供商

用 `~/.omp/agent/config.yml`、项目 `.omp/config.yml` 或 `--config` 覆盖层中的 `disabledProviders` 设置关闭提供商:

```yaml
# .omp/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` 是**带一个共享 id 命名空间的整提供商开关**,由两个无关子系统使用:

| Id 种类                | 示例                                                                           | 列入时的效果                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发现提供商 id | `native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md` | 整个配置源被移除——不仅是其上下文文件,还有它本会贡献的任何 MCP 服务器、斜杠命令、技能、钩子、工具、提示和设置。 |
| 模型提供商 id     | `anthropic`、`openai`、`google`、`groq`、`ollama`、`openrouter`                    | 即使凭据存在,模型后端也从选择中移除。见 [Providers](./providers.md)。                                                                |

Id 是精确的,两个命名空间不会意外冲突:`google` 禁用 Google 模型后端,而 `gemini` 禁用 Gemini CLI 发现文件。禁用发现提供商比看起来更重——例如禁用 `claude` 也会丢弃 Claude 发现的 MCP 服务器、命令、技能、钩子、工具和设置,而不仅是 `CLAUDE.md`。

只有 `enabledModels` 和 `disabledProviders` 支持**路径作用域**条目,因此可以按子树变化提供商可用性:

```yaml
disabledProviders:
  - github # disabled everywhere
  - path: ~/work/legacy-claude
    providers:
      - claude # disabled only under this directory
```

当 cwd 等于配置的路径或位于其下时,作用域条目生效;`~` 展开为家目录。裸字符串条目处处生效。

记住,更高优先级的设置层**替换**数组设置,而不是追加。如果全局配置禁用 `claude` 但项目配置设置 `disabledProviders: [github]`,那么在该项目内 Claude 发现被重新启用,只有 GitHub 被禁用。完整的层优先级、合并规则和路径作用域数组细节见 [Settings](./settings.md)。

## 故障排查

### 文件未加载

- 原生项目上下文只从最近非空 `.omp/` 目录读取。该目录必须包含非空 `AGENTS.md`;若没有,发现不会继续到更远的原生目录。
- 独立 `AGENTS.md` 由 `agents-md` 处理,而非 `native`。
- `.claude/CLAUDE.md`、`.gemini/GEMINI.md` 和 `.github/copilot-instructions.md` 只从当前工作目录的配置目录读取——不从每个祖先读取。
- `~/.codex/AGENTS.md` 和 `~/.config/opencode/AGENTS.md` 仅用户级,没有项目对应物。
- 空文件对原生和独立提供商不贡献任何内容。
- 被禁用的发现提供商不贡献任何内容——检查全局、项目和 `--config` 层中的 `disabledProviders`。

### 错误的文件胜出

在一个用户作用域或项目深度,更高优先级的提供商遮蔽其他(native > claude > agents/codex > gemini > opencode > github > agents-md)。要强制确定性行为,把指引移入 `.omp/AGENTS.md`(原生总是胜出)或禁用竞争的发现提供商。

### 用户上下文消失了

只有一个用户级上下文文件存活,`~/.omp/agent/AGENTS.md` 优先级最高。若它存在,它会遮蔽用户级 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.config/opencode/AGENTS.md`、`~/.copilot/copilot-instructions.md` 和 `~/.agent`/`~/.agents` 文件。把用户指引合并进原生文件,或若你更偏好另一个工具的文件则移除原生文件。

### `RULES.md` 文件被忽略

只有原生 `RULES.md` 位置是粘性的:活动用户 Agent 目录,以及从 cwd 向仓库根选定的最近非空项目 `.omp/` 目录。若存在更近的非空 `.omp/` 目录,即使它没有 `RULES.md`,它也会阻断更远的原生目录。其他任何位置的 `RULES.md` 都不是被认可的约定。

### `@` 导入未展开

确认目标相对于导入文件存在(而非 cwd)。围栏代码块或内联代码跨度内的导入有意保持字面,`git@`/电子邮件样式的令牌从不导入,循环被跳过,展开在五跳后停止,缺失目标保持原 `@path` 文本不变。
