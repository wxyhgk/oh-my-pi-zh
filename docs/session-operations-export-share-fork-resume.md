# 会话操作:导出、转储、分享、全新、清除、分叉、恢复/继续

本文档描述会话导出、分享、对话重置、生命周期、分叉和恢复操作在当前实现中的操作者可见行为。

## 实现文件

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`../src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## 操作矩阵

| 操作                                   | 入口路径                     | 会话变更                                     | 会话文件创建/切换                                                                             | 输出产物                                                                               |
| -------------------------------------- | ---------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/dump`                                | 斜杠命令(TUI/headless)       | 否                                           | 否                                                                                           | 剪贴板/命令文本,外加尽力而为的临时 JSON 伴生文件                                        |
| `/export [--themes] [path]`            | 斜杠命令(TUI/headless)       | 否                                           | 否                                                                                           | HTML 文件                                                                              |
| `--export <session.jsonl> [outputPath]` | CLI 启动快速路径             | 无运行时会话变更                             | 无活动会话;读取目标文件                                                                     | HTML 文件                                                                              |
| `/share`                               | 斜杠命令(TUI/headless)       | 否                                           | 否                                                                                           | 加密分享链接(gist 或分享服务器);仅 TUI 自定义处理器使用临时 HTML                       |
| `/new`                                 | 交互式斜杠命令               | 是(开始一个空对话)                           | 切换身份;持久化模式下分配新的转录路径                                                       | 无                                                                                     |
| `/fresh`                               | 斜杠命令(TUI/headless)       | 是(仅面向提供商的进程内 id/状态)            | 否;保留当前会话文件/头                                                                       | 无                                                                                     |
| `/clear`                               | 交互式斜杠命令               | 是(清除实时/模型对话上下文)                 | 否;保留会话身份、元数据、转录文件和完整磁盘历史                                             | 追加一条持久化的 `reset_boundary`                                                      |
| `/drop`                                | 交互式斜杠命令               | 是(开始一个空对话)                           | 尝试删除当前持久化会话及其产物,然后切换到新会话                                             | 无                                                                                     |
| `/fork`                                | 交互式斜杠命令               | 是(活动会话身份变更)                        | 创建新的会话文件并将当前会话切换到它(仅持久化模式)                                          | 存在时将会话产物目录复制到新会话命名空间                                                 |
| `--fork <id\|path>`                    | CLI 启动                     | 是(会话创建后)                               | 从选定来源创建新的会话分叉,进入当前 cwd/会话目录                                           | 无                                                                                     |
| `/resume [id\|@claude\|@codex]`        | 交互式斜杠命令               | 是(活动进程内状态被替换)                    | 切换到选定/匹配的会话,或导入选定的外部会话                                                   | 无                                                                                     |
| `--resume`                             | CLI 启动选择器               | 是(会话创建后)                               | 打开选定的现有会话文件                                                                       | 无                                                                                     |
| `--resume <id\|path>`                  | CLI 启动                     | 是(会话创建后)                               | 打开现有会话;缺失的记录 cwd 可能被重新根植到当前目录                                       | 无                                                                                     |
| `--continue`                           | CLI 启动                     | 是(会话创建后)                               | 打开终端面包屑或最近会话;不存在时创建新会话                                                 | 无                                                                                     |

## 导出与转储

### `/export [--themes] [outputPath]`(斜杠命令)

流程:

1. 内置斜杠命令注册表(`src/slash-commands/builtin-registry.ts`)使用 `parseExportArgs` 解析参数;TUI 将同一命令委托给 `CommandController.handleExportCommand`。
2. `--themes` 选择配置的深色/浅色 TUI 主题,而不是独立的网页调色板。移除该标志后,最多接受一个以空白分隔的路径;多余 token 会产生 `Usage: /export [--themes] [path]`。
3. `AgentSession.exportToHtml()` 调用 `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`。
4. TUI 显示路径并在浏览器中打开文件。Headless 命令执行只打印路径而不打开它。

行为细节:

- `--copy`、`clipboard` 和 `copy` 参数会被显式拒绝,并警告改用 `/dump`。
- 导出嵌入会话头/条目/叶子,以及来自 Agent 状态的当前 `systemPrompt` 和工具描述。
- 存储在会话文件旁边的子 Agent 转录(`<session>/<AgentId>.jsonl`,嵌套派生的子代递归)会作为 `subSessions` 嵌入(`collectSubSessions`,位于 `src/export/html/index.ts`;可通过 `ExportOptions` 中的 `includeSubSessions: false` 禁用)。在页面中,任务工具卡片中的 Agent id 会打开带面包屑的子会话覆盖层。
- 工具调用通过 `<omp-tool-view>` Web 组件渲染——与 collab-web 共享的逐工具 React 渲染器(`packages/collab-web/src/tool-render/`),由 `bun run gen:tool-views` 预构建到 `src/export/html/tool-views.generated.js`。
- 导出期间不会追加任何会话条目。

注意事项:

- 解析基于空白,因此带空格的引号路径不会被保留。请使用没有空格的路径。

### `--export <inputSessionFile> [outputPath]`(CLI)

`main.ts` 中的流程:

1. 尽早处理(在交互式/会话启动之前)。
2. 调用 `exportFromFile(inputPath, outputPath?)`。
3. `SessionManager.open(inputPath)` 加载条目,然后生成并写入 HTML。
4. 进程打印 `Exported to: ...` 并退出。

行为细节:

- 输入文件缺失会显示为 `File not found: <path>`。
- 此路径不会创建 `AgentSession`,也不会变更任何正在运行的会话。

### `/dump`(剪贴板/headless 文本导出)

流程:

1. 命令调用 `session.formatSessionAsText()`。
2. 如果返回空字符串,命令报告 `No messages to dump yet.`。
3. 否则,它还会尝试 `session.dumpLlmRequestToTmpDir()`,并将结果路径追加到转录中。TUI 将合并后的文本复制到剪贴板;headless/ACP 命令执行将其作为命令输出返回。

转储转录内容包括:

- 系统提示词
- 活动模型/思考级别
- 工具定义 + 参数
- 用户/助手消息
- 思考块和工具调用
- 工具结果和执行块(`excludeFromContext` bash/python 条目除外)
- 自定义/钩子/文件提及/分支摘要/压缩摘要条目

尽力而为的 JSON 伴生文件名为 `omp-llm-request-<id>.json`,位于操作系统临时目录下。它包含当前模型、思考级别、服务层级、系统提示词、线上工具模式,以及 LLM 转换后的消息。它在命令结束后持久存在,可能包含原始上下文或秘密;请相应保护或删除它。伴生文件失败不会抑制转录(TUI 报告失败;headless 执行静默省略路径)。

转储不会追加任何会话持久化条目。

## 分享

`/share` 发布会话的端到端加密快照,并打印查看器链接。实现:[`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts)。

### TUI 阶段 1:自定义分享处理器(如果存在)

交互式 TUI 的 `loadCustomShare()` 会在 `~/.omp/agent` 中检查第一个存在的候选:

- `share.ts`
- `share.js`
- `share.mjs`

要求:

- 模块必须默认导出一个函数 `(htmlPath) => Promise<CustomShareResult | string | undefined>`。

如果存在且有效,则保留旧版契约:会话被导出到临时 HTML 文件(`${os.tmpdir()}/${Snowflake.next()}.html`),处理器接收其路径,之后临时文件被移除。处理器结果解读:

- string => 视为 URL,显示并打开
- object => 显示 `url` 和/或 `message`;打开 `url`
- `undefined`/falsy => 通用的 `Session shared`

关键回退行为:

- 如果自定义处理器存在但加载失败,命令报错并返回。
- 如果自定义处理器执行时抛出异常,命令报错并返回。
- 在两种失败情况下,它**不会**回退到默认流程。
- 默认流程仅在不存在自定义分享脚本时运行。
- Headless/ACP 斜杠命令执行不加载自定义分享脚本;它始终使用默认的加密流程。

### 默认加密分享

对于 headless 执行,或在 TUI 中仅当未找到自定义分享处理器时,`shareSession()`:

1. 构建会话快照(`header`、`entries`、`leafId`,以及来自 Agent 状态的当前 `systemPrompt` 和工具描述)。
2. 如果 `share.redactSecrets` 已启用(默认)且混淆器具有配置或正则发现的秘密,则进行类型化逐字段遮蔽处理,重写带文本的头、提示词、工具、条目、子会话和消息字段。内联图像字节留给后面的尺寸处理。不透明的提供商重放字段和未类型化的扩展负载(`details`、`data`、`outputSchema`、压缩保留数据)会被丢弃,而不是被遍历。
3. JSON 被 gzip 压缩,并用全新的 AES-256-GCM 密钥密封(`[12B IV][ciphertext+tag]`)。
4. 上传目标由 `share.store` 选择:
   - **分享服务器**(默认,`store: "blob"`)——以原始 blob `POST <share.serverUrl>`(默认 `https://my.omp.sh/s`),上限 1 MB。过大的快照会被裁剪到合适大小:先是内联图像,然后是长字符串(32 KB → 8 KB → 2 KB → 512 B 上限),然后是最旧的条目。
   - **秘密 gist**(`store: "gist"`)——当 `gh` 已安装并认证时,密封 blob 以 base64 编码推送到 `session.ompshare.txt`(密封预算 5 MB;gist 原始拉取上限 10 MB),当 `gh` 不可用时回退到分享服务器。
5. 两种情况下链接都是 `<share.serverUrl>/<id>#<base64url key>`。该处提供的查看器页面获取 blob(十六进制 id 通过 GitHub gist API,其他通过服务器的 blob 存储)并在客户端解密;密钥只存在于 URL 片段中,绝不会出现在任何 HTTP 请求中。

UI 报告分享 URL(外加底层 gist URL,以及在适用时的一条截断说明)。Headless `/share` 打印相同的行。与 `/export` 不同,`/share` 对内存(`--no-session`)会话有效:快照从实时条目构建,不需要会话文件。

分享中的取消/中止语义:

- 加载器有 `onAbort` 钩子,可恢复编辑器 UI 并报告 `Share cancelled`。
- 上传本身不会中途中止;取消是 UI 级的,并在上传返回后检查。

## 全新

交互式 `/fresh` 重置当前会话的面向提供商流状态,**不触及本地转录、会话文件或头**。用它从卡住或损坏的提供商流(过期的提示词缓存、轮次中途故障,或漂移的服务器端会话 id)中恢复,同时保留你能看到的对话。

`AgentSession.freshSession()`:

- 在 Agent 流式输出时会被拒绝——请等待响应完成或先中止它。
- 关闭每个缓存的提供商会话状态条目(服务器端会话/提示词缓存句柄),并报告清理了多少个。
- 铸造全新的提供商会话 id,将 hindsight 和 mnemopi 内存重新绑定到它,并使追加式上下文失效,以便下一轮将完整的本地转录重新发送给提供商。
- 保留本地转录、会话文件和会话身份不变,因此你所说或所收的任何内容都不会丢失。

因为它同时保留可见的和面向模型的对话,`/fresh` 不同于 `/clear`(就地清除实时/模型对话)、`/new`(开始一个全新的空会话)和 `/drop`(尝试删除当前会话并开始新会话)。只有 `/fresh` 在保留现有对话的同时给提供商流状态一个干净的起点。

## 清除

交互式 `/clear` 就地清除当前对话上下文。它仅在 TUI 中可用,并且在响应流式输出或前台 bash/Python 执行运行时会被拒绝。如果压缩处于活动状态,命令会中止它并等待其停止后再重置。

`AgentSession.resetSessionContext()`:

- 丢弃实时消息、排队的 steer/follow-up 轮次、待处理的工具调用、错误状态、检查点/回退和延迟工具状态,以及会话停止延续状态。它还会取消该 Agent 排队的延续工作和异步 bash/task 任务。
- 轮换提供商端会话状态,重新预置顾问,使追加式模型上下文失效,并重置内存提升,以便下一轮从基础系统提示词和当前项目指令重建。
- 保留会话 id、标题、cwd、模型、设置、活动计划路径和转录文件。
- 追加一条持久化的 `reset_boundary`。折叠后的实时转录和重建的模型上下文从最新边界之后开始,而 JSONL 转录和完整转录导出在磁盘上保留重置前的历史。

TUI 在成功清除后清除其渲染的转录。这与 `/fresh` 不同,后者轮换提供商流状态而不清除对话;与 `/new` 不同,后者创建新的会话身份和转录文件;与 `/drop` 不同,后者在开始新会话前尝试删除旧的持久化会话。

## 分叉

交互式 `/fork` 从当前会话创建新会话,并切换活动会话身份。

### 前提条件与即时守卫

- 如果 Agent 正在流式输出,`/fork` 会被拒绝并发出警告。
- 操作前清除 UI 状态/加载指示器。

### 会话级流程

`AgentSession.fork()`:

1. 发出 `session_before_switch`,`reason: "fork"`(可取消)。
2. 刷新待处理的写入。
3. 调用 `SessionManager.fork()`。
4. 将产物目录从旧会话命名空间复制到新命名空间(尽力而为;非 ENOENT 复制失败会被记录,而非致命)。
5. 更新 `agent.sessionId`,并继承前一个提供商提示词缓存密钥,除非显式的提示词缓存密钥已被钉住。
6. 发出 `session_switch`,`reason: "fork"`。

`SessionManager.fork()` 行为:

- 需要持久化模式和现有会话文件。
- 创建新的会话 id 和新的 JSONL 文件路径。
- 重写头:
  - 新的 `id`
  - 新的时间戳
  - `cwd` 不变
  - `parentSession` 设置为之前的会话 id
  - `providerPromptCacheKey` 设置为之前头继承的密钥,或未钉住时的之前会话 id
- 在新文件中保留所有非头条目不变。

### 非持久化行为

- 内存会话管理器从 `fork()` 返回 `undefined`。
- `AgentSession.fork()` 返回 `false`。
- UI 报告 `Fork failed (session not persisted or cancelled)`。

### CLI `--fork <id|path>`

启动时 `--fork` 在正常会话创建之前解析:

1. `--fork` 与 `--no-session` 一起使用会被拒绝。
2. 路径样式的值(`/`、`\` 或 `.jsonl`)调用 `SessionManager.forkFrom(path, cwd, sessionDir)`。
3. 其他值通过 `resolveResumableSession(...)` 解析:先是本地会话,当 `sessionDir` 未被强制时再进行全局搜索。匹配接受小写的会话 id 前缀、完整 JSONL 文件名前缀,以及去掉时间戳的文件名 id 后缀。
4. 分叉文件创建在当前 cwd/会话目录作用域中,并成为启动的活动会话管理器。
5. 完整上下文分叉会自动从源头的继承密钥种子 `providerPromptCacheKey`,回退到源会话 id。当 `--model`、`--thinking`、`--system-prompt`、`--append-system-prompt`、`--tools` 或 `--no-tools` 改变提供商路由或提示词/工具形态时,启动会丢弃该自动继承。

使用 `--prompt-cache-key <key>` 显式且独立于 OMP 会话 id 和 `--provider-session-id` 钉住提供商提示词缓存身份。`--provider-session-id` 继续控制提供商会话/路由头和粘性凭据选择;`--prompt-cache-key` 在支持处控制 OpenAI Responses `prompt_cache_key` 负载。

## 恢复与继续

## 交互式 `/resume [value]`

不带参数:

1. 打开通过 `SessionManager.list(currentCwd, currentSessionDir)` 填充的会话选择器。
2. 选择器从当前文件夹作用域开始;Tab 切换到所有项目作用域,惰性加载并缓存 `SessionManager.listAll()`。
3. 选中后,`SelectorController.handleResumeSession(sessionPath)` 调用 `session.switchSession(sessionPath)`。
4. UI 清除/重建聊天和 todos,然后报告 `Resumed session`(或当恢复的会话属于另一个项目时报告 `Resumed session in <dir>`,此时进程 cwd 和 cwd 派生的缓存通过 `applyCwdChange` 重新指向)。

带参数:

- `/resume <id>` 先本地后全局地解析 id/文件名前缀,并直接切换到匹配的文件;未知值报告 `Session "<value>" not found`。
- `/resume @claude` 和 `/resume @codex` 打开外部会话选择器。选中一个会将其转换并在全新的 OMP 会话身份下持久化,然后切换到该新会话。

## CLI `--resume`

### `--resume`(无值)

- `main.ts` 列出当前 cwd/sessionDir 的会话,并在当前文件夹作用域中打开选择器。当该列表为空时,它会预加载 `SessionManager.listAll()`,以便用户发起的 Tab 切换到所有项目作用域是即时的;它不会自动切换作用域。仅当全局列表也为空时才打印 `No sessions found`。
- 选中的路径在会话创建前用 `SessionManager.open(selectedPath)` 打开。从另一个项目选择会话会先将进程切换到该项目的目录,并重新加载 cwd 作用域的设置/缓存。

### `--resume <value>`

`createSessionManager()` 解析顺序:

1. 如果值看起来像路径(`/`、`\` 或 `.jsonl`),直接打开。
2. 否则 `resolveResumableSession(...)` 搜索:
   - 当前作用域(`SessionManager.list(cwd, sessionDir)`)
   - 仅当未提供显式 `sessionDir` 时,才搜索全局会话(`SessionManager.listAll()`)
3. 匹配接受不区分大小写的会话 id 前缀、完整 JSONL 文件名前缀,以及 `<timestamp>_<sessionId>.jsonl` 中时间戳之后的 id 后缀。

跨项目 id 匹配行为:

- 如果匹配会话的记录目录已不存在,CLI 会询问 `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`。
  - 选择是(默认)时,`SessionManager.open(match.path)` 后跟 `manager.moveTo(cwd)` 将现有会话重新根植到当前目录,而不会复制它。
  - 选择否时,启动被取消。在非 TTY 模式下,启动失败并报错,指示用户以交互方式运行。
- 如果记录目录仍然存在,匹配的会话被直接打开。启动稍后将进程/项目作用域更改为恢复会话的 cwd,并重新加载 cwd 作用域的设置和插件缓存。它不会被隐式分叉。

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. 解析当前 cwd 的会话目录。
2. 读取终端作用域的面包屑。如果它指向嵌套的产物/子 Agent 会话,解析会上溯到顶层交互式父会话(最多八层)。
3. 如果面包屑指向记录在不同 cwd 下、其目录已不存在**且**当前目录没有自己的会话的会话,则通过 `moveTo` 将该会话重新根植到当前目录,而不是重新开始。
4. 否则,如果面包屑的 cwd 与当前 cwd 匹配,则使用面包屑会话;否则回退到最近修改的会话文件。
5. 打开找到的会话;如果不存在,则创建新会话。

为兼容起见,当 UUID 是唯一的位置消息时,`--continue <full-UUID>` 会被规范化为 `--resume <UUID>`。`autoResume` 设置在未提供显式会话标志/会话目录时调用相同的 `continueRecent` 行为,并在找到先前转录时恢复会话模型/思考状态。

这是仅启动行为;没有交互式的 `/continue` 斜杠命令。

## 会话切换如何实际变更运行时状态

`AgentSession.switchSession(sessionPath)` 执行恢复类操作所用的运行时转换:

1. 发出 `session_before_switch`,`reason: "resume"` 和 `targetSessionFile`(可取消)。
2. 断开 Agent 事件订阅,中止进行中的工作,并运行可选的切换前协调器。
3. 刷新待处理的 bash/会话写入并捕获回退状态:会话管理器状态;Agent 消息和所有队列;模型/思考/服务层级;工具和提示词;提供商/缓存 id;内存提升;以及检查点回退状态。
4. 清除 Agent 和下一轮队列。对于不同的文件,排空/分离顾问记录器。
5. `sessionManager.setSessionFile(sessionPath)`,更新提供商缓存/会话 id 和内存密钥,构建显示上下文,并重新水合检查点状态。
6. 发出 `session_switch`,`reason: "resume"`。
7. 替换 Agent 消息,重置顾问状态,并同步 todos。对于不同的文件,或对于重放消息已变更的同文件重新加载,关闭缓存的提供商会话。
8. 恢复可用的持久化模型。如果加载的分支以被中断的轮次结束,追加其合成中止消息并重建上下文。
9. 恢复配置/生效的思考和各系列服务层级,当目标分支没有对应条目时回退到当前设置。
10. 对于不同的转录,重置内存上下文;对于任何对话重写,清除会话作用域的工具状态。
11. 重新连接 Agent 事件,运行可选的会话切换协调器(交互模式用它重新进入诸如 plan 之类的持久化模式),并尽力而为地刷新工作区根系统提示词块。协调器/提示词刷新错误会被记录,而不是回滚已提交的切换。
12. 恢复目标顾问费用状态,完成 bash 转换,并在会话 id 变更时通知会话变更回调。

如果受保护转换中的某个抛出步骤失败,`switchSession()` 会恢复捕获的会话、Agent 队列/消息、工具/提示词、模型/思考/服务层级、提供商/缓存、内存和检查点状态;在重新抛出之前,它会重新连接先前的 Agent 订阅并重新运行模式协调。

`switchSession()` 本身不会创建新的会话文件。

## 事件发出与取消点

### 切换/分叉生命周期钩子

对于 `newSession`、`fork` 和 `switchSession`:

- 之前事件:`session_before_switch`
  - 原因:`new`、`fork`、`resume`
  - 可通过返回 `{ cancel: true }` 取消
- 之后事件:`session_switch`
  - 相同的原因集
  - 包含 `previousSessionFile`

`ExtensionRunner.emit()` 在第一个取消的之前事件结果处提前返回。

### 自定义工具 `onSession` 行为

SDK 将扩展会话事件桥接到自定义工具 `onSession` 回调:

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

这些回调是观察性的;它们不会取消切换/分叉。

### 与本文档相关的其他取消表面

- `/fork` 在流式输出时被阻止(用户必须先等待/中止当前响应)。
- `/resume` 选择器可以被用户关闭选择器取消。
- 跨项目 `--resume <id>` 可以通过拒绝缺失目录移动/重新根植提示取消。
- `/share` 有 UI 中止路径(`Share cancelled`);上传本身不会中途被杀。

## 非持久化(内存)会话行为

当会话管理器以 `SessionManager.inMemory()`(`--no-session`)创建时:

- 会话文件路径缺失。
- `/export` 失败并报 `Cannot export in-memory session to HTML`(传播到命令错误 UI)。`/share` 仍然有效:快照从实时条目构建。
- `/fork` 失败,因为 `SessionManager.fork()` 需要持久化。
- `/dump` 仍然有效,因为它序列化内存中的 Agent 状态。
- 如果设置了 `--no-session`,CLI 恢复/继续语义会被绕过,因为管理器创建会立即返回内存模式。

## 已知实现注意事项(截至当前代码)

- `SelectorController.handleResumeSession()` 不检查 `session.switchSession(...)` 的布尔结果;被钩子取消的切换仍可能通过 UI 的 "Resumed session" 重绘/状态路径继续。
- `/share` 自定义分享失败不会降级到默认的加密分享流程;它们会以错误终止 TUI 命令。
- `/export` 参数分词不保留带空格的引号路径。
- `/drop` 将删除视为尽力而为:它尝试删除当前会话 JSONL 和产物目录,记录任何删除失败,并且仍然创建并切换到新会话。失败或不完整的删除可能将旧会话或其产物留在磁盘上,因此 `/drop` 不是保证的擦除边界。
