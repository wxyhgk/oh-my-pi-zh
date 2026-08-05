# @oh-my-pi/browser-relay

让 omp 的 `browser` 工具驱动**你现有 Chrome 标签页**(包括已登录的会话)的 Chrome 扩展——无需用 `--remote-debugging-port` 重启 Chrome(况且 Chrome 136+ 在默认配置档上也会拒绝这个参数)。

配套的中继服务器位于 omp CLI 内(`omp browser-relay`,见 `packages/coding-agent/src/tools/browser/relay/`)。它模仿 Chrome 的 CDP 发现端点,合成 `chrome.debugger` 不暴露的浏览器目标与 `Target.*` 层级,并把任意数量的下游 puppeteer 连接(omp 为每个标签页 worker 开一条)复用在 Chrome 允许每个标签页的单一 debugger 附加之上。

## 安装

1. `omp browser-relay install` — 把打包好的扩展写到 `~/.omp/browser-relay/extension`,然后通过 `chrome://extensions` → 开发者模式 → *加载已解压的扩展程序* 加载。(也可以从 GitHub releases 取 `omp-browser-relay-extension.zip`。)
2. `omp config set browser.relay true` — 让 browser 工具走中继。单次调用传 `app.relay: true` 也可以,无需此设置。

就这样:第一次 browser 工具需要中继时,中继服务器会在 omp 与配置档无关的全局守护 broker 下自动启动。每个中继消费者都持有 broker 租约,因此一个项目退出不会打断另一个;所有项目的最后一个消费者退出后服务器才停止。连接后扩展徽章会变**亮**。仅在需要 `--token`、`--no-group` 或非默认端口时才手动运行 `omp browser-relay`——已服务于该端口的中继会被接管,绝不会争抢。

`app.target` 按 URL/标题子串挑选特定标签页;不传时,omp 接管可见标签页而不抢焦点。omp **正在主动驱动**的标签页会被收进每窗口一个的 **"omp" 标签组**(青色)——omp 松开该标签页时释放,断开连接时解散;其余标签页、固定标签页、你自己分组里的标签页,以及拖出去的标签页都不受影响。用 `omp browser-relay --no-group` 关闭。

## 开发

- `bun run build` — 把扩展打包进 `dist/extension/`,为 GH releases 打 zip,并在 `packages/coding-agent/src/tools/browser/relay/extension-assets/` 下重新生成内嵌的 CLI 安装资源(**请提交这些文件**)。
- `bun scripts/smoke.ts [relay-url] [target-substring]` — 针对真实中继复现 omp 监督者 + 标签页 worker 双连接模式的端到端冒烟测试。

## 限制

- `chrome://`、DevTools、Web Store 及其它扩展页面不可附加,对 Agent 隐藏。
- 只要有标签页被附加,Chrome 就会显示 "is debugging this browser" 提示条;关闭它会让该标签页分离,直到它再次导航。
- 开着 DevTools 的标签页无法附加(每个标签页只有一个 debugger——这正是中继为自己的客户端绕过的约束)。
- 任何能触达中继端口的东西都能驱动你已登录的浏览器。中继只绑定 loopback;若担心不可信的本地进程,请使用 `omp browser-relay --token <secret>`(在扩展选项中镜像配置)。
