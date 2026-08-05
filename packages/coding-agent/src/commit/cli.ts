import chalk from "chalk";
import type { CommitCommandArgs } from "./types";

const FLAG_ALIASES = new Map<string, string>([
	["-c", "--context"],
	["-m", "--model"],
]);

export function parseCommitArgs(args: string[]): CommitCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "commit") {
		return undefined;
	}

	const result: CommitCommandArgs = {
		push: false,
		dryRun: false,
		noChangelog: false,
	};

	for (let i = 1; i < args.length; i += 1) {
		const raw = args[i] ?? "";
		const flag = FLAG_ALIASES.get(raw) ?? raw;
		switch (flag) {
			case "--push":
				result.push = true;
				break;
			case "--dry-run":
				result.dryRun = true;
				break;
			case "--no-changelog":
				result.noChangelog = true;
				break;
			case "--legacy":
				result.legacy = true;
				break;
			case "--context": {
				const value = args[i + 1];
				if (!value || value.startsWith("-")) {
					process.stderr.write(`${chalk.red("错误:--context 需要一个值")}\n`);
					process.exit(1);
				}
				result.context = value;
				i += 1;
				break;
			}
			case "--model": {
				const value = args[i + 1];
				if (!value || value.startsWith("-")) {
					process.stderr.write(`${chalk.red("错误:--model 需要一个值")}\n`);
					process.exit(1);
				}
				result.model = value;
				i += 1;
				break;
			}
			case "--help":
			case "-h":
				break;
			default:
				if (flag.startsWith("-")) {
					process.stderr.write(`${chalk.red(`错误:未知标志 ${flag}`)}\n`);
					process.exit(1);
				}
		}
	}

	return result;
}

export function printCommitHelp(): void {
	const lines = [
		"用法:",
		"  omp commit [选项]",
		"",
		"选项:",
		"  --push           提交后推送",
		"  --dry-run        预览但不提交",
		"  --no-changelog   跳过变更日志更新",
		"  --legacy         使用旧版确定性流水线",
		"  --context, -c    为模型提供附加上下文",
		"  --model, -m      覆盖模型选择",
		"  --help, -h       显示此帮助消息",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
}
