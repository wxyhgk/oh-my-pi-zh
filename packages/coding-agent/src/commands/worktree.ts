/**
 * List and clean up agent-managed git worktrees under `~/.omp/wt`.
 */

import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { worktreeHelp as commandHelp } from "../cli/command-help";
import { clearWorktrees, listWorktrees } from "../cli/worktree-cli";
import { Settings } from "../config/settings";

export default class Worktree extends Command {
	static description = commandHelp.description;
	static aliases = ["wt"];

	static args = {
		// `list` (default) inspects the worktree dir; `clear` removes entries.
		// A positional action keeps `omp worktree` (the no-arg form) useful.
		action: Args.string({
			description: "list（默认）或 clear",
			required: false,
			options: ["list", "clear"],
			default: "list",
		}),
	};

	static flags = {
		all: Flags.boolean({
			description: "清除所有条目，包括正在使用的 PR 检出工作树（clear）",
			default: false,
		}),
		"dry-run": Flags.boolean({
			char: "n",
			description: "仅打印将要移除的内容，不实际改动文件系统（clear）",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "输出机器可读的 JSON", default: false }),
	};

	static examples = [
		"omp-zh worktree",
		"omp-zh worktree list --json",
		"omp-zh worktree clear",
		"omp-zh worktree clear --dry-run",
		"omp-zh worktree clear --all",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Worktree);
		// Load settings so the `worktree.base` override is applied before we scan
		// — otherwise this command would inspect ~/.omp/wt while the agent created
		// its worktrees under the configured base.
		await Settings.init({ cwd: getProjectDir() });
		if (args.action === "clear") {
			await clearWorktrees({
				all: flags.all ?? false,
				dryRun: flags["dry-run"] ?? false,
				json: flags.json ?? false,
			});
			return;
		}
		await listWorktrees({ json: flags.json ?? false });
	}
}
