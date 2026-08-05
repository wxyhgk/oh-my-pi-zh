# Natives 架构

`@oh-my-pi/pi-natives` 将 JavaScript ESM 加载器与 Rust Node-API 插件结合：

1. **包/加载器层** 选择、加载并验证正确的 `.node` 插件，然后暴露生成的命名 ESM 导出。
2. **Rust N-API 层** 实现这些导出并提供 napi-rs 生成的 TypeScript 声明。

## 权威文件

- `packages/natives/package.json`
- `packages/natives/native/index.js` 与 `index.d.ts`
- `packages/natives/native/loader-state.js` 与 `loader-state.d.ts`
- `packages/natives/native/desktop.js` 与 `desktop.d.ts`
- `packages/natives/native/clipboard.js` 与 `clipboard.d.ts`
- `packages/natives/native/embedded-addon.js`
- `packages/natives/scripts/build-bindings.ts`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/scripts/gen-enums.ts`
- `packages/natives/scripts/gen-npm-packages.ts`
- `scripts/bazel-natives.ts`
- `crates/pi-natives/src/lib.rs` 及其模块

## 包入口点

该包导出三个入口点：

| 导入                           | 运行时               | 类型                   | 加载行为                                                                           |
| ------------------------------ | -------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `@oh-my-pi/pi-natives`         | `native/index.js`    | `native/index.d.ts`    | 立即加载插件，然后绑定每个生成的类/函数与枚举对象。                                |
| `@oh-my-pi/pi-natives/desktop` | `native/desktop.js`  | `native/desktop.d.ts`  | 暴露 `createDesktopSession(options)`，并将插件加载推迟到调用时。                   |
| `@oh-my-pi/pi-natives/clipboard` | `native/clipboard.js` | `native/clipboard.d.ts` | 暴露惰性的 `copyToClipboard` 与 `readImageFromClipboard` 包装器。                |

没有 `packages/natives/src` 包装层。根消费者直接调用生成的 N-API 导出。惰性子路径的存在使 worker 可以在相关操作初始化前导入其 JS 包装器而不加载大型插件。

当前根能力包括：

- 搜索、glob、工作区扫描、AST 匹配/编辑、代码摘要、语法高亮、文本布局、token 计数与结构化差异；
- shell、PTY、进程、文件锁、隔离与工作档案原语；
- 桌面捕获/输入/辅助功能、剪贴板、音频捕获/播放、实时 WebRTC、设备检查、SIXEL、snapcompact 渲染与向量排序。

## 加载器与分发

`native/index.js` 从 `loader-state.js` 调用 `loadNative()`。平台标签为 `${process.platform}-${process.arch}`。受支持的标签为：

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

x64 构建有 `modern`（x86-64-v3/AVX2）与 `baseline`（x86-64-v2）变体。`PI_NATIVE_VARIANT=modern|baseline` 覆盖自动检测。自动检测在 Linux 上读取 `/proc/cpuinfo`，在 macOS 上调用 `sysctl`，或在 Windows 上的 PowerShell 中查询 `System.Runtime.Intrinsics.X86.Avx2`。其结果通过私有 `__PI_NATIVE_VARIANT_CACHE` 环境条目由后续 worker 与子进程继承。非 x64 构建使用无后缀文件名。

文件名回退为：

- modern x64：`-modern.node`，然后 `-baseline.node`，然后无后缀 `.node`；
- baseline x64：`-baseline.node`，然后无后缀 `.node`；
- 非 x64：仅无后缀 `.node`。

发布的核心包包含加载器 JS、声明与元数据，但没有 `.node` 文件。发布流程生成 `@oh-my-pi/pi-natives-<platform>-<arch>` 可选依赖叶子包，并以相同版本注入核心清单。`gen-npm-packages.ts` 中的 `LEAF_TARGETS` 是权威发布目标列表。

### 候选归属与顺序

对于正常安装的包，平台叶子在核心包的 `native/` 目录与 `process.execPath` 目录之前被探测。工作区开发跳过叶子解析，使本地产物优先。

编译模式由已填充的嵌入式清单、`PI_COMPILED` 或 `import.meta.url` 中的 Bun 嵌入式标记检测。它先探测版本化缓存与旧版用户数据目录，再探测包/可执行文件位置。`getNativesDir()` 仅在 `$XDG_DATA_HOME/omp` 已存在时为 `$XDG_DATA_HOME/omp/natives`；否则为 `~/.omp/natives`。

已填充的清单引用 `embedded-addons.<tag>.tar.gz`。提取只允许清单列出的仅基名常规文件，原子写入 `<getNativesDir()>/<version>`，并校验文件大小。在 Windows `node_modules` 安装上，加载器改为在该版本化目录中暂存叶子/核心插件，使运行中的进程不会锁定 Bun 在更新时必须替换的副本。

插件成功加载后，加载器尽力而为地删除有效语义版本早于当前包的缓存目录。当前、未来与非语义版本目录保留。

## 加载校验与运行时初始化

每个安装或编译候选必须暴露从 `package.json#version` 计算的版本哨兵，例如 `__piNativesV17_2_5`。工作区加载跳过此检查。加载器不校验完整符号列表。

在 `require(...)` 与哨兵校验之后，加载器在存在时调用 `__ompInstallTokioRuntime()`。Rust 刻意在 `#[module_init]` 期间、动态加载器锁被持有时不创建 worker 线程。加载后钩子安装受限的 Windows Tokio/Rayon 池；没有钩子的旧插件使用 napi-rs 默认值。钩子失败是尽力而为的，仅在启用时出现在启动标记中。

设置 `PI_DEBUG_STARTUP` 可在插件加载、提取与运行时安装周围向 stderr 发出同步 `[startup]` 标记。

## Rust 模块归属

`crates/pi-natives/src/lib.rs` 注册当前模块：

- 平台/运行时：`appearance`、`clipboard`、`crash_handler`、`desktop`、`devicecheck`、`file_lock`、`iofs`、`power`、`prof`、`ps`、`pty`、`shell`；
- 媒体/实时：`audio`、`live`、`sixel`、`snapcompact`；
- 代码/数据：`ast`、`block`、`diff`、`fd`、`glob`、`glob_util`、`grep`、`highlight`、`html`、`keys`、`summary`、`text`、`tokens`、`vectors`、`workspace`；
- 隔离/任务支持：`iso`、`task`、crate 私有 `utils` 与仅测试的 `testing`；
- 从 `pi_ast::language` 重新导出的语言元数据。

Rust `#[napi]` 函数、类、对象与枚举生成声明表面。默认的 snake_case Rust 名称变为 camelCase JavaScript 名称。

## 归属边界

- **包/脚本** 拥有二进制选择、CPU 变体、可选叶子解析、嵌入式提取、Windows 暂存、声明与显式 ESM 导出。
- **`pi-natives` 与支持 crates** 拥有算法、原生资源、平台行为、取消与 N-API 转换。
- **消费者** 拥有更高级的工具策略、渲染、产物与未编码进原语的用户可见回退。

支持 crate 地图见 [`native-crates.md`](./native-crates.md)。精确的加载器诊断见 [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)。

## 运行时流程

1. 消费者导入急切根或惰性子路径。
2. `loadNative()` 计算模式、平台、变体、文件名与有序候选。
3. 嵌入式提取或 Windows 暂存可能前置一个缓存候选。
4. 按顺序 require 候选，安装/编译加载经过哨兵校验。
5. 可选的加载后运行时钩子运行，然后尽力而为地清理过期缓存版本。
6. 根绑定生成的命名导出；惰性子路径通过包装器调用选定绑定。
7. 调用方调用 N-API 函数/类；napi-rs 执行参数与结果转换。
