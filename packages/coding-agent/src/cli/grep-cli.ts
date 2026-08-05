/**
 * Grep CLI command handlers.
 *
 * Handles `omp grep` subcommand for testing grep tool on Windows.
 */
import * as path from "node:path";
import { GrepOutputMode, grep } from "@wxyhgk/pi-natives";
import { APP_NAME } from "@wxyhgk/pi-utils";
import chalk from "chalk";
import { expandPath } from "../tools/path-utils";

export interface GrepCommandArgs {
	pattern: string;
	path: string;
	glob?: string;
	limit: number;
	context: number;
	mode: GrepOutputMode;
	gitignore: boolean;
}

/**
 * Parse grep subcommand arguments.
 * Returns undefined if not a grep command.
 */
export function parseGrepArgs(args: string[]): GrepCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "grep") {
		return undefined;
	}

	const result: GrepCommandArgs = {
		pattern: "",
		path: ".",
		limit: 20,
		context: 2,
		mode: GrepOutputMode.Content,
		gitignore: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--glob" || arg === "-g") {
			result.glob = args[++i];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = parseInt(args[++i], 10);
		} else if (arg === "--context" || arg === "-C") {
			result.context = parseInt(args[++i], 10);
		} else if (arg === "--files" || arg === "-f") {
			result.mode = GrepOutputMode.FilesWithMatches;
		} else if (arg === "--count" || arg === "-c") {
			result.mode = GrepOutputMode.Count;
		} else if (arg === "--no-gitignore") {
			result.gitignore = false;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length >= 1) {
		result.pattern = positional[0];
	}
	if (positional.length >= 2) {
		result.path = positional[1];
	}

	return result;
}

export async function runGrepCommand(cmd: GrepCommandArgs): Promise<void> {
	if (!cmd.pattern) {
		console.error(chalk.red("错误:必须提供搜索模式"));
		process.exit(1);
	}

	const searchPath = path.resolve(expandPath(cmd.path));
	console.log(chalk.dim(`正在搜索:${searchPath}`));
	console.log(chalk.dim(`模式:${cmd.pattern}`));
	console.log(chalk.dim(`输出模式:${cmd.mode},限制:${cmd.limit},上下文行:${cmd.context},Gitignore:${cmd.gitignore}`));

	console.log("");

	try {
		const result = await grep({
			pattern: cmd.pattern,
			path: searchPath,
			glob: cmd.glob,
			mode: cmd.mode,
			maxCount: cmd.limit,
			context: cmd.mode === GrepOutputMode.Content ? cmd.context : undefined,
			hidden: true,
			gitignore: cmd.gitignore,
		});

		console.log(chalk.green(`总匹配数:${result.totalMatches}`));
		console.log(chalk.green(`包含匹配的文件数:${result.filesWithMatches}`));
		console.log(chalk.green(`已搜索文件数:${result.filesSearched}`));
		if (result.limitReached) {
			console.log(chalk.yellow(`已达到限制:true`));
		}
		console.log("");

		for (const match of result.matches) {
			const displayPath = match.path.replace(/\\/g, "/");

			if (cmd.mode === GrepOutputMode.Content) {
				if (match.contextBefore) {
					for (const ctx of match.contextBefore) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log(`${chalk.cyan(displayPath)}:${chalk.yellow(String(match.lineNumber))}: ${match.line}`);
				if (match.contextAfter) {
					for (const ctx of match.contextAfter) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log("");
			} else if (cmd.mode === GrepOutputMode.Count) {
				console.log(`${chalk.cyan(displayPath)}: ${match.matchCount ?? 0} 个匹配`);
			} else {
				console.log(chalk.cyan(displayPath));
			}
		}
	} catch (err) {
		console.error(chalk.red(`错误:${err instanceof Error ? err.message : String(err)}`));
		process.exit(1);
	}
}

export function printGrepHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} grep`)} - 测试 grep 工具

${chalk.bold("用法:")}
  ${APP_NAME} grep <pattern> [path] [options]

${chalk.bold("参数:")}
  pattern   要搜索的正则表达式模式
  path      要搜索的目录或文件(默认:.)

${chalk.bold("选项:")}
  -g, --glob <pattern>  按 glob 模式筛选文件
  -l, --limit <n>       最大匹配数(默认:20)
  -C, --context <n>     上下文行数(默认:2)
  -f, --files           仅输出文件名
  -c, --count           输出每个文件的匹配数
  -h, --help            显示此帮助
  --no-gitignore        包含被 .gitignore 排除的文件

${chalk.bold("环境变量:")}
  PI_WALK_WORKERS=N    设置文件系统遍历线程数(默认 4,0 = 自动)

${chalk.bold("示例:")}
  ${APP_NAME} grep "import" src/
  ${APP_NAME} grep "TODO" . --glob "*.ts"
  ${APP_NAME} grep "function" --files
`);
}
