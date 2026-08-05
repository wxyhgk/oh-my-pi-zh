/**
 * Manage bundled task agents.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { agentsHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: AgentsAction[] = ["unpack"];

export default class Agents extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Agents 操作",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "覆盖现有的 agent 文件" }),
		json: Flags.boolean({ description: "输出 JSON" }),
		dir: Flags.string({ description: "输出目录（覆盖 --user/--project）" }),
		user: Flags.boolean({ description: "写入 ~/.omp/agent/agents（默认）" }),
		project: Flags.boolean({ description: "写入 ./.omp/agents" }),
	};

	static examples = [
		"# 将内置 agents 导出到用户配置（默认）\n  omp-zh agents unpack",
		"# 将内置 agents 导出到项目配置\n  omp-zh agents unpack --project",
		"# 覆盖现有的本地 agent 文件\n  omp-zh agents unpack --project --force",
		"# 导出到自定义目录\n  omp-zh agents unpack --dir ./tmp/agents --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp("omp-zh", "agents", Agents);
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
			},
		};

		await initTheme();
		await runAgentsCommand(cmd);
	}
}
