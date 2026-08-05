# 技能

技能(Skills)是基于文件的能力包,在启动时被发现,并以以下形式暴露给模型:

- 系统提示词中的轻量元数据(名称 + 描述)
- 通过 `read` 工具按需读取 `skill://...` 的内容
- 可选的交互式 `/skill:<name>` 命令

本文档介绍 `packages/coding-agent/src/extensibility/skills.ts`、`packages/coding-agent/src/discovery/builtin.ts`、`packages/coding-agent/src/internal-urls/skill-protocol.ts` 和 `packages/coding-agent/src/discovery/agents-md.ts` 中的当前运行时行为。

## 本代码库中技能的定义

一个被发现的技能表示为:

- `name`
- `description`
- `filePath`(`SKILL.md` 路径)
- `baseDir`(技能目录)
- 来源元数据(`provider`、`level`、路径)

运行时仅要求 `name` 和 `path` 有效。实际上,匹配质量取决于 `description` 是否有意义。

## 必需布局与 SKILL.md 预期

### 目录布局

对于基于提供商(原生/Claude/Codex/Agents/插件提供商)的发现,技能在 `skills/` 下**一层**被发现:

- `<skills-root>/<skill-name>/SKILL.md`

类似 `<skills-root>/group/<skill>/SKILL.md` 的嵌套模式不会被提供商加载器发现。

对于 `skills.customDirectories`,扫描使用相同的非递归布局(`*/SKILL.md`)。

```text
Provider-discovered layout (non-recursive under skills/):

<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ discovered
  ├─ pdf/
  │   └─ SKILL.md      ✅ discovered
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ not discovered by provider loaders

Custom-directory scanning is also non-recursive, so nested paths are ignored unless you point `customDirectories` at that nested parent.
```

### `SKILL.md` frontmatter

技能类型上支持的 frontmatter 字段:

- `name?: string`
- `description?: string`
- `globs?: string[]`
- `alwaysApply?: boolean`
- `hide?: boolean`
- `disableModelInvocation?: boolean`(Agent Skills 中 `hide` 的等价物;从 kebab-case `disable-model-invocation` 规范化而来)
- 其他键作为未知元数据保留

当前运行时行为:

- `name` 默认为技能目录名
- `description` 在以下场景必需:
  - 原生 `.omp` 提供商技能发现(`requireDescription: true`)
  - `omp-plugins` 扩展包技能和 `github` 提供商(`.github/skills/`),它们也传入 `requireDescription: true`
  - `src/discovery/helpers.ts` 中 `scanSkillsFromDir` 进行的 `skills.customDirectories` 扫描(非递归)
- claude/codex/agents/opencode/claude-plugins 提供商可以加载无描述的技能

## 发现流水线

`packages/coding-agent/src/extensibility/skills.ts` 中的 `loadSkills()` 分三遍进行:

1. **能力提供商**,通过 `loadCapability("skills")`(托管/自动学习提供商的技能在此跳过,在第 3 遍处理)
2. **自定义目录**,通过 `scanSkillsFromDir(..., { requireDescription: true })`(一层目录枚举)。自定义目录技能覆盖同名的默认提供商技能;重复的自定义目录名称保持先到先得。
3. **托管(自动学习)技能**(`omp-managed` 提供商)最后解析,因此提供商或自定义目录中任何同名的已启用创作技能优先

如果 `skills.enabled` 为 `false`,发现不返回任何技能。

### 内置技能提供商与优先级

提供商排序为优先级优先(高者胜),同级按注册顺序。

当前注册的技能提供商:

1. `native`(优先级 100)— 通过 `src/discovery/builtin.ts` 发现的 `.omp` 用户/项目技能
2. `omp-plugins`(优先级 90)— 通过 `extensions:`、`--extension`/`-e` 加载的扩展包旁的 `skills/`,或 `~/.omp/plugins/node_modules` 下已安装的插件
3. `claude`(优先级 80)
4. 优先级 70 组(按注册顺序):
   - `claude-plugins`
   - `agents`
   - `codex`
5. `opencode`(优先级 55)
6. `github`(优先级 30)— `.github/skills/<name>/SKILL.md`(GitHub Agent Skills 布局,仅项目)
7. `omp-managed`(优先级 5)— `~/.omp/agent/managed-skills` 下的自动学习技能,在 `src/discovery/builtin.ts` 中注册并无条件发现(只有写入/提示受 `autolearn.enabled` 门控);始终让位于同名的创作技能

去重键是技能名称。给定名称的第一个条目胜出。

### 来源开关与筛选

`loadSkills()` 应用以下控制:

- 来源开关:`enableCodexUser`、`enableClaudeUser`、`enableClaudeProject`、`enablePiUser`、`enablePiProject`、`enableAgentsUser`、`enableAgentsProject`
- `disabledExtensions` 中 `skill:<name>` 形式的条目
- `ignoredSkills`(排除;glob 模式)
- `includeSkills`(包含允许列表;glob 模式;为空表示包含全部)

筛选顺序为:

1. 未被 `disabledExtensions` 禁用
2. 来源已启用
3. 未被忽略
4. 被包含(如果存在包含列表)

`agents` 提供商(`.agent[s]/skills`)是 OMP 原生的标准位置,有自己的 `enableAgentsUser`/`enableAgentsProject` 开关 — 禁用 Claude/Codex/Pi **不会**关闭它。没有专用开关的提供商(`claude-plugins`、`opencode`、`github` 等)在**任一**具名第三方来源开关启用时启用。

### 冲突与重复处理

- 能力去重已按名称保留每名称的第一个技能(最高优先级提供商)
- `extensibility/skills.ts` 额外:
  - 通过 `realpath` 对相同文件去重(符号链接安全)
  - 当后续技能名称冲突时发出冲突警告
  - 保留便捷 API `loadSkillsFromDir({ dir, source })`,作为 `scanSkillsFromDir` 的薄适配器
- 自定义目录技能在提供商技能之后合并,并覆盖同名的默认路径提供商技能。自定义目录之间,第一个同名技能胜出。

## 运行时使用行为

### 系统提示词暴露

系统提示词构造(`src/system-prompt.ts`)按如下方式使用发现的技能:

- 如果 `read` 工具可用:
  - 在提示词中包含发现的技能列表,排除 `hide: true` 的技能
- 否则:
  - 省略发现的列表

`hide: true` 不会禁用技能。隐藏技能仍会被加载,并且在技能命令启用时仍可通过 `skill://<name>` 和 `/skill:<name>` 访问。

任务工具子代理通过正常会话创建接收会话的发现/提供技能列表;没有按任务固定技能的覆盖机制。

### 交互式 `/skill:<name>` 命令

如果 `skills.enableSkillCommands` 为 true,交互模式为每个发现的技能注册一个斜杠命令。

`/skill:<name> [args]` 行为:

- 识别传统的行首形式,以及嵌入普通文本中、以空白分隔的 `/skill:<name>` token
- 对于嵌入 token,移除该 token 并将周围文本作为参数传递
- 当草稿以另一个斜杠命令或本地 bash/Python 执行符号开头时,不将嵌入 token 视为调用
- 直接从 `filePath` 读取技能文件
- 去除 frontmatter
- 用技能名称、基础目录和可选用户参数包装正文,然后作为自定义消息注入
- 投递模式遵循**提交快捷键**:
  - **Enter** → 流式期间在 `steer` 队列上调用技能(与自由文本 Enter 一致,同样执行 steer),或在 Agent 未流式时作为普通空闲提示词
  - **Ctrl+Enter**(`app.message.followUp`)→ 流式期间在 `followUp` 队列上调用技能,或在 Agent 未流式时作为普通空闲提示词

没有标志、模式选择器或 frontmatter 旋钮覆盖投递模式 — 快捷键**就是**选择,与流式期间自由文本路由相同。

## `skill://` URL 行为

`src/internal-urls/skill-protocol.ts` 支持:

- `skill://<name>` → 解析为该技能的 `SKILL.md`
- `skill://<name>/<relative-path>` → 在该技能目录内解析

```text
skill:// URL resolution

skill://pdf
  -> <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  -> <pdf-base>/references/tables.md

Guards:
- reject absolute paths
- reject `..` traversal
- reject any resolved path escaping <pdf-base>
```

解析细节:

- 技能名称必须精确匹配
- 相对路径进行 URL 解码
- 绝对路径被拒绝
- 路径遍历(`..`)被拒绝
- 解析后的路径必须保持在 `baseDir` 内
- 缺失文件返回显式的 `File not found` 错误

内容类型:

- `.md` => `text/markdown`
- 其他一切 => `text/plain`

缺失资产不执行回退搜索。

## 技能与 AGENTS.md、命令、工具、钩子的关系

### 技能与 AGENTS.md

- **技能**:具名的、可选的能力包,由任务上下文选择或显式请求
- **AGENTS.md/上下文文件**:持久指令文件,作为上下文文件能力加载,并按层级/深度规则合并

`src/discovery/agents-md.ts` 专门从 `cwd` 向上遍历祖先目录以发现独立的 `AGENTS.md` 文件(在仓库根目录处停止,若无已知仓库根目录则在 home 处停止),跳过所在目录名以点开头的文件。

### 技能与斜杠命令

- **技能**:模型可读的知识/工作流内容
- **斜杠命令**:用户调用的命令入口点
- `/skill:<name>` 是注入技能文本的便捷包装;它不改变技能发现语义

### 技能与自定义工具

- **技能**:通过提示词上下文和 `read` 加载的文档/工作流内容
- **自定义工具**:模型可调用的可执行工具 API,带 schema 和运行时副作用

### 技能与钩子

- **技能**:被动内容
- **钩子**:事件驱动的运行时拦截器,可在执行期间阻止/修改行为

## 与发现逻辑相关的实用创作指引

- 将每个技能放在自己的目录中:`<skills-root>/<skill-name>/SKILL.md`
- 始终包含显式的 `name` 和 `description` frontmatter
- 将引用的资产保持在同一技能目录下,并使用 `skill://<name>/...` 访问
- 对于嵌套分类(`team/domain/skill`),将 `skills.customDirectories` 指向嵌套父目录;扫描本身保持非递归
- 避免跨来源使用重复的技能名称;第一个匹配按提供商优先级胜出
