import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { registerDaemonProjectPresence } from "../../src/launch/presence";
import type {
	DaemonCompletionNotification,
	DaemonOperation,
	DaemonSnapshot,
	DaemonSpec,
} from "../../src/launch/protocol";

const cleanupDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

// Cross-process integration: fake timers cannot advance a detached broker or OS process table.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// A last-client shutdown may already have closed the broker.
	}
	client.close();
}

async function publishCompletionOwner(
	projectDir: string,
	runtimeDir: string,
	owner: string,
	subscriptionId: string,
	completionAcks: string[] = [],
): Promise<void> {
	const socket = net.createConnection(daemonBrokerEndpoint(projectDir, runtimeDir));
	const connected = Promise.withResolvers<void>();
	const responded = Promise.withResolvers<void>();
	let buffer = "";
	socket.setEncoding("utf8");
	socket.once("connect", connected.resolve);
	socket.once("error", responded.reject);
	socket.on("data", chunk => {
		buffer += chunk;
		if (buffer.includes("\n")) responded.resolve();
	});
	await connected.promise;
	socket.write(
		`${JSON.stringify({
			id: crypto.randomUUID(),
			token: (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim(),
			owners: [owner],
			completionEvents: true,
			completionAcks,
			completionSubscriptionId: subscriptionId,
			operation: { op: "ping" },
		})}\n`,
	);
	await responded.promise;
	socket.destroy();
}

async function startPtyDaemonWithShell(shell: string, initialMarker: string, expectedMarker: string): Promise<void> {
	const projectDir = await tempDir("omp-daemon-shell-project-");
	const runtimeDir = await tempDir("omp-daemon-shell-runtime-");
	const runner = `
		import { createDaemonBrokerClient } from "./src/launch/client";

		const projectDir = ${JSON.stringify(projectDir)};
		const runtimeDir = ${JSON.stringify(runtimeDir)};
		const expectedMarker = ${JSON.stringify(expectedMarker)};
		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 5_000,
		});
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "shell",
					application: process.execPath,
					args: [
						"-e",
						"process.stdout.write(process.env.OMP_TEST_SHELL_MARKER); process.stdout.write(String.fromCharCode(10)); process.stdin.resume();",
					],
					env: {},
					cwd: projectDir,
					pty: true,
					ready: { log: expectedMarker, timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
				owner: "shell-test",
			});
			if (started.op !== "start") throw new Error("unexpected start response");
			if (started.daemon.state !== "ready") {
				const logs = await client.request({
					op: "logs",
					name: "shell",
					lines: 20,
					head: false,
					follow: false,
					timeoutMs: 1_000,
				});
				throw new Error(
					"daemon did not become ready: " +
						(started.daemon.exitReason ?? "unknown error") +
						"; logs: " +
						(logs.op === "logs" ? logs.text : "unavailable"),
				);
			}
			process.stdout.write(JSON.stringify({ state: started.daemon.state, readyTimedOut: started.readyTimedOut }));
			await client.request({ op: "stop", name: "shell", timeoutMs: 2_000 });
		} finally {
			try {
				await client.request({ op: "shutdown" });
			} catch {
				// A last-client shutdown may already have closed the broker.
			}
			client.close();
		}
	`;
	const child = Bun.spawn([process.execPath, "--eval", runner], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env: {
			...process.env,
			SHELL: shell,
			OMP_TEST_SHELL_MARKER: initialMarker,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(stdout)).toEqual({ state: "ready", readyTimedOut: false });
}

afterEach(async () => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("daemon broker", () => {
	it("shares PTY output and input across project clients", async () => {
		const projectDir = await tempDir("omp-daemon-project-");
		const runtimeDir = await tempDir("omp-daemon-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("\\x1b[2J\\x1b[H");
for (let index = 0; index < 25; index++) process.stdout.write("BOOT:" + index + "\\n");
process.stdout.write("\\x1b[1;32mREADY\\x1b[0m\\n");
process.stdin.on("data", chunk => process.stdout.write("INPUT:" + JSON.stringify(chunk) + "\\n"));
setInterval(() => {}, 1000);
`,
		);
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const spec: DaemonSpec = {
				name: "debugger",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: true,
				ready: { log: "READY", timeoutMs: 5_000 },
				restart: "no",
				persist: false,
				detached: false,
			};
			const started = await first.request({ op: "start", spec, owner: "first-client" });
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeFalse();
			expect(started.daemon.state).toBe("ready");

			const listed = await second.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op !== "list") throw new Error("unexpected list result");
			expect(listed.daemons.map(daemon => daemon.name)).toEqual(["debugger"]);

			await second.request({ op: "send", name: "debugger", data: "run\r" });
			const waited = await first.request({
				op: "wait",
				name: "debugger",
				for: "exit",
				pattern: "INPUT",
				timeoutMs: 3_000,
			});
			expect(waited.op).toBe("wait");
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.timedOut).toBeFalse();
			expect(waited.matched).toBe("INPUT");

			const logs = await second.request({
				op: "logs",
				name: "debugger",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
				renderTerminalRows: true,
			} as DaemonOperation);
			expect(logs.op).toBe("logs");
			if (logs.op !== "logs") throw new Error("unexpected logs result");
			expect(logs.text).toContain("READY");
			expect(logs.text).not.toContain("\x1b");
			expect(logs.text).not.toContain("BOOT:0");
			expect(logs.text).toContain('INPUT:"run\\r"');
			const expectedTerminalRows = [
				...Array.from({ length: 18 }, (_, index) => `\x1b[0mBOOT:${index + 7}`),
				"\x1b[0m\x1b[1;38;5;2mREADY",
				'\x1b[0mINPUT:"run\\r"',
			];
			expect(logs.terminalRows).toEqual(expectedTerminalRows);

			const legacyLogs = await second.request({
				op: "logs",
				name: "debugger",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			if (legacyLogs.op !== "logs") throw new Error("unexpected legacy logs result");
			expect("terminalText" in legacyLogs ? legacyLogs.terminalText : undefined).toContain("BOOT:0");
			expect(legacyLogs.terminalRows).toBeUndefined();

			const grepped = await second.request({
				op: "logs",
				name: "debugger",
				lines: 20,
				head: false,
				grep: "READY",
				follow: false,
				timeoutMs: 1_000,
			});
			if (grepped.op !== "logs") throw new Error("unexpected grep logs result");
			expect(grepped.text).toContain("READY");
			expect(grepped.terminalRows).toBeUndefined();

			const stopped = await first.request({ op: "stop", name: "debugger", timeoutMs: 2_000 });
			expect(stopped.op).toBe("stop");
			if (stopped.op !== "stop") throw new Error("unexpected stop result");
			expect(stopped.daemon.state).toBe("exited");
		} finally {
			await shutdown(first);
			second.close();
		}
	}, 20_000);

	it("omits terminal rows for non-PTY logs", async () => {
		const projectDir = await tempDir("omp-daemon-plain-project-");
		const runtimeDir = await tempDir("omp-daemon-plain-runtime-");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "plain",
					application: process.execPath,
					args: ["-e", 'process.stdout.write("\\x1b[31mPLAIN\\x1b[0m\\n"); process.stdin.resume();'],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: { log: "PLAIN", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeFalse();

			const logs = await client.request({
				op: "logs",
				name: "plain",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			if (logs.op !== "logs") throw new Error("unexpected logs result");
			expect(logs.text).toBe("PLAIN\n");
			expect(logs.terminalRows).toBeUndefined();

			await client.request({ op: "stop", name: "plain", timeoutMs: 2_000 });
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("uses a basic shell when the login shell cannot run POSIX commands", async () => {
		if (process.platform === "win32") return;
		const shellPath = path.join(await tempDir("omp-daemon-nonposix-shell-"), "csh");
		await Bun.write(shellPath, "#!/bin/sh\nexit 1\n");
		await fs.chmod(shellPath, 0o755);

		await startPtyDaemonWithShell(shellPath, "basic-shell", "basic-shell");
	}, 20_000);

	it("preserves compatible login shells for PTY daemons", async () => {
		if (process.platform === "win32") return;
		const shellPath = path.join(await tempDir("omp-daemon-posix-shell-"), "zsh");
		await Bun.write(shellPath, '#!/bin/sh\nexport OMP_TEST_SHELL_MARKER="compatible-shell"\nexec /bin/sh "$@"\n');
		await fs.chmod(shellPath, 0o755);

		await startPtyDaemonWithShell(shellPath, "basic-shell", "compatible-shell");
	}, 20_000);

	it("returns promptly when a finite PTY child does not write the broker PID file", async () => {
		if (process.platform === "win32") return;
		const shellPath = path.join(await tempDir("omp-daemon-no-pid-shell-"), "zsh");
		await Bun.write(
			shellPath,
			`#!/bin/sh
case "$2" in
	*process.pid*)
		command=\${2#*; exec }
		exec /bin/sh -c "exec $command"
		;;
	*)
		exec /bin/sh "$@"
		;;
esac
`,
		);
		await fs.chmod(shellPath, 0o755);
		const projectDir = await tempDir("omp-daemon-finite-project-");
		const runtimeDir = await tempDir("omp-daemon-finite-runtime-");
		const runner = `
			import { createDaemonBrokerClient } from "./src/launch/client";

			const client = await createDaemonBrokerClient(${JSON.stringify(projectDir)}, {
				runtimeDir: ${JSON.stringify(runtimeDir)},
				idleGraceMs: 5_000,
			});
			try {
				const startedAt = performance.now();
				const started = await client.request({
					op: "start",
					spec: {
						name: "finite-pty",
						application: "/bin/sh",
						args: ["-c", "sleep 5"],
						env: {},
						cwd: ${JSON.stringify(projectDir)},
						pty: true,
						restart: "no",
						persist: false,
						detached: false,
					},
				});
				if (started.op !== "start") throw new Error("unexpected start response");
				process.stdout.write(JSON.stringify({
					elapsedMs: Math.round(performance.now() - startedAt),
					state: started.daemon.state,
					pid: started.daemon.pid,
				}));
				if (started.daemon.state === "running") {
					await client.request({ op: "stop", name: "finite-pty", timeoutMs: 2_000 });
				}
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {}
				client.close();
			}
		`;
		const child = Bun.spawn([process.execPath, "--eval", runner], {
			cwd: path.resolve(import.meta.dir, "../.."),
			env: { ...process.env, SHELL: shellPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const started = JSON.parse(stdout) as { elapsedMs: number; state: string; pid?: number };
		// This is cross-process startup latency; fake timers cannot drive the broker or PTY child.
		expect(started.elapsedMs).toBeLessThan(3_000);
		expect(started.state).toBe("running");
		expect(started.pid).toBeGreaterThan(0);
	}, 20_000);

	it("stops non-persistent daemons after the last project omp exits", async () => {
		const projectDir = await tempDir("omp-daemon-exit-project-");
		const runtimeDir = await tempDir("omp-daemon-exit-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, `process.stdout.write("READY\\n"); setInterval(() => {}, 1000);\n`);
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
		let pid: number | undefined;
		try {
			const started = await first.request({
				op: "start",
				spec: {
					name: "server",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: { log: "READY", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("daemon did not start");
			const daemonPid = started.daemon.pid;
			pid = daemonPid;
			await second.request({ op: "list" });

			first.close();
			second.close();
			// Cross-process integration: the real broker grace clock cannot be advanced with test fake timers.
			await Bun.sleep(500);
			expect(processExists(daemonPid)).toBeTrue();

			await presence.close();
			const stopped = await waitUntil(() => !processExists(daemonPid), 5_000);
			const socketRemoved = await waitUntil(
				() =>
					Bun.file(path.join(runtimeDir, "broker.sock"))
						.exists()
						.then(exists => !exists),
				5_000,
			);
			expect(stopped).toBeTrue();
			expect(socketRemoved).toBeTrue();
		} finally {
			first.close();
			second.close();
			await presence.close();
			if (pid !== undefined && processExists(pid)) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
				await shutdown(rescue);
			}
		}
	}, 20_000);

	it("keeps detached daemons alive through broker replacement", async () => {
		const projectDir = await tempDir("omp-daemon-detached-project-");
		const runtimeDir = await tempDir("omp-daemon-detached-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, `process.stdout.write("READY\\n"); setInterval(() => {}, 1000);\n`);
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		let recovered: DaemonBrokerClient | undefined;
		let pid: number | undefined;
		try {
			const started = await first.request({
				op: "start",
				spec: {
					name: "detached",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: { log: "READY", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: true,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined)
				throw new Error("detached daemon did not start");
			pid = started.daemon.pid;
			expect(started.daemon.persist).toBeTrue();
			expect(started.daemon.detached).toBeTrue();

			await first.request({ op: "shutdown" });
			first.close();
			// Broker shutdown happens in another process, so fake timers cannot observe its lease release.
			const brokerStopped = await waitUntil(
				() =>
					Bun.file(path.join(runtimeDir, "broker.pid"))
						.exists()
						.then(exists => !exists),
				5_000,
			);
			expect(brokerStopped).toBeTrue();
			expect(processExists(pid)).toBeTrue();

			recovered = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const described = await recovered.request({ op: "describe", name: "detached" });
			if (described.op !== "describe") throw new Error("detached daemon did not recover");
			expect(described.daemon.pid).toBe(pid);
			expect(described.daemon.detached).toBeTrue();
			expect(described.spec.persist).toBeTrue();

			const stopped = await recovered.request({ op: "stop", name: "detached", timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error("detached daemon did not stop");
			expect(stopped.daemon.state).toBe("exited");
			await shutdown(recovered);
			recovered = undefined;
		} finally {
			first.close();
			recovered?.close();
			if (pid !== undefined && processExists(pid)) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
				try {
					await rescue.request({ op: "stop", name: "detached", timeoutMs: 2_000 });
				} finally {
					await shutdown(rescue);
				}
			}
		}
	}, 20_000);

	it("reports a recovered detached daemon exit without a polling RPC", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-recovered-exit-project-");
		const runtimeDir = await tempDir("omp-daemon-recovered-exit-runtime-");
		const owner = "recovered-detached-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		let pid: number | undefined;
		let completion: DaemonSnapshot | undefined;
		const unregister = first.onCompletion(owner, notification => {
			completion = notification.daemon;
		});
		try {
			const started = await first.request({
				op: "start",
				spec: {
					name: "recovered-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 1.5; exit 7"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: true,
				},
				owner,
			});
			if (started.op !== "start" || started.daemon.pid === undefined)
				throw new Error("detached daemon did not start");
			pid = started.daemon.pid;
			await first.request({ op: "shutdown" });
			expect(
				await waitUntil(
					() =>
						Bun.file(path.join(runtimeDir, "broker.pid"))
							.exists()
							.then(exists => !exists),
					5_000,
				),
			).toBeTrue();
			const launchedPid = pid;
			expect(processExists(launchedPid)).toBeTrue();

			expect(await waitUntil(() => completion !== undefined, 5_000)).toBeTrue();
			expect(completion).toMatchObject({ name: "recovered-exit", state: "exited", exitCode: undefined });
		} finally {
			unregister();
			if (completion !== undefined) await shutdown(first);
			else first.close();
			if (pid !== undefined && processExists(pid)) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
				try {
					await rescue.request({ op: "stop", name: "recovered-exit", timeoutMs: 2_000 });
				} finally {
					await shutdown(rescue);
				}
			}
		}
	}, 15_000);

	it("replays a detached exit that precedes broker recovery", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-pre-recovery-exit-project-");
		const runtimeDir = await tempDir("omp-daemon-pre-recovery-exit-runtime-");
		const owner = "pre-recovery-exit-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		let recovered: DaemonBrokerClient | undefined;
		let unregister: (() => void) | undefined;
		let pid: number | undefined;
		try {
			first.onCompletion(owner, () => {});
			const started = await first.request({
				op: "start",
				spec: {
					name: "pre-recovery-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 0.2; exit 7"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: true,
				},
				owner,
			});
			if (started.op !== "start" || started.daemon.pid === undefined)
				throw new Error("detached daemon did not start");
			pid = started.daemon.pid;
			await first.request({ op: "shutdown" });
			first.close();
			expect(await waitUntil(() => !processExists(pid!), 3_000)).toBeTrue();

			recovered = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const completions: DaemonSnapshot[] = [];
			unregister = recovered.onCompletion(owner, notification => {
				completions.push(notification.daemon);
			});
			await recovered.request({ op: "list" });
			expect(await waitUntil(() => completions.length === 1, 2_000)).toBeTrue();
			expect(completions[0]).toMatchObject({ name: "pre-recovery-exit", state: "exited" });
		} finally {
			unregister?.();
			first.close();
			if (recovered) await shutdown(recovered);
			if (pid !== undefined && processExists(pid)) process.kill(pid, "SIGKILL");
		}
	}, 12_000);

	it("replays every pending generation completion after broker recovery", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-pending-recovery-project-");
		const runtimeDir = await tempDir("omp-daemon-pending-recovery-runtime-");
		const owner = "pending-recovery-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 500 });
		let controller: DaemonBrokerClient | undefined;
		let recovered: DaemonBrokerClient | undefined;
		let unregister: (() => void) | undefined;
		const completions: DaemonSnapshot[] = [];
		try {
			first.onCompletion(owner, () => {});
			const started = await first.request({
				op: "start",
				spec: {
					name: "pending-recovery-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 0.15; exit 7"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: true,
				},
				owner,
			});
			if (started.op !== "start") throw new Error("detached daemon did not start");
			first.close();
			const metaPath = path.join(runtimeDir, "daemons", "pending-recovery-exit", "meta.json");
			expect(
				await waitUntil(async () => {
					const meta = (await Bun.file(metaPath).json()) as { pendingCompletions?: unknown[] };
					return meta.pendingCompletions?.length === 1;
				}, 3_000),
			).toBeTrue();

			controller = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			await controller.request({ op: "restart", name: "pending-recovery-exit" });
			expect(
				await waitUntil(async () => {
					const meta = (await Bun.file(metaPath).json()) as { pendingCompletions?: unknown[] };
					return meta.pendingCompletions?.length === 2;
				}, 3_000),
			).toBeTrue();
			const persisted = (await Bun.file(metaPath).json()) as {
				daemon: DaemonSnapshot;
				pendingCompletions: DaemonCompletionNotification[];
				[key: string]: unknown;
			};
			expect(new Set(persisted.pendingCompletions.map(completion => completion.completionId)).size).toBe(2);
			await Bun.write(
				metaPath,
				JSON.stringify({
					...persisted,
					daemon: {
						...persisted.daemon,
						state: "running",
						exitCode: undefined,
						exitedAt: undefined,
					},
				}),
			);
			const brokerPidPath = path.join(runtimeDir, "broker.pid");
			const { pid: brokerPid } = (await Bun.file(brokerPidPath).json()) as { pid: number };
			process.kill(brokerPid, "SIGKILL");
			expect(await waitUntil(() => !processExists(brokerPid), 3_000)).toBeTrue();

			recovered = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			unregister = recovered.onCompletion(owner, notification => {
				completions.push(notification.daemon);
			});
			await recovered.request({ op: "list" });

			expect(await waitUntil(() => completions.length === 2, 2_000)).toBeTrue();
			expect(completions.map(completion => completion.name)).toEqual([
				"pending-recovery-exit",
				"pending-recovery-exit",
			]);
			expect(completions).toEqual([
				expect.objectContaining({ state: "failed", exitCode: 7 }),
				expect.objectContaining({ state: "failed", exitCode: 7 }),
			]);
			expect(
				await waitUntil(async () => {
					const metadata = (await Bun.file(metaPath).json()) as {
						completionPending?: boolean;
						pendingCompletions?: unknown[];
					};
					return metadata.completionPending === false && metadata.pendingCompletions?.length === 0;
				}, 2_000),
			).toBeTrue();
		} finally {
			unregister?.();
			first.close();
			controller?.close();
			if (recovered) await shutdown(recovered);
		}
	}, 12_000);

	it("replays a recovered non-detached daemon exit", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-attached-recovery-project-");
		const runtimeDir = await tempDir("omp-daemon-attached-recovery-runtime-");
		const owner = "attached-recovery-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		let recovered: DaemonBrokerClient | undefined;
		let unregister: (() => void) | undefined;
		let daemonPid: number | undefined;
		try {
			first.onCompletion(owner, () => {});
			const started = await first.request({
				op: "start",
				spec: {
					name: "attached-recovery-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 30"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("daemon did not start");
			daemonPid = started.daemon.pid;
			const { pid: brokerPid } = (await Bun.file(path.join(runtimeDir, "broker.pid")).json()) as { pid: number };
			process.kill(brokerPid, "SIGKILL");
			expect(await waitUntil(() => !processExists(brokerPid), 3_000)).toBeTrue();
			first.close();

			recovered = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const completions: DaemonSnapshot[] = [];
			unregister = recovered.onCompletion(owner, notification => {
				completions.push(notification.daemon);
			});
			await recovered.request({ op: "list" });

			expect(await waitUntil(() => completions.length === 1, 3_000)).toBeTrue();
			expect(completions[0]).toMatchObject({ name: "attached-recovery-exit", state: "exited" });
		} finally {
			unregister?.();
			first.close();
			if (recovered) await shutdown(recovered);
			if (daemonPid !== undefined && processExists(daemonPid)) process.kill(daemonPid, "SIGKILL");
		}
	}, 12_000);

	// Regression: a start whose log pattern matched but whose port never accepted
	// used to report "Ready: <match>" AND "Readiness timed out" with no hint of
	// which condition failed. The snapshot now names the unmet condition(s).
	it("names the unmet readiness condition when start times out", async () => {
		const projectDir = await tempDir("omp-daemon-ready-project-");
		const runtimeDir = await tempDir("omp-daemon-ready-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, `process.stdout.write("LISTENING\\n"); setInterval(() => {}, 1000);\n`);
		// Reserve an ephemeral port and release it so nothing accepts connections there.
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const deadPort = probe.port;
		probe.stop(true);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const spec: DaemonSpec = {
				name: "never-ready",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "LISTENING", port: deadPort, timeoutMs: 3_000 },
				restart: "no",
				persist: false,
				detached: false,
			};
			const started = await client.request({ op: "start", spec });
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeTrue();
			expect(started.daemon.state).toBe("starting");
			expect(started.daemon.readyMatch).toBe("LISTENING");
			expect(started.daemon.readyPending).toEqual(["port"]);

			const stopped = await client.request({ op: "stop", name: "never-ready", timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error("unexpected stop result");
			// Terminal states carry no stale readiness noise.
			expect(stopped.daemon.readyPending).toBeUndefined();
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	// Regression: a process that flips starting→ready→exited within one 50ms poll
	// interval used to hang `start` for the full readiness timeout, because
	// #waitUntil sampled the live (already "exited") state instead of the sticky
	// readyAt marker #markReady durably recorded.
	it("returns promptly when the process becomes ready then exits within a poll", async () => {
		const projectDir = await tempDir("omp-daemon-fast-project-");
		const runtimeDir = await tempDir("omp-daemon-fast-runtime-");
		const scriptPath = path.join(projectDir, "fast.ts");
		await Bun.write(scriptPath, `process.stdout.write("done\\n");\n`);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const spec: DaemonSpec = {
				name: "fast",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: ".+", timeoutMs: 60_000 },
				restart: "no",
				persist: false,
				detached: false,
			};
			const t0 = Date.now();
			const started = await client.request({ op: "start", spec });
			const elapsed = Date.now() - t0;
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unexpected start result");
			// Woke on readyAt/terminal, not the full 60s timeout.
			expect(elapsed).toBeLessThan(10_000);
			expect(started.readyTimedOut).toBeFalse();
			expect(started.daemon.readyAt).toBeDefined();

			// A for:"ready" wait on the settled daemon reports success via the sticky
			// readyAt marker even though the process has already exited.
			const waited = await client.request({
				op: "wait",
				name: "fast",
				for: "ready",
				timeoutMs: 60_000,
			});
			expect(waited.op).toBe("wait");
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.timedOut).toBeFalse();
			expect(waited.daemon.readyAt).toBeDefined();
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	// Regression: a process that exits before ever becoming ready used to block the
	// caller for the full timeout, and a for:"ready" wait on the settled daemon did
	// the same. Terminal states now wake both waits immediately.
	it('wakes start and for:"ready" waits when the process exits before readiness', async () => {
		const projectDir = await tempDir("omp-daemon-preexit-project-");
		const runtimeDir = await tempDir("omp-daemon-preexit-runtime-");
		const scriptPath = path.join(projectDir, "preexit.ts");
		// Exits without ever printing the ready pattern.
		await Bun.write(scriptPath, `process.stdout.write("nope\\n"); process.exit(0);\n`);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const spec: DaemonSpec = {
				name: "preexit",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "LISTENING", timeoutMs: 60_000 },
				restart: "no",
				persist: false,
				detached: false,
			};
			const t0 = Date.now();
			const started = await client.request({ op: "start", spec });
			const startElapsed = Date.now() - t0;
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(startElapsed).toBeLessThan(10_000);
			// Woke on the terminal exit rather than timing out; the readyAt marker is
			// absent because the ready pattern never matched.
			expect(started.readyTimedOut).toBeFalse();
			expect(started.daemon.readyAt).toBeUndefined();
			expect(["exited", "failed"]).toContain(started.daemon.state);

			// A for:"ready" wait on the already-settled daemon must wake immediately,
			// but a process that never became ready is surfaced as not ready
			// (timedOut) so callers don't chain work against a dead process.
			const t1 = Date.now();
			const waited = await client.request({
				op: "wait",
				name: "preexit",
				for: "ready",
				timeoutMs: 60_000,
			});
			const waitElapsed = Date.now() - t1;
			expect(waited.op).toBe("wait");
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waitElapsed).toBeLessThan(10_000);
			expect(waited.timedOut).toBeTrue();
			expect(waited.daemon.readyAt).toBeUndefined();
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	// Regression (PR #6305 review): readyAt belongs to the exited generation, so a
	// daemon in the restart backoff window must not report readiness. #settle now
	// clears readyAt/readyMatch when entering "restarting"; without that, start and
	// for:"ready" waits race a dead service during the backoff.
	it("clears stale readiness while a daemon is restarting", async () => {
		const projectDir = await tempDir("omp-daemon-restart-project-");
		const runtimeDir = await tempDir("omp-daemon-restart-runtime-");
		const scriptPath = path.join(projectDir, "flap.ts");
		// Becomes ready (prints the pattern), then crashes shortly after.
		await Bun.write(scriptPath, `process.stdout.write("READY\\n"); setTimeout(() => process.exit(1), 50);\n`);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const spec: DaemonSpec = {
				name: "flap",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "READY", timeoutMs: 60_000 },
				restart: "on-failure",
				persist: false,
				detached: false,
			};
			const started = await client.request({ op: "start", spec });
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.daemon.readyAt).toBeDefined();

			// Catch the backoff window: once restarting, readiness must be cleared.
			const restarting = await waitUntil(async () => {
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") return false;
				const daemon = listed.daemons.find(d => d.name === "flap");
				return daemon?.state === "restarting";
			}, 15_000);
			expect(restarting).toBeTrue();
			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error("unexpected list result");
			const daemon = listed.daemons.find(d => d.name === "flap");
			expect(daemon?.state).toBe("restarting");
			expect(daemon?.readyAt).toBeUndefined();
			expect(daemon?.readyMatch).toBeUndefined();

			await client.request({ op: "stop", name: "flap", timeoutMs: 2_000 });
		} finally {
			await shutdown(client);
		}
	}, 30_000);
	it("delivers owner completions for spontaneous final exits only", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-completion-project-");
		const runtimeDir = await tempDir("omp-daemon-completion-runtime-");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const owner = "completion-owner";
		const completions: DaemonSnapshot[] = [];
		let resolveNext: ((daemon: DaemonSnapshot) => void) | undefined;
		const nextCompletion = (): Promise<DaemonSnapshot> => {
			const { promise, resolve } = Promise.withResolvers<DaemonSnapshot>();
			resolveNext = resolve;
			return promise;
		};
		const unregister = client.onCompletion(owner, notification => {
			completions.push(notification.daemon);
			resolveNext?.(notification.daemon);
			resolveNext = undefined;
		});
		const startSpec = (name: string, command: string, restart: DaemonSpec["restart"]): DaemonSpec => ({
			name,
			application: "/bin/sh",
			args: ["-c", command],
			env: {},
			cwd: projectDir,
			pty: false,
			restart,
			persist: false,
			detached: false,
		});
		try {
			const successPending = nextCompletion();
			await client.request({
				op: "start",
				spec: startSpec("success", "exit 0", "no"),
				owner,
			});
			const success = await successPending;
			expect(success.state).toBe("exited");
			expect(success.exitCode).toBe(0);
			await client.request({ op: "list" });
			expect(completions).toHaveLength(1);
			const failurePending = nextCompletion();
			await client.request({
				op: "start",
				spec: startSpec("failure", "exit 7", "no"),
				owner,
			});
			const failure = await failurePending;
			expect(failure.state).toBe("failed");
			expect(failure.exitCode).toBe(7);

			const beforeExplicitRestart = completions.length;
			await client.request({
				op: "start",
				spec: startSpec("explicit-restart", "while true; do sleep 1; done", "no"),
				owner,
			});
			await client.request({ op: "restart", name: "explicit-restart" });
			expect(completions).toHaveLength(beforeExplicitRestart);
			await client.request({ op: "stop", name: "explicit-restart", timeoutMs: 2_000 });
			expect(completions).toHaveLength(beforeExplicitRestart);

			const beforeRestart = completions.length;
			await client.request({
				op: "start",
				spec: startSpec("restart", "exit 0", "always"),
				owner,
			});
			const restarting = await waitUntil(async () => {
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") return false;
				return listed.daemons.find(daemon => daemon.name === "restart")?.state === "restarting";
			}, 3_000);
			expect(restarting).toBeTrue();
			expect(completions).toHaveLength(beforeRestart);
			await client.request({ op: "stop", name: "restart", timeoutMs: 2_000 });
			expect(completions).toHaveLength(beforeRestart);
		} finally {
			unregister();
			await shutdown(client);
		}
	}, 9_000);

	it("acknowledges a completion only after its consumer accepts delivery", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-sink-acceptance-project-");
		const runtimeDir = await tempDir("omp-daemon-sink-acceptance-runtime-");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const owner = "delayed-owner";
		const delivered = Promise.withResolvers<void>();
		const accepted = Promise.withResolvers<void>();
		const unregister = client.onCompletion(owner, async () => {
			delivered.resolve();
			await accepted.promise;
		});
		const metaPath = path.join(runtimeDir, "daemons", "delayed-sink", "meta.json");
		try {
			await client.request({
				op: "start",
				spec: {
					name: "delayed-sink",
					application: "/bin/sh",
					args: ["-c", "exit 0"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			await delivered.promise;
			const pending = (await Bun.file(metaPath).json()) as { pendingCompletions?: unknown[] };
			expect(pending.pendingCompletions).toHaveLength(1);

			accepted.resolve();
			expect(
				await waitUntil(async () => {
					const metadata = (await Bun.file(metaPath).json()) as { pendingCompletions?: unknown[] };
					return metadata.pendingCompletions?.length === 0;
				}, 2_000),
			).toBeTrue();
		} finally {
			unregister();
			await shutdown(client);
		}
	}, 9_000);

	it("replays an unacknowledged completion after the owner reconnects", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-reconnect-project-");
		const runtimeDir = await tempDir("omp-daemon-reconnect-runtime-");
		const owner = "reconnect-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		first.onCompletion(owner, () => {});
		await first.request({
			op: "start",
			spec: {
				name: "gap-exit",
				application: "/bin/sh",
				args: ["-c", "sleep 0.2; exit 7"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
			owner,
		});
		first.close();
		await Bun.sleep(400);

		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const completions: DaemonSnapshot[] = [];
		const received = Promise.withResolvers<void>();
		const unregister = second.onCompletion(owner, notification => {
			completions.push(notification.daemon);
			received.resolve();
		});
		try {
			await second.request({ op: "list" });
			await received.promise;
			await second.request({ op: "list" });
			expect(completions).toHaveLength(1);
			expect(completions[0]).toMatchObject({ name: "gap-exit", state: "failed", exitCode: 7 });
		} finally {
			unregister();
			await shutdown(second);
		}
	}, 9_000);
	it("prevents daemon name reuse until pending completions are acknowledged", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-pending-name-project-");
		const runtimeDir = await tempDir("omp-daemon-pending-name-runtime-");
		const owner = "pending-name-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		first.onCompletion(owner, () => {});
		const spec = {
			name: "pending-name",
			application: "/bin/sh",
			args: ["-c", "sleep 0.2; exit 0"],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no" as const,
			persist: false,
			detached: false,
		};
		await first.request({ op: "start", spec, owner });
		first.close();
		await Bun.sleep(400);

		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		let unregister: (() => void) | undefined;
		try {
			await expect(second.request({ op: "start", spec })).rejects.toThrow(
				"守护进程 pending-name 存在未确认的完成通知",
			);
			const received = Promise.withResolvers<void>();
			unregister = second.onCompletion(owner, () => received.resolve());
			await second.request({ op: "list" });
			await received.promise;
			await second.request({ op: "list" });
			const restarted = await second.request({ op: "start", spec });
			expect(restarted).toMatchObject({ op: "start", daemon: { name: "pending-name" } });
		} finally {
			unregister?.();
			await shutdown(second);
		}
	}, 9_000);
	it("publishes a restored owner subscription without another caller request", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-restored-owner-project-");
		const runtimeDir = await tempDir("omp-daemon-restored-owner-runtime-");
		const owner = "restored-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		let completion: DaemonSnapshot | undefined;
		let unregister: (() => void) | undefined;
		try {
			await first.request({
				op: "start",
				spec: {
					name: "restored-owner-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 0.3; exit 0"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			await second.request({ op: "ping" });
			unregister = second.onCompletion(owner, notification => {
				completion = notification.daemon;
			});

			expect(await waitUntil(() => completion !== undefined, 3_000)).toBeTrue();
			expect(completion).toMatchObject({ name: "restored-owner-exit", state: "exited", exitCode: 0 });
		} finally {
			unregister?.();
			first.close();
			await shutdown(second);
		}
	}, 9_000);

	it("ignores an unsubscribe from a superseded owner subscription", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-superseded-owner-project-");
		const runtimeDir = await tempDir("omp-daemon-superseded-owner-runtime-");
		const owner = "shared-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const unregisterFirst = first.onCompletion(owner, () => {});
		let unregisterSecond: (() => void) | undefined;
		let completion: DaemonSnapshot | undefined;
		try {
			await first.request({
				op: "start",
				spec: {
					name: "superseded-owner-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 1; exit 0"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			const metaPath = path.join(runtimeDir, "daemons", "superseded-owner-exit", "meta.json");
			const firstMetadata = (await Bun.file(metaPath).json()) as { completionSubscriptionId?: string };
			if (!firstMetadata.completionSubscriptionId)
				throw new Error("first completion subscription was not persisted");
			unregisterSecond = second.onCompletion(owner, notification => {
				completion = notification.daemon;
			});
			const replacementSubscriptionId = crypto.randomUUID();
			await publishCompletionOwner(projectDir, runtimeDir, owner, replacementSubscriptionId);
			const replacementMetadata = (await Bun.file(metaPath).json()) as {
				completionEvents?: boolean;
				completionSubscriptionId?: string;
			};
			expect(replacementMetadata).toMatchObject({
				completionEvents: true,
				completionSubscriptionId: replacementSubscriptionId,
			});
			await second.request({ op: "ping" });
			await publishCompletionOwner(projectDir, runtimeDir, owner, firstMetadata.completionSubscriptionId, [
				"stale-completion",
			]);
			unregisterFirst();

			expect(await waitUntil(() => completion !== undefined, 3_000)).toBeTrue();
			expect(completion).toMatchObject({ name: "superseded-owner-exit", state: "exited", exitCode: 0 });
		} finally {
			unregisterFirst();
			unregisterSecond?.();
			first.close();
			await shutdown(second);
		}
	}, 9_000);
	it("preserves a superseding owner subscription through broker recovery", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-recovered-subscription-project-");
		const runtimeDir = await tempDir("omp-daemon-recovered-subscription-runtime-");
		const owner = "recovered-shared-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const unregisterFirst = first.onCompletion(owner, () => {});
		let unregisterSecond: (() => void) | undefined;
		let completion: DaemonSnapshot | undefined;
		let pid: number | undefined;
		try {
			await first.request({ op: "ping" });
			unregisterSecond = second.onCompletion(owner, notification => {
				completion = notification.daemon;
			});
			const started = await second.request({
				op: "start",
				spec: {
					name: "recovered-superseded-owner-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 1.5; exit 0"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: true,
				},
				owner,
			});
			if (started.op !== "start" || started.daemon.pid === undefined) {
				throw new Error("detached daemon did not start");
			}
			pid = started.daemon.pid;
			const metaPath = path.join(runtimeDir, "daemons", "recovered-superseded-owner-exit", "meta.json");
			const beforeRecovery = (await Bun.file(metaPath).json()) as { completionSubscriptionId?: string };
			expect(beforeRecovery.completionSubscriptionId).toBeString();

			await second.request({ op: "shutdown" });
			expect(
				await waitUntil(
					() =>
						Bun.file(path.join(runtimeDir, "broker.pid"))
							.exists()
							.then(exists => !exists),
					5_000,
				),
			).toBeTrue();

			unregisterFirst();
			await first.request({ op: "ping" });
			const afterStaleUnsubscribe = (await Bun.file(metaPath).json()) as {
				completionEvents?: boolean;
				completionSubscriptionId?: string;
			};
			expect(afterStaleUnsubscribe).toMatchObject({
				completionEvents: true,
				completionSubscriptionId: beforeRecovery.completionSubscriptionId,
			});
			first.close();

			expect(await waitUntil(() => pid !== undefined && !processExists(pid), 4_000)).toBeTrue();
			await second.request({ op: "list" });
			expect(await waitUntil(() => completion !== undefined, 2_000)).toBeTrue();
			expect(completion).toMatchObject({
				name: "recovered-superseded-owner-exit",
				state: "exited",
			});
		} finally {
			unregisterFirst();
			unregisterSecond?.();
			first.close();
			await shutdown(second);
			if (pid !== undefined && processExists(pid)) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
				try {
					await rescue.request({ op: "stop", name: "recovered-superseded-owner-exit", timeoutMs: 2_000 });
				} finally {
					await shutdown(rescue);
				}
			}
		}
	}, 15_000);

	it("clears an owner unsubscribed after a transport reconnect", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-unsubscribe-project-");
		const runtimeDir = await tempDir("omp-daemon-unsubscribe-runtime-");
		const owner = "unsubscribed-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
		let second: DaemonBrokerClient | undefined;
		try {
			first.onCompletion(owner, () => {});
			await first.request({
				op: "start",
				spec: {
					name: "unsubscribe-gap",
					application: "/bin/sh",
					args: ["-c", "sleep 0.4; exit 0"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			first.close();

			second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
			const unregister = second.onCompletion(owner, () => {});
			unregister();
			await second.request({ op: "ping" });
			expect(
				await waitUntil(async () => {
					const listed = await second!.request({ op: "list" });
					return listed.op === "list" && listed.daemons[0]?.state === "exited";
				}, 3_000),
			).toBeTrue();
			second.close();

			expect(
				await waitUntil(
					() =>
						Bun.file(path.join(runtimeDir, "broker.sock"))
							.exists()
							.then(exists => !exists),
					3_000,
				),
			).toBeTrue();
		} finally {
			first.close();
			second?.close();
			if (await Bun.file(path.join(runtimeDir, "broker.sock")).exists()) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
				await shutdown(rescue);
			}
		}
	}, 12_000);

	it("preserves an owner's pending completion while its sink is detached", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-preserve-owner-project-");
		const runtimeDir = await tempDir("omp-daemon-preserve-owner-runtime-");
		const owner = "preserved-owner";
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
		const unregister = client.onCompletion(owner, () => {});
		let recovered: DaemonBrokerClient | undefined;
		try {
			await client.request({
				op: "start",
				spec: {
					name: "preserved-owner-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 0.2; exit 0"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			unregister({ preservePending: true });
			expect(
				await waitUntil(async () => {
					const listed = await client.request({ op: "list" });
					return listed.op === "list" && listed.daemons[0]?.state === "exited";
				}, 3_000),
			).toBeTrue();

			client.close();
			expect(
				await waitUntil(
					() =>
						Bun.file(path.join(runtimeDir, "broker.sock"))
							.exists()
							.then(exists => !exists),
					3_000,
				),
			).toBeTrue();

			recovered = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
			const received = Promise.withResolvers<void>();
			const unregisterRecovered = recovered.onCompletion(owner, () => received.resolve());
			try {
				await recovered.request({ op: "list" });
				await received.promise;
			} finally {
				unregisterRecovered();
			}
		} finally {
			client.close();
			recovered?.close();
			if (await Bun.file(path.join(runtimeDir, "broker.sock")).exists()) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
				await shutdown(rescue);
			}
		}
	}, 12_000);

	it("does not let a detached client reclaim a resumed owner", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-detached-owner-project-");
		const runtimeDir = await tempDir("omp-daemon-detached-owner-runtime-");
		const owner = "resumed-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const unregisterFirst = first.onCompletion(owner, () => {});
		let unregisterSecond: (() => void) | undefined;
		let completion: DaemonSnapshot | undefined;
		try {
			await first.request({
				op: "start",
				spec: {
					name: "resumed-owner-exit",
					application: "/bin/sh",
					args: ["-c", "sleep 0.5; exit 0"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			unregisterFirst({ preservePending: true });
			unregisterSecond = second.onCompletion(owner, notification => {
				completion = notification.daemon;
			});
			await second.request({ op: "ping" });
			await first.request({ op: "ping" });

			expect(await waitUntil(() => completion !== undefined, 3_000)).toBeTrue();
			expect(completion).toMatchObject({ name: "resumed-owner-exit", state: "exited", exitCode: 0 });
		} finally {
			unregisterFirst();
			unregisterSecond?.();
			first.close();
			await shutdown(second);
		}
	}, 9_000);
	it("drops a completion when its owner unsubscribes during settlement", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-settle-unsubscribe-project-");
		const runtimeDir = await tempDir("omp-daemon-settle-unsubscribe-runtime-");
		const owner = "settle-unsubscribe-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
		const unregister = first.onCompletion(owner, () => {});
		try {
			await first.request({
				op: "start",
				spec: {
					name: "settle-unsubscribe",
					application: "/bin/sh",
					args: ["-c", "i=0; while [ $i -lt 20000 ]; do echo x; i=$((i+1)); done"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				owner,
			});
			expect(
				await waitUntil(async () => {
					const listed = await first.request({ op: "list" });
					return listed.op === "list" && listed.daemons[0]?.state === "exited";
				}, 5_000),
			).toBeTrue();
			unregister();
			await first.request({ op: "ping" });
			first.close();
			expect(
				await waitUntil(
					() =>
						Bun.file(path.join(runtimeDir, "broker.sock"))
							.exists()
							.then(exists => !exists),
					3_000,
				),
			).toBeTrue();
		} finally {
			unregister();
			first.close();
			if (await Bun.file(path.join(runtimeDir, "broker.sock")).exists()) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
				await shutdown(rescue);
			}
		}
	}, 12_000);
	it("does not retain completions for owners that did not advertise event support", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-legacy-owner-project-");
		const runtimeDir = await tempDir("omp-daemon-legacy-owner-runtime-");
		const owner = "legacy-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		await first.request({
			op: "start",
			spec: {
				name: "legacy-exit",
				application: "/bin/sh",
				args: ["-c", "exit 7"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
			owner,
		});
		first.close();
		await Bun.sleep(200);

		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const completions: DaemonSnapshot[] = [];
		const unregister = second.onCompletion(owner, notification => {
			completions.push(notification.daemon);
		});
		try {
			await second.request({ op: "list" });
			await Bun.sleep(100);
			expect(completions).toEqual([]);
		} finally {
			unregister();
			await shutdown(second);
		}
	}, 9_000);
	it("does not replay a completion after the owner unsubscribes", async () => {
		if (process.platform === "win32") return;
		const projectDir = await tempDir("omp-daemon-unsubscribe-project-");
		const runtimeDir = await tempDir("omp-daemon-unsubscribe-runtime-");
		const owner = "unsubscribe-owner";
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const unregisterFirst = first.onCompletion(owner, () => {});
		await first.request({
			op: "start",
			spec: {
				name: "unsubscribed-exit",
				application: "/bin/sh",
				args: ["-c", "sleep 0.3; exit 7"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
			owner,
		});
		unregisterFirst();
		await Bun.sleep(100);
		first.close();
		await Bun.sleep(300);

		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const completions: DaemonSnapshot[] = [];
		const unregisterSecond = second.onCompletion(owner, notification => {
			completions.push(notification.daemon);
		});
		try {
			await second.request({ op: "list" });
			await Bun.sleep(100);
			expect(completions).toEqual([]);
		} finally {
			unregisterSecond();
			await shutdown(second);
		}
	}, 9_000);
});
