/**
 * Check for and install updates.
 */

import { Command, Flags } from "@wxyhgk/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "../modes/theme/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "强制更新", default: false }),
		check: Flags.boolean({ char: "c", description: "检查更新但不安装", default: false }),
		plugins: Flags.boolean({ char: "l", description: "更新已安装的插件", default: false }),
	};

	static examples = [
		"omp-zh update",
		"omp-zh update --check",
		"# 如果 GitHub 对发布元数据限流，请设置 GITHUB_TOKEN 或 GH_TOKEN\n  GITHUB_TOKEN=... omp-zh update",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({ force: flags.force, check: flags.check });
		}
	}
}
