# 将热路径移植到 `pi-natives`

这是贡献者路径:把经测量的 JS/TS 热路径移入 `crates/pi-natives`,并通过 `@oh-my-pi/pi-natives` 暴露它。

## 决定是否移植

当原生代码消除了可证明的 CPU、阻塞 I/O、分配或平台集成成本,且边界可以保持数据导向时,就进行移植。当工作严重依赖 JS 对象同一性、动态导入、对应用状态的回调,或原生转换成本抵消了收益时,则保留 JS。

从一个行为兼容的 JS 基线开始,并准备有代表性的输入。一个存在但更慢或行为不同的原生导出不是成功的移植。

## 当前包与构建拆分

该包没有 `packages/natives/src/<module>` 包装层。其入口点是:

- 急切根入口:`native/index.js` 及生成的 `native/index.d.ts`;
- 惰性桌面包装:`native/desktop.js` / `desktop.d.ts`;
- 惰性剪贴板包装:`native/clipboard.js` / `clipboard.d.ts`。

两条命令服务于不同目的:

- `bun --cwd=packages/natives run build:bindings` 为主机运行 napi-rs,安装本地变体 addon 和生成的声明,并重新生成显式的 ESM/enum 导出。当 Rust 公开类型面变化时使用它。
- `bun --cwd=packages/natives run build` 调用 `scripts/bazel-natives.ts host --dest native`。它构建发货风格的主机 addon,但不会重新生成声明。

发布构建使用 Bazel 目标,并在平台叶子包中发布 `.node` 文件。核心发布重写会移除 addon,并注入由 `gen-npm-packages.ts` 中的 `LEAF_TARGETS` 生成的锁步可选依赖。

## 设计 N-API 边界

1. 将实现放在所属的 `crates/pi-natives/src/<module>.rs`;在 `lib.rs` 中注册新模块。
2. 在可行时,将计算保持在一个普通 Rust 函数中,然后暴露一个薄的 `#[napi]` 边界。
3. 优先使用拥有的 N-API 兼容值:`String`、向量、类型化数组和 `#[napi(object)]` 选项/结果结构体。避免生命周期无法跨越 N-API 工作的借用公开输入。
4. 让 napi-rs 应用默认的 snake_case 到 camelCase 命名,除非某个有意的公开名称需要 `js_name`。
5. 保留 JS 契约:null/undefined 区分、顺序、错误与结果语义、回调时机,以及同步与 Promise 行为。

### 工作调度与取消

- 对 CPU 密集或阻塞工作使用 `task::blocking(tag, cancel_token, work)`。它返回 `AsyncTask`,对工作进行性能剖析,并在 panic 跨越异步工作的 FFI 边界之前捕获它们。
- 对 Tokio 异步 I/O 使用 `task::future(env, tag, future)`。它通过 `Env::spawn_future` 返回 `PromiseRaw`。
- 当公开选项暴露 `timeoutMs` 或 `AbortSignal` 时,构建 `task::CancelToken::new(timeout_ms, signal)`,并在阻塞循环中的有意义间隔调用 `heartbeat()`。取消是协作式的;从未被检查的 token 不会停止工作。
- 不要在模块初始化中创建运行时或 worker 池。JS 加载器会在动态加载器锁释放后执行可选的 `__ompInstallTokioRuntime` 加载后步骤。

匹配一个具有相同调度/错误形态的现有导出,而不是引入第二种约定。

## 端到端清单

### 1. 实现并暴露

- 在需要时添加 Rust 逻辑,并为纯不变量添加聚焦的 Rust 测试。
- 添加 `#[napi]` 项以及对象/enum 类型。
- 在 `crates/pi-natives/src/lib.rs` 中注册一个新模块。
- 如果移植使用另一个第一方 crate,按照原生构建的要求,将依赖添加到 `crates/pi-natives/Cargo.toml` 及其构建系统输入中。

### 2. 重新生成并检查绑定

运行:

```bash
bun --cwd=packages/natives run build:bindings
```

然后验证:

- `native/index.d.ts` 包含预期的 JS 名称、精确的输入/结果类型、回调形状和同步/Promise 返回;
- `native/index.js` 中标记的生成块包含类/函数导出;
- 更改过的 enum 同时具有声明和字面量运行时对象。

`gen-enums.ts` 通过读取顶层 `export declare class`、`export declare function` 和 enum 声明来派生导出。声明中缺失的项不会成为具名的根 ESM 导出。

### 3. 仅在合理时添加惰性入口点

根入口会急切加载 addon。如果某个 worker 必须导入而不支付该启动成本,请遵循 desktop/clipboard 模式:

- 一个小的 JS 包装在导出的函数内调用 `loadNative()`;
- 一个匹配的 `.d.ts` 导入/重新导出根类型;
- `package.json#exports` 同时提供 `types` 和 `import` 路径。

不要仅仅为了重命名生成的根导出而添加包装。

### 4. 干净地迁移消费者

- 从 `@oh-my-pi/pi-natives` 导入生成的根符号或有意的惰性子路径。
- 在边界情况下将结果和错误与 JS 基线进行比较。
- 在同一变更中切换每个预期的调用者并移除过时的实现。
- 当原生原语不拥有面向用户的策略和渲染时,将其保留在消费者中。

### 5. 对代表性工作进行基准测试

在所属包(`packages/natives/bench`、`packages/tui/bench`、`packages/coding-agent/bench` 或其他现有包的 bench 目录)放置一个持久基准。在同一进程中、在相同的准备好的输入上运行 JS 和原生实现。当调用者可以复用该设置时,将设置/转换与计时操作分开。

```ts
const ITERATIONS = 2_000;

function bench(name: string, fn: () => void): number {
  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
  console.log(
    `${name}: ${elapsedMs.toFixed(2)}ms (${(elapsedMs / ITERATIONS).toFixed(6)}ms/op)`,
  );
  return elapsedMs;
}

bench("feature/js", () => jsImpl(sample));
bench("feature/native", () => nativeImpl(sample));
```

对于返回 Promise 的操作,使用异步基准循环并等待每次调用;不要只计时 promise 的创建。

### 6. 验证加载的产物

针对你刚构建的 addon 运行狭窄场景。在诊断候选不匹配时,检查加载器报告的候选路径:

```bash
bun -e 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const mod = require(process.argv[1]); console.log(Object.keys(mod).sort())' -- /path/to/pi_natives.<tag>[-variant].node
```

确认导出和包版本哨兵都存在。不要为必需的导出添加可选的消费者检查来掩盖产物不匹配。

## 常见失败

### 过时的变体或缓存胜出

x64 候选顺序是现代主机为 modern → baseline → unsuffixed,基线主机为 baseline → unsuffixed。编译和暂存的 Windows 加载也可以从 `<getNativesDir()>/<version>` 在包路径之前胜出。

只移除加载器诊断标识出的过时本地产物/缓存,然后重新构建。加载器在成功加载后会尽力删除有效旧版本的缓存目录,但有意保留当前版本目录。

### 声明已更改,但发货的 addon 没有

`build:bindings` 拥有声明生成;`build` 拥有 Bazel 主机产物。CI/发布目标拥有跨平台产物。验证生成的源码控制输出和场景实际使用的二进制。

### 同版本不完整 addon

哨兵证明发布版本,而非完整的导出集。本地生产的同版本二进制可以成功加载,但缺少新生成的成员。检查实际候选上的 `Object.keys` 并重新构建它;不要削弱调用者。

### 运行时 enum 缺失

仅靠 napi-rs enum 声明不提供根的字面量运行时对象。运行 `build:bindings` 并验证生成的块。如果 `gen-enums.ts` 无法解析声明形状,请修复生成器,而不是手工编辑其标记的块。

### 错误的同步/异步假设

以 `native/index.d.ts` 为权威。例如,`renderSnapcompactPng` 返回 `Promise<string>`,而 `snapcompactSupportedChars` 是同步的。改变调用风格的移植需要有意地迁移消费者。

## 完成标准

只有当生成的声明和 ESM 导出与 Rust API 匹配、预期消费者使用它、过时的 JS 代码已消失、一次聚焦的真实调用针对构建的 addon 成功,且有代表性的比较显示可接受的行为和性能时,移植才算完成。
