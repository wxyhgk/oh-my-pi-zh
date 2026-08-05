/**
 * Get the API key or OAuth token for a provider.
 */

import { PROVIDER_REGISTRY } from "@wxyhgk/pi-ai";
import { Args, Command, Flags } from "@wxyhgk/pi-utils/cli";
import chalk from "chalk";
import { tokenHelp as commandHelp } from "../cli/command-help";
import { isAuthenticated, ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";
import { getAvailableAuthMethods } from "../web/search/providers/perplexity-auth";

export default class Token extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "提供商 ID（例如 anthropic、openai）",
			required: true,
		}),
	};

	static flags = {
		raw: Flags.boolean({
			description: "输出原始凭据值，不解析嵌套的 JSON 结构",
			default: false,
		}),
		"force-refresh": Flags.boolean({
			description: "即使 OAuth token 尚未过期也强制刷新",
			default: false,
		}),
		account: Flags.integer({
			char: "a",
			description: "按存储顺序选择第 N 个 OAuth 账户（从 1 开始），而不是默认的轮询方式",
		}),
		list: Flags.boolean({
			char: "l",
			description: "列出该提供商的 OAuth 账户（序号 + 身份）并退出",
			default: false,
		}),
	};

	static examples = [
		"# 获取 Anthropic 的 API 密钥\n  omp-zh token anthropic",
		"# 获取原始 Copilot 凭据 JSON\n  omp-zh token github-copilot --raw",
		"# 强制刷新并获取 Gemini CLI token\n  omp-zh token google-gemini-cli --force-refresh",
		"# 列出 Anthropic 的 OAuth 账户\n  omp-zh token anthropic --list",
		"# 获取第 2 个 Anthropic OAuth 账户的 token\n  omp-zh token anthropic --account 2",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Token);
		const providerName = args.provider ?? "";
		const provider = providerName.toLowerCase();

		const authStorage = await discoverAuthStorage();
		try {
			if (flags.list || flags.account !== undefined) {
				const accounts = authStorage.listOAuthAccounts(provider);
				if (accounts.length === 0) {
					process.stderr.write(`${chalk.red(`未找到提供商 "${providerName}" 的 OAuth 账户。`)}\n`);
					process.stderr.write("使用 --account/--list 可从 OAuth 账户中选择；该提供商未存储任何账户。\n");
					process.exitCode = 1;
					return;
				}
				if (flags.list) {
					for (const acct of accounts) {
						const base =
							acct.email ??
							acct.accountId ??
							acct.projectId ??
							acct.enterpriseUrl ??
							`凭据 #${acct.credentialId}`;
						const org = acct.orgName ?? acct.orgId;
						const label = org && org !== base ? `${base} (${org})` : base;
						process.stdout.write(`${acct.position + 1}. ${label}\n`);
					}
					return;
				}
				const n = flags.account;
				if (n === undefined || n < 1 || n > accounts.length) {
					process.stderr.write(
						`${chalk.red(`无效的 --account ${n ?? "（缺失）"}。`)} 提供商 "${providerName}" 有 ${accounts.length} 个 OAuth 账户（1-${accounts.length}）。\n`,
					);
					process.exitCode = 1;
					return;
				}
				const resolution = await authStorage.getOAuthAccessAt(provider, n - 1, {
					forceRefresh: flags["force-refresh"],
				});
				if (!resolution?.ok) {
					const reason = resolution && !resolution.ok ? resolution.error : "没有可用的 OAuth 凭据";
					process.stderr.write(`${chalk.red(`无法获取提供商 "${providerName}" 账户 ${n} 的 token：${reason}`)}\n`);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`${resolution.accessToken}\n`);
				return;
			}

			const modelRegistry = new ModelRegistry(authStorage);

			// Resolve the API key / token
			let apiKey: string | undefined;

			if (provider === "perplexity") {
				const methods = await getAvailableAuthMethods(authStorage, undefined, {
					forceRefresh: flags["force-refresh"],
				});
				const printable = methods.find(m => m.type === "oauth" || m.type === "api_key");
				if (printable) {
					apiKey = printable.type === "oauth" ? printable.access.accessToken : printable.apiKey;
				}
			}

			if (!apiKey) {
				apiKey = await modelRegistry.getApiKeyForProvider(provider, undefined, {
					forceRefresh: flags["force-refresh"],
				});
			}

			if (!isAuthenticated(apiKey)) {
				// Find all active/configured providers
				const activeProviders = new Set<string>();
				for (const p of PROVIDER_REGISTRY) {
					if (authStorage.hasAuth(p.id)) {
						activeProviders.add(p.id);
					}
				}
				const all = authStorage.getAll();
				for (const p in all) {
					if (authStorage.hasAuth(p)) {
						activeProviders.add(p);
					}
				}

				const msg = `未找到提供商 "${providerName}" 的活动凭据。`;
				process.stderr.write(`${chalk.red(msg)}\n`);
				if (activeProviders.size > 0) {
					process.stderr.write(`已配置的提供商：${Array.from(activeProviders).sort().join(", ")}\n`);
				}
				process.exitCode = 1;
				return;
			}

			if (!flags.raw) {
				try {
					const parsed = JSON.parse(apiKey);
					if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
						process.stdout.write(`${parsed.token}\n`);
						return;
					}
				} catch {
					// Not a JSON string, print as-is
				}
			}

			process.stdout.write(`${apiKey}\n`);
		} finally {
			authStorage.close();
		}
	}
}
