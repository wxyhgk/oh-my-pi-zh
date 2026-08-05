/**
 * Shell CLI command handlers.
 *
 * Handles `omp shell` subcommand for testing the native brush-core shell.
 */
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Shell } from "@oh-my-pi/pi-natives";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { buildMinimizerOptions } from "../exec/bash-executor";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";

export interface ShellCommandArgs {
	cwd?: string;
	timeoutMs?: number;
	noSnapshot?: boolean;
}

export function parseShellArgs(args: string[]): ShellCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "shell") {
		return undefined;
	}

	const result: ShellCommandArgs = {};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd" || arg === "-C") {
			result.cwd = args[++i];
		} else if (arg === "--timeout" || arg === "-t") {
			const parsed = Number.parseInt(args[++i], 10);
			if (Number.isFinite(parsed)) {
				result.timeoutMs = parsed;
			}
		} else if (arg === "--no-snapshot") {
			result.noSnapshot = true;
		}
	}

	return result;
}

export async function runShellCommand(cmd: ShellCommandArgs): Promise<void> {
	if (!process.stdin.isTTY) {
		process.stderr.write("错误:shell 控制台需要交互式 TTY。\n");
		process.exit(1);
	}

	const cwd = cmd.cwd ? path.resolve(cmd.cwd) : getProjectDir();
	const settings = await Settings.init({ cwd });
	const { shell, env: shellEnv } = settings.getShellConfig();
	const snapshotPath = cmd.noSnapshot || !shell.includes("bash") ? null : await getOrCreateSnapshot(shell, shellEnv);
	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));
	const shellSession = new Shell({ sessionEnv: shellEnv, snapshotPath: snapshotPath ?? undefined, minimizer });

	let active = false;
	let lastChar: string | null = null;

	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const prompt = chalk.cyan(`${APP_NAME} shell> `);

	const printHelp = () => {
		process.stdout.write(
			`${chalk.bold("Shell 控制台命令")}

` +
				`${chalk.bold("特殊命令:")}
  .help           显示此帮助
  .exit, exit     退出控制台

` +
				`${chalk.bold("选项:")}
  --cwd, -C <path>     设置命令的工作目录
  --timeout, -t <ms>   每条命令的超时时间(毫秒)
  --no-snapshot        跳过从用户 shell 加载快照

` +
				`${chalk.bold("说明:")}
  在持久的 brush-core shell 会话中运行。
  一条命令中定义的变量和函数会保留到下一条命令。

`,
		);
	};

	const interruptHandler = () => {
		if (active) {
			void shellSession.abort();
			return;
		}
		rl.close();
		process.exit(0);
	};

	process.on("SIGINT", interruptHandler);
	process.stdout.write(chalk.dim("输入 .help 查看命令。\n"));

	try {
		while (true) {
			const line = (await rl.question(prompt)).trim();
			if (!line) {
				continue;
			}
			if (line === ".help") {
				printHelp();
				continue;
			}
			if (line === ".exit" || line === "exit" || line === "quit") {
				break;
			}

			active = true;
			lastChar = null;
			try {
				const result = await shellSession.run(
					{
						command: line,
						cwd,
						timeoutMs: cmd.timeoutMs,
					},
					(err, chunk) => {
						if (err) {
							process.stderr.write(`${err.message}\n`);
							return;
						}
						if (chunk.length > 0) {
							lastChar = chunk[chunk.length - 1] ?? null;
						}
						process.stdout.write(chunk);
					},
				);

				if (lastChar && lastChar !== "\n") {
					process.stdout.write("\n");
				}

				if (result.timedOut) {
					process.stderr.write(chalk.yellow("命令超时。\n"));
				} else if (result.cancelled) {
					process.stderr.write(chalk.yellow("命令已取消。\n"));
				} else if (result.exitCode !== 0 && result.exitCode !== undefined) {
					process.stderr.write(chalk.yellow(`退出码:${result.exitCode}\n`));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(chalk.red(`错误:${message}\n`));
			} finally {
				active = false;
			}
		}
	} finally {
		process.off("SIGINT", interruptHandler);
		rl.close();
	}
}

export function printShellHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} shell`)} - 用于测试的交互式 shell 控制台

${chalk.bold("用法:")}
  ${APP_NAME} shell [options]

${chalk.bold("选项:")}
  --cwd, -C <path>     设置命令的工作目录
  --timeout, -t <ms>   每条命令的超时时间(毫秒)
  --no-snapshot        跳过从用户 shell 加载快照
  -h, --help           显示此帮助

${chalk.bold("示例:")}
  ${APP_NAME} shell
  ${APP_NAME} shell --cwd ./tmp
  ${APP_NAME} shell --timeout 2000
`);
}
