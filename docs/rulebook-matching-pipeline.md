# 规则手册匹配流水线

本文档描述 coding-agent 如何从受支持的配置格式中发现规则,将它们规范化为统一的 `Rule` 结构,解决优先级冲突,并将结果拆分为:

- **规则手册规则**(通过系统提示词与 `rule://` URL 提供给模型)
- **TTSR 规则**(时间旅行流规则)

它反映当前实现,包括已解析但未强制执行的语义与元数据。

## 实现文件

- [`packages/coding-agent/src/capability/rule.ts`](../packages/coding-agent/src/capability/rule.ts)
- [`packages/coding-agent/src/capability/rule-buckets.ts`](../packages/coding-agent/src/capability/rule-buckets.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/discovery/index.ts`](../packages/coding-agent/src/discovery/index.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts)
- [`packages/coding-agent/src/discovery/builtin-defaults.ts`](../packages/coding-agent/src/discovery/builtin-defaults.ts)
- [`packages/coding-agent/src/discovery/agents.ts`](../packages/coding-agent/src/discovery/agents.ts)
- [`packages/coding-agent/src/discovery/github.ts`](../packages/coding-agent/src/discovery/github.ts)
- [`packages/coding-agent/src/discovery/cursor.ts`](../packages/coding-agent/src/discovery/cursor.ts)
- [`packages/coding-agent/src/discovery/windsurf.ts`](../packages/coding-agent/src/discovery/windsurf.ts)
- [`packages/coding-agent/src/discovery/cline.ts`](../packages/coding-agent/src/discovery/cline.ts)
- [`packages/coding-agent/src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`packages/coding-agent/src/system-prompt.ts`](../packages/coding-agent/src/system-prompt.ts)
- [`packages/coding-agent/src/internal-urls/rule-protocol.ts`](../packages/coding-agent/src/internal-urls/rule-protocol.ts)
- [`packages/utils/src/frontmatter.ts`](../packages/utils/src/frontmatter.ts)

## 1. 规范规则结构

所有提供商都将源文件规范化为 `Rule`:

```ts
interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  _source: SourceMeta;
}
```

能力标识为 `rule.name`(`ruleCapability.key = rule => rule.name`)。

后果:优先级与去重**仅基于名称**。两个具有相同 `name` 的不同文件被视为同一条逻辑规则。

## 2. 发现来源与规范化

`src/discovery/index.ts` 自动注册提供商。对于 `rules`,当前提供商为:

- `native`(优先级 `100`)
- `omp-plugins`(优先级 `90`)——配置的扩展包根目录内的 `rules/*.{md,mdc}`,通过共享的 `buildRuleFromMarkdown` 路径规范化
- `agents`(优先级 `70`)
- `cursor`(优先级 `50`)
- `windsurf`(优先级 `50`)
- `cline`(优先级 `40`)
- `github`(优先级 `30`)
- `builtin-defaults`(优先级 `1`)

### 原生提供商(`builtin.ts`)

从以下位置加载 `.omp` 规则:

- 项目规则:当 cwd 的 `.omp/` 目录非空时,加载 `<cwd>/.omp/rules/*.{md,mdc}`
- 用户规则:`<active-native-agent-dir>/rules/*.{md,mdc}`
- 固定用户规则:`<active-native-agent-dir>/RULES.md`
- 固定项目规则:从 cwd 向仓库根目录遍历时选中的最近的非空 `.omp/` 目录中的 `RULES.md`;当该目录缺少此文件时,OMP 不再继续向上查找

活动原生 Agent 目录默认为 `~/.omp/agent`,遵循命名配置文件,并遵循 `PI_CODING_AGENT_DIR`。

规范化:

- `name` = 去掉 `.md`/`.mdc` 后的文件名
- frontmatter 通过 `parseFrontmatter` 解析
- `content` = 正文(去除 frontmatter)
- `globs`、`alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 与 `interruptMode` 由 `buildRuleFromMarkdown` 解析
- 顶层 `RULES.md` 被合成为规则名 `RULES`,并强制 `alwaysApply: true`

两个固定文件都使用固定名称 `RULES`。由于原生项按项目规则、用户规则、用户固定 `RULES.md`、项目固定 `RULES.md` 的顺序追加,因此最先出现的名为 `RULES` 的项获胜。通常这意味着用户固定内容遮蔽项目固定内容;普通的 `rules/RULES.md` 可以同时遮蔽两者。

重要提示:看起来像文件 glob 的 `condition` 值会被转换为带兜底条件 `.*` 的 `tool:edit(...)` / `tool:write(...)` 作用域简写。

### Agents 提供商(`agents.ts`)

同时从 `.agent` 和 `.agents` 目录加载:

- 项目:从 `cwd` 向上遍历至仓库根目录,加载 `<ancestor>/.agent/rules/*.{md,mdc}` 与 `<ancestor>/.agents/rules/*.{md,mdc}`
- 用户:`~/.agent/rules/*.{md,mdc}` 与 `~/.agents/rules/*.{md,mdc}`

规范化使用共享的 `buildRuleFromMarkdown` 路径:名称取自文件名,正文去除 frontmatter,并解析 `globs`、`alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 与 `interruptMode`。

### Cursor 提供商(`cursor.ts`)

从以下位置加载:

- 用户:`~/.cursor/rules/*.{mdc,md}`
- 项目:`<cwd>/.cursor/rules/*.{mdc,md}`

规范化(`transformMDCRule`):

- `description`:仅当为字符串时保留
- `alwaysApply`:规范化为布尔值——仅当 frontmatter 含有 `alwaysApply: true` 时为 `true`(其他任何值都变为 `false`)
- `globs`:接受数组(仅字符串元素)或单个字符串
- `condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 与 `interruptMode` 由共享规则辅助函数解析
- `name` 取自去掉扩展名的文件名

### Windsurf 提供商(`windsurf.ts`)

从以下位置加载:

- 用户:`~/.codeium/windsurf/memories/global_rules.md`(固定规则名 `global_rules`)
- 项目:`<cwd>/.windsurf/rules/*.md`

规范化:

- `globs`:字符串数组或单个字符串
- `alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 与 `interruptMode` 由共享规则辅助函数解析
- 用户全局文件的 `name` 固定为 `global_rules`,项目规则则取自文件名

### Cline 提供商(`cline.ts`)

从 `cwd` 向上搜索最近的 `.clinerules`:

- 如果是目录:加载其中的 `*.md`
- 如果是文件:将单个文件加载为名为 `clinerules` 的规则

规范化:

- `globs`:字符串数组或单个字符串
- `alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 与 `interruptMode` 由共享规则辅助函数解析
- `.clinerules` 文件的 `name` 固定为 `clinerules`,`.clinerules/*.md` 则取自文件名

### GitHub 提供商(`github.ts`)

从以下位置递归加载 `*.instructions.md`:

- 项目:`<cwd>/.github/instructions/`
- 用户:对于逗号分隔的 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 中的每个目录,加载 `<dir>/.github/instructions/`

去掉 `.instructions.md` 后的文件名即为规则名。共享的 Markdown 解析仍能识别常规 OMP 规则元数据,包括 TTSR 字段。GitHub 的 `applyTo` 还会按如下方式额外规范化:

- 逗号分隔的字符串(或可容忍的 YAML 数组)变为 `globs`;
- `*`、`**` 或 `**/*` 使规则始终应用并清空 `globs`;
- 任何其他 glob 都使规则非始终应用;缺失的 `description` 会从 globs 生成;
- 缺失 `applyTo` 会产生一条规则手册描述以及一条发现警告。

由于 TTSR 分桶在始终应用/规则手册分桶之前运行,带有被接受的 `condition` 或 `astCondition` 的 GitHub 指令无论 `applyTo` 如何都仍仅属于 TTSR。

## 3. Frontmatter 解析行为与歧义

所有提供商都使用 `parseFrontmatter`(`utils/frontmatter.ts`),其语义如下:

1. 仅当内容以 `---` 开头且有闭合的 `\n---` 时才解析 frontmatter。
2. 提取 frontmatter 后正文会被裁剪。
3. 如果整篇文档的 YAML 解析失败:
   - 记录一条警告,
   - 解析器回退到简单的 `key: value` 行解析(`^([\w-]+):\s*(.*)$`),
   - 每个捕获的值会独立地重新按 YAML 解析,只有仍然解析失败的值才保留为原始裁剪字符串。

回退限制:

- 多行数组、嵌套对象及其他依赖缩进的 YAML 结构不会被重建。有效的单行流式值(例如 `[text, thinking]`)仍能在逐值重新解析中存活。
- 单独格式错误的值仍保留为原始字符串;需要布尔值、列表或对象的提供商可能会丢弃该元数据。
- `ttsr_trigger` 在回退中有效(下划线键);`thinking-level` 等连字符键也能解析并规范化为 camelCase(`thinkingLevel`)——键名规范化同样适用于 YAML 路径。
- 没有有效 frontmatter 的文件仍会作为元数据为空、正文为完整内容的规则加载。作用域解析器也容忍常见的畸形回退值 `scope: "text","thinking"`,但优先推荐有效的 YAML(`"text, thinking"` 或 `[text, thinking]`)。

## 4. 提供商优先级与去重

`loadCapability("rules")`(`capability/index.ts`)合并各提供商的输出,然后按 `rule.name` 去重。

### 优先级模型

- 提供商按优先级降序排列。
- 相同优先级保持注册顺序(`discovery/index.ts` 中 `cursor` 在 `windsurf` 之前)。
- 去重为先到先得:最先遇到的规则名被保留;后续同名项在 `all` 中被标记为 `_shadowed`,并从 `items` 中排除。

当前有效的规则提供商顺序为:

1. `native`(100)
2. `omp-plugins`(90)
3. `agents`(70)
4. `cursor`(50)
5. `windsurf`(50)
6. `cline`(40)
7. `github`(30)
8. `builtin-defaults`(1)

### 提供商内部排序注意事项

在提供商内部,项的顺序来自 `loadFilesFromDir` 的 glob 结果顺序加上显式的 push 顺序。这对常规使用来说足够确定,但代码中并未显式排序。

值得注意的源顺序差异:

- `native` 依次追加项目 `.omp/rules`、用户 `~/.omp/agent/rules`、用户 `RULES.md`,然后是最近的项目 `RULES.md`。
- `omp-plugins` 按配置的扩展包根目录追加 `rules/` 结果。
- `agents` 先追加项目遍历得到的 `.agent`/`.agents` 规则目录,再追加用户主目录。
- `cursor` 先追加用户结果,再追加项目结果。
- `windsurf` 先追加用户 `global_rules`,再追加项目规则。
- `cline` 只加载最近的 `.clinerules` 来源。
- `github` 先追加 cwd 项目指令,再按环境变量列表顺序追加每个 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 条目。
- `builtin-defaults` 使用内嵌规则源顺序。

## 5. 拆分为规则手册、始终应用与 TTSR 分桶

在 `createAgentSession`(`sdk.ts`)完成规则发现后,`bucketRules(...)` 应用会话级筛选与分桶分配:

1. 丢弃 `ttsr.disabledRules` 中列出的规则。
2. 当 `ttsr.builtinRules === false` 时,丢弃来自 `builtin-defaults` 提供商的规则。
3. 将带有非空 `condition` 或 `astCondition` 的规则注册到 `TtsrManager`;如果注册成功,该规则仅属于 TTSR。
4. 将剩余的 `alwaysApply === true` 规则放入 `alwaysApplyRules`。
5. 将剩余带有 `description` 的规则放入 `rulebookRules`。

### 分桶行为

- **TTSR 分桶**:任何启用的、带有非空解析后 `condition`(正则)或 `astCondition`(ast-grep 模式)且被 `TtsrManager.addRule(...)` 接受的规则。优先于其他分桶。
- **始终应用分桶**:`alwaysApply === true` 且非 TTSR。完整内容注入系统提示词。可通过 `rule://` 解析。
- **规则手册分桶**:必须具有 description,必须不是 TTSR,必须不是 `alwaysApply`。在系统提示词中按名称+描述列出;内容通过 `rule://` 按需读取。
- 同时具有触发条件和 `alwaysApply` 的规则,仅当 TTSR 注册接受它时才进入 TTSR;否则它可以落入始终应用。
- 同时具有 `alwaysApply` 和 `description` 的规则只进入始终应用(不进入规则手册)。

## 6. 元数据如何影响运行时表面

### `description`

- 规则手册收录所必需。
- 渲染在系统提示词的规则手册块中(默认模板中的 `<domain-rules>`,自定义提示词模板中的 `<rules>`)。
- 缺少 description 会使规则无法进入规则手册列表;除非它是始终应用规则或被接受的 TTSR 规则,否则也无法通过 `rule://` 寻址。

### `globs`

- 在 `Rule` 上原样传递。
- 在默认提示词的规则手册列表中内联渲染(`- <name> (<glob>, ...): <description>`);自定义提示词模板将它们渲染为 `<glob>...</glob>` 条目。
- 在规则 UI 状态中暴露(`extensions` 模式列表)。
- 被 TTSR 用作全局路径闸门:如果 TTSR 规则具有 globs,则匹配上下文必须至少包含一个匹配的文件路径。
- 不用于为 `rule://` 自动选择规则手册规则;规则手册匹配仍是建议性的提示词行为。

### `alwaysApply`

- 由提供商解析并保留。
- 用于 UI 显示(扩展状态管理器中的 `"always"` 触发标签)。
- 用作从 `rulebookRules` 排除的条件。
- **规则的完整内容会自动注入系统提示词**(在规则手册规则部分之前)。
- 该规则也可通过 `rule://<name>` 寻址以重新读取。

### `condition`、`astCondition`、`scope` 与 `interruptMode`

- `condition` 是正则 TTSR 触发字段;解析期间接受旧版 `ttsr_trigger` / `ttsrTrigger` 作为回退输入。前导的 `(?i)`、`(?m)` 或 `(?s)` 内联标志组会被转换为等效的 JavaScript `RegExp` 标志。
- `astCondition` 是 ast-grep 触发字段:一个字符串或结构模式的 YAML 序列,原样保留(不做 glob 推断)。它只在 edit/write 工具流上匹配,语言根据文件路径推断。规则可以设置 `condition`、`astCondition` 或两者。
- `scope` 将 TTSR 匹配限制在流表面的允许列表中。它接受逗号分隔的 YAML 字符串或 YAML 序列。省略它时,会监听助手散文(`text`)和所有工具参数(`tool`),但不监听思考。

  ```yaml
  # 散文与思考;以下形式等价:
  scope: "text, thinking"
  ```

  ```yaml
  scope: [text, thinking]
  ```

  ```yaml
  # 块式 YAML 序列同样有效:
  scope:
    - text
    - thinking
  ```

  ```yaml
  # 仅 edit/write 产生的 TypeScript 源快照:
  scope: "tool:edit(*.ts), tool:write(*.ts)"
  ```

  有效 token 为 `text`、`thinking`、`tool`(或 `toolcall`)以及 `tool:<name>(<path-glob>)`。解析器容忍畸形的回退拼写 `scope: "text","thinking"`,但可移植的规则文件应将逗号放在单个 YAML 字符串内或使用 YAML 序列。

- 看起来像文件 glob 的 `condition` token 会变为 `tool:edit(<glob>)` 和 `tool:write(<glob>)` 作用域条目,外加兜底条件 `.*`;`astCondition` token 从不触发此简写。
- `interruptMode` 可以覆盖该规则的全局 TTSR 中断模式。

## 7. 系统提示词包含路径

`buildSystemPromptInternal` 同时接收 `rules`(规则手册)和 `alwaysApplyRules`。

始终应用规则会与生效的系统/自定义/追加提示词来源以及已加载的上下文文件正文去重。规范化内容已出现在这些来源之一的规则会被从自动注入中省略。剩余的原始正文在规则手册列表之前渲染:默认模板中的 `<generic-rules>` 内部,以及捆绑的自定义提示词模板中直接渲染。

规则手册规则在 `<domain-rules>` 块中渲染为 `- <name> (<globs>): <description>` 行;提示词中的 URL 列表记录 `rule://<name>`,工作流部分告诉模型先阅读相关规则。自定义提示词模板(`custom-system-prompt.md`)则在显式的“必须阅读 `rule://<name>`”指令下渲染带 `<glob>` 子元素的 `<rule name="...">` 条目。

这是建议性/上下文性的:提示词文本要求模型阅读适用的规则,但代码不会强制 glob 的适用性。

## 8. `rule://` 内部 URL 行为

`RuleProtocolHandler` 针对进程全局的活动规则快照进行解析,该快照在 `sdk.ts` 中为每个顶层会话安装一次:

```ts
setActiveRules([
  ...rulebookRules,
  ...alwaysApplyRules,
  ...ttsrManager.getRules(),
]);
```

含义:

- `rule://<name>` 针对 **rulebookRules**、**alwaysApplyRules** 和 **已注册的 TTSR 规则**进行解析。
- TTSR 规则在规则手册/始终应用之前就被分桶出去,但 `ttsrManager.getRules()` 会将它们重新加入快照,因此被触发的规则(例如内置规则)仍可被寻址以重新读取。
- 没有 description、没有 `alwaysApply`、也没有被接受的 TTSR 条件的规则无法通过 `rule://` 寻址。
- 解析为精确名称匹配。
- 未知名称返回错误,列出可用的规则名称。
- 返回的内容是原始 `rule.content`(已去除 frontmatter),内容类型为 `text/markdown`。

## 9. 已知的部分/未强制执行的语义

1. 当前为 `rules` 加载的规则提供商有 `native`、`omp-plugins`、`agents`、`cursor`、`windsurf`、`cline`、`github` 以及内嵌的 `builtin-defaults`;其他工具的提供商文件可能解析其他配置格式,但不会注册规则加载器。
2. `globs` 元数据会呈现给提示词/UI,并用作 TTSR 匹配的全局路径闸门,但它不用于为 `rule://` 自动选择规则手册规则。
3. `rule://` 的规则选择包括规则手册、始终应用和已注册的 TTSR 规则(因此被触发的 TTSR 规则可以被重新读取),但不包括未注册条件且既无 description 也无 `alwaysApply` 的规则。
4. 发现警告(`loadCapability("rules").warnings`)会被产生,但 `createAgentSession` 目前在此路径中不会呈现/记录它们。
