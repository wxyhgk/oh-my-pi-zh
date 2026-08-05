# grep

> 使用正则表达式在文件、目录、glob 与内部 URL 中搜索文件内容。

## 来源
- 入口:`packages/coding-agent/src/tools/grep.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/grep.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/match-line-format.ts` — 面向模型的锚点格式化。
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径规范化、glob 拆分、内部 URL 解析。
  - `packages/coding-agent/src/tools/file-recorder.ts` — 分组输出的文件排序。
  - `packages/coding-agent/src/tools/grouped-file-output.ts` — 按文件分组的文本布局。
  - `packages/coding-agent/src/session/streaming-output.ts` — 行截断与最终字节截断。
  - `packages/coding-agent/src/config/settings-schema.ts` — 默认上下文行数。
  - `packages/natives/native/index.d.ts` — 暴露给 TS 的原生 `grep()` 类型。
  - `crates/pi-natives/src/grep.rs` — 原生正则/文件搜索实现。
  - `docs/natives-text-search-pipeline.md` — 原生搜索流水线概述。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pattern` | `string` | 是 | 正则表达式模式。`grep.ts` 会拒绝纯空白输入,但会原样保留它。原生匹配器先尝试 Rust regex,再对诸如环视(lookaround)/反向引用等特性尝试 PCRE2,然后对格式错误的括号/圆括号做定向字面量恢复。仅当模式包含字面换行符或两个字符的序列 `\\n` 时才启用多行模式。 |
| `path` | `string` | 否 | 文件、目录、glob、归档成员、内部 URL、抓取的 URL,或单文件行选择器,如 `src/foo.ts:50-100`。多个根用 `;` 分隔。省略或为空时默认为 `.`。已存在且包含分号的路径保持原样;内部 URL 不能包含 glob 字符。 |
| `case` | `boolean` | 否 | 区分大小写的搜索。默认为 `true`。传递给原生 `ignoreCase` 或用于虚拟资源的 JS `RegExp` 标志。 |
| `gitignore` | `boolean` | 否 | 目录扫描期间是否遵循 `.gitignore`。默认为 `true`。 |
| `skip` | `number \| null` | 否 | 多文件结果的文件页偏移。默认为 `0`;有限值会向下取整,负数/非有限值会失败。单文件搜索忽略它。 |

`grep` 默认启用(`grep.enabled = true`),属于可发现工具而非必备工具。上下文默认值可通过 `grep.contextBefore` 和 `grep.contextAfter` 配置。

## 输出
该工具在 `content[0].text` 中返回单个文本块,外加结构化 `details`。

- 在 hashline 模式下,匹配行由 `formatMatchLine()` 格式化为 `*LINE:content`(匹配)与 ` LINE:content`(上下文),位于 `[PATH#TAG]` 头部之下。
  - Hashline 模式:`[src/login.ts#1F2A]`、`*5:content`、` 9:content`。
  - Plain 模式:`*5|content`、` 9|content`。
- 目录与多文件结果通过 `formatGroupedFiles()` 以多层、前缀折叠的目录树形式分组:每层嵌套一个 `#`,目录头部以 `/` 结尾,当可编辑的 hashline 锚点可用时文件头部带有 `#TAG` 后缀。
- `details` 可能包含:
  - `scopePath` — 格式化后的搜索范围。
  - `matchCount`、`fileCount`、`files`、`fileMatches` — 返回页面的各项计数。
  - `fileLimitReached` — 当前 20 文件页之外还有更多匹配文件。
  - `perFileLimitReached` — 某个热点文件被裁剪到单文件匹配上限。
  - `linesTruncated` — 一行或多行匹配被缩短到 `512` 字符并附加 `…`。
  - `truncated` 和 `meta.truncation` — 最终文本输出被 `truncateHead()` 头部截断。
  - `displayContent` — 仅 TUI 使用的渲染文本,用 `│` 边线而非模型锚点。
  - `missingPaths` — 因基路径不存在而被跳过的多路径条目。
- 无匹配的结果文本为 `No matches found`(当 `skip` 指向最后一个文件页之后时为 `No more results (...)`),可选地后跟被跳过的缺失路径、不可读归档或超大文件提示。

## 流程
1. `GrepTool.execute()` 在 `packages/coding-agent/src/tools/grep.ts` 中校验并规范化输入:
   - 拒绝纯空白模式,同时原样保留该模式;
   - 省略或为空的 `path` 默认为 `.`,拆分分号分隔的根,同时保留已存在的包含分隔符的路径;
   - 将 `skip` 规范化为非负整数;
   - 从每个根上剥离任何行范围选择器;
   - 从会话设置中读取 `grep.contextBefore` 和 `grep.contextAfter`(默认分别为 `1` 和 `3`);
   - 仅当 `pattern` 包含 `\n` 或实际换行符时启用多行模式。
2. 在共享范围解析期间,每个 `path` 根会再次用 `normalizePathLikeInput()` 规范化;对于已由分隔符展开规范化的条目,这是无操作。
3. 类似 `bundle.zip:src/foo.ts` 的归档成员路径会在原生 grep 之前物化为临时 UTF-8 暂存文件。二进制或非 UTF-8 归档成员会被报告为已跳过/不可读。
4. 内部 URL 在文件系统范围解析之前解析:
   - 内部 URL 拒绝 glob 元字符(`*`、`?`、`[`、`{`);
   - 带 `sourcePath` 的资源通过其后备文件搜索;
   - 不带 `sourcePath` 的资源在内存中用 JavaScript `RegExp` 搜索;
   - `omp://` 通过 URL 补全展开为每个内嵌文档文件;
   - 跟踪不可变来源,以便输出可按文件抑制可编辑的 hashline 编号输出。
5. 对于多路径调用,`partitionExistingPaths()` 仅跳过 ENOENT 条目。如果所有文件系统条目都缺失且没有剩余的虚拟内部资源,该工具会报错。
6. 路径解析分支:
   - 单条目:`parseSearchPath()` 拆分 `basePath` 与可选的 glob;
   - 多条目:`resolveExplicitSearchPaths()`(通过 `resolveToolSearchScope()`)计算公共基目录、花括号并集 glob、精确文件列表或逐条目目标列表。当公共祖先本身不是所请求的范围,或普通文件条目本会被降级进目录遍历的 glob 并集时,目标会展开(`fanOutFileTargets`)。
7. 行范围选择器在路径/归档/内部解析之后校验。它们仅允许用于单文件、归档成员或虚拟资源;glob/目录的行范围选择器会报错。
8. `grep.ts` 对解析后的基路径执行 stat,以决定文件还是目录行为。
9. 它用以下参数调用来自 `@oh-my-pi/pi-natives` 的原生 `grep()`:
   - `pattern`、`ignoreCase`、`multiline`、`gitignore`;
   - `hidden: true`;
   - `cache: false`;
   - 来自设置的 `contextBefore` / `contextAfter`;
   - `maxColumns: DEFAULT_MAX_COLUMN`(`512`);
   - `maxCount: INTERNAL_TOTAL_CAP`(`2000`);
   - `maxCountPerFile`:单文件匹配上限加一;
   - `mode: content`;
   - 组合的中止 `signal` 与 `timeoutMs: SEARCH_GREP_TIMEOUT_MS`(`30_000`)。
10. 原生执行发生在 `crates/pi-natives/src/grep.rs`:
    - `build_matcher()` 清理非量词花括号,并首先尝试 Rust regex 引擎;
    - Rust regex 不支持的模式(包括环视/反向引用)用 PCRE2 重试;
    - 组平衡错误用字面圆括号重试;如果两个引擎仍然拒绝该模式,则按字面搜索原始模式。
11. grep 分发因解析后的路径集而异:
    - 精确的显式文件或展开的多目标:JS 遍历目标,自行合并 `grep()` 结果,并按绝对路径 + 行号对重叠目标去重;
    - 单文件/目录基:一次 `grep()` 调用处理原生扫描。
12. 虚拟内部资源在 JS 中用 `RegExp` 搜索;归档暂存路径和虚拟路径在渲染前会被重新映射回面向用户的选择器。
13. 随后 JS 输出整形会:
    - 将多文件输出限制为每页 20 个文件(`DEFAULT_FILE_LIMIT`),以 `skip` 作为下一个文件偏移;
    - 将单文件匹配数限制为多文件范围 20、单文件范围 200;
    - 轮询分配所选文件间的匹配,使单个文件不会独占页面;
    - 通过 `formatMatchLine()` 为模型格式化行,通过 `formatCodeFrameLine()` 为 TUI 格式化;
    - 在 hashline 模式下,用 `recordFileSnapshot()` 为每个渲染的文件记录整文件快照,以生成 `#TAG` 锚点(归档、虚拟和不可变路径会被跳过)。
14. 最终文本通过 `truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })` 处理,因此有效上限是来自 `streaming-output.ts` 的默认字节上限,而非默认行数上限。
15. `toolResult()` 附加文本以及限制/截断元数据。

## 模式 / 变体
1. **单文件路径**
   - `grep()` 搜索单个文件。
   - 输出是匹配/上下文行的扁平列表。
   - 可见限制是原生匹配与 JS 单文件上限之后的 `200` 个匹配。
2. **单目录路径或单一类 glob 路径**
   - `parseSearchPath()` 可能将输入拆分为 `path` + `glob`。
   - 一次原生 `grep()` 以 `gitignore` 和 `hidden:true` 扫描目录树。
   - 结果分组为 20 文件页;请使用限制消息中显示的下一个文件偏移配合 `skip`。
   - JS 轮询分配所选文件的匹配。
3. **多个显式路径/glob**
   - `resolveExplicitSearchPaths()` 将它们折叠为公共基,并生成花括号并集 glob、显式文件列表或逐目标搜索(当公共祖先本身不是所请求的范围,或普通文件条目本会被降级进目录遍历时)。
   - 缺失条目被非致命地跳过,除非全部缺失。
4. **归档成员路径**
   - 仅支持 UTF-8 文本条目。成员会被提取到临时暂存文件供原生 grep 使用,然后显示为 `archive.ext:member`。
5. **内部 URL 路径**
   - 基于文件系统的资源搜索其解析后的 `sourcePath`。
   - 没有 `sourcePath` 的虚拟资源在内存中搜索其解析后的内容。
   - `omp://` 展开为所有内嵌文档文件,因此可用作文档搜索根。
   - 不支持内部 URL glob。
   - 不可变与虚拟来源会抑制可编辑的 hashline 锚点。

## 副作用
- 文件系统
  - 对解析后的搜索根和输入路径执行 stat。
  - 通过原生 `grep()` 读取匹配文件。
  - 通过 `recordFileSnapshot()` 将整文件快照记录到会话文件快照存储中,供 hashline 锚点使用。
- 会话状态(记录、记忆、任务、检查点、注册表)
  - 读取会话设置以获取上下文默认值。
  - 使用 `session.internalRouter` 解析内部 URL。
  - 用截断/限制元数据填充工具 `details.meta`。
- 后台工作 / 取消
  - 在 JS 层用 `untilAborted(signal, ...)` 包装。
  - `grep.ts` 将中止 `signal` 与 `timeoutMs: SEARCH_GREP_TIMEOUT_MS`(`30_000`)传入原生 `grep()`,因此原生扫描可取消且有时间限制。

## 限制与上限
- 文件页限制:`20` 个文件(`DEFAULT_FILE_LIMIT`,位于 `packages/coding-agent/src/tools/grep.ts`)。
- 单文件匹配上限:多文件范围 `20`(`MULTI_FILE_PER_FILE_MATCHES`),单文件范围 `200`(`SINGLE_FILE_MATCHES`)。
- 原生/JS 预选上限:`2000` 个匹配(`INTERNAL_TOTAL_CAP`)。
- 行截断:每条输出行 `512` 字符(`DEFAULT_MAX_COLUMN`,位于 `packages/coding-agent/src/session/streaming-output.ts`)。原生 grep 标记被截断的行;JS 报告 `linesTruncated`。
- 最终文本截断:`truncateHead()` 默认字节上限 `50 * 1024` 字节(`DEFAULT_MAX_BYTES`,位于 `packages/coding-agent/src/session/streaming-output.ts`)。`grep.ts` 将 `maxLines` 覆盖为 `Number.MAX_SAFE_INTEGER`,因此正常的 grep 输出受字节上限而非行数上限约束。
- 上下文默认值:`grep.contextBefore = 1`、`grep.contextAfter = 3`,位于 `packages/coding-agent/src/config/settings-schema.ts`。
- 分页:`skip` 是多文件范围的文件页偏移。当还有更多文件时,结果文本显示 `Use skip=<N> for the next page`。
- 原生目录扫描缓存:在 `grep.rs` 中可用,但该工具始终设置 `cache: false`。
- 原生 grep 墙钟时间预算:每次调用 `30_000ms`(`SEARCH_GREP_TIMEOUT_MS`,位于 `packages/coding-agent/src/tools/grep.ts`);达到该预算会抛出 `Grep timed out after 30s; ...`。
- 原生单文件大小上限:`4 * 1024 * 1024` 字节(`MAX_FILE_BYTES`,位于 `crates/pi-natives/src/grep.rs`,在 `grep.ts` 中镜像为 `NATIVE_GREP_MAX_FILE_BYTES`)。超大的文件系统文件会被跳过,并以部分覆盖的形式呈现(显式文件给出名称,目录扫描给出计数)。超大的虚拟资源在行模式下按行边界分块搜索;多行虚拟搜索回退到 JavaScript 正则。

## 错误
- 当修剪后的 `pattern` 为空时:`Pattern must not be empty`。
- 对于负数或非有限的 `skip`:`Skip must be a non-negative number`。
- 当规范化后的根为空时:`` `path` must contain non-empty paths or globs ``。
- 内部 URL + glob 元字符:`Glob patterns are not supported for internal URLs: ...`。
- 行范围选择器错误包括 `Line-range selector requires a single file, not a glob: ...`、`Line-range selector requires a single file: ... is a directory` 和 `Path not found for line-range selector: ...`。
- 当所有归档选择器都不可读、为二进制或非 UTF-8 时:`Cannot search archive member(s): ...`。
- 当基于文件系统的解析后基路径缺失,或所有多根文件系统条目都缺失时(若有不可读的归档成员参与,则附带归档提示):`Path not found: ...; list each target in the semicolon-delimited \`path\``。
- 虚拟资源 JavaScript 正则编译可能报告 `Invalid regex: ...`。基于文件系统的原生搜索通常从 Rust regex 回退到 PCRE2,最后回退到字面模式,而不是拒绝正则语法。
- 多文件原生扫描会跳过 `grep.rs` 内部的逐文件打开/搜索失败;扫描会继续处理幸存的文件。
- 当原生 grep 达到 `SEARCH_GREP_TIMEOUT_MS` 时:``Grep timed out after 30s; narrow paths or pattern, or scope with `glob` first``。

## 备注
- 基于文件系统的搜索先使用 Rust regex,当模式需要环视或反向引用等特性时使用 PCRE2。虚拟内存资源使用 JavaScript `RegExp`。
- 原生 `build_matcher()` 会自动转义不能作为有效量词的花括号。诸如 `a{2,4}` 的有效量词仍保持正则语法。
- 如果 Rust regex 和 PCRE2 都拒绝组语法,原生编译会在转义未转义的圆括号后重试,最后将原始模式按字面处理。
- 内部 URL 在路径存在性检查之前解析。有后备的资源变为普通文件系统路径;虚拟资源保留在内存中,不生成可编辑的 hashline 锚点。
- `hidden:true` 在 `grep.ts` 中硬编码;没有面向模型的标志可排除点文件。
- `gitignore:false` 仅影响原生目录遍历。它不会禁用工具自身的路径规范化或显式文件处理。
- 当 `path` 解析为多个精确文件时,每个目标在 JS 分组前使用 `2000` 内部上限。
- hashline 模式下的节标签是来自会话快照存储的四位十六进制不透明快照标签;`grep` 尽可能记录整文件快照,并在头部下方打印裸行号。
