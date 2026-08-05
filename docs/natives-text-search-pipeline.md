# Natives 文本/搜索流水线

本文档将 `@oh-my-pi/pi-natives` 的文本/搜索/代码表面从生成的 JS/TS 导出映射到 Rust N-API 模块,再映射回 JS 结果对象。

术语遵循 `docs/natives-architecture.md`:

- **生成绑定**:`packages/natives/native/index.d.ts` 中的公共 API。
- **Rust 模块层**:`crates/pi-natives/src/*` 中的 N-API 导出。
- **共享扫描缓存**:可选的 `pi-walker` 目录条目缓存,用于发现流程。

## 实现文件

- `packages/natives/native/index.d.ts`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/glob_util.rs`
- `crates/pi-natives/src/iofs.rs`
- `crates/pi-walker/src/lib.rs`
- `crates/pi-walker/src/cache.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/tokens.rs`

## JS API ↔ Rust 导出映射

| JS API                                                                          | Rust 导出(`#[napi]`,snake_case -> camelCase) | Rust 模块     |
| ------------------------------------------------------------------------------- | ---------------------------------------------- | ------------- |
| `grep(options, onMatch?)`                                                       | `grep`                                         | `grep.rs`     |
| `search(content, options)`                                                      | `search`                                       | `grep.rs`     |
| `hasMatch(content, pattern, ignoreCase?, multiline?)`                           | `hasMatch`                                     | `grep.rs`     |
| `fuzzyFind(options)`                                                            | `fuzzyFind`                                    | `fd.rs`       |
| `glob(options, onMatch?)`                                                       | `glob`                                         | `glob.rs`     |
| `invalidateFsScanCache(path?)`                                                  | `invalidateFsScanCache`                        | `iofs.rs`     |
| `astGrep(options)`                                                              | `astGrep`                                      | `ast.rs`      |
| `astMatch(options)`                                                             | `astMatch`                                     | `ast.rs`      |
| `astEdit(options)`                                                              | `astEdit`                                      | `ast.rs`      |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrapTextWithAnsi`                             | `text.rs`     |
| `truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth)`                      | `truncateToWidth`                              | `text.rs`     |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `sliceWithWidth`                               | `text.rs`     |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extractSegments`                              | `text.rs`     |
| `visibleWidth(text, tabWidth)`                                                  | `visibleWidth`                                 | `text.rs`     |
| `setHangulCompatJamoWidthOverride(value)`                                       | `setHangulCompatJamoWidthOverride`             | `text.rs`     |
| `highlightCode(code, lang, colors)`                                             | `highlightCode`                                | `highlight.rs`|
| `supportsLanguage(lang)`                                                        | `supportsLanguage`                             | `highlight.rs`|
| `getSupportedLanguages()`                                                       | `getSupportedLanguages`                        | `highlight.rs`|
| `countTokens(input, encoding?)`                                                 | `countTokens`                                  | `tokens.rs`   |

## 按子系统的流水线概览

## 1) 正则搜索(`grep`、`search`、`hasMatch`)

### 输入/选项流

1. 调用方直接调用生成的原生导出;没有将 `search` 重命名为 `searchContent` 的包本地 TS 包装层。
2. `grep.rs` 中的 Rust 选项结构体反序列化 camelCase 字段,包括 `ignoreCase`、`maxCount`、`maxCountPerFile`、`contextBefore`、`contextAfter`、`maxColumns` 与 `timeoutMs`。
3. `grep` 从 `timeoutMs` + `AbortSignal` 创建 `CancelToken`,并在 `task::blocking("grep", ...)` 内运行。文件系统 grep 不暴露也不使用共享 walker 缓存。
4. `search` 与 `hasMatch` 操作于提供的字符串/`Uint8Array` 内容,不扫描文件系统。

### 执行分支

- **内存分支**
  - `search` -> 在提供的内容字节上执行 `search_sync` / 搜索辅助函数。
  - `hasMatch` 针对提供的内容编译/检查模式并返回布尔值。
  - 无文件系统扫描或 walker 缓存。
- **单文件分支**
  - `grep` 解析路径,检查元数据为文件,并搜索该文件。
- **目录分支**
  - 候选发现使用不带扫描缓存的 `pi-walker`。
  - Walker 策略应用 hidden/gitignore 设置,并跳过可跳过的目录错误。
  - 条目筛选:仅文件 + 可选 glob 筛选(`glob_util`)+ 可选类型筛选映射(`js`、`ts`、`rust` 等)。

### 搜索/收集语义

- 匹配器选择:先尝试 Rust 正则引擎,再尝试 PCRE2 以支持 lookaround/backreference 等特性。`OMP_PCRE2_JIT=0`/`false` 禁用 PCRE2 JIT,`1` 启用;未设置时,除 macOS 外 JIT 均启用。
- 上下文解析:
  - `contextBefore/contextAfter` 覆盖旧版 `context`。
  - 非内容模式不收集上下文。
- 输出模式:
  - `content` -> 每个命中一个 `GrepMatch`。
  - `count` 与 `filesWithMatches` 映射为计数式条目(`lineNumber=0`、`line=""`、设置 `matchCount`)。
  - `offset` 与 `maxCount` 在跨排序文件结果聚合期间应用;`maxCountPerFile` 可额外防止单个热文件消耗内容模式预算。
  - 目录搜索使用并行文件系统遍历/搜索,然后聚合每个文件的结果以保持全局 offset/limit 语义。小型有序回调流可能提前停止;较大流使用有界有序窗口。

### 返回 JS 的结果整形

- Rust `SearchResult`/`GrepResult` 字段通过 N-API 对象转换映射到 TS 接口。
- 计数器在需要时跨越 N-API 前被钳制。
- `GrepResult.limitReached` 是可选的,为 true 时才发出;`skippedOversized` 报告因超过 4 MiB 限制而跳过的文件。
- 流式回调为 content 或计数式条目接收每个整形后的 `GrepMatch`。

### 失败行为

- `search` 对正则/搜索失败返回 `SearchResult.error` 而不是抛出。
- `grep` 对硬错误(如无效路径或取消超时/中止)拒绝。被两个正则引擎都拒绝的模式回退为字面量搜索,而不是产生正则错误。
- `hasMatch` 成功时返回布尔值;匹配器构造使用相同的容忍回退。
- 多文件扫描中不可读/非普通文件被跳过;超大文件计入 `skippedOversized`。

### 畸形正则处理

`grep.rs` 在正则编译前净化花括号:

- 当无法构成 `{N}`、`{N,}`、`{N,M}` 时,无效的类似重复的花括号被转义(`{`/`}` -> `\{`/`\}`)。
- 这防止常见字面量模板片段(例如 `${platform}`)作为畸形重复而失败。
- 未闭合/未开启分组导致的编译失败会触发一次针对性重试:转义未转义的括号,同时保留正则其余部分。
- 如果两个引擎仍然拒绝该模式,则整个原始模式被转义并按字面量搜索。

## 2) 文件发现(`glob`)与模糊路径搜索(`fuzzyFind`)

`glob` 与 `fuzzyFind` 共享可选的 `pi-walker` 扫描缓存;匹配逻辑不同。两个 API 的缓存使用默认均为 `false`。

### `glob` 流程

1. 调用方直接传入 `GlobOptions`。生成的类型中 `pattern` 与 `path` 为必填。
2. Rust 解析搜索路径并通过 `glob_util::compile_glob` 编译模式。
3. 条目来源:
   - `cache=true` -> 共享 walker 缓存 + 可选的过期空结果重扫。
   - `cache=false` -> 全新扫描,既不读取也不更新缓存。
4. 筛选:
   - 总是跳过 `.git`;
   - 除非请求(`includeNodeModules`)或模式提及 `node_modules`,否则跳过 `node_modules`;
   - 应用 glob 匹配;
   - 应用文件类型筛选;symlink `file`/`dir` 筛选解析目标元数据。
5. 截断到 `maxResults` 前可选按 mtime 降序排序(`sortByMtime`)。

### `fuzzyFind` 流程

1. Rust 实现位于 `fd.rs`;生成的导出为 `fuzzyFind`。
2. 共享 `pi-walker` 扫描源,采用相同的可选缓存与过期空结果重查策略。
3. 评分:
   - 精确 / 前缀 / 包含 / 基于子序列的模糊评分;
   - 分隔符/标点归一化评分路径;
   - 目录加分与确定性平局决胜(`score` 降序,然后 `path` 升序)。
4. symlink 条目从模糊结果中排除。

### 失败行为

- 无效 glob 模式从 `glob_util::compile_glob` 返回错误。
- 目录发现流程的搜索根必须解析为存在的目录。
- 取消/超时通过调用方提供的 walker heartbeat 与结果处理检查以中止错误形式传播。

### 畸形 glob 处理

`glob_util::build_glob_pattern` 是容忍的:

- 将 `\` 归一化为 `/`,
- 当 `recursive=true` 时为简单递归模式自动添加 `**/` 前缀,
- 编译前自动闭合不平衡的 `{...` 交替组。

## 3) AST 搜索/匹配/编辑(`astGrep`、`astMatch`、`astEdit`)

`ast.rs` 暴露语法感知的代码搜索与重写操作。

- `astGrep(options)` 返回带字节/行/列坐标与可选元变量绑定的匹配。
- `astMatch(options)` 对内存中的 `source` 字符串而非文件运行相同的模式;`lang` 为必填(没有路径可推断它),结果保留 matches、`totalMatches`、`limitReached` 与解析错误,但省略文件计数字段。
- `astEdit(options)` 返回替换更改、每文件计数、搜索/触及文件计数、解析错误,以及编辑是否被应用。
- 生成文档中编辑选项的 `dryRun` 默认为 true。
- 选项包括语言覆盖、path/glob/selector、严格度、限制、解析错误策略、`signal` 与 `timeoutMs`。
- 对 `astGrep` 与 `astEdit`,目录 `path` 使用带配置过期空结果重查的共享缓存进行候选发现;直接文件 `path` 返回该文件,不做遍历或缓存访问。`astMatch` 保持内存内。

这些导出是工具使用的直接原生 API;它们不经由 `packages/natives` 中的 TS 包装层。

## 4) 共享扫描/缓存生命周期(`pi-walker`)

`pi-walker` 拥有遍历与缓存策略。`crates/pi-natives/src/iofs.rs` 仅包含面向 JavaScript 的 DTO 转换、错误映射与失效导出。

缓存存储规范化的相对条目(`path`、`fileType`、可选 `mtime` 与普通文件 `size`),以规范化搜索根加有效的遍历级 `WalkOptions` 为键:hidden/gitignore 与目录剪枝策略、链接跟随、元数据细节、遍历顺序/深度、根发射、目录错误处理、文件系统边界与缓存模式。`WalkFilter` 谓词、排序与结果限制在收集之后运行,不独立划分缓存,因此具有不同 glob、文件类型、大小阈值或限制值的请求可以共享条目。需要额外元数据的筛选器或排序器仍可提升有效细节策略,从而选择不同的键。

配置从环境读取一次:

- `FS_SCAN_CACHE_TTL_MS`:缓存 TTL,默认 `1000`。
- `FS_SCAN_EMPTY_RECHECK_MS`:缓存空结果重查年龄,默认 `200`。
- `FS_SCAN_CACHE_MAX_ENTRIES`:缓存映射中的最大条目数,默认 `16`。
- `PI_WALK_WORKERS`:walker Rayon 池大小,默认 `4`。

### 缓存状态转换

1. **禁用 / 未命中 / 过期**
   - 禁用请求全新收集,不读取也不更新缓存;
   - 启用的未命中与达到或超过 TTL 的条目全新收集并填充缓存。
2. **命中**
   - 年轻于 TTL 的条目返回缓存条目与缓存年龄。
3. **过期空结果重查**
   - 当调用方启用配置的重查时,达到或超过阈值的空缓存查询被再次扫描一次。
4. **失效**
   - `invalidateFsScanCache()` 清除所有键;
   - `invalidateFsScanCache(path)` 移除包含该路径的缓存根。

缓存偏向低延迟的重复扫描,而非即时一致性。写入、编辑、重命名或删除之后,显式失效是正确性钩子。

## 5) ANSI 文本工具(`text`)

这些是纯内存工具。

### 边界与职责

- `text.rs` 拥有终端单元格语义:
  - ANSI 序列解析,
  - 字形感知的宽度与切片,
  - wrap/truncate/slice 行为,
  - 宽度敏感 API 上的显式 tab 宽度参数。
- `grep.rs` 的行截断(`maxColumns`)是独立的:
  - 用 `...` 对匹配行进行简单字符边界截断,
  - 不保持 ANSI 状态,也不感知终端单元格宽度。

### 关键行为

- `wrapTextWithAnsi`:按可见宽度换行,将活动 SGR 码携带到换行后的行。
- `truncateToWidth`:带省略号策略(`Unicode`、`Ascii`、`Omit`)的可见单元格截断,可选右侧填充。
- `sliceWithWidth`:列切片,可选严格宽度强制。
- `extractSegments`:围绕覆盖层提取前后段,同时为 `after` 段恢复 ANSI 状态。
- `setHangulCompatJamoWidthOverride(value)` 控制 U+3131–U+318E 的宽度修正,以兼容客户端终端:`0` 使用平台回退,`1` 强制一单元格,`2` 强制两单元格,`3` 遵循 Unicode 宽度。
- `visibleWidth`:使用调用方提供的 tab 宽度计数可见终端单元格。

### 失败行为

文本函数通常返回确定性转换输出;错误仅限于 N-API 参数/字符串转换边界。

## 6) 语法高亮(`highlight`)

`highlight.rs` 是纯转换;不使用文件系统扫描缓存。

### 流程

1. 调用方传入 `code`、可选 `lang` 与 ANSI 调色板。
2. Rust 按 token/名称查找、扩展名查找、别名表回退,然后纯文本回退解析语法。
3. 每一行用 syntect `ParseState` 与作用域栈解析。
4. 作用域映射到语义颜色类别,并注入/重置 ANSI 颜色码。

### 失败行为

- 单行解析失败不会使调用失败:该行以无高亮附加,处理继续。
- 未知/不支持的语言回退为纯文本语法。

## 7) Token 计数(`tokens`)

`countTokens(input, encoding?)` 是内存工具。

- `input` 可以是单个字符串或字符串数组。
- 数组返回一个聚合计数,并在 Rust 中并行编码。
- 默认编码为 `O200kBase`;`Cl100kBase` 也可用。
- 实现使用普通 token 化,不处理特殊 token。

## 纯工具与依赖文件系统的流程

| 流程                          | 文件系统访问 | 共享缓存              | 说明                                                                  |
| ----------------------------- | ------------ | --------------------- | --------------------------------------------------------------------- |
| `search` / `hasMatch`         | 否           | 否                    | 仅对提供的字节/字符串执行正则                                         |
| `text` 模块函数               | 否           | 否                    | 仅 ANSI/宽度工具                                                      |
| `highlight` 模块函数          | 否           | 否                    | 仅语法 + ANSI 着色                                                    |
| `countTokens`                 | 否           | 否                    | 仅 token 化                                                           |
| `astMatch`                    | 否           | 否                    | 内存内语法感知匹配(无磁盘)                                           |
| `astGrep` / `astEdit`         | 是           | 是(目录发现)          | 目录路径使用缓存遍历;直接文件路径绕过它                              |
| `glob`                        | 是           | 可选                  | 目录扫描 + glob 筛选                                                  |
| `fuzzyFind`                   | 是           | 可选                  | 目录扫描 + 模糊评分                                                   |
| `grep`(文件/目录路径)        | 是           | 否                    | walker 发现 + 正则搜索,可选筛选器/回调                               |

## 端到端生命周期摘要

1. 调用方以类型化选项调用生成的原生导出。
2. Rust 验证/规范化选项并构建匹配器/搜索配置。
3. 对文件系统流程,条目被扫描(适用时缓存命中/未命中/重扫),然后被筛选/评分/搜索。
4. Worker 循环周期性地调用取消 heartbeat;超时/中止可终止执行。
5. Rust 将输出整形为 N-API 对象(`lineNumber`、`matchCount`、`limitReached` 等)。
6. 生成绑定为 `grep`/`glob` 返回类型化 JS 对象与可选的逐匹配回调。
