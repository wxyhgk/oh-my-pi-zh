/**
 * View usage statistics dashboard.
 */

import { Command, Flags } from "@wxyhgk/pi-utils/cli";
import { statsHelp as commandHelp } from "../cli/command-help";
import { runStatsCommand, type StatsCommandArgs } from "../cli/stats-cli";
import { initTheme } from "../modes/theme/theme";

export default class Stats extends Command {
	static description = commandHelp.description;
	static flags = {
		port: Flags.integer({ char: "p", description: "仪表盘服务器端口", default: 3847 }),
		json: Flags.boolean({ char: "j", description: "以 JSON 输出统计信息", default: false }),
		summary: Flags.boolean({ char: "s", description: "在控制台打印摘要", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Stats);

		const cmd: StatsCommandArgs = {
			port: flags.port,
			json: flags.json,
			summary: flags.summary,
		};

		await initTheme();
		await runStatsCommand(cmd);
	}
}
