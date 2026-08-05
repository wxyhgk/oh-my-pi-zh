# 工具批准模式

工具批准有三个输入:

1. **工具声明** — 每个工具都可以声明一个 `approval` 层级:
   - `read`:读取数据或仅更新 UI 的会话元数据。
   - `write`:修改工作区/会话状态,但不执行任意代码。
   - `exec`:执行代码、调用 shell、驱动浏览器、派生 Agent,或执行类似宽泛的动作。
2. **工具策略** — 对象形式的声明可以设置 `policy: allow | deny | prompt`,可选带 `override` 和一个原因。这用于参数相关的安全/模式规则。
3. **用户策略** — `tools.approval.<toolName>: allow | deny | prompt` 覆盖活动模式,但不能绕过工具自身的 deny/prompt 策略或非 yolo 的安全覆盖。

没有 `approval` 声明的工具,以及格式错误的批准决策,都被视为 `exec`。这是未知自定义工具的安全默认。MCP 服务器工具声明 `write`。

## 模式

用 `tools.approvalMode` 配置:

| 模式             | 自动批准           | 提示          |
| ---------------- | ----------------------- | --------------- |
| `always-ask`     | `read`                  | `write`, `exec` |
| `write`          | `read`, `write`         | `exec`          |
| `yolo`(默认) | `read`, `write`, `exec` | 无            |

`--auto-approve` 和 `--yolo` 强制会话的 `tools.approvalMode: yolo`。

## 用户覆盖

`tools.approval` 在每个模式中都受尊重:

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem__delete: deny
```

每次工具调用的解析:

1. 评估 `tool.approval(args)`;省略/格式错误的决策默认层级为 `exec`。
2. 工具声明的 `policy: deny` 总是拒绝。用户 `deny` 下一个被检查,也总是拒绝。
3. 在 `yolo` 中,显式工具 `allow`/`prompt` 策略胜出;否则有效的用户策略胜出,或调用被允许。单独的 `override` 标志不会在 `yolo` 中强制提示。
4. 在非 yolo 模式中,`override: true` 决策只允许伴随的工具 `policy: allow`;其他每个非拒绝情形都提示。
5. 没有 override 时,显式工具 `allow`/`prompt` 策略胜出,然后是有效的用户策略胜出。
6. 没有显式策略时,活动模式按层级自动批准或提示。

策略字符串被修剪并归一化大小写。无效的用户值被忽略。

## 安全覆盖

工具可以用对象形式批准强制提示:

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` 对关键破坏性模式使用此方式,如 `rm -rf /`、fork 炸弹、远程抓取后执行、写入 `/etc/passwd` 和主机关机命令。它还支持配置的 `bash.patterns` 规则:`deny` 是绝对的,`prompt` 强制提示,`allow` 在 `write` 层级显式允许匹配的调用。原因出现在批准提示中。在 `yolo` 中,裸的关键 override 被忽略,但显式工具/用户 `prompt` 或 `deny` 策略仍然被强制执行。

### 计算机安全

默认禁用的 [`computer` 工具](./computer-use.md) 从调用的 `read_only` 声明选择其层级:

- `read_only: true` 使用 `read`;
- `read_only: false`、缺失字段、格式错误的参数或任何其他值使用 `exec`。

批准提示在适用时显示 `read-only`,后跟提交的 JavaScript(由标准格式化器截断到 2,000 字符)。`read_only` 是由批准层级强制执行的信任声明,不是对脚本的静态分析。

另外,提供商发起的 computer-use 调用可能携带 `pendingSafetyChecks` 元数据。任何待处理检查都会强制交互提示,无论 yolo、逐工具 `allow` 或已批准的 `xd://` 分派。提示列出每个安全检查代码、消息和净化/截断的数据。没有交互 UI 时,调用以 `pending provider safety checks but no interactive UI is available` 失败关闭。

工具批准不授权底层的现实世界动作。屏幕上的文本不可信,不能覆盖直接的用户指令。后果性动作仍需要在确切目标、范围和值上要求风险点确认,除非用户的直接消息已经授权了它们。

## 逐工具提示细节

工具可以用 `formatApprovalDetails(args)` 添加批准提示正文行。标准提示包括:

- `Allow tool: <name>`
- 未注释 `mcp__...` 工具为 `Origin: MCP server tool`
- 工具决策提供原因时为 `Reason: <reason>`
- 工具特定细节,如命令、路径、代码、浏览器动作或子代理指派

## 在工具上定义批准

内置和自定义工具共享相同的形状:

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision =
  | ToolTier
  | {
      tier: ToolTier;
      reason?: string;
      override?: boolean;
      policy?: "allow" | "deny" | "prompt";
    };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

示例:

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";

approval: (args) =>
  isForbidden(args)
    ? { tier: "exec", policy: "deny", reason: "Blocked by tool policy" }
    : "write";
```

## ACP 会话

ACP(`omp acp`)使用与正常 OMP 启动相同的设置解析器。全局 `~/.omp/agent/config.yml` 适用,ACP 会话 `cwd` 的项目配置适用,传给 ACP 服务器进程的任何 `--config <file>` 覆盖层适用于该进程创建的会话。

要自动批准 ACP 工具调用,在全局或项目配置中设置模式:

```yaml
tools:
  approvalMode: yolo
```

或用运行时覆盖或单进程配置覆盖层启动 ACP 服务器:

```bash
omp acp --yolo
omp acp --auto-approve
omp acp --approval-mode yolo
omp acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

优先级是正常的设置优先级:运行时标志(`--approval-mode`、`--auto-approve`、`--yolo`)覆盖 `--config` 覆盖层,覆盖项目配置,覆盖全局配置。ACP 目前不定义 `session/new`、`session/load` 或 `session/resume` 批准策略字段,因此需要按会话 yolo 的 ACP 客户端应使用上述标志之一启动单独的 `omp acp` 进程,或用会话特定的 `--config` 覆盖层。

`tools.approvalMode: yolo` 在被显式配置或由运行时标志提供时完全适用于 ACP。它跳过 OMP 的批准提示,也跳过 ACP 客户端对 `bash`、`edit`、`delete` 和 `move` 的权限门,除非 `tools.approval.<tool>` 是 `prompt` 或 `deny`。schema 默认是 `yolo`,但默认配置的 ACP 会话仍保留客户端权限门;客户端想要无人值守执行时,显式设置 `tools.approvalMode: yolo`。

ACP 需要批准时,OMP 通过 ACP 客户端而非终端 TUI 路由它。客户端门控的 `bash`、`edit`、`delete` 和 `move` 调用使用 ACP `session/request_permission`;客户端宣告 `elicitation.form` 时,通用批准提示使用表单引导。被拒绝、取消或不支持的提示会拒绝/取消工具调用;OMP 不会静默允许它。

## 子代理

子代理以 `tools.approvalMode: yolo` 无头运行,因此普通的基于层级的提示不会阻塞它们。父级 `task` 批准是授权边界。用户的 `tools.approval.<tool>` 设置仍然权威:`deny` 阻止工具,`allow` 允许它,`prompt` 在无头子代理中无法被满足并拒绝调用。
