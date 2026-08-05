# @oh-my-pi/collab-web

[omp collab 会话](../../docs/collab.md)的 Web 客户端。把 `/collab` 链接粘进浏览器,你就能看到与 TUI 中访客所见相同的实时会话:流式转录、工具调用卡片、带实时转录的子 Agent 面板,以及一个可提示(或打断)宿主 Agent 的输入框。

## 快速开始

```sh
# 开发服务器(Bun HTML dev server,带 HMR)— http://localhost:3000
bun run dev

# 离线演示:本地中继 + 脚本化 mock 宿主;打印一个 ws://localhost 链接
bun run mock-host
```

从任意 omp 实例托管一个会话(`/collab`,或用 `/collab ws://localhost:7466` 使用 mock 中继),然后把打印出的链接粘进连接界面。深链接同样可用:`http://localhost:3000/#<roomId>.<key>` 加载即自动连接。

## 构建与部署

```sh
bun run build   # 静态站点,输出到 dist/
```

`dist/` 是一个完全静态的 SPA——可在任何地方托管。JS/CSS 打包带内容哈希;favicons、`manifest.webmanifest`、`robots.txt`、`sitemap.xml` 与 `og-image.png` 来自 `public/`,以稳定名称输出到站点根目录(规范 URL:`https://my.omp.sh/`)。两项运行时要求:

- **安全上下文**:房间密钥用 WebCrypto(`crypto.subtle`)解封,而浏览器只在 `https://` 或 `localhost` 上暴露它。
- **中继可达性**:客户端通过 WebSocket 直连中继(非 localhost 一律 `wss://`)。默认中继是 `wss://my.omp.sh`;裸 `<roomId>.<key>` 链接按它解析(遗留的 `<roomId>#<key>` 与 `%23` 变体链接仍可解析)。

房间密钥从不离开 URL 片段——不会发送给中继或任何服务器。

## 架构

- `src/lib/` — vendored wire 编解码器(`codec.ts` AES-256-GCM、`link.ts` 封套 + 链接文法)、`socket.ts` 自动重连中继 socket、`client.ts` 访客会话存储(`GuestClient` + 供 `useSyncExternalStore` 使用的不变快照)。共享协议形状来自 `@oh-my-pi/pi-wire`。
- `src/components/` — `transcript/`(条目、markdown、工具卡片)、`agents/`(面板 + 转录抽屉)、`shell/`(连接界面、页头、输入框、横幅、toast)。
- `src/tool-render/` — 与 coding-agent HTML 会话导出共享的按工具 React 渲染器:每个内置工具一个视图、通用 `ToolView` 外壳、随主题适配的 `tv-` 设计令牌,以及一个 `<omp-tool-view>` web-component 包装。`ToolRenderHost` 接缝让宿主把 agent-id 徽章接入子会话视图(此处为抽屉,导出中为覆盖层)。
- `scripts/` — `local-relay.ts`(基于 `Bun.serve` 的内容盲中继)、`mock-host.ts` + `fixture.ts`(供离线开发使用的脚本化宿主)、`build-tool-views.ts`(把 `src/tool-render/` + React 打包进 `packages/coding-agent/src/export/html/tool-views.generated.js`,用于自包含导出)。

本包刻意保持独立——运行时与类型层面都不依赖 `@oh-my-pi/pi-coding-agent`。wire 形状漂移通过消费与宿主相同的 `@oh-my-pi/pi-wire` 契约来防止,密封帧互操作仍由 `test/codec.test.ts` 覆盖。
