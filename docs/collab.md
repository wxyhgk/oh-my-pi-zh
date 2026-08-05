# Collab:实时会话共享

`/collab` 将你正在运行的会话实时共享给其他 omp 实例。访客在**自己的 TUI 中原生渲染同一个会话**——流式助手文本、工具调用卡片、底部状态(cwd、模型、上下文百分比、费用)、ctrl+o 展开、`/dump`——而非终端镜像。访客可以发起提示并中断 Agent;宿主机运行 Agent 和所有工具。

## 快速开始

主机:

```
/collab
```

输出

```
Collab session started!
 • Join from another terminal: omp join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

浏览器那一行是点击即加入(指向完整 `https://` 深链接的 OSC 8 超链接):relay 在 `/` 提供 Web 访客客户端,房间 id 和密钥放在 URL 片段(fragment)中。从另一个 omp(任意目录、任意机器)出发,两种形式都可用:

运行 `/collab` 或 `/collab view` 会启动或显示当前正在托管的会话,同时渲染终端/浏览器加入链接及对应的二维码。

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

访客之前的会话在 `/leave`(或主机停止时)时恢复。

### 命令

| 命令               | 作用                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `/collab`         | 开始共享完全控制权(已在托管时则重新打印链接/二维码)           |
| `/collab <relay>` | 通过指定 relay 开始共享(`relay.example.com`、`ws://localhost:7475`) |
| `/collab view`    | 开始只读共享(已在托管时则重新打印链接/二维码)              |
| `/collab status`  | 显示链接和参与者                                                            |
| `/collab stop`    | 停止共享                                                                        |
| `/join <link>`    | 作为访客加入共享会话                                                    |
| `/leave`          | 离开(访客)或停止共享(主机)                                                |

## 链接格式

`/join <link>` 与 `omp join "<link>"` 接受:

```
<roomId>.<key>                                                    → 默认 relay (wss://my.omp.sh)
<roomId>#<key>                                                    → 旧的裸形式
host[:port]/r/<roomId>.<key>                                     → 自定义 relay,推断为 wss://
host[:port]/r/<roomId>#<key>                                     → 旧式直接 relay 形式
https://host[:port]/r/<roomId>.<key>                             → 直接 relay URL,归一化为 wss://
wss://host[:port]/r/<roomId>.<key>                               → 直接 websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                             → 直接明文 ws,仅限 localhost
https://host[:port]/#<link>                                      → Web UI 与 relay 同主机时的浏览器深链接
https://web-host[:port][/<path>]/#<relay-link>                   → 浏览器 UI 包装,relay 链接放在片段中
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → Web UI 与 relay 位于不同主机
```

`<link>` / `<relay-link>` 会按上述任一可接受链接递归解析。对于带可解析片段的 `http(s)` 浏览器包装,片段优先于把 HTTP 主机/路径当作 relay 处理。这样 `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` 可在 `web.example` 打开 Web UI,同时加入 `wss://relay.example.com/r/<roomId>`。如果片段不是完整的 collab 链接,解析会回退到旧式直接 relay 形式,因此 `https://relay.example.com/r/<roomId>#<key>` 仍表示 relay 为 `relay.example.com`。

末尾的 `.<key>` 或 `#<key>` 部分是房间密钥,base64url 编码,有两种强度:

- **完整链接** — 48 字节:32 字节 AES-256-GCM 房间密钥后跟 16 字节写入令牌。授予提示、中断和子代理控制权。
- **只读链接** — 裸 32 字节密钥,无写入令牌。仅授予实时读取权限。无令牌的旧链接解析为只读。

新生成的链接中房间密钥用点连接,因为 RFC 3986 禁止在 URL 片段中出现裸 `#`;解析器仍接受旧式 `#` 形式以及被 `%23` 转义的旧深链接。

## 端到端加密

每个会话负载(条目、事件、状态、提示)在触及 socket 之前都用 AES-256-GCM 封存。relay 只能看到:

- 房间 id 与连接数,
- 不透明的密文帧及其大小,
- 4 字节路由前缀(帧的目标访客)。

持有链接即信任边界:完整链接可读取并操控会话,只读链接只能读取。两者都要像机密一样分享。

## 访客权限模型

两个信任级别,由链接本身强制执行——主机在加入时校验 16 字节写入令牌,并拒绝没有该令牌的对等方的写入(他们在参与者列表中显示为只读,加入通知也会说明)。

持有完整链接的访客可以:

- 读取整个会话(包括加入时的回溯转录),
- 向 Agent 发起提示(在每个参与者的转录中以他们的名字徽章渲染;LLM 看到的是提示文本原文——名字仅用于显示),
- 中断 Agent(Esc),
- 针对主机的子代理使用 Agent 中心:实时表格与进度、聊天(操控主机的子代理)、终止、复活,以及转录查看(按需从主机获取)。
- 回答主机的交互式 `select` 和 `editor` 请求。主机只把每个待处理请求广播给可写访客;第一个提交或取消的响应将其定案,并关闭其他呈现。

持有只读链接的访客可以实时读取一切——回溯转录、流式文本、工具卡片、子代理转录——但主机会拒绝他们的提示、中断和 Agent 控制。

所有会改变主机会话或机器的操作仅限主机:`/model`、`/compact`、`/resume`、`/branch`、bash(`!`)、python(`$`)、skills 等。访客保留一个小的本地白名单(`/dump`、`/export`、`/copy`、`/help`、`/hotkeys`、`/theme`、`/settings`、`/leave`、`/collab`、`/exit`、`/quit`)。

当访客在助手轮次中途加入时,该进行中的轮次会出现在随后第一条 `message_update` 上:访客在转发增量之前,先从该 update 累积的完整消息中合成缺失的 `message_start`。如果访客加入后主机对该轮次不再发出任何 update,就没有可用来合成实时组件的 update。持久条目仍会到达副本的消息状态,但条目帧有意不渲染,因此该边缘情况可以不出现在实时 TUI 中。

## Web 客户端

`packages/collab-web` 是面向相同链接的独立浏览器客户端——访客端无需安装 omp。relay 在 `/` 提供它,这正是 `/collab` 深链接点击即加入的原因:`https://<relay>/#<link>` 加载客户端并从片段自动连接。它渲染实时转录(流式文本、思考、工具卡片)、带按需转录的子代理面板,以及具备相同访客能力(提示、中断、中心操作)的输入区。在包内运行 `bun run dev` 可启动本地实例,`bun run mock-host` 可运行一个离线的脚本化主机用于开发,`bun run build` 可产出可部署到任意位置的静态 `dist/`(WebCrypto 需要 HTTPS)。客户端只与 relay 通信,密钥始终留在 URL 片段中。

当浏览器 UI 与 websocket relay 分开托管时,设置 `collab.webUrl`。为空时,`/collab` 从 `collab.relayUrl` 推导 `http(s)://host[:port]`;显式 Web UI URL 必须使用 `https://`,但 `http://localhost` 开发源除外。生成的浏览器 URL 仍在片段中携带 relay 专属的 collab 链接。

## 设置

| 设置                   | 默认值               | 含义                                                                                                        |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `collab.relayUrl`     | `wss://my.omp.sh`     | 未内联传入 relay 时 `/collab` 使用的 relay                                                         |
| `collab.webUrl`       | 空                 | `/collab` 链接的浏览器 UI URL;为空时从 relay 推导;显式 `http://` 仅允许用于 localhost |
| `collab.displayName`  | 操作系统用户名           | 展示给其他参与者的名称                                                                               |
| `share.serverUrl`     | `https://my.omp.sh/s` | `/share` 使用的分享查看器/上传基址(链接为 `<base>/<id>#<key>`)                                      |
| `share.redactSecrets` | `true`                | 上传前对 `/share` 快照运行机密混淆器                                                |

## 自托管 relay

relay 是一个小型、内容不可知的 Go 服务。它除活动连接外不保留任何状态,并提供:

- `GET /` — 静态 collab-web 访客客户端(`/collab` 深链接的目标),
- `GET /r/<roomId>?role=host|guest` — WebSocket 升级,
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob 上传、查看器页面和 blob 获取,
- `GET /healthz` — 存活检查。

## 架构说明

Hub 拓扑——主机是权威方,访客之间从不互连:

1. `welcome` + `snapshot-chunk` 帧 — 初始状态与转录。转录按字节分块,使每次到达都重置访客的进度超时;过大的复制条目在传输前会被收缩。
2. `entry` 帧 — 持久会话条目,在 blob 外部化之前广播,使图片保持内联(访客无法解析主机的 blob 引用)。访客在保留 id 的情况下将其追加到 `~/.omp/collab/<roomId>.jsonl` 的副本会话文件,以及 Agent 的消息数组中,这正是 `/dump` 和上下文估算可用的原因。
3. `event` 帧 — 实时 Agent 事件,直接送入访客的正常事件控制器;渲染仅基于事件,以防止双重渲染。
4. `state` 帧 — 防抖的底部状态快照:流式标志、主机的完整模型对象和思考级别(应用于访客的副本 Agent 状态,因此模型显示和上下文窗口计算是原生的)、主机上下文数字,以及参与者。
5. `bus` 帧 — 镜像的任务子代理生命周期/进度 EventBus 流量,在访客本地总线上重新发布,使子代理 HUD 和状态栏计数原生工作。
6. `agents` 帧 — 提供访客本地注册表的 Agent 注册表快照,使 Agent 中心的表格渲染主机子代理。
7. `ui-request` / `ui-request-end` 帧 — 主机 select/editor 提示,呈现给完全控制访客,一旦定案便在所有地方关闭。访客以 `ui-response` 应答。

访客→主机:`hello`、`prompt`、`abort`、`agent-cmd`(中心聊天/终止/复活)、`fetch-transcript`(增量子代理转录读取,由定向的 `transcript` 帧应答),以及 `ui-response`。副本通过常规的 `/resume` 机制加载,因此主题、ctrl+o 和转录行为天然原生;访客进程从不 chdir 到主机路径。
