# TUI 运行时内部机制

本文档梳理交互模式下从终端输入到渲染输出的非主题运行时路径。它聚焦 `packages/tui` 中的行为,以及 `packages/coding-agent` 控制器的集成。

> **要修改渲染引擎本身?** 先读 [`tui-core-renderer.md`](./tui-core-renderer.md) —— 它记录了失败模式(拉扯 / 损坏 / 闪烁 / 宽度崩溃)以及渲染规划器、原生滚动缓冲记账与能力检测绝不能违反的不变量。

## 运行时层次与归属

- **`packages/tui` 引擎**:终端生命周期、stdin 规范化、焦点路由、渲染调度、差分绘制、覆盖层合成、硬件光标定位。
- **`packages/coding-agent` 交互模式**:构建组件树,绑定编辑器回调与按键映射,响应 Agent/会话事件,并将领域状态(流式、工具执行、重试、计划模式)转化为 UI 组件。

边界规则:TUI 引擎与消息无关。它只认识 `Component.render(width)`、`handleInput(data)`、焦点与覆盖层。Agent 语义保留在交互式控制器中。

## 实现文件

- [`packages/coding-agent/src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`packages/coding-agent/src/modes/session-teardown.ts`](../packages/coding-agent/src/modes/session-teardown.ts)
- [`packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`packages/coding-agent/src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`packages/coding-agent/src/modes/components/custom-editor.ts`](../packages/coding-agent/src/modes/components/custom-editor.ts)
- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts)
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts)
- [`packages/tui/src/editor-component.ts`](../packages/tui/src/editor-component.ts)
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts)
- [`packages/tui/src/components/loader.ts`](../packages/tui/src/components/loader.ts)

## 启动与组件树组装

`InteractiveMode` 构造 `TUI(new ProcessTerminal(), settings.get("showHardwareCursor"))`,应用 `tui.maxInlineImages` 与 Kitty 文本尺寸设置,然后创建持久容器:

- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `todoContainer`
- `subagentContainer`
- `btwContainer`
- `omfgContainer`
- `errorBannerContainer`
- `modelCycleContainer`(ctrl+p 模型角色循环芯片轨道)
- `statusLine`
- `hookWidgetContainerAbove`
- `editorContainer`(持有 `CustomEditor`)
- `hookWidgetContainerBelow`

`init()` 在任何启动警告/欢迎/更新日志之后按该顺序接线组件树,聚焦编辑器,通过 `InputController` 注册输入处理器,启动 TUI,推送终端标题状态,更新编辑器边框,并请求强制渲染。强制渲染(`requestRender(true)`)排队一次视口重绘或显式会话替换;默认情况下它**不会**丢弃前几行的历史。

## 终端生命周期与 stdin 规范化

`ProcessTerminal.start()`:

1. 启用原始模式与括号粘贴。
2. 挂接调整大小处理器并刷新尺寸。
3. 在 win32 上运行时启用 Windows VT 输入模式。
4. 创建 `StdinBuffer`,将部分转义块拆分为完整序列。
5. 查询 Kitty 键盘协议支持(`CSI ? u`),若支持则启用协议标志;否则在短暂超时后启用 modifyOtherKeys 回退。
6. 查询 OSC 11 背景色与 Mode 2031 外观通知,用于深色/浅色主题检测。
7. 查询 OSC 99 通知能力。
8. 仅在安全处启动周期性 OSC 11 轮询,然后通过 DECRQM 探测 DEC 私有模式 2026/2048/2031。

`StdinBuffer` 行为:

- 缓冲碎片化的转义序列(CSI/OSC/DCS/APC/SS3)。
- 仅在序列完整或超时刷新时发出 `data`。
- 检测括号粘贴并发出携带原始粘贴文本的 `paste` 事件。

这防止部分转义块被误解释为普通按键。

### 关闭与终端交接

通过双击 `Ctrl+C`、空编辑器 `Ctrl+D`、`/exit` 与事后检查信号退出,都会汇合到 promise 记忆化的会话拆除。第一个调用方胜出:它快照编辑器草稿,同步调用 `beginDispose()`,尝试保存草稿,然后销毁会话。草稿保存失败会被记录,但不会跳过销毁;后续的按键或信号调用方等待同一个 promise,不会重复运行关闭。

交互式关闭随后遵循以下归属顺序:

1. `InteractiveMode` 停止活动命令与瞬态控制器,显示关闭状态,并在交还终端前等待会话销毁。
2. 它最多排空一秒钟的在途 Kitty 输入,使释放序列不会泄漏到父 shell。
3. 它在停止 UI 前销毁运行状态标题/旋转器状态并恢复先前的终端标题。
4. `TUI.stop()` 离开调整大小/全屏备用屏幕状态,清除图像/探测状态,停止看门狗与渲染/调整大小定时器,定位并强制恢复光标,然后委托给 `ProcessTerminal.stop()`。
5. `ProcessTerminal.stop()` 恢复真实的 stderr 与终端模式,禁用键盘/鼠标/外观协议,清除探测与定时器,销毁 `StdinBuffer`,移除 stdin/stdout 监听器,暂停 stdin,并恢复其先前的原始模式状态。

终端断开将终端标记为死亡并停止交互式渲染。清理仍会移除拥有的状态,但原始模式恢复错误仅在终端死亡的情况下被抑制,因为没有活着的 TTY 可恢复。

挂起不同于退出:`Ctrl+Z` 停止 TUI 以释放终端模式,发送 `SIGTSTP`,并保留会话。它的一次性 `SIGCONT` 处理器重新启动 TUI 并强制重绘;它不运行会话拆除,也不向父 shell 交接终端。

## 输入路由与焦点模型

输入路径:

`stdin -> ProcessTerminal -> StdinBuffer -> TUI.#handleInput -> focusedComponent.handleInput`

路由细节:

1. TUI 首先运行已注册的输入监听器(`addInputListener`),允许消费/转换行为。
2. TUI 在组件分发前处理全局调试快捷键(`shift+ctrl+d`)。
3. 如果焦点组件属于现已隐藏/不可见的覆盖层,TUI 将焦点重新分配给下一个可见覆盖层或保存的覆盖层前焦点。
4. 按键释放事件会被过滤,除非焦点组件设置 `wantsKeyRelease = true`。
5. 分发后,TUI 调度渲染。

`setFocus()` 还会切换 `Focusable.focused`,它控制组件是否为硬件光标定位发出 `CURSOR_MARKER`。

## 按键处理分工:编辑器与控制器

`CustomEditor` 首先拦截高优先级组合键(escape、ctrl-c/d/z、ctrl-v、ctrl-p 变体、ctrl-t、alt-up、扩展自定义键),并将其余部分委托给基础 `Editor` 行为(文本编辑、历史、自动补全、光标移动)。

`InputController.setupKeyHandlers()` 随后将编辑器回调绑定到模式动作:

- `Escape` 上的取消 / 模式退出
- 双击 `Ctrl+C` 或空编辑器 `Ctrl+D` 上的关闭
- `Ctrl+Z` 上的挂起/恢复
- 斜杠命令与选择器热键
- 跟进/出队切换与展开切换

这让按键解析/编辑器机制保留在 `packages/tui`,模式语义保留在 coding-agent 控制器中。

## 渲染循环与默认的仅追加契约

`TUI.requestRender()` 合并渲染请求并限制普通帧的速率:

- 强制渲染(`requestRender(true, ...)`)调度立即的全窗口重写;`clearScrollback` 请求破坏性重放路径
- 普通渲染使用 30fps 基础节奏,加上由前一帧成本推导的自适应背压
- 渲染待决期间的重复请求合并到同一调度帧
- 当几何与渲染器状态安全时,`requestComponentRender(component)` 将组合范围限定到受影响的根子树;否则降级为完整组合
- `requestDirectWrite(component)` 可以立即重写一个安静、可见、固定高度的组件段(用于加载器式动画);覆盖层、图像、光标标记、几何变化、已提交段或其他不安全状态回退到 `requestComponentRender`

`#doRender()` 管线:

1. 渲染根组件树,收集第一个 `NativeScrollbackLiveRegion` 边界及其可选的固定策略。
2. 审计已提交的原始前缀是否存在结构性偏移;插入/删除会在第一个变化的行处重新锚定提交,因此过时历史可能重复,但新内容不会丢失。
3. 推进仅追加账本。实时边界之前的行是精确/最终的;滚动到窗口上方的可变行通常以冻结快照提交,而固定的实时区域保持在视口本地。
4. 提取并剥离 `CURSOR_MARKER`,规范化行,切片可见窗口,并将覆盖层合成到该屏幕坐标窗口切片中(覆盖层冻结提交)。
5. 发出以下之一:手势驱动或差异重建的全量绘制、滚动追加、窗口内行差异或接缝重写。

默认情况下,原生滚动缓冲区是仅追加的:已提交的帧行永不重写。精确行在组件接缝声明其为最终后进入历史;滚出的未固定可变行记录为提交时可见的快照。没有视口位置探测或延迟协调;参见 [`tui-core-renderer.md`](./tui-core-renderer.md)。

可选的 `tui.scrollbackRebuild` 设置(默认 `false`)改变已提交前缀差异的修复方式。当最终内容替换滚出的预览,或帧收缩进已提交行时,直接终端会话用 ED3 清空原生滚动缓冲区并重放当前帧,使过时与最终形态不会同时存在。多路复用器会话永远不会走这条破坏性路径,而是保留追加/下方修复回退。`PI_TUI_SCROLLBACK_REBUILD=1` 初始化底层 `TUI` 标志,但 `InteractiveMode` 随后应用配置的 `tui.scrollbackRebuild` 值;因此该设置在 coding-agent 中才是有效控制。

渲染写入在启用时使用同步输出模式(`CSI ? 2026 h/l`);能力检测、DECRQM 或 `PI_NO_SYNC_OUTPUT` 可以禁用包装器,同时保持自动换行纪律开启。

## 渲染安全约束

`TUI` 中的关键安全检查:

- 非图像渲染行应适配终端宽度;差异路径会作为最后防线截断超宽行,并在启用重绘调试时写入调试诊断。
- 覆盖层合成包含防御性截断与合成后宽度防护。
- 宽度变化强制重绘/重建规划,因为换行语义会改变。
- 光标位置在移动前被限制。

这些约束是运行时防护加组件约定;渲染器仍应返回宽度安全的行,而非依赖截断。

这些防护存在的深层原因——渲染器为何无法观测滚动位置、ED3(`CSI 3 J`)为何被限制在单一路径、热路径为何限制而非抛出——记录在 [`tui-core-renderer.md`](./tui-core-renderer.md) 中。

## 调整大小处理

调整大小事件从 `ProcessTerminal` 事件驱动到 `TUI.requestRender()`。

影响:

- 调整大小是显式用户手势:在多路复用器之外,引擎清空并重放(`ED3` + 全量绘制),使历史按新几何重新换行;提交账本从重放的帧重新开始。
- 在终端多路复用器内部,调整大小在稳定防抖后原地重绘可见窗口(issue #2088);窗格历史保持旧换行,与任何 shell 输出一样,因为窗格滚动缓冲区无法安全清空。
- 在备用屏幕缓冲区被切换时重新报告尺寸的终端(Warp 报告备用缓冲区高度差一行)也走原地路径。非多路复用器快速路径为拖拽帧借用备用屏幕,因此在这些终端上每次备用屏幕进入/离开都会发出新的调整大小事件,重新进入快速路径——形成自维持循环,以稳定几何淹没 ED3 全量重绘。`resizeRepaintsInPlace()`(覆盖多路复用器与这些终端;可通过 `PI_TUI_RESIZE_IN_PLACE` 覆盖)将它们路由到原地重绘,它从不触碰备用缓冲区。
- 覆盖层可见性可能依赖终端尺寸(`OverlayOptions.visible`);调整大小后覆盖层变为不可见时,焦点会被纠正。

## 流式与增量 UI 更新

`EventController` 订阅 `AgentSessionEvent` 并增量更新 UI:

- `agent_start`:在 `statusContainer` 中启动加载器。
- `message_start` 助手:创建 `streamingComponent` 并挂载它。
- `message_update`:更新流式助手内容;随工具调用出现创建/更新工具执行组件。
- `tool_execution_update/end`:更新工具结果组件与完成状态。
- `message_end`:定稿助手流,处理已中止/错误注释,在正常停止时标记待处理工具参数完成。
- `agent_end`:停止加载器,清除瞬态流状态,冲刷延迟的模型切换,在后台时发出完成通知。

读工具分组有意保持有状态(`#lastReadGroup`),将连续的 read 工具调用合并为一个视觉块,直到出现非 read 断点。

## 状态与加载器编排

状态通道归属:

- `statusContainer` 持有瞬态加载器(`loadingAnimation`、`autoCompactionLoader`、`retryLoader`)。
- `statusLine` 渲染持久状态/钩子/计划指示器,并驱动编辑器顶部边框更新。

加载器行为:

- `Loader` 每 80ms 推进其旋转器(动画消息着色器以约 30fps 重绘),并对安静、固定高度的帧使用直接写入路径,在直接重写不安全时自动回退到组件作用域渲染。
- Escape 取消进行中的自动压缩、交接生成或自动重试:编辑器的单个 `onEscape` 处理器根据实时会话状态(`isCompacting`/`isGeneratingHandoff`/`isRetrying`)分发,并调用匹配的中止方法,而非切换处理器。
- 在结束/取消路径上,控制器停止/清除加载器组件。

## 模式转换与后台化

### Bash/Python 输入模式

输入文本前缀切换编辑器边框模式标志:

- `!` -> bash 模式
- `$`(非模板字面量前缀)-> python 模式

Escape 通过清除编辑器文本并恢复边框颜色退出非活动模式;当执行处于活动状态时,escape 改为中止正在运行的任务。

### 计划模式

`InteractiveMode` 跟踪计划模式标志、状态行状态、活动工具与模型切换。进入/退出更新会话模式条目与状态/UI 状态,包括流式活动时的延迟模型切换。

### 挂起/恢复(`Ctrl+Z`)

`InputController.handleCtrlZ()`:

1. 注册一次性 `SIGCONT` 处理器以重启 TUI 并强制渲染。
2. 在挂起前停止 TUI。
3. 向进程组发送 `SIGTSTP`。

## 取消路径

主要取消输入:

- 活动流加载器期间的 `Escape`:将排队的消息恢复到编辑器并中止 Agent。
- bash/python 执行期间的 `Escape`:中止正在运行的命令。
- 自动压缩、交接生成或自动重试期间的 `Escape`:编辑器的 `onEscape` 根据实时会话状态(`isCompacting`/`isGeneratingHandoff`/`isRetrying`)分发,并调用匹配的中止方法(`abortCompaction`/`abortHandoff`/`abortRetry`)。
- `Ctrl+C` 单击:清除编辑器;500ms 内双击:关闭。

取消是状态条件的;同一个键根据运行时状态可以表示中止、模式退出、选择器触发或空操作。

## 事件驱动与限流行为

事件驱动的更新:

- Agent 会话事件(`EventController`)
- 按键输入回调(`InputController`)
- 终端调整大小回调
- `InteractiveMode` 中的终端外观回调、SIGWINCH 主题重新评估与 git 分支监视器

限流/防抖路径:

- TUI 渲染使用 30fps 基础节奏、合并与来自渲染成本的适应性背压。
- 加载器动画由间隔驱动(80ms 旋转器推进;消息着色器动画时约 30fps),在安全时使用直接写入,否则使用组件作用域渲染。
- 编辑器自动补全更新(`Editor` 内部)使用防抖定时器,减少输入期间的重算颠簸。

因此,运行时将事件驱动的状态转换与有界的渲染节奏混合,以在无重绘风暴的情况下保持交互响应。
