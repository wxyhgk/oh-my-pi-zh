# browser

> 打开、复用、关闭浏览器标签页并对其执行脚本:可面向项目共享的 Chromium、通过 CDP 附加的应用、通过 OMP Browser Relay 连接的用户 Chrome,或 cmux 表面。

## 源码
- 入口:`packages/coding-agent/src/tools/browser.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/browser.md`
- 主要协作者:
  - `packages/coding-agent/src/tools/browser/tab-supervisor.ts` — 全局标签页注册表;worker 生命周期;运行/关闭协调。
  - `packages/coding-agent/src/tools/browser/tab-worker.ts` — 执行 `run` 代码;实现 `tab` 辅助 API。
  - `packages/coding-agent/src/tools/browser/tab-worker-entry.ts` — worker 线程传输引导。
  - `packages/coding-agent/src/tools/browser/registry.ts` — 按浏览器种类键控的浏览器句柄注册表。
  - `packages/coding-agent/src/tools/browser/launch.ts` — Puppeteer 加载、Chromium 解析/下载、无头启动、stealth 注入。
  - `packages/coding-agent/src/tools/browser/shared-daemon.ts` — 项目共享的、由 broker 拥有的 Chromium(通过 daemon broker 确保/附加)。
  - `packages/coding-agent/src/tools/browser/attach.ts` — CDP 附加/复用、目标选取、spawned-app 进程处理。
  - `packages/coding-agent/src/tools/browser/tab-protocol.ts` — worker 初始化/运行/结果消息模式。
  - `packages/coding-agent/src/tools/browser/readable.ts` — `tab.extract()` 可读性提取。
  - `packages/coding-agent/src/tools/browser/aria/aria-snapshot.ts` — `captureAriaSnapshot()`(puppeteer/CDP 路径)和 `buildAriaSnapshotScript()`(cmux 路径);导入已提交的 `aria-snapshot.bundle.txt`。
  - `packages/coding-agent/src/tools/browser/aria/aria-snapshot.bundle.txt` — 生成并提交的产物:Playwright 注入的 ARIA 快照源码(Apache-2.0,(c) Microsoft;ARIA 树 + W3C accessible-name 计算)打包成 CJS 模块。上游源码未 vendor 进仓库。
  - `packages/coding-agent/scripts/generate-aria-snapshot.ts` — 把固定的 Playwright 源码拉到临时目录,并打包进 `aria-snapshot.bundle.txt`(CJS,浏览器目标)。仅开发期运行、依赖网络;只有打包产物会被提交。
  - `packages/coding-agent/src/tools/browser/cmux/rpc.ts` — cmux 浏览器种类解析,以及 cmux 后端的 snapshot/eval/wait-state 辅助函数。
  - `packages/coding-agent/src/tools/browser/cmux/socket-client.ts` — `CmuxSocketClient`:通过 cmux unix socket 的 JSON-RPC。
  - `packages/coding-agent/src/tools/browser/cmux/cmux-tab.ts` — `CmuxTab` 表面辅助 API 和 `runCmuxCode()` 执行路径。
  - `packages/coding-agent/src/tools/browser/relay/kind.ts` — relay 设置/环境变量解析与默认端点。
  - `packages/coding-agent/src/tools/browser/relay/daemon.ts` — 机器全局的、由 broker 拥有的 relay 自动启动。
  - `packages/coding-agent/src/tools/browser/relay/{server,bridge,protocol}.ts` — 回环 CDP 门面和 Chrome 扩展协议桥。
  - `packages/coding-agent/src/eval/js/shared/runtime.ts` — 共享 `JsRuntime`,执行 `run` 代码(与 `eval` JS 工具同一引擎);worker 和 cmux 后端都委托给它。
  - `packages/coding-agent/src/tools/browser/render.ts` — `open`/`close` 状态行和 `run` JS 单元格的 TUI 渲染。
  - `packages/coding-agent/src/tools/puppeteer/00_stealth_tampering.txt` — 把被 patch 的函数/描述符伪装成原生。
  - `packages/coding-agent/src/tools/puppeteer/01_stealth_activity.txt` — 合成可见性/焦点/滚动活动。
  - `packages/coding-agent/src/tools/puppeteer/02_stealth_hairline.txt` — 修复 Modernizr 发丝线检测。
  - `packages/coding-agent/src/tools/puppeteer/03_stealth_botd.txt` — 伪造 `navigator.webdriver`、`window.chrome` 和 Chrome 指纹表面。
  - `packages/coding-agent/src/tools/puppeteer/04_stealth_iframe.txt` — patch iframe `contentWindow`/`srcdoc` 行为。
  - `packages/coding-agent/src/tools/puppeteer/05_stealth_webgl.txt` — 伪造 WebGL 厂商/渲染器/精度。
  - `packages/coding-agent/src/tools/puppeteer/06_stealth_screen.txt` — 规范化屏幕/视口/设备像素比值。
  - `packages/coding-agent/src/tools/puppeteer/07_stealth_fonts.txt` — 伪造本地字体并扰动 canvas 文本渲染。
  - `packages/coding-agent/src/tools/puppeteer/08_stealth_audio.txt` — 伪造音频延迟/采样率并扰动离线渲染。
  - `packages/coding-agent/src/tools/puppeteer/09_stealth_locale.txt` — 强制 locale/语言/时区/日期字符串。
  - `packages/coding-agent/src/tools/puppeteer/10_stealth_plugins.txt` — 合成 `navigator.plugins`/`navigator.mimeTypes`。
  - `packages/coding-agent/src/tools/puppeteer/11_stealth_hardware.txt` — 伪造 `navigator.hardwareConcurrency`。
  - `packages/coding-agent/src/tools/puppeteer/12_stealth_codecs.txt` — 伪造媒体编解码器支持。
  - `packages/coding-agent/src/tools/puppeteer/13_stealth_worker.txt` — 把 UA/平台伪造带入 `Worker`/`SharedWorker`。

## 输入

### 共享字段

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `action` | `"open" \| "close" \| "run"` | 是 | 分发到 open/close/run 路径。 |
| `name` | `string` | 否 | 标签页 id。默认 `"main"`。标签页存在于进程全局 map 中,因此同名会被后续调用和进程内子代理复用,直到关闭。 |
| `timeout` | `number` | 否 | 工具墙钟超时(秒)。默认 `30`;执行前会被钳制到 browser 工具的范围。 |

### `action: "open"`

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `url` | `string` | 否 | 标签页就绪后导航。提供 `url` 时,已有的可复用标签页也会导航。 |
| `viewport` | `{ width: number; height: number; scale?: number }` | 否 | 请求的视口。无头启动时成为初始视口;对页面则通过 `page.setViewport()` 应用。`scale` 映射到 Puppeteer 的 `deviceScaleFactor`。 |
| `wait_until` | `"load" \| "domcontentloaded" \| "networkidle0" \| "networkidle2"` | 否 | 导航等待条件。省略时默认 `"load"`,包括 `open` 导航和后续的 `tab.goto(...)`。 |
| `dialogs` | `"accept" \| "dismiss"` | 否 | 安装页面 `dialog` 处理器,自动接受或自动关闭对话框。省略则无处理器。 |
| `app` | `{ path?: string; cdp_url?: string; relay?: boolean; args?: string[]; target?: string }` | 否 | 选择浏览器种类。显式 `app.cdp_url` 优先,然后是 `app.path`,再是 relay 选择。`app.relay: true` 启用 OMP Browser Relay;`app.relay: false` 对本次调用抑制 relay 设置。没有显式 app 种类时,`browser.relay`(可被 `PI_BROWSER_RELAY` 覆盖)先于 `browser.cdpUrl`,然后是可用时的 cmux,最后是 `browser.headless`。`browser.relayUrl` 默认为 `http://127.0.0.1:9224`。`args` 只作用于 spawn 的 `app.path`;`target` 按 URL/标题子串选择附加/生成/relay 页面。 |

### `action: "close"`

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `all` | `boolean` | 否 | 关闭所有已知标签页。省略则只关闭 `name`。 |
| `kill` | `boolean` | 否 | 当释放标签页使 spawned-app 浏览器句柄引用计数降到 0 时,同时终止其进程树。对无头关闭无影响,对已连接的 CDP 浏览器仅断开连接。 |

### `action: "run"`

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `code` | `string` | 是 | 由共享 `JsRuntime` 执行的异步函数体(`src/eval/js/shared/runtime.ts`,与 `eval` JS 工具同一引擎)。作用域内包含浏览器特定的 `page`、`browser`、`tab`、`assert(cond, msg?)` 和 `wait(ms)`,以及运行时 prelude 辅助函数(`display`、`print`、`read`、`write`、`append`、`tree`、`env`、`tool`、`completion`、`agent`、`parallel`、`pipeline`、`log`、`phase`、`budget`,……)和环境 Bun 全局(`console`、定时器、`URL`、`TextEncoder`/`TextDecoder`、`Buffer`)。 |

## 输出
该工具每次调用返回一个结果;浏览器实现本身不发出流式部分输出。

- `open`:文本内容,包含 `Opened` 或 `Reused`、浏览器描述、URL 和可选标题。`details` 包含 `action`、`name`、`browser`、`url`、`viewport`,以及 `details.result` 中的相同文本。
- `close`:文本内容,包含 `Closed ...` 或 `No tab named ...`。`details` 包含 `action`、`name` 和 `details.result`。
- `run`:按以下规则构建的有序 `content` 数组:
  1. 按执行顺序排列的每个结构化 display 输出(object/image 的 `display(value)` 调用加上辅助函数状态事件),
  2. 最终返回值,除非已是字符串,否则 JSON 序列化,
  3. 如果未产生其他内容,则为 `Ran code on tab "..."`。
- `display(value)` 由共享运行时的 `displayValue()` 处理(`src/eval/js/shared/runtime.ts`),再由 `WorkerCore.#pushDisplay()` 映射为内容(`packages/coding-agent/src/tools/browser/tab-worker.ts`):
  - 带可解码 base64 的 `{ type: "image", data, mimeType }` 变成图像内容;无法识别的 `data` 形状会被丢弃并附带调试说明。
  - 其他任何 object/array 变成美化 JSON 文本(`JSON.stringify(value, null, 2)`);无法结构化克隆的值会被丢弃并附带调试说明。
  - 辅助函数副作用(`read`/`write`/`tree`/……)发出 `status` 事件,以紧凑 JSON 文本形式呈现。
  - 原始类型的 `display(value)`(string/number/……)和 `console.*` 流入文本通道,worker 将其作为调试日志转发而非工具内容;`undefined` 被忽略。
- `tab.screenshot()` 返回保存的路径,并追加文本和图像,除非 `silent: true`;`details.screenshots` 记录 `{ dest, mimeType, bytes, width, height }`。
- `run` 的 `details` 包含 `action`、`name`、标签页存在时的当前 `browser`/`url`、可选的 `screenshots`,以及只含拼接文本输出的 `details.result`。合并后的 run 文本通过 `enforceInlineByteCap()` 限制在内联字节上限内;超限文本保存为会话产物(`saveBrowserOutputArtifact()`),截断后的文本替换 content 和 `details.result` 中的内容。

## 流程
1. `BrowserTool.execute()`(`packages/coding-agent/src/tools/browser.ts`)做 abort 检查,通过 `clampTimeout("browser", ...)` 钳制 `timeout`,将 `name` 默认为 `"main"`,并按 `action` 分发。
2. `open` 用 `resolveBrowserKind()` 解析浏览器种类:
   - `app.cdp_url` → 去除尾部斜杠后为 `{ kind: "connected" }`。
   - `app.path` → 相对会话 cwd 解析后为 `{ kind: "spawned" }`。
   - `app.relay: true` → relay 模式,除非 `PI_BROWSER_RELAY=0` 禁用它。
   - 否则,除非 `app.relay === false`,`browser.relay` 选择 relay 模式;`PI_BROWSER_RELAY=0|1` 是最终的设置覆盖,`browser.relayUrl` 提供端点。
   - 否则,非空的 `browser.cdpUrl` 设置 → `{ kind: "connected" }`。
   - 否则,当设置了 `CMUX_SOCKET_PATH` 且启用了 cmux 时(`browser.cmux`,可由 `PI_BROWSER_CMUX` 覆盖),`resolveCmuxKind()` → `{ kind: "cmux", socketPath, password?, surface? }`。
   - 否则 → `{ kind: "headless", headless: session.settings.get("browser.headless") }`。
3. `open` 拒绝跨浏览器种类复用同名标签页(`sameBrowserKind()`);调用方必须先关闭。
4. `open` 通过 `acquireBrowser()`(`packages/coding-agent/src/tools/browser/registry.ts`)获取浏览器句柄:
   - 已有的 connected 句柄按浏览器种类键复用;
   - headless 附加到项目共享的、由 broker 拥有的 Chromium(`ensureSharedBrowser()`);在 CLI 宿主进程中,broker 失败是硬错误,而非 CLI 宿主(`bun test`、SDK 嵌入)通过 `launchHeadlessBrowser()` 启动进程本地 Chromium;
   - `connected` 等待 `${cdpUrl}/json/version`,然后 `puppeteer.connect()`;
   - `relay` 在 CLI 宿主中为回环端点自动启动机器全局的、由 broker 拥有的服务器,等待扩展握手最多 35 秒,然后通过 Puppeteer 附加。远程端点和非 CLI 宿主必须已在服务;
   - `spawned` 先尝试 `findReusableCdp()`,否则杀死同路径进程,分配空闲回环端口,以 `--remote-debugging-port=<port>` 启动可执行文件,等待 CDP,然后连接;
   - `cmux` 将 `CmuxSocketClient` 连接到 cmux unix socket;已有 cmux 句柄无条件复用(不做连接存活重检)。
5. `open` 通过 `acquireTab()`(`packages/coding-agent/src/tools/browser/tab-supervisor.ts`)获取标签页:
   - 同名 + 同浏览器 + 存活的标签页被复用,除非 `dialogs` 改变;
   - 同名但浏览器句柄不同、已死亡,或对话框策略改变,则强制释放并重新创建;
   - 以新 `url` 复用时,通过 worker 发出 `await tab.goto(...)` 导航,省略 `wait_until` 时默认 `waitUntil: "load"`。
6. 新标签页在 `buildInitPayload()` 中构建 `WorkerInitPayload`:
   - headless 模式发送 `url`、`waitUntil`、`viewport`、`dialogs` 和超时;worker 将缺失的 `waitUntil` 默认为 `"load"`。
   - attached、spawned 和 relay 模式用 `pickElectronTarget()` 解析页面,获取其 target id,并发送 `targetId` 和 `dialogs`。connected/relay 模式未提供 `target` 时,目标选择优先选择可见可用的页面,截图不会激活它;显式匹配器可以选中并激活后台页面以获得目标正确的像素。
7. `acquireTab()` 从 `tab-worker-entry.ts` 生成专用 Bun `Worker`;若失败则回退到主线程内联执行(`spawnInlineWorker()`),行为保持不变,但失去对同步无限循环的保护。
8. `WorkerCore.#init()`(`packages/coding-agent/src/tools/browser/tab-worker.ts`)连接回浏览器 websocket 端点。headless 模式打开新页面、应用 stealth patch、应用视口、按需安装对话框处理,并可选导航。附加模式解析请求的目标页面,并按需安装对话框处理。
9. 成功后 worker 发送 `ready` 及 `{ url, title, viewport, targetId }`;supervisor 存储 `TabSession`,用 `holdBrowser()` 递增浏览器句柄引用计数,并把标签页保存在进程全局 `Map<string, TabSession>` 中。
10. `run` 要求非空 `code`,用 `getTab()` 查找标签页,然后委托给 `runInTab()`。
11. `runInTabWithSnapshot()` 拒绝已死亡标签页和并发运行(`Tab ... is busy`),捕获会话 cwd 和可选的 `browser.screenshotDir`,注册 abort 钩子,向 worker 发送 `run` 消息,并将结果与 `timeoutMs + 750` 毫秒赛跑。超时会强制杀死标签页 worker,对 headless 标签页还会关闭孤立的页面 target。
12. `WorkerCore.#run()` 构建 `tab` API,通过 `#ensureRuntime()` 惰性创建共享 `JsRuntime`,用 `runtime.setRunScope()` 注入 `page`/`browser`/`tab`/`assert`/`wait`,并通过 `runtime.run(code, ...)` 执行用户代码,与取消/超时拒绝赛跑。cmux 标签页走 `runCmuxCode()` 的平行路径,驱动同一个 `JsRuntime`。
13. `#createTabApi()` 实现的 `tab` 辅助 API 是:
   - `tab.name: string`
   - `tab.page: Page`
   - `tab.signal?: AbortSignal`
   - `tab.url(): string`
   - `tab.title(): Promise<string>`
   - `tab.goto(url, { waitUntil? })`
   - `tab.observe({ includeAll?, viewportOnly? })`
   - `tab.ariaSnapshot(selector?, { depth?, boxes? })`
   - `tab.ref(id)`
   - `tab.screenshot({ selector?, fullPage?, silent? })`
   - `tab.extract(format = "markdown")`
   - `tab.click(selector)`
   - `tab.type(selector, text)`
   - `tab.fill(selector, value)`
   - `tab.press(key, { selector? })`
   - `tab.scroll(deltaX, deltaY)`
   - `tab.drag(from, to)`
   - `tab.waitFor(selector, { timeout? })`
   - `tab.evaluate(fn, ...args)`
   - `tab.scrollIntoView(selector)`
   - `tab.select(selector, ...values)`
   - `tab.uploadFile(selector, ...filePaths)`
   - `tab.waitForUrl(pattern, { timeout? })`
   - `tab.waitForResponse(pattern, { timeout? })`
   - `tab.waitForSelector(selector, { timeout?, visible?, hidden? })`
   - `tab.waitForNavigation({ waitUntil?, timeout? })`
   - `tab.id(n)`
   - `tab.ref(id)`
14. `normalizeSelector()` 中的选择器处理接受普通 CSS 和 Puppeteer 查询处理器,并重写旧式 Playwright 风格前缀 `p-text/`、`p-xpath/`、`p-pierce/`、`p-aria/`;其他 `p-*` 前缀抛出 `ToolError`。CSS 选择器上的 Playwright 专属引擎/伪类(`:has-text()`、`:text()`、`:visible`、`:nth-match()`、`:near()`/`:above()`/……)会抛出 `ToolError` 指向 `text/`/`aria/` 等价写法,而不是拖到动作超时。
15. `tab.observe()` 清空元素缓存,获取 Puppeteer 无障碍快照,除非 `includeAll` 否则筛选出交互节点,可选地筛选出视口可见节点,分配数字 id,缓存 `ElementHandle`,并返回 URL/标题/视口/滚动元数据及 `elements`。
15a. `tab.ariaSnapshot()` 解析可选的 `selector`(通过 `normalizeSelector()` → `page.$`,默认整个文档),并通过 `captureAriaSnapshot()` 运行生成的 Playwright ARIA 快照包(`src/tools/browser/aria/aria-snapshot.bundle.txt`)。该包被包装进 worker 端构建的 `new Function`(因此页面 CSP 永远不会生效),序列化为页面**主世界**中的 CDP `page.evaluate`,返回 Playwright 格式的 YAML。它始终以 `ai` 模式运行:每个节点获得 `[ref=eN]` id,可点击元素获得 `[cursor=pointer]`,匹配的 DOM 节点被标记 `_ariaRef` 扩展属性。每次快照前会清除已有的 `_ariaRef` 扩展属性,使 id 从 e1 开始确定性地重新编号(新模块的计数器每次调用都会重置);ref 在下一次快照前保持有效。cmux 后端改用 `buildAriaSnapshotScript()` 通过 `browser.eval` 执行(没有 `ElementHandle`;根节点仅支持 CSS 选择器)。
16. `tab.id(n)` 解析缓存的 `ElementHandle`,验证 `el.isConnected`,若 DOM 已变化或缓存已清空,则在缓存失效后抛出过期 id 错误。
16a. `tab.ref(id)` 通过 `resolveAriaRefHandle()`(`page.evaluateHandle`,在主世界中遍历文档 + shadow root 查找匹配的 `_ariaRef`)把最近一次 `ariaSnapshot()` 的 `[ref=eN]` id 解析为存活的 `ElementHandle`,无匹配元素时抛出;它接受裸 `eN` 或带前缀的形式。选择器辅助函数识别 `aria-ref=eN`、`aria-ref/eN`、`ariaref/eN`、裸 `eN` 和 `@eN`。cmux 后端在自己的观察 id 命名空间中解释裸 `eN`;在任一后端,`eN` 选择器都指最近一次页面转储中的 id。
17. `tab.goto()` 在导航前清空缓存的元素 id。任何新的 `tab.observe()` 也会清空并重建缓存。
18. `tab.click()` 对 `text/...` 选择器使用自定义重试循环查找可操作的可见匹配;其他选择器用 `page.locator(...).click()`。交互动作(`click`/`fill`/`type`/`press`/`scroll`/`drag`/`scrollIntoView`/`select`/`uploadFile`)和 `waitFor*` 辅助函数在每次操作截止时间(`min(cellBudget − slack, ceiling)`)内运行,该截止时间同时传入 puppeteer 的 `signal` 和 `.setTimeout()`,因此停滞的辅助函数会中止 CDP 动作并抛出带名称的 `tab.<op> timed out after <ms>ms`,保留单元格预算——绝不会是含糊的整格超时。`goto`/`evaluate` 保持不设上限。
19. `tab.screenshot()` 将页面或所选元素捕获为 PNG,调整模型副本大小,保存到 `browser.screenshotDir` 或 OS 临时目录,返回该路径,记录元数据,并可选地发出文本和图像内容。
20. `display()` 调用累积在数组中。代码完成后,worker 发布 `{ displays, returnValue, screenshots }`;`BrowserTool.#run()` 在返回值不是 `undefined` 时将其追加为尾部文本内容。
21. `close` 通过 `releaseTab()` / `releaseAllTabs()` 释放一个或全部标签页。每个标签页中止挂起的运行,要求 worker 关闭,等待 `closed` 确认最多 `750` 毫秒,终止 worker,递减浏览器引用计数,并在引用计数归零时释放浏览器句柄。

## 模式 / 变体
- **动作分发**
  - `open` — 获取/复用浏览器 + 标签页。
  - `close` — 释放一个或全部标签页。
  - `run` — 在标签页 worker 内执行 JS。
- **浏览器种类**
  - **Headless(无头)**:附加到由 daemon broker 监督的一个项目共享 Chromium(`hub ps` 中的 `omp.browser.headless` / `omp.browser.headed`),应用 stealth patch,并为每个标签页创建全新页面。daemon 随项目中的最后一个 omp 客户端停止。非 CLI 宿主改为启动私有本地 Chromium。
  - **Spawned app(`app.path`)**:尽可能复用该可执行文件已有的 CDP 启用进程;否则杀死同路径进程,以启用远程调试的方式启动可执行文件,然后附加。不注入 stealth patch。
  - **Connected browser(`app.cdp_url`,或调用未带 `app` 时的 `browser.cdpUrl` 设置)**:附加到已在运行的 CDP 端点。不拥有进程;close 只断开连接。
  - **OMP Browser Relay(`app.relay` 或 `browser.relay`)**:通过回环 relay 及其 MV3 扩展附加到用户自己的 Chrome 标签页。用 `omp browser-relay install` 安装一次。CLI 宿主为回环 URL 自动启动固定端口 relay daemon;远程/自定义 relay 必须已在服务。relay 是 connected 浏览器:不拥有进程,也没有 stealth patch。没有 `app.target` 时,采纳可见的可用标签页且不将其置顶;匹配器按 URL/标题子串选择。
  - **Cmux surface(`browser.cmux`)**:无 `app` 且有可用 cmux socket(`CMUX_SOCKET_PATH`,由 `browser.cmux` 设置 / `PI_BROWSER_CMUX` 覆盖启用)时,通过 unix socket JSON-RPC 客户端驱动 cmux WKWebView 表面,而不是 Puppeteer。没有 Bun worker,也没有 stealth patch;`open` 打开一个分屏(拥有该表面),`run` 通过 `runCmuxCode()` 执行,`close` 对它拥有的表面发出 `surface.close`(保留工作区的最后一个表面打开)。
- **attached/spawned/relay 浏览器的目标选择**
  - 有 `app.target` 时,`pickElectronTarget()` 返回 URL 或标题包含不区分大小写子串的第一个页面。
  - 没有 `app.target` 时,跳过标题/URL 匹配 `request handler|devtools|background page|background host|service worker` 的页面,否则回退到第一个页面。
- **Worker 模式**
  - **专用 worker**:常规路径;用户代码在主线程之外运行,即使同步阻塞也能被中止。
  - **内联回退**:当 Bun worker 生成失败时启用;行为一致,但用户代码中的同步无限循环无法被中断。
- **对话框策略**
  - 无 `dialogs` 字段:无自动处理器。
  - `accept`/`dismiss`:页面 `dialog` 事件被自动处理。
  - 在已有存活标签页上改变对话框策略会强制重建标签页,而不是就地修改 worker。
- **截图持久化**
  - 设置了 `browser.screenshotDir` 会话设置:以带时间戳的文件名把全分辨率 PNG 持久化到该目录下。
  - 未设置:持久化到 OS 临时目录下的临时文件路径。
  - `tab.screenshot()` 返回保存的文件路径。

## 副作用
- 文件系统
  - `loadPuppeteer()` 在导入 `puppeteer-core` 前向 `<puppeteer-safe-dir>/package.json` 写入 `{}`。
  - 首次无头启动可能把 Chromium 下载到 `getPuppeteerDir()` 返回的 Puppeteer 缓存目录。
  - `tab.screenshot()` 创建父目录并写入图像文件。
  - `tab.uploadFile()` 相对会话 cwd 解析提供的路径。
- 网络
  - CDP 附加路径轮询 `http://127.0.0.1:<port>/json/version` 或提供的 `cdp_url` 的 `/json/version`。
  - headless/浏览器附加会话创建 CDP websocket 连接。
  - headless 首次使用的 Chromium 下载使用 `@puppeteer/browsers`。
  - 回环 relay 模式可能启动机器全局的 `omp.browser.relay` daemon。扩展向外连接到 relay,Puppeteer 连接到其 CDP 兼容端点。
  - 用户的 `page` / `tab` 操作执行正常的浏览器网络流量。
- 子进程 / 原生绑定
  - headless 模式通过 Puppeteer 启动 Chromium。
  - `app.path` 模式可能通过 `Bun.spawn()` 生成目标可执行文件。
  - `killExistingByPath()` / `gracefulKillTreeOnce()` 使用 `@oh-my-pi/pi-natives` 的进程检查/终止。
  - worker 模式使用 Bun `Worker`;回退模式不用。
- 会话状态(记录、内存、任务、检查点、注册表)
  - 浏览器句柄缓存在 `packages/coding-agent/src/tools/browser/registry.ts` 中按浏览器种类键控的进程全局 `Map` 中。
  - 标签页缓存在 `packages/coding-agent/src/tools/browser/tab-supervisor.ts` 中按 `name` 键控的进程全局 `Map` 中。
  - `run` 捕获会话 cwd 和可选的 `browser.screenshotDir` 用于截图路径解析。
  - `restartForModeChange()` 只丢弃 headless 标签页。
- 面向用户的提示 / 交互 UI
  - 除正常工具输出外没有其他。对话框自动处理不可见,除非失败并发出调试日志。
- 后台工作 / 取消
  - `open`、`run`、CDP 等待和浏览器动作都贯穿 abort 信号。
  - 超时的 `run` 会中止 worker 执行路径,并可能拆毁标签页。

## 限制与上限
- 工具超时钳制:默认 `30` 秒,最小 `1` 秒,最大 `300` 秒(`packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `TOOL_TIMEOUTS.browser`)。
- init/run/close 周围的 supervisor 宽限期:`750` 毫秒(`packages/coding-agent/src/tools/browser/tab-supervisor.ts` 中的 `GRACE_MS`)。
- 启动/连接操作的 Puppeteer 协议超时:`60_000` 毫秒(`packages/coding-agent/src/tools/browser/launch.ts` 中的 `BROWSER_PROTOCOL_TIMEOUT_MS`)。
- connected 浏览器 CDP 就绪等待:`puppeteer.connect()` 前 `5_000` 毫秒(`packages/coding-agent/src/tools/browser/registry.ts`)。
- spawned-app 生成后的 CDP 就绪等待:`30_000` 毫秒(`packages/coding-agent/src/tools/browser/registry.ts`)。
- relay 扩展握手等待:`35_000` 毫秒;回环 relay daemon 就绪:`15_000` 毫秒(`packages/coding-agent/src/tools/browser/{registry,relay/daemon}.ts`)。
- CDP 轮询节奏:`waitForCdp()` 中 150 毫秒(`packages/coding-agent/src/tools/browser/attach.ts`)。
- headless 默认视口:`deviceScaleFactor: 1.25` 下的 `1365x768`(`packages/coding-agent/src/tools/browser/launch.ts` 中的 `DEFAULT_VIEWPORT`)。
- 截图模型附件调整大小上限:`maxWidth 1024`、`maxHeight 1024`、`maxBytes 150 * 1024`、`jpegQuality 70`(`packages/coding-agent/src/tools/browser/tab-worker.ts`)。
- `tab.waitForUrl()` 轮询间隔:`200` 毫秒(`packages/coding-agent/src/tools/browser/tab-worker.ts`)。
- 拖拽模拟使用 `12` 次鼠标移动步(`packages/coding-agent/src/tools/browser/tab-worker.ts`)。
- 每次操作快速失败上限(`packages/coding-agent/src/tools/browser/tab-worker.ts`):快速页面读取(`observe`/`screenshot`/`extract`/`ariaSnapshot`)`min(cellBudget − 1s, 20s)`;交互动作 + 默认等待 `min(cellBudget − 1s, 15s)`;`waitFor*` 上的显式 `{ timeout }` 被钳制到 `cellBudget − 1s`(`0`/`Infinity` → 该边界)。参见 `resolveOpTimeouts()` / `resolveWaitTimeout()`。

## 错误
- `BrowserTool.execute()` 把 DOM 风格的 `AbortError` 转换为 `ToolAbortError`;其他错误原样传播。
- `run` 在缺少代码时硬失败:`Missing required parameter 'code' for action 'run'.`
- `open` 在跨浏览器种类复用名称时失败:`Tab "..." is bound to a different browser (...). Close it first.`
- `runInTabWithSnapshot()` 在标签页缺失/死亡(`Tab "..." is not alive. Reopen it.`)或已在运行(`Tab "..." is busy`)时失败。
- worker 初始化失败和运行失败通过 `RunErrorPayload` 序列化;`ToolError` 和 abort 状态由宿主机侧的 `errorFromPayload()` 重建。
- 附加目标不匹配表现为:
  - `No page targets available on the attached browser`
  - `No page target matched "...". Available pages:\n...`
  - `Target ... is no longer available on the attached browser`
- spawned-app 路径校验要求 cwd 解析后是可执行文件的绝对路径,而不是 app bundle 目录路径。
- 生成/附加失败被包装为 `ToolError`,例如 `Timed out waiting for CDP endpoint ...`、`Failed to attach to ...` 或 `Connected to ... but puppeteer.connect failed: ...`。
- `app.cdp_url` 必须是 HTTP CDP 发现端点,而不是 `ws://` URL;否则 `normalizeConnectedCdpUrl()` 抛出 `browser app.cdp_url must be the HTTP CDP discovery endpoint ...`。
- relay 模式拒绝不可达的端点或扩展从未连接的 relay。回环 CLI 宿主错误告诉用户运行 `omp browser-relay install` 并检查扩展徽章;远程/非自动启动错误告诉用户启动 `omp browser-relay` 或检查端点。
- `tab` 辅助函数错误是对用户可见的 `ToolError`,包括不支持的选择器前缀、过期/未知元素 id、无效拖拽目标、缺少上传文件、`tab.select()` 的非 `<select>`、`tab.uploadFile()` 的非文件输入,以及截图选择器未命中。
- 运行超时时,worker 报告 `Browser code execution timed out after <ms>ms`(带 `(stalled on <op>)` 指明仍在运行的辅助函数);单个停滞的 per-op 辅助函数则会在达到单元格预算前以 `tab.<op>(...) timed out after <ms>ms` 拒绝。若宽限期过后 worker 仍无响应,supervisor 可能升级为 `Browser code execution hung past grace; tab killed`。

## 备注
- 静态 URL 用 `read`;需要 JavaScript 执行、认证或交互时用 `browser`。`run` 前必须先打开标签页,命名标签页在关闭前一直存在。
- `run` 代码拥有完整的 Node/Bun 和会话工具访问权;它不受沙箱限制。
- `loadPuppeteer()` 和 `loadPuppeteerInWorker()` 在导入 `puppeteer-core` 前临时把 `cwd` 重定向到安全的 Puppeteer 目录,因为 Puppeteer 在模块加载期间会探测当前工作目录。
- headless 启动优先使用检测到的系统 Chrome/Chromium,然后是 `PUPPETEER_EXECUTABLE_PATH`,最后才下载 Chromium。
- headless 启动总是传入 `--no-sandbox`、`--disable-setuid-sandbox`、`--disable-blink-features=AutomationControlled` 和匹配初始视口的 `--window-size=...`。它还忽略 Puppeteer 默认参数 `--disable-extensions`、`--disable-default-apps` 和 `--disable-component-extensions-with-background-pages`。
- 代理相关环境变量只影响 headless 启动 argv(共享和本地):`PUPPETEER_PROXY`、`PUPPETEER_PROXY_BYPASS_LOOPBACK` 和 `PUPPETEER_PROXY_IGNORE_CERT_ERRORS`。对于共享 daemon,它们在首次启动时写入,并在 daemon 下次冷启动后再次生效。
- stealth patch 只在 headless 模式应用。spawned 或外部连接的浏览器有意保持原样。
- relay 模式驱动已有的用户浏览器,不接收 stealth patch。任何能到达 relay 端点的事物都能驱动已登录的标签页;内置服务器绑定回环,可选的共享 token 为扩展连接把关。
- `applyStealthPatches()` 还会从 CDP `Runtime.evaluate` / `Runtime.callFunctionOn` 载荷中剥离 Puppeteer 的 `//# sourceURL=__puppeteer_evaluation_script__` 后缀。
- `tab.extract()` 读取 `page.content()`,先运行 Readability,然后回退到 `[data-pagefind-body]`/`main article`/`article`/`main`/`[role='main']`/`body` 中的第一个非空值,如果两条提取路径都没有产出内容则返回 `null`。
- `close(all: true, kill: false)` 在最后一个标签页关闭时断开 spawned、connected 和 relay 浏览器,但保留 spawned app 进程和用户的 Chrome 运行。
- headless 孤儿清理尽力而为:如果 worker 在关闭页面之前死亡,supervisor 会按 `targetId` 搜索浏览器 target 并关闭该页面。
- `run` 内的 console 方法不会出现在工具输出中;它们通过 worker 传输作为 debug/warn/error 日志转发。
- 原始页面请求拦截是 run 作用域的。run 结束时 worker 移除用户的 `request` 处理器、禁用拦截并释放持有的请求;清理失败会把标签页标记为待恢复。
