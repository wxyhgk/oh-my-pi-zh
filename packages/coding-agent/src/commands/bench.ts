import { Args, Command, Flags } from "@wxyhgk/pi-utils/cli";
import { runBenchCommand } from "../cli/bench-cli";
import { benchHelp as commandHelp } from "../cli/command-help";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";

export default class Bench extends Command {
	static description = commandHelp.description;
	static args = {
		models: Args.string({
			description: "模型选择器（provider/model 或模糊 ID，例如 opus）",
			required: true,
			multiple: true,
		}),
	};

	static flags = {
		runs: Flags.integer({ description: "每个模型的请求数（结果取平均；默认：10）" }),
		"max-tokens": Flags.integer({ description: "每个请求的最大输出 token（默认：512；缓存模式：64）" }),
		prompt: Flags.string({ description: "自定义提示词文本（默认：内置 bench 提示词）" }),
		"service-tier": Flags.string({
			description: "应用于每个模型族的服务层级（默认：已配置的 `tier.*` 设置；`none` 表示省略）",
			options: SERVICE_TIER_OPENAI_VALUES,
		}),
		json: Flags.boolean({ description: "输出 JSON" }),
		par: Flags.integer({ description: "以 N 个并行查询/请求执行（默认：4）" }),
		cache: Flags.boolean({
			description: "运行独立的冷/热提示词缓存配对（openai-codex-responses 不支持）",
		}),
		"cache-prefix-file": Flags.string({ description: "用于 --cache 的稳定提示词前缀文件" }),
		"cache-prefix-bytes": Flags.integer({ description: "用于 --cache 的稳定前缀字节预算（默认：8192）" }),
		"cache-pairs": Flags.integer({ description: "每个模型用于 --cache 的冷/热配对数（默认：1）" }),
		"cache-concurrency": Flags.integer({
			description: "用于 --cache 的并发缓存配对；每个配对内部保持顺序（默认：1）",
		}),
	};

	static examples = [
		"# 比较两个模型\n  omp-zh bench anthropic/claude-opus-4-5 openai/gpt-5.2",
		"# 模糊选择器同样可用\n  omp-zh bench opus sonnet",
		"# 每个模型运行 3 次取平均\n  omp-zh bench opus gpt-5.2 --runs 3",
		"# 强制优先服务层级\n  omp-zh bench openai-codex/gpt-5.5:low --runs 10 --service-tier priority",
		"# 测量一组冷/热提示词缓存配对\n  omp-zh bench openai/gpt-5.6 --cache --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Bench);
		await runBenchCommand({
			models: args.models ?? [],
			flags: {
				runs: flags.runs,
				maxTokens: flags["max-tokens"],
				prompt: flags.prompt,
				serviceTier: flags["service-tier"],
				json: flags.json,
				par: flags.par,
				cache: flags.cache,
				cachePrefixFile: flags["cache-prefix-file"],
				cachePrefixBytes: flags["cache-prefix-bytes"],
				cachePairs: flags["cache-pairs"],
				cacheConcurrency: flags["cache-concurrency"],
			},
		});
	}
}
