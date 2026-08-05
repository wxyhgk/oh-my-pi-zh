驱动真实的 Chromium 标签页;通过 JS 获得完整 puppeteer 访问权限。

<instruction>
- 静态内容?用 `read` 读 URL。Browser 只用于 JS 执行、认证、交互操作。
- `open` → `run` — 标签页跨调用和子 Agent 存活,打开一次反复复用。
- `run` 作用域:可用 `page`、`browser`、`tab`、`display`、`assert`、`wait`。`wait(fn)` 轮询直到为真——用它代替在 `tab.evaluate` 里轮询。

- `tab` 辅助方法(未覆盖的情况降到原始 puppeteer `page`):
  元素句柄:`tab.ref("e5")` / `tab.id(n)` 返回一个你可以直接调用方法的句柄——`(await tab.id(n)).click()`。句柄不是选择器:`tab.click`/`type`/`fill`/`waitFor*` 只接受字符串选择器。快照引用可在任何选择器位置使用:`tab.click("e5")` ≡ `tab.click("aria-ref=e5")`。
  简单操作:`tab.goto`、`tab.click`、`tab.type`、`tab.fill`、`tab.press`、`tab.scroll`、`tab.scrollIntoView`、`tab.drag`、`tab.uploadFile`、`tab.select`、`tab.screenshot`、`tab.extract`、`tab.evaluate`。
  截图:`tab.screenshot({ selector?, fullPage?, silent? })` 保存到 `browser.screenshotDir`,未设置时保存到 OS 临时目录,然后返回路径。它绝不接受路径。
  等待:`tab.waitFor`、`tab.waitForSelector`、`tab.waitForUrl`、`tab.waitForResponse`、`tab.waitForNavigation`。
  快照:`tab.observe()` → 可访问性树;`tab.ariaSnapshot()` → 带 `[ref=eN]` 的 ARIA YAML。

  注意事项:
  - `tab.fill` 对 `<select>` 绝不起作用 — 用 `tab.select`。
  - `tab.waitForNavigation` 必须在触发点击**之前**开始。
  - 导航和重新渲染(虚拟化列表、SPA 更新)会使 id/ref 失效 — 重新 observe 或重新 snapshot,然后在同一个单元格内行动。
  - 停滞的动作会以命名错误快速失败,绝不会整个单元格超时。
  - 原始请求拦截是 run 作用域的:run 结束会移除 `request` 处理器、禁用拦截、释放被持有的请求。

- `app.path` → 绝不篡改真实的桌面应用(没有隐身补丁)。
- `app.relay: true` → 通过 omp 浏览器中继驱动用户自己的 Chrome 标签页(自动启动;需要安装 OMP Browser Relay 扩展)。`app.target` 按 URL/标题子串选择标签页;没有它则采用可见标签页而不抢焦点。
- 选择器:CSS + puppeteer `aria/…`、`text/…`、`xpath/…`、`pierce/…`。Playwright 专属伪类(`:has-text()`、`:visible`)会被拒绝。
</instruction>

<critical>
- 必须先 `open` 再 `run`。默认用 `tab.observe()`;只为外观截图。`code` 拥有完整 Node 访问权限——不是沙箱。
</critical>
