/**
 * `omp auth-gateway` — run a forward proxy that injects auth from the broker.
 */

import { Args, Command, Flags, renderCommandHelp } from "@wxyhgk/pi-utils/cli";
import {
	AUTH_GATEWAY_ACTIONS,
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "../cli/auth-gateway-cli";
import { authGatewayHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

export default class AuthGateway extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "子命令",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "输出 JSON（token/status/check）" }),
		bind: Flags.string({ description: "`serve` 的绑定地址（host:port）", char: "b" }),
		regenerate: Flags.boolean({ description: "重新生成网关 bearer token（token）" }),
		"no-auth": Flags.boolean({
			description: "禁用入站 bearer-token 认证（serve）。当绑定到 loopback 时很有用——允许任何调用方。",
		}),
		strict: Flags.boolean({
			description:
				"对于 `check`：另外针对各提供商的 chat-completion 端点探测每个凭据。较慢；每个凭据会消耗少量配额。",
		}),
	};

	static examples = [
		"# 基于已配置的 broker 启动网关\n  omp-zh auth-gateway serve",
		"# 在非默认端口启动\n  omp-zh auth-gateway serve --bind=127.0.0.1:4000",
		"# 打印网关 bearer token（首次运行会创建一个）\n  omp-zh auth-gateway token",
		"# 轮换网关 bearer token\n  omp-zh auth-gateway token --regenerate",
		"# 在 loopback 上运行且不使用任何 bearer（本机任何人都可以调用）\n  omp-zh auth-gateway serve --no-auth",
		"# 显示本地网关 + broker 配置状态\n  omp-zh auth-gateway status",
		"# 探测每个 broker 凭据，找出是哪个产生 401\n  omp-zh auth-gateway check",
		"# 同上，机器可读，便于脚本处理\n  omp-zh auth-gateway check --json",
		"# 严格检查——还用真实的 chat-completion ping 演练每个凭据\n  omp-zh auth-gateway check --strict",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthGateway);
		if (!args.action) {
			renderCommandHelp("omp-zh", "auth-gateway", AuthGateway);
			return;
		}
		const cmd: AuthGatewayCommandArgs = {
			action: args.action as AuthGatewayAction,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				noAuth: flags["no-auth"],
				strict: flags.strict,
			},
		};
		await initTheme();
		await runAuthGatewayCommand(cmd);
	}
}
