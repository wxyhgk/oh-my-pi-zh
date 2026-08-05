# TUI 核心渲染器 —— 仅追加契约

这是你在改动渲染引擎之前需要了解的内容。本文是 [`tui-runtime-internals.md`](./tui-runtime-internals.md) 的姊妹篇:那篇文档描述 _流程_(输入 → 组件树 → 渲染);本文解释**渲染契约、它为何如此设计,以及你绝不能违反的不变量**。范围仅限核心引擎:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — 帧管线、提交账本、窗口计算、发射器、光标定位。
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — `ProcessTerminal`、能力探测、私有 CSI 重组。
- [`packages/tui/src/terminal-capabilities.ts`](../packages/tui/src/terminal-capabilities.ts) — `TERMINAL` 档案、同步输出 / DECCARA / 图像检测。
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts) — 转义序列重组。
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) — 宽度/切片/换行(宽度模型)。
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) + [`components/image.ts`](../packages/tui/src/components/image.ts) — 内联图像。
- [`packages/tui/src/deccara.ts`](../packages/tui/src/deccara.ts) — 矩形填充优化器。

应用层渲染器(转录、工具调用、会话树、编辑器、小部件)**不在范围内**——它们位于 `packages/coding-agent`。对该契约起承载作用的一个应用层文件是 [`transcript-container.ts`](../packages/coding-agent/src/modes/components/transcript-container.ts),它实现了下文描述的提交边界接缝。

---

## 1. 首先要理解的一件事

> **渲染器无法观测终端的滚动位置**(ConPTY 的探测会撒谎;POSIX 根本没有 API)。之前的引擎试图 _猜测_ 何时可以安全地重写原生滚动缓冲区,而针对这个不可观测变量的每个策略选择都在一组失败模式之间权衡(拉扯 ↔ 闪烁 ↔ 损坏 ↔ 直到调整大小才可见——完整战争日志见本文件的 git 历史)。默认引擎完全消除了猜测:**原生滚动缓冲区是仅追加的。** 可选的差异重建模式可以在最终内容与已提交历史不再匹配时,在多路复用器之外清空并重放滚动缓冲区(§2);它不探测视口位置。

我们将转录保留在**普通屏幕**上(原生滚动缓冲区、原生选择、退出后转录仍然存在)。引擎维护一个账本:

- **`committedRows`(C)** — 帧行 `[0, C)` 已进入终端历史。普通发射器从不重写它们。可选的破坏性差异重放会清空账本并从当前帧重建历史。
- **`windowTopRow`(W)** — 映射到网格行 0 的帧行。可见窗口是帧行 `[W, W + height)`,用相对光标移动重绘。
- **实时区域边界(B)** — 第一个仍可能发生变化的行,由 `NativeScrollbackLiveRegion` 报告。B 之前的行是精确的并经过审计。离开窗口的未固定可变行以冻结的视觉快照提交。固定的实时区域则将可变后缀保持在视口本地,直到边界推进。

对于普通的未固定帧,`W = max(C, L - height)`,新的提交终点是 `max(C, W)`,并限制在帧内。进入历史的唯一字节是旧提交索引与新提交索引之间的块。精确行仍受已提交前缀审计约束;冻结的可变快照有意被排除在精确性声明之外。因此,在默认模式下,滚动缓冲区按提交时的字节按顺序记录每个已提交行一次。渲染器永远不需要知道用户是否已滚动离开尾部。

### 这付出的代价(已接受的权衡)

- 已经滚动过窗口顶部的块无法原地重排。精确的稳定行以其最终字节提交;未固定的可变行提交其滚出时可见的快照,因此之后的布局变化会留下过时的历史行,而不是重写原生滚动缓冲区。
- 报告**无接缝**的组件树获得 shell 语义:滚出去的即最终。将这样的帧收缩进其已提交前缀会重新锚定窗口,并在历史中留下过时副本(§3)。
- 在多路复用器内,调整大小会按旧宽度保留窗格历史的换行(与任何 shell 输出相同)。

---

## 2. 帧管线(你正在编辑的内容)

`#doRender` 每帧:

1. 组合帧,收集第一个根子级的 `getNativeScrollbackLiveRegionStart()` 与可选的固定策略。
2. 审计已提交的精确前缀(`findCommittedPrefixResync`,几何帧跳过)。检测器对前缀尾部采样(最后 24 行中最多 8 个非空行,去除 SGR)。单个就地不匹配被接受为过时历史;结构性偏移在第一个变化的行处重新锚定,宁可重复也不丢失内容。
3. 将帧分类为手势驱动的全量绘制、可选的差异重建或普通更新,并计算窗口/提交块。覆盖层冻结提交。固定的实时区域裁剪其屏幕外可变后缀,而非对其快照。
4. 提取光标标记,准备宽度安全的行,切片窗口,并仅将覆盖层合成到屏幕坐标窗口中。
5. 发出:

| 发射器                        | 字节                                              | 时机                                                                   |
| ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `#emitFullPaint`              | 起始位置 + 已提交块 + 窗口行;可选 ED3             | 初始绘制、显式几何/会话/重置手势或重建                                 |
| `#emitUpdate` 滚动追加        | 新的底部行 + 变化行范围                           | 离开屏幕的行正好是提交块                                               |
| `#emitUpdate` 窗口内差异      | 相对移动 + 变化行重写                             | 没有滚动或提交                                                         |
| `#emitUpdate` 接缝重写        | 提交块 + 完整窗口重写                             | 提交/窗口重新锚定、隐藏间隙回填或多路复用器调整大小                    |

**ED3(`CSI 3 J`)只在唯一一处发出** —— `#emitFullPaint({ clearScrollback: true })`。常规调用方是显式用户手势:会话替换/分支/恢复(`requestRender(true, { clearScrollback: true })`)、多路复用器之外的调整大小,以及 `resetDisplay()`(显示重置和弦,默认 `Alt+L`)。它无需先 `ED2` 即可清空原生历史;重放从起始位置覆盖每一行,因此没有同步输出的终端不会暴露空白视口。手势将用户固定到尾部,因此历史快照是可接受的。

第二个调用方是启用 `tui.scrollbackRebuild` 时的普通渲染差异:如果已提交前缀在结构上重新同步,或当前帧收缩进已提交行,渲染器清空并重放当前帧,用最终形态替换过时的预览历史。此路径默认禁用,并且永远不会在首次绘制之后、显式替换/几何帧期间或多路复用器内部运行。多路复用器永远不会收到 ED3(在那里它是空操作,重放会重复窗格历史)。

普通更新路径从不发出 ED2/ED3 或绝对光标归位——有几种终端系列在收到这些时会将被滚动的阅读者拉回底部。

### 提交边界接缝(承载应用契约)

`NativeScrollbackLiveRegion` 有一个边界和一个可选策略:

- `getNativeScrollbackLiveRegionStart()` 返回第一个仍可能发生变化的局部行。它之前的行被声明为当前宽度下的字节稳定。
- `isNativeScrollbackLiveRegionPinned()` 将可变后缀保持在视口本地,而不是在其滚出时记录冻结快照。这用于替换仪表板,而非追加形状的转录内容。
- 报告无接缝则获得 shell 语义:行随滚动提交。

当多个根子级报告接缝时,最顶部的接缝胜出,因为提交仅限前缀。`NativeScrollbackCommittedRows` 让容器将已提交计数传给子级,`NativeScrollbackReplay` 让组件在破坏性重放前释放布局锁。

`TranscriptContainer` 实现了应用层接缝。它扫描第一个未定稿的转录块。它之前的已定稿块是精确的;该实时块可以通过 `getTranscriptBlockSettledRows()` 扩展精确边界。助手消息从已完成的内容块与 markdown 的冻结 token 前缀推导这些稳定行,而可以异步重新布局的结构(例如 Mermaid)则推迟定稿。固定从第一个实时块传播;工具执行用它来替换预览/仪表板状态。

转录组装还报告 `RenderStablePrefix`:在未变化的偏移处保持不变的组件数组引用让引擎跳过字节相同前缀上的工作。丢弃或锁定已提交材料的组件必须遵循已提交行与重放钩子。冻结/定稿是正确性契约,而非终端特定的优化。

---

## 3. 不变量 —— 必须 / 绝不

1. **绝不要新增 `CSI 3 J`(ED3)调用点。** ED3 只流经 `#emitFullPaint({ clearScrollback: true })`,用于显式手势或受保护的、可选的差异重建,并且绝不进入多路复用器内部。
2. **普通发射器绝不重写已提交的行。** 它们将帧行 `< C` 视为不可变。收缩或结构性重新同步可能会在旧提交点之下重新锚定,但在默认模式下过时历史保留、新字节被追加;它永远不会被静默跳过。可选的差异重建是刻意的例外:它清空并重放完整的当前帧。
3. **提交恰好就是那个块。** 任何使屏幕滚动的字节形态只能滚动提交推进所计入的行。
4. **在更新路径中绝不要探测视口位置或按平台分支。** win32 的行为与 POSIX 相同。探测 API 已移除;不要重新引入它们。
5. **只有当行的字节稳定时才声明其精确。** 可变转录内容可以以未固定的冻结快照提交,但接缝之前的行仍受精确前缀审计。
6. **将硬件光标停在真实内容的底部**,而不是填充后的窗口底部,否则高度收缩会把实时行滚入历史,并在每次调整大小步骤中重复它们。
7. **光标写入位于同步输出帧内部**,在 ESU 之前——绝不能作为其后的第二个帧。
8. **在渲染热路径中绝不要抛出异常。** 限制超宽行(`truncateToWidth`);宽度不匹配是外观问题,不是致命问题。
9. **多路复用器在调整大小时既不获得破坏性清空,也不重排历史** —— 原地重绘窗口;窗格历史保持旧换行。
10. **对账本数学、发射器或接缝的任何更改都必须通过压力测试装置(§6)在其完整场景矩阵上验证**,而不是通过单终端冒烟测试。

---

## 4. 终端能力检测

`TERMINAL`(`terminal-capabilities.ts`)在导入时从 `TERMINAL_ID` 与环境嗅探解析一次;检测辅助函数在 `(env, platform)` 上是纯函数,可单元测试。

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 默认值。优先级:用户选择退出(`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`)→ 用户强制开启(`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`)→ `TERM_FEATURES` 声明 `Sy` → `WT_SESSION` → 已知的直接终端 → 对有风险的多路复用器与未知终端关闭。运行时由 DECRQM mode-2026 报告协调;用户覆盖仍然优先。
- `detectRectangularSgrSupport(id, env)` → DECCARA 填充:仅 kitty,在多路复用器与 `PI_NO_DECCARA` 下关闭。
- `supportsScreenToScrollback` → kitty 的 ED22(仅使用一次,在初始绘制时,以保留预先存在的 shell 屏幕)。

旧的 ED3 风险分类器(`eagerEraseScrollbackRisk`、`PI_TUI_ED3_SAFE`、`submitPinsViewportToTail`)已移除:行为不再依赖哪个终端在渲染,因此没有需要检测的风险类别。环境嗅探现在只选择_优化项_(同步输出、DECCARA、图像),漏判只是外观问题,不会造成损坏。

---

## 5. 宽度模型

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`(`utils.ts`)在**同一个 UAX#11 宽度模型**上达成一致。切片、截断、换行与片段提取在原生引擎(`@oh-my-pi/pi-natives`,Rust `unicode-width`)上运行;`visibleWidth` 使用**固定到同一模型**的 `Bun.stringWidth`(`STRING_WIDTH_OPTS`:`countAnsiEscapeCodes: false`、`ambiguousIsNarrow: true`)测量——这是共享原生宽度表的 JSC 内建函数,没有原生扫描器在 Bun 1.3.x 下会陷入的每次调用 N-API 装箱。两者绝不能不一致;在测量与切片之间混用未固定的宽度模型会导致崩溃。

- 快速路径:可打印 ASCII 每个代码单元占一个单元格。
- ASCII 前缀之后的内容通过 `Bun.stringWidth` 测量(CSI/OSC 剥离为零);制表符按固定的 `DEFAULT_TAB_WIDTH` 列加回。
- OSC 66 尺寸的跨度按 `scale × (explicit w ?? payload width)` 加回——否则 `Bun.stringWidth` 会把整个跨度剥离为零。

**规则:**任何新的测量代码都通过这些辅助函数路由,热路径限制而非抛出。已知残留:组合字符密集的脚本(阿拉伯语变音符号)能原样通过绘制,但 ghostty-web 的单元格回读可能使非间距标记在单元格间迁移——压力测试装置在剥离标记后比较这些行(`sameLinesAllowingMarkDrift`)。

---

## 6. 保真度关卡(务必使用)

`packages/tui/test/render-stress-harness.ts` 将渲染器的**真实发出的 ANSI** 送入 ghostty-web `VirtualTerminal`,跨越随机操作序列与参数化终端形态,并用**影子提交账本**验证契约:独立重实现 §1 的数学,仅以观察到的帧(`render` 包装)与观察到的字节(`write` 包装)为输入。每个操作断言:

- 整个磁带(滚动缓冲区 + 网格)逐行等于 `shadowTape + window slice`,包括跨调整大小;
- 已滚动的阅读者保持固定,可见的历史行永不重写;
- 多路复用器窗格历史恰好增长提交块的大小;
- 同步输出/自动换行括号纪律、光标停放、背景列、重复记账。

在更改账本数学、发射器或接缝之前运行它——以及 `render-regressions.test.ts`、`streaming-scrollback-defer.test.ts` 和 `issue-*-repro.test.ts` 文件。只通过一个终端和一个种子的更改不算验证通过。

---

## 7. 能力探测与 stdin 重组

`ProcessTerminal` 将能力查询与裸 DA1(`CSI c`)哨兵融合,因此当 DA1 先返回时即可检测出不响应的终端。回复可能**跨越一次 stdin 刷新被拆分**,因此:

- `#privateCsiResponseBuffer` 在哨兵未决时累积 `\x1b[?…` 部分,在终止字节处重新连接,然后在**完整的**回复上运行处理器。重组中途出现新的 `\x1b` 或超过 256 字节会放弃部分内容,以便真实按键仍能到达输入。
- `#da1SentinelOwners` 是一个按 `kind` 区分的**类型化 FIFO**,因此键盘 DA1 不会被误认为是 OSC 11 / DECRQM / 图形探测哨兵。
- DECRQM 探测(2026/2048/2031)驱动运行时功能门控。

**规则:**任何新探测都必须拥有类型化哨兵并能承受拆分的回复(在测试中逐字节喂入回复,断言没有内容泄漏到输入)。

---

## 8. 内联图像与内存

Kitty 图像是**一次传输、多次放置**(`kitty-graphics.ts`)。`ImageBudget` 只保持最近的 N 个图像存活;超过上限时,被降级图像的像素按 id 删除(`a=d,d=I`),其可见行通过普通窗口差异以文本回退重新渲染——**无破坏性重放**。已提交到历史的降级放置只是丢失像素(已提交行不可变),并且图形一旦渲染,文本回退是**保持高度**的(保留行 + 回退行),因此降级永远不会缩小块,也永远不会移动其下方已提交的内容。

**规则:**绝不要每帧重新发出完整的 base64。Kitty Unicode 占位符仅对 kitty/ghostty 默认开启(`PI_NO_KITTY_PLACEHOLDERS` / `PI_KITTY_PLACEHOLDERS`)。

---

## 9. 逃生舱(环境变量)

| 变量                                                      | 效果                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_NO_SYNC_OUTPUT=1`                                    | 禁用 DEC 2026 BSU/ESU 包装器(自动换行纪律保持开启)。                                                                                                                    |
| `PI_TUI_SYNC_OUTPUT=0\|1` / `PI_FORCE_SYNC_OUTPUT=1`     | 强制关闭 / 开启同步输出。                                                                                                                                               |
| `PI_NO_DECCARA`                                          | 禁用 Kitty DECCARA 矩形填充优化。                                                                                                                                       |
| `PI_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off`      | 覆盖图像协议检测。                                                                                                                                                      |
| `PI_NO_KITTY_PLACEHOLDERS=1` / `PI_KITTY_PLACEHOLDERS=1` | 强制关闭 / 开启 Kitty Unicode 占位符。                                                                                                                                  |
| `PI_HARDWARE_CURSOR=1`                                   | 显示真实硬件光标,而非渲染的光标。                                                                                                                                      |
| `PI_NOTIFICATIONS=off\|0\|false`                         | 抑制终端通知。                                                                                                                                                          |
| `PI_DEBUG_REDRAW=1`                                      | 将每帧选定的渲染意图 + 账本状态记录到调试日志。                                                                                                                         |
| `PI_TUI_RESIZE_IN_PLACE=1\|0`                            | 强制调整大小时原地重绘(不借用备用屏幕,不做 ED3 重排)开 / 关。对在备用屏幕切换时重新报告尺寸的终端(Warp)默认开启。                                                      |
| `PI_TUI_SCROLLBACK_REBUILD=1`                            | 初始化底层 `TUI` 差异重建为开启。Coding-agent 随后应用 `tui.scrollbackRebuild`(默认 `false`),因此交互式会话请使用该设置。                                              |

随旧引擎移除:`PI_TUI_ED3_SAFE`(不再存在 ED3 风险开关)、`PI_CLEAR_ON_SHRINK` 和 `PI_TUI_DEBUG`(逐渲染转储已被 `PI_DEBUG_REDRAW` 账本日志与压力测试装置的重放/缩减工具取代)。

---

## 10. 在改动渲染核心之前 —— 检查清单

- [ ] 你是否要在手势或受保护差异重建的现有 `clearScrollback` 全量绘制路径之外发出 `CSI 3 J`?**停止。**
- [ ] 普通发射器是否会重写 `committedRows` 之下的行?**停止。**
- [ ] 你的字节形态是否会滚动提交块未计入的行?那会破坏仅追加账本。
- [ ] 你是否在更新路径中添加视口探测、平台分支或终端品牌分支?契约的存在就是为了不需要它们。
- [ ] 编辑器上方有新的可变 UI?它必须报告(或位于)实时区域接缝内,否则会在首次提交时冻结。
- [ ] 你是否在完整场景矩阵上运行了压力测试装置与复现套件——而不只是一个终端和一个种子?
- [ ] 新的探测?类型化哨兵所有者 + 拆分回复测试。
- [ ] 新的宽度路径?通过共享原生引擎路由,在热路径中限制(绝不抛出)。
