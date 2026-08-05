/**
 * Manage SSH host configurations.
 */

import { Args, Command, Flags } from "@wxyhgk/pi-utils/cli";
import { sshHelp as commandHelp } from "../cli/command-help";
import { runSSHCommand, type SSHAction, type SSHCommandArgs } from "../cli/ssh-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: SSHAction[] = ["add", "remove", "list"];

export default class SSH extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "SSH 操作",
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: "主机名或参数",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "输出 JSON" }),
		host: Flags.string({ description: "主机地址" }),
		user: Flags.string({ description: "用户名" }),
		port: Flags.string({ description: "端口号" }),
		key: Flags.string({ description: "身份密钥路径" }),
		desc: Flags.string({ description: "主机描述" }),
		compat: Flags.boolean({ description: "启用兼容模式" }),
		scope: Flags.string({ description: "配置作用域（project|user）", options: ["project", "user"] }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(SSH);
		const action = (args.action ?? "list") as SSHAction;
		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];

		const cmd: SSHCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				host: flags.host,
				user: flags.user,
				port: flags.port,
				key: flags.key,
				desc: flags.desc,
				compat: flags.compat,
				scope: flags.scope as "project" | "user" | undefined,
			},
		};

		await initTheme();
		await runSSHCommand(cmd);
	}
}
