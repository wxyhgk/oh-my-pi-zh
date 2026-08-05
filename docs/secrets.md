# 秘密混淆

防止敏感值(API 密钥、token、密码)被发送到 LLM 提供商。启用后,在提供商可见的文本离开进程之前,已配置的秘密和内置的凭据形态 token 模式会被替换。可逆的占位符会在模型生成的工具参数执行之前以及在本地会话上下文为显示或恢复而重建时被还原。替换模式是一次性的,不会被还原。

## 启用

默认禁用。通过 `/settings` UI 或在 `config.yml` 中直接切换:

```yaml
secrets:
  enabled: true
```

## 工作原理

1. 会话启动时,秘密从以下位置收集:
   - **环境变量**,其名称匹配常见的秘密模式(`KEY`、`SECRET`、`TOKEN`、`PASSWORD`、`PASS`、`AUTH`、`CREDENTIAL`、`PRIVATE`、`OAUTH`),且值至少 8 个字符长
   - **`secrets.yml` 文件**(见下文)
   - 一个内置的可逆正则,用于匹配仅出现在会话内容或工具结果中的常见 GitHub、GitLab 和 OpenAI 风格凭据 token

2. 提供商可见的文本会将匹配值替换为确定性占位符,例如 `$$3P8W5JH1TK2Q$$`、`$$3P8W5JH1TK2Q:L$$` 或 `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`。

3. 实时模型生成的工具参数会被深度遍历,占位符在工具执行前被还原。会话上下文会为本地显示/恢复还原占位符,并在提供商重放前重新混淆。替换模式的替换是一次性的,不会被还原。

两种模式控制每个秘密的处理方式:

| 模式                    | 行为                                                                                    | 可逆 |
| ----------------------- | --------------------------------------------------------------------------------------- | ---- |
| `obfuscate`(默认)       | 替换为确定性的 `$$HASH(:hint)$$` 或 `$$FRIENDLY_HASH(:hint)$$` 占位符                   | 是   |
| `replace`               | 替换为配置的 `replacement`,省略时替换为确定性的同长度值                                 | 否   |

混淆模式的明文值和短于 8 个字符的正则匹配会被忽略,以避免遮蔽普通短单词。替换模式可以处理短值;仅当每个可能的 1–2 字符匹配都无法被遮蔽为不同的稳定值时,没有自定义替换的替换模式正则才会被拒绝。

## secrets.yml

在 YAML 中定义自定义秘密条目。会检查两个位置:

| 级别   | 路径                       | 用途                       |
| ------ | -------------------------- | -------------------------- |
| 全局   | `~/.omp/agent/secrets.yml` | 所有项目的秘密             |
| 项目   | `<cwd>/.omp/secrets.yml`   | 项目特定的秘密             |

项目条目会覆盖具有匹配 `content` 的全局条目。

### 模式

数组中的每个条目都有以下字段:

| 字段           | 类型                         | 必需 | 描述                                                       |
| -------------- | ---------------------------- | ---- | ---------------------------------------------------------- |
| `type`         | `"plain"` 或 `"regex"`       | 是   | 匹配策略                                                   |
| `content`      | string                       | 是   | 秘密值(plain)或正则模式(regex)                            |
| `mode`         | `"obfuscate"` 或 `"replace"` | 否   | 默认:`"obfuscate"`                                         |
| `replacement`  | string                       | 否   | 自定义替换(仅替换模式)                                    |
| `flags`        | string                       | 否   | 正则标志(仅 regex 类型)                                   |
| `friendlyName` | string                       | 否   | 混淆模式占位符的净化后模型可见标签                         |

### 示例

#### 明文秘密

```yaml
# 混淆特定的 API 密钥(默认模式)
- type: plain
  content: sk-proj-abc123def456

# 用固定字符串替换数据库密码
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### 友好名称

`friendlyName` 为可逆混淆占位符添加语义上下文,而不会暴露秘密值:

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

这会生成形如 `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$` 的占位符。友好名称会被净化为大写字母和数字,上限为 32 个字符,如果净化后为空值则省略。无效的可选 `friendlyName` 元数据不会禁用秘密条目;该秘密仍会以无标签占位符进行混淆。如果某个特定占位符的标签会暴露已配置的字面秘密或匹配已配置的秘密正则,该标签也会被丢弃。

12 字符的哈希基数是秘密在私有每安装密钥下的 HMAC(存储在 `~/.omp/agent/secret-placeholder.key`,或 XDG 启用安装上的 `$XDG_STATE_HOME/omp/secret-placeholder.key`,绝不会发送给模型)。这可以防止转录阅读者通过字典哈希将占位符反推回秘密。仅大小写不同的秘密会获得独立的基数,因此看到一个占位符不会让提供商通过更改大小写提示来合成另一个。如果密钥无法在惰性内置 token 路径上持久化,会话会发出警告并使用进程临时密钥;混淆在该进程内仍可逆,但占位符在重启后不稳定。大小写提示后缀标记被遮蔽值的大小写:

| 提示 | 含义                                     |
| ---- | ---------------------------------------- |
| `:U` | 所有带大小写的 ASCII 字母均为大写       |
| `:L` | 所有带大小写的 ASCII 字母均为小写       |
| `:C` | 首个带大小写的 ASCII 字母大写,其余小写 |
| `:M` | ASCII 大小写混合                         |

regex 条目上的 `friendlyName` 标记的是配置的正则条目,而不是匹配的值。请保持正则标签足够宽泛,使其对每个匹配都成立。

#### 正则秘密

```yaml
# 混淆任何 AWS 风格密钥
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# 带显式标志的不区分大小写匹配
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# 正则字面量语法(模式和标志在一个字符串中)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

regex 条目始终全局扫描(`g` 标志会自动强制执行)。正则字面量语法 `/pattern/flags` 作为 `content` + `flags` 分离字段的替代方案受支持。模式中的转义斜杠(`\\/`)会被正确处理。

#### 带正则的替换模式

```yaml
# 一次性替换连接字符串(不可逆)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## 无效条目与文件

- 缺失的 `secrets.yml` 被视为没有条目。
- 解析失败或非数组文档会被忽略并发出警告。
- 无效条目会逐个跳过并发出警告。`type` 必须是 `plain` 或 `regex`;`content` 必须是非空字符串;`mode`、`replacement`、`flags` 和正则语法按上述方式验证。
- 无效的可选 `friendlyName` 元数据会被丢弃,而不会丢弃本来有效的条目。

## 与自动检测的交互

环境变量首先收集,文件定义的条目随后跟进,内置的凭据正则最后运行,因此配置的条目会在通用检测器之前看到匹配的内容。重复的环境值会在环境扫描中被合并。环境条目和文件条目不会相互去重,因此同时出现在两者中的明文值会被注册两次;两个占位符都会还原为同一个秘密,因此去混淆不受影响。

## 关键文件

- `packages/coding-agent/src/secrets/index.ts` —— 加载、合并、环境变量收集
- `packages/coding-agent/src/secrets/obfuscator.ts` —— `SecretObfuscator` 类、占位符生成、消息混淆
- `packages/coding-agent/src/secrets/regex.ts` —— 正则字面量解析与编译
- `packages/coding-agent/src/config/settings-schema.ts` —— `secrets.enabled` 设置定义

## 另见

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) —— 远程凭据保管库和正向代理,可将提供商的 OAuth 刷新 token 和访问 token 完全隔离在开发者主机之外(与进程内混淆互补)。
