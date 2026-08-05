# @oh-my-pi/omptype

面向 JavaScript 与 TypeScript 的快速、兼容 ArkType 的 schema 校验。Schema 从一个小的解释器开始,重复使用后惰性编译,既保持构造廉价,又不牺牲热路径校验速度。

## 安装

```sh
npm install @oh-my-pi/omptype
# 或
bun add @oh-my-pi/omptype
```

可在 Node 20+(以带捆绑类型声明的编译 ESM 发布)与 Bun 1.3.14+(通过 `bun` 导出条件直接解析 TypeScript 源码)上运行。无运行时依赖。

## 用法

```ts
import { type } from "@oh-my-pi/omptype";

const Config = type({
  name: "string",
  "retries?": "number.integer >= 0",
  enabled: "boolean = true",
});

const config = Config.assert({ name: "worker" });
// { name: "worker", enabled: true }

const result = Config({ name: 42 });
if (result instanceof type.errors) {
  console.error(result.summary);
}
```

Schema 可调用,并暴露组合(`.or()`、`.and()`、`.array()`、`.pipe()`、`.narrow()`)、对象变换(`.pick()`、`.omit()`、`.partial()`、`.required()`、`.merge()`、`.map()`)、细化、语义比较、错误配置与 JSON Schema 输出。

内置关键字模块包括 `type.string.email`、`type.string.uuid.v4`、`type.string.date.iso.parse`、`type.string.normalize.NFKC`、`type.number.integer`,以及 `type.parse` 下的解析器。

## 命名与递归 schema

```ts
const models = type
  .scope({
    User: { name: "string", "manager?": "User" },
    Users: "User[]",
    PublicUser: "Pick<User, 'name'>",
  })
  .export();

models.User.assert({ name: "Ada", manager: { name: "Grace" } });
```

Scope 惰性解析别名,包括循环。`type.module()` 直接导出一个 scope,`type.define()` 保留字面定义,`type.generic("<value>", definition)` 构建参数化运行时 schema。

校验失败返回 `OmpErrors`;每个条目暴露 `code`、`path`、`expected`、`actual`、`problem` 与 `message`,聚合对象暴露 `summary` 与 `byPath`。`.configure()` 接受字符串或回调覆盖错误文本。`.toJsonSchema()` 接受 `target`、`dialect` 与 `fallback` 选项。

## 兼容适配器

TypeBox 风格与 Zod 风格的构建器产生原生 omptype schema:

```ts
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";

const TypeBoxUser = Type.Object({ name: Type.String() });
type TypeBoxUser = Static<typeof TypeBoxUser>;

const ZodUser = z.object({ name: z.string() });
const user = ZodUser.parse({ name: "Ada" });
```

`@oh-my-pi/omptype/ark` 提供本仓库的 ArkType 兼容门面,并重新导出相同的 `type` 与 `scope` 实现。

## 性能

从仓库根目录运行基准测试:

```sh
bun packages/omptype/bench/bench.ts
```

该 harness 首先要求每个候选库都能正确接受、拒绝并变换相同的 fixtures。编译与冷启动结果使用 400 个唯一对象 schema,报告五次重复中最快的一次。热校验在 2,000 次预热调用后混合有效与无效输入。仅有效行在每个库的公共布尔路径经过 20,000 次预热调用后测量。

Apple M4 Max、Darwin 25.6.0 与 Bun 1.3.14 上的代表性结果:

| 阶段                   |    omptype |           ArkType |               Zod |         TypeBox |
| ----------------------- | ---------: | ----------------: | ----------------: | --------------: |
| 编译 `type()`        |  **509ns** | 271.08µs (532.3×) |  77.95µs (153.1×) | 27.36µs (53.7×) |
| 编译 + 2 次校验 | **2.18µs** | 526.46µs (241.5×) | 222.55µs (102.1×) | 46.90µs (21.5×) |

| 热工作负载               |  omptype |         ArkType |             Zod |         TypeBox |
| -------------------------- | -------: | --------------: | --------------: | --------------: |
| `flat-small`               | **25ns** | 5.10µs (203.7×) | 4.55µs (181.4×) |  1.23µs (49.2×) |
| `enum-union`               | **27ns** | 4.92µs (185.0×) | 4.38µs (164.7×) |  2.20µs (83.0×) |
| `nested-arrays`            | **29ns** | 4.80µs (163.0×) | 7.05µs (239.6×) | 3.01µs (102.2×) |
| `strict-defaults`          | **40ns** | 4.85µs (122.1×) | 6.71µs (169.2×) | 4.92µs (123.9×) |
| `delete-extras`            | **22ns** | 4.12µs (191.6×) | 2.55µs (118.6×) |  2.07µs (96.0×) |
| `record-mixed`             | **43ns** | 4.32µs (100.4×) | 8.80µs (204.5×) |  3.35µs (77.9×) |
| `deep-message`             | **31ns** | 6.32µs (202.5×) | 9.16µs (293.7×) | 5.13µs (164.5×) |
| `nested-arrays` 仅有效 | **15ns** |     28ns (1.8×) |  1.05µs (68.3×) |     45ns (2.9×) |

时间越低越好。括号中的数值表示每个候选库在此次运行中比 omptype 慢多少倍。结果随硬件、运行时、热状态与依赖版本而变;本地测量请用上面的命令。

## 许可证

MIT
