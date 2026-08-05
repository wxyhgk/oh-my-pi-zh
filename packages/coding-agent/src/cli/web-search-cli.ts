/**
 * Web search CLI command handlers.
 *
 * Handles `omp q`/`omp web-search` subcommands for testing web search providers.
 */

import { APP_NAME, getProjectDir } from "@wxyhgk/pi-utils";
import chalk from "chalk";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { Settings } from "../config/settings";
import { initTheme, theme } from "../modes/theme/theme";
import { runSearchQuery, type SearchQueryParams } from "../web/search/index";
import { SEARCH_PROVIDER_ORDER } from "../web/search/provider";
import { renderSearchResult } from "../web/search/render";
import type { SearchProviderId } from "../web/search/types";

export interface SearchCommandArgs {
	query: string;
	provider?: SearchProviderId | "auto";
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
}

const PROVIDERS: Array<SearchProviderId | "auto"> = ["auto", ...SEARCH_PROVIDER_ORDER];

const RECENCY_OPTIONS: SearchCommandArgs["recency"][] = ["day", "week", "month", "year"];

/**
 * Parse web search subcommand arguments.
 * Returns undefined if not a web search command.
 */
export function parseSearchArgs(args: string[]): SearchCommandArgs | undefined {
	if (args.length === 0 || (args[0] !== "q" && args[0] !== "web-search")) {
		return undefined;
	}

	const result: SearchCommandArgs = {
		query: "",
		expanded: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--provider") {
			result.provider = args[++i] as SearchCommandArgs["provider"];
		} else if (arg === "--recency") {
			result.recency = args[++i] as SearchCommandArgs["recency"];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = Number.parseInt(args[++i], 10);
		} else if (arg === "--compact") {
			result.expanded = false;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length > 0) {
		result.query = positional.join(" ");
	}

	return result;
}

export async function runSearchCommand(cmd: SearchCommandArgs): Promise<void> {
	if (!cmd.query) {
		process.stderr.write(`${chalk.red("错误:必须提供查询")}\n`);
		process.exit(1);
	}

	if (cmd.provider && !PROVIDERS.includes(cmd.provider)) {
		process.stderr.write(`${chalk.red(`错误:未知提供商“${cmd.provider}”`)}\n`);
		process.stderr.write(`${chalk.dim(`有效提供商:${PROVIDERS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.recency && !RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(`错误:无效的时间范围“${cmd.recency}”`)}\n`);
		process.stderr.write(`${chalk.dim(`有效的时间范围值:${RECENCY_OPTIONS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.limit !== undefined && Number.isNaN(cmd.limit)) {
		process.stderr.write(`${chalk.red("错误:--limit 必须是数字")}\n`);
		process.exit(1);
	}

	const settings = await Settings.init({ cwd: getProjectDir() });
	applyProviderGlobalsFromSettings(settings);

	await initTheme();

	const params: SearchQueryParams = {
		query: cmd.query,
		provider: cmd.provider,
		recency: cmd.recency,
		limit: cmd.limit,
	};

	const result = await runSearchQuery(params);
	const component = renderSearchResult(result, { expanded: cmd.expanded, isPartial: false }, theme, {
		query: cmd.query,
		maxAnswerLines: cmd.expanded ? undefined : 6,
	});

	const width = Math.max(60, process.stdout.columns ?? 100);
	process.stdout.write(`${component.render(width).join("\n")}\n`);

	if (result.details?.error) {
		process.exitCode = 1;
	}
}

export function printSearchHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} q`)} - 测试网络搜索提供商

${chalk.bold("用法:")}
  ${APP_NAME} q [options] <query>
  ${APP_NAME} web-search [options] <query>

${chalk.bold("参数:")}
  query      搜索查询文本

${chalk.bold("选项:")}
  --provider <name>   提供商:${PROVIDERS.join(", ")}
  --recency <value>   时间范围筛选(如果支持):${RECENCY_OPTIONS.join(", ")}
  -l, --limit <n>     返回的最大结果数
  --compact           渲染精简输出
  -h, --help          显示此帮助

${chalk.bold("查询指令:")}
  site:/-site:  after:/before: (YYYY-MM-DD)  inurl:  intitle:  filetype:
  "exact phrase"  -term  OR
  在可用时映射到提供商的原生筛选器,否则作为宽松的后置筛选应用
  (无匹配的约束会被放宽,而不是报错)。

${chalk.bold("示例:")}
  ${APP_NAME} q --provider=exa "what's the color of the sky"
  ${APP_NAME} q --provider=brave --recency=week "latest TypeScript 5.7 changes"
  ${APP_NAME} q 'transformer scaling site:arxiv.org after:2024 -site:reddit.com'
`);
}
