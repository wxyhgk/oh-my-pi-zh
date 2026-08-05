# github

> 分发 GitHub CLI 操作,涵盖仓库、仓库文件、拉取请求、搜索与 Actions 运行监视。

## 来源
- 入口:`packages/coding-agent/src/tools/gh.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/github.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/gh-format.ts` — 为摘要缩短提交 SHA。
  - `packages/coding-agent/src/tools/gh-renderer.ts` — TUI 渲染,尤其是 `run_watch` 的实时/结果视图。
  - `packages/coding-agent/src/utils/git.ts` — `gh`/`git` 进程包装、仓库锁、分支配置写入。
  - `packages/utils/src/dirs.ts` — 专用 PR 工作树的基础目录。
  - `packages/coding-agent/src/sdk.ts` — 会话产物分配钩子。
  - `packages/coding-agent/src/session/artifacts.ts` — 产物文件名格式 `<id>.<toolType>.log`。

## 可用性与批准

- `github.enabled` 默认 `false`;使用前请在 **设置 → 工具** 中启用 GitHub CLI 工具。
- 该工具可被发现(discoverable)且为严格 schema,仅在 `gh` 位于 `PATH` 时才会创建。认证由 CLI 在操作运行时检查。
- `repo_view`、`file_read`、所有 `search_*` 操作及 `run_watch` 请求读取批准。`pr_create`、`pr_checkout` 与 `pr_push` 请求执行批准。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `op` | `"repo_view" \| "file_read" \| "pr_create" \| "pr_checkout" \| "pr_push" \| "search_issues" \| "search_prs" \| "search_code" \| "search_commits" \| "search_repos" \| "run_watch"` | 是 | 分发选择器。`GithubTool.execute()` 仅依据此字段进行分支。 |
| `repo` | `string` | 否 | `owner/repo` 覆盖。当标识参数已是完整的 GitHub URL 时忽略。对 `search_issues`/`search_prs`/`search_code`/`search_commits`,省略时默认为当前检出的 `owner/repo`(当查询已包含 `repo:`/`org:`/`user:`/`owner:` 限定词,或当前仓库解析失败时跳过)。当 `gh` 无法从当前检出推断仓库上下文时,实际必须提供。 |
| `branch` | `string` | 否 | 供 `repo_view`、`file_read`、`pr_push` 与 `run_watch` 使用。`file_read` 省略该 ref 以使用仓库默认分支;`run_watch` 在省略 `run` 时回退到当前 git 分支;`pr_push` 回退到当前分支。 |
| `path` | `string` | 否 | `file_read` 必填。GitHub 仓库内文件的仓库相对路径;拒绝以 `/` 开头。 |
| `pr` | `string \| string[]` | 否 | 供 `pr_checkout` 使用。每一项可以是 PR 编号、分支名或 GitHub PR URL。数组形式支持批量处理。省略表示当前分支的 PR。 |
| `force` | `boolean` | 否 | 仅由 `pr_checkout` 使用。默认 `false`;允许将已存在的 `pr-<number>` 本地分支重置到 PR head 提交。 |
| `forceWithLease` | `boolean` | 否 | 仅由 `pr_push` 使用;透传给 git push。 |
| `title` | `string` | 否 | 仅由 `pr_create` 使用。除非 `fill` 为 `true`,否则必填。 |
| `body` | `string` | 否 | 仅由 `pr_create` 使用。与 `fill` 互斥。空/省略的 body 会变成 `--body ""` 以抑制交互式编辑器。非空 body 写入临时文件并以 `--body-file` 传递。 |
| `base` | `string` | 否 | 仅由 `pr_create` 使用;以 `--base` 传递。 |
| `head` | `string` | 否 | 仅由 `pr_create` 使用;以 `--head` 传递。 |
| `draft` | `boolean` | 否 | 仅由 `pr_create` 使用。默认 `false`。 |
| `fill` | `boolean` | 否 | 仅由 `pr_create` 使用。默认 `false`。与 `title` 和 `body` 互斥。 |
| `reviewer` | `string[]` | 否 | 仅由 `pr_create` 使用;每个条目变成 `--reviewer`。 |
| `assignee` | `string[]` | 否 | 仅由 `pr_create` 使用;每个条目变成 `--assignee`。 |
| `label` | `string[]` | 否 | 仅由 `pr_create` 使用;每个条目变成 `--label`。 |
| `query` | `string` | 否 | 供所有 `search_*` 操作使用。本地校验仅对 `search_code` 要求必填;其他搜索操作会将其与可选的日期/仓库/类型限定词组合后发送给 GitHub。 |
| `since` | `string` | 否 | `search_issues`、`search_prs`、`search_commits` 与 `search_repos` 的下限日期。接受相对时长(`3d`、`12h`、`2w`、`2mo`、`1y`)、`YYYY-MM-DD` 或 ISO 日期时间。对 `search_code` 拒绝。 |
| `until` | `string` | 否 | `search_issues`、`search_prs`、`search_commits` 与 `search_repos` 的上限日期。格式与 `since` 相同。对 `search_code` 拒绝。 |
| `dateField` | `"created" \| "updated"` | 否 | issue/PR/仓库搜索的日期限定字段。默认 `created`;仓库搜索将 `updated` 映射为 GitHub 的 `pushed:` 限定词。提交搜索忽略该字段,始终使用 `committer-date:`。 |
| `limit` | `number` | 否 | 供所有 `search_*` 操作使用。默认 `10`,向下取整,钳制到 `50`,且必须 `> 0`。 |
| `run` | `string` | 否 | 仅由 `run_watch` 使用。必须是数字形式的运行 ID 或完整的 GitHub Actions 运行 URL。 |
| `tail` | `number` | 否 | 仅由 `run_watch` 使用。默认 `15`,向下取整,钳制到 `200`,且必须 `> 0`。 |

## 输出
该工具返回由 `packages/coding-agent/src/tools/gh.ts` 中的 `buildTextResult()` 构建的单个文本结果。

- `content`:一个文本块。多项操作以空行与 `---` 分隔符连接各段落。
- `sourceUrl`:当已知规范 URL 时,为仓库/文件/PR/运行结果设置。
- `details`:供 TUI 渲染器使用的可选结构化元数据。
  - 通用字段:`artifactId`、`repo`、`branch`、`worktreePath`、`remote`、`remoteBranch`、`headSha`、`runId`、`runIds`、`status`、`conclusion`、`failedJobs`。
  - `pr_checkout` 添加 `checkouts: GhPrCheckoutSummary[]`。
  - `run_watch` 添加 `watch: GhRunWatchViewDetails`,用于驱动 `packages/coding-agent/src/tools/gh-renderer.ts` 中的自定义实时/结果渲染器。
- 产物尾部:当存在 `artifactId` 时,文本正文会追加一行,形如 `Full failed-job logs: artifact://<id>`。
  - `run_watch` 通过 `session.allocateOutputArtifact("github")` 分配产物;因此持久会话会把失败日志正文保存为 `<artifact-dir>/<id>.github.log`。

`run_watch` 是唯一的流式操作。它在轮询期间发出 `onUpdate` 快照,然后返回一个最终文本结果。

## 流程
1. `GithubTool.createIf()` 仅在 `git.github.available()` 于 `PATH` 上找到 `gh` 时暴露该工具。
2. `GithubTool.execute()` 用 `untilAborted()` 包裹分发逻辑,并按 `params.op` 分支。
3. 每个操作都在 `packages/coding-agent/src/tools/gh.ts` 中本地规范化可选字符串、数组、布尔值与数值上限。
4. CLI 执行经由 `packages/coding-agent/src/utils/git.ts` 中的 `git.github.run/json/text()`:
   - 使用 `Bun.spawn()` 启动 `gh ...`;
   - 除非 `trimOutput: false`,否则修剪 stdout/stderr;
   - 将常见的认证/仓库上下文失败映射为面向工具的 `ToolError` 消息;
   - `json()` 拒绝空或无效的 JSON。
5. 读取类操作(`repo_view`、`file_read`、`search_*`)获取仓库数据,并返回文本或格式化后的类 Markdown 摘要。`file_read` 使用带 raw-media accept 头的 GitHub contents API,并将响应字节保留为文本。单 issue 与单 PR 视图已移出该工具,现通过 `issue://` / `pr://` 内部 URL 方案解析,二者共享同一个 SQLite 缓存。
6. PR 差异已移出该工具。`pr://<N>/diff` 列出变更文件,`pr://<N>/diff/<i>` 截取单个文件,`pr://<N>/diff/all` 返回完整的统一差异(unified diff)——参见 `docs/tools/read.md`。三种变体通过 `pr-diff` 缓存行共享一次 `gh pr diff` 调用。
7. `pr_checkout` 先解析 PR 元数据,再在任何 git 变更之前进入 `git.withRepoLock()`,使同一主仓库的并行检出调用不会在共享的 `.git` 状态上竞争。
8. `pr_push` 从 git 分支配置读回 PR head 元数据,推导 refspec,用 `git.push()` 推送,然后通过 `invalidateAllForNumber()` 使该 PR 的缓存 `pr://` 行失效,以便下一次 `pr://` 读取反映本次推送。
9. `pr_create` 调用一次外部命令,然后尽力重新读取已创建的 PR 以生成更丰富的摘要。
10. `run_watch` 选择运行模式(提供 `run`)或提交模式(省略 `run`),第一分钟内每 3 秒轮询一次 GitHub Actions API,之后每 15 秒一次,发出流式更新,并可能在返回前保存完整的失败日志产物。
11. 最终文本经由 `toolResult().text(...)` 输出;如果 `session.allocateOutputArtifact()` 返回可用槽位,失败日志文本会用 `Bun.write()` 持久化。

## 模式 / 变体

### `repo_view`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`branch` |
| `gh` 命令 | `gh repo view [<repo>] [--branch <branch>] --json <GH_REPO_FIELDS>` |
| 批处理 | 无 |
| 输出 | `# <owner/repo>` 标题、描述、URL、默认分支、请求的分支、可见性、权限、主要语言、星标数、fork 数、归档/fork 标志、更新时间戳、主页、主题。`sourceUrl = data.url`。 |

如果省略 `repo`,则使用 `gh` 的仓库解析。

### `file_read`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op`、`path` |
| 可选字段 | `repo`、`branch` |
| `gh` 命令 | `gh api /repos/<repo>/contents/<encoded-path> --method GET -H "Accept: application/vnd.github.raw+json" [-f ref=<branch>]` |
| 批处理 | 无 |
| 输出 | 文件内容与 contents API 返回的完全一致(`trimOutput: false`)。`sourceUrl` 指向 `https://github.com/<repo>/blob/<branch-or-HEAD>/<encoded-path>`;`details` 包含解析后的 `repo` 与可选的 `branch`。 |

`repo` 默认为当前检出的 GitHub 仓库。省略 `branch` 时向 GitHub 请求该仓库的默认分支。每个路径段都独立进行 URL 编码。该操作拒绝空路径或以 `/` 开头的路径;GitHub 通过常规 CLI 错误映射报告缺失文件、目录与无效 ref。面向模型的提示词要求对 GitHub 仓库中托管的文件使用此操作,而非 `curl` 或 `wget`。

单 issue 与单 PR 读取位于 `issue://<N>` / `pr://<N>` URL 方案中(参见 `docs/tools/read.md`)。它们共享 `~/.omp/cache/github-cache.db`(可通过 `OMP_GITHUB_CACHE_DB` 覆盖)以及 `github.cache.softTtlSec` / `github.cache.hardTtlSec` / `github.cache.enabled` 设置。缓存保留渲染后的 Markdown 及 `gh` 返回的原始 JSON 载荷,包括私有正文、评论、审查与(启用评论时的)审查评论;行按本地 GitHub 凭据指纹限定作用域。根级与仓库级读取(`issue://`、`pr://owner/repo`)会发起实时的 `gh issue list` / `gh pr list` 以供浏览;查询参数 `state`、`limit`、`author`、`label` 透传给 `gh`(`issue://` 接受 `state=open|closed|all`;`pr://` 还接受 `merged`)。PR 差异在 `pr://<N>/diff[/…]` 下使用同一缓存:列表、完整差异与按文件切片都共享一个以仓库和 PR 编号为键的 `pr-diff` 行。

### `pr_create`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op`,以及 `fill=true` 或 `title` 之一 |
| 可选字段 | `repo`、`title`、`body`、`base`、`head`、`draft`、`fill`、`reviewer[]`、`assignee[]`、`label[]` |
| `gh` 命令 | `gh pr create ...`,标志由所提供的字段组装 |
| 批处理 | 无 |
| 输出 | `# Created Pull Request ...` 摘要,包含 URL、状态、草稿标志、base/head、作者、创建时间、标签与可选的正文。`sourceUrl` 为所创建 PR 的 URL。 |

分支:
- `fill && (title || body !== undefined)` 会抛出异常。
- 非空 `body` 写入 `os.tmpdir()` 下名为 `gh-pr-body-*` 的临时目录,以 `--body-file` 传递,然后在 `finally` 中移除。
- 创建后,工具解析返回的 URL,并尽力运行 `gh pr view <number> --repo <repo> --json <GH_PR_FIELDS_NO_COMMENTS>`;此处的失败会被吞掉。

### `pr_checkout`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`pr`、`force` |
| `gh` 命令 | 对每个请求的 PR:`gh pr view [<pr>] [--repo <repo>] --json <GH_PR_CHECKOUT_FIELDS>`;跨仓库 PR 还可能调用 `gh repo view <headRepository> --json <GH_REPO_CLONE_FIELDS>`。 |
| 批处理 | 支持。`pr` 可以是 `string[]`;各 PR 并行解析,但 git 变更会由 `git.withRepoLock()` 按主仓库串行化。 |
| 输出 | 单个 PR:检出/工作树摘要,外加 `details.repo`、`details.branch`、`details.worktreePath`、`details.remote`、`details.remoteBranch`、`details.checkouts`。批量:`# <n> Pull Request Worktrees (...)` 外加每个 PR 一个段落及聚合的 `details.checkouts`。部分失败时,标题变为 `# <n>/<total> Pull Request Worktrees checked out (<k> failed)`,并带末尾的 `## Failed` 列表。 |

工作树与元数据行为:
- 本地分支名始终为 `pr-<number>`。
- 工作树路径为 `getWorktreeDir("<number>-<repo-hash>")` = `path.join(getWorktreesDir(), "<number>-<repo-hash>")`,其中 `<number>` 是 PR 编号,`<repo-hash>` 是 `hashPath(primaryRepoRoot)`(主仓库根的 7 位十六进制摘要)。`getWorktreesDir()` 按以下顺序解析基础目录:有效的 `OMP_WORKTREE_DIR`、已应用的 `worktree.base` 设置,然后是 profile/XDG 感知的数据根默认值(通常为 `~/.omp/wt`)。两种覆盖都会展开开头的 `~`,且必须解析为绝对路径;无效的相对值会被忽略,解析继续回退。当结果路径已被 git 注册或已存在于磁盘上时,`resolveAvailableWorktreePath()` 会追加 `-2`/`-3`… 后缀。
- 已存在工作树的检测依据 `git.worktree.list()` 中的分支 ref `refs/heads/pr-<number>`。
- 创建新工作树时,先验证路径既未被注册也尚未存在于磁盘,然后调用 `git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal })`。
- 同仓库 PR 的 remote 为 `origin`。跨仓库 PR 时,工具解析 head 仓库的克隆 URL,尽可能复用具有相同 URL 的现有 remote,或创建 `fork-<owner>` / `fork-<owner>-<n>`。
- 分支推送元数据通过 `git config` 持久化在仓库共享的 `.git/config` 中,条目为:
  - `branch.pr-<number>.remote`
  - `branch.pr-<number>.merge`
  - `branch.pr-<number>.pushRemote`
  - `branch.pr-<number>.ompPrHeadRef`
  - `branch.pr-<number>.ompPrUrl`
  - `branch.pr-<number>.ompPrIsCrossRepository`
  - `branch.pr-<number>.ompPrMaintainerCanModify`
- 如果 `refs/heads/pr-<number>` 已存在于不同的提交上,则检出失败,除非 `force=true`,此时 `git branch --force` 会将其重置到已获取的 PR head。
- 如果匹配的工作树已存在,工具会复用它并报告 `reused: true`。

### `pr_push`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `branch`、`forceWithLease` |
| `gh` 命令 | 无。此路径使用 git,而非 `gh`。 |
| 批处理 | 无 |
| 输出 | `# Pushed Pull Request Branch` 摘要,包含本地分支、remote、远程分支、远程 URL、PR URL 与 force-with-lease 标志。已知时 `sourceUrl = prUrl`。 |

推送目标解析会读取 `pr_checkout` 写入的 `branch.<name>.ompPrHeadRef`、`pushRemote`/`remote`、`ompPrUrl`、`ompPrMaintainerCanModify` 与 `ompPrIsCrossRepository` git-config 键。如果当前检出的分支与目标分支一致,源 ref 为 `HEAD`;否则推送 `refs/heads/<branch>`。refspec 为 `HEAD:refs/heads/<headRef>` 或 `refs/heads/<branch>:refs/heads/<headRef>`。

### `search_issues`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:issue" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub issues search`、回显的查询、可选的仓库、结果数量,然后每个 issue 一个条目,包含 repo/状态/作者/标签/时间戳/URL。 |

省略 `repo` 时,通过 `resolveSearchRepoScope()` 默认使用当前检出的 `owner/repo`。当组合后的查询已包含开头的 `repo:`/`org:`/`user:`/`owner:` 限定词,或 `gh repo view` 无法解析当前检出(例如不在 github remote 中)时,该默认值会被抑制。

### `search_prs`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:pr" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | 形态与 `search_issues` 相同,标注为拉取请求。 |

与 `search_issues` 一样,`repo` 默认为当前检出的 `owner/repo`。

### `search_code`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op`、`query` |
| 可选字段 | `repo`、`limit` |
| `gh` 命令 | `gh api -X GET /search/code -f q="<query> [repo:<repo>]" -F per_page=<limit> -H "Accept: application/vnd.github.text-match+json"` |
| 批处理 | 无 |
| 输出 | `# GitHub code search`、结果数量,然后每个匹配一个条目,包含路径、仓库、短提交 SHA、URL,以及(如存在)首个规范化的 text-match 片段行。 |

与 `search_issues` 一样,`repo` 默认为当前检出的 `owner/repo`。`since` 与 `until` 对此操作会被明确拒绝,因为 GitHub 代码搜索没有受支持的日期限定词。

### `search_commits`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField`(接受但忽略;提交搜索使用 `committer-date`) |
| `gh` 命令 | `gh api -X GET /search/commits -f q="<query> [committer-date qualifier] [repo:<repo>]" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub commits search`、结果数量,然后每个提交一个条目:短 SHA + 提交消息首行、仓库、作者、日期、URL。 |

与 `search_issues` 一样,`repo` 默认为当前检出的 `owner/repo`。

### `search_repos`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/repositories -f q="<query> [date qualifier]" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub repositories search`、结果数量,然后每个仓库一个条目,包含描述首行、语言、星标数、fork 数、未解决问题数、可见性、归档/fork 标志、更新时间、URL。 |

`repo` 有意不用于此操作。如果 `query`、`since` 与 `until` 全部省略,工具会发送空的 GitHub 仓库搜索查询,GitHub API 可能会拒绝它。

### `run_watch`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`branch`、`run`、`tail` |
| `gh` 命令 | 仓库解析:当 `repo` 与运行 URL 中的仓库都缺失时,使用 `gh repo view --json nameWithOwner -q .nameWithOwner`。单运行模式使用 `gh api --method GET /repos/<repo>/actions/runs/<runId>` 与 `gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`。提交模式使用 `gh api --method GET /repos/<repo>/branches/<branch>`、`gh api --method GET /repos/<repo>/actions/runs`、`gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`,以及为失败作业使用 `gh api /repos/<repo>/actions/jobs/<jobId>/logs`。 |
| 批处理 | 仅在提交模式下隐式批处理:同一提交的所有工作流运行一起跟踪。 |
| 输出 | 通过 `onUpdate` 输出流式监视快照,然后是最终文本报告。失败时,追加 `Full failed-job logs: artifact://<id>` 并设置 `details.artifactId`。 |

监视流程:
- `run` 解析接受十进制运行 ID 或完整运行 URL。当两者都给定时,URL 中的仓库必须与显式 `repo` 一致。
- 监视开始的前 `60` 秒内轮询间隔为 `3` 秒(`RUN_WATCH_INTERVAL_DEFAULT`)(`RUN_WATCH_FAST_WINDOW_MS`),之后为 `15` 秒(`RUN_WATCH_INTERVAL_SLOW`)。受速率限制的轮询错误按慢间隔退避,最多连续失败 `5` 次后重试(`RUN_WATCH_MAX_POLL_FAILURES`)。提交模式下,如果始终没有运行出现,`90` 秒后以明确消息放弃(`RUN_WATCH_NO_RUNS_GIVE_UP_MS`)。
- 失败宽限期固定为 5 秒(`RUN_WATCH_GRACE_DEFAULT`)。当完成前出现任何失败作业时,工具会发出提示,等待一次,重新获取状态,然后收集日志,以便纳入并发的失败。
- 失败作业日志通过 `git.github.run()`(而非 `json()`)以 `gh api /repos/<repo>/actions/jobs/<jobId>/logs` 获取。非零退出会留下 `available: false`,而不是使整个监视失败。
- 内联结果仅包含每个失败作业的最后 `tail` 行。保存的产物包含完整日志(`mode: "full"`)。
- 在提交模式下,成功会被有意双重确认:一旦所有已知运行都成功,工具会再等待一个轮询间隔,且仅当运行 ID 集合不变时才判定成功。这避免了在同一个提交的后续工作流运行出现之前就提前返回。
- `details.watch` 驱动 `packages/coding-agent/src/tools/gh-renderer.ts` 中的专用渲染器;非监视结果回退到通用文本渲染。

## 副作用
- 文件系统
  - `pr_create` 可能在 `os.tmpdir()` 下创建名为 `gh-pr-body-*` 的临时目录,写入 `body.md`,然后在 `finally` 中移除该目录。
  - `pr_checkout` 可能按 `OMP_WORKTREE_DIR`、`worktree.base`,再到 profile/XDG 感知的默认值(通常为 `~/.omp/wt`)选定的基础目录下创建名为 `<pr-number>-<repo-hash>` 的工作树目录,并在其中添加 git 工作树。
  - `run_watch` 可能写入包含完整失败作业日志的会话产物。
- 网络
  - 除 `pr_push` 外,每个操作都会调用 `gh`,由它与 GitHub API 通信。
  - `pr_push` 使用 git 网络传输到配置的 remote。
- 子进程 / 原生绑定
  - 所有 `gh` 调用都使用 `Bun.spawn(["gh", ...args])`。
  - `pr_checkout` 与 `pr_push` 还会调用 `packages/coding-agent/src/utils/git.ts` 中的 git 辅助函数。
- 会话状态(会话记录、记忆、任务、检查点、注册表)
  - 持久化失败作业日志时,`run_watch` 会消耗 `session.allocateOutputArtifact()`。
  - 返回的 `details` 对象携带供渲染器/UI 使用的运行/检出元数据。
- 用户可见的提示 / 交互式 UI
  - `pr_create` 通过强制使用 `--body-file` 或 `--body ""` 抑制 `gh` 的交互式编辑器回退。
  - `gh-renderer` 为所有操作提供紧凑标题,并为 `run_watch` 提供自定义实时监视视图。
- 后台工作 / 取消
  - `run_watch` 循环直至成功/失败,并在轮询之间使用 `scheduler.wait()`。
  - `GithubTool.execute()` 被 `untilAborted()` 包裹;`git.github.run()` 将中止信号转发给 `Bun.spawn()`。

## 限制与上限
- 搜索结果默认值:`10`(`SEARCH_LIMIT_DEFAULT`,位于 `packages/coding-agent/src/tools/gh.ts`)。
- 搜索结果上限:`50`(`SEARCH_LIMIT_MAX`)。
- `pr://` 视图中的 PR 文件预览:仅前 `50` 个文件(`gh.ts` 中的 `FILE_PREVIEW_LIMIT`)。对于因 GitHub 20,000 行限制而被拒绝的聚合差异,`pr://<N>/diff` 获取器会回退到分页文件 API(每页 `100` 个文件,最多 `3000` 个文件);二进制或单个过大的补丁仍会列出,并带不可用补丁标记。
- 运行监视轮询间隔:前 `60s` 为 `3s`,之后 `15s`(`RUN_WATCH_INTERVAL_DEFAULT`、`RUN_WATCH_FAST_WINDOW_MS`、`RUN_WATCH_INTERVAL_SLOW`);提交模式下无运行时 `90s` 后放弃(`RUN_WATCH_NO_RUNS_GIVE_UP_MS`);最多容忍 `5` 次连续的速率限制轮询失败(`RUN_WATCH_MAX_POLL_FAILURES`)。
- 运行监视失败宽限期:`5s`(`RUN_WATCH_GRACE_DEFAULT`)。
- 运行监视失败日志尾部默认值:`15` 行(`RUN_WATCH_TAIL_DEFAULT`)。
- 运行监视失败日志尾部上限:`200` 行(`RUN_WATCH_TAIL_MAX`)。
- PR 审查评论分页大小:`100`(`REVIEW_COMMENTS_PAGE_SIZE`)。
- Actions 作业分页大小:`100`(`RUN_JOBS_PAGE_SIZE`)。
- 搜索与 tail 的数值输入用 `Math.floor()` 向下取整,钳制到上限,非有限值或 `<= 0` 时拒绝。
- `pr_checkout` 的批量扇出在工具代码中无上限;所有请求的 PR 都用 `Promise.allSettled()` 启动,因此个别失败会以部分结果的形式呈现,而不是中止整个批次。

## 错误
- 当 `gh` 未安装时,完全跳过工具创建。
- 执行时若缺少 `gh`,`git.github.run()` 会抛出 `ToolError("GitHub CLI (gh) is not installed...")`。
- `git.github.text/json()` 将常见失败映射为面向模型的消息:
  - 未认证 → `GitHub CLI is not authenticated. Run \`gh auth login\`.`
  - 未显式提供 `repo` 且缺少仓库上下文 → `GitHub repository context is unavailable. Pass \`repo\` explicitly or run the tool inside a GitHub checkout.`
  - 否则为 stderr/stdout 文本,或回退消息 `GitHub CLI command failed: gh ...`
- `json()` 在 stdout 为空或 JSON 无效时也会抛出异常。
- 本地校验错误会抛出 `ToolError`,包括:
  - 缺少各操作必填字段(`file_read` 的 `path`、`search_code` 的 `query`,以及除非 `fill=true` 否则必填的 `title`)
  - 无效的数值 `limit` / `tail`
  - 无效的 `since` / `until` 日期边界
  - 无效的 `run` 格式
  - `fill` 与 `title` 或 `body` 同时使用
  - 检出、推送或监视缺少 git 仓库 / 分支 / HEAD 上下文
  - 在缺少 `ompPrHeadRef` 元数据的分支上执行 `pr_push`
  - 未提供 `force` 时存在冲突的现有工作树路径或分支
  - `file_read` 的绝对路径(以 `/` 开头)
- `run_watch` 对失败作业日志获取做特殊处理:日志内容缺失不会使监视失败;它会将该日志标记为 `available: false`,并打印 `Log tail unavailable.` / `Full log unavailable.`。
- `pr_create` 只吞掉创建后尽力而为的 `gh pr view` 刷新;创建步骤本身仍会正常失败。

## 说明
- 当标识参数已是完整 GitHub URL 时,`appendRepoFlag()` 有意跳过 `--repo`;这样可让 `gh` 从 URL 推导仓库/编号。
- `normalizePrIdentifierList()` 也接受 `reviewer`、`assignee` 与 `label` 数组;该辅助函数的名字比其调用方更宽泛。
- `pr_push` 依赖 `pr_checkout` 先对该本地分支运行过;没有其他元数据来源。
- `pr_checkout` 将推送元数据存储在分支配置中,而非工作树目录。复用同一个 `pr-<number>` 分支会复用这些配置键。
- 工作树写入的串行化以主仓库根为键,而非当前工作树路径,因为 git 工作树共享 `.git/config`、`packed-refs`、commit-graph 与工作树元数据文件。
- `search_repos` 是唯一从不转发 `repo` 的搜索操作;仓库作用域必须直接在查询中表达。
- `run_watch` 在提交模式下的成功意味着“所有观察到的运行都已成功,且一个轮询间隔后没有新的运行出现”,而不仅仅是“最近一次轮询看起来一切正常”。
- TUI 渲染器会折叠失败日志预览,除非结果视图被展开;底层文本结果仍包含相同的尾部行及任何产物引用。
