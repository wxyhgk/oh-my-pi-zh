# Natives 媒体与系统工具

本文档涵盖 `@oh-my-pi/pi-natives` 当前提供的媒体/系统/转换导出:音频采集/播放与实时 WebRTC 媒体、终端 SIXEL 与 snapcompact PNG 编码、HTML 转换、剪贴板访问、token 计数、DeviceCheck、macOS 外观/电源辅助功能,以及工作性能剖析。

## 实现文件

- `crates/pi-natives/src/audio.rs`
- `crates/pi-natives/src/live.rs`
- `crates/pi-natives/src/snapcompact.rs`
- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/tokens.rs`
- `crates/pi-natives/src/devicecheck.rs`
- `crates/pi-natives/src/appearance.rs`
- `crates/pi-natives/src/power.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

当前 `pi-natives` 插件中不存在原生 `PhotonImage` 类、`image.rs` 或 ProjFS 覆盖辅助模块。通用图像解码/缩放/编码预期在该接口之外实现;这里与图像相关的导出是终端 SIXEL 编码和 snapcompact PNG 帧渲染。

## JS API ↔ Rust 导出/模块映射

| JS 导出                                 | Rust N-API 导出                   | Rust 模块          |
| --------------------------------------- | --------------------------------- | ------------------ |
| `new AudioCapture(sampleRate, cb)`      | `AudioCapture`                    | `audio.rs`         |
| `new AudioPlayback(sampleRate)`         | `AudioPlayback`                   | `audio.rs`         |
| `new LiveWebRtcPeer(...)`               | `LiveWebRtcPeer`                  | `live.rs`          |
| `encodeSixel(bytes, width, height)`     | `encode_sixel`                    | `sixel.rs`         |
| `renderSnapcompactPng(text, options)`   | `render_snapcompact_png`          | `snapcompact.rs`   |
| `snapcompactSupportedChars(font, chars)`| `snapcompact_supported_chars`     | `snapcompact.rs`   |
| `htmlToMarkdown(html, options?)`        | `html_to_markdown`                | `html.rs`          |
| `copyToClipboard(text)`                 | `copy_to_clipboard`               | `clipboard.rs`     |
| `readImageFromClipboard()`              | `read_image_from_clipboard`       | `clipboard.rs`     |
| `countTokens(input, encoding?)`         | `count_tokens`                    | `tokens.rs`        |
| `detectMacOSAppearance()`               | `detect_macos_appearance`         | `appearance.rs`    |
| `MacAppearanceObserver.start(cb)`       | `MacAppearanceObserver::start`    | `appearance.rs`    |
| `MacOSPowerAssertion.start(options?)`   | `MacOSPowerAssertion::start`      | `power.rs`         |
| `getWorkProfile(lastSeconds)`           | `get_work_profile`                | `prof.rs`          |
| `deviceCheckGenerateToken()`            | `device_check_generate_token`     | `devicecheck.rs`   |

## 数据格式边界与转换

### 音频与实时 WebRTC

- `AudioCapture(sampleRate, callback)` 打开默认麦克风,以请求的逻辑采样率提供低延迟单声道 `Float32Array` PCM 块。`stop()` 立即释放采集。
- `AudioPlayback(sampleRate)` 打开默认扬声器。`write(samples)` 按顺序排队单声道 `Float32Array` PCM;`setGain(gain)` 即使对已排队的样本也能更改渲染增益;`end()` 排空并关闭,而 `stop()` 立即丢弃已排队的音频。
- `LiveWebRtcPeer(onEvent, onLevel, onFailure)` 为 Codex 实时媒体持有一个 WebRTC 对端。`createOffer()` 返回 SDP,`acceptAnswer(sdp)` 应用远端 answer,`waitForOpen(timeoutMs?)` 等待 `oai-events` 数据通道,`pushAudio()` 排队 16 kHz 单声道 PCM,`setMuted()` 控制发送,`close()` 拆除媒体、数据通道、对端与播放。

### SIXEL 图像编码(`sixel`)

- **JS 输入边界**:包含编码图像字节的 `Uint8Array`。
- **Rust 解码边界**:格式通过 `ImageReader::with_guessed_format()` 猜测,然后解码为 `DynamicImage`。
- **缩放边界**:仅当源尺寸与 `targetWidthPx`/`targetHeightPx` 不同时,才使用 `resize_exact(..., FilterType::Lanczos3)` 缩放图像。
- **输出边界**:`encodeSixel(...)` 同步返回 SIXEL 转义字符串。

支持的解码格式取决于此构建中编译的 `image` crate 对 `ImageReader` 的支持(通常是 PNG/JPEG/WebP/GIF)。无效的目标尺寸(宽或高为 `0`)会以 `Target SIXEL dimensions must be greater than zero` 失败。

### Snapcompact PNG 渲染

`renderSnapcompactPng(text, options)` 在受限位图上渲染预规范化文本,并异步返回 **base64 编码的 PNG 字符串**。N-API 传输类型是 `Latin1String`,但该字符串包含的是 base64 文本而非原始单字节 PNG 数据;在将结果当作 PNG 字节处理之前,请先进行 base64 解码。`options.size` 为必填;可选控制项包括 `font`、`cellWidth`、`cellHeight`、`variant`、`lineRepeat`、`stretch` 和 `columns`。输出高度贴合已使用的行,溢出的输入会被忽略。`snapcompactSupportedChars(font, chars)` 仅返回指定捆绑字体所支持的字符。

### HTML 转换(`html`)

- **JS 输入边界**:HTML `string` + 可选 `{ cleanContent?: boolean; skipImages?: boolean }`。
- **Rust 转换边界**:转换通过 `task::blocking("html_to_markdown", (), ...)` 调度;此导出没有超时/中止选项。
- **输出边界**:Markdown `string` 的 Promise。

转换行为:

- `cleanContent` 默认为 `false`。
- 当 `cleanContent=true` 时,启用预处理:`PreprocessingPreset::Aggressive`、`remove_navigation=true` 和 `remove_forms=true`。
- `skipImages` 默认为 `false`,并传给 `html_to_markdown_rs::ConversionOptions`。

### 剪贴板(`clipboard`)

- `copyToClipboard(text)` 是使用 `arboard::Clipboard::set_text` 的同步原生调用。在 Linux 上,会保持一个进程生命周期内的单个 `Clipboard` 实例存活(X11/Wayland 选区所有权);macOS/Windows 每次调用使用临时实例。
- `readImageFromClipboard()` 在 `task::blocking("clipboard.read_image", (), ...)` 中运行。
- 当 `arboard` 报告 `ContentNotAvailable` 时,图像读取返回 `null`/`undefined`。
- 成功的图像读取会将剪贴板 RGBA 数据转换为 PNG 字节,并返回 `{ data: Uint8Array, mimeType: "image/png" }`。
- 剪贴板访问或图像编码失败会以原生错误的形式 reject/抛出。

当前没有 `packages/natives` TS 包装层来发出 OSC52、处理 Termux 或抑制原生剪贴板失败。任何尽力而为的剪贴板策略都必须由消费方实现。

### Token 计数(`tokens`)

- `countTokens(input, encoding?)` 接受单个字符串或字符串数组。
- 数组返回一个聚合的 token 计数;数组元素通过 rayon 并行编码。
- 默认编码为 `O200kBase`;同时也导出 `Cl100kBase`。
- 实现使用 `encode_ordinary`,不处理特殊 token。
- BPE 表通过 `LazyLock` 只初始化一次并复用。

### DeviceCheck

`deviceCheckGenerateToken()` 在原生辅助程序的一秒等待内解析,返回 `{ supported, tokenBase64?, error?, latencyMs }`。它以结果形式报告不支持的平台/设备与生成失败,而不是要求 token 必须存在。

### macOS 外观与电源辅助功能

- `detectMacOSAppearance()` 在非 macOS 上返回 `"dark"`、`"light"` 或 `null`。
- `MacAppearanceObserver.start(callback)` 返回带 `stop()` 的句柄;在 macOS 上使用分布式通知外加 2 秒轮询回退,在非 macOS 上是不执行任何操作的观察者。
- `MacOSPowerAssertion.start(options?)` 返回带 `stop()` 的句柄;在 macOS 上获取一个或多个 IOKit 断言,在其他平台上是不执行任何操作的句柄。
- 电源断言选项为 `{ reason?, idle?, system?, user?, display? }`。如果所有布尔值都未设置或省略,则默认使用 `idle` 行为。

### 工作性能剖析(`prof`)

- **采集边界**:性能样本由 `task::blocking` 与 `task::future` 中的 `profile_region(tag)` 守卫产生。
- **存储格式**:固定大小的环形缓冲区(`MAX_SAMPLES = 10_000`),存储堆栈路径、时长与时间戳。
- **输出边界**:`getWorkProfile(lastSeconds)` 返回:
  - `folded`:折叠堆栈文本(flamegraph 输入)
  - `summary`:markdown 表格摘要
  - `svg`:可选的 flamegraph SVG
  - `totalMs`、`sampleCount`

## 生命周期与状态转换

### SIXEL 生命周期

1. `encodeSixel(bytes, targetWidthPx, targetHeightPx)` 校验目标尺寸。
2. Rust 猜测并解码编码图像。
3. 需要时将图像精确缩放到目标尺寸。
4. 像素转换为 RGBA8,并用 `icy_sixel::sixel_encode` 编码。
5. 同步返回 SIXEL 转义字符串。

失败转换:

- 格式检测/解码失败抛出。
- 无效目标尺寸抛出。
- SIXEL 编码失败抛出 `Failed to encode SIXEL: ...`。

### HTML 生命周期

1. `htmlToMarkdown(html, options)` 调度一个阻塞转换任务。
2. 除非另行指定,转换使用默认选项(`cleanContent=false`、`skipImages=false`)运行。
3. 上游转换器负责规范化与预处理,使受影响的辅助遍历保持迭代式,并将剩余的递归 DOM 遍历限制在 64;达到该上限时拒绝转换,而不是返回部分 Markdown。
4. 返回 markdown 字符串,或拒绝并抛出 `Conversion error: ...`。

### 剪贴板生命周期

- 文本复制同步调用 `set_text`;macOS/Windows 每次调用构造临时 `arboard::Clipboard`,而 Linux 在首次复制时初始化一个进程生命周期的实例并复用。
- 图像读取构造 `arboard::Clipboard`,调用 `get_image`,成功时编码 PNG,将 `ContentNotAvailable` 映射为 `None`,并拒绝其他错误。

### 工作性能剖析生命周期

1. 无显式启动:task 辅助函数执行时剖析即处于活动状态。
2. 每个被插桩的 task 作用域在守卫 drop 时记录一个样本。
3. 达到缓冲区容量后,样本覆盖最旧的条目。
4. `getWorkProfile(lastSeconds)` 读取一个时间窗口,并派生 folded/summary/svg 产物。

失败转换:

- SVG 生成失败是软失败(`svg` 省略/undefined),而 folded 与 summary 仍会返回。
- 空样本窗口返回空的 folded 数据且无 SVG,而不是错误。

## 不支持的操作与错误传播

### SIXEL

- 不支持或损坏的图像输入是严格失败。
- 无效的 SIXEL 目标尺寸是严格失败。
- natives 包未暴露任何 JS 回退路径。

### HTML

- 转换错误是严格失败。
- 选项省略是默认化,而非失败。

### 剪贴板

- 文本复制在原生 API 层面是严格的。
- 图像读取区分“无图像”(`null`/`undefined`)与操作失败(reject)。

### 工作性能剖析

- 函数调用本身的检索是严格的。
- Flamegraph SVG 生成是可空/可选的。
- 缓冲区截断是预期的环形缓冲区行为。

## 平台注意事项

- 剪贴板访问依赖于 `arboard` 暴露的 OS/会话支持。
- macOS 外观与电源辅助功能在不支持的平台上刻意返回 no-op/null 行为。
- 此媒体/系统原生工具接口不暴露 ProjFS。隔离后端的选择(包括任何 ProjFS 支持)位于独立的 `iso` 子系统中。
