/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. Adding a new subcommand here is enough to make
 * `runCli` route to it instead of forwarding the argv as a prompt to
 * `launch` — see #1496 for the original "args silently leak to the LLM"
 * regression that motivated the split.
 */
import type { CommandEntry } from "@wxyhgk/pi-utils/cli";
import * as commandHelp from "./cli/command-help";
import { flagConsumesValue } from "./cli/flag-tables";
import { launchHelp } from "./commands/launch-help";

export const commands: CommandEntry[] = [
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default), help: launchHelp },
	{
		name: "acp",
		load: () => import("./commands/acp").then(m => m.default),
		help: commandHelp.acpHelp,
	},
	{
		name: "auth-broker",
		load: () => import("./commands/auth-broker").then(m => m.default),
		help: commandHelp.authBrokerHelp,
	},
	{
		name: "auth-gateway",
		load: () => import("./commands/auth-gateway").then(m => m.default),
		help: commandHelp.authGatewayHelp,
	},
	{
		name: "agents",
		load: () => import("./commands/agents").then(m => m.default),
		help: commandHelp.agentsHelp,
	},
	{
		name: "bench",
		load: () => import("./commands/bench").then(m => m.default),
		help: commandHelp.benchHelp,
	},
	{
		name: "browser-relay",
		load: () => import("./commands/browser-relay").then(m => m.default),
		help: commandHelp.browserRelayHelp,
	},
	{
		name: "cleanse",
		load: () => import("./commands/cleanse").then(m => m.default),
		help: commandHelp.cleanseHelp,
	},
	{
		name: "commit",
		load: () => import("./commands/commit").then(m => m.default),
		help: commandHelp.commitHelp,
	},
	{
		name: "completions",
		load: () => import("./commands/completions").then(m => m.default),
		help: commandHelp.completionsHelp,
	},
	{
		name: "__complete",
		load: () => import("./commands/complete").then(m => m.default),
		help: commandHelp.completeHelp,
	},
	{
		name: "config",
		load: () => import("./commands/config").then(m => m.default),
		help: commandHelp.configHelp,
	},
	{
		name: "dry-balance",
		load: () => import("./commands/dry-balance").then(m => m.default),
		help: commandHelp.dryBalanceHelp,
	},
	{
		name: "gc",
		load: () => import("./commands/gc").then(m => m.default),
		help: commandHelp.gcHelp,
	},
	{
		name: "grep",
		load: () => import("./commands/grep").then(m => m.default),
		help: commandHelp.grepHelp,
	},
	{
		name: "gallery",
		load: () => import("./commands/gallery").then(m => m.default),
		help: commandHelp.galleryHelp,
	},
	{
		name: "grievances",
		load: () => import("./commands/grievances").then(m => m.default),
		help: commandHelp.grievancesHelp,
	},
	{
		name: "install",
		load: () => import("./commands/install").then(m => m.default),
		help: commandHelp.installHelp,
	},
	{
		name: "join",
		load: () => import("./commands/join").then(m => m.default),
		help: commandHelp.joinHelp,
	},
	{
		name: "models",
		load: () => import("./commands/models").then(m => m.default),
		help: commandHelp.modelsHelp,
	},
	{
		name: "plugin",
		load: () => import("./commands/plugin").then(m => m.default),
		help: commandHelp.pluginHelp,
	},
	{
		name: "say",
		load: () => import("./commands/say").then(m => m.default),
		help: commandHelp.sayHelp,
	},
	{
		name: "setup",
		load: () => import("./commands/setup").then(m => m.default),
		help: commandHelp.setupHelp,
	},
	{
		name: "shell",
		load: () => import("./commands/shell").then(m => m.default),
		help: commandHelp.shellHelp,
	},
	{
		name: "read",
		load: () => import("./commands/read").then(m => m.default),
		help: commandHelp.readHelp,
	},
	{
		name: "ssh",
		load: () => import("./commands/ssh").then(m => m.default),
		help: commandHelp.sshHelp,
	},
	{
		name: "stats",
		load: () => import("./commands/stats").then(m => m.default),
		help: commandHelp.statsHelp,
	},
	{
		name: "update",
		load: () => import("./commands/update").then(m => m.default),
		help: commandHelp.updateHelp,
	},
	{
		name: "usage",
		load: () => import("./commands/usage").then(m => m.default),
		help: commandHelp.usageHelp,
	},
	{
		name: "tiny-models",
		load: () => import("./commands/tiny-models").then(m => m.default),
		help: commandHelp.tinyModelsHelp,
	},
	{
		name: "token",
		load: () => import("./commands/token").then(m => m.default),
		help: commandHelp.tokenHelp,
	},
	{
		name: "ttsr",
		load: () => import("./commands/ttsr").then(m => m.default),
		help: commandHelp.ttsrHelp,
	},
	{
		name: "worktree",
		load: () => import("./commands/worktree").then(m => m.default),
		aliases: ["wt"],
		help: commandHelp.worktreeHelp,
	},
	{
		name: "search",
		load: () => import("./commands/web-search").then(m => m.default),
		aliases: ["q"],
		help: commandHelp.searchHelp,
	},
];

// Documented-looking plugin/marketplace verbs that are NOT registered top-level
// commands. Without a guard `resolveCliArgv` rewrites e.g. `omp marketplace add
// xyz` to `omp launch marketplace add xyz`, silently forwarding the argv to the
// model as a prompt instead of managing plugins (#4845; same class as the
// `list`/`remove` leak fixed in #2935 and the `install` leak in #1496/#1498).
// The real commands live under `omp plugin <action>`; each entry maps a verb to
// a hint pointing there. See {@link reservedTopLevelWordMessage} for when a hint
// fires vs. when the argv still falls through to `launch`.
const RESERVED_TOP_LEVEL_WORDS: Record<string, string> = {
	extensions:
		'`omp-zh extensions` 不是管理命令。请使用 `omp-zh plugin list` / `omp-zh plugin install`;如果你是想把 “extensions” 作为提示词发送,请运行 `omp-zh launch extensions`。',
	list: '`omp-zh list` 不是顶层命令。请使用 `omp-zh plugin list` 列出已安装的插件;如果你是想把 “list” 作为提示词发送,请运行 `omp-zh launch list`。',
	remove:
		'`omp-zh remove` 不是顶层命令。请使用 `omp-zh plugin uninstall <name>` 移除插件;如果你是想把 “remove” 作为提示词发送,请运行 `omp-zh launch remove`。',
	uninstall:
		'`omp-zh uninstall` 不是顶层命令。请使用 `omp-zh plugin uninstall <name@marketplace>` 移除插件;如果你是想把 “uninstall” 作为提示词发送,请运行 `omp-zh launch uninstall`。',
	marketplace:
		'`omp-zh marketplace` 不是顶层命令。请使用 `omp-zh plugin marketplace <add|remove|update|list>` 管理市场;如果你是想把 “marketplace” 作为提示词发送,请运行 `omp-zh launch marketplace`。',
	discover:
		'`omp-zh discover` 不是顶层命令。请使用 `omp-zh plugin discover [marketplace]` 浏览可用插件;如果你是想把 “discover” 作为提示词发送,请运行 `omp-zh launch discover`。',
	upgrade:
		'`omp-zh upgrade` 不是顶层命令。请使用 `omp-zh plugin upgrade [name@marketplace]` 升级插件;如果你是想把 “upgrade” 作为提示词发送,请运行 `omp-zh launch upgrade`。',
	enable:
		'`omp-zh enable` 不是顶层命令。请使用 `omp-zh plugin enable <name@marketplace>` 启用插件;如果你是想把 “enable” 作为提示词发送,请运行 `omp-zh launch enable`。',
	disable:
		'`omp-zh disable` 不是顶层命令。请使用 `omp-zh plugin disable <name@marketplace>` 禁用插件;如果你是想把 “disable” 作为提示词发送,请运行 `omp-zh launch disable`。',
};

// Sub-actions that make `omp marketplace <sub>` unambiguously a management
// command even when multi-word (the reporter's `omp marketplace add xyz`,
// #4845). Mirrors the switch in `handleMarketplace` (cli/plugin-cli.ts).
const MARKETPLACE_SUBCOMMANDS: Record<string, true> = { add: true, remove: true, rm: true, update: true, list: true };

/**
 * Hint for a reserved plugin/marketplace verb used as a top-level command, or
 * `undefined` when the argv should fall through to `launch`.
 *
 * A bare verb (`omp marketplace`) always hints. A multi-word invocation only
 * hints when the arguments follow the documented plugin grammar — a marketplace
 * sub-action (`omp marketplace add …`) or a `name@marketplace` plugin id
 * (`omp uninstall foo@bar`) — so genuine prompts that merely begin with one of
 * these words (`omp list all my files`, `omp upgrade the deps`) still launch.
 *
 * Flags (`-…`) and `@file` arguments in the verb slot are never management
 * commands; those fall through to the default `launch` command.
 */
export function reservedTopLevelWordMessage(argv: readonly string[]): string | undefined {
	const first = argv[0];
	if (!first || first.startsWith("-") || first.startsWith("@")) return undefined;
	const hint = RESERVED_TOP_LEVEL_WORDS[first];
	if (!hint) return undefined;
	const second = argv[1];
	if (second === undefined) return hint;
	if (first === "marketplace" && MARKETPLACE_SUBCOMMANDS[second]) return hint;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("-") && arg.includes("@")) return hint;
	}
	return undefined;
}

/**
 * Return true when `first` matches a registered subcommand name or alias.
 *
 * Flags (`-…`) and `@file` arguments are never subcommands; for those the CLI
 * runner skips ahead to the default `launch` command.
 */
export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

export type ResolvedCliArgv = { argv: string[] } | { error: string };

/**
 * Index of the first argv token that names a registered subcommand, skipping
 * leading global option flags (and any value they consume) with the same
 * contract as the launch parser ({@link flagConsumesValue}). Returns -1 when
 * scanning hits a non-subcommand positional, an end-of-options `--`, or the end
 * of argv first.
 */
function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, route a recognized
 * subcommand (even behind leading global flags like `--approval-mode=yolo`) to
 * that command with the flags preserved, and forward everything else to
 * `launch` (#2970).
 */
export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(argv);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	// A subcommand can hide behind leading global option flags
	// (`omp --approval-mode=yolo acp`). `run` dispatches strictly on argv[0], so
	// hoist the subcommand to the front and keep the leading flags as its own
	// argv; the command's parser then applies them. Genuine launch prompts (no
	// trailing subcommand) are untouched.
	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		return { argv: [argv[subIndex], ...argv.slice(0, subIndex), ...argv.slice(subIndex + 1)] };
	}
	return { argv: ["launch", ...argv] };
}
