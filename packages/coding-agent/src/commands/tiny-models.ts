import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { tinyModelsHelp as commandHelp } from "../cli/command-help";
import { runTinyModelsCommand, type TinyModelsAction, type TinyModelsCommandArgs } from "../cli/tiny-models-cli";

const ACTIONS: TinyModelsAction[] = ["download", "list"];

export default class TinyModels extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "要执行的操作",
			required: false,
			options: ACTIONS,
		}),
		model: Args.string({
			description: "模型键，或 all",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "输出 JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(TinyModels);
		const command: TinyModelsCommandArgs = {
			action: (args.action ?? "download") as TinyModelsAction,
			model: args.model,
			flags: {
				json: flags.json,
			},
		};
		await runTinyModelsCommand(command);
	}
}
