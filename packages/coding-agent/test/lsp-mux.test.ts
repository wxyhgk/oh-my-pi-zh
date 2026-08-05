import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MessageFramer } from "../src/jsonrpc/message-framing";
import {
	MUX_CONNECT_METHOD,
	MUX_PING_METHOD,
	MUX_RESTART_METHOD,
	type MuxConnectParams,
	type MuxConnectResult,
} from "../src/lsp/mux/protocol";
import { LspMuxServer } from "../src/lsp/mux/server";

interface RpcMessage {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

interface FakeState {
	initializeCount: number;
	processId: number | null;
	didOpen: Record<string, number>;
	didChange: Record<string, number[]>;
	didClose: string[];
	notifications: string[];
}

interface PublishDiagnosticsParams {
	uri: string;
	version?: number;
	diagnostics: Array<{ message: string; severity: number }>;
}

class MuxTestClient {
	readonly #socket: net.Socket;
	readonly #framer = new MessageFramer(Buffer.alloc(0));
	readonly #pending = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	readonly #notifications = new Map<string, RpcMessage[]>();
	readonly #notificationWaiters = new Map<string, Array<(message: RpcMessage) => void>>();
	#nextId = 1;
	#closed = false;

	constructor(socket: net.Socket) {
		this.#socket = socket;
		socket.on("data", (chunk: Buffer) => {
			this.#framer.push(chunk);
			for (const text of this.#framer.drain(() => {})) this.#receive(JSON.parse(text) as RpcMessage);
		});
		socket.on("error", error => this.#failPending(error));
		socket.on("close", () => {
			this.#closed = true;
			this.#failPending(new Error("Mux socket closed"));
		});
	}

	static async connect(endpoint: string): Promise<MuxTestClient> {
		const socket = net.createConnection(endpoint);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onConnect = (): void => {
			socket.off("error", onError);
			resolve();
		};
		const onError = (error: Error): void => {
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
		await promise;
		return new MuxTestClient(socket);
	}

	request<T>(method: string, params?: unknown, id: string | number = this.#nextId++): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#write({ jsonrpc: "2.0", id, method, params });
		return promise as Promise<T>;
	}

	notify(method: string, params?: unknown): void {
		this.#write({ jsonrpc: "2.0", method, params });
	}

	async nextNotification<T>(method: string): Promise<T> {
		const queued = this.#notifications.get(method);
		const message = queued?.shift();
		if (message) return message.params as T;
		const { promise, resolve } = Promise.withResolvers<RpcMessage>();
		const waiters = this.#notificationWaiters.get(method);
		if (waiters) waiters.push(resolve);
		else this.#notificationWaiters.set(method, [resolve]);
		return (await withTimeout(promise, `notification ${method}`)).params as T;
	}

	waitForClose(): Promise<void> {
		if (this.#closed || this.#socket.destroyed) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#socket.once("close", () => resolve());
		return withTimeout(promise, "socket close");
	}

	destroy(): void {
		this.#socket.destroy();
	}

	#write(message: RpcMessage): void {
		const json = JSON.stringify(message);
		this.#socket.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
	}

	#receive(message: RpcMessage): void {
		if (message.method !== undefined) {
			if (message.id !== undefined) {
				this.#write({ jsonrpc: "2.0", id: message.id, result: message.params });
				return;
			}
			const waiters = this.#notificationWaiters.get(message.method);
			const waiter = waiters?.shift();
			if (waiter) waiter(message);
			else {
				const queued = this.#notifications.get(message.method);
				if (queued) queued.push(message);
				else this.#notifications.set(message.method, [message]);
			}
			return;
		}
		if (message.id === undefined) return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
		else pending.resolve(message.result);
	}

	#failPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}

async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
	return Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for ${description}`);
		}),
	]);
}

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
const initializeParams = (processId = 424242): Record<string, unknown> => ({
	processId,
	rootUri: null,
	capabilities: {},
});

async function initialize(client: MuxTestClient, processId = 424242): Promise<Record<string, unknown>> {
	const result = await client.request<Record<string, unknown>>("initialize", initializeParams(processId));
	client.notify("initialized", {});
	return result;
}

async function state(client: MuxTestClient): Promise<FakeState> {
	return client.request<FakeState>("test/state");
}

async function pollUntil(check: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("LspMuxServer", () => {
	let server: LspMuxServer;
	let tmpDir: string;
	let socketPath: string;
	let connectParams: MuxConnectParams;
	const clients: MuxTestClient[] = [];

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-mux-test-"));
		socketPath = path.join(tmpDir, "mux.sock");
		connectParams = { command: process.execPath, args: ["run", fixturePath], cwd: tmpDir };
		server = new LspMuxServer();
		await server.listen(socketPath);
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy();
		await server.shutdown();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function link(): Promise<{ client: MuxTestClient; connected: MuxConnectResult }> {
		const client = await MuxTestClient.connect(socketPath);
		clients.push(client);
		const connected = await client.request<MuxConnectResult>(MUX_CONNECT_METHOD, connectParams);
		return { client, connected };
	}

	it.skipIf(process.platform === "win32")(
		"spawns one server and caches its initialize result across links",
		async () => {
			const first = await link();
			const second = await link();
			expect(first.connected.spawned).toBe(true);
			expect(second.connected.spawned).toBe(false);
			expect(second.connected.pid).toBe(first.connected.pid);

			const [firstInitialize, secondInitialize] = await Promise.all([
				initialize(first.client),
				initialize(second.client),
			]);
			expect(firstInitialize).toEqual(secondInitialize);
			const firstInfo = firstInitialize.serverInfo as { version: string };
			const secondInfo = secondInitialize.serverInfo as { version: string };
			expect(firstInfo.version).toBe(String(first.connected.pid));
			expect(secondInfo.version).toBe(firstInfo.version);
			expect((await state(first.client)).initializeCount).toBe(1);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"rewrites initialize processId to the mux process",
		async () => {
			const { client } = await link();
			await initialize(client, 424242);
			expect((await state(client)).processId).toBe(process.pid);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"isolates equal request ids between sessions",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const [one, two] = await Promise.all([
				first.client.request<{ owner: string }>("test/echo", { owner: "first" }, 7),
				second.client.request<{ owner: string }>("test/echo", { owner: "second" }, 7),
			]);
			expect(one).toEqual({ owner: "first" });
			expect(two).toEqual({ owner: "second" });
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"reference-counts opens and rewrites shared document versions",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const uri = "file:///shared.ts";
			first.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "first" },
			});
			await pollUntil(async () => (await state(first.client)).didOpen[uri] === 1, "first didOpen");

			second.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "second" },
			});
			await pollUntil(async () => {
				const snapshot = await state(first.client);
				return snapshot.didOpen[uri] === 1 && (snapshot.didChange[uri]?.some(version => version >= 2) ?? false);
			}, "second open converted to change");

			first.client.notify("textDocument/didClose", { textDocument: { uri } });
			await first.client.request("test/echo", { barrier: true });
			expect((await state(second.client)).didClose).not.toContain(uri);
			second.client.notify("textDocument/didClose", { textDocument: { uri } });
			await pollUntil(async () => (await state(second.client)).didClose.includes(uri), "final didClose");
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"broadcasts diagnostics and replays the cached publication to a new link",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const uri = "file:///diagnostics.ts";
			first.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "x" },
			});
			const [firstPublish, secondPublish] = await Promise.all([
				first.client.nextNotification<PublishDiagnosticsParams>("textDocument/publishDiagnostics"),
				second.client.nextNotification<PublishDiagnosticsParams>("textDocument/publishDiagnostics"),
			]);
			expect(firstPublish).toMatchObject({
				uri,
				version: 1,
				diagnostics: [{ message: "fake", severity: 2, range: expect.any(Object) }],
			});
			expect(secondPublish).toMatchObject({
				uri,
				diagnostics: [{ message: "fake", severity: 2, range: expect.any(Object) }],
			});

			const third = await link();
			await initialize(third.client);
			const replay = await third.client.nextNotification<PublishDiagnosticsParams>(
				"textDocument/publishDiagnostics",
			);
			expect(replay).toMatchObject({
				uri,
				diagnostics: [{ message: "fake", severity: 2, range: expect.any(Object) }],
			});
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"intercepts shutdown and exit for only the calling session",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			expect(await first.client.request<null>("shutdown")).toBeNull();
			const closed = first.client.waitForClose();
			first.client.notify("exit");
			await closed;
			expect(await second.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({ alive: true });
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"answers muxPing before a link is bound",
		async () => {
			const client = await MuxTestClient.connect(socketPath);
			clients.push(client);
			expect(await client.request<string>(MUX_PING_METHOD)).toBe("pong");
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"restarts a shared server and disconnects every attached session",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const firstClosed = first.client.waitForClose();
			const secondClosed = second.client.waitForClose();
			first.client.notify(MUX_RESTART_METHOD);
			await Promise.all([firstClosed, secondClosed]);

			const replacement = await link();
			expect(replacement.connected.spawned).toBe(true);
			expect(replacement.connected.pid).not.toBe(first.connected.pid);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"closes orphaned documents when a session drops abruptly",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const uri = "file:///orphan.ts";
			first.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "orphan" },
			});
			await pollUntil(async () => (await state(second.client)).didOpen[uri] === 1, "orphan didOpen");
			first.client.destroy();
			await pollUntil(async () => (await state(second.client)).didClose.includes(uri), "orphan didClose");
		},
		10_000,
	);
});
