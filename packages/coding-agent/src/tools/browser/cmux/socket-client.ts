import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "../../tool-errors";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const UTF8 = new TextEncoder();

type RequestJob = {
	method: string;
	params: Record<string, unknown>;
	timeoutMs: number;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: unknown) => void;
};

type LineWaiter = {
	resolve: (line: string) => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
};

type CmuxErrorPayload = {
	code?: unknown;
	message?: unknown;
	details?: unknown;
};

type RelayEndpoint = {
	host: string;
	port: number;
};

type RelayCredentials = {
	relayId: string;
	relayToken: Uint8Array<ArrayBuffer>;
};

function parseRelayCredentials(relayIdValue: unknown, relayTokenValue: unknown): RelayCredentials | null {
	if (typeof relayIdValue !== "string" || typeof relayTokenValue !== "string") {
		return null;
	}
	const relayId = relayIdValue.trim();
	const relayTokenHex = relayTokenValue.trim();
	if (
		relayId.length === 0 ||
		relayTokenHex.length === 0 ||
		relayTokenHex.length % 2 !== 0 ||
		!/^[0-9a-f]+$/i.test(relayTokenHex)
	) {
		return null;
	}
	const relayToken = new Uint8Array(new ArrayBuffer(relayTokenHex.length / 2));
	for (let index = 0; index < relayToken.length; index++) {
		relayToken[index] = Number.parseInt(relayTokenHex.slice(index * 2, index * 2 + 2), 16);
	}
	return { relayId, relayToken };
}

export function formatCmuxError(error: CmuxErrorPayload | undefined): string {
	const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "错误";
	const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : "cmux 错误";
	const details = error?.details === undefined ? "" : ` 详情=${JSON.stringify(error.details)}`;
	return `${code}: ${message}${details}`;
}

export class CmuxSocketClient {
	readonly #socketPath: string;
	readonly #password: string | undefined;
	readonly #relayId: string | undefined;
	readonly #relayToken: string | undefined;
	#socket: net.Socket | null = null;
	#connectPromise: Promise<void> | null = null;
	#connected = false;
	#disposed = false;
	#buffer = "";
	readonly #lineWaiters: LineWaiter[] = [];
	readonly #queue: RequestJob[] = [];
	#activeJob: RequestJob | null = null;
	#pumping = false;

	constructor(opts: { socketPath: string; password?: string; relayId?: string; relayToken?: string }) {
		this.#socketPath = opts.socketPath;
		this.#password = opts.password;
		this.#relayId = opts.relayId ?? process.env.CMUX_RELAY_ID;
		this.#relayToken = opts.relayToken ?? process.env.CMUX_RELAY_TOKEN;
	}

	async connect(): Promise<void> {
		if (this.#disposed) {
			throw new ToolError("cmux 套接字已关闭");
		}
		if (this.#connected && this.#socket && !this.#socket.destroyed) {
			return;
		}
		if (this.#connectPromise) {
			return await this.#connectPromise;
		}

		this.#connectPromise = this.#openSocket();
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = null;
		}
	}

	async request(
		method: string,
		params: Record<string, unknown>,
		opts?: { timeoutMs?: number },
	): Promise<Record<string, unknown>> {
		if (this.#disposed) {
			throw new ToolError("cmux 套接字已关闭");
		}
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#queue.push({
			method,
			params,
			timeoutMs: opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			resolve,
			reject,
		});
		this.#pump();
		return await promise;
	}

	close(): void {
		this.#disposed = true;
		const err = new ToolError("cmux 套接字已关闭");
		this.#rejectAll(err);
		this.#socket?.end();
		this.#socket?.destroy();
		this.#socket = null;
		this.#connected = false;
		this.#connectPromise = null;
	}

	async #openSocket(): Promise<void> {
		const relayEndpoint = this.#parseRelayEndpoint();
		const relayCredentials = relayEndpoint ? await this.#loadRelayCredentials(relayEndpoint) : null;
		const socket = relayEndpoint
			? net.createConnection({ host: relayEndpoint.host, port: relayEndpoint.port })
			: net.createConnection({ path: this.#socketPath });
		this.#socket = socket;
		this.#buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(String(chunk)));
		socket.on("error", err => this.#handleSocketFailure(err));
		socket.on("close", () => this.#handleSocketClose());

		try {
			await this.#waitForConnect(socket);
			if (relayEndpoint && relayCredentials) {
				await this.#authenticateRelay(relayEndpoint, relayCredentials);
			}
			if (this.#password) {
				const line = await this.#sendLine(`auth ${this.#password}`, DEFAULT_CONNECT_TIMEOUT_MS);
				if (line.startsWith("ERROR:") && !line.includes("Unknown command 'auth'")) {
					throw new ToolError(line);
				}
			}
			this.#connected = true;
		} catch (err) {
			this.#connected = false;
			socket.destroy();
			if (err instanceof ToolError) throw err;
			throw new ToolError(
				`无法连接到 ${this.#socketPath} 处的 cmux 套接字: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	#parseRelayEndpoint(): RelayEndpoint | null {
		const value = this.#socketPath.trim();
		if (value.length === 0 || value.startsWith("/")) {
			return null;
		}
		const match = /^(127\.0\.0\.1|localhost):([0-9]+)$/.exec(value);
		if (!match) {
			return null;
		}
		const port = Number.parseInt(match[2] ?? "", 10);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			return null;
		}
		return { host: "127.0.0.1", port };
	}

	async #loadRelayCredentials(endpoint: RelayEndpoint): Promise<RelayCredentials> {
		const environmentCredentials = parseRelayCredentials(this.#relayId, this.#relayToken);
		if (environmentCredentials) {
			return environmentCredentials;
		}

		const authPath = path.join(os.homedir(), ".cmux", "relay", `${endpoint.port}.auth`);
		let payload: unknown;
		try {
			payload = await Bun.file(authPath).json();
		} catch {
			throw new ToolError(
				`缺少 ${endpoint.host}:${endpoint.port} 的 cmux 中继认证元数据;请设置 CMUX_RELAY_ID/CMUX_RELAY_TOKEN,或恢复 ~/.cmux/relay/${endpoint.port}.auth`,
			);
		}
		const relayId = payload && typeof payload === "object" && "relay_id" in payload ? payload.relay_id : undefined;
		const relayToken =
			payload && typeof payload === "object" && "relay_token" in payload ? payload.relay_token : undefined;
		const fileCredentials = parseRelayCredentials(relayId, relayToken);
		if (!fileCredentials) {
			throw new ToolError(`~/.cmux/relay/${endpoint.port}.auth 中的 cmux 中继认证元数据无效`);
		}
		return fileCredentials;
	}

	async #authenticateRelay(endpoint: RelayEndpoint, credentials: RelayCredentials): Promise<void> {
		const challengeLine = await this.#nextLine(DEFAULT_CONNECT_TIMEOUT_MS);
		let challenge: unknown;
		try {
			challenge = JSON.parse(challengeLine);
		} catch {
			throw new ToolError(`来自 ${endpoint.host}:${endpoint.port} 的 cmux 中继认证质询无效`);
		}
		if (
			!challenge ||
			typeof challenge !== "object" ||
			!("protocol" in challenge) ||
			challenge.protocol !== "cmux-relay-auth" ||
			!("version" in challenge) ||
			typeof challenge.version !== "number" ||
			!Number.isInteger(challenge.version) ||
			!("relay_id" in challenge) ||
			challenge.relay_id !== credentials.relayId ||
			!("nonce" in challenge) ||
			typeof challenge.nonce !== "string" ||
			challenge.nonce.length === 0
		) {
			throw new ToolError(`来自 ${endpoint.host}:${endpoint.port} 的 cmux 中继认证质询无效`);
		}

		const message = `relay_id=${challenge.relay_id}\nnonce=${challenge.nonce}\nversion=${challenge.version}`;
		const key = await globalThis.crypto.subtle.importKey(
			"raw",
			credentials.relayToken,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = await globalThis.crypto.subtle.sign("HMAC", key, UTF8.encode(message));
		const authLine = JSON.stringify({
			relay_id: credentials.relayId,
			mac: Buffer.from(mac).toString("hex"),
		});
		const responseLine = await this.#sendLine(authLine, DEFAULT_CONNECT_TIMEOUT_MS);
		let response: unknown;
		try {
			response = JSON.parse(responseLine);
		} catch {
			throw new ToolError(`cmux 中继认证失败: ${endpoint.host}:${endpoint.port}`);
		}
		if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true) {
			throw new ToolError(`cmux 中继认证失败: ${endpoint.host}:${endpoint.port}`);
		}
	}

	#waitForConnect(socket: net.Socket): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new ToolError(`无法连接到 ${this.#socketPath} 处的 cmux 套接字: 连接超时`));
		}, DEFAULT_CONNECT_TIMEOUT_MS);
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		const onConnect = (): void => {
			cleanup();
			resolve();
		};
		const onError = (err: Error): void => {
			cleanup();
			reject(new ToolError(`无法连接到 ${this.#socketPath} 处的 cmux 套接字: ${err.message}`));
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
		return promise;
	}

	#pump(): void {
		if (this.#pumping) return;
		this.#pumping = true;
		void this.#pumpLoop();
	}

	async #pumpLoop(): Promise<void> {
		try {
			while (this.#queue.length > 0 && !this.#disposed) {
				const job = this.#queue.shift();
				if (!job) continue;
				this.#activeJob = job;
				try {
					await this.connect();
					const request = JSON.stringify({ id: randomUUID(), method: job.method, params: job.params });
					const line = await this.#sendLine(request, job.timeoutMs);
					job.resolve(this.#parseResponse(line));
				} catch (err) {
					job.reject(err instanceof Error ? err : new ToolError(String(err)));
				} finally {
					if (this.#activeJob === job) {
						this.#activeJob = null;
					}
				}
			}
		} finally {
			this.#pumping = false;
			if (this.#queue.length > 0 && !this.#disposed) {
				this.#pump();
			}
		}
	}

	#sendLine(line: string, timeoutMs: number): Promise<string> {
		if (!this.#socket || this.#socket.destroyed) {
			throw new ToolError("cmux 套接字未连接");
		}
		const read = this.#nextLine(timeoutMs);
		this.#socket.write(`${line}\n`, err => {
			if (err) {
				this.#handleSocketFailure(err);
			}
		});
		return read;
	}

	#nextLine(timeoutMs: number): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let waiter: LineWaiter;
		const timer = setTimeout(() => {
			const index = this.#lineWaiters.indexOf(waiter);
			if (index >= 0) {
				this.#lineWaiters.splice(index, 1);
			}
			reject(new ToolError("等待 cmux 套接字响应超时"));
			this.#destroySocketForDesync();
		}, timeoutMs);
		waiter = {
			resolve: line => {
				clearTimeout(timer);
				resolve(line);
			},
			reject: err => {
				clearTimeout(timer);
				reject(err);
			},
			timer,
		};
		this.#lineWaiters.push(waiter);
		this.#drainLines();
		return promise;
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		this.#drainLines();
	}

	#drainLines(): void {
		while (this.#lineWaiters.length > 0) {
			const newlineIndex = this.#buffer.indexOf("\n");
			if (newlineIndex < 0) return;
			let line = this.#buffer.slice(0, newlineIndex);
			this.#buffer = this.#buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			const waiter = this.#lineWaiters.shift();
			waiter?.resolve(line);
		}
	}

	#parseResponse(line: string): Record<string, unknown> {
		if (line.startsWith("ERROR:")) {
			throw new ToolError(line);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(line);
		} catch (err) {
			throw new ToolError(`cmux 套接字 JSON 响应无效: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!payload || typeof payload !== "object") {
			throw new ToolError("cmux 套接字响应无效:应为对象");
		}
		const response = payload as { ok?: unknown; result?: unknown; error?: CmuxErrorPayload };
		if (response.ok === true) {
			return (response.result ?? {}) as Record<string, unknown>;
		}
		if (response.ok === false) {
			throw new ToolError(formatCmuxError(response.error));
		}
		throw new ToolError("cmux 套接字响应无效:缺少 ok 标志");
	}

	#handleSocketFailure(err: Error): void {
		if (this.#disposed) return;
		this.#connected = false;
		this.#connectPromise = null;
		this.#rejectAll(new ToolError(`cmux 套接字错误: ${err.message}`));
		this.#socket?.destroy();
		this.#socket = null;
	}

	#handleSocketClose(): void {
		const hadPendingRead = this.#lineWaiters.length > 0;
		this.#connected = false;
		this.#connectPromise = null;
		this.#socket = null;
		if (!this.#disposed && hadPendingRead) {
			this.#rejectAll(new ToolError("cmux 套接字已关闭"));
		}
	}

	#destroySocketForDesync(): void {
		this.#connected = false;
		this.#connectPromise = null;
		this.#socket?.destroy();
		this.#socket = null;
	}

	#rejectAll(err: ToolError): void {
		for (const waiter of this.#lineWaiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(err);
		}
		if (this.#activeJob) {
			this.#activeJob.reject(err);
			this.#activeJob = null;
		}
		for (const job of this.#queue.splice(0)) {
			job.reject(err);
		}
	}
}
