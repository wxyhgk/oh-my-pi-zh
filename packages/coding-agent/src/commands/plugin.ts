/**
 * Manage plugins (install, uninstall, list, etc.).
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { pluginHelp as commandHelp } from "../cli/command-help";
import { type PluginAction, type PluginCommandArgs, runPluginCommand } from "../cli/plugin-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

export default class Plugin extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "插件操作",
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: "包、路径或插件名称",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "输出 JSON" }),
		fix: Flags.boolean({ description: "尝试修复问题（doctor）" }),
		force: Flags.boolean({ description: "强制安装" }),
		"dry-run": Flags.boolean({ description: "显示操作但不应用更改" }),
		local: Flags.boolean({ char: "l", description: "对本地插件目录进行操作" }),
		enable: Flags.string({ description: "启用一个功能" }),
		disable: Flags.string({ description: "禁用一个功能" }),
		set: Flags.string({ description: "设置插件配置（key=value）" }),
		scope: Flags.string({
			description: '安装范围："user"（默认）或 "project"',
			options: ["user", "project"],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Plugin);
		const action = (args.action ?? "list") as PluginAction;

		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
		const cmd: PluginCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				fix: flags.fix,
				force: flags.force,
				dryRun: flags["dry-run"],
				local: flags.local,
				enable: flags.enable,
				disable: flags.disable,
				set: flags.set,
				scope: flags.scope as "user" | "project" | undefined,
			},
		};

		await initTheme();
		await runPluginCommand(cmd);
	}
}
