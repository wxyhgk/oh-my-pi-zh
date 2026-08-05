给定 diff hunks 修补文件。编辑现有文件的主要工具。

<instruction>
**Hunk 头:**
- `@@` — 上下文行唯一时的裸头
- `@@ $ANCHOR` — 从文件逐字复制的锚点(整行或唯一子串)
**锚点选择:**
1. 上下文行单独就能唯一时优先裸 `@@`;否则选择从文件复制的高特异性锚点:
   - 完整函数签名
   - 类声明
   - 唯一的字符串字面量/错误消息
   - 名字不常见的配置键
2. 遇到 "Found multiple matches":添加上下文行,用带独立锚点的多个 hunk,或用更长的锚点子串
**上下文行:**
用足够的 ` ` 前缀行让匹配唯一(通常 2-8)
编辑结构化块(嵌套花括号、标签、缩进区域)时,包含开闭行,让编辑保持在块内
</instruction>

<parameters>
```ts
// 输入是 { path: string, edits: Entry[] }。`path` 是必需的,适用于每个条目。
type Entry =
   // Diff 是顶层路径的一个或多个 hunks。
   // - 每个 hunk 以 "@@" 开头(锚点可选)。
   // - 每个 hunk 正文只包含以 ' ' | '+' | '-' 开头的行。
   // - 每个 hunk 至少包含一处变更(+ 或 -)。
   | { op: "update", diff: string }
   // Diff 是完整文件内容,无前缀。
   | { op: "create", diff: string }
   // 删除不需要 diff。
   | { op: "delete" }
   // update+move 时从顶层路径到新路径。
   | { op: "update", rename: string, diff: string }
```
</parameters>

<output>
返回成功/失败;失败时,错误消息指示:
- "Found multiple matches" — 锚点/上下文不够唯一
- "No match found" — 上下文中不存在这些行(内容错误或读取过时)
- diff 格式的语法错误
</output>

<critical>
- 编辑前你必须读取目标文件
- 你必须逐字复制锚点和上下文行(包括空白)
- 你绝不把锚点当注释(不要行号、位置标签、`@@ @@` 之类的占位符)
- 你绝不把新行放在预期块之外
- 如果编辑失败或破坏结构,你必须重新读取文件,并根据当前内容生成新补丁——你绝不重试同一个 diff
- 绝不用 edit 修复缩进、空白或重新格式化代码。格式化是在结尾运行一次的单个命令(`bun fmt`、`cargo fmt`、`prettier --write` 等)——不是 N 次单独编辑。如果编辑后看到不一致的缩进,留着;格式化器会一次修好全部。
</critical>

<avoid>
- 泛化锚点:`import`、`export`、`describe`、`function`、`const`
- 在多个 hunk 中重复相同的添加(重复块)
- 为小变更整文件覆盖(重大重构或短文件可以接受)
</avoid>
