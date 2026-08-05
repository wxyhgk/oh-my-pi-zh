# `/tree` 命令参考

`/tree` 打开交互式**会话树**导航器。它可以跳转到当前会话文件中的任意条目,并从该处继续。

这是文件内的叶节点移动,不是新会话导出。

## `/tree` 的作用

- 根据当前会话条目构建树(`SessionManager.getTree()`)
- 打开 `TreeSelectorComponent`,支持键盘导航、筛选与搜索
- 选中后调用 `AgentSession.navigateTree(targetId, { summarize, customInstructions })`
- 根据新的叶路径重建可见聊天内容
- 选择用户/自定义消息时,可选地将编辑器文本预填为草稿

主要实现:

- `src/slash-commands/builtin-registry.ts`(`/tree`、`/branch` 命令路由)
- `src/modes/controllers/input-controller.ts`(快捷键接线、双击 Esc 行为)
- `src/modes/controllers/selector-controller.ts`(树 UI 启动 + 摘要提示流程)
- `src/modes/components/tree-selector.ts`(导航、筛选、搜索、标签、渲染)
- `src/session/agent-session.ts`(`navigateTree` 叶切换 + 可选摘要)
- `src/session/session-manager.ts`(`getTree`、`branch`、`branchWithSummary`、`resetLeaf`、标签持久化)

## 如何打开

以下任一方式都会打开同一个选择器:

- `/tree`
- 为 `app.session.tree` 动作配置的快捷键
- 当 `doubleEscapeAction = "tree"`(默认)时,在空编辑器上双击 Esc
- 当 `doubleEscapeAction = "tree"` 时使用 `/branch`(路由到树选择器,而不是仅限用户的分支选择器)

## 树 UI 模型

树根据会话条目的父指针(`id` / `parentId`)渲染。

- 子条目按时间戳升序排序
- 包含活动叶的分支在选择器中排在最前;其他历史仍可访问
- 活动分支(根到叶路径)用项目符号标记
- 标签在节点文本前渲染为 `[label]`
- 缺失父级、自引用父级与显式 null 父级的条目成为根;多个根共享一个虚拟分支根

```text
Example tree view (active path marked with •):

├─ user: "Start task"
│  └─ assistant: "Plan"
│     ├─ • user: "Try approach A"
│     │  └─ • assistant: "A result"
│     │     └─ • [milestone] user: "Continue A"
│     └─ user: "Try approach B"
│        └─ assistant: "B result"
```

选择器围绕当前选择重新居中,最多显示:

- `max(5, floor(terminalHeight / 2))` 行

## 树选择器内的快捷键

- `Up` / `Down`:移动选择(可循环)
- `Alt+Up` / `Alt+Down`:跳到上一条/下一条用户或助手轮次
- `Page Up` / `Page Down`,或 `Left` / `Right`:翻页
- `Home` / `End`:第一个/最后一个可见条目
- `Enter`:选择节点
- `Shift+Enter`:直接摘要并切换,不打开摘要选择提示
- `Esc`:若搜索处于活动状态则清除搜索;否则关闭选择器
- `Ctrl+C`:关闭选择器
- `Type`(输入):追加到搜索查询
- `Backspace`:删除搜索字符
- `Shift+L`:搜索为空时编辑/清除标签
- `Ctrl+O`:向前循环筛选
- `Shift+Ctrl+O`:向后循环筛选
- `Alt+D/T/U/L/A`:直接跳转到某个筛选

## 筛选与搜索语义

初始模式来自 `treeFilterMode`(默认 `default`)。模式按此顺序循环:

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

### `default`

显示会话节点以及未被显式抑制的所有条目类型。它隐藏以下设置/簿记条目类型:

- `label`
- `custom`
- `model_change`
- `thinking_level_change`

当前代码中,其他没有专门渲染的条目类型(例如服务层级、标题、凭据固定、重置与模式条目)可能显示为空白行。

### `no-tools`

与 `default` 相同,另外隐藏 `toolResult` 消息。

### `user-only`

只显示 role 为 `user` 的 `message` 条目。

### `labeled-only`

只显示当前能解析出标签的条目。

### `all`

会话树中的一切,包括簿记/自定义条目。

### 仅含工具的助手节点行为

只包含工具调用(没有规范文本)的助手消息在所有筛选模式下都会被隐藏,包括 `all`,除非:

- 消息是错误/中止的(`stopReason` 既不是 `stop` 也不是 `toolUse`),或
- 它是当前叶

### 搜索行为

- 查询按空格分词
- 匹配是模糊(子序列)且不区分大小写的(`fuzzyMatch`)
- 所有 token 必须匹配(AND 语义)
- 可搜索文本包括标签、role 和类型特定内容(消息文本、分支摘要文本、自定义类型、工具命令片段等)

## 选择结果(重要)

`navigateTree` 根据所选条目类型计算新的叶行为:

### 选择 `user` 消息

- 新叶成为所选条目的 `parentId`
- 根用户消息将叶重置为根
- 文本与图片附件重建为可编辑草稿
- 选择器仅在编辑器当前为空时写入该草稿

### 选择 `custom_message`

- 普通自定义消息与用户消息使用相同的父叶规则和文本预填
- `skill-prompt` 自定义消息不可编辑;选择它会像其他非用户条目一样落在这个节点上

### 选择过去的 `ask` 工具结果

- 交互式 `/tree` 重新打开原始提问 UI,而不是复用过时的答案
- 取消则树保持不变
- 新答案作为同级工具结果追加,保留旧答案分支,然后 Agent 从该处继续
- 如果旧版/损坏数据无法恢复原始问题,选择回退为普通叶移动

### 选择其他节点

- 新叶成为所选节点 id
- 不预填编辑器

### 选择当前叶

- 通常以 `Already at this point` 关闭
- 当前叶的 `ask` 结果仍允许重新回答流程

```text
Selection decision (simplified):

selected node
   │
   ├─ current leaf (not ask result)? ──> close selector (no-op)
   │
   ├─ ask tool result? ──> re-answer as a sibling branch when questions are recoverable
   │
   ├─ user or ordinary custom message? ──> leaf := parentId (or root)
   │                                         + prefill only into an empty editor
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

## 切换时摘要流程

摘要提示由 `branchSummary.enabled` 控制(默认 `false`)。`Shift+Enter` 直接请求摘要,不受提示设置影响;必须有可用的模型与提供商凭据。

启用提示时,普通 Enter 提供:

- `No summary`
- `Summarize`
- `Summarize with custom prompt`

流程细节:

- 在摘要提示中按 Esc 会重新打开树选择器
- 取消自定义提示词会返回摘要选择
- 摘要期间,UI 显示加载器并将 Esc 绑定到 `abortBranchSummary()`
- 如果摘要中止,树选择器重新打开且不应用移动

`navigateTree` 内部:

- 刷新待处理的 bash 输出并校验目标
- 收集从旧叶到公共祖先的被放弃分支条目
- 发出可取消的 `session_before_tree`;扩展可以提供所请求的摘要
- 仅当请求了摘要、条目需要摘要且没有钩子摘要提供时才运行默认摘要器
- 按需应用 `branchWithSummary(...)`、`branch(newLeafId)` 或 `resetLeaf()`
- 重建受历史重写影响的模型上下文、检查点/回退状态、顾问状态、todos 与提供商会话
- 发出 `session_tree`,若处理程序可能追加了条目则再次重建

如果请求了摘要但没有可摘要的内容,导航会在没有摘要条目的情况下继续进行。

## 标签

树 UI 中的标签编辑调用 `appendLabelChange(targetId, label)`。

- 非空标签设置/更新解析后的标签
- 空标签清除它
- 标签存储为仅追加的 `label` 条目
- 树节点显示解析后的标签状态,而不是原始标签条目历史

## `/tree` 与相邻操作

| 操作 | 范围 | 结果 |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tree`   | 当前会话文件 | 将叶移动到所选位置(同一文件) |
| `/branch` | 通常是当前会话文件 -> 新会话文件 | 默认从所选 **user** 消息分支到新会话文件;若 `doubleEscapeAction = "tree"`,`/branch` 打开树导航 UI 代替 |
| `/fork`   | 整个当前会话 | 将会话复制到新的持久化会话文件 |
| `/resume` | 会话列表 | 切换到另一个会话文件 |

关键区别:`/tree` 是一个会话文件内的导航/重定位工具。`/branch`、`/fork` 和 `/resume` 都会更改会话文件上下文。

## 操作工作流

### 不丢失当前分支,从更早的用户提示重新运行

1. `/tree`
2. 搜索/选择更早的用户消息
3. 选择 `No summary`(或按需摘要)
4. 在编辑器中编辑预填文本
5. 提交

效果:新分支从同一会话文件中的所选点生长。

### 带上下文面包屑离开当前分支

1. 启用 `branchSummary.enabled`
2. `/tree` 并选择目标节点
3. 选择 `Summarize`(或自定义提示词)

效果:继续之前,在目标位置追加一条 `branch_summary` 条目。

### 调查隐藏的簿记条目

1. `/tree`
2. 按 `Alt+A`(all)
3. 搜索 `model`、`thinking`、`custom` 或标签

效果:检查完整内部时间线,而不仅仅是会话节点。

### 为后续跳转标记枢轴点

1. `/tree`
2. 移动到条目
3. `Shift+L` 并设置标签
4. 之后使用 `Alt+L`(`labeled-only`)快速跳转

效果:在持久的分支地标间快速导航。
