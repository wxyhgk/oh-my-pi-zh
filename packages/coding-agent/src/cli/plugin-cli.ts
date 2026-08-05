/**
 * Plugin CLI command handlers.
 *
 * Handles `omp plugin <command>` subcommands for plugin lifecycle management.
 */

import { APP_NAME, getProjectDir } from "@wxyhgk/pi-utils";
import chalk from "chalk";
import { resolveOrDefaultProjectRegistryPath } from "../discovery/helpers";
import { PluginManager, parseSettingValue, validateSetting } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace/index.js";
import { theme } from "../modes/theme/theme";

// =============================================================================
// Types
// =============================================================================

export type PluginAction =
	| "install"
	| "uninstall"
	| "list"
	| "link"
	| "doctor"
	| "features"
	| "config"
	| "enable"
	| "disable"
	| "marketplace"
	| "discover"
	| "upgrade";

export interface PluginCommandArgs {
	action: PluginAction;
	args: string[];
	flags: {
		json?: boolean;
		fix?: boolean;
		force?: boolean;
		dryRun?: boolean;
		local?: boolean;
		enable?: string;
		disable?: string;
		set?: string;
		scope?: "user" | "project";
	};
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

/**
 * Parse plugin subcommand arguments.
 * Returns undefined if not a plugin command.
 */
export function parsePluginArgs(args: string[]): PluginCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "plugin") {
		return undefined;
	}

	if (args.length < 2) {
		return { action: "list", args: [], flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as PluginAction)) {
		console.error(chalk.red(`未知的 plugin 命令:${action}`));
		console.error(`有效命令:${VALID_ACTIONS.join(", ")}`);
		process.exit(1);
	}

	const result: PluginCommandArgs = {
		action: action as PluginAction,
		args: [],
		flags: {},
	};

	// Parse remaining arguments
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (arg === "--fix") {
			result.flags.fix = true;
		} else if (arg === "--force") {
			result.flags.force = true;
		} else if (arg === "--dry-run") {
			result.flags.dryRun = true;
		} else if (arg === "-l" || arg === "--local") {
			result.flags.local = true;
		} else if (arg === "--enable" && i + 1 < args.length) {
			result.flags.enable = args[++i];
		} else if (arg === "--disable" && i + 1 < args.length) {
			result.flags.disable = args[++i];
		} else if (arg === "--set" && i + 1 < args.length) {
			result.flags.set = args[++i];
		} else if (arg === "--scope" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
			const s = args[++i];
			if (s === "user" || s === "project") {
				result.flags.scope = s;
			} else {
				console.error(chalk.red(`无效的 --scope 值:“${s}”。必须是 "user" 或 "project"。`));
				process.exit(1);
			}
		} else if (arg === "--scope") {
			// --scope with no value following
			console.error(chalk.red(`--scope 需要提供值:"user" 或 "project"。`));
			process.exit(1);
		} else if (!arg.startsWith("-")) {
			result.args.push(arg);
		}
	}

	return result;
}

import { classifyInstallTarget } from "./classify-install-target";

export { classifyInstallTarget } from "./classify-install-target";

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Run a plugin command.
 */
export async function runPluginCommand(cmd: PluginCommandArgs): Promise<void> {
	const manager = new PluginManager();

	switch (cmd.action) {
		case "install":
			await handleInstall(manager, cmd.args, cmd.flags);
			break;
		case "uninstall":
			await handleUninstall(manager, cmd.args, cmd.flags);
			break;
		case "list":
			await handleList(manager, cmd.flags);
			break;
		case "link":
			await handleLink(manager, cmd.args, cmd.flags);
			break;
		case "doctor":
			await handleDoctor(manager, cmd.flags);
			break;
		case "features":
			await handleFeatures(manager, cmd.args, cmd.flags);
			break;
		case "config":
			await handleConfig(manager, cmd.args, cmd.flags);
			break;
		case "enable":
			await handleEnable(manager, cmd.args, cmd.flags);
			break;
		case "disable":
			await handleDisable(manager, cmd.args, cmd.flags);
			break;
		case "marketplace":
			await handleMarketplace(cmd.args, cmd.flags);
			break;
		case "discover":
			await handleDiscover(cmd.args, cmd.flags);
			break;
		case "upgrade":
			await handleUpgrade(cmd.args, cmd.flags);
			break;
	}
}

// =============================================================================
// Marketplace Handlers
// =============================================================================

async function makeMarketplaceManager(): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(getProjectDir()),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
	});
}

async function handleMarketplace(args: string[], _flags: PluginCommandArgs["flags"]): Promise<void> {
	const subcommand = args[0] ?? "list";
	const manager = await makeMarketplaceManager();

	switch (subcommand) {
		case "add": {
			const source = args[1];
			if (!source) {
				console.error(chalk.red(`用法:${APP_NAME} plugin marketplace add <source>`));
				process.exit(1);
			}
			try {
				await manager.addMarketplace(source);
				console.log(chalk.green(`${theme.status.success} 已添加市场:${source}`));
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} 添加市场失败:${err}`));
				process.exit(1);
			}
			break;
		}
		case "remove":
		case "rm": {
			const name = args[1];
			if (!name) {
				console.error(chalk.red(`用法:${APP_NAME} plugin marketplace remove <name>`));
				process.exit(1);
			}
			try {
				await manager.removeMarketplace(name);
				console.log(chalk.green(`${theme.status.success} 已移除市场:${name}`));
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} 移除市场失败:${err}`));
				process.exit(1);
			}
			break;
		}
		case "update": {
			try {
				const name = args[1];
				if (name) {
					await manager.updateMarketplace(name);
					console.log(chalk.green(`${theme.status.success} 已更新市场:${name}`));
				} else {
					const results = await manager.updateAllMarketplaces();
					console.log(chalk.green(`${theme.status.success} 已更新 ${results.length} 个市场`));
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} 更新市场失败:${err}`));
				process.exit(1);
			}
			break;
		}
		default: {
			if (subcommand !== "list") {
				console.error(chalk.red(`未知的市场子命令:${subcommand}`));
				console.error(chalk.dim("有效子命令:add、remove、update、list"));
				process.exit(1);
			}
			try {
				const marketplaces = await manager.listMarketplaces();
				if (marketplaces.length === 0) {
					console.log(chalk.dim("未配置市场"));
					console.log(chalk.dim(`\n使用以下命令添加:${APP_NAME} plugin marketplace add <source>`));
					return;
				}
				console.log(chalk.bold("已配置的市场:\n"));
				for (const mp of marketplaces) {
					console.log(`  ${chalk.cyan(mp.name)}  ${chalk.dim(mp.sourceUri)}`);
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} 列出市场失败:${err}`));
				process.exit(1);
			}
			break;
		}
	}
}

async function handleDiscover(args: string[], _flags: PluginCommandArgs["flags"]): Promise<void> {
	const marketplace = args[0];
	const manager = await makeMarketplaceManager();
	try {
		const plugins = await manager.listAvailablePlugins(marketplace);

		if (plugins.length === 0) {
			console.log(chalk.dim(marketplace ? `在 ${marketplace} 中未找到插件` : "没有可用插件"));
			return;
		}

		console.log(chalk.bold(`可用插件${marketplace ? `(${marketplace})` : ""}:\n`));
		for (const plugin of plugins) {
			console.log(`  ${chalk.cyan(plugin.name)}${plugin.version ? `@${plugin.version}` : ""}`);
			if (plugin.description) {
				console.log(chalk.dim(`    ${plugin.description}`));
			}
		}
	} catch (err) {
		console.error(chalk.red(`${theme.status.error} 发现插件失败:${err}`));
		process.exit(1);
	}
}

async function handleUpgrade(args: string[], flags: PluginCommandArgs["flags"]): Promise<void> {
	const manager = await makeMarketplaceManager();
	const pluginId = args[0];
	try {
		if (pluginId) {
			if (flags.scope) {
				const result = await manager.upgradePlugin(pluginId, flags.scope);
				console.log(chalk.green(`已将 ${pluginId}(${flags.scope})升级到 ${result.version}`));
			} else {
				const entries = await manager.upgradePluginAcrossScopes(pluginId);
				for (const entry of entries) {
					console.log(chalk.green(`已将 ${pluginId}(${entry.scope})升级到 ${entry.version}`));
				}
			}
		} else {
			if (flags.scope) {
				console.error(
					chalk.yellow(
						`警告:升级所有插件时忽略 --scope。请使用 'omp-zh plugin upgrade <id> --scope ${flags.scope}' 指定特定的插件和作用域。`,
					),
				);
			}
			const results = await manager.upgradeAllPlugins();
			if (results.length === 0) {
				console.log("所有市场插件都已是最新版本。");
			} else {
				for (const r of results) {
					console.log(chalk.green(`  ${r.pluginId} (${r.scope}): ${r.from} -> ${r.to}`));
				}
			}
		}
	} catch (err) {
		console.error(chalk.red(`升级失败:${err}`));
		process.exit(1);
	}
}

async function handleInstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; force?: boolean; dryRun?: boolean; scope?: "user" | "project" },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(`用法:${APP_NAME} plugin install <source>[features] ...`));
		console.error(chalk.dim("示例:"));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @wxyhgk/exa`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install name@marketplace`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install github:user/repo`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install https://github.com/user/repo#v1.0`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install ./path/to/local/plugin`));
		process.exit(1);
	}

	// Build known marketplace set for classification
	const mktMgr = await makeMarketplaceManager();
	const knownMarketplaces = new Set((await mktMgr.listMarketplaces()).map(m => m.name));

	for (const spec of packages) {
		const target = classifyInstallTarget(spec, knownMarketplaces);

		if (target.type === "marketplace") {
			try {
				const entry = await mktMgr.installPlugin(target.name, target.marketplace, {
					force: flags.force,
					scope: flags.scope,
				});
				console.log(
					chalk.green(
						`${theme.status.success} 已从 ${target.marketplace} 安装 ${target.name}(${entry.version})`,
					),
				);
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} 安装 ${spec} 失败:${err}`));
				process.exit(1);
			}
			continue;
		}

		if (target.type === "local") {
			// Local paths route to link(): symlink the directory into the plugins
			// node_modules tree so source edits show up without a reinstall. Matches
			// `omp plugin link <path>` so users can use either verb interchangeably.
			if (flags.scope) {
				console.error(
					chalk.yellow(
						`警告:--scope 仅支持市场安装(name@marketplace)。已对 ${spec} 忽略。`,
					),
				);
			}
			if (flags.force) {
				console.error(
					chalk.yellow(
						`警告:--force 对本地路径安装无效(link 本身是幂等的)。已对 ${spec} 忽略。`,
					),
				);
			}
			if (flags.dryRun) {
				if (flags.json) {
					console.log(JSON.stringify({ dryRun: true, action: "link", path: target.path }, null, 2));
				} else {
					console.log(chalk.dim(`[演练] 将链接 ${spec}`));
				}
				continue;
			}
			try {
				const result = await manager.link(target.path);
				if (flags.json) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					console.log(chalk.green(`${theme.status.success} 已从 ${spec} 链接 ${result.name}`));
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} 安装 ${spec} 失败:${err}`));
				process.exit(1);
			}
			continue;
		}

		// --scope only applies to marketplace installs; warn when it would be silently no-op'd for npm.
		if (flags.scope) {
			console.error(
				chalk.yellow(
					`警告:--scope 仅支持市场安装(name@marketplace)。已对 ${spec} 忽略。`,
				),
			);
		}

		// npm path
		try {
			const result = await manager.install(spec, { force: flags.force, dryRun: flags.dryRun });

			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				if (flags.dryRun) {
					console.log(chalk.dim(`[演练] 将安装 ${spec}`));
				} else {
					console.log(chalk.green(`${theme.status.success} 已安装 ${result.name}@${result.version}`));
					if (result.enabledFeatures && result.enabledFeatures.length > 0) {
						console.log(chalk.dim(`  功能:${result.enabledFeatures.join(", ")}`));
					}
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			}
		} catch (err) {
			console.error(chalk.red(`${theme.status.error} 安装 ${spec} 失败:${err}`));
			process.exit(1);
		}
	}
}

async function handleUninstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(`用法:${APP_NAME} plugin uninstall <package> ...`));
		process.exit(1);
	}

	// For uninstall, check the installed plugins registry directly.
	// This works even if the marketplace entry was later removed from marketplaces.json.
	const mktMgr = await makeMarketplaceManager();
	const installedPlugins = new Set((await mktMgr.listInstalledPlugins()).map(p => p.id));

	for (const name of packages) {
		if (installedPlugins.has(name)) {
			// Exact match against installed marketplace plugin IDs (name@marketplace)
			try {
				await mktMgr.uninstallPlugin(name, flags.scope);
				console.log(chalk.green(`${theme.status.success} 已卸载 ${name}`));
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} 卸载 ${name} 失败:${err}`));
				process.exit(1);
			}
			continue;
		}

		// npm path
		try {
			await manager.uninstall(name);
			if (flags.json) {
				console.log(JSON.stringify({ uninstalled: name }));
			} else {
				console.log(chalk.green(`${theme.status.success} 已卸载 ${name}`));
			}
		} catch (err) {
			console.error(chalk.red(`${theme.status.error} 卸载 ${name} 失败:${err}`));
			process.exit(1);
		}
	}
}

async function handleList(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const npmPlugins = await manager.list();
	const mktMgr = await makeMarketplaceManager();
	const mktPlugins = await mktMgr.listInstalledPlugins();

	if (flags.json) {
		console.log(JSON.stringify({ npm: npmPlugins, marketplace: mktPlugins }, null, 2));
		return;
	}

	if (npmPlugins.length === 0 && mktPlugins.length === 0) {
		console.log(chalk.dim("未安装插件"));
		console.log(chalk.dim(`\n使用以下命令安装插件:${APP_NAME} plugin install <package>`));
		return;
	}

	if (npmPlugins.length > 0) {
		console.log(chalk.bold("npm 插件:\n"));
		for (const plugin of npmPlugins) {
			const status = plugin.enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
			const nameVersion = `${plugin.name}@${plugin.version}`;
			console.log(`${status} ${nameVersion}`);
			if (plugin.manifest.description) {
				console.log(chalk.dim(`  ${plugin.manifest.description}`));
			}
			if (plugin.enabledFeatures && plugin.enabledFeatures.length > 0) {
				console.log(chalk.dim(`  功能:${plugin.enabledFeatures.join(", ")}`));
			}
			if (plugin.manifest.features) {
				const availableFeatures = Object.keys(plugin.manifest.features);
				if (availableFeatures.length > 0) {
					const enabledSet = new Set(plugin.enabledFeatures ?? []);
					const featureDisplay = availableFeatures
						.map(f => (enabledSet.has(f) ? chalk.green(f) : chalk.dim(f)))
						.join(", ");
					console.log(chalk.dim(`  可用:[${featureDisplay}]`));
				}
			}
		}
	}

	if (mktPlugins.length > 0) {
		if (npmPlugins.length > 0) console.log();
		console.log(chalk.bold("市场插件:\n"));
		for (const plugin of mktPlugins) {
			const entry = plugin.entries[0];
			const version = entry?.version ?? "未知";
			const shadowLabel = plugin.shadowedBy ? chalk.dim(" [被遮蔽]") : "";
			const scopeLabel = chalk.dim(` (${plugin.scope})`);
			console.log(`  ${plugin.id} (${version})${scopeLabel}${shadowLabel}`);
		}
	}
}

async function handleLink(manager: PluginManager, paths: string[], flags: { json?: boolean }): Promise<void> {
	if (paths.length === 0) {
		console.error(chalk.red(`用法:${APP_NAME} plugin link <path>`));
		process.exit(1);
	}

	try {
		const result = await manager.link(paths[0]);

		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(chalk.green(`${theme.status.success} 已从 ${paths[0]} 链接 ${result.name}`));
		}
	} catch (err) {
		console.error(chalk.red(`${theme.status.error} 链接失败:${err}`));
		process.exit(1);
	}
}

async function handleDoctor(manager: PluginManager, flags: { json?: boolean; fix?: boolean }): Promise<void> {
	const checks = await manager.doctor({ fix: flags.fix });

	if (flags.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}

	console.log(chalk.bold("插件健康检查\n"));

	for (const check of checks) {
		const icon =
			check.status === "ok"
				? chalk.green(theme.status.success)
				: check.status === "warning"
					? chalk.yellow(theme.status.warning)
					: chalk.red(theme.status.error);
		console.log(`${icon} ${check.name}: ${check.message}`);
		if (check.fixed) {
			console.log(chalk.dim(`  ${theme.nav.cursor} 已修复`));
		}
	}

	const errors = checks.filter(c => c.status === "error" && !c.fixed).length;
	const warnings = checks.filter(c => c.status === "warning" && !c.fixed).length;
	const ok = checks.filter(c => c.status === "ok").length;
	const fixed = checks.filter(c => c.fixed).length;

	console.log("");
	console.log(`摘要:${ok} 正常,${warnings} 个警告,${errors} 个错误${fixed > 0 ? `,${fixed} 个已修复` : ""}`);

	if (errors > 0) {
		if (!flags.fix) {
			console.log(chalk.dim("\n使用 --fix 运行以尝试自动修复"));
		}
		process.exit(1);
	}
}

async function handleFeatures(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; enable?: string; disable?: string; set?: string },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(`用法:${APP_NAME} plugin features <plugin> [--enable f1,f2] [--disable f1] [--set f1,f2]`),
		);
		process.exit(1);
	}

	const pluginName = args[0];
	const plugins = await manager.list();
	const plugin = plugins.find(p => p.name === pluginName);

	if (!plugin) {
		console.error(chalk.red(`未找到插件“${pluginName}”`));
		process.exit(1);
	}

	// Handle modifications
	if (flags.enable || flags.disable || flags.set) {
		let currentFeatures = new Set((await manager.getEnabledFeatures(pluginName)) ?? []);

		if (flags.set) {
			// --set replaces all features
			currentFeatures = new Set(
				flags.set
					.split(",")
					.map(f => f.trim())
					.filter(Boolean),
			);
		} else {
			if (flags.enable) {
				for (const f of flags.enable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.add(f);
				}
			}
			if (flags.disable) {
				for (const f of flags.disable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.delete(f);
				}
			}
		}

		await manager.setEnabledFeatures(pluginName, [...currentFeatures]);
		console.log(chalk.green(`${theme.status.success} 已更新 ${pluginName} 的功能`));
	}

	// Display current state
	const updatedFeatures = await manager.getEnabledFeatures(pluginName);

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					plugin: pluginName,
					enabledFeatures: updatedFeatures,
					availableFeatures: plugin.manifest.features ? Object.keys(plugin.manifest.features) : [],
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`${pluginName} 的功能:\n`));

	if (!plugin.manifest.features || Object.keys(plugin.manifest.features).length === 0) {
		console.log(chalk.dim("  没有可用的可选功能"));
		return;
	}

	const enabledSet = new Set(updatedFeatures ?? []);
	for (const [name, feat] of Object.entries(plugin.manifest.features)) {
		const enabled = enabledSet.has(name);
		const icon = enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
		const defaultLabel = feat.default ? chalk.dim(" (默认)") : "";
		console.log(`${icon} ${name}${defaultLabel}`);
		if (feat.description) {
			console.log(chalk.dim(`    ${feat.description}`));
		}
	}
}

async function handleConfig(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; local?: boolean },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(`用法:${APP_NAME} plugin config <list|get|set|delete|validate> <plugin> [key] [value]`),
		);
		process.exit(1);
	}

	const [subcommand, pluginName, key, ...valueArgs] = args;

	// Special case: validate doesn't need a plugin name
	if (subcommand === "validate") {
		await handleConfigValidate(manager, flags);
		return;
	}

	if (!pluginName) {
		console.error(chalk.red("必须提供插件名"));
		process.exit(1);
	}

	const plugins = await manager.list();
	const plugin = plugins.find(p => p.name === pluginName);

	if (!plugin) {
		console.error(chalk.red(`未找到插件“${pluginName}”`));
		process.exit(1);
	}

	switch (subcommand) {
		case "list": {
			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings || {};

			if (flags.json) {
				console.log(JSON.stringify({ settings, schema }, null, 2));
				return;
			}

			console.log(chalk.bold(`${pluginName} 的设置:\n`));

			if (Object.keys(schema).length === 0) {
				console.log(chalk.dim("  未定义设置"));
				return;
			}

			for (const [k, s] of Object.entries(schema)) {
				const value = settings[k] ?? s.default;
				const displayValue = s.secret && value ? "********" : String(value ?? chalk.dim("(未设置)"));
				console.log(`  ${k}: ${displayValue}`);
				if (s.description) {
					console.log(chalk.dim(`    ${s.description}`));
				}
				if (s.env) {
					console.log(chalk.dim(`    env: ${s.env}`));
				}
			}
			break;
		}

		case "get": {
			if (!key) {
				console.error(chalk.red("必须提供键"));
				process.exit(1);
			}

			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings?.[key];
			const value = settings[key] ?? schema?.default;

			if (flags.json) {
				console.log(JSON.stringify({ [key]: value }));
			} else {
				const displayValue = schema?.secret && value ? "********" : String(value ?? "(未设置)");
				console.log(displayValue);
			}
			break;
		}

		case "set": {
			if (!key) {
				console.error(chalk.red("必须提供键"));
				process.exit(1);
			}

			const valueStr = valueArgs.join(" ");
			const schema = plugin.manifest.settings?.[key];

			// Parse value according to type
			let value: unknown = valueStr;
			if (schema) {
				value = parseSettingValue(valueStr, schema);

				// Validate
				const validation = validateSetting(value, schema);
				if (!validation.valid) {
					console.error(chalk.red(validation.error!));
					process.exit(1);
				}
			}

			await manager.setPluginSetting(pluginName, key, value);
			console.log(chalk.green(`${theme.status.success} 已设置 ${key}`));
			break;
		}

		case "delete": {
			if (!key) {
				console.error(chalk.red("必须提供键"));
				process.exit(1);
			}

			await manager.deletePluginSetting(pluginName, key);
			console.log(chalk.green(`${theme.status.success} 已删除 ${key}`));
			break;
		}

		default:
			console.error(chalk.red(`未知的 config 子命令:${subcommand}`));
			console.error(chalk.dim("有效子命令:list、get、set、delete、validate"));
			process.exit(1);
	}
}

async function handleConfigValidate(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const plugins = await manager.list();
	const results: Array<{ plugin: string; key: string; error: string }> = [];

	for (const plugin of plugins) {
		const settings = await manager.getPluginSettings(plugin.name);
		const schema = plugin.manifest.settings || {};

		for (const [key, s] of Object.entries(schema)) {
			const value = settings[key];
			if (value !== undefined) {
				const validation = validateSetting(value, s);
				if (!validation.valid) {
					results.push({ plugin: plugin.name, key, error: validation.error! });
				}
			}
		}
	}

	if (flags.json) {
		console.log(JSON.stringify({ valid: results.length === 0, errors: results }, null, 2));
		return;
	}

	if (results.length === 0) {
		console.log(chalk.green(`${theme.status.success} 所有设置均有效`));
	} else {
		for (const { plugin, key, error } of results) {
			console.log(chalk.red(`${theme.status.error} ${plugin}.${key}: ${error}`));
		}
		process.exit(1);
	}
}

async function handleEnable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, true);
}

async function handleDisable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, false);
}

async function handleSetEnabled(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
	enabled: boolean,
): Promise<void> {
	const action = enabled ? "enable" : "disable";
	const pastTense = enabled ? "已启用" : "已禁用";
	const actionZh = enabled ? "启用" : "禁用";
	const jsonKey = enabled ? "enabled" : "disabled";

	if (plugins.length === 0) {
		console.error(chalk.red(`用法:${APP_NAME} plugin ${action} <plugin> ...`));
		process.exit(1);
	}

	const mktMgr = await makeMarketplaceManager();
	const installedPlugins = new Set((await mktMgr.listInstalledPlugins()).map(p => p.id));

	for (const name of plugins) {
		if (installedPlugins.has(name)) {
			try {
				await mktMgr.setPluginEnabled(name, enabled, flags.scope);
				if (flags.json) {
					console.log(JSON.stringify({ [jsonKey]: name }));
				} else {
					console.log(chalk.green(`${theme.status.success} ${pastTense} ${name}`));
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} ${actionZh} ${name} 失败:${err}`));
				process.exit(1);
			}
			continue;
		}

		try {
			await manager.setEnabled(name, enabled);
			if (flags.json) {
				console.log(JSON.stringify({ [jsonKey]: name }));
			} else {
				console.log(chalk.green(`${theme.status.success} ${pastTense} ${name}`));
			}
		} catch (err) {
			console.error(chalk.red(`${theme.status.error} ${actionZh} ${name} 失败:${err}`));
			process.exit(1);
		}
	}
}

// =============================================================================
// Help
// =============================================================================

export function printPluginHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} plugin`)} - 插件生命周期管理

${chalk.bold("命令:")}
  install <source>[features]     从 npm、GitHub 或 git URL 安装插件
  uninstall <pkg>                移除插件
  list                           显示已安装的插件
  link <path>                    链接本地插件以进行开发
  doctor                         检查插件健康状态
  features <pkg>                 查看/修改已启用的功能
  config <cmd> <pkg> [key] [val] 管理插件设置
  enable <pkg>                   启用已禁用的插件
  disable <pkg>                  禁用插件但不卸载
  marketplace <cmd>              管理市场源(add、remove、update、list)
  discover [marketplace]         浏览可用的市场插件

${chalk.bold("功能语法:")}
  pkg                使用默认功能安装
  pkg[feat1,feat2]   使用特定功能安装
  pkg[*]             使用全部功能安装
  pkg[]              不安装任何可选功能

${chalk.bold("来源:")}
  pkg、pkg@1.2.3                    npm 包(可固定版本)
  github:user/repo[#ref]           GitHub 简写(也支持 gitlab:、bitbucket:、codeberg:、sourcehut:)
  https://github.com/user/repo     完整 git URL(https、ssh 或 git 协议)
  name@marketplace                 市场插件(参见 marketplace 命令)
  ./path、../path、/abs、~/path     本地插件目录(符号链接,与 plugin link 相同)

${chalk.bold("Config 子命令:")}
  config list <pkg>              列出所有设置
  config get <pkg> <key>         获取设置值
  config set <pkg> <key> <val>   设置设置值
  config delete <pkg> <key>      删除设置
  config validate                校验所有插件设置

${chalk.bold("选项:")}
  --json          以 JSON 输出
  --fix           尝试自动修复(doctor)
  --force         不提示直接覆盖(install)
  --scope <scope>  安装作用域:user(默认)或 project(安装 name@marketplace 时)
  --dry-run       预览更改而不应用(install)
  -l, --local     使用项目级本地覆盖

${chalk.bold("示例:")}
  ${APP_NAME} plugin install @wxyhgk/exa[search]
  ${APP_NAME} plugin list --json
  ${APP_NAME} plugin features my-plugin --enable search,web
  ${APP_NAME} plugin config set my-plugin apiKey sk-xxx
  ${APP_NAME} plugin doctor --fix
  ${APP_NAME} plugin install --scope project name@marketplace
  ${APP_NAME} plugin install github:user/repo#v1.0
`);
}
