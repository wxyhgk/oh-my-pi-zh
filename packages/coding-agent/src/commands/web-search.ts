/**
 * Test web search providers.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { searchHelp as commandHelp } from "../cli/command-help";
import { runSearchCommand, type SearchCommandArgs } from "../cli/web-search-cli";
import { SEARCH_PROVIDER_ORDER } from "../web/search/provider";

const PROVIDERS: Array<string> = ["auto", ...SEARCH_PROVIDER_ORDER];

const RECENCY: NonNullable<SearchCommandArgs["recency"]>[] = ["day", "week", "month", "year"];

export default class Search extends Command {
	static description = commandHelp.description;
	static aliases = ["q"];

	static args = {
		query: Args.string({ description: "搜索查询文本", required: false, multiple: true }),
	};

	static flags = {
		provider: Flags.string({ description: "搜索提供商", options: PROVIDERS }),
		recency: Flags.string({ description: "时间范围筛选", options: RECENCY }),
		limit: Flags.integer({ char: "l", description: "最多返回的结果数" }),
		compact: Flags.boolean({ description: "渲染精简输出" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Search);
		const query = Array.isArray(args.query) ? args.query.join(" ") : (args.query ?? "");

		const cmd: SearchCommandArgs = {
			query,
			provider: flags.provider as SearchCommandArgs["provider"],
			recency: flags.recency as SearchCommandArgs["recency"],
			limit: flags.limit,
			expanded: !flags.compact,
		};

		await runSearchCommand(cmd);
	}
}
