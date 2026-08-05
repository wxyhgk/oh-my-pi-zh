import { postmortem } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCleanseCommand } from "../cleanse";
import { cleanseHelp as commandHelp } from "../cli/command-help";
import { CliUsageError } from "../cli/usage-error";

export default class Cleanse extends Command {
	static description = commandHelp.description;
	static flags = {
		agents: Flags.integer({
			char: "n",
			description: "文件不相交子代理的最大数量",
			default: 8,
		}),
		model: Flags.string({
			char: "m",
			description: "子代理模型选择器",
			default: "@smol",
		}),
		tests: Flags.boolean({
			char: "t",
			description: "同时运行已配置的项目测试套件",
			default: false,
		}),
	};

	static examples = [
		"omp-zh cleanse",
		"omp-zh cleanse -n 4",
		"omp-zh cleanse -m opus",
		"omp-zh cleanse -t",
		"omp-zh cleanse --agents 12 --model anthropic/claude-opus-4-6",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Cleanse);
		if (flags.agents <= 0) throw new CliUsageError("--agents 必须是正整数");
		const result = await runCleanseCommand({
			maxAgents: flags.agents,
			model: flags.model,
			includeTests: flags.tests,
		});
		await postmortem.quit(result.exitCode);
	}
}
