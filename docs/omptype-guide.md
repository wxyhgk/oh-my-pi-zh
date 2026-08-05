# omptype 指南(本仓库中的 schema 编写)

内部 schema 使用 **`@oh-my-pi/omptype`** —— 一个兼容 ArkType 的验证器,带惰性 JIT 运行时(`packages/omptype`)。使用 `import { type } from "@oh-my-pi/omptype"` 编写类型。

> **作用域规则。** Zod 在**外部边界**仍然受支持 —— `Tool.parameters` 接受 Zod _或_ omptype _或_ JSON Schema,公共 `pi.zod` 扩展 API 保持不变。内部 schema 使用 omptype。

## 为什么用 omptype(性能契约)

- `type()` 构造比 arktype 便宜约 100 倍(无急切 codegen,无节点 interning)。
- 前两次调用运行解释器;第三次调用通过 `new Function` JIT 编译专用验证器。热路径验证为数十纳秒;失败时分配一个带惰性消息构建的小错误对象。
- 没有 `jitless` 开关,也没有 `scope()` —— 惰性 JIT 消除了它们原本要规避的启动开销。直接导入 `type`。

## 检测契约(不要破坏它)

`packages/ai/src/utils/schema/wire.ts` 区分三种 schema 种类:

- **omptype** = 带 `.toJsonSchema` 与 `.assert` 方法的_可调用函数_(`isArkSchema`)。
- **Zod** = 携带 `_zod` + `.parse` 的不可调用对象(`isZodSchema`)。
- **JSON Schema** = 普通对象。

在提供商边界,`toolWireSchema()` 调用 `toJsonSchema()`,修剪 `T | undefined` 分支,并用 `additionalProperties: false` 闭合已声明对象。谓词(`.narrow`)与 morph(`.pipe`)在本地验证,但在线上降级为其基础 schema。

## 定义语言(arktype 兼容子集)

| 构造                        | 形式                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| 原语                        | `"string"`、`"number"`、`"boolean"`、`"null"`、`"undefined"`、`"unknown"`、`"object"`、`"bigint"` |
| 整数                        | `"number.integer"`                                                 |
| URL 字符串                  | `"string.url"`                                                     |
| 字面量                      | `"'x'"`、`"5"`、`"true"`                                           |
| 联合                        | `"'a' \| 'b'"`、`"string \| null"`                                 |
| 数组                        | `"string[]"`、`"(string \| number)[]"`、`[def, "[]"]`              |
| 边界                        | `"number >= 0"`、`"0 < number <= 3600"`、`"1 <= string <= 10"`     |
| 可选键                      | `{ "limit?": "number" }` 或值后缀 `{ limit: "number?" }`           |
| 默认值                      | `{ count: "number = 10" }`、`type("string[]").default(() => [])`   |
| 未声明键                    | `"+": "reject"`(失败)/ `"+": "delete"`(剥离)/ 默认保留            |
| 记录                        | `{ "[string]": "number" }` —— 不是 `"Record<string, number>"`      |
| 运行时枚举                  | `type.enumerated(...RUNTIME_ARRAY)`                                |
| 运行时构建的对象定义        | `type.raw({...})`(返回 `BaseType`)                                 |
| 关键字静态                  | `type.number.atLeast(5).atMost(300)`、`type.string`                |

## 验证(与 arktype 相同)

```ts
import { type } from "@oh-my-pi/omptype";
const out = schema(value);
if (out instanceof type.errors) {
  // out.summary → 人类可读消息;条目有 .path(数组)与 .problem
  throw new Error(out.summary);
}
// `out` 是已验证/已 morph 的值(默认值已填充,额外键已剥离)
```

- 失败返回 `OmpErrors`(`OmpError` 数组);`type.errors === OmpErrors`。
- 验证是快速失败:每次失败一个错误条目。
- Morph 从不改变输入;当应用默认值/`"+": "delete"`/pipes 时,返回全新对象。
- 工具验证**绝不**使用 `.allows()` —— 它跳过 morphs/defaults/pipes。
- `.infer` / `.inferIn` 是仅推断属性。
- 定义错误(坏 DSL、非法组合)在 `type()` 时抛出 `OmpTypeError`。

## 方法

`.describe(d)`、`.default(v | () => v)`、`.or(TypeOrStringDef)`、`.and(Type)`、`.array()`、`.atLeastLength(n)` / `.atMostLength(n)`(字符串/数组)、`.atLeast(n)` / `.atMost(n)`(数字)、`.pipe(fn)`、`.narrow(fn)`(带 `ctx.mustBe("...")`)、`.allows(v)`、`.assert(v)`、`.toJsonSchema()`。

关于 `.or()` 类型说明:schema 与字符串操作数推断精确;对象字面量操作数会降级 —— 先用 `type({...})` 包装它们。

## Zod → omptype 转换(用于新代码)

| Zod                                | omptype                                                     |
| ---------------------------------- | ----------------------------------------------------------- |
| `z.object({ a: ... })`             | `type({ a: ... })`                                          |
| `z.enum(["a","b"])`(静态)         | `"'a' \| 'b'"`                                              |
| `z.enum(RUNTIME_ARRAY)`            | `type.enumerated(...RUNTIME_ARRAY)`                         |
| `z.record(z.string(), z.number())` | `type({ "[string]": "number" })`                            |
| `.optional()`                      | 可选键 `{ "a?": "string" }`                                 |
| `.strict()` / `.strip()`           | `"+": "reject"` / `"+": "delete"`                           |
| `.refine(fn, msg)`                 | `.narrow((d, ctx) => fn(d) \|\| ctx.mustBe("<expect>"))`    |
| `.transform(fn)`                   | `.pipe(fn)`                                                 |
| `.catch(fallback)`                 | `type("unknown").pipe(raw => { const out = inner(raw); return out instanceof type.errors ? FALLBACK : out; })` |
| `z.infer<typeof S>`                | `typeof S.infer`                                            |

## 适配器

为 omptype 运行时支撑的 TypeBox 风格或 Zod 风格编写:

```ts
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";
```

两者都产生真正的 omptype schema(JIT 验证、`toJsonSchema`、线上检测)。将它们用于面向扩展的表面;内部代码直接编写字符串 DSL。
