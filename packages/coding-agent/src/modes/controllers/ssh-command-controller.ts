/**
 * SSH Command Controller
 *
 * Handles /ssh subcommands for managing SSH host configurations.
 */
import { getProjectDir, getSSHConfigPath } from "@wxyhgk/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { type SSHHost, sshCapability } from "../../capability/ssh";
import { loadCapability } from "../../discovery";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import {
	groupBySource,
	parseRemoveArgs,
	readScopeFlag,
	type ScopeValue,
	showCommandMessage,
} from "./command-controller-shared";

export class SSHCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /ssh command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			default:
				this.ctx.showError(`未知子命令:${subcommand}。输入 /ssh help 查看用法。`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("SSH 主机管理"),
			"",
			"管理用于远程命令执行的 SSH 主机配置。",
			"",
			theme.fg("accent", "命令:"),
			"  /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			"  /ssh list             列出所有已配置的 SSH 主机",
			"  /ssh remove <name> [--scope project|user]    移除 SSH 主机(默认:project)",
			"  /ssh help             显示此帮助信息",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	/**
	 * Handle /ssh add - parse flags and add host to config
	 */
	async #handleAdd(text: string): Promise<void> {
		const prefixMatch = text.match(/^\/ssh\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			this.ctx.showError(
				"用法:/ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			);
			return;
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			this.ctx.showError(
				"用法:/ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			);
			return;
		}

		let name: string | undefined;
		let scope: ScopeValue = "project";
		let host: string | undefined;
		let username: string | undefined;
		let port: number | undefined;
		let keyPath: string | undefined;
		let description: string | undefined;
		let compat = false;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--host") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("--host 缺少值。");
					return;
				}
				host = value;
				i += 2;
				continue;
			}
			if (argToken === "--user") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("--user 缺少值。");
					return;
				}
				username = value;
				i += 2;
				continue;
			}
			if (argToken === "--port") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("--port 缺少值。");
					return;
				}
				const parsed = Number.parseInt(value, 10);
				if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
					this.ctx.showError("--port 值无效。必须是 1 到 65535 之间的整数。");
					return;
				}
				port = parsed;
				i += 2;
				continue;
			}
			if (argToken === "--key") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("--key 缺少值。");
					return;
				}
				keyPath = value;
				i += 2;
				continue;
			}
			if (argToken === "--desc") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("--desc 缺少值。");
					return;
				}
				description = value;
				i += 2;
				continue;
			}
			if (argToken === "--compat") {
				compat = true;
				i += 1;
				continue;
			}
			if (argToken === "--scope") {
				const r = readScopeFlag(tokens[i + 1]);
				if (!r.ok) {
					this.ctx.showError(r.error);
					return;
				}
				scope = r.scope;
				i += 2;
				continue;
			}
			this.ctx.showError(`未知选项:${argToken}`);
			return;
		}

		if (!name) {
			this.ctx.showError("必须提供主机名。用法:/ssh add <name> --host <host> ...");
			return;
		}

		if (!host) {
			this.ctx.showError("--host 为必填项。用法:/ssh add <name> --host <host> ...");
			return;
		}

		try {
			const cwd = getProjectDir();
			const filePath = getSSHConfigPath(scope, cwd);

			const hostConfig: SSHHostConfig = { host };
			if (username) hostConfig.username = username;
			if (port) hostConfig.port = port;
			if (keyPath) hostConfig.keyPath = keyPath;
			if (description) hostConfig.description = description;
			if (compat) hostConfig.compat = true;

			await addSSHHost(filePath, name, hostConfig);
			resetCapabilities();

			const scopeLabel = scope === "user" ? "用户" : "项目";
			const lines = [
				"",
				theme.fg("success", `+ 已将 SSH 主机 "${name}" 添加到${scopeLabel}配置`),
				"",
				`  Host: ${host}`,
			];
			if (username) lines.push(`  User: ${username}`);
			if (port) lines.push(`  Port: ${port}`);
			if (keyPath) lines.push(`  Key:  ${keyPath}`);
			if (description) lines.push(`  Desc: ${description}`);
			if (compat) lines.push(`  Compat: true`);
			lines.push("");
			lines.push(theme.fg("muted", `运行 ${theme.fg("accent", "/ssh list")} 查看所有已配置的主机。`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			let helpText = "";
			if (errorMsg.includes("already exists")) {
				helpText = `\n\n提示:先使用 ${theme.fg("accent", "/ssh remove")},或换一个名称。`;
			}

			this.ctx.showError(`添加主机失败:${errorMsg}${helpText}`);
		}
	}

	/**
	 * Handle /ssh list - show all configured SSH hosts
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();

			// Load from both user and project configs
			const userPath = getSSHConfigPath("user", cwd);
			const projectPath = getSSHConfigPath("project", cwd);

			const [userConfig, projectConfig] = await Promise.all([
				readSSHConfigFile(userPath),
				readSSHConfigFile(projectPath),
			]);

			const userHosts = Object.keys(userConfig.hosts ?? {});
			const projectHosts = Object.keys(projectConfig.hosts ?? {});

			// Load discovered hosts via capability system
			const configHostNames = new Set([...userHosts, ...projectHosts]);
			let discoveredHosts: SSHHost[] = [];
			try {
				const result = await loadCapability<SSHHost>(sshCapability.id, { cwd });
				discoveredHosts = result.items.filter(h => !configHostNames.has(h.name));
			} catch {
				// Ignore discovery errors
			}

			if (userHosts.length === 0 && projectHosts.length === 0 && discoveredHosts.length === 0) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "尚未配置 SSH 主机。"),
						"",
						`使用 ${theme.fg("accent", "/ssh add")} 添加主机。`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("已配置的 SSH 主机"), ""];

			// Show user-level hosts
			if (userHosts.length > 0) {
				lines.push(theme.fg("accent", "用户级") + theme.fg("muted", ` (~/.omp/agent/ssh.json):`));
				for (const name of userHosts) {
					const config = userConfig.hosts![name];
					const details = this.#formatHostDetails(config);
					lines.push(`  ${theme.fg("accent", name)} ${details}`);
				}
				lines.push("");
			}

			// Show project-level hosts
			if (projectHosts.length > 0) {
				lines.push(theme.fg("accent", "项目级") + theme.fg("muted", ` (.omp/ssh.json):`));
				for (const name of projectHosts) {
					const config = projectConfig.hosts![name];
					const details = this.#formatHostDetails(config);
					lines.push(`  ${theme.fg("accent", name)} ${details}`);
				}
				lines.push("");
			}

			// Show discovered hosts (from ssh.json, .ssh.json in project root, etc.)
			if (discoveredHosts.length > 0) {
				for (const { providerName, shortPath, items: hosts } of groupBySource(discoveredHosts, h => h._source)) {
					lines.push(
						theme.fg("accent", "发现") +
							theme.fg("muted", ` (${providerName}: ${shortPath}):`) +
							theme.fg("dim", " 只读"),
					);
					for (const host of hosts) {
						const details = this.#formatHostDetails({
							host: host.host,
							username: host.username,
							port: host.port,
						});
						lines.push(`  ${theme.fg("accent", host.name)} ${details}`);
					}
					lines.push("");
				}
			}

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`列出主机失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Format host details (host, user, port) for display
	 */
	#formatHostDetails(config: { host?: string; username?: string; port?: number }): string {
		const parts: string[] = [];
		if (config.host) parts.push(config.host);
		if (config.username) parts.push(`user=${config.username}`);
		if (config.port && config.port !== 22) parts.push(`port=${config.port}`);
		return theme.fg("dim", parts.length > 0 ? `[${parts.join(", ")}]` : "");
	}

	/**
	 * Handle /ssh remove <name> - remove a host from config
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/ssh\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const parsed = parseRemoveArgs(rest);
		if (!parsed.ok) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { name, scope } = parsed.value;
		if (!name) {
			this.ctx.showError("必须提供主机名。用法:/ssh remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = getProjectDir();
			const filePath = getSSHConfigPath(scope, cwd);
			const config = await readSSHConfigFile(filePath);
			if (!config.hosts?.[name]) {
				this.ctx.showError(`主机 "${name}" 未在 ${scope} 配置中找到。`);
				return;
			}

			await removeSSHHost(filePath, name);
			resetCapabilities();

			this.#showMessage(
				["", theme.fg("success", `- 已从 ${scope} 配置中移除 SSH 主机 "${name}"`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`移除主机失败:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}
