# 配置发现与解析

本文档描述 coding-agent 目前如何解析配置:扫描哪些根目录、优先级如何工作,以及解析后的配置如何被设置、技能、钩子、工具和扩展消费。

## 范围

主要实现:

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts`(从 `config.ts` 重新导出)
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

关键集成点:

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/hooks/loader.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

## 解析流程(图示)

```text
         Generic helper order (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.omp/agent, ~/.claude, ...       │
│ 2) <cwd>/.omp, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (native provider scans project .omp before user .omp;
  other providers have their own loading rules)
                    │
                    ▼
      provider priority sort + capability dedup
                    │
                    ▼
          subsystem-specific consumption
   (settings, skills, hooks, tools, extensions)
```

## 1) 配置根目录与来源顺序

## 规范根目录

`src/config.ts` 定义了固定的来源优先级列表:

1. `.omp`(原生)
2. `.claude`
3. `.codex`
4. `.gemini`

用户级基础:

- OMP 原生:`~/<PI_CONFIG_DIR>/agent`(通常是 `~/.omp/agent`;命名 profile 会如下所述改变它)
- `~/.claude`
- `~/.codex`
- `~/.gemini`

项目级基础:

- `<cwd>/.omp`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` 是 `.omp`(`packages/utils/src/dirs.ts`)。`PI_CONFIG_DIR` 改变通用助手使用的 OMP 用户根目录。`PI_CODING_AGENT_DIR` 不同:对默认 profile 它改变 `getAgentDir()` 的消费者,如原生发现、设置和运行时状态,但**不**改变通用 `getConfigDirs()` / `findConfigFile()` 的 OMP 基础。命名 profile 忽略 `PI_CODING_AGENT_DIR`。

## Profiles

命名 profile(`omp --profile <name>`、`OMP_PROFILE` 或遗留回退 `PI_PROFILE`)重新定位 OMP 用户基础。`OMP_PROFILE` 定义时胜出,包括显式为空;`default`、空或空白选择默认 profile。当 profile 激活时,本文中写成 `~/.omp/agent/...` 的每个 OMP 原生用户级路径通常解析为 `~/.omp/profiles/<name>/agent/...`。`--alias <command>` 本身不选择 profile:与 `--profile` 配对时,它为那个 profile 创建 shell 快捷方式。

重定位在原生提供商(`builtin.ts`)和通用 `config.ts` 助手中一致,因此它覆盖斜杠命令、规则、提示、指令、钩子、工具、扩展、设置、技能和 MCP,以及顶层 `SYSTEM.md` / `RULES.md` / `AGENTS.md` 文件和运行时状态(会话、blob、`agent.db`)。profile 只能看到自己的 OMP 配置,永远看不到默认 profile 的 Agent 配置。

快捷键是唯一的例外:命名 profile 会把默认 profile 的 `~/.omp/agent/keybindings.*` 合并到自己的 `~/.omp/profiles/<name>/agent/keybindings.*` 下,profile 文件按绑定覆盖([#4867](https://github.com/can1357/oh-my-pi/issues/4867))。快捷键描述的是用户面前的终端/键盘,它不随活动 profile 改变,因此除非 profile 显式覆盖,用户级重映射在每个 profile 中都继续有效。继承的文件对 profile 进程只读——默认 profile 文件的旧格式迁移只在默认 profile 自身运行时发生。

在 macOS 和 Linux 上,已有的 `$XDG_DATA_HOME/omp`、`$XDG_STATE_HOME/omp` 或 `$XDG_CACHE_HOME/omp` 可以重定位对应的数据、状态或缓存路径。对命名 profile,OMP 仅当某 XDG 类别已包含 `omp/profiles/<name>` 时才使用该类别;否则该类别仍位于 `~/.omp/profiles/<name>` 下。在依赖 XDG 路径之前运行 `omp config init-xdg`。

其他来源基础不随 profile 作用域变化,在每个 profile 下加载方式相同:外部工具基础(`~/.claude`、`~/.codex`、`~/.gemini`)属于那些工具,项目级基础(`<cwd>/.omp`、`<cwd>/.claude`、...)与工作目录绑定。通篇阅读时,除非在讨论环境覆盖或 XDG 路径,请把 `~/.omp/agent` 读作活动 profile 的 Agent 目录的简写。

## 重要约束

`src/config.ts` 中的通用助手**不**在来源发现顺序中包含 `.pi`。

---

## 2) 核心发现助手(`src/config.ts`)

## `getConfigDirs(subpath, options)`

返回有序条目:

- 先是用户级条目(按来源优先级)
- 然后是项目级条目(按相同来源优先级)

选项:

- `user`(默认 `true`)
- `project`(默认 `true`)
- `cwd`(默认 `getProjectDir()`)
- `existingOnly`(默认 `false`)

此 API 用于基于目录的配置查找(命令、钩子、工具、Agent 等)。

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

跨有序基础搜索第一个存在的文件,返回第一个匹配(仅路径或路径+元数据)。

## `findAllNearestProjectConfigDirs(subpath, cwd)`

向上遍历父目录,返回每个来源基础(`.omp`、`.claude`、`.codex`、`.gemini`)**最近的已存在目录**,然后按来源优先级排序结果。

当项目配置应从祖先目录继承时(monorepo/嵌套工作区行为)使用它。

---

## 3) 文件配置包装(`src/config/config-file.ts` 中的 `ConfigFile<T>`,从 `src/config.ts` 重新导出)

`ConfigFile<T>` 是单个配置文件、经 schema 校验的加载器。

支持的格式:

- `.yml` / `.yaml`
- `.json` / `.jsonc`

行为:

- 对照提供的 Zod schema 校验解析后的数据。
- 缓存加载结果,直到 `invalidate()`。
- 通过 `tryLoad()` 返回三态结果:
  - `ok`
  - `not-found`
  - `error`(带 schema/解析上下文的 `ConfigError`)

仍支持遗留迁移:

- 若目标路径是 `.yml`/`.yaml`,同级的 `.json` 会被自动迁移一次(`migrateJsonToYml`)。

---

## 4) 设置解析模型(`src/config/settings.ts`)

运行时设置模型分层:

1. 全局设置:`~/.omp/agent/config.yml` 与 `config.yaml` 中第一个存在的文件
2. 项目设置:通过设置能力发现(`settings.json` 和来自提供商的 `config.yml`)
3. 配置覆盖:`PI_CONFIG_FILES`(平台路径列表),后接重复的 `omp --config <path>` 文件;全部仅对本进程按 `config.yml` 风格 YAML 加载
4. 运行时覆盖:内存中、非持久
5. Schema 默认值:来自 `SETTINGS_SCHEMA`

有效优先级:

`默认值 <- 全局 <- 项目 <- PI_CONFIG_FILES 覆盖 <- --config 覆盖 <- 运行时覆盖`

在任一覆盖列表中,后面的文件覆盖前面的文件。覆盖路径相对于活动项目目录解析(在 `~` 展开之后)。

写入行为:

- `settings.set(...)` 写入**全局**层(启动时选定的全局 YAML 文件),并排队后台保存。
- 项目设置和配置覆盖对设置 API 只读。

### 设置加载失败

- 缺失的全局/项目 YAML 视为空配置。
- 无效的全局或原生项目 YAML 会在文件锁下被移动到唯一的 `.broken-<timestamp>-<pid>-<uuid>` 同级文件,然后启动以原始路径和备份路径失败。不可读文件失败但不移动。
- 每个 `PI_CONFIG_FILES` / `--config` 覆盖都是严格的:缺失文件、无效 YAML 和非映射文档根都是硬错误。覆盖文件不会被隔离。

## 仍活动的迁移行为

启动时,若全局 `config.yml` 与 `config.yaml` 都不存在:

1. 从 `~/.omp/agent/settings.json` 迁移(成功时改名为 `.bak`)
2. 与 `agent.db` 中的遗留 DB 设置合并(DB 值在冲突时胜出)
3. 将合并结果写入 `config.yml`

`#migrateRawSettings` 中的字段级迁移:

- `queueMode` -> `steeringMode`
- 当旧值看起来像毫秒(`> 1000`)时,`ask.timeout` 毫秒 -> 秒
- 遗留扁平 `theme: "..."` -> `theme.dark/theme.light` 结构

---

## 5) 能力/发现集成

大多数非核心配置加载通过能力注册表(`src/capability/index.ts` + `src/discovery/index.ts`)流转。

## 提供商排序

提供商按数字优先级排序(高的在前)。示例优先级:

- 原生 OMP(`builtin.ts`):`100`
- Claude:`80`
- Codex / agents / Claude marketplace:`70`
- Gemini:`60`

```text
Provider precedence (higher wins)

native (.omp)          priority 100
claude                 priority  80
codex / agents / ...   priority  70
gemini                 priority  60
```

## 去重语义

能力定义 `key(item)`:

- 相同键 => 第一个条目胜出(更高优先级/更早加载的条目)
- 无键(`undefined`)=> 不去重,保留所有条目

相关键:

- 技能:`name`
- 工具:`name`
- 钩子:`${type}:${tool}:${name}`
- 扩展模块:`name`
- 扩展:`name`
- 设置:不去重(保留所有条目)

---

## 6) 原生 `.omp` 提供商行为(`packages/coding-agent/src/discovery/builtin.ts`)

原生提供商(`id: native`)从以下位置读取原生配置:

- 项目:`<cwd>/.omp/...`
- 用户:`~/.omp/agent/...`

### 目录接纳规则

- 斜杠命令、目录规则、提示、指令、钩子、工具、扩展、扩展模块和设置仅在根目录存在且非空时使用项目/用户根。
- 技能为从当前工作目录到仓库根/家目录边界的每个祖先扫描 `<ancestor>/.omp/skills`,加上 `~/.omp/agent/skills`,不要求根 `.omp` 目录本身非空。
- `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md` 直接读取用户级文件,项目文件使用最近的非空祖先 `.omp` 目录。`RULES.md` 成为始终应用的粘性规则。完整的 `SYSTEM.md` / `APPEND_SYSTEM.md` 契约见 [`docs/system-prompt-customization.md`](./system-prompt-customization.md)。
- MCP 不使用非空根接纳助手。它直接读取项目 `.omp/mcp.json` 然后 `.omp/.mcp.json`,接着用户 `mcp.json` 然后 `.mcp.json`。

### 按作用域加载

- 技能:`<ancestor>/.omp/skills/*/SKILL.md` 和 `~/.omp/agent/skills/*/SKILL.md`
- 斜杠命令:`commands/*.md`
- 规则:`rules/*.{md,mdc}` 加顶层 `RULES.md`
- 提示:`prompts/*.md`
- 指令:`instructions/*.md`
- 钩子:`hooks/pre/*`、`hooks/post/*`
- 工具:`tools/*.{json,md,ts,js,sh,bash,py}` 和 `tools/<name>/index.ts`
- 扩展模块:在 `extensions/` 下发现(+ 遗留 `settings.json.extensions` 字符串数组)
- 扩展:`extensions/<name>/gemini-extension.json`
- 设置能力:`settings.json`,然后 `config.yml`
- 上下文文件:`.omp/AGENTS.md`;独立的祖先 `AGENTS.md` 文件由低优先级 `agents-md` 提供商单独加载

### 最近项目查找细节

对 `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md`,原生提供商向上走到最近的非空项目 `.omp` 目录。

## 7) 主要子系统如何消费配置

## 设置子系统

- `Settings.init()` 按上述优先级加载全局 YAML 文件、发现的项目设置、`PI_CONFIG_FILES` / `--config` 覆盖和运行时覆盖。
- 只有 `level === "project"` 的能力条目被合并进项目层。

### 会话标题提示覆盖

在任何通用配置基础中创建 `TITLE_SYSTEM.md`:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- 缺失 `TITLE_SYSTEM.md` 则保留内置标题提示。
- 发现先检查当前项目目录基础(`<cwd>/.omp`、`.claude`、`.codex`、`.gemini`),然后按通用助手顺序检查用户基础。与原生 `SYSTEM.md` 不同,项目标题发现**不**向上遍历祖先目录。
- 该覆盖只替换自动会话标题生成的系统提示;常规 `SYSTEM.md` / `APPEND_SYSTEM.md` 提示定制不受影响。
- 在线路径要求标题模型把标题包裹在 `<title>...</title>` 中,并宽松地从文本解析(普通句子、截断/未闭合的标签,或游离的 `{"title": "..."}` JSON 回显都能工作)。`TITLE_SYSTEM.md` 覆盖会在其后追加包裹于 `<title>` 的指令。本地微小标题路径保留 `<title>...</title>` 预填/停止包装,并把该文件用作其系统轮次。

## 技能子系统

- `extensibility/skills.ts` 通过 `loadCapability(skillCapability.id, { cwd })` 加载。
- 应用来源开关和筛选(`ignoredSkills`、`includeSkills`、自定义目录)。
- 遗留命名开关仍存在(`skills.enablePiUser`、`skills.enablePiProject`),但它们门控原生提供商(`provider === "native"`)。

## 钩子系统

- `discoverAndLoadHooks()` 从钩子能力 + 显式配置路径解析钩子路径。
- 然后通过 Bun import 加载模块。

## 工具子系统

- `discoverAndLoadCustomTools()` 从工具能力 + 插件工具路径 + 显式配置路径解析工具路径。
- 声明式 `.md/.json` 工具文件仅为元数据;可执行加载期待代码模块。

## 扩展子系统

- `discoverAndLoadExtensions()` 加载原生扩展模块能力条目、JS/TS 钩子工厂、已安装插件入口点和显式配置路径。
- 环境扩展模块能力发现被显式限制为 `provider: "native"`;此步骤不扫描外来提供商。

---

## 8) 可依赖的优先级规则

使用这个心智模型:

1. `config.ts` 的来源目录顺序决定候选路径顺序。
2. 能力提供商优先级决定跨提供商优先级。
3. 能力键去重决定冲突行为(带键能力第一个胜出)。
4. 子系统特定的合并逻辑可以进一步改变有效优先级(尤其是设置)。

### 设置特定注意事项

设置能力条目不去重;`Settings.#loadProjectSettings()` 按返回顺序深合并项目条目,因此后面的条目覆盖前面的。提供商按从高到低的优先级访问,这意味着较低优先级提供商的设置可以覆盖较高优先级的设置。在原生提供商内部,项目 `config.yml` 跟在 `settings.json` 之后并覆盖它。原生 `.omp/config.yml` 模型角色随后作为权威项目模型角色层重新应用。

---

## 9) 仍存在的遗留/兼容行为

- 面向 YAML 目标的文件的 `ConfigFile` JSON -> YAML 迁移。
- 从 `settings.json` 和 `agent.db` 到 `config.yml` 的设置迁移。
- 字段迁移涵盖重命名/移除的设置和值形状变化,包括 `queueMode`、changelog 设置、`ask.timeout`、扁平 `theme`、`inspect_image.enabled`、任务隔离/急切设置、已移除的编辑和压缩模式、`inlineToolDescriptors`、状态栏段、提供商/搜索设置、memories/hindsight 设置,以及嵌套叶子重命名。当前完整清单请查阅 `Settings.#migrateRawSettings()`。
- 遗留设置名 `skills.enablePiUser` / `skills.enablePiProject` 仍是原生技能来源的活动门控。

如果这些兼容路径在代码中被移除,请立即更新本文档;若干运行时行为今天仍依赖它们。
