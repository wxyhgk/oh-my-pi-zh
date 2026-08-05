# 文件系统扫描缓存架构契约

本文档定义了由 `crates/pi-walker` 实现、并被暴露给 `packages/coding-agent` 的原生发现 API 所使用的共享 Rust 文件系统扫描缓存。

## 归属与数据模型

缓存位于 `crates/pi-walker/src/cache.rs`。它存储目录遍历得到的自有 `CollectedEntry` 列表,而不是最终的 glob、模糊匹配、grep 或 AST 结果。`crates/pi-walker/src/lib.rs` 中的 `WalkRequest` 在该收集层之上应用静态筛选、排序、限制以及可选的空结果重新校验。

当前的原生消费者:

- `crates/pi-natives/src/glob.rs` — 通过 `GlobOptions.cache` 选择启用
- `crates/pi-natives/src/fd.rs`(`fuzzyFind`)— 通过 `FuzzyFindOptions.cache` 选择启用
- `crates/pi-natives/src/ast.rs`(`astGrep` / `astEdit` 发现)— 目录操作数始终缓存

`crates/pi-natives/src/grep.rs` 使用 `WalkRequest` 进行候选发现,但明确设置 `.cache(false)`;当前公开的 `GrepOptions` 没有 cache 字段。

公开的失效绑定仍是 `packages/natives/native/index.d.ts` / `index.js` 中的 `invalidateFsScanCache(path?)`。Coding-agent 的修改辅助函数位于 `packages/coding-agent/src/tools/fs-cache-invalidation.ts`。

## 缓存键分区

每个缓存键由以下部分组成:

- 规范化后的根目录
- 完整的有效 `WalkOptions` 值,仅清除其 `cache` 位

因此所有影响遍历的选项都会对条目分区:隐藏文件和忽略策略、`.git` 与 `node_modules` 剪枝、符号链接策略、元数据详细程度、每目录顺序、根条目输出、最小/最大深度、内容优先遍历、目录错误策略以及同文件系统策略。在这些字段上存在任何差异的调用都不会共享一次扫描。特别是,`follow_links` **是**当前键的一部分。

高层的 `WalkRequest` 筛选、排序、结果上限、空结果复检策略和大小提示策略不会直接存储在键中。在收集之前,大小提示策略和最大文件大小筛选可能会将有效元数据详细程度提升为 `Full`,这会进一步对底层扫描分区。

## 收集行为

`pi-walker` 将相对根目录解析到当前 cwd,要求目标必须是已存在的目录,并尽可能对其规范化。`WalkOptions` 控制遍历;消费者显式选择自己的策略,而不是继承遍历器的每个默认值。

收集到的条目包含规范化的正斜杠相对路径和文件类型。`WalkDetail::Full` 额外请求 mtime 和常规文件大小。取消通过调用方提供的心跳传递。

遍历相邻的并行工作使用共享的 Rayon 线程池:

- `PI_WALK_WORKERS` 默认值为 `4`
- `0` 自动检测可用的并行度
- `1` 强制串行工作
- 辅助操作仅在 256 个及以上条目时并行化

## 新鲜度与驱逐

全局环境可覆盖策略:

- `FS_SCAN_CACHE_TTL_MS` — 默认 `1000`
- `FS_SCAN_EMPTY_RECHECK_MS` — 默认 `200`
- `FS_SCAN_CACHE_MAX_ENTRIES` — 默认 `16`

启用缓存时:

- TTL `0` 绕过缓存,返回一次全新扫描,`cache_age_ms = 0`。
- 命中且年龄小于 TTL 的条目会克隆存储的条目并报告其年龄。
- 过期的条目会被移除,并由一次全新扫描替换。
- 插入后,超过配置上限的条目按创建时间最旧优先驱逐。

禁用缓存时,收集会进行全新扫描,既不读取也不填充共享缓存。它不会驱逐同一键的既有缓存条目。

## 空结果重新校验

`WalkRequest` 拥有复检策略。`EmptyRecheck::Configured` 在以下情况重试一次:

1. 第一次收集是一次年龄非零的缓存命中,
2. 经过请求的高层筛选后结果为空,且
3. 缓存年龄至少为 `FS_SCAN_EMPTY_RECHECK_MS`(配置阈值为 `0` 会禁用此模式)。

重试在无缓存的情况下运行,不会替换或驱逐既有的缓存条目。`EmptyRecheck::Never` 禁用它;`AfterMillis(n)` 提供请求特定的年龄阈值。

当前效果:

- `glob` 将其编译后的 glob 和 node-module 策略集成到 `WalkFilter` 中,因此空的筛选后匹配集可以触发重新校验。
- AST 发现集成仅文件、可选 glob 和 node-module 筛选,因此空的候选集可以触发重新校验。
- `fuzzyFind` 使用默认的全条目筛选收集,之后再进行评分。因此重新校验覆盖的是底层遍历为空的情况,而不是非空遍历但所有条目评分均为零的情况。
- `grep` 无缓存,因此不适用缓存年龄复检。

## 消费者策略

- `glob`:`hidden=false`, `gitignore=true`, `cache=false`;跳过 `.git`;除非模式提及 `node_modules`,否则跳过 `node_modules`;绝不跟随符号链接;使用路径顺序和模式受限的深度;仅在进行 mtime 排序时使用完整详细信息。
- `fuzzyFind`:`hidden=false`, `gitignore=true`, `cache=false`;跳过 `.git` 和 `node_modules`;始终跟随符号链接;使用最小详细信息和路径顺序。
- `astGrep` / `astEdit` 目录发现:`hidden=true`, `gitignore=true`,始终启用缓存;跳过 `.git`;除非提供的 glob 提及 `node_modules`,否则排除 `node_modules`;绝不跟随符号链接;使用最小详细信息和路径顺序。
- `grep`:候选遍历跳过 `.git`,绝不跟随符号链接,使用最小详细信息,且无缓存。

TUI 的 `@` 提及自动补全选择使用缓存化的 `fuzzyFind`。Coding-agent 的 grep 工具不填充此缓存。

## 失效

`invalidateFsScanCache(path?)`:

- 不带路径时,清除所有条目
- 带路径时,移除每个缓存根目录是目标前缀的条目

相对路径相对 cwd 解析。失效会规范化目标;当目标不再存在时,它尝试规范化父目录并重新附加文件名。这支持创建、删除和重命名失效。

Coding-agent 辅助函数:

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` — 两侧不同时同时失效

当前的写入、hashline、补丁和替换修改路径在成功更改后会调用这些辅助函数。任何新的文件系统修改路径都必须同样处理。

## 添加缓存消费者

1. 选择稳定的遍历选项并复用 `WalkRequest`;每个有效的 `WalkOptions` 差异都会创建一个分区。
2. 当空结果重新校验应观察候选筛选时,将稳定的候选筛选放入 `WalkFilter`。收集后的评分无法触发请求的复检。
3. 对于真正需要新鲜结果的请求使用 `.cache(false)`;它绕过而非清除共享状态。
4. 审慎选择 `EmptyRecheck`。不要添加每次调用的 TTL 控制;TTL 和默认复检年龄是全局的。
5. 在每次成功的写入、删除或移动后失效;重命名两侧都要失效。

## 边界

- `DashMap` 缓存是进程本地的,不会被持久化。
- 条目是完整的自有扫描结果,而不是最终的工具结果。
- 缓存命中会克隆存储的条目向量。
- 只有在相同规范化根目录和完整有效遍历选项下才会发生共享。
