/**
 * `omp browser-relay` — drive the user's own Chrome tabs.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	BROWSER_RELAY_ACTIONS,
	type BrowserRelayAction,
	DEFAULT_RELAY_PORT,
	runBrowserRelayCommand,
} from "../cli/browser-relay-cli";

export default class BrowserRelay extends Command {
	static description = "运行本地 CDP relay,让浏览器工具可以操控你自己的 Chrome 标签页";

	static args = {
		action: Args.string({
			description: `操作：${BROWSER_RELAY_ACTIONS.join(" | ")}（默认 serve）`,
			options: [...BROWSER_RELAY_ACTIONS],
			required: false,
		}),
	};

	static flags = {
		port: Flags.integer({ char: "p", description: "监听端口", default: DEFAULT_RELAY_PORT }),
		token: Flags.string({ description: "要求扩展提供此 token" }),
		dir: Flags.string({
			description: "扩展安装目录（install；默认 ~/.omp/browser-relay/extension）",
		}),
		"no-group": Flags.boolean({
			description: "不将可控制的标签页归入 'omp' 标签组",
			default: false,
		}),
		verbose: Flags.boolean({ char: "v", description: "将中继流量摘要记录到 stderr", default: false }),
	};

	static examples = [
		"omp-zh browser-relay install    # write the Chrome extension to disk + setup steps",
		"omp-zh browser-relay            # serve the relay on the default port",
		"omp-zh browser-relay -p 9333 --token s3cret",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserRelay);
		await runBrowserRelayCommand({
			action: (args.action as BrowserRelayAction | undefined) ?? "serve",
			port: flags.port,
			token: flags.token,
			dir: flags.dir,
			group: !flags["no-group"],
			verbose: flags.verbose,
		});
	}
}
