/**
 * `omp auth-broker` command handlers.
 *
 * Sub-verbs:
 *   - `serve [--bind=…]` — boots the broker against the local SQLite store.
 *   - `token` / `token --regenerate` — manages the bearer token file.
 *   - `login <provider> [--via=user@host]` — logs into a provider locally, or
 *     via SSH tunnel into a remote broker host.
 *   - `import <file|dir>` — imports CLIProxyAPI-style JSON credentials into
 *     the local SQLite store (typical use: `import ~/.cliproxy/auth`).
 *   - `migrate --from-local [--include-env] [--include-oauth] [--dry-run]` —
 *     uploads local SQLite + env API keys to the broker, skipping anything
 *     the broker already has.
 *   - `status` — health-pings the configured remote broker.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
	type AuthCredential,
	AuthStorage,
	type CredentialDisabledEvent,
	getEnvApiKey,
	getOAuthProviders,
	listProvidersWithEnvKey,
	type OAuthCredential,
	type OAuthProvider,
	type OAuthProviderInfo,
	PASTE_CODE_LOGIN_PROVIDERS,
	PROVIDER_REGISTRY,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, DEFAULT_AUTH_BROKER_BIND, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { $which, APP_NAME, getAgentDbPath, getConfigRootDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import { setTransports as setLoggerTransports } from "@oh-my-pi/pi-utils/logger";
import { $ } from "bun";
import chalk from "chalk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";

export type AuthBrokerAction = "serve" | "token" | "login" | "logout" | "status" | "import" | "migrate" | "list";

export interface AuthBrokerCommandArgs {
	action: AuthBrokerAction;
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		via?: string;
		provider?: string;
		dryRun?: boolean;
		/** `login`/`logout`: provider id. `import`: filesystem path. */
		source?: string;
		/** `import`: keep credentials whose JSON had `disabled: true`. */
		includeDisabled?: boolean;
		/** `migrate`: also upload local OAuth (default: api_key only, since OAuth is via cliproxy import). */
		includeOauth?: boolean;
		/** `migrate`: also capture env-var API keys for providers not yet on broker. */
		includeEnv?: boolean;
		/** `migrate`: required `--from-local` source. Reserved for future sources. */
		fromLocal?: boolean;
	};
}

const ACTIONS: readonly AuthBrokerAction[] = [
	"serve",
	"token",
	"login",
	"logout",
	"import",
	"migrate",
	"status",
	"list",
];

/** Callback ports baked from the per-provider OAuth flow modules. */
const CALLBACK_PORTS: Record<string, number> = Object.fromEntries(
	PROVIDER_REGISTRY.flatMap(provider =>
		provider.callbackPort != null ? [[provider.id, provider.callbackPort] as [string, number]] : [],
	),
);

function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

async function readToken(): Promise<string | null> {
	try {
		const raw = await Bun.file(getTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function writeToken(token: string): Promise<void> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await Bun.write(file, token);
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

async function ensureToken(): Promise<string> {
	const existing = await readToken();
	if (existing) return existing;
	const token = generateToken();
	await writeToken(token);
	return token;
}

async function runServe(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	// The broker is a long-running headless service: route structured logs to
	// stdout so a process supervisor (pm2, journald, k8s) captures them, and
	// skip the rotating ~/.omp/logs/ file the TUI default would have used.
	setLoggerTransports({ console: true, file: false });

	const bind = flags.bind ?? DEFAULT_AUTH_BROKER_BIND;
	const token = await ensureToken();
	const dbPath = getAgentDbPath();
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const storage = new AuthStorage(store);
	await storage.reload();
	const handle = startAuthBroker({
		storage,
		bind,
		bearerTokens: [token],
		version: VERSION,
	});
	logger.info("auth-broker listening", { url: handle.url });
	logger.info("auth-broker bearer token loaded", { path: getTokenFilePath(), mode: "0600" });

	const credentialDisabledUnsub = storage.onCredentialDisabled((event: CredentialDisabledEvent) => {
		logger.warn("auth-broker credential disabled", { ...event });
	});

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		logger.info("auth-broker shutting down", { signal });
		credentialDisabledUnsub();
		await handle.close();
		storage.close();
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));

	// Block forever; lifecycle is signal-driven.
	await new Promise<never>(() => {});
}

async function runToken(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	if (flags.regenerate) {
		const next = generateToken();
		await writeToken(next);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ token: next, path: getTokenFilePath() })}\n`);
		} else {
			process.stdout.write(`${next}\n`);
		}
		return;
	}
	const token = await ensureToken();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ token, path: getTokenFilePath() })}\n`);
	} else {
		process.stdout.write(`${token}\n`);
	}
}

async function runLogin(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const providers = getOAuthProviders();
	let providerArg = flags.provider;
	if (!providerArg) {
		if (flags.via) {
			throw new Error(
				"用法:omp-zh auth-broker login <provider> --via=user@host(远程登录必须提供 provider)",
			);
		}
		providerArg = await pickProviderInteractively(providers);
	}
	if (!providers.some(p => p.id === providerArg)) {
		throw new Error(
			`未知的 OAuth 提供商 '${providerArg}'。已知:${providers
				.map(p => p.id)
				.sort()
				.join(", ")}`,
		);
	}
	if (flags.via) {
		await runRemoteLogin(providerArg, flags.via, flags.dryRun ?? false);
		return;
	}
	await runLocalLogin(providerArg as OAuthProvider);
}

async function runLocalLogin(provider: OAuthProvider): Promise<void> {
	// Drive the per-provider OAuth dance in-process. Persists into the same
	// SQLite store the broker uses.
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (msg: string) => promptLine(rl, `${msg} `);
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	const storage = new AuthStorage(store);
	await storage.reload();
	try {
		// Only paste-code providers (fixed non-loopback redirect, e.g. GitLab Duo
		// Agent's vscode:// URI) get the manual paste fallback. An explicit
		// `onManualCodeInput` is honored for ANY provider (the storage escape hatch),
		// so for loopback providers we must not pass it: it would make
		// `OAuthCallbackFlow` race a readline prompt against the HTTP callback and, if
		// the callback wins, leave that prompt outstanding (dirty/blocked terminal).
		// `AuthStorage.login` independently refuses to synthesize the default prompt
		// for non-paste-code providers, so this is defense-in-depth on the same gate.
		const usesManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider);
		await storage.login(provider, {
			onAuth({ url, launchUrl, instructions }) {
				process.stdout.write("\n在浏览器中打开此 URL:\n");
				// Full URL first so the CLI works from any machine, including SSH
				// sessions where a `launchUrl` (loopback `/launch` on the OMP
				// host) would resolve against the caller's browser and fail.
				// Headless capture is unaffected: it reads the first URL line.
				process.stdout.write(`${url}\n`);
				if (launchUrl && launchUrl !== url) {
					// Local shortcut for the machine running OMP. Terminals or
					// screen-scrapers narrower than the full URL still get an
					// unbroken copy target here.
					process.stdout.write(`本地快捷方式(仅限本机):${launchUrl}\n`);
				}
				if (instructions) process.stdout.write(`${instructions}\n`);
				process.stdout.write("\n");
			},
			onProgress(message) {
				process.stdout.write(`${message}\n`);
			},
			onPrompt(p) {
				return ask(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
			...(usesManualInput
				? {
						onManualCodeInput() {
							return ask("粘贴授权码(或完整的重定向 URL):");
						},
					}
				: undefined),
		});
		process.stdout.write(`\n凭据已保存到 ${getAgentDbPath()}\n`);
	} finally {
		store.close();
		rl.close();
	}
}

/**
 * Interactive `readline` prompt that cleanly tears down on Ctrl-C / Escape so
 * cancelling a half-finished login flow doesn't leave the terminal in raw mode.
 */
function promptLine(rl: readline.Interface, question: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin as NodeJS.ReadStream;
	const supportsRawMode = input.isTTY && typeof input.setRawMode === "function";
	const wasRaw = supportsRawMode ? input.isRaw : false;
	let settled = false;

	const cleanup = () => {
		rl.off("SIGINT", onSigint);
		if (supportsRawMode) {
			input.off("keypress", onKeypress);
			input.setRawMode?.(wasRaw);
		}
	};

	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};

	const cancel = () => {
		finish(() => reject(new Error("登录已取消")));
	};

	const onSigint = () => {
		cancel();
	};

	const onKeypress = (_str: string, key: readline.Key) => {
		if (key.name === "escape" || (key.ctrl && key.name === "c")) {
			cancel();
			rl.close();
		}
	};

	if (supportsRawMode) {
		readline.emitKeypressEvents(input, rl);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
	}

	rl.once("SIGINT", onSigint);
	rl.question(question, answer => {
		finish(() => resolve(answer));
	});
	return promise;
}

async function pickProviderInteractively(providers: readonly OAuthProviderInfo[]): Promise<string> {
	if (providers.length === 0) {
		throw new Error("未注册任何 OAuth 提供商");
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write("选择一个提供商:\n\n");
		for (let i = 0; i < providers.length; i++) {
			process.stdout.write(`  ${i + 1}. ${providers[i].name}\n`);
		}
		process.stdout.write("\n");
		const choice = await promptLine(rl, `输入编号(1-${providers.length}): `);
		const index = Number.parseInt(choice, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= providers.length) {
			throw new Error(`无效的选择:${choice}`);
		}
		return providers[index].id;
	} finally {
		rl.close();
	}
}

async function runRemoteLogin(provider: string, via: string, dryRun: boolean): Promise<void> {
	const port = CALLBACK_PORTS[provider];
	if (port === undefined) {
		throw new Error(
			`提供商 '${provider}' 没有已知的 OAuth 回调端口。请直接在 broker 主机上使用设备码流程。`,
		);
	}
	const sshArgs = [
		"-L",
		`${port}:127.0.0.1:${port}`,
		"-o",
		"ExitOnForwardFailure=yes",
		via,
		`${APP_NAME} auth-broker login ${provider}`,
	];
	if (dryRun) {
		process.stdout.write(`ssh ${sshArgs.map(a => (a.includes(" ") ? `'${a}'` : a)).join(" ")}\n`);
		return;
	}
	const sshBin = $which("ssh");
	if (!sshBin) {
		throw new Error("在 PATH 中未找到 ssh 二进制文件");
	}
	const proc = Bun.spawn({
		cmd: [sshBin, ...sshArgs],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`ssh 退出,代码 ${exitCode}`);
	}
}

async function runLogout(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	let providerArg = flags.provider;
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		if (!providerArg) {
			const stored = store.listProviders();
			if (stored.length === 0) {
				process.stdout.write("未存储任何凭据。\n");
				return;
			}
			providerArg = await pickStoredProviderInteractively(stored);
		}
		store.deleteAuthCredentialsForProvider(providerArg, "logged out by user");
		process.stdout.write(`已退出登录 ${providerArg}\n`);
	} finally {
		store.close();
	}
}

async function pickStoredProviderInteractively(providers: string[]): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write("选择要退出登录的提供商:\n\n");
		for (let i = 0; i < providers.length; i++) {
			process.stdout.write(`  ${i + 1}. ${providers[i]}\n`);
		}
		process.stdout.write("\n");
		const choice = await promptLine(rl, `输入编号(1-${providers.length}): `);
		const index = Number.parseInt(choice, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= providers.length) {
			throw new Error(`无效的选择:${choice}`);
		}
		return providers[index];
	} finally {
		rl.close();
	}
}

async function runList(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const providers = getOAuthProviders();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(providers.map(p => ({ id: p.id, name: p.name })))}\n`);
		return;
	}
	process.stdout.write("可用提供商:\n\n");
	for (const p of providers) {
		process.stdout.write(`  ${p.id.padEnd(20)} ${p.name}\n`);
	}
}

// ─── CLIProxyAPI import ─────────────────────────────────────────────────

/**
 * Maps the `type` field of a CLIProxyAPI credential JSON to the omp provider id.
 * The filename also encodes the type (e.g. `claude-foo@bar.json`), but the
 * in-file `type` is authoritative — we only fall back to filename if absent.
 */
const CLIPROXY_TYPE_TO_PROVIDER: Record<string, string> = {
	claude: "anthropic",
	codex: "openai-codex",
	gemini: "google-gemini-cli",
	antigravity: "google-antigravity",
	"gemini-cli": "google-gemini-cli",
};

interface CliProxyCredentialJson {
	type?: string;
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expired?: string;
	last_refresh?: string;
	email?: string;
	account_id?: string;
	disabled?: boolean;
}

interface ImportPlanEntry {
	sourceFile: string;
	provider: string;
	email: string | null;
	accountId: string | null;
	expiresAt: number;
	disabled: boolean;
	credential: OAuthCredential;
}

function resolveCliProxyProvider(json: CliProxyCredentialJson, filename: string, overrideId?: string): string | null {
	if (overrideId && overrideId.length > 0) return overrideId;
	const typeField = json.type?.trim().toLowerCase();
	if (typeField && CLIPROXY_TYPE_TO_PROVIDER[typeField]) return CLIPROXY_TYPE_TO_PROVIDER[typeField];
	// Fall back to filename prefix: `<type>-<email>.json`
	const base = path.basename(filename, ".json").toLowerCase();
	for (const prefix in CLIPROXY_TYPE_TO_PROVIDER) {
		const providerId = CLIPROXY_TYPE_TO_PROVIDER[prefix];
		if (base.startsWith(`${prefix}-`) || base === prefix) return providerId;
	}
	return null;
}

function parseCliProxyExpiry(raw: string | undefined): number | null {
	if (!raw) return null;
	// CLIProxyAPI writes RFC3339-ish dates. `Date.parse` handles both `Z` and offsets.
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms)) return null;
	return ms;
}

async function collectImportSources(target: string): Promise<string[]> {
	const stat = await fs.stat(target);
	if (stat.isFile()) return [target];
	if (!stat.isDirectory()) {
		throw new Error(`导入源既不是文件也不是目录:${target}`);
	}
	const entries = await fs.readdir(target, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		files.push(path.join(target, entry.name));
	}
	files.sort();
	return files;
}

async function loadImportPlan(
	target: string,
	overrideProvider: string | undefined,
	includeDisabled: boolean,
): Promise<{ entries: ImportPlanEntry[]; skipped: Array<{ file: string; reason: string }> }> {
	const files = await collectImportSources(target);
	const entries: ImportPlanEntry[] = [];
	const skipped: Array<{ file: string; reason: string }> = [];
	for (const file of files) {
		let json: CliProxyCredentialJson;
		try {
			json = (await Bun.file(file).json()) as CliProxyCredentialJson;
		} catch (err) {
			skipped.push({ file, reason: `JSON 不可读:${String(err)}` });
			continue;
		}
		if (json.disabled === true && !includeDisabled) {
			skipped.push({ file, reason: "凭据标记为已禁用(使用 --include-disabled 仍可导入)" });
			continue;
		}
		const provider = resolveCliProxyProvider(json, file, overrideProvider);
		if (!provider) {
			skipped.push({
				file,
				reason: `无法从 type=${json.type ?? "?"} 确定 omp 提供商(请传入 --provider 覆盖)`,
			});
			continue;
		}
		if (!json.access_token || !json.refresh_token) {
			skipped.push({ file, reason: "缺少 access_token 或 refresh_token" });
			continue;
		}
		const expiresAt = parseCliProxyExpiry(json.expired);
		if (expiresAt === null) {
			skipped.push({ file, reason: `无法解析 expired=${json.expired ?? "?"}` });
			continue;
		}
		const email = typeof json.email === "string" && json.email.length > 0 ? json.email : null;
		const accountId = typeof json.account_id === "string" && json.account_id.length > 0 ? json.account_id : null;
		const credential: OAuthCredential = {
			type: "oauth",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: expiresAt,
			...(email !== null ? { email } : {}),
			...(accountId !== null ? { accountId } : {}),
		};
		entries.push({
			sourceFile: file,
			provider,
			email,
			accountId,
			expiresAt,
			disabled: json.disabled === true,
			credential,
		});
	}
	return { entries, skipped };
}

function describeImportEntry(entry: ImportPlanEntry): string {
	const ident = entry.email ?? entry.accountId ?? "(无身份)";
	const stale = entry.expiresAt < Date.now() ? " [已过期]" : "";
	const disabled = entry.disabled ? " [已禁用]" : "";
	return `${entry.provider}: ${ident}${stale}${disabled} from ${entry.sourceFile}`;
}

async function runImport(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const target = flags.source;
	if (!target) {
		throw new Error("用法:omp-zh auth-broker import <file|dir> [--provider=<id>] [--include-disabled] [--dry-run]");
	}
	const resolvedTarget = path.resolve(target.startsWith("~") ? target.replace(/^~/, os.homedir()) : target);
	const { entries, skipped } = await loadImportPlan(resolvedTarget, flags.provider, flags.includeDisabled === true);

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				imported: flags.dryRun
					? []
					: entries.map(e => ({ provider: e.provider, email: e.email, file: e.sourceFile })),
				plan: entries.map(e => ({
					provider: e.provider,
					email: e.email,
					accountId: e.accountId,
					expiresAt: e.expiresAt,
					disabled: e.disabled,
					file: e.sourceFile,
				})),
				skipped,
			})}\n`,
		);
	}

	if (!flags.json) {
		for (const skip of skipped) {
			process.stdout.write(`${chalk.yellow("跳过")} ${skip.file}: ${skip.reason}\n`);
		}
	}

	if (entries.length === 0) {
		if (!flags.json) process.stdout.write(`在 ${resolvedTarget} 中没有可导入的凭据。\n`);
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`演练——将导入 ${entries.length} 个凭据:\n`);
			for (const entry of entries) process.stdout.write(`  ${describeImportEntry(entry)}\n`);
		}
		return;
	}

	const brokerConfig = await resolveAuthBrokerConfig();
	if (brokerConfig) {
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		for (const entry of entries) {
			try {
				await client.uploadCredential(entry.provider, entry.credential);
				if (!flags.json) {
					process.stdout.write(`${chalk.green("已上传")} ${describeImportEntry(entry)} → ${brokerConfig.url}\n`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (flags.json) {
					process.stdout.write(`${JSON.stringify({ error: message, file: entry.sourceFile })}\n`);
				} else {
					process.stdout.write(`${chalk.red("失败")} ${describeImportEntry(entry)}:${message}\n`);
				}
				process.exitCode = 1;
			}
		}
		return;
	}

	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		for (const entry of entries) {
			store.upsertAuthCredentialForProvider(entry.provider, entry.credential);
			if (!flags.json) process.stdout.write(`${chalk.green("已导入")} ${describeImportEntry(entry)}\n`);
		}
	} finally {
		store.close();
	}
}

// ─── Migrate: local SQLite + env → broker ──────────────────────────────

interface MigratePlanEntry {
	source: "local-sqlite" | "env";
	provider: string;
	credential: AuthCredential;
	identity: string;
}

interface MigrateSkip {
	source: "local-sqlite" | "env";
	provider: string;
	identity: string;
	reason: string;
}

function credentialIdentity(provider: string, credential: AuthCredential): string {
	if (credential.type === "api_key") return "(API 密钥)";
	const base = credential.email ?? credential.accountId ?? credential.projectId ?? `<${provider} OAuth>`;
	return credential.orgId ? `${base} (${credential.orgName ?? credential.orgId})` : base;
}

/**
 * Build the set of "identities already on the broker" so re-runs are idempotent.
 * For OAuth, identity = email|accountId|projectId, each org-qualified when the
 * row carries an organization (one Anthropic email can hold a Team seat AND a
 * personal Max plan — those must migrate as two rows). A row with NO base
 * identity but an orgId (login recovered neither email nor account) is marked
 * by the org alone, so re-running migrate does not re-upload a stale refresh
 * token over the broker's newer one. For api_key, we collapse to a single
 * marker per provider (broker has no concept of "multiple api keys per
 * provider with different identities"; upsert would coalesce them).
 */
function indexBrokerSnapshot(snapshot: {
	credentials: Array<{
		provider: string;
		credential: { type: string; email?: string; accountId?: string; projectId?: string; orgId?: string };
	}>;
}): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const entry of snapshot.credentials) {
		const ids = out.get(entry.provider) ?? new Set<string>();
		if (entry.credential.type === "api_key") {
			ids.add("@api_key");
		} else {
			const orgSuffix = entry.credential.orgId ? `|org:${entry.credential.orgId}` : "";
			if (entry.credential.email) ids.add(`email:${entry.credential.email}${orgSuffix}`);
			if (entry.credential.accountId) ids.add(`accountId:${entry.credential.accountId}${orgSuffix}`);
			if (entry.credential.projectId) ids.add(`projectId:${entry.credential.projectId}${orgSuffix}`);
			if (
				!entry.credential.email &&
				!entry.credential.accountId &&
				!entry.credential.projectId &&
				entry.credential.orgId
			) {
				ids.add(`org:${entry.credential.orgId}`);
			}
		}
		out.set(entry.provider, ids);
	}
	return out;
}

function brokerAlreadyHas(existing: Map<string, Set<string>>, provider: string, credential: AuthCredential): boolean {
	const ids = existing.get(provider);
	if (!ids) return false;
	if (credential.type === "api_key") return ids.has("@api_key");
	const orgSuffix = credential.orgId ? `|org:${credential.orgId}` : "";
	if (credential.email && ids.has(`email:${credential.email}${orgSuffix}`)) return true;
	if (credential.accountId && ids.has(`accountId:${credential.accountId}${orgSuffix}`)) return true;
	if (credential.projectId && ids.has(`projectId:${credential.projectId}${orgSuffix}`)) return true;
	if (!credential.email && !credential.accountId && !credential.projectId && credential.orgId) {
		return ids.has(`org:${credential.orgId}`);
	}
	return false;
}

async function runMigrate(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"必须设置 OMP_AUTH_BROKER_URL(或 config.yml 中的 `auth.broker.url`)。`migrate` 会将本地凭据上传到已配置的 broker。",
		);
	}
	if (flags.fromLocal !== true) {
		throw new Error(
			"`omp-zh auth-broker migrate` 需要显式指定来源。传入 `--from-local` 可从本地 SQLite 存储和环境变量迁移。",
		);
	}

	const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
	const snapshotResult = await client.fetchSnapshot();
	if (snapshotResult.status !== 200) throw new Error("Auth broker 未返回快照");
	const existing = indexBrokerSnapshot(snapshotResult.snapshot);

	const plan: MigratePlanEntry[] = [];
	const skipped: MigrateSkip[] = [];

	// 1. Local SQLite rows.
	const localDbPath = getAgentDbPath();
	const localStore = await SqliteAuthCredentialStore.open(localDbPath);
	const plannedApiKeyProviders = new Set<string>();
	try {
		for (const row of localStore.listAuthCredentials()) {
			// Skip placeholder sentinels that pi-ai treats as "authenticated via
			// out-of-band mechanism" (Bedrock/Vertex `<authenticated>`). They
			// aren't real keys and uploading them would store garbage on the
			// broker. Mirrors the env-var path's guard below.
			if (row.credential.type === "api_key" && row.credential.key === "<authenticated>") {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity: "(API 密钥)",
					reason: "占位哨兵 '<authenticated>' 不是真实的密钥",
				});
				continue;
			}
			const identity = credentialIdentity(row.provider, row.credential);
			if (row.credential.type === "oauth" && flags.includeOauth !== true) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "默认跳过本地 SQLite 中的 OAuth(使用 --include-oauth)",
				});
				continue;
			}
			if (brokerAlreadyHas(existing, row.provider, row.credential)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "已在 broker 上",
				});
				continue;
			}
			if (row.credential.type === "api_key" && plannedApiKeyProviders.has(row.provider)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "该提供商已计划了另一个本地 api_key",
				});
				continue;
			}
			if (row.credential.type === "api_key") plannedApiKeyProviders.add(row.provider);
			plan.push({ source: "local-sqlite", provider: row.provider, credential: row.credential, identity });
		}
	} finally {
		localStore.close();
	}

	// 2. Env-var API keys (opt-in).
	if (flags.includeEnv === true) {
		for (const provider of listProvidersWithEnvKey()) {
			const envValue = getEnvApiKey(provider);
			if (!envValue) continue;
			if (envValue === "<authenticated>") continue; // Bedrock/Vertex sentinels — not literal keys.
			const credential: AuthCredential = { type: "api_key", key: envValue };
			if (brokerAlreadyHas(existing, provider, credential)) {
				skipped.push({
					source: "env",
					provider,
					identity: "(API 密钥)",
					reason: "已在 broker 上(该提供商已有 api_key)",
				});
				continue;
			}
			// Also skip if local SQLite already produced an entry for this provider in this batch.
			if (plan.some(p => p.provider === provider && p.credential.type === "api_key")) {
				skipped.push({
					source: "env",
					provider,
					identity: "(API 密钥)",
					reason: "本地 SQLite 已为该提供商提供了 api_key",
				});
				continue;
			}
			plan.push({ source: "env", provider, credential, identity: "(API 密钥)" });
		}
	}

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				plan: plan.map(p => ({ source: p.source, provider: p.provider, identity: p.identity })),
				skipped,
			})}\n`,
		);
	} else {
		for (const skip of skipped) {
			process.stdout.write(
				`${chalk.yellow("跳过")} [${skip.source}] ${skip.provider} ${skip.identity}:${skip.reason}\n`,
			);
		}
	}

	if (plan.length === 0) {
		if (!flags.json) process.stdout.write("没有可迁移的内容。\n");
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`演练——将上传 ${plan.length} 个凭据:\n`);
			for (const entry of plan) {
				process.stdout.write(`  [${entry.source}] ${entry.provider} ${entry.identity}\n`);
			}
		}
		return;
	}

	for (const entry of plan) {
		try {
			await client.uploadCredential(entry.provider, entry.credential);
			if (!flags.json) {
				process.stdout.write(`${chalk.green("已上传")} [${entry.source}] ${entry.provider} ${entry.identity}\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ error: message, provider: entry.provider })}\n`);
			} else {
				process.stdout.write(`${chalk.red("失败")} [${entry.source}] ${entry.provider}:${message}\n`);
			}
			process.exitCode = 1;
		}
	}
}

async function runStatus(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const cfg = await resolveAuthBrokerConfig();
	if (!cfg) {
		const message = "未配置 auth-broker(设置 OMP_AUTH_BROKER_URL 以启用)。";
		if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: "not_configured" })}\n`);
		else process.stdout.write(`${chalk.yellow(message)}\n`);
		return;
	}
	const client = new AuthBrokerClient({ url: cfg.url, token: cfg.token });
	try {
		const health = await client.healthz();
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ url: cfg.url, ...health })}\n`);
		} else {
			process.stdout.write(`${chalk.green("正常")} ${cfg.url} (version=${health.version ?? "未知"})\n`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, url: cfg.url, error: message })}\n`);
		} else {
			process.stdout.write(`${chalk.red("失败")} ${cfg.url}:${message}\n`);
		}
		process.exitCode = 1;
	}
}

export async function runAuthBrokerCommand(cmd: AuthBrokerCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "login":
			await runLogin(cmd.flags);
			return;
		case "logout":
			await runLogout(cmd.flags);
			return;
		case "import":
			await runImport(cmd.flags);
			return;
		case "migrate":
			await runMigrate(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "list":
			await runList(cmd.flags);
			return;
		default: {
			// Exhaustive check.
			const _exhaustive: never = cmd.action;
			throw new Error(`未知的 auth-broker 操作:${String(_exhaustive)}`);
		}
	}
}

export { ACTIONS as AUTH_BROKER_ACTIONS };

// Touch `$` so Bun's tree-shaker keeps the shell helper imported (used by future verbs).
void $;
