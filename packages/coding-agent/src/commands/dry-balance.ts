import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { dryBalanceHelp as commandHelp } from "../cli/command-help";
import { runDryBalanceCommand } from "../cli/dry-balance-cli";

export default class DryBalance extends Command {
	static description = commandHelp.description;
	static args = {
		model: Args.string({
			description: "模型选择器（provider/model 或模糊 ID）。默认为已配置的默认模型。",
			required: false,
		}),
	};

	static flags = {
		model: Flags.string({ description: "模型选择器（语法与 omp 的 --model 相同）" }),
		count: Flags.integer({ description: "要尝试的随机会话 ID 数量", default: 100 }),
		concurrency: Flags.integer({ description: "最大并发凭据解析数", default: 32 }),
		json: Flags.boolean({ description: "输出 JSON" }),
		bench: Flags.boolean({ description: "为每个 OAuth 账户发送一次实时基准请求" }),
	};

	static examples = [
		"# 使用 100 个随机会话 ID 试运行已配置的默认模型\n  omp-zh dry-balance",
		"# 试运行特定模型\n  omp-zh dry-balance anthropic/claude-sonnet-4-5",
		"# 更大规模运行，限制并发\n  omp-zh dry-balance --model openai-codex/gpt-5-codex --count 1000 --concurrency 64",
		"# 并行基准测试每个 OAuth 账户\n  omp-zh dry-balance --bench",
		"# 机器可读输出\n  omp-zh dry-balance --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(DryBalance);
		await runDryBalanceCommand({
			model: args.model,
			flags: {
				model: flags.model,
				count: flags.count,
				concurrency: flags.concurrency,
				json: flags.json,
				bench: flags.bench,
			},
		});
	}
}
