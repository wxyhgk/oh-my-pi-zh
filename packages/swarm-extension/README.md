# Swarm 扩展

面向 oh-my-pi 的多 Agent 编排。用 YAML 定义 Agent 工作流——管线、并行扇出、顺序链,或任意 DAG——并无人值守地运行到完成。

每个 Agent 都是一个完整的 oh-my-pi 子 Agent,可访问所有工具:bash、python、read、write、edit、grep、find、fetch、web_search、browser。编排器管理生命周期与顺序;Agent 通过共享的工作区文件系统通信。

可用于任何场景:研究管线、代码生成、数据处理、内容创作、分析工作流、类 CI 自动化——任何受益于专业化 Agent 协同工作的多步骤任务。

## 安装

```bash
cd packages/swarm-extension
bun install
```

## 运行

### 独立运行(推荐用于长时间工作)

```bash
# 前台——运行到完成,无超时:
omp-swarm path/to/swarm.yaml

# 后台——关闭终端后仍存活:
nohup omp-swarm path/to/swarm.yaml \
  > pipeline.log 2>&1 & disown
```

独立 runner 没有超时。它一轮接一轮地运行,直到管线完成或你终止它。

### 在 oh-my-pi 内(TUI)

在你的配置中注册扩展(`~/.omp/config.json` 或 `.omp/config.json`):

```json
{
	"extensions": ["packages/swarm-extension"]
}
```

然后:

```
/swarm run path/to/swarm.yaml
/swarm status <name>
/swarm help
```

## 监控

管线运行期间,状态持久化到 `<workspace>/.swarm_<name>/`:

```
.swarm_<name>/
  state/pipeline.json    # 实时管线 + 每个 Agent 的状态
  logs/orchestrator.log  # Wave 转换、迭代进度
  logs/<agent>.log       # 每个 Agent 的时间戳与错误
  context/               # Agent 会话产物
```

查看运行中的管线:

```bash
# 快速状态
cat workspace/.swarm_mypipeline/state/pipeline.json | python -m json.tool

# 观察编排器日志
tail -f workspace/.swarm_mypipeline/logs/orchestrator.log
```

---

## YAML 参考

每个 swarm 都是带顶层 `swarm` 键的单个 YAML 文件:

```yaml
swarm:
  name: my-pipeline # Identifier (state stored in .swarm_<name>/)
  workspace: ./workspace # Working directory (relative to YAML file location)
  mode: pipeline # pipeline | parallel | sequential
  target_count: 10 # Iterations (pipeline mode only, default: 1)
  model: claude-opus-4-6 # Default model for agents without an override (optional)

  agents:
    first_agent:
      role: short-role-name
      task: |
        Full instructions for this agent.
      extra_context: |
        Optional additional system prompt text.
      reports_to:
        - downstream_agent
      waits_for:
        - upstream_agent
      model: claude-sonnet-4-5 # Optional per-agent override
```

### 顶层字段

| 字段          | 必需 | 默认值         | 说明                                                                    |
| -------------- | -------- | --------------- | ------------------------------------------------------------------------------ |
| `name`         | 是      | —               | 管线标识。状态目录为 `.swarm_<name>/`                       |
| `workspace`    | 是      | —               | 共享工作目录。相对路径从 YAML 文件位置解析       |
| `mode`         | 否       | `sequential`    | 执行模式(见下文)                                                     |
| `target_count` | 否       | `1`             | 完整管线重复多少次。仅在 `pipeline` 模式下有意义 |
| `model`        | 否       | 会话默认值 | 未设置 `agents.<name>.model` 的 Agent 的默认模型                |

### Agent 字段

| 字段           | 必需 | 说明                                                             |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `role`          | 是      | 简短的角色标识——成为该 Agent 的系统提示词               |
| `task`          | 是      | 作为用户提示词发送的完整指令。多行用 YAML `\|` |
| `extra_context` | 否       | 追加到系统提示词的额外文本                               |
| `model`         | 否       | 仅对该 Agent 生效的模型覆盖                                      |
| `reports_to`    | 否       | 依赖此 Agent 的 Agent 名列表                           |
| `waits_for`     | 否       | 此 Agent 依赖的 Agent 名列表                               |

### 执行模式

**`pipeline`** — 把完整 Agent 图重复 `target_count` 次。每次迭代按顺序运行所有 wave。用于累积型工作:"每次迭代找一个,共找 50 个。"

**`sequential`** — Agent 各运行一次,按声明顺序链接(除非显式依赖覆盖)。默认模式。

**`parallel`** — 所有 Agent 同时运行(除非显式依赖施加顺序)。

### 依赖解析

编排器从 `waits_for` 与 `reports_to` 构建 DAG,然后用拓扑排序把 Agent 分组为 **wave**。同一 wave 中的 Agent 并行运行;wave 依次执行。

- `waits_for: [a, b]` — 直到 `a` 与 `b` 都完成后,此 Agent 才启动
- `reports_to: [x]` — 等价于 `x` 有 `waits_for: [this_agent]`
- 无显式依赖 + `pipeline`/`sequential` 模式 — Agent 按 YAML 声明顺序链接
- 无显式依赖 + `parallel` 模式 — 所有 Agent 在一个 wave 中运行
- 循环会在执行前被检测并拒绝

---

## 模式

### 管线:迭代累积

把同一 Agent 链运行 N 次。每次迭代都建立在上一次迭代的输出之上。适合:研究收集、数据采集、批处理、迭代精化。

```yaml
swarm:
  name: research-collector
  workspace: ./workspace
  mode: pipeline
  target_count: 25
  model: claude-opus-4-6

  agents:
    finder:
      role: researcher
      task: |
        Find ONE new source on the topic defined in workspace/topic.md.

        1. Read processed.txt to see what's already been found
        2. Use web_search to find a new, high-quality source
        3. Append the URL to processed.txt
        4. Write the URL to signals/finder_out.txt: FOUND:<url>

    analyzer:
      role: analyst
      task: |
        Read signals/finder_out.txt for the URL.
        Fetch the page and extract key findings.
        Read tracking/count.txt, increment it, write back.
        Write analysis to analyzed/item_<N>.md
        Write to signals/analyzer_out.txt: DONE:<N>

    compiler:
      role: technical-writer
      task: |
        Read signals/analyzer_out.txt for the item number.
        Read analyzed/item_<N>.md.
        Append a summary to output/report.md under a new section.
```

25 次迭代后:找到、分析并汇编了 25 个来源,汇总进一份报告。

### 扇入:并行专家

多个 Agent 独立工作,一个综合者合并结果。适合:多视角分析、并行代码评审、全面审计。

```yaml
swarm:
  name: codebase-audit
  workspace: ./workspace

  agents:
    security:
      role: security-auditor
      task: |
        Audit all code in src/ for security vulnerabilities.
        Write findings to reports/security.md with severity ratings.
      reports_to:
        - lead

    performance:
      role: performance-analyst
      task: |
        Profile and analyze src/ for performance bottlenecks.
        Write findings to reports/performance.md with benchmarks.
      reports_to:
        - lead

    architecture:
      role: architecture-reviewer
      task: |
        Review src/ for architectural issues, coupling, and tech debt.
        Write findings to reports/architecture.md with refactoring suggestions.
      reports_to:
        - lead

    lead:
      role: engineering-lead
      task: |
        Read all reports in reports/.
        Create a prioritized action plan in output/action_plan.md.
        Rank issues by impact and effort.
      waits_for:
        - security
        - performance
        - architecture
```

执行:security + performance + architecture 并行运行(wave 1),三者全部完成后 lead 启动(wave 2)。

### 顺序链:分阶段交接

在截然不同的阶段间线性推进。适合:内容管线、多阶段处理、评审链。

```yaml
swarm:
  name: blog-post
  workspace: ./workspace
  mode: sequential

  agents:
    researcher:
      role: researcher
      task: |
        Research the topic in topic.md using web_search.
        Write raw findings and source links to research/notes.md

    writer:
      role: technical-writer
      task: |
        Read research/notes.md.
        Write a complete blog post draft to drafts/post.md.
        Include code examples where relevant.

    editor:
      role: editor
      task: |
        Read drafts/post.md.
        Fix grammar, improve flow, tighten prose.
        Rewrite to drafts/post.md.

    reviewer:
      role: senior-reviewer
      task: |
        Read drafts/post.md.
        Check technical accuracy against research/notes.md.
        Add an editorial note at top if issues found, otherwise
        copy to output/final.md.
```

执行:researcher → writer → editor → reviewer,一个接一个。

### 菱形:先扇出再扇入

一个规划者、并行 worker、一个集成者。适合:分而治之、模块化代码生成、多文件重构。

```yaml
swarm:
  name: feature-implementation
  workspace: ./workspace

  agents:
    planner:
      role: architect
      task: |
        Read the feature spec in spec.md.
        Break it into independent implementation tasks.
        Write the plan to plan.md with file assignments.
      reports_to:
        - api
        - ui
        - tests

    api:
      role: backend-developer
      task: |
        Read plan.md for your assigned files.
        Implement the API layer. Write to src/api/.
      reports_to:
        - integrator

    ui:
      role: frontend-developer
      task: |
        Read plan.md for your assigned files.
        Implement the UI components. Write to src/ui/.
      reports_to:
        - integrator

    tests:
      role: test-engineer
      task: |
        Read plan.md for the full feature scope.
        Write integration tests to tests/.
      reports_to:
        - integrator

    integrator:
      role: tech-lead
      task: |
        Read plan.md and review all code in src/ and tests/.
        Wire everything together. Fix any integration issues.
        Run the tests and fix failures.
        Write status to output/done.md.
```

执行:planner(wave 1)→ api + ui + tests 并行(wave 2)→ integrator(wave 3)。

### 混合:混合依赖

任意 DAG 都合法。自由组合这些模式。

```yaml
swarm:
  name: data-pipeline
  workspace: ./workspace
  mode: pipeline
  target_count: 10

  agents:
    scraper_a:
      role: web-scraper
      task: |
        Scrape data source A. Write to raw/source_a.json
      reports_to:
        - transformer

    scraper_b:
      role: web-scraper
      task: |
        Scrape data source B. Write to raw/source_b.json
      reports_to:
        - transformer

    transformer:
      role: data-engineer
      task: |
        Read raw/source_a.json and raw/source_b.json.
        Clean, normalize, merge. Write to processed/merged.json
      reports_to:
        - loader
        - validator

    validator:
      role: qa-analyst
      task: |
        Read processed/merged.json.
        Validate schema, check for anomalies.
        Write report to qa/validation.md

    loader:
      role: data-engineer
      task: |
        Read processed/merged.json.
        Append to output/dataset.jsonl
```

每次迭代的执行:scraper_a + scraper_b(wave 1)→ transformer(wave 2)→ loader + validator(wave 3)。

---

## 编写 Agent 任务

### Agent 能做什么

每个 Agent 都是一个完整的 oh-my-pi 会话。它可以:

- **bash/python**:运行命令、脚本,安装包,处理数据
- **read/write/edit**:在工作区创建与修改文件
- **grep/find**:搜索工作区(或磁盘上任何地方)
- **web_search**:搜索互联网(通过配置的提供商)
- **fetch**:下载网页、API、文档
- **browser**:浏览网站、抓取动态内容、截屏

### Agent 间通信

编排器按正确顺序启动与停止 Agent。它**不**在它们之间传递数据。Agent 通过共享工作区中的文件通信。

设计你自己的协议。常见模式:

**信号文件** — Agent 完成时写入的轻量状态标志:

```
signals/finder_out.txt    -> "FOUND:https://example.com"
signals/analyzer_out.txt  -> "DONE:42"
signals/reviewer_out.txt  -> "APPROVED" or "REJECTED:reason"
```

**结构化输出** — 其它 Agent 读取的详细结果:

```
analyzed/item_1.md        -> 完整分析文档
results/report.json       -> 机器可读数据
output/final.docx         -> 累积的可交付物
```

**追踪文件** — 防止跨管线迭代的重复工作:

```
processed.txt             -> 已处理条目(每行一个)
tracking/count.txt        -> 当前条目计数器
tracking/status.json      -> 累积状态
```

### 可靠 Agent 的提示

- **明确写出路径。** Agent 每次迭代都是全新开始——它们不记得之前的运行。明确告诉它们在哪里读输入、在哪里写输出。
- **检查现有状态。** 在 pipeline 模式下,告诉 Agent 干活前先读追踪文件:"先读 processed.txt 以避免重复。"
- **使用编号输出。** `item_1.md`、`item_2.md` 等,这样迭代之间不会互相覆盖。
- **处理失败。** 告诉 Agent 出问题时该做什么:"如果来源缺乏深度,就把 SKIP 写入 signals/out.txt 并说明原因。"
- **保持信号文件简单。** 一行、可解析的格式。复杂数据放进结构化输出文件。
- **把任务范围收紧。** 试图一次做五件事的 Agent,一件都做不好。每个 Agent 一个清晰目标。

---

## 模型

omp 中配置的任何模型都可用。设置 swarm 默认值,并可选择性按 Agent 覆盖:

```yaml
swarm:
  model: claude-opus-4-6
  agents:
    writer:
      role: technical-writer
      task: |
        Write the draft.
    reviewer:
      role: reviewer
      model: claude-sonnet-4-5
      task: |
        Review the draft.
```

优先级:`agents.<name>.model` → `swarm.model` → 会话默认值。可用模型 id 见 `packages/ai/src/models.json`。

---

## 架构

```
src/extension.ts      TUI 入口(注册 /swarm 命令)
src/cli.ts   独立 runner(无 TUI,无超时)
src/swarm/
  schema.ts           YAML 解析 + 校验
  dag.ts              依赖图、循环检测、拓扑排序
  executor.ts         通过 oh-my-pi 的 runSubprocess 派生 Agent
  pipeline.ts         迭代循环 + wave 控制器
  state.ts            文件系统状态持久化
  render.ts           进度显示格式化
```
