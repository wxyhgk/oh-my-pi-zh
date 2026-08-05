# @oh-my-pi/pi-wire

面向 omp collab 实时会话的共享 TypeScript wire 契约。

本包只包含 JSON 安全的协议形状与常量,无运行时依赖,同时被宿主 CLI(`@oh-my-pi/pi-coding-agent`)与浏览器访客(`@oh-my-pi/collab-web`)使用。

## 导出

```ts
import type { GuestFrame, HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH } from "@oh-my-pi/pi-wire";
```

主要分组:

- 由 collab 访客渲染的消息与会话条目形状,
- 实时 Agent 事件与 task 子 Agent 总线负载形状,
- 供 AES-GCM 密封负载使用的 `GuestFrame`、`HostFrame` 与 `WireFrame` 联合类型,
- 中继控制 TEXT 消息,
- 宿主、访客与本地中继代码共享的链接/封套常量。

## 协议边界

`pi-wire` 不对帧进行编码、解码、校验、加密或路由。它定义这些边界上使用的共享契约:

1. 调用方构建 `GuestFrame` 或 `HostFrame`,
2. 传输代码在加密负载内把它序列化为 JSON,
3. 中继代码使用明文 peer-id 前缀路由不透明封套,
4. 接收方按 `frame.t` 分发,并容忍未知的未来字段。

保持协议变更向后感知:仅当旧宿主与旧访客必须互相拒绝时才提升 `COLLAB_PROTO`。
