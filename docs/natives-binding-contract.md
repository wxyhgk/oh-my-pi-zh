# Natives 绑定契约（JavaScript/TypeScript 侧）

本页定义 `@oh-my-pi/pi-natives` 调用方与其 N-API 插件之间的公共 JS/TS 边界。权威公共根表面是 `packages/natives/native/index.d.ts` 加上 `native/index.js` 中的显式 ESM 导出；其中未出现的 Rust 内部不属于包 API。

## 契约层

1. `crates/pi-natives/src/**/*.rs` 定义 `#[napi]` 函数、类、对象与枚举。
2. `bun --cwd=packages/natives run build:bindings` 运行 napi-rs，安装主机插件与生成的 `native/index.d.ts`，然后运行 `gen-enums.ts`。
3. `gen-enums.ts` 读取声明，将 napi-rs 的 `const enum` 声明重写为可运行时使用的声明，并用显式类/函数导出与字面量枚举对象替换 `native/index.js` 中的标记块。
4. `native/index.js` 加载插件并绑定该生成的根表面。

没有 `NativeBindings` 声明合并生命周期，也没有 `packages/natives/src/<module>` 包装器约定。加载器只为安装/编译加载校验发布版本哨兵，而非每个公共符号。

## 公共入口点

`packages/natives/package.json` 导出：

| 入口                            | 公共值                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@oh-my-pi/pi-natives`          | 来自 `native/index.js` / `index.d.ts` 的生成根类、函数与枚举对象。导入是急切的。                                         |
| `@oh-my-pi/pi-natives/desktop`  | `createDesktopSession(options): DesktopSession`；插件加载推迟到调用时。                                                  |
| `@oh-my-pi/pi-natives/clipboard`| `copyToClipboard(text)` 与 `readImageFromClipboard()` 加上 `ClipboardImage` 类型；插件加载推迟到调用时。               |

包消费者不要导入未导出的 `native/*` 实现路径。

## 按归属划分的当前根表面

| 类别                 | 代表性公共导出                                                                                                                                     | Rust 归属                                                            | 调用风格           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------ |
| 搜索与工作区         | `grep`、`search`、`hasMatch`、`fuzzyFind`、`glob`、`invalidateFsScanCache`、`listWorkspace`                                                       | `grep.rs`、`fd.rs`、`glob.rs`、`iofs.rs`、`workspace.rs`             | 同步/promise 混合  |
| AST 与代码结构       | `astGrep`、`astMatch`、`astEdit`、`blockRangeAt`、`enclosingBlockBoundaries`、`summarizeCode`                                                     | `ast.rs`、`block.rs`、`summary.rs`                                   | 同步/promise 混合  |
| 差异与向量           | `diffLines`、`diffWords`、`diffLineRuns`、`structuredPatchHunks`、`cosineSimilarityPairs`、`mmrRerankIndices`、`vectorIndexTopK`                  | `diff.rs`、`vectors.rs`                                              | 同步               |
| Shell 与 PTY         | `executeShell`、`Shell`、`PtySession`                                                                                                             | `shell.rs`、`pty.rs`                                                 | 类/promise         |
| 进程与文件           | `Process`、`FileLock`                                                                                                                             | `ps.rs`、`file_lock/mod.rs`                                          | 类/混合            |
| 桌面与剪贴板         | `DesktopSession`、`copyToClipboard`、`readImageFromClipboard`                                                                                     | `desktop/mod.rs`、`clipboard.rs`                                     | 类、同步、promise  |
| 音频与实时媒体       | `AudioCapture`、`AudioPlayback`、`LiveWebRtcPeer`                                                                                                 | `audio.rs`、`live.rs`                                                | 类/混合            |
| 文本与高亮           | `wrapTextWithAnsi`、`truncateToWidth`、`sliceWithWidth`、`extractSegments`、`visibleWidth`、`setHangulCompatJamoWidthOverride`、`highlightCode`、语言查询 | `text.rs`、`highlight.rs`                                       | 同步               |
| 转换与渲染           | `htmlToMarkdown`、`encodeSixel`、`renderSnapcompactPng`、`snapcompactSupportedChars`                                                              | `html.rs`、`sixel.rs`、`snapcompact.rs`                              | 同步/promise 混合  |
| Token 与系统         | `countTokens`、macOS appearance/power 导出、`getWorkProfile`、`deviceCheckGenerateToken`                                                          | `tokens.rs`、`appearance.rs`、`power.rs`、`prof.rs`、`devicecheck.rs`| 混合               |
| 隔离                 | `isoBackend`、`isoProbe`、`isoResolve`、`isoIsUnavailableError`、`isoStart`、`isoStop`、`isoDiff`                                                 | `iso.rs`                                                             | 同步/promise 混合  |
| 按键                 | `parseKey`、`matchesKey`、Kitty/legacy 辅助函数                                                                                                   | `keys.rs`                                                            | 同步               |

确切的选项/结果字段与签名见 `native/index.d.ts`。当前值得注意的签名包括 `renderSnapcompactPng(...): Promise<string>`、`readImageFromClipboard(): Promise<ClipboardImage | undefined | null>` 与类型化数组向量输入/结果。

## 同步、Promise 与回调规则

调用风格是公共契约的一部分：

- 计算密集/阻塞 API 通常通过 napi-rs 任务返回 promise，包括 `grep`、`glob`、`fuzzyFind`、AST 搜索/编辑、snapcompact 渲染与 HTML 转换。
- 基于 Tokio 的操作（如 shell、PTY、隔离生命周期、设备检查、桌面操作与实时媒体）在声明处使用 promise。
- 内存内转换与直接探测通常保持同步：`search`、`hasMatch`、块边界、文本/布局辅助函数、差异、向量排序、高亮、按键解析与隔离探测/解析辅助函数。
- 有状态资源是类。其构造函数与各方法可以有不同的同步/异步行为；使用声明而非假设整个类是异步的。

在同步与返回 promise 之间改变公共函数是破坏性变更。例如，`renderSnapcompactPng` 必须 await，尽管相邻的 snapcompact 字符探测是同步的。

由 napi-rs `ThreadsafeFunction` 生成的回调参数使用错误优先形状，如 `(error: Error | null, value) => void`。流式回调不取代所属的 promise/结果。其确切时机与可选性按导出声明。

## 对象、枚举与二进制数据

`#[napi(object)]` 结构体成为 TS 接口，如搜索结果、AST 负载、shell/PTY 结果、桌面选项/结果、音频/实时事件与隔离记录。napi-rs 拥有运行时转换；TypeScript 可选性不给无类型调用方提供语义校验。

生成的运行时枚举对象目前为：

- `AstMatchStrictness`
- `Ellipsis`
- `Encoding`
- `FileType`
- `GrepOutputMode`
- `IsoBackendKind`
- `IsoChangeKind`
- `KeyEventType`
- `MacOSAppearance`
- `ProcessStatus`

数字与字符串枚举声明约束 TypeScript 调用方，但本身不证明任意无类型值在语义上有效。二进制 API 在声明处使用类型化数组（`Uint8Array`、`Float32Array`、`Float64Array`、`Uint32Array`）；未经显式转换不要用普通数组替换。

## 导入与错误行为

- 如果无兼容插件候选可加载，导入根会抛出。惰性 desktop/clipboard 子路径将该失败推迟到包装器被调用时。
- 缺少预期版本哨兵的安装与编译候选在加载期间被拒绝。工作区开发候选跳过哨兵校验。
- 驻留的旧版本插件可能产生特定于重启的不匹配；磁盘上的过期文件产生重装诊断。
- 加载器不检查完整导出集。因此，同版本的残缺构建可以加载并在之后暴露 `undefined` 成员。
- N-API 转换错误在 Rust 业务逻辑运行之前抛出或拒绝。原生任务与异步失败拒绝其返回的 promise。

## 绑定变更清单

1. 添加或更改归属 Rust `#[napi]` 项；在 `crates/pi-natives/src/lib.rs` 中注册新模块。
2. 导出类型表面变化时运行 `bun --cwd=packages/natives run build:bindings`。这是声明/本地插件路径；常规 `build` 脚本是 Bazel 发布插件路径。
3. 确认 `native/index.d.ts` 具有预期的 JS 名称、类型、可选性、回调形状与同步/promise 返回。
4. 确认 `native/index.js` 中的标记块包含类/函数与任何枚举运行时对象。
5. 仅当需要延迟加载时添加惰性子路径包装器，然后添加匹配的 `package.json#exports` 运行时/类型条目。
6. 更新所有直接消费者，并在原生路径成为规范时移除过时实现。
7. 运行一个针对新构建插件导入并调用变更导出的聚焦场景。
