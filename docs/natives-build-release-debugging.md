# Natives 构建、发布与调试手册

本手册介绍 `@oh-my-pi/pi-natives` 如何产出 `.node` 插件、生成的声明与编译二进制嵌入负载，以及如何调试加载器/构建失败。

插件**产物由 Bazel 构建**（`rules_rust` + `crate_universe` + 密闭 cc 工具链）；cargo 工作区在本地 Rust 迭代（rust-analyzer、`cargo nextest`）与 napi typedef 再生成上保持权威。运行时加载与嵌入不变。

它沿用 `docs/natives-architecture.md` 中的架构术语：

- **构建时产物生产**（经 `scripts/bazel-natives.ts` 的 Bazel `//:natives-<target>`）
- **嵌入式插件清单生成**（`scripts/embed-native.ts`）
- **运行时插件加载**（`native/index.js`、`native/loader-state.js`）

## 实现文件

构建侧：

- `BUILD.bazel`（根）— 八个 `//:natives-<target>` 插件目标 + 聚合 filegroup
- `bazel/defs.bzl` — `native_addon` 规则/转换
- `bazel/platforms/BUILD.bazel` — 每个发布的插件一个 `platform()`
- `bazel/variants/BUILD.bazel` — `baseline`/`modern` ISA 约束值
- `bazel/toolchains/` — musl rustc 消歧 + msvc 交叉 cc 工具链（`msvc/NOTES.md`）
- `bazel/clippy.bazelrc` — 由 `Cargo.toml` 中的 `[workspace.lints]` 生成
- `MODULE.bazel`、`MODULE.bazel.lock`、`.bazelrc`、`.bazelversion`（Bazel 9.2.0）
- `scripts/bazel-natives.ts` — 规范驱动程序（构建 + 定位 + 安装）
- `crates/pi-natives/BUILD.bazel`、`crates/pi-natives/Cargo.toml`

包侧（运行时/打包不变）：

- `packages/natives/scripts/build-bindings.ts` — 仅开发用的 typedef 再生成
- `packages/natives/scripts/embed-native.ts`、`gen-enums.ts`、`gen-npm-packages.ts`
- `packages/natives/package.json`
- `packages/natives/native/index.js`、`native/loader-state.js`

## 构建架构

### 1) `//:natives-<target>` 插件目标

根 `BUILD.bazel` 为每个发布的 `(platform, arch, ISA-variant)` 实例化一个 `native_addon`：

| 目标                               | 平台                                    | 规范输出                              |
| ---------------------------------- | --------------------------------------- | ------------------------------------- |
| `//:natives-linux-x64-baseline`    | `//bazel/platforms:linux-x64-baseline`  | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-x64-modern`      | `//bazel/platforms:linux-x64-modern`    | `pi_natives.linux-x64-modern.node`    |
| `//:natives-linux-arm64`           | `//bazel/platforms:linux-arm64`         | `pi_natives.linux-arm64.node`         |
| `//:natives-linux-musl-x64-baseline` | `//bazel/platforms:linux-musl-x64-baseline` | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-musl-arm64`      | `//bazel/platforms:linux-musl-arm64`    | `pi_natives.linux-arm64.node`         |
| `//:natives-darwin-x64-baseline`   | `//bazel/platforms:darwin-x64-baseline` | `pi_natives.darwin-x64-baseline.node` |
| `//:natives-darwin-arm64`          | `//bazel/platforms:darwin-arm64`        | `pi_natives.darwin-arm64.node`        |
| `//:natives-win32-x64-baseline`    | `//bazel/platforms:win32-x64-baseline`  | `pi_natives.win32-x64-baseline.node`  |

注意事项：

- musl 插件**刻意复用**普通 `linux-<arch>` 文件名——加载器从不同时看到 gnu 与 musl；发布任务将它们保留在单独的调用/目标目录中（`scripts/bazel-natives.ts` 对单次运行内的基名冲突硬报错）。
- 聚合：`//:natives-linux-all`（所有 linux 目标 + msvc 交叉构建，即从 linux-x64 主机可构建的一切）与 `//:natives-darwin-all`（仅 mac 主机）。

### 2) `native_addon` 规则（`bazel/defs.bzl`）

`native_addon` 将 `//crates/pi-natives:pi_natives`（一个 `rust_shared_library`）包裹在配置转换中，按目标固定：

- `--platforms=<the addon's platform>`
- `--compilation_mode=opt`
- `@rules_rust//rust/settings:lto=thin`
- 额外 rustc 标志 `-Ccodegen-units=16 -Cstrip=symbols`

这镜像了旧的 cargo `ci` profile。由于 profile 位于**转换中**，裸 `bazel build //:natives-<t>` 无论 `-c` 如何总是发布级别，且每个插件每 (platform, source) 对共享一个缓存条目。然后规则将产生的共享库符号链接到加载器的规范 `pi_natives.<platform>-<arch>[-<variant>].node` 名称，作用域在规则名下（`bazel-bin/natives-<t>/…`），使基名相同的 gnu/musl 输出在包级别无法冲突。

不属于转换的逐目标代码生成位于 `crates/pi-natives/BUILD.bazel` 的 `rustc_flags` selects 中：经 `//bazel/variants` 的 `-Ctarget-cpu=x86-64-v2`（baseline）/ `x86-64-v3`（modern）、napi 链接参数（macOS 上 `-Wl,-undefined,dynamic_lookup`，linux 上 `-Wl,-z,nodelete`——`build.rs`/`napi_build::setup()` 刻意未接入），以及 musl 的 `-Ctarget-feature=-crt-static`。

### 3) 平台与工具链

| 目标族          | cc 工具链                                                               | 说明                                                                                                 |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| linux gnu (x64/arm64) | `@zig_sdk//libc_aware/toolchain:linux_*_gnu.2.17`（密闭 zig cc）   | glibc **2.17** 可移植性下限——与之前交叉构建使用的下限相同                                            |
| linux musl (x64/arm64) | `@zig_sdk//libc_aware/toolchain:linux_*_musl`                     | 动态 CRT（crate BUILD 中 `-Ctarget-feature=-crt-static`）                                            |
| darwin (x64/arm64) | 主机 Xcode 工具链                                                   | Apple 框架不可再分发；darwin 插件仅在 mac 主机上构建                                                 |
| win32-x64 msvc  | `//bazel/toolchains/msvc`（`@msvc_cc`）：clang-cl + lld-link + xwin CRT/SDK | 从 linux-x64 CI pod 与 darwin 开发主机密闭交叉链接；见 `bazel/toolchains/msvc/NOTES.md`        |

Rust 工具链为 nightly（固定在 `MODULE.bazel` 中），`//bazel/toolchains` 中有仓库本地 musl 重新注册，携带显式 `@zig_sdk//libc:musl` 约束（rules_rust 生成的 gnu 与 musl 工具链否则共享 (os, cpu) 约束）。

### 4) 第三方 crates（`crate_universe`）

`@crates//...` 从工作区 `Cargo.toml`/`Cargo.lock` 生成，严格限制为恰好七个发布三元组。crate 特定构建修复作为 `MODULE.bazel` 中的 `crate.annotation` 存在（见下方调试手册）。

根模块刻意省略 `crate_universe` 的可选渲染锁。crate 输入变化后的首次求值拼接工作区并从固定的 `Cargo.lock` 生成外部仓库规格；Bazel 将该扩展结果记录在 `MODULE.bazel.lock` 中，因此后来的干净输出基座复用它。因此，Cargo 清单、锁与注解编辑无需单独 re-pin 步骤。

## 本地开发

### 构建插件

```bash
# Addon for the current host (x64 hosts pick modern vs baseline via AVX2 detection),
# installed into packages/natives/native/:
bun --cwd=packages/natives run build          # = bun ../../scripts/bazel-natives.ts host --dest native
# same, from the repo root:
bun run build:native

# The driver directly — targets are //:natives-* names plus pseudo-targets
# host / linux-all / darwin-all:
bun scripts/bazel-natives.ts <target>... [--dest <dir>] [-- <extra bazel args>]
bun scripts/bazel-natives.ts linux-x64-baseline linux-x64-modern --dest packages/natives/native
bun scripts/bazel-natives.ts darwin-all

# Or bazelisk directly (outputs stay in bazel-bin, nothing is installed):
bazelisk build //:natives-darwin-arm64
bazelisk build //:natives-linux-all
```

驱动程序为所有请求目标运行一次 `bazel build`，经 `bazel cquery --output=files` 定位输出（回退到 `bazel-bin/natives-<t>/<canonical>.node` 路径约定），并取消引用复制到 `--dest`（默认 `packages/natives/native`）。`--` 后的额外参数原样传给 bazel。它从 `PATH` 解析 `bazelisk`（或 `bazel`），并支持 `OMP_BAZEL_RC` 环境变量作为 `--bazelrc=` 启动选项（CI 以此注入缓存接线）。

将 `linux-all` 构建到一个 dest 会以 musl 插件覆盖 gnu 插件（共享基名）——驱动程序拒绝；请用单独调用与单独 `--dest` 目录。

### Typedef 再生成（napi CLI，仅开发）

`native/index.js`/`index.d.ts` 是**已提交**的，因此 Bazel 产物构建从不需要 napi CLI。仅当 Rust API 表面改变其导出 typedef 时：

```bash
bun --cwd=packages/natives run build:bindings   # = bun scripts/build-bindings.ts
```

这会针对 `crates/pi-natives` 运行 napi CLI（仅主机，本地 cargo profile），安装再生成的 `index.d.ts`，规范化插件文件名，并经 `gen-enums.ts` 重新渲染显式 ESM 导出 + 运行时枚举对象。提交产生的 `index.js`/`index.d.ts` 变更。

### 可选远程缓存（`.bazelrc.user`）

`.bazelrc` 以 `try-import %workspace%/.bazelrc.user`（gitignored）结尾。bazel-remote 端点仅集群内部可用；如果你能到达它（VPN/tailnet），以只读方式接线：

```
# .bazelrc.user
build --config=cache-ro
build --remote_cache=grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092
build --tls_certificate=infra/bazel-remote/ca.crt
```

`.bazelrc` 中的 `cache-ro`/`cache-rw` 只携带策略（上传开/关、`--remote_local_fallback`、重试/超时，使缓存故障永不失败构建）；端点 + 凭据总是由消费者组合。此处简单的 `--disk_cache=<dir>` 行同样适用。

## CI

### 拆分 Rust 校验与插件生产

`.github/workflows/ci.yml` 将 `rust_validate` 与 `native_addons` 分开；TypeScript 任务只依赖 `native_addons`。

**拉取请求从不构建或校验 Rust。** 影响原生的 PR 足够稀少，不值得在 PR 侧做 bazel 构建：`rust_validate` 被完全跳过（`if: github.event_name != 'pull_request'`），而 `native_addons` 从 `@oh-my-pi/pi-natives-linux-x64` npm 叶子获取最新发布的 Linux x64 插件对，冒烟加载两者，并将其上传为 `native-addons` 工作流产物。加载器对工作区加载跳过版本哨兵，因此发布版本的插件在更新的检出下也能正常加载。TypeScript 测试依赖已变更原生行为的 PR 会明显失败（CI 还会在任何触碰原生的 PR 上发出通知）；Rust 侧在合并后在 main 上校验，并在发布时再次校验。

非 PR 事件上，两个任务都在 `omp-kata` pod 上针对集群远程缓存运行。`rust_validate` 运行：

```bash
bazelisk --bazelrc="$rc" test //crates/...                 # full Rust suite
# clippy scope mirrors `cargo clippy --workspace` (libraries only), split by
# lint policy via a query kind filter:
bazelisk query "kind('rust_library|rust_shared_library', //crates/pi-ast/... + //crates/pi-iso/... + //crates/pi-natives/... + //crates/pi-shell/... + //crates/pi-voice/... + //crates/pi-walker/...)" \
  | xargs bazelisk --bazelrc="$rc" build --config=clippy-strict --
bazelisk query "kind('rust_library|rust_shared_library', //crates/... - (…strict set…) - //crates/vendor/brush-core/... - //crates/vendor/brush-builtins/...)" \
  | xargs bazelisk --bazelrc="$rc" build --config=clippy --
bazelisk --bazelrc="$rc" build --config=rustfmt //crates/...
```

- `--config=clippy` = rules_rust clippy aspect + `-Dwarnings`；`--config=clippy-strict` 为 `[lints] workspace = true` 的 crates 叠加生成的 `bazel/clippy.bazelrc`。
- `--config=rustfmt` = 针对工作区 `rustfmt.toml` 的 rustfmt aspect。

main 上的 `native_addons` 逐个构建六个 Linux 托管目标以避免并发链接 OOM，然后将 `//:natives-linux-all` 作为聚合一致性检查构建。它将每个 `.node` 输出上传为 `native-addons` 工作流产物。下游任务使用 `.github/actions/native-artifacts` 下载该产物并无调用 Bazel 安装请求的目标集。

原生任务无需工具链设置步骤：bazelisk 在 GitHub 镜像上，并烘焙进 kata runner 镜像；Bazel 密闭获取 Rust/zig/LLVM/xwin。

### 托管缓存预热器

`.github/workflows/bazel-cache-warm.yml` 为没有其他可靠生产者的 GitHub 托管缓存播种：`release-darwin-*` bazel 磁盘缓存（在与 `release_binary_darwin` 矩阵相同的 macOS 镜像上构建，因此发布的 bazel 构建是版本提升增量而非约 40 分钟的冷图）与 PR 任务恢复但从不保存的共享 bun store 条目。它只在可能改变这些归档的推送时触发（crate/bazel/lock 输入、`bun.lock`、`.github/**`）。

### `bazel-cache` action（`.github/actions/bazel-cache`）

缓存接线的单一事实来源，以 bazelrc 片段（其 `rc` 输出）形式发出，消费者经 `bazelisk --bazelrc=...` 或 `OMP_BAZEL_RC` 传递。两种模式经 `BAZEL_REMOTE_USER`/`BAZEL_REMOTE_PASSWORD` 选择：

| Runner        | 片段内容                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| omp-kata pod  | 临时输出根、`--config=ci`、PVC 支持的 repository/xwin 缓存、`--config=cache-rw`、集群内 TLS 远程缓存端点与掩码 Basic-auth 头，加上 `--remote_download_toplevel`                                       |
| GitHub-hosted | `--config=ci`、`--disk_cache=$HOME/.cache/omp-bazel-disk` 与 `--repository_cache=$HOME/.cache/omp-bazel-repo`                                                                                        |

托管磁盘缓存使用 `bazel-disk-v3-<scope>-<os>-<arch>-<config-hash>-<source-hash>`。配置哈希覆盖 Cargo/Bazel/工具链设置；源哈希覆盖 `crates/**` 与根 `BUILD.bazel`。恢复从精确键回退到配置作用域前缀，然后到裸 `<scope>-<os>-<arch>` 前缀——裸回退正是让发布版本提升（重写 `Cargo.toml`/`Cargo.lock` 从而重写配置哈希）不必冷重建的原因；bazel 的内容寻址 action 键使过期归档成为部分命中，绝不会是错误输出。不精确恢复允许一次刷新的精确键保存。托管构建前，14 天未触碰的磁盘缓存文件会被修剪；repository-cache 内容刻意不做年龄修剪，因为提取的文件保留上游 mtime。远程端点只在集群内解析。

### 原生产物 actions

`.github/actions/bazel-natives` 是直接构建器：`bazel-cache` → `OMP_BAZEL_RC=<rc> bun scripts/bazel-natives.ts <targets> --dest <dest>`，随后在托管未命中后保存磁盘缓存。`.github/actions/native-artifacts` 是免构建消费者：下载 `native-addons` → 用 `--source` 运行同一驱动程序。

### 发布二进制构建与发布

二进制构建仅构建，并与测试扇出并行运行。`release_binary`（Linux + Windows 矩阵）只需 `native_addons`，其工作流产物提供插件。`release_binary_darwin` 只需 `release_metadata`，并在检测到发布运行的那一刻开始：darwin 产物无法在 Linux 上交叉构建，因此每个 macOS 分支通过 `bazel-natives` 以 `release-<target_id>` 作用域构建自己的架构（由预热工作流在 HEAD 附近播种——通常只是版本提升增量），然后 `bun run ci:release:build-binaries` 嵌入并编译可执行文件。发布被 `release_gate`（每个校验任务的聚合）拦在后面：`release_native_leaves` 下载所有构建的插件，从一个 linux runner 发布五个 `@oh-my-pi/pi-natives-<tag>` 叶子，GitHub release / verify / 核心 npm 链并排运行。

## 调试手册

### 产物落点 / 如何检查

```bash
# Outputs (workspace-relative): bazel-bin/natives-<target>/pi_natives.<...>.node
bazelisk cquery --output=files //:natives-linux-x64-baseline

# What actions/flags a target produces (add the same --config flags as the build):
bazelisk aquery 'outputs(".*\.node", deps(//:natives-linux-arm64))'
bazelisk aquery 'mnemonic("Rustc", deps(//crates/pi-natives:pi_natives))'

# Which toolchain resolved (e.g. confirm @msvc_cc, not host cc, for win32):
bazelisk cquery 'deps(//:natives-win32-x64-baseline)' | grep msvc_cc

# Keep the sandbox dir + print the full command line of a failing action:
bazelisk build --sandbox_debug --verbose_failures //:natives-<t>

# Analyze without building (cheap cross-target sanity check):
bazelisk build --nobuild //:natives-win32-x64-baseline
```

`scripts/bazel-natives.ts` 实时流式传输 bazel stderr，并在失败时重复 40 行尾部；其 cquery 步骤失败时回退到 `bazel-bin` 路径约定。

### 常见失败类别（bring-up 期间所见——修复已在树中，再现时引用）

| 症状                                                                                        | 原因                                                                                                | 修复（树中）                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| musl 构建“成功”但不输出 `.node`                                                              | musl 默认为 `+crt-static`；rustc 静默不输出 cdylib                                                   | `crates/pi-natives/BUILD.bazel` 中的 `-Ctarget-feature=-crt-static` select                                                                                                   |
| opus/cmake `try_compile` 链接 UBSan 运行时失败                                                | zig cc 默认启用 UBSan；cmake 测试 exe 用裸包装器链接（无工具链特性）                                  | `audiopus_sys` 注解中的 `CFLAGS=-fno-sanitize=undefined`（`MODULE.bazel`）                                                                                                   |
| 优化下 `tree-sitter-just` scanner.c `#error`                                                 | 设置 `NDEBUG` 时 scanner 硬报错（opt 模式 cc 默认）                                                  | `CFLAGS=-UNDEBUG` 注解（cc-rs 最后追加环境 CFLAGS，因此 `-U` 生效）                                                                                                           |
| vendored 测试中 rstest 宏：“Cargo.toml not found”                                             | rstest 校验 `Cargo.toml` 存在于清单目录                                                              | `rust_test` 上的 `compile_data = ["Cargo.toml"]`（见 `crates/vendor/uu-tail/BUILD.bazel`）                                                                                     |
| vendored 测试在裸 `test_data/...` 路径 / 符号链接进 srcs 时失败                              | 测试假定 cargo 的 cwd，与 runfiles 执行不兼容                                                        | `tags = ["manual"]`（例如 `//crates/vendor/uu-find:uu-find_test`）；触碰 fork 时经 `cargo nextest` 运行；密闭兄弟测试覆盖契约                                                 |
| blake3 msvc：找不到 `ml64.exe`                                                               | cc-rs 在非 windows 主机上从构建脚本 PATH 解析 MASM                                                    | `@msvc_cc` 中 `bin/ml64.exe → llvm-ml -m64` shim，经 `blake3` 注解 PATH 前置                                                                                                  |
| audiopus_sys msvc：cmake 要求 VS generator / rc+mt 工具；`try_compile` 想要 `msvcrtd.lib`    | linux/mac 主机上的交叉 cmake；Debug 配置 → `/MDd`，精简 xwin splat 缺少它                           | `CMAKE_GENERATOR_x86_64_pc_windows_msvc=Ninja` + `@msvc_cc` 的 `toolchain.cmake`（`CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_msvc`）固定包装器 + Release try-compile + `/MD`      |
| win32 链接怪癖一般                                                                           | —                                                                                                    | 先读 `bazel/toolchains/msvc/NOTES.md`：包装器自定位、`lld-link` flavor/驱动链接行为、`LIB`、`/MD` CRT 选择、xwin splat 注意事项                                               |
| `rust_test(crate = ...)` 宏展开时“can't find crate”                                          | 仅 rmeta 的流水线依赖破坏 macro_rules 再导出 harness 编译                                            | rust pipelined_compilation 保持关闭（`.bazelrc` 备注）                                                                                                                         |
| 构建脚本找不到 cmake/ninja                                                                   | `--incompatible_strict_action_env`——无主机环境泄漏                                                    | crate 注解（`MODULE.bazel`）中的显式 `PATH`，而非主机环境                                                                                                                     |

### 缓存行为

- **omp-kata：** 到集群内 bazel-remote 的读写 gRPC（`grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092`，经提交的 `infra/bazel-remote/ca.crt` 的 TLS，htpasswd 用户 `ci`）。`--remote_local_fallback` 加重试使故障降级为本地执行而非失败构建。
- **GitHub-hosted：** 无集群访问；只有 darwin 发布/预热任务在此用 bazel 构建。v3 `actions/cache` 磁盘键以前缀 + 裸回退分离配置与源代（见上文 `bazel-cache` action 一节）；`.github/workflows/bazel-cache-warm.yml` 从与发布消费者相同的 macOS 镜像发布 `release-darwin-*` 归档。
- **msvc 仓库：** 约 2 GiB 的 LLVM 下载是 sha256 固定且 repository-cache 支持的；约 1 GiB 的 xwin CRT/SDK splat 在仓库规则内从 Microsoft CDN 获取，**不**由 repo-cache 支持——冷输出基座会重新下载。Microsoft 随时间推进 VS channel 负载，因此 MS 提升后 win32 action 的远程缓存命中率优雅下降（先前交叉工具链也有同样属性）。Win32 链接 action 也不跨主机 OS 共享缓存条目（linux 与 mac clang 二进制）。
- 服务器侧操作（部署、TLS/认证、出口、投毒边界）：`infra/docs/04-arc-and-caching.md` §5。

## 目标/变体模型与命名约定

## 平台标签

构建与运行时都使用平台标签：

`<platform>-<arch>`（示例：`darwin-arm64`、`linux-x64`）。

## 变体模型（仅 x64）

x64 支持 CPU 变体，编码为平台上 `//bazel/variants` 约束值（baseline → `-Ctarget-cpu=x86-64-v2`，modern → `x86-64-v3`）：

- `modern`（支持 AVX2 的路径）
- `baseline`（回退）

非 x64 使用单个无变体后缀的默认产物。没有构建时变体_开关_：每个变体是各自的 `//:natives-*` 目标，`host` 伪目标经 AVX2 检测选择 modern vs baseline。

### 输出文件名

- x64：`pi_natives.<platform>-<arch>-modern.node` 或 `...-baseline.node`
- 非 x64：`pi_natives.<platform>-<arch>.node`

运行时 x64 候选顺序在选定变体候选后也包含无后缀默认文件名。

## 运行时标志

- `PI_NATIVE_VARIANT`：x64 运行时覆盖；有效值为 `modern` 与 `baseline`。无效值被忽略并运行正常检测。
- `PI_DEBUG_STARTUP`：在加载器入口、嵌入式提取、候选加载与原生 Tokio 运行时安装周围向 stderr 写入同步 `[startup] native:…` 标记；用它定位启动挂起。
- `PI_COMPILED`：编译模式信号。发布编译将 `process.env.PI_COMPILED` 常量折叠为 `"true"`；已填充的嵌入式插件清单与 Bun 嵌入式 URL 标记也指示编译模式。

## 嵌入生命周期（`embed-native.ts`）

1. **Init**：计算平台标签（主机值，可由发布打包脚本为交叉目标归档覆盖）。
2. **候选集**：
   - x64 查找 `modern` 与 `baseline` 文件；
   - 非 x64 查找一个默认文件。
3. **校验可用性**：`packages/natives/native` 中至少一个预期文件必须存在。
4. **生成归档 + 清单**：写入包含所有可用目标插件文件的 `native/embedded-addons.<platform>-<arch>.tar.gz` 与带包版本、归档元数据与文件大小的 `native/embedded-addon.js`。
5. **运行时提取就绪**供编译模式使用。

`--reset` 写入空清单桩（`embeddedAddon = null`）而不校验插件可用性，并从 `native/` 删除任何现有 `embedded-addons.*.tar.gz` 归档。

## 开发工作流 vs 发布/编译行为

## 本地开发工作流

典型本地循环：

1. 构建插件：`bun --cwd=packages/natives run build`。
2. 加载器解析平台 npm 叶子包候选（`@oh-my-pi/pi-natives-<platform>-<arch>`，可解析时），然后包本地 `native/` 与可执行文件目录回退候选。
3. `native/index.d.ts` 中生成的声明描述公共 TS API（仅当 Rust API 表面改变时用 `build:bindings` 再生成）。
4. 在 Windows 包安装上，加载器先将 `node_modules` 插件复制进版本化缓存，使运行中的进程不会锁定 Bun 在之后的全局更新中必须替换的文件。
5. 成功加载后，更旧的 semver 形版本缓存目录被尽力删除；清理失败从不中止启动。

## 发布/编译二进制工作流

编译模式下（`PI_COMPILED`、Bun 嵌入式 URL 标记或已填充的嵌入式清单）：

1. 加载器计算版本化缓存目录：`<getNativesDir()>/<packageVersion>`。
2. 如果嵌入式清单匹配当前平台+版本，且缓存文件缺失或大小错误，加载器从 `embedded-addons.<tag>.tar.gz` 提取选定文件到该版本化目录。
3. 运行时候选顺序包括：
   - 提取的版本化缓存路径（可用时），
   - 版本化缓存目录，
   - 旧版编译二进制目录（Windows 上 `%LOCALAPPDATA%/omp`，其他平台 `~/.local/bin`），
   - 包/可执行文件目录。
4. 返回第一个成功加载且带预期版本哨兵的插件。

这就是打包与运行时加载器预期必须对齐的原因：文件名、平台标签、CPU 变体与嵌入式清单版本必须匹配 `native/loader-state.js` 探测的内容。

## JS API ↔ Rust 导出映射（构建健全性子集）

生成的声明当前包含来自这些 Rust 模块的导出：

| 领域                | 代表性 JS 导出                                                                                                                  | Rust 源                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 搜索/工作区         | `grep`、`search`、`hasMatch`、`fuzzyFind`、`glob`、`listWorkspace`、`invalidateFsScanCache`                                     | `grep.rs`、`fd.rs`、`glob.rs`、`workspace.rs`、`iofs.rs`                     |
| AST/块/摘要         | `astGrep`、`astEdit`、`blockRangeAt`、`summarizeCode`                                                                           | `ast.rs`、`block.rs`、`summary.rs`                                           |
| 文本/高亮/token     | `visibleWidth`、`truncateToWidth`、`highlightCode`、`countTokens`                                                               | `text.rs`、`highlight.rs`、`tokens.rs`                                       |
| Shell/PTY/进程/按键 | `executeShell`、`Shell`、`PtySession`、`Process`、`parseKey`                                                                    | `shell.rs`、`pty.rs`、`ps.rs`、`keys.rs`                                     |
| 媒体/系统/iso       | `encodeSixel`、`copyToClipboard`、`detectMacOSAppearance`、`MacOSPowerAssertion`、`getWorkProfile`、`isoBackend`、`isoStart`、`isoDiff` | `sixel.rs`、`clipboard.rs`、`appearance.rs`、`power.rs`、`prof.rs`、`iso.rs` |

## 失败行为与诊断

## 构建时失败

- Bazel 分析/编译失败：`scripts/bazel-natives.ts` 呈现退出码加 stderr 尾部；直接重跑打印的 `bazel build` 行（加 `--verbose_failures`、`--sandbox_debug`）迭代。
- 未知目标名：驱动程序报出完整已知目标列表错误（`//:natives-*` 名称 + `host`/`linux-all`/`darwin-all`）。
- 成功构建后未定位 `.node` 输出：驱动程序退出 1（手动检查 `bazel cquery --output=files`）。
- 基名冲突（一次调用中 gnu + musl）：驱动程序拒绝安装并点名两个来源——拆分为单独 `--dest` 目录。
- `build:bindings`（napi）失败：脚本呈现非零退出与 stderr；产物构建不受影响（Bazel 从不运行 napi CLI）。

## 运行时加载器失败（`native/loader-state.js`）

- 不支持的平台标签：探测失败后抛出并列出支持的平台。
- 无候选可加载：抛出完整候选错误列表与模式特定补救提示。
- 嵌入式提取与 Windows 暂存问题：归档/mkdir/写入/复制错误被记录，并在加载失败时纳入最终诊断。
- 版本不匹配：缺少包版本哨兵的安装/编译加载在候选探测期间被拒绝。

## 故障排查矩阵

| 症状                                                                | 可能原因                                                                                | 验证                                                            | 修复                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 每个候选都报 `Cannot find module` 或动态库加载错误                    | 缺少发布产物、平台标签错误或过期编译缓存                                                 | 检查加载器错误列表与 `packages/natives/native` 文件名            | 构建正确目标（`bun scripts/bazel-natives.ts <t> --dest packages/natives/native`）；删除该包版本的过期缓存                             |
| 运行时缺少导出但 TypeScript 中有                                     | 加载了过期 `.node`、生成的声明比二进制新、或 Rust 导出未编译                              | require 实际候选并检查 `Object.keys(mod)`                       | 重建原生包并移除过期候选/缓存路径                                                                                                     |
| x64 机器在预期 modern 时加载 baseline                                | `PI_NATIVE_VARIANT=baseline`、未检测到 AVX2 或 modern 文件不可用                         | 检查 `native/` 中的环境与文件名                                 | 构建并发布 modern 目标（`bun scripts/bazel-natives.ts linux-x64-modern --dest packages/natives/native`）                              |
| gnu 插件被 musl 覆盖（反之亦然）                                      | 两者构建进同一 dest——它们按设计共享规范基名                                               | 比较 `bazel-bin/natives-<t>/` 源与已安装文件                    | 用单独 `--dest` 目录单独调用（发布矩阵已如此）                                                                                        |
| 升级后编译二进制失败                                                  | 过期提取缓存、嵌入式归档不匹配或嵌入式清单版本不匹配                                      | 检查 `<getNativesDir()>/<version>` 与加载器错误列表              | 删除该包版本的版本化缓存；打包时重新生成嵌入式归档/清单                                                                               |
| `gen:native` 失败报 `No native addons found`                         | 嵌入前未构建所需平台产物                                                                 | 检查错误文本中的预期列表                                         | 为目标构建至少一个预期产物，然后重跑 `gen:native`                                                                                     |

## 操作命令

```bash
# Addon for the current host, installed into packages/natives/native/
bun --cwd=packages/natives run build

# Explicit targets (x64 variants are separate targets, not env switches)
bun scripts/bazel-natives.ts linux-x64-modern linux-x64-baseline --dest packages/natives/native

# Raw bazel (output: bazel-bin/natives-<t>/pi_natives.<...>.node)
bazelisk build //:natives-darwin-arm64

# Regenerate TS typedefs + enum exports (napi CLI, only on Rust API changes)
bun --cwd=packages/natives run build:bindings

# Generate embedded addon manifest from built native files
bun run gen:native
# Output archive: packages/natives/native/embedded-addons.<platform>-<arch>.tar.gz

# Reset embedded manifest to null stub
bun run gen:native:reset
```

## 编排器侧内容寻址构建缓存（robomp）

当 `pi-natives` 在 robomp 编排器（`python/robomp/`）内构建时，工作区通过内容寻址缓存共享构建产物，而不是在每个 per-issue 工作树中从头重建。缓存**仅编排器侧**——`bun --cwd=packages/natives run build` 本身不变；缓存存在于构建流水线之外，并在 `python/robomp/src/natives_cache.py` 的 `ensure_workspace` 与任务后成功路径周围填充/捕获。

### 缓存什么

缓存从 `packages/natives/native/` 捕获以下文件，置于计算键下。正确复用假定键控路径的工作树内容匹配已提交 `HEAD`；由于键忽略未提交更改，否则脏键控路径的构建可能被捕获在未变键下并在之后复用：

- `pi_natives.<platform>-<arch>[-variant].node`（glob `pi_natives.*.node`）
- `index.d.ts`
- `index.js`
- `embedded-addon.js`
- `manifest.json`（缓存元数据：键、目标三元组、捕获时间戳、源工作区、提交）

仅当 `.node` glob 匹配**且**每个伴生文件加清单都存在时，条目才算命中。部分条目在 GC 时被逐出。

### 缓存键

键是以下输入（按此顺序，顺序有意义）的 `(path \t git-tree-hash \n)` 对的 `sha256`，后跟目标三元组：

1. `crates`（整个子树——pi-natives 传递依赖其他工作区 crates）
2. `Cargo.lock`
3. `Cargo.toml`
4. `rust-toolchain.toml`
5. `packages/natives`（整个子树——构建脚本、`scripts/*`、package.json）

树哈希来自对 `HEAD` 的一次 `git cat-file --batch-check` 调用；`HEAD` 中缺失的路径折叠为固定空哈希，使键在不发布每个输入的仓库间保持确定性。目标后缀在非 x64 上是 `<platform>-<arch>`。x64 上是 `<platform>-<arch>-<TARGET_VARIANT>`，`TARGET_VARIANT` 未设置时为 `<platform>-<arch>-host`；Python 缓存不做 AVX2 检测。

此输入集之外的任何内容（`MODULE.bazel`/`BUILD.bazel` 等 Bazel 定义文件、主机 glibc、目标后缀之外的环境变量）都**不在**键中。内容哈希还描述已提交的 `HEAD`，而非未提交的工作树更改。在键外或未提交的构建输入更改后删除相关缓存条目；在五个键控路径之一提交更改会自动产生新键。

### 布局与归属

- 根：`/data/cache/pi-natives`（由 `entrypoint.sh` 与 cargo 缓存一起提供，属主 `root:omp`，模式 `02770` setgid，使缓存文件继承 `gid=omp` 并保持每个 slot 用户可读）。
- Per-repo 子目录：`<root>/<repo-slug>/`，slug 为 `owner__repo`（镜像 `SandboxManager.pool_path`）。
- Per-entry 目录：`<root>/<repo-slug>/<sha256-key>/`，包含缓存文件加 `manifest.json`。
- Per-repo 锁文件：`<root>/<repo-slug>/.lock`（建议性 `fcntl.flock`，捕获与 GC 时排他）。
- 捕获期间的暂存目录（`.<key>.tmp.<pid>`）；原子重命名进最终条目路径。崩溃捕获留下的过期暂存目录在 GC 时清扫。

### 填充与捕获语义

- **填充**（工作区 ← 缓存）在 `ensure_workspace` 内运行。键命中时 `.node` 被**硬链接**进工作区（零拷贝，共享 inode）；伴生 `index.d.ts` / `index.js` / `embedded-addon.js` 被**复制**（独立 inode），因为绑定再生成流程（`build-bindings.ts` 的 `installGeneratedBindings` 与 `gen-enums.ts`）经 `open(..., 'w')` 重写这些文件——原地截断会经硬链接传播并损坏缓存。跨设备硬链接失败（`EXDEV`）回退到复制。
- **捕获**（缓存 ← 工作区）在构建产生完整产物集时从任务后成功路径运行。捕获使用**复制**而非硬链接：硬链接 slot 拥有的工作区文件会保留缓存 inode 上的 slot UID 属主，破坏共享组模型。复制经 setgid 缓存根创建全新 root 拥有、`gid=omp` 的 inode。捕获在 per-repo flock 下幂等：同一键的并发捕获返回现有条目。

### 垃圾回收

`WorkerPool` 中运行周期性 GC 循环，每仓库两个上限。任一上限超出时，最先删除最旧条目（按 `manifest.json.captured_at`）：

- 条目数上限（`max_entries_per_repo`，默认 8）
- 字节上限（`max_bytes`，默认 4 GiB）

GC 前硬链接了 `.node` 的工作区经内核 inode 引用计数保留访问——`rmtree` 缓存条目不会从工作区删除文件。

### 配置（`robomp.config.Settings` 上的设置）

| 环境变量                                     | 默认值                  | 作用                                                                                              |
| -------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `ROBOMP_NATIVES_CACHE_ENABLED`               | `true`                  | 总开关。为 false 时填充/捕获钩子为 no-op，每个工作区从头构建。                                    |
| `ROBOMP_NATIVES_CACHE_ROOT`                  | `/data/cache/pi-natives`| 缓存根目录。必须为 `root:omp 02770` 以支持跨 slot 读取。                                          |
| `ROBOMP_NATIVES_CACHE_MAX_ENTRIES_PER_REPO`  | `8`                     | LRU 条目数上限，按 repo slug。                                                                    |
| `ROBOMP_NATIVES_CACHE_MAX_BYTES`             | `4294967296`（4 GiB）   | LRU 字节上限，按 repo slug。                                                                      |
| `ROBOMP_NATIVES_CACHE_GC_INTERVAL_SECONDS`   | `3600`                  | `WorkerPool` 中后台 GC 循环的周期。                                                               |

### 手动失效

- 一个键：`rm -rf /data/cache/pi-natives/<repo-slug>/<sha256>`。
- 一个仓库：`rm -rf /data/cache/pi-natives/<repo-slug>`。
- 全部：`rm -rf /data/cache/pi-natives/*`（保留根，使其 setgid 模式存活）。
- 卡住的锁：`rm /data/cache/pi-natives/<repo-slug>/.lock`（仅在无编排器进程触碰该仓库时）。

对于固定目标后缀，`crates/`、`Cargo.lock`、`Cargo.toml`、`rust-toolchain.toml` 或 `packages/natives/` 下已提交的 `HEAD` 更改会产生自动未命中。更改平台/架构或 x64 上的 `TARGET_VARIANT` 也选择不同键。仅编辑未提交工作树既不改变 `HEAD` 哈希也不改变键。
