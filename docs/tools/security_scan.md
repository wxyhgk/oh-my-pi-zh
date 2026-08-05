# security_scan

> 规划并运行 OMP 原生的安全审查,验证已存储的发现,并显式与 Codex Security 云端扫描交互。

## 可用性与前置条件

- `security.enabled` 默认值为 `false`。禁用时,`security_scan` 会从可用工具集中省略,`security://` 读取会以启用提示消息失败。可在 **设置 → 工具 → 安全** 中启用,或将 `security.enabled` 设为 `true`。
- 该工具可被发现、使用严格 schema,并被归类为 `exec`。
- 原生 `preflight` 需要一个 Git 仓库、一个激活的模型、会话模型与认证注册表,以及激活模型提供商的一个已存储 OAuth 凭据。仅 API 密钥的认证不被接受。
- 如果存在多个 OAuth 账户且均未激活,请传入 `credential_id`;只有一个账户时会自动选中。不可变计划会固定该凭据行以及记录的账户/工作区身份。执行与 token 刷新始终停留在该行,而不会轮换到另一个账户。
- 云端操作需要一个 `openai-codex` ChatGPT OAuth 凭据。它们调用 ChatGPT 的 Codex Security 云端控制面,而非公开的 OpenAI API,并且绝不会作为原生扫描的回退方案。

## 源码

- 入口:`packages/coding-agent/src/tools/security-scan.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/security-scan.md`
- 原生规划与新鲜度:`packages/coding-agent/src/security/preflight.ts`
- 后台执行:`packages/coding-agent/src/security/coordinator.ts`
- 仅扫描的发布工具:`packages/coding-agent/src/security/publication.ts`
- 规范存储与输出文件:`packages/coding-agent/src/security/store.ts`
- 云端客户端/导入:`packages/coding-agent/src/security/cloud.ts`
- 只读资源:`packages/coding-agent/src/internal-urls/security-protocol.ts`

## 输入

| 字段 | 类型 | 使用方 | 说明 |
| --- | --- | --- | --- |
| `action` | `"preflight" \| "start" \| "status" \| "cancel" \| "validate" \| "cloud_scans" \| "cloud_start" \| "cloud_status" \| "cloud_pull"` | 全部 | 必填的分发选择器。 |
| `plan_id` | `string` | `start` | `preflight` 返回的计划 ID。 |
| `operation_id` | `string` | `status`、`cancel` | `start` 返回的操作 ID。 |
| `target_kind` | `"repository" \| "scoped_path" \| "ref_diff" \| "working_tree"` | `preflight` | 默认为 `repository`。 |
| `include_paths` | `string[]` | `preflight` | 纳入不可变范围的仓库相对路径。`scoped_path` 至少需要一个非空值。 |
| `exclude_paths` | `string[]` | `preflight` | 从范围中移除的仓库相对路径。排除优先于包含。 |
| `base_revision` | `string` | 带 `ref_diff` 的 `preflight` | 与 `head_revision` 一起必填;在 preflight 期间解析为一个提交。 |
| `head_revision` | `string` | 带 `ref_diff` 的 `preflight` | 与 `base_revision` 一起必填;在 preflight 期间解析为一个提交。 |
| `knowledge_base_paths` | `string[]` | `preflight` | 相对于仓库根目录解析、规范化,并按 SHA-256 与大小固定的文件。 |
| `output_root` | `string` | `preflight` | 可选的外部结果目录。它必须位于仓库之外、是规范路径、非符号链接,并且除非 `archive_existing=true`,否则必须为空。 |
| `archive_existing` | `boolean` | `preflight` | 默认为 `false`。允许在执行开始时将非空输出目录重命名为 `<output_root>.archive-<scan-id>`。 |
| `credential_id` | 正整数 | 原生 `preflight`;每个云端操作 | 固定一个 OAuth 凭据。原生扫描为激活模型提供商选择它;云端操作为 `openai-codex` 选择它。 |
| `scan_id` | `string` | `validate` | 包含该发现的已存储扫描。 |
| `finding_id` | `string` | `validate` | 要更新的已存储发现。 |
| `validation_status` | `"unvalidated" \| "validated" \| "rejected" \| "partial" \| "error"` | `validate` | 新的验证状态。 |
| `validation_summary` | `string` | `validate` | 必填、非空的验证说明。 |
| `validation_evidence` | `{label: string, explanation: string}[]` | `validate` | 作为验证证据附加的可选证据;标签必须非空。 |
| `cloud_configuration_id` | `string` | `cloud_status`、`cloud_pull` | Codex Security 云端配置 ID。 |
| `repository_id` | `string` | `cloud_start` | 必填的云端仓库标识符。 |
| `repository_url` | `string` | `cloud_start` | 必填的云端仓库 URL。 |
| `environment_id` | `string` | `cloud_start` | 必填的云端环境标识符。 |
| `lookback_days` | 正整数或 `"all"` | `cloud_start` | 默认为 `30`;`"all"` 发送无限制的回看。 |

不读取它们的操作会忽略未使用的可选字段。

## 输出与执行模型

每个操作返回一个文本内容块,外加包含 `action` 及下文所述操作特定对象的结构化 `details`。工具本身不流式传输部分参数或进度更新。`start` 立即返回一个已排队的操作;其单独注册的 OMP 任务报告进度,调用方使用 `status` 获取持久化的操作状态。

## 操作参考

### `preflight`

`preflight` 解析并持久化一个不可变计划,然后返回:

```text
Security plan <plan-id> is ready. Fingerprint: <fingerprint>. Start it with action=start and plan_id=<plan-id>.
```

`details` 为 `{ action: "preflight", plan: { id, fingerprint } }`。

该计划固定:

- 规范化的仓库根目录与标准化后的包含/排除范围;
- 目标快照;
- 在适用情况下的已解析 ref-diff 修订与 diff 摘要;
- 激活的提供商/模型及可选的思考级别;
- 精确的 OAuth 凭据与记录的账户/工作区身份;
- 知识库文件身份;
- 输出策略;
- 安全设置快照及协调器提示词/工作流的指纹。

对于 `repository`、`scoped_path` 和 `working_tree`,目标摘要覆盖范围内已跟踪与未跟踪的文件路径及内容、可执行位、符号链接目标以及当前 HEAD(或 `unborn`)。`ref_diff` 则对解析后的 base/head 提交及其原始树 diff 取指纹。范围路径必须相对于仓库、必须存在并解析到仓库内部,且会被标准化、去重并排序。

若省略 `output_root`,preflight 会在项目的 OMP 安全状态下分配一个私有的唯一目录。调用方提供的输出目录若不存在,会在 preflight 期间创建;其父目录必须已有规范身份。非空目录需要 `archive_existing=true`。

### `start`

`start` 加载已存储的计划,并根据当前目标、安全设置、知识库、输出策略与工作流重新计算其指纹。不匹配则失败并报:

```text
Security scan plan is stale: expected <old>, got <new>. Run security preflight again.
```

成功时,它在注册后台工作后立即返回:

```text
Security scan <scan-id> started as <operation-id>.
```

`details.operation` 包含 `operationId`、`planId`、`scanId`、`phase`、时间戳、`findingCount`,以及(可用时)`jobId`、`sessionFile` 或 `error`。

操作阶段为:

```text
queued → preparing → reviewing → publishing → completed
```

终态备选为 `partial`、`cancelled` 和 `failed`。协调器会创建一个受限、自动批准的扫描会话,包含只读的仓库检查工具、只读 LSP,且仅有 `security-reviewer` 任务工作线程。扩展发现、MCP 与 IRC 被禁用。模型回退与账户轮换被禁用。

对于 `ref_diff`,执行会在固定的 head 修订处创建一个分离的临时 worktree,并向审查会话提供固定的 diff;清理时会移除该 worktree。其他目标类型直接审查仓库根目录。

### `status`

需要 `operation_id`。它返回:

```text
Security scan <scan-id>: <phase>; <count> finding(s).
```

完整的操作快照位于 `details.operation` 中。终态操作会跨会话从项目存储中恢复。进程重启会将持久化的 `running` 或 `planned` 扫描标记为 `failed`,并附 `Security scan was interrupted by a process restart`,同时清理 ref-diff 目标的 worktree。未知 ID 会抛出 `Unknown security operation: <id>`。

### `cancel`

需要 `operation_id`。运行中的异步任务通过任务管理器取消;否则协调器会中止其本地控制器与扫描会话。结果要么是:

```text
Cancellation requested for <operation-id>.
No running operation <operation-id>.
```

`details.cancelled` 报告请求是否被接受;当操作存在时包含 `details.operation`。已终态与未知操作返回 `false`。

### `validate`

需要 `scan_id`、`finding_id`、`validation_status` 以及非空的 `validation_summary`。它更新规范化的已存储发现,并可选地追加生成的验证证据记录:

```text
Finding <finding-id> validation is now <status>.
```

`details.finding` 包含发现 ID 与验证状态。缺少扫描/发现或必填字段时会失败,而不会创建新发现。

### `cloud_scans`

列出所选 ChatGPT 账户可见的每个分页配置。每行包含配置 ID、当前步骤、仓库 ID、环境 ID 与仓库 URL。若不存在任何配置,工具会说明。结构化配置在 `details.cloudConfigurations` 中返回。

### `cloud_start`

需要 `repository_id`、`repository_url` 和 `environment_id`。它创建一个启用的 Codex Security 云端扫描配置,并消耗该账户独立的云端扫描额度。`lookback_days` 默认为 `30`。

文本标识配置与仓库。`details.cloudScan` 包含 `{ id, repositoryUrl }`。

### `cloud_status`

需要 `cloud_configuration_id`。它报告当前步骤以及已完成/待处理的提交数量。`details.cloudStats` 还包含失败的提交、按严重级别统计的发现数量,以及服务暴露的任何最后扫描的提交/时间戳。

### `cloud_pull`

需要 `cloud_configuration_id`。它获取配置、状态及所有归属的发现详情,将其转换为 OMP 的规范 schema,生成报告与 SARIF,并持久化一个已完成的导入扫描。

除非当前项目有一个规范化仓库身份与云端配置 URL 匹配的 `origin` 远程,否则导入会以失败关闭。由于发现 API 不暴露覆盖凭证,云端覆盖率记录为 `unknown`。`details.importedScan` 包含新的扫描 ID 与发现数量。

## 原生发布与持久化

`security_publish` 是一个内部、严格、写入层的工具,仅在受限的原生扫描会话内部可用;它不是普通的调用方操作。协调器要求扫描 Agent 恰好调用一次,并提供:

- 去重后的发现,包含规则、标题、摘要、严重级别、置信度、类别、至少一个范围内的位置、可选的证据/修复建议/CWE 及验证状态;
- 如实的覆盖完整性、已审查面、排除项、延后工作与未决问题;
- 最终的 Markdown 报告。

发布会拒绝绝对路径、穿越父目录或超出范围的发现与证据路径。具有相同规范指纹的重复发现会被去重。第二次成功的发布调用会失败。若扫描会话在未发布的情况下结束,扫描会持久化为 `partial`;即使后续指标/输出刷新失败,一次成功的发布仍保持为 `completed`。

规范状态在 OMP 的安全状态根目录下以项目为键私有存储。一个已完成的原生输出目录包含:

- `scan.json` — 公开的扫描清单,作为提交标记最后写入;
- `findings.json`;
- `report.md`;
- `results.sarif`;
- `provenance.json` — 已脱敏的私有元数据。

在非 Windows 平台上,目录加固为 `0700` 模式,文件为 `0600` 模式。

## 读取结果

`security://` 命名空间是不可变且按项目隔离的:

| URL | 结果 |
| --- | --- |
| `security://` | 命名空间索引。 |
| `security://scans` | 已存储的扫描列表。 |
| `security://scans/<scan-id>` | 扫描摘要与子资源索引。 |
| `security://scans/<scan-id>/manifest` | 公开的清单 JSON,包含计划。 |
| `security://scans/<scan-id>/findings` | 发现列表。 |
| `security://scans/<scan-id>/findings/<finding-id>` | 渲染后的发现、位置、证据与修复建议。 |
| `security://scans/<scan-id>/coverage` | 覆盖率 JSON。 |
| `security://scans/<scan-id>/report` | Markdown 报告(若存在)。 |
| `security://scans/<scan-id>/sarif` | SARIF JSON(若存在)。 |
| `security://scans/<scan-id>/provenance` | 已脱敏的来源 JSON。 |

使用 `security_scan` 操作或显式安全命令进行变更;URI 读取从不验证、导入、取消或以其他方式修改状态。

## 示例

规划并启动一次仓库扫描:

```json
{"action":"preflight","target_kind":"repository","exclude_paths":["vendor","dist"]}
```

```json
{"action":"start","plan_id":"secplan_<id>"}
```

规划带有外部输出目录的精确修订 diff:

```json
{
  "action": "preflight",
  "target_kind": "ref_diff",
  "base_revision": "origin/main",
  "head_revision": "HEAD",
  "output_root": "/tmp/omp-security-review"
}
```

验证一个发现:

```json
{
  "action": "validate",
  "scan_id": "secscan_<id>",
  "finding_id": "secfinding_<id>",
  "validation_status": "validated",
  "validation_summary": "Reproduced with an untrusted archive entry.",
  "validation_evidence": [
    {"label":"Reproduction","explanation":"The entry writes outside the extraction root."}
  ]
}
```

显式启动并随后导入一次云端扫描:

```json
{
  "action": "cloud_start",
  "repository_id": "repo_<id>",
  "repository_url": "https://github.com/owner/repo",
  "environment_id": "env_<id>",
  "lookback_days": 30,
  "credential_id": 7
}
```

```json
{"action":"cloud_pull","cloud_configuration_id":"scan_<id>","credential_id":7}
```

## 错误与约束

- 每个操作首先重新检查 `security.enabled`;禁用时直接执行会抛出 `Security is disabled. Enable security.enabled before using security_scan.`
- 必填字符串会被去除首尾空白并拒绝空值。ArkType 拒绝无效的枚举值、非正的凭据/回看 ID 以及格式错误的验证证据。
- 原生扫描拒绝缺少 Git 上下文、未知引用、越界/不存在的范围路径、无效的知识库文件、不安全的输出目录、未知/过期的计划、不可用的固定模型、OAuth 身份变更以及不可用的固定凭据。
- 云端请求在 HTTP 401 时以强制刷新重试一次,然后失败。其他非成功响应会报告状态与端点。
- `cloud_pull` 在导入前验证仓库身份与配置归属。
- 取消是协作式的。只有后台运行处理了中止并持久化其终态包之后,操作才会达到终态 `cancelled`。
