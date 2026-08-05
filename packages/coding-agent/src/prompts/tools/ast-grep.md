通过 ast-grep 进行结构化代码搜索。当语法形状比文本更重要时使用(调用、声明、语言构造)。

<instruction>
- 把每次调用收窄到一种语言。`pat` 是**一个** AST 模式;不相关的模式分开调用。
- `$NAME` 捕获一个节点;`$_` 匹配但不绑定;`$$$NAME` 零或多个;`$$$` 零或多个不绑定。
  - 使用 `$$$NAME`,不要用 `$$NAME`(无效)。名字要大写、整个节点——`prefix$VAR` 会失败。
- 同一个元变量出现两次 → 必须匹配相同的代码(`$A == $A` 匹配 `x == x`,不匹配 `x == y`)。
- 模式必须能解析为单个 AST 节点。不能独立成节点 → 包裹:`class $_ { … }`。
- C++ 表达式语句调用需要尾随 `;`:`ns::doThing($ARG);`、`$CALLEE($ARG);`。
- TS:容忍注解——`async function $NAME($$$ARGS): $_ { $$$BODY }`。
- 声明形式各不相同——`function foo`、方法 `foo()`、`const foo = () => {}`;在断定不存在之前,先搜索正确的形式。
- 最宽松的存在性检查:`pat: "executeBash"` 配合收窄的 `path`。
</instruction>

<critical>
- 避免仓库根目录扫描——先收窄 `path`。
- 解析问题 = 查询失败,不是不存在:在断定“无匹配”之前,先修复模式或收紧 `path`。
- 广泛的跨子系统探索 → 先{{#if scoutAvailable}}用 Task 工具 + scout{{else}}用 Task 工具{{/if}}子 Agent。
</critical>
