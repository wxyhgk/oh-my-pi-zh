/**
 * Interactive shell console.
 */

import { Command, Flags } from "@wxyhgk/pi-utils/cli";
import { shellHelp as commandHelp } from "../cli/command-help";
import { runShellCommand, type ShellCommandArgs } from "../cli/shell-cli";
import { initTheme } from "../modes/theme/theme";

export default class Shell extends Command {
	static description = commandHelp.description;
	static flags = {
		cwd: Flags.string({ char: "C", description: "设置命令的工作目录" }),
		timeout: Flags.integer({ char: "t", description: "每条命令的超时时间（毫秒）" }),
		"no-snapshot": Flags.boolean({ description: "跳过从用户 shell 加载快照" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Shell);

		const cmd: ShellCommandArgs = {
			cwd: flags.cwd,
			timeoutMs: flags.timeout,
			noSnapshot: flags["no-snapshot"],
		};

		await initTheme();
		await runShellCommand(cmd);
	}
}
