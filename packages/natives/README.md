# @oh-my-pi/pi-natives

通过 N-API 提供的原生 Rust 功能。

## 内含内容

- **Grep**:由 ripgrep 引擎驱动的正则搜索,带原生文件遍历与匹配
- **Find**:带 gitignore 支持的、基于 glob 的文件/目录发现(通过 `globPaths` 的纯 TypeScript)
- **SIXEL**:面向支持 SIXEL 的终端的终端图像编码(一次完成解码、缩放、编码)
- **Audio**:跨平台低延迟麦克风采集与无间隙扬声器播放
- **WebRTC**:原生 Opus 媒体、SDP offer/answer 协商,以及实时会话的数据通道事件
- **文件锁**:进程拥有的跨进程锁,Linux/Windows 上使用内存内核名,其它 Unix 平台使用 `flock(2)` sidecar

通用图像处理(面向文件与缓冲区的解码/缩放/编码)在 JS 侧位于 [`Bun.Image`](https://bun.com/docs/runtime/image);本 crate 只发布 SIXEL 编码器,因为该终端协议没有内置等价实现。

## 用法

```typescript
import { grep, find, encodeSixel } from "@oh-my-pi/pi-natives";

// 按模式 Grep
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// 查找文件
const files = await find({
	pattern: "*.rs",
	path: "/path/to/project",
	fileType: "file",
});

// 为终端单元格框(px)做 SIXEL 编码
const sequence = encodeSixel(pngBytes, widthPx, heightPx);
```

## 构建

```bash
# 从 workspace 根目录构建原生 addon(需要 Rust)
bun run build

# 类型检查
bun run check
```

## 架构

`@oh-my-pi/pi-natives` 发布一个小型核心包,外加生成的平台专属可选依赖包:

```
crates/pi-natives/       # Rust 源码(workspace 成员)
  src/lib.rs             # N-API 导出
  src/sixel.rs           # SIXEL 终端图像编码
  Cargo.toml             # Rust 依赖
native/                  # 核心加载器文件与本地/CI 原生构建产物
  index.js               # 公共原生导出面
  loader-state.js        # 平台、ISA 变体与 addon 解析
  embedded-addon.js      # 独立二进制嵌入桩/生成元数据
  pi_natives.<platform>-<arch>-modern.node   # x64 现代 ISA(本地/CI 产物)
  pi_natives.<platform>-<arch>-baseline.node # x64 基线 ISA(本地/CI 产物)
  pi_natives.<platform>-<arch>.node          # 非 x64 构建产物
npm/<platform>-<arch>/   # 发布时生成,不提交
  package.json           # @oh-my-pi/pi-natives-<platform>-<arch>
  *.node                 # 仅该平台的 addon 二进制或 x64 ISA 变体
```

发布的核心包只包含 JS 加载器、声明、README 与 `package.json`。发布流程为每个受支持的 `os`/`cpu` 组合生成一个叶子包,并把叶子作为固定版本 `optionalDependencies` 注入核心清单,因此包管理器只安装宿主平台的原生 addon。x64 叶子包含每个已构建的 ISA 变体,加载器在运行时持续在 `baseline` 与 `modern` 之间选择。
