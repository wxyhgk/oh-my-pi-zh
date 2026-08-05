# edit

> 应用源码编辑。默认的 `hashline` 模式接收一个以行锚定的补丁字符串,并直接编辑现有文件。

## 源码
- 入口与模式注册:`packages/coding-agent/src/edit/index.ts`
- hashline schema:`packages/coding-agent/src/edit/hashline/params.ts`
- 面向模型的 hashline 提示词:`packages/hashline/src/prompt.md`
- 规范的约束解码文法:`packages/hashline/src/grammar.lark`
- 解析与应用:`packages/hashline/src/input.ts`、`packages/hashline/src/parser.ts`、`packages/hashline/src/apply.ts`
- 快照验证/恢复:`packages/hashline/src/snapshots.ts`、`packages/hashline/src/patcher.ts`、`packages/hashline/src/recovery.ts`
- coding-agent 执行/结果塑造:`packages/coding-agent/src/edit/hashline/execute.ts`
- 流式预览策略:`packages/coding-agent/src/edit/streaming.ts`、`packages/coding-agent/src/edit/hashline/diff.ts`

## 模式选择与可用性

`edit` 是一个必需的内置工具。`resolveEditMode()` 按以下顺序选择活动的线上(wire)契约:

1. 模型专属的已配置变体;
2. `PI_EDIT_VARIANT`;
3. `edit.mode`;
4. 默认 `hashline`。

支持的模式为 `hashline`、`apply_patch`、`patch` 与 `replace`。除非设置了 `PI_STRICT_EDIT_MODE`,否则一个简短的模型排除列表可以用 `replace` 替换默认的 hashline 契约。本页记录默认的 hashline 契约;工具的 schema、提示词、示例、渲染器与可选的自定义 Lark 格式都会随所选模式切换。在 `apply_patch` 自定义工具模式下,线上名称是 `apply_patch`;分发仍然到达同一个内部工具。

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `input` | `string` | 是 | 包含 hashline 操作的一个或多个 `[PATH#TAG]` 段。严格的 custom-tool 文法用 `*** Begin Patch` / `*** End Patch` 包裹这些段;普通解析器也接受未包裹的载荷。 |

每个段编辑一个现有文件,并且必须从最近一次带锚的 `read`、`grep` 或成功的 `edit` 结果中复制四个大写十六进制字符的快照标签:

```text
[src/example.ts#1A2B]
PUT 4.=4:
+const value = 2;
```

使用 `write` 创建或整体覆写文件。hashline 在应用时会拒绝未带标签的锚定编辑。

## 规范补丁语言

所有行号均指向原始的带标签快照,而非同一次调用中更早的 hunk。

| 形式 | 作用 |
| --- | --- |
| `PUT N.=M:` | 用随后的 `+TEXT` 行替换包含端点的原始行 `N..M`。 |
| `PUT N*:` | 替换从第 `N` 行开始的跨行语法块。 |
| `PUT <N:` / `PUT >N:` | 在第 `N` 行之前 / 之后立即插入主体行。`PUT <1:` 表示文件头部。 |
| `PUT >$:` | 在文件尾部追加主体行。 |
| `PUT >N*:` | 在第 `N` 行开始的语法块之后插入。 |
| `CUT N.=M` / `CUT N*` | 删除并捕获包含端点的范围或已解析的块。添加 `@name` 可写入命名寄存器。 |
| `PUT <N` / `PUT >N` / `PUT >$` | 将匿名寄存器粘贴到空隙中。 |
| `PUT <N @name` / `PUT >N @name` / `PUT >$ @name` | 将命名寄存器粘贴到空隙中。 |
| `PUT N.=M @name` / `PUT N* @name` | 用命名寄存器替换范围或块。跨段/块粘贴需要命名寄存器。 |
| `REM` | 删除该段的文件。 |
| `MV DEST` | 在该段内任何先前的编辑之后移动/重命名该段文件。包含空格的路径需要加引号。 |

寄存器名称包含 ASCII 字母、数字、`_` 或 `-`。匿名寄存器是批内局部的,每次调用都从空开始。命名寄存器在会话期间持续存在,并且只有在其写入落地后才发布。操作跨段从上到下运行,因此更早段的剪切可以为更晚段的粘贴提供内容。重复粘贴不会消耗其寄存器。

只有带主体的 `PUT ...:` 头才接受主体行。每个主体行都是 `+TEXT`;单独的 `+` 插入一个空行。主体是最终内容,绝不是统一差异(unified-diff)的前后对照。以 `-` 或 `+` 开头的字面内容写作 `+-...` 或 `++...`。`CUT`、寄存器支持的 `PUT`、`REM` 与 `MV` 不接受主体。

### 块锚点

块形式从起始行解析到 tree-sitter 节点的末尾。锚定构造体的起始符,绝不要锚定结束分隔符、最后可见行、空行或内部语句。单行节点会被拒绝,并提示使用对应的显式行操作。当没有解析出块时,`PUT >N*:` 会降级为普通 `PUT >N:` 并给出警告;replace/cut 的块形式则会失败,而不是猜测。

前导装饰器、属性与文档注释可能是独立的语法节点。当解析器将首个装饰器与声明分组时,锚定首个装饰器;否则使用显式范围。独立的行注释不会被自动纳入。在 Markdown 中,标题的块包含其正文与更深层的子节,直到下一个同级或更高级别的标题。

使用紧凑的范围,并分开处理互不相邻的更改。不要仅为了重新格式化或调整代码风格而使用 `edit`;在实质性编辑之后运行项目的格式化器。

## 示例

给定:

```text
[greet.py#A1B2]
1:@cache
2:def greet(name):
3:    print("Hello, " + name)
4:
5:greet("world")
```

替换带装饰器的函数,而不改动其调用方:

```text
*** Begin Patch
[greet.py#A1B2]
PUT 1*:
+@cache
+def greet(name):
+    print(f"Hi, {name}")
*** End Patch
```

使用命名寄存器将它移动到另一个已读取的文件:

```text
*** Begin Patch
[greet.py#A1B2]
CUT 1* @fn
[lib/greet.py#3C4D]
PUT <1 @fn
*** End Patch
```

编辑后重命名:

```text
*** Begin Patch
[greet.py#A1B2]
PUT 5.=5:
+greet("team")
MV lib/welcome.py
*** End Patch
```

## 输出与副作用

hashline 在一次工具调用中应用;它不使用 `ast_edit` 所用的暂存式 `xd://resolve` / `xd://reject` 流程。

成功的段返回新的 `[path#TAG]` 头、可选的块解析与移动行、可用时的紧凑编辑后预览,以及当恢复或规范化产生警告时的 `Warnings:` 块。`EditToolDetails` 可以包含统一 `diff`、`firstChangedLine`、诊断/格式化结果、操作(hashline 模式下的 `update` 或 `delete`)、路径/移动元数据、快照与逐文件结果。多段输入返回一个汇总结果。

流式渲染器解析传输中载荷的完整部分,并计算只读差异。流式预览跳过临时的未解析块、过期标签与空粘贴,而不是把部分输入呈现为最终失败。执行时正常重新读取并校验。

对于多段调用,在开始写入之前每个段都会被解析并准备,因此语法、锚点与无操作失败都能快速失败。随后文件按顺序写入;操作系统写入失败可能留下已落地的前缀已应用的状态。命名寄存器的会话状态只针对该落地的前缀推进。

## 限制与校验

- 快照标签是由规范化后的文件内容派生的四个大写十六进制字符,并记录在会话快照存储中。
- `read`/`grep` 的可见范围很重要:针对记录的可见范围之外行的编辑会被拒绝。在编辑被省略或未显示的范围之前,先重新读取它们。
- 范围是包含端点的,必须有序,并且在检查目标文件实际边界之前,受解析器放大上限 100,000 个展开行的限制。
- 重叠的编辑或针对同一原始锚点的多个操作会被拒绝。
- 同路径的段会合并,使它们的原始行锚点一起生效。若交错出现的同路径段会使编写的寄存器顺序变得歧义,则剪贴板操作会被拒绝。
- 过期标签会尝试基于快照的恢复。只有当记录的快照链证明存在唯一安全结果时,恢复才会应用;否则返回与当前上下文不匹配的提示。
- 逐字节相同的编辑是错误。重复三次相同的无操作载荷会触发无操作循环保护。

## 常见失败

- 缺失/格式错误的 `[PATH#TAG]`、未知的快照标签,或已不存在的路径。
- 锚点在文件之外、在记录的已见行范围之外、在被省略的区域中,或基于无法安全恢复的过期快照。
- 反向或重叠的范围。
- 需要主体的 `PUT` 却给了空主体、无主体操作下出现主体行、未知的命名寄存器,或在明确的匿名剪切之前进行匿名粘贴。
- 块锚点指向不支持/无效的语法树、空行/结束行或单行节点。
- 统一差异污染(`@@`、apply-patch 哨兵、`-old` 行)代替 hashline 操作与最终内容的 `+` 行。
- `REM` / `MV` 冲突、无效的移动目标、目标冲突或文件系统写入失败。
- 补丁解析并应用到与现有字节完全相同的内容(无变化)。

解析器对常见的模型失误(可选包裹、良性的头部噪音、一些裸行与范围拼写)有有限的恢复能力,并在修复输入时呈现警告。调用方只应输出上述规范文法;恢复行为不是第二套公开语法。
