/**
 * Test grep tool.
 */

import { GrepOutputMode } from "@oh-my-pi/pi-natives";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { grepHelp as commandHelp } from "../cli/command-help";
import { type GrepCommandArgs, runGrepCommand } from "../cli/grep-cli";
import { initTheme } from "../modes/theme/theme";

export default class Grep extends Command {
	static description = commandHelp.description;
	static args = {
		pattern: Args.string({ description: "要搜索的正则模式", required: false }),
		path: Args.string({ description: "要搜索的目录或文件", required: false }),
	};

	static flags = {
		glob: Flags.string({ char: "g", description: "按 glob 模式筛选文件" }),
		limit: Flags.integer({ char: "l", description: "最大匹配数", default: 20 }),
		context: Flags.integer({ char: "C", description: "上下文行数", default: 2 }),
		files: Flags.boolean({ char: "f", description: "仅输出文件名" }),
		count: Flags.boolean({ char: "c", description: "输出每个文件的匹配数" }),
		"no-gitignore": Flags.boolean({ description: "包含被 .gitignore 排除的文件" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Grep);

		const mode: GrepCommandArgs["mode"] = flags.count
			? GrepOutputMode.Count
			: flags.files
				? GrepOutputMode.FilesWithMatches
				: GrepOutputMode.Content;

		const cmd: GrepCommandArgs = {
			pattern: args.pattern ?? "",
			path: args.path ?? ".",
			glob: flags.glob,
			limit: flags.limit,
			context: flags.context,
			mode,
			gitignore: !flags["no-gitignore"],
		};

		await initTheme();
		await runGrepCommand(cmd);
	}
}
