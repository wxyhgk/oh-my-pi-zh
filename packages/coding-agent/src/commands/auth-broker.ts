/**
 * `omp auth-broker` — manage the omp credential vault.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AUTH_BROKER_ACTIONS,
	type AuthBrokerAction,
	type AuthBrokerCommandArgs,
	runAuthBrokerCommand,
} from "../cli/auth-broker-cli";
import { authBrokerHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

export default class AuthBroker extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "子命令",
			required: false,
			options: [...AUTH_BROKER_ACTIONS],
		}),
		// Second positional: provider id (login/logout) or filesystem path (import).
		source: Args.string({
			description: "OAuth 提供商 ID（login/logout）或路径（import）",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "输出 JSON" }),
		bind: Flags.string({ description: "`serve` 的绑定地址（host:port）", char: "b" }),
		regenerate: Flags.boolean({ description: "重新生成 bearer token" }),
		via: Flags.string({
			description: "远程登录的 SSH user@host（login --via=user@host）",
		}),
		provider: Flags.string({
			description: "为 `import` 覆盖提供商 ID（例如当 JSON `type` 无法识别时）",
		}),
		"include-disabled": Flags.boolean({
			description: "导入 JSON 中带 `disabled: true` 的凭据（import）",
		}),
		"from-local": Flags.boolean({
			description: "迁移来源：本地 SQLite + 环境变量（`migrate` 必需）",
		}),
		"include-env": Flags.boolean({
			description: "捕获尚未接入 broker 的提供商的 API 密钥环境变量（migrate）",
		}),
		"include-oauth": Flags.boolean({
			description: "迁移期间同时上传本地 SQLite 中的 OAuth（默认跳过）",
		}),
		"dry-run": Flags.boolean({ description: "只打印操作而不执行（import / login --via / migrate）" }),
	};

	static examples = [
		"# 基于本地 SQLite 存储启动 broker\n  omp-zh auth-broker serve",
		"# 在非默认端口启动\n  omp-zh auth-broker serve --bind=127.0.0.1:9000",
		"# 打印 bearer token\n  omp-zh auth-broker token",
		"# 轮换 bearer token\n  omp-zh auth-broker token --regenerate",
		"# 列出支持的 OAuth 提供商\n  omp-zh auth-broker list",
		"# 本地登录（在 broker 主机上运行）\n  omp-zh auth-broker login anthropic",
		"# 交互式提供商选择\n  omp-zh auth-broker login",
		"# 通过 SSH 隧道远程登录\n  omp-zh auth-broker login anthropic --via=user@broker",
		"# 退出提供商（不带提供商参数时为交互式）\n  omp-zh auth-broker logout anthropic",
		"# 导入 CLIProxyAPI 认证转储\n  omp-zh auth-broker import ~/.cliproxy/auth",
		"# 导入单个 CLIProxyAPI JSON，覆盖提供商映射\n  omp-zh auth-broker import ~/.cliproxy/auth/claude-foo.json --provider anthropic",
		"# 预览从本地存储 + 环境变量到已配置 broker 的迁移\n  omp-zh auth-broker migrate --from-local --include-env --dry-run",
		"# 应用迁移\n  omp-zh auth-broker migrate --from-local --include-env",
		"# 健康检查已配置的远程 broker\n  omp-zh auth-broker status",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthBroker);
		if (!args.action) {
			renderCommandHelp("omp-zh", "auth-broker", AuthBroker);
			return;
		}
		const action = args.action as AuthBrokerAction;
		const cmd: AuthBrokerCommandArgs = {
			action,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				via: flags.via,
				// `login`/`logout` reuse the legacy `provider` slot; `import` keeps `source` separate
				// so `provider` flag (used as an override) is unambiguous.
				provider: action === "import" ? flags.provider : (args.source ?? flags.provider),
				source: args.source,
				includeDisabled: flags["include-disabled"],
				fromLocal: flags["from-local"],
				includeEnv: flags["include-env"],
				includeOauth: flags["include-oauth"],
				dryRun: flags["dry-run"],
			},
		};
		await initTheme();
		await runAuthBrokerCommand(cmd);
	}
}
