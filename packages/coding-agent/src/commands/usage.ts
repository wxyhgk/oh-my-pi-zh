/**
 * Show provider usage limits for every authenticated account.
 */

import { Args, Command, Flags } from "@wxyhgk/pi-utils/cli";
import { usageHelp as commandHelp } from "../cli/command-help";
import { runUsageCommand } from "../cli/usage-cli";

export default class Usage extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "要执行的子命令",
			required: false,
			options: ["invalidate"],
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "以 JSON 格式输出用量报告", default: false }),
		provider: Flags.string({ char: "p", description: "仅显示此提供商 ID（如 anthropic）的用量" }),
		redact: Flags.boolean({
			char: "r",
			description: "隐藏账户邮箱/ID（最短唯一前缀），用于分享截图",
			default: false,
		}),
		history: Flags.boolean({
			description: "显示记录的用量限制历史（每小时快照），而不是实时快照",
			default: false,
		}),
		days: Flags.integer({ char: "d", description: "历史窗口天数（配合 --history）", default: 7 }),
	};

	static examples = [
		"# 所有提供商的逐账户用量明细\n  omp-zh usage",
		"# 仅 Anthropic 账户\n  omp-zh usage --provider anthropic",
		"# 隐藏账户标识，便于截图分享\n  omp-zh usage --redact",
		"# 机器可读输出\n  omp-zh usage --json",
		"# 最近 30 天的用量限制趋势\n  omp-zh usage --history --days 30",
		"# 使所有提供商的缓存用量报告失效\n  omp-zh usage invalidate",
		"# 使指定提供商的缓存用量报告失效\n  omp-zh usage invalidate --provider anthropic",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Usage);
		await runUsageCommand({
			action: args.action,
			json: flags.json,
			provider: flags.provider,
			redact: flags.redact,
			history: flags.history,
			days: flags.days,
		});
	}
}
