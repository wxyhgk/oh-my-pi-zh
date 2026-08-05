<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="omp">
</p>

<div align="center">

# 简体中文汉化版 🇨🇳

> **这是 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 的简体中文汉化分支。**
> 启动命令为 **`omp-zh`**,与官方 `omp` 互不冲突,可同时安装使用。

</div>

## 我们做了什么

在保持上游全部功能不变的前提下,完成了**全量中文化**:

| 范围 | 内容 |
|---|---|
| **界面** | 设置面板(1200+ 项)、70 个斜杠命令、TUI 组件、状态栏、CLI 帮助与输出全部译为中文 |
| **提示词** | 系统提示词、工具描述、Agent 角色提示词(159 个文件)译为中文,模型回复默认中文 |
| **文档** | `docs/` 全部文档(124 篇)与 README 翻译为中文 |
| **命令名** | 启动命令改为 `omp-zh`,避免与官方版冲突;`--help`/补全/示例同步更新 |

**保留英文的部分**(技术原因):命令名、工具名(如 `inspect_image`)、配置键、模型/提供商名、URL/路径/环境变量、以及参与程序逻辑判断的字符串。汉化过程中未改动任何功能逻辑,测试套件通过(仅剩少量与本机环境相关的预存失败)。

> [!IMPORTANT]
> 汉化版基于 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)(MIT License)派生。
> 版权归原作者 Mario Zechner 与 Can Bölük 所有,详见 [LICENSE](LICENSE)。
> 上游更新时,可用 `git fetch` 与 `git merge` 同步,再修复可能的合并冲突。

## 从源码运行(当前方式)

```sh
git clone <本仓库地址> oh-my-pi-hanhua
cd oh-my-pi-hanhua
bun install
bun --cwd=packages/natives run build   # 构建原生模块(需 bazelisk、cmake)
sh scripts/link-omp.sh                 # 链接 omp-zh 到 ~/.bun/bin
omp-zh                                # 启动
```

---

<p align="center">
  <strong>一个内置 IDE 能力的编码 Agent。</strong>
  <strong><a href="https://omp.sh">omp.sh</a></strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent"><img src="https://img.shields.io/npm/v/@oh-my-pi/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm 版本"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="变更日志"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="许可证"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://github.com/badlogic/pi-mono">Pi</a> 的分支,作者为 <a href="https://github.com/mariozechner">@mariozechner</a>
</p>

市面在售的最强 Agent 形态。经真实使用持续调优——开箱即用,全链路开放。

**60+** 提供商 · **31** 个内置工具 · **14** 种 LSP 操作 · **28** 种 DAP 操作 · **约 8 万行** Rust 核心。

> [!NOTE]
> 拉取请求目前**暂时向所有人开放**,作为试验。此前我们要求先获得担保才能接受 PR;在评估开放式贡献的效果期间,该要求暂时取消。视结果而定,担保系统可能会恢复。

## 安装

**macOS · Linux**

```sh
curl -fsSL https://omp.sh/install | sh
```

> **Alpine / musl:** 预编译的 musl 二进制会动态链接 `libstdc++`/`libgcc`,而标准 Alpine 并不自带。请先安装它们:`apk add libstdc++ libgcc`。

**Homebrew**

```sh
brew install can1357/tap/omp
```

**Bun(推荐)**

```sh
bun install -g @oh-my-pi/pi-coding-agent
```

**Windows(PowerShell)**

```powershell
irm https://omp.sh/install.ps1 | iex
```

**固定版本(mise)**

```sh
mise use -g github:can1357/oh-my-pi
```

macOS · Linux · Windows · bun ≥ 1.3.14

### Shell 补全

`omp` 会根据实时的命令/参数元数据,为 **bash**、**zsh** 和 **fish** 生成自身的补全脚本,因此它们永远不会与真实 CLI 脱节。子命令、参数和枚举值静态补全;模型名(`--model`、`--smol`、`--slow`、`--plan`)对照内置模型目录解析,`--resume` 对照磁盘上的会话解析。

```sh
# zsh — 添加到 ~/.zshrc(或把输出写入 $fpath 中的某个文件)
eval "$(omp-zh completions zsh)"

# bash — 添加到 ~/.bashrc
eval "$(omp-zh completions bash)"

# fish
omp-zh completions fish > ~/.config/fish/completions/omp.fish
```

## 每个工具,都_拉满性能_。

一次就能落地的编辑。只读摘要、不倾倒全文的读取。瞬间返回的搜索。选任何模型——omp 都能做好。

| model            | metric       | what                                                                  |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| Grok Code Fast 1 | 6.7% → 68.3% | 编辑格式不再拖垮模型的那一刻,成功率提升十倍。                         |
| Gemini 3 Flash   | +5 pp        | 相对 str_replace——超过了 Google 自己对这一格式的最佳尝试。            |
| Grok 4 Fast      | −61% tokens  | 坏差异上的重试循环消失后,输出量骤降。                                 |
| MiniMax          | 2.1×         | 通过率翻倍有余。同样的权重,同样的提示词。                             |

- `read` : 摘要式片段 · 理想的默认值 · 选择器命中率
- `grep` : 西部最快的搜索
- `lsp` : 你的 IDE 知道的一切,Agent 都知道
- `prompts` : 为每个模型持续调优

[阅读全文 ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)

## 你钟爱的 Pi,_电池全配_。

omp 建立在 [Mario Zechner](https://github.com/mariozechner) 出色的 [Pi](https://github.com/badlogic/pi-mono) 之上,补上了你缺失的一切。

### 01 · 支持工具调用的代码执行

多数 harness 给 Agent 一个 Python 沙箱就完事了。我们的则运行持久化的 Python 和一个 Bun worker,两个内核都能通过 loopback 桥回调 Agent 自己的工具——read、search、task。Agent 可以在 Python 里用 tool.read 加载 CSV,用 JavaScript 画图表,全程不离开单元格。

![omp TUI:一个 eval 会话,`[1/2] pandas describe`(Python)打印出真实的 DataFrame.describe() 表格,随后 `[2/2] top scorer`(JavaScript)执行 reduce。底部提示:'两个内核在同一个会话中运行。'](https://omp.sh/captures/eval.webp)

### 02 · LSP 接入每一次写入

要求重命名,就得到重命名。调用会经过 workspace/willRenameFiles,因此 re-export、barrel 文件和别名导入都会在文件移动前更新。你的 IDE 知道的一切,Agent 都知道。

![omp TUI:`LSP references` 为符号 `formatBytes` 返回跨三个文件的五个命中,随后 `LSP rename` 应用修改,涉及 format.ts/report.ts/cli.ts,最后是 `Search formatBytes 0 matches` 确认。最后一行:'重命名完成。跨三个文件的五处修改…'](https://omp.sh/captures/lsp.webp)

_[阅读 LSP 配置文档](docs/lsp-config.md)_

### 03 · 驱动真实调试器

C 二进制段错误:Agent 挂上 lldb,步进到坏指针,读取栈帧。Go 服务卡住:它挂上 dlv,遍历 goroutine。Python 进程僵死:debugpy、暂停、检查、求值。多数 Agent 还在到处撒 print 语句。

![omp TUI:针对 /tmp/omp-native/demo 原生二进制的实时 lldb-dap 会话。Adapter=lldb-dap,Status=stopped,Frame=xorshift32,指令指针 0x10000055C,位置 demo.c:6:10。Debug scopes 与 Debug variables 卡片显示局部变量(x = 57351),Agent 确认了计算:x 从 7 → 57351(= 7 ^ (7<<13))。](https://omp.sh/clips/dap-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/dap.mp4)_

### 04 · 可时光回溯的流式规则

你的规则平时休眠,直到模型脱离脚本。正则命中会在流式输出中途中止,把规则作为系统提醒注入,并从同一位置重试。无需在每一轮都付出上下文代价,就能得到纠偏。注入在压缩后依然存活,所以修正会一直生效。

![omp TUI:Agent 正在读取 src.rs,准备写入 Box::leak 时请求被中止(红色 `Error: Request was aborted`),琥珀色 `⚠ Injecting rule: box-leak` 卡片注入规则正文 `Don't reach for Box::leak in production code paths`,随后 Agent 纠偏,提议改用 `Arc<str>` 并请用户确认。](https://omp.sh/clips/ttsr-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/ttsr.mp4)_

### 05 · 一等公民子 Agent

把任务分给多个 worker,拿回类型化结果。task 扇出到隔离的 worktree,每个 worker 运行自己的工具面,最终的 yield 是一个通过 schema 校验的对象,父级可直接读取。无需解析散文,兄弟之间没有合并冲突,也没有孤儿编辑。

![omp TUI:展示 `task` 派生出 `ComponentsExports` 和 `RoutesExports` 两个子 Agent,约束块要求 peer 之间通过 IRC DM 沟通,每个子 Agent 的状态卡片显示费用与耗时,最后的 Findings 区块列出两份导出,以及一条诚实的关于单向握手的 'IRC 协调说明'。](https://omp.sh/clips/irc-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/irc.mp4)_

### 06 · 第二个模型,注视着每一轮。

把审阅模型配到 'advisor' 角色,它会阅读主 Agent 的每一轮,内联注入批注——一句轻声提醒、一个担忧,或一个硬性阻塞。它运行在自己的上下文和自己的模型上,所以能捕捉到执行者匆匆略过的问题。主 Agent 看到批注后纠偏,或者告诉你它为什么不改。

![omp TUI:/advisor status 显示 advisor 运行在 openai-codex/gpt-5.5 上;主 Agent 把 catch 的范围收敛到 ENOENT 而不是吞掉所有错误之后,琥珀色 'Advisor 1 note (concern)' 卡片警告该修复已不再符合用户字面上的验收标准。](https://omp.sh/clips/advisor-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/advisor.mp4)_

### 07 · 把链接丢给别人,他们就直接进来。

/collab 把你的实时会话挂到中继上,返回一个链接——外加一个二维码。队友用 omp-zh join 从另一个终端加入,或者直接在浏览器里打开。共享读写权限来结对操作同一个 Agent,或者用 /collab view 生成只读链接,任何人都能观看但无人能操控。帧在客户端封签;中继永远看不到你的密钥。

![omp TUI:/collab view 打印 'Collab session started!',包含一条 omp join 命令、一个 my.omp.sh 浏览器链接、提示 'Anyone with this link can watch the session but cannot prompt the agent',以及一个大号可扫描二维码。](https://omp.sh/clips/collab-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/collab.mp4)_

### 08 · 在 arxiv 上读个 PDF,何乐不为?

web_search 串联二十三个有排名的提供商,把找到的 URL 直接交给 read。Arxiv PDF、GitHub 页面、Stack Overflow 帖子都以结构化的 markdown 返回,锚点完好——和你本地文件用的工具面完全一致。引用、跟进、摘录,永远不会迷失来路。

![omp TUI:web_search 为推理时计算扩展返回 10 个有排名的 Perplexity 来源,Agent 选中一篇 arxiv 论文,调用 read https://arxiv.org/pdf/2604.10739v1,并用真实数字总结论文的头条结论。](https://omp.sh/clips/web-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/web.mp4)_

### 09 · 毫不掩饰的原生。即使在 Windows 上。

其他 Agent 会外部调用 rg、grep、find 和 bash。在很多机器上这些二进制根本不存在;而在存在的机器上,每次调用都要付出 fork-exec 往返的代价。omp 把真实实现链接进进程。ripgrep、glob、find:进程内。brush 就是 bash——会话跨调用存活,46 个 vendored coreutils(ls、sed、sort、xargs,连 jq 都通过 jaq)作为进程内内建命令运行,零 fork/exec。同一个 omp 二进制在 macOS、Linux 和 Windows 上运行——无需 WSL 桥接。

### 10 · 带优先级和结论的代码评审

对变更能否上线给出明确结论,每个问题按 P0 到 P3 排序并给出置信度评分。/review 会派生专门的评审子 Agent,并行扫查分支、单个提交或未提交的工作。先处理阻塞发布的问题;没有重要信息会埋没在一大段散文里。

### 11 · Hashline:按内容哈希编辑

完美编辑,更少 token。模型指向锚点,而不是重敲它想改的行,于是空白字符之争和字符串找不到的循环就此消失。编辑过期文件时锚点会分歧——我们会在补丁破坏任何东西之前拒绝它。Grok 4 Fast 在同一份工作上少花 61% 的输出 token。

### 12 · GitHub 只是另一种文件系统

其他 harness 硬塞 gh_issue_view、gh_pr_view、gh_search——每个都有各自的一堆参数,Agent 要学,你要调试。我们跳过了这套。read 本来就处理路径;PR 也是路径。只需教模型一种接口,只需维护一个面。

### 13 · 由 Agent 打理的内存

Agent 会在会话之间记住你的代码库。它在运行中用 retain 写入事实,用 learn 捕捉可复用的经验,用 recall 把它们拉回来,并把每次会话压缩成一个心智模型,在下一次会话的第一轮就加载。用 `memory.backend` 选择引擎——local、Hindsight 或 Mnemopi。默认按项目隔离,所以它对这个仓库学到的东西就留在这个仓库。

### 14 · ACP:编辑器可驱动的 Agent

在 Zed 里运行 omp,你就得到与终端里驱动的一样的 Agent——读取你正在看的缓冲区,通过编辑器的保存路径写入,在编辑器的终端里派生子 shell。破坏性工具会暂停,弹出权限提示,你只需确认一次即可。无需桥接、无需插件、无需再维护一个第二大脑。

### 15 · 继承你其它工具已经写好的东西

其它每个 Agent 都自带一个导入器,期待你转换。omp 直接以原生形态读取磁盘上已有的八种格式——Cursor MDC、Cline .clinerules、Codex AGENTS.md、Copilot applyTo 等等。没有迁移脚本,没有 YAML 到 TOML 的移植,没有"受支持子集"的脚注。你团队上个季度写的配置今晚依然能用。

### 16 · omp commit:原子拆分,校验过的提交信息

omp 通过 git_overview、git_file_diff 和 git_hunk 读取工作树,然后把无关的修改拆成按依赖排序的原子提交。循环会在写入任何东西之前被拒绝。源文件的评分高于测试、文档和配置,所以头条提交就是那个重要的提交。锁文件完全排除在分析之外。

### 17 · 读 PR。_漫步 Skills。_从子 Agent 里取出 JSON。

十六种内部 scheme——`pr://`、`issue://`、`agent://`、`skill://`、`ssh://` 等——在 Agent 调用的每个 FS 形态工具里透明解析。`read pr://1428` 返回与 `read src/foo.ts` 相同的形态。`grep` 可以把差异当目录来走。`agent://<id>/findings.0.path` 按路径从子 Agent 的输出中取出字段。

![omp TUI:读取 pr://can1357/oh-my-pi/1063,然后是 /diff/1,显示 hunk 头、新增行,以及一条 [MODIFIED] (+12 -0) 摘要。](https://omp.sh/captures/pr.webp)

### 18 · 冲突解决,变得简单。

每个合并冲突都变成一个 URL。Agent 向 `conflict://N` 写入 `@theirs`、`@ours` 或 `@base`,文件就干净地解决了。批量形式:`conflict://*`。

![omp TUI:✓ Read src/session.ts(⚠ 1 conflict),随后 ✓ Write conflict://1 · 1 line,内容为 @theirs,最后是确认 'Resolved.'](https://omp.sh/clips/conflict-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/conflict.mp4)_

### 19 · 先预览,再接受。

`ast_edit` 返回一张 _(proposed)_ 卡片,带替换计数。变更被暂存。Agent 向 `xd://resolve` 写一行理由;TUI 把它变成一张 **Accept** 卡片,磁盘移动随即发生——原子、全有或全无。

![omp TUI:✓ AST Edit: console.log($X) (proposed) 3 replacements · 1 file,随后 ✓ Accept: 3 replacements in 1 file (AST Edit),最后是 'Applied 3 replacements in src/auth.ts.'](https://omp.sh/clips/codemod-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/codemod.mp4)_

### 20 · 驱动_真实浏览器_。或者你的 Slack?

Stealth 默认开启,所以页面看到的是一个普通用户,而不是无头机器人。同一套 API 可以直接驱动任何 Electron 应用——指向 Slack,Agent 读取你的私信就像读取网页一样。或者干脆跳过沙箱:浏览器中继扩展让 Agent 接管你已经打开的 Chrome 标签页,且不抢焦点。

![omp TUI 用浏览器工具驱动 DuckDuckGo](https://omp.sh/captures/browser.webp)

### 21 · 直接操控桌面

`computer` 在真实宿主机上运行持久化 JavaScript:枚举窗口和显示器、截屏、发送原生输入、遍历操作系统的无障碍树、触摸剪贴板。不是浏览器工具,没有 DOM——就是你正在看的那个桌面。

## 任务需要什么,_盒子里都有_。

31 个工具与 `read`、`bash` 同处一个命名空间。用 `--tools read,edit,bash,…` 固定活跃集合;不常用的可发现工具留在 `xd://` 设备后面。`read xd://` 列出它们,启用 `tools.xdev` 后 `write xd://<tool>` 即可运行一个。

**文件与搜索**

- `read` — 通过一条路径处理文件、目录、归档、SQLite、PDF、笔记本、URL、远程 `ssh://` 路径以及内部 `://` scheme。
- `write` — 创建或覆盖文件、归档条目或 SQLite 行。
- `edit` — 带内容哈希锚点与过期锚点恢复的 hashline 补丁。
- `ast_edit` — 基于 ast-grep 的结构化改写,应用前先预览。
- `ast_grep` — 覆盖 50+ 种 tree-sitter 语法的结构化代码查询。
- `grep` — 对文件、glob 和内部 URL 的正则搜索。
- `glob` — 基于 glob 的路径查找;需要内容匹配时请用 `grep`。

**运行时**

- `bash` — 带 46 个进程内 coreutils、可选 PTY 和后台任务分发的工作区 shell。
- `eval` — 带共享 prelude 和工具重入的持久化 Python 与 JavaScript 单元格。

**代码智能**

- `lsp` — 诊断、导航、符号、重命名、代码操作、原始请求。
- `debug` — 驱动 DAP 会话——断点、单步、线程、栈、变量。
- `security_scan` — 规划并运行原生安全评审;驱动 Codex Security 云端扫描。

**协作**

- `task` — 并行扇出子 Agent,可选工作区隔离。
- `hub` — 给在线 Agent 发消息、等待或取消后台任务,并监督长时运行进程。
- `todo` — 对会话待办列表做带阶段追踪的有序变更。
- `ask` — 为交互式运行提供结构化追问。

**桌面与网络**

- `browser` — 通过无头 Chromium、CDP 附加的应用,或经中继使用你自己的 Chrome 来开 Puppeteer 标签页。
- `computer` — 针对宿主桌面的持久化 JS:窗口、截屏、原生输入、AX 树、剪贴板。
- `web_search` — 一次查询跨配置好的提供商,返回答案与引用。
- `github` — GitHub CLI 操作——仓库、PR、issue、代码搜索、Actions 运行观察。
- `generate_image` — 通过 Gemini、GPT 或 xAI Grok 图像模型生成或编辑位图图像。
- `inspect_image` — 用视觉模型分析本地图像文件。
- `tts` — 通过 xAI Grok Voice 实现文本转语音——五种内置音色,WAV 或 MP3。

**内存与技能**

- `checkpoint` — 标记对话状态,供日后折叠并汇报。
- `rewind` — 修剪探索性上下文,保留一份简明报告。
- `retain` — 把持久事实排入活跃记忆库。
- `recall` — 在记忆库中搜索原始记忆。
- `reflect` — 基于记忆库综合出答案。
- `memory_edit` — 按 id 更新、遗忘或失效已存记忆。
- `learn` — 捕捉可复用的经验;可选择提升为受管技能。
- `manage_skill` — 创建、更新或删除隔离的受管技能。

受设置控制、默认关闭:`github`、`security_scan`、`generate_image`、`tts`、`checkpoint`、`rewind` 以及记忆类工具(`retain`/`recall`/`reflect`/`memory_edit`,按 `memory.backend`)。当活跃模型无法看图时,`inspect_image` 会自动激活。

[完整参考 →](https://omp.sh/docs/tools)

### 提示词控制

三个独立的、全小写的词,让某一轮进入专门的 Agent 行为:

- `ultrathink` — 请求仔细的多步推理,以及支持的最高自动思考强度。
- `orchestrate` — 通过并行子 Agent 运行大量独立工作,并校验每个阶段。
- `workflowz` — 用活跃的 `task` 工具构建确定性的多子 Agent 工作流。

它们只会在正文中触发,不会在代码跨度、围栏代码块、XML/HTML 区块、标识符或路径中触发。精确的匹配规则与配置见 [魔法关键词](docs/magic-keywords.md)。

### 会话控制

斜杠命令会改变整个会话的运行方式:

- `/vibe` — 进入 [Vibe 模式](docs/vibe-mode.md):扮演导演,用只读工具集驱动持久的 `fast`/`good` worker 会话。
- `/fresh` — 重置提供商流状态(过期的提示词缓存、卡死的流),不改变本地转录。参见 [会话操作](docs/session-operations-export-share-fork-resume.md#fresh)。

## 六十多家提供商,上千个模型,_离 /model 一步之遥_。

十个角色按意图路由工作。`default` 用于常规轮次。`smol` 用于廉价的子 Agent 扇出。`slow` 用于深度推理。`plan` 用于计划模式。`commit` 用于变更日志。此外还有 `vision`、`designer`、`task`、`advisor` 和 `tiny`,各司其职。启动时用 `--smol`、`--slow` 或 `--plan` 覆盖;用 `Ctrl+P` 在活跃角色的已配置模型间循环。用 `/model` 斜杠命令在会话中途切换活跃模型。

下方的认证标签:`oauth` 用你的提供商账户登录,`plan` 通过编程计划订阅路由,`local` 针对本地服务器运行,密钥可选。

### 前沿 API

直接 API 与网关。可按角色混用提供商。

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### 编程计划

订阅路由。`/login` 挂接会话。

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### 自己运行

OpenAI 兼容的 `/v1/models`。本地实例可跳过密钥。

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### 自定义 OpenAI 兼容提供商

在 `~/.omp/agent/models.yml` 中定义自定义提供商:

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

运行 `omp-zh models spark` 验证发现。然后运行 `omp-zh setup`,在默认模型步骤中选择该模型,或在会话中打开 `/model` 把它分配给 `default` 角色。

不想用选择器预配置默认值,就把选择器加进 `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: spark/minimax-m3
```

### 让路由有用的四个旋钮

- **自定义提供商** — 在 `~/.omp/agent/models.yml` 中声明任何能说 `openai-completions`、`openai-responses`、`openai-codex-responses`、`azure-openai-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-gemini-cli` 或 `google-vertex` 的东西。
- **回退链** — `retry.fallbackChains` 下按角色或按模型的链。当主提供商抛出 429 或撞上配额墙时,下一个条目接管本轮剩余部分——冷却后恢复。
- **路径作用域模型** — 把 `enabledModels` 和 `disabledProviders` 条目限定到某个 `path:` 前缀,即可在一个仓库上固定不同的模型集合,而无需触碰全局配置。限定条目覆盖该路径及其下的一切。
- **轮询凭证** — 每个提供商堆叠多个 API 密钥,运行时按会话亲和性与按凭证退避轮换。当某个密钥半天就会烧光配额时很有用。

完整的提供商与路由参考见 [omp.sh/docs/providers](https://omp.sh/docs/providers)。

## 二十三个后端。_Agent 早已认识的一个工具_。

`web_search` 是内置的,不是外挂的。`auto` 走一条二十三个提供商的链;如果你已经为某个付费,可以按名字固定它。每一次命中背后,站点感知的提取把 GitHub、注册表、arXiv、Stack Overflow 和文档转成结构化 markdown——锚点和链接目标都完好保留。

### 搜索提供商

二十三个后端。固定一个,或者让 `auto` 按顺序走完这条链。

| provider     | auth                                      |
| ------------ | ----------------------------------------- |
| `auto`       | 链式                                      |
| `perplexity` | `PERPLEXITY_API_KEY`(匿名回退)           |
| `gemini`     | oauth                                     |
| `anthropic`  | oauth                                     |
| `codex`      | oauth                                     |
| `xai`        | oauth 或 `XAI_API_KEY`                    |
| `zai`        | `ZAI_API_KEY`                             |
| `exa`        | `EXA_API_KEY`(或 mcp)                    |
| `tinyfish`   | `TINYFISH_API_KEY`                        |
| `jina`       | `JINA_API_KEY`                            |
| `kagi`       | `KAGI_API_KEY`                            |
| `tavily`     | `TAVILY_API_KEY`                          |
| `firecrawl`  | `FIRECRAWL_API_KEY`(无密钥回退)          |
| `brave`      | `BRAVE_API_KEY`                           |
| `kimi`       | `/login kimi-code` 或搜索密钥             |
| `parallel`   | `PARALLEL_API_KEY`                        |
| `synthetic`  | `SYNTHETIC_API_KEY`                       |
| `searxng`    | 自托管                                    |
| `duckduckgo` | 无需密钥                                  |
| `startpage`  | 无需密钥                                  |
| `google`     | 无需密钥(浏览器)                         |
| `ecosia`     | 无需密钥(浏览器)                         |
| `mojeek`     | 无需密钥(浏览器)                         |
| `public`     | 无需密钥(以上全部,汇总)                 |

Exa 也接受通过 `/login exa` 存储的 API 密钥;显式选择无密钥模式时使用公共 MCP 回退。

### 专门处理器

Agent 拿到的是结构化内容,而不是剥掉标签的 HTML。

- **代码托管** — github、gitlab
- **包注册表** — npm、PyPI、crates.io、Hex、Hackage、NuGet、Maven、RubyGems、Packagist、pub.dev、Go 包
- **研究来源** — arxiv、semantic scholar
- **论坛** — stack overflow、reddit、hn
- **文档** — mdn、readthedocs、docs.rs

页面转成带完整链接结构的 markdown。Agent 可以引用、跟进、摘录,而不丢失锚点。

### 安全数据库

漏洞查询用厂商数据作答,而不是博客摘要。

- **NVD** — 国家漏洞数据库
- **OSV** — 开源漏洞源
- **CISA KEV** — 已知被利用漏洞

[`web_search` 参考 ↗](https://omp.sh/docs/tools#web_search)

## 大约 **8 万行** Rust,做着其它 harness 靠外部命令做的事。

九个 crate,一个带平台标签的 N-API addon。搜索、shell、AST、高亮、PTY、桌面控制、图像解码、BPE 计数——全部在 libuv 线程池上进程内完成。热路径上零 fork/exec。另有约 7.7 万行随附 vendored:brush bash fork、一个 jq 引擎(jaq),以及直接编进 shell 的 46 个 uutils coreutils。

- Crates:`pi-natives`、`pi-shell`、`pi-ast`、`pi-iso`、`pi-voice`、`pi-walker`、`pi-uu-grep`、`pi-uu-diff`、`pi-uutils-ctx`
- 平台:`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`win32-x64` — x64 同时提供双 AVX2 与基线二进制

按 crate 计,仅代码行数:

| Crate         | 作用                                                                                   |   ~行数 |
| ------------- | -------------------------------------------------------------------------------------- | -----: |
| pi-shell      | 内嵌 bash 引擎 · 持久会话 · 进程内 coreutils 分发 · 最小化器                           | 38,000 |
| pi-natives    | N-API 表面——下表中的每一个模块                                                        | 25,000 |
| pi-walker     | 并行、感知 ignore 的遍历器 + 扫描缓存,由 grep · glob · workspace · shell 共享          |  5,200 |
| pi-iso        | 工作区隔离 · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy                 |  3,300 |
| pi-uu-grep    | 基于 ripgrep 的 grep,作为进程内 shell 内建命令运行                                     |  3,300 |
| pi-ast        | tree-sitter + ast-grep 匹配、块解析、结构化摘要                                         |  2,900 |
| pi-voice      | 音频采集/播放 · Opus · 实时 WebRTC                                                     |  1,000 |
| pi-uu-diff    | 由 similar 支撑的结构化 diff 内建命令                                                   |    500 |
| pi-uutils-ctx | 线程局部 stdio/cwd/env,让内建命令无需 fork 即可并发运行                                |    300 |

`pi-natives` 内部,按模块细分(胶水代码与测试省略):

| 模块          | 作用                                                                                | 底层依赖                                  |   ~行数 |
| ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| desktop       | 窗口/显示器枚举 · 截屏 · 原生输入 · 供 `computer` 使用的 AX 树                        | xcap · enigo · OS AX FFI                  | 10,600 |
| grep          | 正则搜索 · 并行/串行 · glob 与类型过滤 · 模糊查找                                    | grep-regex · grep-searcher                |  3,280 |
| text          | 感知 ANSI 的宽度 · 截断 · 列切片 · 保留 SGR 的换行                                    | unicode-width · segmentation              |  2,070 |
| snapcompact   | 位图帧栅格化 + PNG 编码,用于上下文压缩                                                | image · png                               |  1,760 |
| keys          | Kitty 键盘协议带 xterm 回退 · PHF 完美哈希查找                                        | phf                                       |  1,740 |
| ast           | ast-grep 模式匹配与结构化改写                                                         | ast-grep-core                             |  1,510 |
| diff          | 供工具与预览使用的结构化文件差异                                                      | in-tree                                   |  1,030 |
| pty           | 为 sudo · ssh 交互提示分配原生 PTY                                                    | portable-pty                              |    630 |
| crash_handler | 原生崩溃捕获与上报                                                                    | in-tree                                   |    610 |
| highlight     | 语法高亮 · 11 种语义类别 · 30+ 别名                                                   | syntect                                   |    550 |
| appearance    | Mode 2031 + 通过 CoreFoundation FFI 实现的原生 macOS 深色/浅色                         | core-foundation                           |    450 |
| task          | libuv 线程池上的阻塞工作 · 取消 · 超时 · 性能剖析                                      | tokio · napi                              |    440 |
| glob          | 带 glob 的发现 · 类型过滤 · mtime 排序 · 尊重 gitignore                                | ignore · globset                          |    430 |
| fd            | 用于替代 find 工具的文件系统遍历器                                                    | ignore                                    |    385 |
| clipboard     | 系统剪贴板的文本复制与图像读取 · 无需 xclip/pbcopy                                    | arboard                                   |    370 |
| workspace     | 一次遍历完成工作区遍历,兼顾 gitignore + AGENTS.md 发现                                | ignore                                    |    275 |
| power         | 用于防止空闲/系统/显示器睡眠的 macOS 电源断言 API                                     | IOKit FFI                                 |    270 |
| prof          | 循环缓冲剖析器,输出折叠栈与 SVG 火焰图                                                | inferno                                   |    240 |
| file_lock     | 跨进程建议性文件锁                                                                | in-tree                                   |    210 |
| ps            | 跨平台进程树终止与后代枚举                                                           | libc · libproc · CreateToolhelp32Snapshot |    195 |
| tokens        | O200k / Cl100k BPE token 计数 · 两张表均已内嵌                                        | tiktoken-rs                               |     70 |
| html          | HTML 转 Markdown,可选内容清洗                                                        | html-to-markdown-rs                       |     60 |
| sixel         | 终端图像渲染 · 解码 PNG · JPEG · WebP · GIF · 缩放 · SIXEL 编码                        | icy_sixel · image                         |     55 |

## 四个入口:_交互式_、_一次性_、RPC 和 ACP。

同一引擎,四个外壳。`omp-zh` 运行 TUI。`omp-zh -p` 回答单个提示词后退出。Node SDK 把会话嵌进你的进程。`omp-zh --mode rpc` 和 `omp-zh acp` 通过 stdio 把方向盘交给另一个程序。

### 交互式——拿不准时,Agent 会问

TUI 是默认界面。工具调用渲染成卡片,编辑在落地前预览,歧义通过 `ask` 工具路由——一个 Agent 可以在轮次中途调用的结构化选项选择器。其余交给键盘。

同样的提示卡片也会在 ACP 上呈现,因此编辑器无需另写一个选择器。

![omp TUI:ask 工具渲染出三个选项的选择器,第一个带 (Recommended) 徽章,底部提示 'up/down navigate · enter select · esc cancel'。](https://omp.sh/captures/ask.webp)

### SDK — 嵌入 Node

`@oh-my-pi/pi-coding-agent`

Node 和 TypeScript 宿主直接引入引擎。该包暴露 `ModelRegistry`、`SessionManager`、`createAgentSession` 和 `discoverAuthStorage`;会话发出类型化事件,你可订阅。

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

### RPC — 通过 stdio 驱动

`omp-zh --mode rpc`

适合非 Node 嵌入者,或当你想要进程隔离时。NDJSON 命令进,响应与事件帧出。`--mode rpc-ui` 额外把工具卡片、选择器和对话框作为 `extension_ui_request` 帧发出,由宿主应答。

```
$ omp-zh --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP — 与编辑器对话

`omp-zh acp`

基于 JSON-RPC 的 [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol)。当编辑器声明能力时,工具 I/O 走该协议,写入由 `session/request_permission` 把关。

| omp tool     | ACP route                           |
| ------------ | ----------------------------------- |
| `bash`       | `terminal/create + terminal/output` |
| `read`       | `fs/read_text_file`                 |
| `write`      | `fs/write_text_file`                |
| `edit, bash` | `session/request_permission`        |

完整参考:[omp.sh/docs/sdk](https://omp.sh/docs/sdk)。

## 一个值得留下的 harness,是你_不会长残_的那种。

从 **[omp.sh](https://omp.sh)** 拿走它。

omp 是 [Mario Zechner](https://github.com/mariozechner) 的 [Pi](https://github.com/badlogic/pi-mono) 的分支,重写为编码优先的表面:会话、子 Agent、斜杠命令、扩展——全部 TypeScript、全部 MIT、全部在 [GitHub](https://github.com/can1357/oh-my-pi) 上。用配置塑造它,从外部挂接它,需要时读源码。

### 原语

扩展就是一个 TypeScript 模块。与内建功能使用相同的工具 API、相同的斜杠命令注册表、相同的快捷键表、相同的 TUI 原语。没有任何保留字段。

### 发现

首次运行时,omp 继承磁盘上已有的东西:来自 `.claude`、`.cursor`、`.windsurf`、`.gemini`、`.codex`、`.cline`、`.github/copilot` 和 `.vscode` 的规则、技能和 MCP 服务器。无需迁移脚本。

### 可扩展性

让 omp 写你缺的那块,然后 `/reload-plugins`。留在本地,放进 `marketplace` 发布,或发布到 npm。

## 理念

omp 是 [Mario Zechner](https://github.com/mariozechner) 的 [pi-mono](https://github.com/badlogic/pi-mono) 的分支,扩展出一套电池全配的编码工作流。

关键思想:

- 为真实编码工作保持交互式、终端优先的体验
- 内置实用的功能(工具、会话、分支、子 Agent、可扩展性)
- 让高级行为可配置,而不是藏起来

---

## 开发

### 从源码开始

全新克隆在源码 CLI 能启动之前,需要工作区依赖和本地 Rust/N-API addon。

```sh
bun setup
bun dev
```

`bun setup` 安装 Bun workspaces 并构建 `@oh-my-pi/pi-natives`。修改 Rust crate 或 `packages/natives` 后,重新运行 `bun run build:native`。

非交互式冒烟检查:

```sh
bun dev -- --version
```

### 调试命令

`/debug` 打开用于调试、上报和性能剖析的工具。

架构与贡献指南见 [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md)。

---

## Monorepo 包

| 包                                                                            | 说明                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **[@oh-my-pi/collab-web](packages/collab-web)**                               | 用于协作实时会话的浏览器访客客户端、mock 宿主与本地中继                  |
| **[@oh-my-pi/pi-ai](packages/ai)**                                            | 支持流式与模型/提供商集成的多提供商 LLM 客户端                           |
| **[@oh-my-pi/pi-catalog](packages/catalog)**                                  | 模型目录:内置模型数据库、提供商描述与身份标识                            |
| **[@oh-my-pi/pi-agent-core](packages/agent)**                                 | 带工具调用与状态管理的 Agent 运行时                                      |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)**                        | 交互式编码 Agent CLI 与 SDK                                              |
| **[@oh-my-pi/pi-tui](packages/tui)**                                          | 带差分渲染的终端 UI 库                                                   |
| **[@oh-my-pi/pi-natives](packages/natives)**                                  | grep、shell、image、text、语法高亮等的 N-API 绑定                        |
| **[@oh-my-pi/omp-stats](packages/stats)**                                     | 面向 AI 用量统计的本地可观测性仪表盘                                     |
| **[@oh-my-pi/omptype](packages/omptype)**                                     | 兼容 ArkType 的 schema 校验,带惰性 JIT 编译                              |
| **[@oh-my-pi/pi-utils](packages/utils)**                                      | 共享工具(日志、流、目录/env/进程辅助)                                   |
| **[@oh-my-pi/pi-wire](packages/wire)**                                        | 共享协作实时会话协议类型与中继常量                                       |
| **[@oh-my-pi/hashline](packages/hashline)**                                   | 支撑 `edit` 工具的锚行补丁语言与应用器                                   |
| **[@oh-my-pi/pi-mnemopi](packages/mnemopi)**                                  | 面向 Oh My Pi Agent 的本地 SQLite 记忆引擎                               |
| **[@oh-my-pi/snapcompact](packages/snapcompact)**                             | 位图帧上下文压缩包与 SQuAD 评测套件                                      |
| **[@oh-my-pi/swarm-extension](packages/swarm-extension)**                     | Swarm 编排扩展包                                                        |
| **[@oh-my-pi/browser-relay](packages/browser-relay)**                         | 让浏览器工具驱动你现有标签页的 Chrome 扩展                              |
| **[@oh-my-pi/pi-metaharness](packages/metaharness)**                          | 统一基准运行器、Harbor 运行存储、REST/SSE API、实时仪表盘               |
| **[@oh-my-pi/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | 构建在 TypeScript 源码变更之上的编辑基准套件                             |

### Rust Crates

| Crate                                              | 说明                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                | 供 `@oh-my-pi/pi-natives` 使用的核心 Rust 原生 addon(N-API `cdylib`);聚合下列各 crate           |
| **[pi-shell](crates/pi-shell)**                    | 从 `pi-natives` 拆分出的内嵌 shell / PTY / 进程管理(包装 `brush-*`)                              |
| **[pi-ast](crates/pi-ast)**                        | 基于 tree-sitter 的代码摘要器与 AST 工具(50+ 语言语法)                                           |
| **[pi-iso](crates/pi-iso)**                        | 任务隔离后端解析器:APFS 克隆、btrfs/zfs reflink、overlayfs、projfs、rcopy                        |
| **[pi-voice](crates/pi-voice)**                    | 音频采集/播放、Opus 编解码器,以及实时 WebRTC 流式传输原语                                       |
| **[pi-walker](crates/pi-walker)**                  | 并行、感知 ignore 的文件系统遍历器,带由 grep、glob 和 workspace 共享的扫描缓存                  |
| **[pi-uu-grep](crates/pi-uu-grep)**                | 以 ripgrep 库为后端的 grep,作为进程内 shell 内建命令执行                                        |
| **[pi-uu-diff](crates/pi-uu-diff)**                | 由 similar crate 支撑的结构化 diff 内建命令                                                      |
| **[pi-uutils-ctx](crates/pi-uutils-ctx)**          | 线程局部 stdio/cwd/env 上下文,让进程内建命令并发运行                                            |
| **[brush-core](crates/vendor/brush-core)**         | [brush-shell](https://github.com/reubeno/brush) 的 vendored fork,用于内嵌 bash 执行             |
| **[brush-builtins](crates/vendor/brush-builtins)** | Vendored bash 内建命令(cd、echo、test、printf、read、export 等)                                  |
| **[jaq](crates/vendor/jaq)**                       | Vendored jq 兼容 JSON 查询引擎,作为进程内建命令运行                                             |
| **uu-\* 家族** ([crates/vendor](crates/vendor))    | 46 个 vendored uutils coreutils(ls、sed、sort、xargs、…),进程内执行,零 fork/exec               |

## 贡献

Issue 与拉取请求向所有人开放。开放的 PR 目前是**试验**——此前的要求担保已取消,待我们评估效果,且可能恢复。贡献指南见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

---

## 许可证

MIT。见 [LICENSE](LICENSE)。

© 2025 Mario Zechner  
© 2025-2026 Can Bölük

_献给那些始终开着的终端_

- [omp.sh](https://omp.sh)
- [GitHub](https://github.com/can1357/oh-my-pi)
- [Changelog](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
- [Discord](https://discord.gg/4NMW9cdXZa)
- [MIT](https://github.com/can1357/oh-my-pi/blob/main/LICENSE)
