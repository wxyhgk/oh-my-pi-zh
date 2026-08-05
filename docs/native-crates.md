# 原生 Crates

`crates/` 下 Rust 工作区成员的贡献者地图。它们是 `@oh-my-pi/pi-natives` 及其嵌入式 shell 背后的实现细节；包消费者使用 JavaScript 入口点，而非这些 crate 的 API。

根 `Cargo.toml` 将 `crates/pi-*` 与 `crates/vendor/*` 作为工作区成员。它还将 crates.io 的 `brush-core` 与 `brush-builtins` 修补为 vendored 副本。

## 第一方 crates

| Crate           | 路径                                              | 角色与消费者                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-natives`    | [`crates/pi-natives`](../crates/pi-natives)       | 顶层 N-API `cdylib`。它暴露 JS 可见 API，并依赖 `pi-ast`、`pi-iso`、`pi-shell`、`pi-voice`、`pi-walker` 与 `pi-uutils-ctx`。                              |
| `pi-shell`      | [`crates/pi-shell`](../crates/pi-shell)           | 持久嵌入式 brush shell、命令执行/最小化、进程管道、文件系统遍历，以及 `pi-natives` 使用的进程内命令集成。                                                |
| `pi-voice`      | [`crates/pi-voice`](../crates/pi-voice)           | 跨平台麦克风/播放与 Opus/WebRTC 支持，供 `AudioCapture`、`AudioPlayback` 与 `LiveWebRtcPeer` 绑定使用。                                                  |
| `pi-ast`        | [`crates/pi-ast`](../crates/pi-ast)               | tree-sitter/ast-grep 语言注册表、匹配/编辑、块分析与跨工作区语法集的摘要支持。                                                                            |
| `pi-iso`        | [`crates/pi-iso`](../crates/pi-iso)               | APFS、Linux/Windows clone/reflink 路径、overlayfs、ProjFS 的隔离后端实现与差异计算，以及递归复制回退。                                                    |
| `pi-walker`     | [`crates/pi-walker`](../crates/pi-walker)         | 使用 ignore 规则与 globsets 的并行、缓存感知文件系统遍历器；供原生 grep/glob/workspace 路径与 shell 命令共享。                                            |
| `pi_uu_grep`    | [`crates/pi-uu-grep`](../crates/pi-uu-grep)       | 基于 ripgrep 库的 `grep` 实现，带 `pi-uutils-ctx` I/O/路径路由。进程内 shell 内建入口点：`pi_uu_grep::run`。                                              |
| `pi_uu_diff`    | [`crates/pi-uu-diff`](../crates/pi-uu-diff)       | 基于 `similar` 的 `diff`，带 `pi-uutils-ctx` I/O/路径路由。进程内 shell 内建入口点：`pi_uu_diff::run`。                                                   |
| `pi-uutils-ctx` | [`crates/pi-uutils-ctx`](../crates/pi-uutils-ctx) | 线程本地 stdin/stdout/stderr 与工作目录上下文，用于嵌入 vendored uutils 与自定义命令而不改变进程全局状态。                                                |

两个自定义 uutils 风格命令的 crate 包名故意不同：其 Cargo 包名为 `pi_uu_grep` 与 `pi_uu_diff`（下划线），而目录使用连字符。

## Vendored 工作区 crates

| 组                 | 路径                                                                                                                        | 用途                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brush              | [`crates/vendor/brush-core`](../crates/vendor/brush-core)、[`crates/vendor/brush-builtins`](../crates/vendor/brush-builtins) | 由 `pi-shell` 消费的 vendored shell 引擎与 POSIX/bash 内建。其清单保留上游包元数据；工作区补丁选择这些本地 fork。                                               |
| uutils 命令        | `crates/vendor/uu-*`                                                                                                        | `pi-shell` 有选择消费的进程内 coreutils 风格命令 crate，包括文件、文本、校验和、进程/系统与管道工具。                                                            |
| 共享 uutils 支持   | [`crates/vendor/uu-checksum-common`](../crates/vendor/uu-checksum-common) 及 `vendor/` 中的其他依赖 crate                  | 所选命令 crate 所需的支持代码；不是直接的 N-API 模块。                                                                                                           |
| jq 实现            | [`crates/vendor/jaq`](../crates/vendor/jaq)                                                                                 | shell 使用的进程内 JSON 查询命令。                                                                                                                               |

`pi-shell/Cargo.toml` 是链接进嵌入式 shell 的命令的权威清单。目录是工作区成员本身并不意味 `pi-natives` 将其暴露为 JavaScript API。

## 边界图

```text
@oh-my-pi/pi-natives JS entrypoints
  -> pi-natives (N-API conversion, platform bindings, task boundaries)
       -> pi-ast / pi-iso / pi-voice / pi-walker
       -> pi-shell
            -> brush-core + brush-builtins
            -> pi_uu_grep + pi_uu_diff + vendored uu-* + jaq
            -> pi-uutils-ctx (per-invocation I/O and cwd)
```

关于加载器与 JS 边界，见：

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

子系统细节见：

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## 文档策略

这些 crates 仍是面向贡献者的实现细节。只有当某个 crate 获得独立于 `@oh-my-pi/pi-natives` 使用的公共 API 或可执行文件时，才将其提升为独立的用户文档；见 [`user-facing-packages.md`](./user-facing-packages.md)。
