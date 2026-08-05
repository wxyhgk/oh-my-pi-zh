# Natives 插件加载器运行时

本页记录 `packages/natives/native/loader-state.js`，即 ESM 入口点与已验证的 `pi_natives.*.node` 插件之间的运行时。

## 入口点与急切/惰性加载

- `native/index.js` 在模块求值时调用 `loadNative()` 并暴露生成的根 API。
- `native/desktop.js` 与 `native/clipboard.js` 导入加载器，但只在其公共包装器内调用它。
- 纯加载器辅助函数为聚焦测试导出，在调用 `loadNative()` 或 `initLoaderContext()` 之前不执行检测或文件系统探测。

成功的调用不会被 JS 记忆化。重复调用依赖运行时的 `require(...)` 模块缓存，而加载后设置是幂等的或尽力而为的。

## 加载器上下文

`initLoaderContext()` 推导出：

- `platformTag`：`${platform}-${process.arch}`；
- 包版本与哨兵名 `__piNativesV<version_with_underscores>`；
- 包本地 `nativeDir` 与 `process.execPath` 的目录；
- `nativesDir`，通常为 `~/.omp/natives`；仅在 `$XDG_DATA_HOME/omp` 存在时才使用 `$XDG_DATA_HOME/omp/natives`；
- `versionedDir`：`<nativesDir>/<packageVersion>`；
- 旧版编译二进制目录：Windows 上为 `%LOCALAPPDATA%/omp`（或 `~/AppData/Local/omp`），其他平台为 `~/.local/bin`；
- 工作区/安装/编译模式、可选叶子目录、Windows 暂存策略、CPU 变体、文件名与有序候选。

当存在已填充的嵌入式清单、设置了 `PI_COMPILED`、或 `import.meta.url` 包含 Bun 嵌入式标记（`$bunfs`、`~BUN` 或 `%7EBUN`）时，编译模式为真。`node_modules` 路径之外的未编译 `nativeDir` 是工作区加载。Windows 路径分类不区分大小写；其他平台使用区分大小写的路径匹配。

## 平台与变体

受支持的发布标签为：

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

不支持的标签只在探测候选之后报告。

对于 x64，`PI_NATIVE_VARIANT=modern|baseline` 优先。无效值被忽略。否则，私有继承的 `__PI_NATIVE_VARIANT_CACHE` 结果有效时使用之；只有到那时加载器才检测 AVX2：

- Linux 读取 `/proc/cpuinfo`。
- macOS 尝试 `/usr/sbin/sysctl` 然后 `sysctl`，查询 `machdep.cpu.leaf7_features` 与 `machdep.cpu.features`。
- Windows 为非交互式 PowerShell 调用 `System.Runtime.Intrinsics.X86.Avx2`。

检测在可用时使用 `Bun.spawnSync`，随后回退到 `node:child_process`。检测结果写入私有缓存环境条目，使后续 worker/子进程继承同一决策。非 x64 不使用或填充变体。

`getAddonFilenames()` 返回：

| 运行时选择    | 有序文件名                                                                         |
| ------------- | ---------------------------------------------------------------------------------- |
| modern x64    | `pi_natives.<tag>-modern.node`、`pi_natives.<tag>-baseline.node`、`pi_natives.<tag>.node` |
| baseline x64  | `pi_natives.<tag>-baseline.node`、`pi_natives.<tag>.node`                          |
| 非 x64 / 无变体 | `pi_natives.<tag>.node`                                                          |

## 候选排序

`resolveLoaderCandidates()` 对路径去重，同时保留首次出现。

### 已安装、未编译的包

1. `@oh-my-pi/pi-natives-<tag>` 中每个选定的文件名。
2. 对每个文件名，先是包本地 `nativeDir`，然后是可执行文件目录。

平台叶子胜过过期的核心产物。工作区加载刻意跳过叶子解析。

### Windows `node_modules` 暂存

当平台为 Windows、运行时未编译且 `nativeDir` 包含 `node_modules` 段时：

1. `versionedDir` 中每个选定的文件名。
2. 叶子包候选。
3. 包本地与可执行文件候选。

探测之前，`maybeStageNodeModulesAddon()` 将 `leafPackageDir ?? nativeDir` 中每个可用文件名复制到缺失的缓存目标。现有缓存文件被保留。这使已加载的 DLL 句柄远离更新必须替换的包管理器副本。目录/复制失败被记录，正常探测继续。

### 编译运行时

1. 对每个文件名，先是 `versionedDir`，然后是旧版用户数据目录。
2. 对每个文件名，先是包本地 `nativeDir`，然后是可执行文件目录。

成功选中的嵌入式候选会被前置。编译模式禁用 Windows 暂存。

## 嵌入式清单与提取

在正常源码/发布核心状态下，`embedded-addon.js` 被重置为 `embeddedAddon = null`。`scripts/embed-native.ts` 可以生成包含以下内容的匹配清单：

- `platformTag` 与包 `version`；
- 一个 gzip 压缩的 tar 归档引用；
- `files[]` 带 `variant`、仅基名的 `filename` 与 `size`。

提取仅在编译模式下运行，要求平台与版本匹配且有可选文件。选择为：

- 非 x64：`default`，然后是第一个文件；
- modern x64：`modern`，然后是 `baseline`；
- baseline x64：仅 `baseline`。

加载器创建 `versionedDir`。如果每个需要提取的清单文件已是声明大小的常规文件，则直接复用。否则 gunzip 并解析 tar 归档，仅接受清单允许列表中仅基名的常规文件条目，校验大小，并通过临时文件加重命名写入。缺失、截断、不安全、错误类型与错误大小的条目都是错误。没有归档的旧清单仍可提供逐文件 `filePath` 元数据。

提取错误会累积；加载器继续尝试普通候选。

## 候选校验与加载后设置

对每个候选：

1. 启用时发出启动标记。
2. `require(candidate)`。
3. 除非是工作区开发，否则 require 预期的包版本哨兵函数。
4. 如果插件提供 `__ompInstallTokioRuntime()`，调用它。
5. 尽力而为地删除早于当前版本的有效语义版本缓存目录。
6. 返回绑定。

哨兵错误区分当前进程中仍驻留的先前插件与磁盘上的过期文件。如果加载的导出携带更旧的哨兵，但候选字节包含预期的当前哨兵，诊断提示重启。否则提示重装。加载器不校验所有公共导出。

Rust 模块初始化安装崩溃诊断，但在动态加载器锁下不生成运行时线程。可选的加载后钩子安装受限的 Windows Tokio 与 Rayon 池。它是尽力而为的；更旧的插件或钩子失败回退到 napi-rs 行为。设置 `PI_DEBUG_STARTUP` 可向 stderr 发出同步 `[startup]` 标记，包括钩子成功/失败。

缓存清理忽略读/删失败，只删除解析语义版本早于当前包的目录。它保留当前/未来版本、预发布/非语义版本名称与普通文件。

## 失败诊断

如果没有候选成功：

- 不支持的标签抛出 `Unsupported platform: <tag>`、支持列表与 issue 指引；
- 受支持的标签抛出 `Failed to load pi_natives native addon for <tag>`（含 x64 变体），随后列出每个候选/准备错误与模式特定帮助。

编译帮助列出预期的缓存路径、建议删除版本化目录，并打印发布下载 `curl` 命令。已安装包帮助建议重装、本地 Bazel 主机构建（`bun --cwd=packages/natives run build`）与显式 `scripts/bazel-natives.ts <target> --dest packages/natives/native` 构建。

## 生命周期

```text
entrypoint evaluates or lazy wrapper is invoked
  -> initialize loader context
  -> extract matching embedded archive, if any
  -> otherwise stage Windows node_modules addon, if applicable
  -> require candidates in deterministic order
       -> validate sentinel outside workspace development
       -> install optional post-load runtime
       -> best-effort clean older version caches
       -> return bindings
  -> no success: throw unsupported-platform or aggregated load error
```
