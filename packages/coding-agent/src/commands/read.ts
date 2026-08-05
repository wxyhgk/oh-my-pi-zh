/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */

import { Args, Command } from "@wxyhgk/pi-utils/cli";
import { readHelp as commandHelp } from "../cli/command-help";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = commandHelp.description;
	static args = {
		path: Args.string({
			description:
				"要读取的路径、URL 或内部 URI（附加 :sel 可指定行范围或 raw 模式，例如 src/foo.ts:50-100）",
			required: true,
		}),
	};

	static examples = [
		"omp-zh read src/foo.ts",
		"omp-zh read src/foo.ts:50-100",
		"omp-zh read src/foo.ts:raw",
		"omp-zh read https://example.com",
		"omp-zh read omp://",
		"omp-zh read issue://123",
		"omp-zh read path/to/archive.zip:dir/file.ts",
		"omp-zh read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
