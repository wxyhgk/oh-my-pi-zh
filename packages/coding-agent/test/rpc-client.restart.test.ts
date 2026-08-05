import { describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("RpcClient lifecycle (issue #4079 B)", () => {
	test("auto-negotiates protocol v2 and reassembles an oversized response", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1" },
		});

		await client.start();
		const state = (await client.getState()) as unknown as { payload: string };
		expect(state.payload).toBe("😀".repeat(400_000));
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 },
		]);
	}, 20_000);

	test("normalizes state fields omitted by a legacy RPC server", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LEGACY_STATE: "1" },
		});

		await client.start();
		const state = await client.getState();
		expect(state.fastModeEnabled).toBe(false);
		expect(state.fastModeActive).toBe(false);
		expect(state.tokensPerSecond).toBeNull();
	}, 20_000);

	test("normalizes a runtime-invalid tokensPerSecond from the RPC server", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_INVALID_TPS: "1" },
		});

		await client.start();
		const state = await client.getState();
		expect(state.tokensPerSecond).toBeNull();
	}, 20_000);

	test("preserves getMessages snapshot behavior while a v2 page walk is unavailable", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_PAGE_BUSY: "1" },
		});

		await client.start();
		await expect(client.getMessagesPage()).rejects.toThrow("Cannot page messages while the session is changing");
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("discards partial pages and falls back to get_messages when a cursor goes stale mid-walk", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_PAGE_STALE: "1" },
		});

		await client.start();
		// Direct page walks stay strict: the stale cursor is surfaced to the caller.
		const firstPage = await client.getMessagesPage();
		expect(firstPage.nextCursor).toBe("second-page");
		await expect(client.getMessagesPage({ cursor: firstPage.nextCursor })).rejects.toThrow(
			"RPC message cursor is stale",
		);
		// The high-level drain discards the partial first page and takes the legacy snapshot.
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("start() succeeds a second time after stop() on the same instance", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
		});

		// First lifecycle: start + stop.
		await client.start();
		await client.stop();

		// Second start on the same instance must NOT reuse the aborted
		// controller from the previous stop(). Before the fix, this rejected
		// with "Agent process exited before ready" because the JSONL reader
		// short-circuited on the pre-aborted signal.
		await client.start();
		await client.stop();
	}, 20000);

	test("start() waits for a signal-ignoring worker to be reaped after stop()", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-stop-restart-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
		});

		await client.start();
		const firstPid = Number(await Bun.file(pidFile).text());

		const stopped = client.stop();
		const restarted = client.start();
		await Promise.all([stopped, restarted]);

		const secondPid = Number(await Bun.file(pidFile).text());
		expect(secondPid).not.toBe(firstPid);
		expect(isProcessAlive(firstPid)).toBe(false);
		await client.stop();
	}, 20_000);

	test("start() may be retried after a failed start (child is cleaned up on failure)", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);

		// Before the fix, #process stayed set after the failed spawn so the
		// second start() rejected with "Client already started". Post-fix,
		// state is cleared and the second attempt fails with the same
		// legitimate startup error.
		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	}, 30000);

	test("stop() rejects active requests instead of leaving them to time out", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_IGNORE_COMMANDS: "1" },
		});
		await client.start();

		const pending = client.getState();
		client.stop();

		await expect(pending).rejects.toThrow("Client stopped");
	});

	test("rejects pending requests and reaps the worker when stdout parsing fails", async () => {
		// This awaits the real child-process grace-to-hard-kill path; fake timers
		// cannot drive OS signal delivery or process reaping.
		using tempDir = TempDir.createSync("@omp-rpc-reader-failure-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_INVALID_OUTPUT: "1",
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
		});

		let pid = 0;
		try {
			await client.start();
			pid = Number(await Bun.file(pidFile).text());

			await expect(client.getState()).rejects.toThrow(/Agent output reader failed/);
			await expect(client.getState()).rejects.toThrow("Client not started");
			expect(isProcessAlive(pid)).toBe(false);
		} finally {
			if (pid > 0 && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 10_000);

	test("rejects pending requests and reaps a worker that closes stdout without exiting", async () => {
		let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let resolveExit: ((exitCode: number) => void) | undefined;
		let killCalls = 0;
		const exited = new Promise<number>(resolve => {
			resolveExit = resolve;
		});
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				stdoutController = controller;
				controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
			},
		});
		const fakeChild = {
			stdout,
			stdin: {
				write() {
					stdoutController?.close();
					stdoutController = undefined;
					return 0;
				},
				flush() {
					return 0;
				},
			},
			exited,
			peekStderr() {
				return "";
			},
			kill() {
				killCalls += 1;
				resolveExit?.(0);
			},
		};
		const spawn = spyOn(ptree, "spawn").mockImplementation(
			() => fakeChild as unknown as ReturnType<typeof ptree.spawn>,
		);

		try {
			using client = new RpcClient({ cliPath: MOCK_AGENT });
			await client.start();

			await expect(client.getState()).rejects.toThrow("Agent output stream ended unexpectedly");
			await expect(client.getState()).rejects.toThrow("Client not started");
			expect(killCalls).toBe(1);
		} finally {
			spawn.mockRestore();
		}
	}, 5_000);

	test("reports exit code and stderr when a ready worker exits", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_EXIT_ON_COMMAND: "23",
				MOCK_RPC_EXIT_STDERR: "fixture worker failed",
			},
		});
		await client.start();

		await expect(client.getState()).rejects.toThrow(
			"Agent process exited with code 23. Stderr: fixture worker failed",
		);
	});
});
