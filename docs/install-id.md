# 安装 ID

一个跨会话和配置文件持久化的按安装分配的 UUID。它为以下场景提供稳定的安装身份:提供商兼容协议、账户级设备元数据、auth-broker 用量报告或去重后的诊断推送需要它时。该 UUID 本身是随机的;它不是从主机名、用户名、硬件或账户数据派生的。

## API

从 `@oh-my-pi/pi-utils`(`packages/utils/src/dirs.ts`)导出:

| 符号                                  | 用途                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `getInstallId(): string`                | 返回安装 ID,首次调用时生成并持久化一个。结果在进程内缓存,持续整个运行时生命周期。 |
| `__resetInstallIdCacheForTests(): void` | 清除进程内缓存。仅供测试 — 生产代码禁止调用。                                                 |

生成的 ID 是小写 RFC 4122 UUID。当既有持久化值与 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`(带正则 `i` 标志)匹配时,按大小写不敏感方式接受,并按原样返回。

## 存储

- 路径:`<base-config-root>/install-id` — 即默认的 `~/.omp/install-id`,遵循 `PI_CONFIG_DIR`。相对于基础配置根(`getBaseConfigRoot()`)解析,与活跃配置文件无关,因此主机上的每个配置文件共享一个安装 ID(安装身份按安装分配,而非按配置文件)。
- 格式:单个 UUID 行(尾部 `\n`)。
- 权限:文件以模式 `0o600` 创建。
- 生命周期:独立于 `~/.omp/agent/`。清除 Agent 状态(会话、设置、数据库)不会重新生成安装 ID;只有删除 `install-id` 文件本身才会。

## 生成与生命周期

1. 首次调用 `getInstallId()` 读取文件。如果内容解析为有效 UUID,缓存该值并返回。
2. 否则辅助函数调用 `crypto.randomUUID()`(Node 的 CSPRNG 支持的 UUID v4)铸造新 ID。
3. 新值通过 `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)` 写入。独占创建守卫意味着两个进程同时首调不能都成功 — 落败者看到 `EEXIST`,重新读取胜者的文件,并采用该 ID。
4. 如果既有文件包含非空垃圾数据(未通过 UUID 正则),它会在独占创建前被 `unlink`,这样 `O_EXCL` 不会因陈旧数据而触发。
5. 任何其他写入失败(只读文件系统、权限错误)都会被吞掉:新生成的 UUID 仍在内存中缓存,因此进程其余部分看到稳定值,后续进程启动会重试持久化。
6. 进程内的后续调用返回缓存值,不触碰磁盘。首次调用后在磁盘上修改文件,直到进程重启(或测试调用 `__resetInstallIdCacheForTests`)才生效。

## 消费者

| 消费者                                                                                             | 用途                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai/src/providers/openai-codex-responses.ts`                                                | 将该值作为 OpenAI Codex 兼容的 `installationId` 发送,与按会话/线程/窗口的 ID 并列。                                                                           |
| `packages/ai/src/providers/anthropic.ts` 和 `packages/coding-agent/src/session/session-metadata.ts` | 从安装 ID 派生 Claude 兼容的 `device_id` 元数据,在有可用时按 Anthropic 账户 UUID 限定范围。原始安装 ID 不直接用作设备 ID。       |
| `packages/ai/src/auth-broker/remote-store.ts`                                                        | 将其包含在向已配置 auth broker 发送的已观测用量报告中。这些报告也包含主机名;安装 ID 辅助函数本身不生成或组合该元数据。 |
| `packages/coding-agent/src/tools/report-tool-issue.ts`                                               | 将其作为 `installId` 包含在自动 QA 问题推送中,使后端能关联同一安装的报告。                                                                |

新消费者必须将该值视为不透明。辅助函数不贡献 PII,但传输层仍可将其与其它元数据一起发送;每个消费者仍负责记录并最小化其完整载荷。

## 另见

- [environment-variables.md](environment-variables.md) — `PI_CONFIG_DIR` 控制 `install-id` 的存放位置。
- [config-usage.md](config-usage.md) — 更广泛的配置根布局。
