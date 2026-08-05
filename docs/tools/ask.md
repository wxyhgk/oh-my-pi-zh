# ask

> 向交互式用户提出一个或多个选项选择或自由填写形式的问题。

## 来源
- 入口:`packages/coding-agent/src/tools/ask.ts`
- 模型提示词:`packages/coding-agent/src/prompts/tools/ask.md`
- 主要协作方:
  - `packages/coding-agent/src/config/settings-schema.ts` — `ask.timeout` / `ask.notify` 默认值
  - `packages/coding-agent/src/modes/theme/theme.ts` — 用于 TUI 渲染的复选框与单选图标
  - `packages/coding-agent/src/tui/index.ts` — 状态行渲染

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `questions` | `Question[]` | 是 | 一个或多个问题。空数组会被 schema 拒绝,运行时也有守卫。 |

### `Question`

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 用于多问题结果中的稳定标识符。 |
| `question` | `string` | 是 | 向用户显示的提示文本。 |
| `options` | `{ label: string; description?: string; preview?: string }[]` | 是 | 选择器选项。`description` 为说明文本;`preview` 为富提问对话框提供可选的精美预览内容。不限制最小/最大数量。运行时自带控制项;调用方不得使用保留标签 `Other (type your own)`、`Chat about this` 或 `Next →`。 |
| `header` | `string` | 否 | 富提问对话框使用的可选短显示徽标。选择器回退时忽略。 |
| `multi` | `boolean` | 否 | 启用多选模式。默认:`false`。 |
| `recommended` | `number` | 否 | 从零开始的推荐/默认选项索引。无效索引在选中时被忽略;回退选择器会对有效的单选选项标记 ` (Recommended)`。 |

## 输出
- 单次结果。
- `content[0].text` 为纯文本:
  - 单个问题:选中的/自定义答案,可附带 `User added note: ...`
  - 多个问题:`User answers:` 后每个 `id` 一行
  - 富对话框聊天跳转:`User chose to chat about this instead of answering...`
- `details`:
  - 单个问题:`{ question, options, multi, selectedOptions, customInput?, note?, timedOut? }`
  - 多个问题:`{ results: QuestionResult[] }`;每项包含 `id`、`question`、`options`、`multi`、`selectedOptions`,以及可选的 `customInput`、`note` 和 `timedOut`
  - 聊天跳转:`{ chatRedirect: true, questions: string[] }`
- 取消和无界面(headless)场景会抛出异常,而不是返回结构化成功结果。该工具不流式更新。

## 流程
1. 仅当 `session.hasUI` 为 true 时,`AskTool.createIf()` 才注册可发现工具;无界面(headless)会话永远不会获得它。
2. `execute()` 还要求 `context.hasUI` 与 `context.ui`;缺失时中止上下文并抛出 `ToolAbortError("Ask tool requires interactive mode")`。
3. 从设置中读取 `ask.timeout`,将秒转换为毫秒(`0` 表示禁用超时),并在计划模式(plan mode)启用期间完全禁用超时。
4. 若 `ask.notify` 不是 `off`,则发送终端通知:`Waiting for input`。当 `speech.enabled` 为 true 时,还会在打开对话框前将所有问题文本发送给语音合成器。
5. 当 UI 提供 `askDialog` 时,该工具打开一个富多问题表单。富选项接收 `header`、`description` 与 `preview`;结果可包含回答备注,或选择对话框的 `Chat about this` 跳转。
6. 否则对每个问题使用选择器/编辑器回退:
   - 单选列表加上 `Other (type your own)`
   - 多选复选框循环,适用时加上 `Done selecting` 和 `Other (type your own)`
7. 在回退多问题模式下,左/右箭头处理程序负责前后移动并保留先前答案。最后一个问题在选择后自动前进。
8. 若在作答前超时触发,回退会自动选择有效的推荐选项,否则选择第一个选项;结果文本附加 ` (auto-selected after timeout)`,并设置 `details.timedOut`。富对话框报告自己的 `timedOut` 答案。
9. 若用户未超时即取消,`execute()` 中止工具上下文并抛出 `ToolAbortError("Ask tool was cancelled by the user")`。
10. 成功时格式化人类可读文本及结构化 `details`;TUI 渲染器使用 `details` 进行富结果展示。

## 模式 / 变体
- 单个问题:返回扁平化的 `details` 字段。
- 多个问题:返回 `details.results[]`;回退模式允许方向键前后导航,而富 UI 呈现完整表单。
- 单选:一个选项或自定义输入。
- 多选:切换的选择或自定义输入。在回退模式中,仅当前进导航未激活且至少选中一个选项时显示 `Done selecting`。
- 富提问对话框:支持每题标题、选项预览、回答备注与 `Chat about this` 跳转。
- 选择器/编辑器回退:支持标签/描述,但不支持标题、预览、备注或聊天跳转。

## 副作用
- 用户可见提示 / 交互式 UI
  - 当 UI 提供富表单 API 时使用 `context.ui.askDialog(...)`;否则使用选择器/编辑器回退。
  - 通过 `context.ui.select(...)` 打开选择对话框。
  - 为 `Other` 通过 `context.ui.editor(...)` 打开文本编辑器对话框。
  - 除非 `ask.notify=off`,否则发送终端通知。
  - 当 `speech.enabled=true` 时通过语音合成器朗读问题文本。
- 会话状态
  - 读取计划模式状态以禁用超时。
  - 在无界面使用或用户取消时调用 `context.abort()`。
- 后台工作 / 取消
  - 将 UI 等待包装在 `untilAborted(...)` 中,使中止信号能中断待处理的对话框。

## 限制与上限
- `questions` 必须至少包含 1 项。未知字段会被拒绝,因为 `AskTool.strict=true`。
- `ask.timeout` 默认为 `0` 秒(禁用);配置的非零值以秒为单位。计划模式始终禁用它。
- 提示词指南建议提供 2–5 个选项,但代码只要求 `options` 数组字段,不强制最小或最大数量。
- 选项标签不得等于保留的运行时标签 `Other (type your own)`、`Chat about this` 或 `Next →`。
- 回退超时仅适用于选项选择器;一旦用户选择 `Other`,编辑器没有超时。
- `AskTool.concurrency = "exclusive"`:该工具在其工具批次中单独运行,因为选择器/编辑器 UI 表面是共享的,并发的 `ask` 调用会相互干扰。
- 调用渲染器会为显示而规范化不完整或格式错误的流式参数:裸字符串选项成为标签,不可用的问题/选项条目被省略。执行仍接收通过 schema 校验的输入。

## 错误
- 缺少交互式 UI:抛出 `ToolAbortError("Ask tool requires interactive mode")`。
- 用户未超时即取消选择器/编辑器:抛出 `ToolAbortError("Ask tool was cancelled by the user")`。
- 输入期间的中止信号:转换为 `ToolAbortError("Ask input was cancelled")`。
- 运行时空 `questions` 返回文本错误负载而非抛出:`Error: questions must not be empty`。
- 富对话框契约违规(结果数、id 或顺序错误)抛出 `Error`。

## 备注
- `recommended` 只是 UI/默认提示;无效索引会被忽略。若没有有效的推荐项,超时回退使用第一个选项。
- 在回退单选模式中,返回的 `selectedOptions` 值会去除附加的 ` (Recommended)` 后缀。
- 多选结果按 `Set` 插入顺序保留选择顺序,而非任意切换后的原始选项顺序。
- 选项标签与提示文本在 `details` 中原样返回。描述/预览/标题指导呈现,但不会复制进结果细节。
- `/tree` 可从持久化的 `ask` 调用中恢复通过 schema 校验的原始 `questions` 并重新打开,以创建兄弟答案分支;格式错误的遗留参数会安全失败(fail closed)。
