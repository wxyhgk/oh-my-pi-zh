/**
 * View, clean, and push reported tool issues from automated QA.
 */

import { Args, Command, Flags } from "@wxyhgk/pi-utils/cli";
import { grievancesHelp as commandHelp } from "../cli/command-help";
import { cleanGrievances, listGrievances, pushGrievances } from "../cli/grievances-cli";

export default class Grievances extends Command {
	static description = commandHelp.description;
	static args = {
		// Positional action: "list" (default), "clean", or "push". A positional
		// arg keeps the historical `omp grievances` invocation working unchanged
		// while reusing the same command surface for the clean/push verbs.
		action: Args.string({
			description: "list（默认）、clean 或 push",
			required: false,
			options: ["list", "clean", "push"],
			default: "list",
		}),
	};

	static flags = {
		limit: Flags.integer({ char: "n", description: "要显示的最近问题数（list）", default: 20 }),
		tool: Flags.string({ char: "t", description: "按工具名筛选（list、clean）" }),
		json: Flags.boolean({ char: "j", description: "以 JSON 格式输出", default: false }),
		id: Flags.integer({ description: "按 id 删除单个问题（clean）" }),
		all: Flags.boolean({ description: "删除所有问题（clean）", default: false }),
	};

	static examples = [
		"omp-zh grievances",
		"omp-zh grievances list --tool find",
		"omp-zh grievances clean --id 209",
		"omp-zh grievances clean --tool find",
		"omp-zh grievances clean --all",
		"omp-zh grievances push",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Grievances);
		if (args.action === "clean") {
			await cleanGrievances({ id: flags.id, tool: flags.tool, all: flags.all, json: flags.json });
			return;
		}
		if (args.action === "push") {
			await pushGrievances({ json: flags.json });
			return;
		}
		await listGrievances({ limit: flags.limit, tool: flags.tool, json: flags.json });
	}
}
