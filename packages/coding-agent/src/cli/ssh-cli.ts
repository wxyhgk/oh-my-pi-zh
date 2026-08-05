/**
 * SSH CLI command handlers.
 *
 * Handles `omp ssh <command>` subcommands for SSH host configuration management.
 */

import { getSSHConfigPath } from "@wxyhgk/pi-utils";
import chalk from "chalk";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../ssh/config-writer";

// =============================================================================
// Types
// =============================================================================

export type SSHAction = "add" | "remove" | "list";

export interface SSHCommandArgs {
	action: SSHAction;
	args: string[];
	flags: {
		json?: boolean;
		host?: string;
		user?: string;
		port?: string;
		key?: string;
		desc?: string;
		compat?: boolean;
		scope?: "project" | "user";
	};
}

// =============================================================================
// Main dispatcher
// =============================================================================

export async function runSSHCommand(cmd: SSHCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "add":
			await handleAdd(cmd);
			break;
		case "remove":
			await handleRemove(cmd);
			break;
		case "list":
			await handleList(cmd);
			break;
		default:
			process.stdout.write(chalk.red(`未知操作:${cmd.action}\n`));
			process.stdout.write(`有效操作:add、remove、list\n`);
			process.exitCode = 1;
	}
}

// =============================================================================
// Handlers
// =============================================================================

async function handleAdd(cmd: SSHCommandArgs): Promise<void> {
	const name = cmd.args[0];
	if (!name) {
		process.stdout.write(chalk.red("错误:必须提供主机名\n"));
		process.stdout.write(
			chalk.dim("用法:omp-zh ssh add <name> --host <address> [--user <user>] [--port <port>] [--key <path>]\n"),
		);
		process.exitCode = 1;
		return;
	}

	const host = cmd.flags.host;
	if (!host) {
		process.stdout.write(chalk.red("错误:必须提供 --host\n"));
		process.stdout.write(chalk.dim("用法:omp-zh ssh add <name> --host <address>\n"));
		process.exitCode = 1;
		return;
	}

	// Validate port if provided
	if (cmd.flags.port !== undefined) {
		const port = Number.parseInt(cmd.flags.port, 10);
		if (Number.isNaN(port) || port < 1 || port > 65535) {
			process.stdout.write(chalk.red("错误:端口必须是 1 到 65535 之间的整数\n"));
			process.exitCode = 1;
			return;
		}
	}

	const hostConfig: SSHHostConfig = { host };
	if (cmd.flags.user) hostConfig.username = cmd.flags.user;
	if (cmd.flags.port) hostConfig.port = Number.parseInt(cmd.flags.port, 10);
	if (cmd.flags.key) hostConfig.keyPath = cmd.flags.key;
	if (cmd.flags.desc) hostConfig.description = cmd.flags.desc;
	if (cmd.flags.compat) hostConfig.compat = true;

	const scope = cmd.flags.scope ?? "project";
	const filePath = getSSHConfigPath(scope);

	try {
		await addSSHHost(filePath, name, hostConfig);
		process.stdout.write(chalk.green(`已将 SSH 主机“${name}”添加到 ${scope} 配置\n`));
	} catch (err) {
		process.stdout.write(chalk.red(`错误:${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	}
}

async function handleRemove(cmd: SSHCommandArgs): Promise<void> {
	const name = cmd.args[0];
	if (!name) {
		process.stdout.write(chalk.red("错误:必须提供主机名\n"));
		process.stdout.write(chalk.dim("用法:omp-zh ssh remove <name> [--scope project|user]\n"));
		process.exitCode = 1;
		return;
	}

	const scope = cmd.flags.scope ?? "project";
	const filePath = getSSHConfigPath(scope);

	try {
		await removeSSHHost(filePath, name);
		process.stdout.write(chalk.green(`已从 ${scope} 配置中移除 SSH 主机“${name}”\n`));
	} catch (err) {
		process.stdout.write(chalk.red(`错误:${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	}
}

async function handleList(cmd: SSHCommandArgs): Promise<void> {
	const projectPath = getSSHConfigPath("project");
	const userPath = getSSHConfigPath("user");

	const [projectConfig, userConfig] = await Promise.all([readSSHConfigFile(projectPath), readSSHConfigFile(userPath)]);

	const projectHosts = projectConfig.hosts ?? {};
	const userHosts = userConfig.hosts ?? {};

	if (cmd.flags.json) {
		process.stdout.write(JSON.stringify({ project: projectHosts, user: userHosts }, null, 2));
		process.stdout.write("\n");
		return;
	}

	const hasProject = Object.keys(projectHosts).length > 0;
	const hasUser = Object.keys(userHosts).length > 0;

	if (!hasProject && !hasUser) {
		process.stdout.write(chalk.dim("未配置 SSH 主机\n"));
		process.stdout.write(chalk.dim("使用以下命令添加:omp ssh add <name> --host <address>\n"));
		return;
	}

	if (hasProject) {
		process.stdout.write(chalk.bold("项目 SSH 主机(.omp/ssh.json):\n"));
		printHosts(projectHosts);
	}

	if (hasProject && hasUser) {
		process.stdout.write("\n");
	}

	if (hasUser) {
		process.stdout.write(chalk.bold("用户 SSH 主机(~/.omp/agent/ssh.json):\n"));
		printHosts(userHosts);
	}
}

// =============================================================================
// Helpers
// =============================================================================

function printHosts(hosts: Record<string, SSHHostConfig>): void {
	for (const [name, config] of Object.entries(hosts)) {
		const parts = [chalk.cyan(name), config.host];
		if (config.username) parts.push(chalk.dim(config.username));
		if (config.port && config.port !== 22) parts.push(chalk.dim(`端口:${config.port}`));
		if (config.keyPath) parts.push(chalk.dim(config.keyPath));
		if (config.description) parts.push(chalk.dim(`- ${config.description}`));
		process.stdout.write(`  ${parts.join("  ")}\n`);
	}
}
