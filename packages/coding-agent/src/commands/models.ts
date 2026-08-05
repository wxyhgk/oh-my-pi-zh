/**
 * List, search, and refresh available models.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { modelsHelp as commandHelp } from "../cli/command-help";
import { resolveModelsArgs, runModelsCommand } from "../cli/models-cli";

export default class Models extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "ls（默认）| find | refresh | <provider>",
			required: false,
		}),
		pattern: Args.string({
			description: "筛选/搜索子串，或提供商名称（find 必需）",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "输出 JSON" }),
		extension: Flags.string({
			char: "e",
			description: "在列出前加载扩展文件（可重复）",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "禁用扩展发现（显式的 -e 路径仍然有效）",
		}),
		config: Flags.string({
			description: "为此运行加载额外的 config.yml 风格覆盖层（可重复）",
			multiple: true,
		}),
	};

	static examples = [
		`# 列出所有可用模型，按提供商分组\n  ${APP_NAME} models`,
		`# 列出某个提供商的模型（任意提供商名称均可）\n  ${APP_NAME} models openai-codex`,
		`# 按子串查找模型\n  ${APP_NAME} models find minimax`,
		`# 强制重新获取目录（相当于 rm -rf ~/.omp/models.db）\n  ${APP_NAME} models refresh`,
		`# 机器可读输出\n  ${APP_NAME} models --json`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Models);
		const { action, pattern } = resolveModelsArgs(args.action, args.pattern);
		await runModelsCommand({
			action,
			pattern,
			flags: {
				json: flags.json,
				extensions: flags.extension,
				noExtensions: flags["no-extensions"],
				config: flags.config,
			},
		});
	}
}
