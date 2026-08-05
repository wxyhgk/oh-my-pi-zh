# macOS 签名与公证

在 GitHub Releases 上发布的编译版 macOS `omp` 二进制文件可以使用 **Developer ID Application** 证书签名并由 Apple **公证**。这使其符合 Gatekeeper 要求，也是正式提交 Homebrew 的前提条件（参见 [#776](https://github.com/can1357/oh-my-pi/issues/776)）。

签名在 CI 的 `release_binary_darwin` 矩阵任务中通过 `scripts/ci-macos-sign.sh` 完成（`.github/workflows/ci.yml`）。除非下面全部五个 `APPLE_*` 仓库机密均已配置，否则该工作流步骤会**自动跳过**，因此在缺少凭据时发布版本仍为 ad-hoc 签名。脚本本身不会跳过：在缺少任何必需凭据的情况下调用它属于错误。

## 工作原理

1. `ci:release:build-binaries` 构建并进行 **ad-hoc** 签名（以便二进制能在构建运行器上运行）。
2. 然后 `scripts/ci-macos-sign.sh`：
   - 将 Developer ID 证书导入一个一次性钥匙串；
   - 使用 `--options runtime --timestamp`（强化运行时 + 安全时间戳）和 `--entitlements scripts/macos-entitlements.plist` 重新签名；
   - 在新签名下运行 `--version` 和 `--smoke-test` 以便快速失败；
   - 通过 `notarytool submit --wait` 对二进制进行公证。
3. `release_github_verify` 重新下载已发布的 arm64 产物，运行 `codesign --verify --strict` 和两项启动检查，并且在签名机密已配置时还会断言签名不是 ad-hoc 的。

### 为什么授权（entitlements）是必需的

该二进制是 Bun 单文件可执行程序，因此强化运行时需要：

| 授权（Entitlement）                                      | 原因                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.cs.allow-jit`                        | JavaScriptCore 在运行时执行 JIT。                                                                                                                                                                                                                                                                                               |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JSC 可执行内存页。                                                                                                                                                                                                                                                                                                  |
| `com.apple.security.cs.disable-library-validation`       | omp 将其原生插件（`pi_natives.<triple>.node`）和其他可选 dylib 解压到运行时缓存并通过 `dlopen()` 加载。它们与主二进制不共享相同的 Team ID，因此没有此项时强化运行时会以_"mapping process and mapped file have different Team IDs"_（映射进程与映射文件具有不同的 Team ID）中止——几乎会破坏每条命令。 |

没有 `disable-library-validation` 时，已签名+公证的二进制可以正常签名和公证，但会在**第一次真正使用时失败**。`scripts/ci-macos-sign.sh` 在签名后特意运行 `--smoke-test`，以便在公证前发现此问题。

### 印记（Stapling）限制（重要）

裸 Mach-O 可执行文件**无法被印记**（`stapler` 只支持 `.app`/`.pkg`/`.dmg`）。该二进制是真正经过公证的——`notarytool` 返回 `Accepted`，票据存在于 Apple 服务器上并以它的 cdhash 为键——但票据必须在线获取，而不是从可执行文件中读取。`release_github_verify` 会报告 `spctl -a -t exec -vv` 以供参考，但不会以它作为发布的门禁：未印记的裸二进制在在线票据不可用的情况下可能产生非零评估结果，这本身并不代表签名或凭据失败。

这在实践中意味着：

- `curl https://omp.sh/install | sh` — `curl` 不设置隔离（quarantine）位，因此不会咨询 Gatekeeper。
- Homebrew **formula** 安装 — Homebrew 不对 formula 文件做隔离，因此不会咨询 Gatekeeper。
- 任何会**隔离**该二进制的方式（浏览器下载，或 Homebrew **cask**）都需要 Apple 的在线票据查询。对于需要离线分发的产物，请将二进制打包成可印记、已公证的 **`.pkg` 或 `.dmg`**（`xcrun stapler staple` 可作用于这两者）。对于 `curl`/formula 路径则不需要。

## 必需的 GitHub 机密

在 **Settings → Secrets and variables → Actions** 下添加这些（仓库机密）。全部五个机密（证书、密码和 API 密钥三件套）必须存在，签名才会启用。

| 机密                        | 含义                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12`      | 导出的 Developer ID Application `.p12`（证书 + 私钥）的 base64。 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。                                  |
| `APPLE_API_KEY_ID`           | App Store Connect API **Key ID**。                                            |
| `APPLE_API_ISSUER_ID`        | App Store Connect API **Issuer ID**（UUID）。                                  |
| `APPLE_API_KEY`              | App Store Connect `.p8` 私钥的 base64。                           |

### 生成凭据文件

将这些放入一个工作目录（默认 `~/omp-signing`）：

| 文件                 | 方法                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.p12`              | **钥匙串访问（Keychain Access）** → 右键点击你的 _Developer ID Application: …_ 身份（即展开后带有私钥的证书条目）→ **导出…** → 保存为 `.p12` 并设置密码。                                              |
| `p12-password.txt`   | 你刚刚在 `.p12` 上设置的密码。                                                                                                                                                                                                |
| `AuthKey_<KEYID>.p8` | App Store Connect → **用户和访问 → 集成 → App Store Connect API** → 创建密钥（**账户持有人**角色也允许创建 API 证书；**开发者**角色足以用于公证）→ **仅下载一次**（不可恢复）。 |
| `issuer-id.txt`      | 密钥表上方显示的 **Issuer ID**（UUID）。                                                                                                                                                                                    |
| `key-id.txt`         | _可选_ — Key ID；否则从 `.p8` 文件名读取。                                                                                                                                                                        |

App Store Connect API 密钥是无法通过 CLI 生成的唯一凭据——它是 API 本身的引导凭据，且 `.p8` 只下载一次。其他所有内容都是本地的。

### 上传而不打印机密值

`scripts/ci-macos-upload-secrets.sh` 会校验文件（用你的密码打开 `.p12`，对 `.p8` 做健全性检查），并将每个值通过 stdin 管道传给 `gh secret set`——机密永远不会打印到终端、argv 或 shell 历史中：

```sh
scripts/ci-macos-upload-secrets.sh ~/omp-signing --dry-run   # 先校验
scripts/ci-macos-upload-secrets.sh ~/omp-signing             # 上传全部五个
gh secret list --repo can1357/oh-my-pi                       # 确认
```

每当证书续期时重新运行它。

### 查找你的签名身份 / Team ID（健全性检查）

```sh
security find-identity -v -p codesigning
# 例如 "Developer ID Application: Your Name (TEAMID1234)"
```

脚本会自动选择第一个 `Developer ID Application` 身份；你无需将身份字符串或 Team ID 存为机密。

## 本地试运行

你可以通过导出五个环境变量并在本地完整演练签名+公证路径（真实证书 + API 密钥）：

```sh
RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries
APPLE_CERTIFICATE_P12=… APPLE_CERTIFICATE_PASSWORD=… \
APPLE_API_KEY_ID=… APPLE_API_ISSUER_ID=… APPLE_API_KEY=… \
  bash scripts/ci-macos-sign.sh packages/coding-agent/binaries/omp-darwin-arm64
```
