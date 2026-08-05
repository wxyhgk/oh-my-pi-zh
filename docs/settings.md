# 设置

`omp` 从内置默认值、持久的全局配置文件、可选的仓库本地配置、一次性 CLI 覆盖层以及内存中的运行时覆盖解析设置。当一个仓库需要与全局默认不同的提供商集合、模型角色、工具策略、记忆后端或 UI 行为时,请使用项目设置——无需改动整台机器的配置。

设置以纯 YAML 映射存储。每个键的类型、默认值和枚举值都来自设置模式(schema)。`omp config` 暴露完整模式;交互式 `/settings` 面板暴露带有 UI 元数据的模式条目。

- 关于模型/提供商凭据、`.env` 文件以及解析 API 密钥的环境变量表,参见[提供商](./providers.md)。
- 关于 `models.yml` 中的自定义模型定义,参见[模型](./models.md)。
- 关于被发现并入 Agent 上下文的指令文件(`AGENTS.md`、`.omp/` 等),参见[上下文文件](./context-files.md)。
- 关于完整的环境变量目录,参见[环境变量](./environment-variables.md)。
- 关于激活特定单轮行为的提示词,参见[魔法关键词](./magic-keywords.md)。

## 设置存放位置

| 作用域 | 路径 | 读取行为 | 写入行为 |
| --- | --- | --- | --- |
| 全局 | `~/.omp/agent/config.yml`(或已有的 `config.yaml`) | 主要的持久设置文件。`config.yml` 是规范的写入目标;已有的 `config.yaml` 会被加载并在原位置更新。 | `/settings`、`omp config set` 和 `omp config reset` 都写入此文件。 |
| 全局(旧版) | `~/.omp/agent/settings.json` | 仅当两个主 YAML 文件名都不存在时,一次性迁移进 `config.yml`。 | 迁移后不再写入;原文件被重命名为 `settings.json.bak`。 |
| 项目 | `<cwd>/.omp/config.yml`(另有 `.omp/settings.json`) | 当进程工作目录含有非空的 `.omp/` 时加载。 | 设置命令不写入任意项目键。当 `modelRoleStorage: project` 时,模型选择器的角色赋值只在此处更新 `modelRoles`;其他键请手工编辑。 |
| 项目(旧版) | `<cwd>/.omp/settings.json` | 仍会被读取;项目的 `config.yml` 在其之上合并。 | 设置命令不写入。 |
| CLI 覆盖 | 任何通过 `--config <file>` 传入的文件 | 在全局与项目设置之后加载,仅对当次进程生效。可重复。 | 从不持久化。 |
| 运行时覆盖 | 仅内存 | 由专用 CLI 标志(`--model`、`--approval-mode` 等)与功能环境变量设置。 | 从不持久化。 |

`PI_CODING_AGENT_DIR` 重定位 `~/.omp/agent` 基础目录。设置它之后,全局 `config.yml`、认证存储(`agent.db`)以及 agent 目录下的其他一切都会随之移动。用 `omp config path` 打印当前生效的 agent 目录。

原生项目设置刻意限定在进程工作目录的 `.omp/` 文件夹内——设置发现**不会**向上遍历祖先目录寻找最近的 `.omp/`。其他发现源(Claude、Codex、Gemini、Cursor、OpenCode)也可以从各自的文件中贡献项目级设置;这些文件对 `omp` 设置命令是只读的,可按提供商 id 关闭(参见[提供商与来源禁用](#provider-and-source-disabling))。

## 配置文件格式

规范的全局文件是 `config.yml` 处的 YAML;`config.yaml` 作为兼容文件名被接受。用于其他文件(例如 `models.yml`)的通用配置加载器接受 `.yml`、`.yaml`、`.json` 和 `.jsonc`:

- 当请求 `.yml`/`.yaml` 路径而旁边只有 `.json` 文件时,会自动迁移为 YAML(幂等,每个进程一次)。
- `.json` 和 `.jsonc` 配置按原样读取,不做迁移。
- 顶层不是映射(mapping)的设置 YAML 文件无效。在可写启动时,`omp` 会将无效的持久设置文件移动为唯一命名的 `.broken-*` 备份,并以原始错误和备份路径退出。带裸数组/标量的 `--config` 覆盖同样是硬错误,但不会被移动。

## 读取与写入设置

在会话内使用交互式 `/settings` 面板,或在 shell 中使用 `omp config` 命令。两者都读取合并后的生效设置。普通持久写入落在**全局**文件中;当 `modelRoleStorage: project` 时,模型选择器的角色变更是例外(参见[写入位置](#where-writes-go))。

```bash
omp config list                 # all settings with current effective values
omp config list --json          # same, machine-readable
omp config get theme.dark       # one value
omp config get theme.dark --json
omp config set compaction.enabled false
omp config set defaultThinkingLevel medium
omp config reset steeringMode   # restore a key to its schema default
omp config path                 # print the active agent directory
```

对于希望在正常启动时看到完整首次运行动画的用户,设置 `startup.showSplash`:

```bash
omp config set startup.showSplash true
```

这仅控制启动画面动画。它不会重新运行设置向导或改变设置状态,`startup.quiet: true` 仍会抑制包括启动画面在内的所有启动装饰。

### 子命令

| 命令 | 效果 |
| --- | --- |
| `omp config list` | 按标签分组打印每个设置及其当前值和类型。`--json` 输出以设置路径为键的对象,含 `{ value, type, description }`。已配置的凭据字段在人类可读输出中掩码为 `********`;JSON 输出中其 `value` 被省略并输出 `redacted: true`。 |
| `omp config get <key>` | 打印单个键的生效值。未知键以非零状态退出。`--json` 输出 `{ key, value, type, description }`。这是明确的单键请求,因此凭据值会原样返回(不掩码)。 |
| `omp config set <key> <value>` | 按键的模式类型解析 `<value>` 并写入全局主 YAML 文件。 |
| `omp config reset <key>` | 将键的模式**默认值**写回全局配置(这会持久化默认值,而不是删除该键)。 |
| `omp config path` | 打印当前生效的 agent 目录(遵循 `PI_CODING_AGENT_DIR`)。 |
| `omp config init-xdg` | 在 Linux 和 macOS 上,在生效的 XDG data、state 与 cache 主目录下创建 `omp` 目录。它不会移动已有文件,也不会设置 XDG 环境变量。其他平台以非零状态退出。 |

`omp config` 不带子命令、带 `--help` 或 `-h` 时列出设置。`list`、`get`、`set` 和 `reset` 都接受 `--json` 标志。

### 值解析

`omp config set` 根据目标键的模式类型解析值字符串。字符串会先去除首尾空白。

| 类型 | 接受的输入 | 说明 |
| --- | --- | --- |
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | 不区分大小写。其他任何值都会被拒绝。 |
| number | 任何有限的 JavaScript 数字 | `Infinity`/`NaN` 会被拒绝。 |
| enum | 键允许的值之一 | 必须完全匹配;错误信息会列出有效值。 |
| array | 一个 JSON 数组 | 例如 `'["anthropic","openai"]'`。必须能解析且是数组。 |
| record | 一个 JSON 对象 | 例如 `'{"bash":"prompt"}'`。必须能解析且是非数组对象。 |
| string | 按给定值存储(去除首尾空白) | 多词值用空格连接。 |

键必须与真实的模式路径完全匹配。没有简写——请设置 `theme.dark`,而不是 `theme`。

### 写入位置

`omp config set`、`omp config reset`、`/settings` 以及普通运行时设置变更都会写入当前生效 agent 目录下的全局主 YAML 文件。它们不会向 `<cwd>/.omp/config.yml` 写入任意键。唯一受支持的项目写入路径是 `modelRoleStorage` 为 `project` 时的模型选择器角色赋值;它只在 `<cwd>/.omp/config.yml` 中更新该角色,缺失的项目角色继续回退到全局角色。要创建其他任何项目本地覆盖,请直接编辑项目文件(参见[项目本地配置](#project-local-config))。保存会防抖并在锁内重新读取文件,因此会话打开期间的外部修改会被保留。

## 优先级

从低到高,设置的生效值按如下方式构建:

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides
```

从高到低:

1. **运行时覆盖**——专用 CLI 标志与功能环境变量,在当前进程的内存中生效:`--model`、`--smol`、`--slow`、`--plan`、`--approval-mode`、`--auto-approve`/`--yolo`、`--hide-thinking`、`--advisor`、`--no-pty`、`--api-key` 以及协议模式默认值。从不持久化。
2. **CLI 配置覆盖**——每个 `--config <file>`;后面的覆盖文件覆盖前面的。
3. **项目设置**——`<cwd>/.omp/settings.json`,然后是 `<cwd>/.omp/config.yml`(以及项目级其他发现源的贡献)。
4. **全局设置**——`~/.omp/agent/config.yml`。
5. **内置默认值**——来自设置模式。

在每一层都未设置的键,读取时解析为其模式默认值。

### 环境变量覆盖

环境变量**不是**单一的设置层。每个环境变量由拥有该值的功能读取,通常作为按机器的覆盖或回退,并且从不写回 `config.yml`。直接映射到某个设置的变量:

| 环境变量 | 覆盖的设置 | 说明 |
| --- | --- | --- |
| `PI_SMOL_MODEL` | `modelRoles.smol` | 也通过 `--smol` 暴露。 |
| `PI_SLOW_MODEL` | `modelRoles.slow` | 也通过 `--slow` 暴露。 |
| `PI_PLAN_MODEL` | `modelRoles.plan` | 也通过 `--plan` 暴露。 |
| `PI_NO_PTY=1` | (禁用 PTY bash) | 对当前进程等效于 `--no-pty`。 |
| `PI_PY` | `eval.py` | `PI_PY=0` 禁用 Python eval 后端。 |
| `PI_JS` | `eval.js` | `PI_JS=0` 禁用 JavaScript eval 后端。 |
| `PI_TINY_DEVICE` | `providers.tinyModelDevice` | 本地小模型的 ONNX 执行提供程序。 |
| `PI_TINY_DTYPE` | `providers.tinyModelDtype` | 本地小模型的 ONNX 精度。 |
| `OMP_AUTH_BROKER_URL` | `auth.broker.url` | 环境变量值优先于配置。 |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token` | 环境变量值优先于配置。 |
| `PI_CODING_AGENT_DIR` | (重定位 agent 目录) | 移动 `config.yml`、`agent.db` 以及整个 agent 基础目录。 |
| `PI_CONFIG_FILES` | CLI 配置覆盖 | 平台路径列表(`:` Unix,`;` Windows);文件按顺序在 `--config` 覆盖之前加载。 |

提供商 API 密钥单独解析(存储的认证、OAuth、`models.yml`、环境与 `.env` 文件);参见[提供商](./providers.md)和完整的[环境变量](./environment-variables.md)参考。

## 合并规则

各层通过深度合并组合:

- **对象深度合并**——仅在较低层存在的键会被保留;在较高层存在的键覆盖。
- **标量与数组整体替换**——由更高优先级的层整体替换。高层数组不会追加到低层数组。

对带点的设置路径使用嵌套 YAML 映射:

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
```

### Bash 命令批准规则

`tools.approval` 按工具名设置默认策略。对于 bash,可以用 `bash.patterns` 添加有序的命令规则;第一条匹配的规则生效。规则支持字面文本加 `*` 通配符。

```yaml
tools:
  approvalMode: write
  approval:
    bash: allow

bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "rm -rf *"
      approval: deny
    - match: "*"
      approval: allow
```

有效的规则批准值为 `allow`、`prompt` 和 `deny`。关键 bash 命令仍要求确认,除非匹配的规则明确拒绝它们;像 `match: "*"` 这样的宽泛允许规则不会绕过关键命令保护。

匹配是不对称的,规则的含义与表面一致:`deny` 与 `prompt` 规则在 glob 匹配整个命令**或**复合命令行(按 `&&`、`||`、`;`、`|`、单个 `&`、子 shell 与换行分割)的**任意单个段**时触发,因此 `match: "rm -rf *"` 仍然拒绝 `cd /tmp && rm -rf build` 和 `sleep 1 & rm -rf build`。`allow` 规则必须匹配**整个**命令,并且从不适用于复合命令行,因此像 `match: "git *"` 这样的窄允许规则不能为 `git status && rm -rf /` 背书。

### Bash 拦截器规则

`bashInterceptor` 与 `bash.patterns` 相互独立:它把 Bash 命令重定向到专用工具,而不是定义命令是否可以执行。显式启用它,并配置正则表达式模式,配以替换工具和面向模型的提示消息:

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead."
```

命名的替换工具必须在当前会话中可用,否则拦截器不会拦截 Bash 调用。关于权限策略与专用工具路由的详细比较,包括复合命令行为与顺序,参见[Bash 工具文档](tools/bash.md#command-policy-and-dedicated-tool-routing)。

### 示例:全局与项目

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - google

# <repo>/.omp/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

`<repo>` 内的生效设置:

```yaml
tools:
  approvalMode: write # kept from global (object deep-merge)
  approval:
    bash: allow # overridden by project
    read: allow # kept from global
disabledProviders:
  - groq # project array REPLACES the global array
```

数组替换是最常见的意外:项目的 `disabledProviders` 不会扩展全局列表——它成为该项目的完整列表。`enabledModels`、`cycleOrder`、`extensions` 以及所有其他数组类型的设置同样如此。

## 项目本地配置

当仓库需要自己的设置时,创建 `<repo>/.omp/config.yml`:

```yaml
# <repo>/.omp/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: write
  approval:
    bash: prompt

compaction:
  strategy: snapcompact
  thresholdPercent: 80

theme:
  dark: titanium
```

除非仓库策略允许,否则不要把机密放进已提交的项目配置。凭据优先使用环境变量、已存储的认证、认证代理或不被跟踪的 `--config` 覆盖。

### 一次性覆盖

对不应持久化的临时层使用 `--config`:

```bash
omp --config ./local/ci-settings.yml "check this failure"
omp --config ./base.yml --config ./experiment.yml "try this model"
```

`--config` 被默认启动命令、`acp` 和 `models` 接受。

包装脚本也可以把 `PI_CONFIG_FILES` 设置为平台分隔的路径列表(`:` Unix,`;` Windows)。环境覆盖在显式 `--config` 覆盖之前按列出顺序加载。

覆盖路径相对于进程工作目录解析(并展开 `~`)。每个覆盖必须能解析为 YAML 映射;文件缺失、YAML 无效或顶层为数组/标量都是硬错误——它**不会**静默回退到更低优先级的设置。

## 路径作用域数组

两个数组设置——`enabledModels` 与 `disabledProviders`——除裸字符串外还接受路径作用域条目,因此单个全局配置可以按目录表现不同:

```yaml
enabledModels:
  - claude-sonnet-4-5 # applies everywhere
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama # applies everywhere
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

裸字符串条目适用于所有位置。当当前工作目录**就是**配置的路径或在**其之下**时,作用域条目生效。`~` 展开为你的主目录,相对路径在匹配前解析。

接受的 **path** 键(可任意组合):`path`、`paths`、`pathPrefix`、`pathPrefixes`。

接受的 **value** 键:

- `models`(用于 `enabledModels`)或 `providers`(用于 `disabledProviders`)
- `values` 或 `items`(任一设置皆可)

只保留字符串值;格式错误的作用域条目会被忽略。路径作用域在**层合并之后**解析,因此它读取最终的生效数组。

## 提供商与来源禁用

`disabledProviders` 是单个共享的 id 命名空间,在任何凭据检查之前门控两个不同的子系统:

| 条目类型 | 示例 id | 效果 |
| --- | --- | --- |
| 模型提供商 | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` | 从模型选择中移除这些后端,即使凭据可用。参见[提供商](./providers.md)。 |
| 发现源 | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | 阻止该来源贡献上下文文件、MCP 服务器、命令、技能、钩子、工具、提示词或设置。参见[上下文文件](./context-files.md)。 |

大多数提供商控制场景列出的是模型提供商 id。禁用 `claude` 发现源与禁用 `anthropic` 模型提供商不同——前者停止 Claude 格式配置的发现,后者停止 Anthropic 模型后端。

因为数组是替换而非追加,设置 `disabledProviders` 的项目必须列出完整的期望集合:

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.omp/config.yml — inside this repo ONLY groq is disabled
disabledProviders:
  - groq
```

默认是空数组(不禁用任何内容)。两个子系统的提供商 id 与顺序参见[提供商](./providers.md)和[上下文文件](./context-files.md)。

## 设置目录

下面每个键都定义在设置模式中;`omp config list` 显示含当前值的完整集合。默认值与枚举值取自模式。接受环境变量或标志覆盖的设置会注明;这些覆盖是进程局部的,不会持久化。

### 模型

`modelRoles`、`modelTags` 与 `cycleOrder` 协同定义你可以在其间切换的模型。角色值可携带思考后缀(`:minimal`、`:low`、`:medium`、`:high`、`:xhigh`、`:max`)。

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: google/gemini-3.1-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

cycleOrder:
  - smol
  - default
  - slow

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `modelRoles` | record | `{}` | 角色名 -> 模型 id 的映射。内置角色:`default`、`smol`、`slow`、`vision`、`plan`、`designer`、`commit`、`tiny`、`task`、`advisor`。`tiny` 角色为轻量后台任务(标题、记忆、自动思考、意外停止)覆盖在线模型,否则使用 `@smol`。逐角色的环境变量/标志仅存在于 `--model`/`--smol`/`--slow`/`--plan`;用 `modelRoles.advisor` 配置顾问。 |
| `modelRoleStorage` | enum | `global` | `global` 将模型选择器的角色赋值保存在当前生效的全局/配置文件;`project` 只将这些角色赋值保存在 `<cwd>/.omp/config.yml`。缺失的项目角色回退到全局角色。 |
| `modelTags` | record | `{}` | 自定义角色/标签元数据;可以引入额外角色。 |
| `modelProviderOrder` | array | `[]` | 模型 id 有歧义时的首选提供商顺序。 |
| `cycleOrder` | array | `["smol","default","slow"]` | 模型切换器循环切换的角色。 |
| `enabledModels` | array | `[]` | 模型允许列表;支持[路径作用域条目](#path-scoped-arrays)。空表示所有可用模型。 |
| `disabledProviders` | array | `[]` | 禁用的模型/发现提供商;支持路径作用域条目。参见[上文](#provider-and-source-disabling)。 |
| `includeModelInPrompt` | boolean | `true` | 在系统提示词中包含当前激活的模型名。 |

`models.yml` 模式与自定义提供商定义参见[模型](./models.md)。

### 顾问

顾问(advisor)是审查每个已完成轮次、可向主会话注入建议的第二个模型。用 `modelRoles.advisor` 指定模型,然后通过 `advisor.enabled`、`/advisor on` 或带 `--advisor` 标志启动来启用它。

运行时行为、`WATCHDOG.md` 发现以及有界的追赶语义参见[Advisor 与 WATCHDOG](./advisor-watchdog.md)。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `advisor.enabled` | boolean | `false` | 当 `modelRoles.advisor` 解析到可用模型时,启用顾问运行时。 |
| `advisor.subagents` | boolean | `false` | 也为生成的 task/eval 子代理启用顾问运行时。 |
| `advisor.syncBacklog` | enum | `off` | 有界的顾问追赶延迟:`off`、`1`、`3` 或 `5`。仅当顾问积压达到或超过阈值时,主代理最多等待 30 秒。 |
| `advisor.immuneTurns` | number | `3` | 在 `concern`/`blocker` 中断之后,接下来的这么多已完成主轮次中,后续的 concern/blocker 以不打断的旁注形式传递。 |

### 思考

```yaml
defaultThinkingLevel: high
hideThinkingBlock: false
thinkingBudgets:
  minimal: 1024
  low: 2048
  medium: 8192
  high: 16384
  xhigh: 32768
  max: 32768
```

| 键 | 类型 | 默认 | 值 |
| --- | --- | --- | --- |
| `defaultThinkingLevel` | enum | `high` | `minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`auto`。每次运行可用 `--thinking` 覆盖。 |
| `hideThinkingBlock` | boolean | `false` | 在输出中隐藏思考块。`--hide-thinking` 为当次运行设置它(仅影响显示)。 |
| `thinkingBudgets.minimal` | number | `1024` | `minimal` 级别的 token 预算。 |
| `thinkingBudgets.low` | number | `2048` | `low` 的 token 预算。 |
| `thinkingBudgets.medium` | number | `8192` | `medium` 的 token 预算。 |
| `thinkingBudgets.high` | number | `16384` | `high` 的 token 预算。 |
| `thinkingBudgets.xhigh` | number | `32768` | `xhigh` 的 token 预算。 |
| `thinkingBudgets.max` | number | `32768` | `max` 的 token 预算。 |
| `providers.autoThinkingMaxEffort` | enum | `xhigh` | 最高力度,`defaultThinkingLevel: auto` 可能解析到它。`xhigh` 让分类器保持在最高档之下一个档位,因此只有 `ultrathink` 能达到 `max`;`max` 允许分类器在暴露该档的模型上计费最高档。本地设备端分类器无论如何都保持在 `xhigh` 上限。这决定了 `auto` 会_解析_到什么:阶梯上没有任何低于上限档位的模型根本不会获得自动级别;同时设置了 `thinking.requiresEffort` 的模型仍会从传输层收到其最低支持的力度——在 `["max"]` 阶梯上就是 `max`,因为该模型不接受其他值。 |

### 采样

值为 `-1` 表示“使用提供商/模型默认”——`omp` 不发送该参数。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `temperature` | number | `-1` | 采样温度。 |
| `topP` | number | `-1` | 核采样。 |
| `topK` | number | `-1` | Top-K 采样。 |
| `minP` | number | `-1` | 最小概率截断。 |
| `presencePenalty` | number | `-1` | 存在惩罚。 |
| `repetitionPenalty` | number | `-1` | 重复惩罚。 |
| `textVerbosity` | enum | `medium` | `low`、`medium`、`high`。由 OpenAI Responses 与 Codex 传输层作为响应详细度发送。 |
| `tier.openai` | enum | `none` | `none`、`auto`、`default`、`flex`、`scale`、`priority`。作为 `service_tier` 发送给 OpenAI / OpenAI-Codex 以及 OpenAI 家族的 OpenRouter 模型。用 `--service-tier <value>` 启动可为单次会话指定 OpenAI 覆盖;该标志不会持久化(`none` 省略 `service_tier`)。 |
| `tier.anthropic` | enum | `none` | `none`、`priority`。`priority` 在受支持的直连 Claude 模型上实现快速模式(在 Bedrock/Vertex 及通过 OpenRouter 时忽略)。 |
| `tier.google` | enum | `none` | `none`、`flex`、`priority`。Gemini API 在请求体中发送;Vertex 通过请求头发送 `priority`(`flex` 在 Vertex 上是空操作)。 |
| `tier.subagent` | enum | `inherit` | `inherit`、`none`、`auto`、`default`、`flex`、`scale`、`priority`。应用于所生成模型的家族;`inherit` 跟随主 Agent。 |
| `tier.advisor` | enum | `none` | `inherit`、`none`、`auto`、`default`、`flex`、`scale`、`priority`。应用于顾问模型的家族。 |
| `personality` | enum | `default` | `default`、`friendly`、`pragmatic`、`none`。 |

### 重试与回退

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    # Any role without an explicit chain inherits the "default" chain.
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chains override the default (roles from `modelRoles`,
    # including custom roles). Selectors accept an optional thinking
    # suffix, e.g. openai/gpt-5.5:low.
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    # Model-selector keys (any key containing "/") attach the chain to the
    # model itself: it applies whenever that model is active, no matter
    # which role it is assigned to, and survives role reassignment.
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    # A `provider/*` KEY covers every model of a provider — current or
    # future. A `provider/*` ENTRY keeps the failing model's id and swaps
    # the provider: google-antigravity/x -> google/x -> google-vertex/x.
    # Ids missing on the target provider are skipped (near-miss ids resolve
    # fuzzily); exact model keys override the wildcard for a specific model.
    google-antigravity/*:
      - google/*
      - google-vertex/*

providers:
  anthropic:
    serverSideFallback: false
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `retry.enabled` | boolean | `true` | 重试瞬时提供商错误。 |
| `retry.maxRetries` | number | `10` | 每个请求的最大重试次数。 |
| `retry.baseDelayMs` | number | `500` | 初始退避。 |
| `retry.maxDelayMs` | number | `300000` | 退避上限(5 分钟)。 |
| `retry.modelFallback` | boolean | `true` | 当一个模型不可用时,回退到另一个模型。 |
| `retry.fallbackChains` | record | `{}` | 将角色、模型选择器或 `provider/*` 通配符映射到有序的回退选择器。含 `/` 的键面向模型,优先于角色:`provider/model-id` 匹配该确切模型,`provider/*` 匹配该提供商的每个模型。`provider/*` _条目_保留失败模型的 id 并更换提供商。`default` 链覆盖每个没有自己链的已分配角色。未知模型/提供商或格式错误的链会在启动时报告为配置警告。 |
| `retry.fallbackRevertPolicy` | enum | `cooldown-expiry` | `cooldown-expiry` 在抑制窗口结束后回到主模型;`never` 保持使用回退模型,直到手动切换。 |
| `providers.anthropic.serverSideFallback` | boolean | `false` | 选择启用 Anthropic 的 `server-side-fallback-2026-06-01` 测试版。只有使用 `anthropic-messages` API、针对 Claude Fable 或 Mythos 模型的直连 `anthropic` 提供商请求才符合条件。在 Anthropic 安全分类器拦截时,提供商可以在服务端用 `claude-opus-4-8` 重试;其他所有提供商、API 与模型不受影响。 |

当活动模型持续失败(429、配额墙、提供商故障)且 `retry.modelFallback` 开启时,会话按特异性选择拥有该失败模型的链:先是确切的 `provider/model-id` 键,然后是 `provider/*` 通配符,再是当前角色的链,最后是 `default`。它会跳过选择器仍在冷却中的模型,并在本轮的剩余部分切换。当子代理的 agent 定义列出多个模型模式时,它们获得各自按生成区分的链——第一个可解析的模式是主模型,其余成为其回退;`fallbackChains` 中没有 `agent:<name>` 键。

### 工具与批准

```yaml
tools:
  format: auto
  approvalMode: yolo # default
  approval:
    bash: prompt
    edit: allow
  maxTimeout: 0
  intentTracing: true
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tools.format` | enum | `auto` | 工具传输格式:`auto`、`native`、`glm`、`hermes`、`kimi`、`xml`、`anthropic`、`deepseek`、`harmony`、`qwen3`、`gemini`、`gemma` 或 `minimax`。`native` 始终使用提供商原生的工具调用。`auto` 也使用原生调用,除非所选模型显式声明 `supportsTools: false`;此时它会选择该模型家族拥有的方言,在没有已知的特定家族方言时回退到 GLM。其他值强制使用该拥有的带内方言。`xml` 是[通用 XML 格式](./toolconv/xml.md);`minimax` 是 [MiniMax 格式](./toolconv/minimax.md)。在会话启动时生效。参见 [GLM](./toolconv/glm-4.5.md)、[Qwen3/Hermes](./toolconv/qwen3.md)、[Kimi](./toolconv/kimi-k2.md)、[Anthropic](./toolconv/anthropic.md)、[DeepSeek](./toolconv/deepseek.md)、[Harmony](./toolconv/harmony.md)、[Gemini](./toolconv/gemini.md) 与 [Gemma](./toolconv/gemma.md)。 |
| `tools.approvalMode` | enum | `yolo` | `always-ask`(自动批准只读)、`write`(自动批准读取 + 工作区写入)、`yolo`(自动批准所有层级)。`--approval-mode` 与 `--auto-approve`/`--yolo` 按次运行覆盖。 |
| `tools.approval` | record | `{}` | 按工具名键控的逐工具策略;每个值为 `allow`、`deny` 或 `prompt`。例如 `omp config set tools.approval '{"bash":"prompt"}'`。 |
| `tools.maxTimeout` | number | `0` | 工具最大运行时长(秒);`0` = 无上限。 |
| `tools.intentTracing` | boolean | `true` | 记录每次调用的意图字符串。 |
| `tools.outputMaxColumns` | number | `768` | 流式输出的每行字节上限;`0` 禁用。 |
| `tools.artifactSpillThreshold` | number | `50` | 工具输出超过该 KB 数时溢出到产物。 |
| `tools.artifactHeadBytes` | number | `20` | 溢出时内联保留的开头 KB 数;`0` = 仅保留末尾。 |
| `tools.artifactTailBytes` | number | `20` | 溢出时内联保留的末尾 KB 数。 |
| `tools.artifactTailLines` | number | `500` | 溢出时内联保留的最大末尾行数。 |

单独的内置工具由各自的键开关,例如 `bash.enabled`、`launch.enabled`、`eval.py`、`eval.js`、`glob.enabled`、`grep.enabled`、`fetch.enabled`、`browser.enabled`、`computer.enabled`、`astEdit.enabled`、`astGrep.enabled` 与 `web_search.enabled`。`inspect_image` 工具由三态 `inspect_image.mode`(`auto`|`on`|`off`,默认 `auto`)控制:`auto` 仅在活动模型缺乏原生图像输入时暴露它,`/vision` 斜杠命令按会话覆盖该模式。

### 窗口作用域的 computer 工具

默认禁用的 `computer` 必备工具通过原生 OS API 捕获并控制一个真实的主机窗口。数字目标可在不聚焦应用、不移动真实指针的情况下隔离应用;合成的 `desktop` 目标保留之前所选显示的组合与全局输入行为。它与 `browser` 相互独立——后者管理 Chromium/CDP 标签页和结构化页面自动化。

```yaml
computer:
  enabled: true
  display: all
  maxWidth: 3840
  maxHeight: 2400
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `computer.enabled` | boolean | `false` | 启用窗口感知的 computer 功能工具。每个结果都列出当前的数字窗口 id 加 `desktop`;`/computer` 斜杠命令仅对当前会话切换该工具。 |
| `computer.display` | string | `all` | 仅控制 `desktop` 目标:合成所有活动显示,或使用一个数字显示 ID。 |
| `computer.maxWidth` | number | `3840` | 最大合成截图宽度(像素)。无法保留原始细节的图像传输,包括 GitHub Copilot Responses 与 xAI OAuth,将有效宽度上限设为 `1280`;Claude 家族模型使用相同的上限作为兼容性回退。 |
| `computer.maxHeight` | number | `2400` | 最大合成截图高度(像素)。那些坐标安全传输将有效高度上限设为 `896`;其他模型保留配置的限制。 |

桌面控制器创建时会捕获 computer 设置。跨越坐标安全尺寸边界的模型切换会重建控制器并重新捕获这些设置;仅更改配置不会,因此在设置变更后请启动新会话。每次调用必须指名 `desktop` 或先前窗口列表中的数字 id。切换目标会使先前的坐标框架失效,因此请在指针输入前捕获新目标。启用输入前,请配置 `tools.approvalMode` 或 `tools.approval.computer` 并授予平台权限。参见[窗口作用域的 computer 工具](computer-use.md)。

### Shell、eval 与 LSP

```yaml
bash:
  enabled: true
  autoBackground:
    enabled: false
    thresholdMs: 60000

eval:
  py: true
  js: true

python:
  kernelMode: session # session, per-call
  interpreter: ""

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
  diagnosticsOnEdit: false
  formatOnWrite: false
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `bash.enabled` | boolean | `true` | 启用 bash 工具。 |
| `launch.enabled` | boolean | `true` | 为共享的长期运行项目进程启用 launch 工具。 |
| `bash.autoBackground.enabled` | boolean | `false` | 自动后台化长时间运行的命令。 |
| `bash.autoBackground.thresholdMs` | number | `60000` | 自动后台化前的阈值。 |
| `eval.py` | boolean | `true` | Python eval 后端。`PI_PY=0` 对当次进程禁用。 |
| `eval.js` | boolean | `true` | JavaScript eval 后端。`PI_JS=0` 对当次进程禁用。 |
| `python.kernelMode` | enum | `session` | `session`(持久内核)或 `per-call`。 |
| `python.interpreter` | string | `""` | Python 解释器路径;空 = 自动检测。 |
| `lsp.enabled` | boolean | `true` | 语言服务器集成。`--no-lsp` 对当次运行禁用。 |
| `lsp.lazy` | boolean | `true` | 按需启动服务器。 |
| `lsp.shared` | boolean | `true` | 通过守护进程代理在本地 `omp` 进程之间为每个项目共享一个语言服务器;代理不可用时回退到私有服务器。 |
| `lsp.diagnosticsOnWrite` | boolean | `true` | 写入后运行诊断。 |
| `lsp.diagnosticsOnEdit` | boolean | `false` | 编辑后运行诊断。 |
| `lsp.formatOnWrite` | boolean | `false` | 写入时格式化文件。 |
| `lsp.diagnosticsDeduplicate` | boolean | `true` | 折叠重复的诊断。 |
| `shellPath` | string | _(未设置)_ | 覆盖 bash 使用的 shell 二进制。 |

### 文件:编辑与读取

```yaml
edit:
  mode: hashline # apply_patch, hashline, patch, replace
  fuzzyMatch: true
  fuzzyThreshold: 0.95
  blockAutoGenerated: true

read:
  defaultLimit: 300
  toolResultPreview: false
  summarize:
    enabled: true
    prose: false
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `edit.mode` | enum | `hashline` | `apply_patch`、`hashline`、`patch`、`replace`。 |
| `edit.fuzzyMatch` | boolean | `true` | 允许模糊锚点匹配。 |
| `edit.fuzzyThreshold` | number | `0.95` | 模糊匹配的相似度阈值。 |
| `edit.blockAutoGenerated` | boolean | `true` | 拒绝编辑生成/类似锁文件的文件。 |
| `edit.streamingAbort` | boolean | `false` | 流式编辑不匹配时中止。 |
| `read.defaultLimit` | number | `300` | 无选择器时 `read` 的默认行数。 |
| `read.summarize.enabled` | boolean | `true` | 代码读取的结构化摘要。 |
| `read.summarize.prose` | boolean | `false` | 也对散文文件做摘要。 |
| `read.toolResultPreview` | boolean | `false` | 工具结果的内联预览。 |
| `readLineNumbers` | boolean | `false` | 显示纯行号。 |

### 上下文、压缩与记忆

```yaml
contextPromotion:
  enabled: false

compaction:
  enabled: true
  strategy: snapcompact # context-full, handoff, shake, snapcompact, off
  midTurnEnabled: true # check thresholds between tool-loop provider requests
  thresholdPercent: -1 # -1 = default reserve-based behavior
  thresholdTokens: -1 # fixed token limit when > 0
  remoteEnabled: true

memory:
  backend: off # off, local, hindsight, mnemopi
```

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `contextPromotion.enabled` | boolean | `false` | 上下文溢出时,提升到活动模型的显式 `contextPromotionTarget`。 |
| `compaction.enabled` | boolean | `true` | 自动对话压缩。 |
| `compaction.midTurnEnabled` | boolean | `true` | 在下一次提供商请求前,于安全的中轮工具循环边界检查阈值。 |
| `compaction.strategy` | enum | `snapcompact` | `context-full`、`handoff`、`shake`、`snapcompact`、`off`。 |
| `compaction.thresholdPercent` | number | `-1` | 上下文百分比触发器;`-1` = 基于保留量的默认行为。 |
| `compaction.thresholdTokens` | number | `-1` | `> 0` 时的固定 token 触发器。 |
| `compaction.reserveTokens` | number | _(未设置)_ | 绝对保留下限。未设置时,生效保留量为 `16384` 与上下文窗口 15% 中的较大者;若该默认值不会给小窗口留下实用的预算,则回退到 15% 保留。 |
| `compaction.keepRecentTokens` | number | `20000` | 始终保留最近的 token。 |
| `compaction.remoteEnabled` | boolean | `true` | 允许远程压缩服务。 |
| `compaction.autoContinue` | boolean | `true` | 压缩后自动继续。 |
| `memory.backend` | enum | `off` | `off`、`local`、`hindsight`、`mnemopi`。每个后端有自己的 `hindsight.*` / `mnemopi.*` / `memories.*` 调优键。 |
| `autolearn.enabled` | boolean | `false` | 实验性:Agent 停止后,提示它把经验捕获到记忆,并在 `~/.omp/agent/managed-skills` 下创建/增强隔离的托管技能。启用 `manage_skill` 工具(记忆后端激活时还有 `learn`)。 |
| `autolearn.autoContinue` | boolean | `false` | 当 `autolearn.enabled` 时,停止时自动运行一次捕获轮次(消耗额外 token)。关闭 = 被动的提醒搭你的下一轮便车。 |
| `autolearn.minToolCalls` | number | `5` | 仅在使用了至少这么多工具的一轮之后提示。 |

`compaction` 还有额外的调优键(空闲压缩、替换/丢弃启发式),见 `omp config list`。完整策略参考参见[压缩](./compaction.md)。

### 外观与终端

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto # off, auto, always
```

| 键 | 类型 | 默认 | 值 |
| --- | --- | --- | --- |
| `theme.dark` | string | `titanium` | 深色终端背景使用的主题。 |
| `theme.light` | string | `light` | 浅色终端背景使用的主题。 |
| `symbolPreset` | enum | `unicode` | `unicode`、`nerd`、`ascii`。 |
| `colorBlindMode` | boolean | `false` | 差异新增用蓝色代替绿色。 |
| `showHardwareCursor` | boolean | `true` | 显示终端硬件光标。 |
| `statusLine.preset` | enum | `default` | `default`、`minimal`、`compact`、`full`、`nerd`、`ascii`、`custom`。 |
| `statusLine.separator` | enum | `powerline-thin` | `powerline`、`powerline-thin`、`slash`、`pipe`、`block`、`none`、`ascii`。 |
| `statusLine.sessionAccent` | boolean | `true` | 用会话颜色给编辑器边框着色。 |
| `statusLine.transparent` | boolean | `false` | 状态行使用终端背景。 |
| `statusLine.showHookStatus` | boolean | `true` | 显示钩子状态消息。 |
| `terminal.showImages` | boolean | `true` | 内联渲染图像(当终端支持时)。 |
| `images.autoResize` | boolean | `true` | 为模型兼容性调整大图尺寸。 |
| `images.blockImages` | boolean | `false` | 从不向提供商发送图像。 |
| `tui.hyperlinks` | enum | `auto` | `off`、`auto`、`always`。 |

对于自定义状态行,设置 `statusLine.preset: custom` 并配置 `statusLine.leftSegments`、`statusLine.rightSegments` 与 `statusLine.segmentOptions`。

### 交互

| 键 | 类型 | 默认 | 值 |
| --- | --- | --- | --- |
| `steeringMode` | enum | `one-at-a-time` | `all`、`one-at-a-time`。排队的转向消息如何投递。 |
| `followUpMode` | enum | `one-at-a-time` | `all`、`one-at-a-time`。 |
| `interruptMode` | enum | `immediate` | `immediate`、`wait`。 |
| `doubleEscapeAction` | enum | `tree` | `branch`、`tree`、`none`。 |
| `autoResume` | boolean | `false` | 自动恢复 cwd 中最近的会话。 |
| `ask.timeout` | number | `0` | `ask` 提示超时前的秒数;`0` = 无超时。(旧版毫秒值会迁移为秒。) |
| `ask.notify` | enum | `on` | `on`、`off`。 |

### 提供商与服务

```yaml
providers:
  webSearchOrder: [perplexity, exa, gemini]
  imageOrder: [openai, xai]
  fetch: auto
  webSearchGeminiModel: gemini-2.5-flash
  tinyModel: online
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openrouterVariant: default
  kimiApiFormat: auto
  maxInFlightRequests:
    anthropic: 2

provider:
  appendOnlyContext: auto # auto, on, off

exa:
  enabled: true
  enableSearch: true
  enableResearcher: false
  enableWebsets: false

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| 键 | 类型 | 默认 | 值 / 说明 |
| --- | --- | --- | --- |
| `providers.webSearchOrder` | array | `[]` | `web_search` 的提供商 id 优先级顺序(`perplexity`、`gemini`、`anthropic`、`codex`、`zai`、`exa`、`jina`、`kagi`、`tavily`、`brave`、`kimi`、`parallel`、`synthetic`、`searxng` 等)。重复与未知 id 被忽略;未列出的提供商随后保留其内置相对顺序。空 = 内置顺序。取代已移除的 `providers.webSearch` 枚举(旧值会迁移到本列表头部)。 |
| `providers.webSearchTimeoutSeconds` | number | `60` | 提供给每个 `web_search` 提供商传输层的硬超时(秒),之后自动链推进到下一个回退。对较慢的模型后端提供商使用更大的值;超过 `300` 的值上限为五分钟。这不是整条链的截止时间,提供商特定的上游或聚合限制仍可能更短。 |
| `providers.webSearchGeminiModel` | string | _(未设置)_ | 当 `web_search` 使用 Gemini 时,Google 搜索 grounding 使用的 Gemini 模型 ID;默认为 `gemini-2.5-flash`,可被 `GEMINI_SEARCH_MODEL` 覆盖。 |
| `providers.imageOrder` | array | `[]` | 图像生成提供商 id 的优先级顺序(`openai`、`openai-codex`、`antigravity`、`xai`、`gemini`、`openrouter`)。未列出的提供商跟随活动会话提供商与内置顺序。取代已移除的 `providers.image` 枚举(旧值会迁移到本列表头部)。 |
| `providers.fetch` | enum | `auto` | `auto`、`native`、`trafilatura`、`lynx`、`parallel`、`jina`。 |
| `providers.tinyModel` | enum | `online` | `online` 或本地模型(`lfm2-350m`、`qwen3-0.6b`、`gemma-270m`、`qwen2.5-0.5b`、`lfm2-700m`)。 |
| `providers.tinyModelDevice` | enum | `default` | 本地小模型的 ONNX 执行提供程序。可被 `PI_TINY_DEVICE` 覆盖。 |
| `providers.maxInFlightRequests` | record | `{}` | 每个提供商的 LLM HTTP 请求正并发上限,在使用同一配置根的本地 `omp` 进程之间共享。未列出的提供商不受限。`omp config set` 拒绝非正数或非数值。 |
| `providers.tinyModelDtype` | enum | `default` | 本地小模型的 ONNX 精度。可被 `PI_TINY_DTYPE` 覆盖。 |
| `providers.openaiWebsockets` | enum | `auto` | `auto`、`off`、`on`。 |
| `providers.openrouterVariant` | enum | `default` | `default`、`nitro`、`floor`、`online`、`exacto`。 |
| `providers.kimiApiFormat` | enum | `auto` | `auto`、`openai`、`anthropic`。`auto` 跟随实时模型元数据。 |
| `provider.appendOnlyContext` | enum | `auto` | `auto`、`on`、`off`。 |
| `exa.enabled` | boolean | `true` | 启用 Exa 集成。 |
| `exa.enableSearch` | boolean | `true` | Exa 搜索。 |
| `exa.enableResearcher` | boolean | `false` | Exa 研究员。 |
| `exa.enableWebsets` | boolean | `false` | Exa websets。 |
| `searxng.endpoint` | string | _(未设置)_ | SearXNG 实例 URL。 |
| `searxng.token` | string | _(未设置)_ | SearXNG token;另有 `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`。 |
| `auth.broker.url` | string | _(未设置)_ | 认证代理 URL。可被 `OMP_AUTH_BROKER_URL` 覆盖。 |
| `auth.broker.token` | string | _(未设置)_ | 认证代理 token。可被 `OMP_AUTH_BROKER_TOKEN` 覆盖。 |
| `secrets.enabled` | boolean | `false` | 在提供商请求前启用配置的机密混淆与内置的凭据形状 token 脱敏。参见[机密混淆](./secrets.md)。 |

提供商凭据与自定义模型定义单独配置——参见[提供商](./providers.md)与[模型](./models.md)。

### 其他分组

`omp config list` 暴露更多分组设置,包括:`task.*`(子代理并发、隔离、模型覆盖)、`skills.*` 与 `commands.*`(发现开关)、`mcp.*`、`github.*`、`async.*`、`goal.*`、`loop.*`、`todo.*`、`magicKeywords.*`、`ttsr.*`(时间旅行流规则)、`display.*`、`startup.*`、`share.*`、`collab.*`、`stt.*`/`tts.*`、`memories.*`/`hindsight.*`/`mnemopi.*`(记忆后端)以及 `bashInterceptor.*`。每个都遵循上面所示的相同类型/默认规则。

## 旧版迁移

`omp` 自动迁移旧版配置形状。这些都不需要操作;列出它们是为了让你知道 `config.yml` 中可能出现哪些变化。

### 启动时迁移到 `config.yml`

当 `~/.omp/agent/config.yml` 与兼容的 `config.yaml` 都不存在时,启动会从旧版来源一次性构建规范的 `config.yml`,然后写入结果:

1. `~/.omp/agent/settings.json`(成功解析后重命名为 `settings.json.bak`)。
2. `agent.db` 中持久化的设置。

任一主 YAML 文件存在后,这些旧版来源不再被读取。通用配置加载器还会在其他配置文件仅有 `.json` 形式时执行 `.json` -> `.yml` 迁移。

### 字段级迁移

每次加载原始设置(全局、项目、覆盖与运行时覆盖)时都会应用:

| 旧 | 新 |
| --- | --- |
| `inspect_image.enabled` boolean | `inspect_image.mode`(`true` → `on`,`false` → `off`) |
| `queueMode` | `steeringMode` |
| 毫秒单位的 `ask.timeout`(值 `> 1000`) | 秒(除以 1000) |
| 扁平字符串 `theme: "<name>"` | `theme.dark` / `theme.light`(按亮度选择槽位;内置的 `light`/`dark` 会被丢弃以使用默认值) |
| `task.isolation.enabled: true/false` | `task.isolation.mode: auto/none` |
| `task.simple` | 已移除 |
| 旧版 `task.isolation.mode`(`worktree`、`fuse-overlay`、`fuse-projfs`) | `rcopy`、`overlayfs`、`projfs` |
| `lastChangelogVersion` | 移至标记文件并从 `config.yml` 中剥离 |

## 故障排查

### 项目设置未生效

- 从包含 `.omp/config.yml` 的目录启动 `omp`。设置发现只检查当前工作目录的 `.omp/`,不检查祖先目录。
- 确保 `.omp/` 非空;空的配置目录会被忽略。
- 确认文件是有效 YAML 且顶层是映射。
- 在该目录运行 `omp config get <key>` 查看生效值。
- 记住 `--config` 覆盖与运行时标志会覆盖项目配置。

### 项目中的全局数组消失

数组是替换而非追加。如果项目设置了 `disabledProviders`、`enabledModels`、`cycleOrder`、`extensions` 或任何其他数组,请在项目层包含**完整**的期望值——全局数组会被完全替换。

### 编辑配置后提供商仍然可用

- 检查你是否禁用了模型提供商 id(例如 `anthropic`)或发现源 id(例如 `claude`)——它们是具有不同效果的不同命名空间。
- 检查是否有项目(或覆盖)的 `disabledProviders` 数组替换了你的全局数组。
- 凭据仍可来自环境变量、`.env`、OAuth、已存储的认证或 `models.yml`;禁用提供商无论如何都会阻止选择,但请确认你编辑的是正确的层。参见[提供商](./providers.md)。
- 如果模型列表已经初始化,请重启会话。

### `omp config set` 改错了文件

`omp config set` 与 `omp config reset` 总是写入当前生效 agent 目录下的全局 `config.yml`。运行 `omp config path` 打印它。对于项目本地设置,直接编辑 `<repo>/.omp/config.yml`。

### `omp config reset` 没有移除我的键

`reset` 将模式的**默认**值写入全局配置——它持久化默认值而不是删除该键。要停止从全局配置覆盖项目值,请手工从 `~/.omp/agent/config.yml` 删除该键。

### `--config` 覆盖在启动时失败

`--config` 文件是进程局部的 YAML 映射。文件缺失、YAML 无效或顶层为数组/标量都是硬错误——它不会静默回退到更低优先级的设置。修复路径或内容。

### 环境变量压过了我的配置

某些设置(模型角色、eval 后端、小模型设备/精度、认证代理、PTY)出于按机器的便利性可被环境变量或 CLI 标志覆盖,并且它们优先于 `config.yml`。取消设置该变量或去掉该标志,让持久化的值生效。参见[环境变量覆盖](#environment-overrides)与[环境变量](./environment-variables.md)。

### `omp config set <key>` 提示“未知设置”

键必须与模式路径完全匹配,没有简写。使用 `theme.dark`,而不是 `theme`。运行 `omp config list` 查看每个有效键。
