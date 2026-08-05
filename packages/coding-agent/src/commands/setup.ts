/**
 * Run onboarding setup or install dependencies for optional features.
 */

import { Args, Command, Flags, renderCommandHelp } from "@wxyhgk/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { setupHelp as commandHelp } from "../cli/command-help";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { runRootCommand } from "../main";
import { initTheme } from "../modes/theme/theme";

const COMPONENTS: SetupComponent[] = ["python", "speech"];

export interface OnboardingSetupDependencies {
	runRoot?: typeof runRootCommand;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	writeStderr?: (text: string) => void;
	exit?: (code: number) => never;
}

export async function runOnboardingSetup(deps: OnboardingSetupDependencies = {}): Promise<void> {
	const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
	const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY;
	if (!stdinIsTTY || !stdoutIsTTY) {
		(deps.writeStderr ?? (text => process.stderr.write(text)))("omp-zh setup 需要交互式 TTY。\n");
		(deps.exit ?? process.exit)(1);
		return;
	}
	await (deps.runRoot ?? runRootCommand)(parseArgs([]), [], { forceSetupWizard: true });
}

export default class Setup extends Command {
	static description = commandHelp.description;
	static args = {
		component: Args.string({
			description: "要安装的可选组件",
			required: false,
			options: COMPONENTS,
		}),
	};

	static flags = {
		check: Flags.boolean({ char: "c", description: "检查依赖是否已安装" }),
		json: Flags.boolean({ description: "以 JSON 输出状态" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		if (!args.component) {
			if (flags.check || flags.json) {
				renderCommandHelp("omp-zh", "setup", Setup);
				return;
			}
			await runOnboardingSetup();
			return;
		}
		const cmd: SetupCommandArgs = {
			component: args.component as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
