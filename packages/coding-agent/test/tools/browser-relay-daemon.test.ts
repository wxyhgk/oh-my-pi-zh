import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import { probeRelayServer } from "../../src/tools/browser/relay/daemon";

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

describe("browser relay daemon", () => {
	it("stays alive while a consumer in another project holds the global broker lease", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-global-"));
		const firstProject = path.join(home, "project-a");
		const secondProject = path.join(home, "project-b");
		const firstMarker = path.join(home, "first-ready");
		const secondMarker = path.join(home, "second-ready");
		const globalRuntimeDir = path.join(home, ".omp", "run", "daemons", "global", "browser-relay");
		const cdpUrl = `http://127.0.0.1:${await findFreeCdpPort()}`;
		const scriptPath = path.join(home, "consumer.ts");
		await Promise.all([fs.mkdir(firstProject), fs.mkdir(secondProject)]);
		await Bun.write(
			scriptPath,
			`
import { closeDaemonClients } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/launch/client.ts"))};
import { ensureRelayDaemon } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};

const cdpUrl = process.env.OMP_TEST_RELAY_URL;
const marker = process.env.OMP_TEST_READY_MARKER;
if (!cdpUrl || !marker) throw new Error("relay consumer environment is incomplete");
try {
	if (!(await ensureRelayDaemon({ cdpUrl }))) throw new Error("relay did not start");
	await Bun.write(marker, "ready");
	const stopped = Promise.withResolvers<void>();
	process.stdin.once("end", () => stopped.resolve());
	process.stdin.resume();
	await stopped.promise;
} finally {
	await closeDaemonClients();
}
`,
		);

		const spawnConsumer = (cwd: string, profile: string, marker: string) =>
			Bun.spawn([process.execPath, scriptPath], {
				cwd,
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					PI_CONFIG_DIR: ".omp",
					OMP_PROFILE: profile,
					OMP_DAEMON_IDLE_GRACE_MS: "200",
					OMP_TEST_RELAY_URL: cdpUrl,
					OMP_TEST_READY_MARKER: marker,
				},
				stdin: "pipe",
				stdout: "ignore",
				stderr: "pipe",
			});

		const first = spawnConsumer(firstProject, "profile-a", firstMarker);
		try {
			expect(await waitUntil(() => Bun.file(firstMarker).exists(), 15_000)).toBeTrue();
			expect(await probeRelayServer(cdpUrl)).toBeTrue();

			const second = spawnConsumer(secondProject, "profile-b", secondMarker);
			try {
				expect(await waitUntil(() => Bun.file(secondMarker).exists(), 15_000)).toBeTrue();
				first.stdin.end();
				const firstExit = await first.exited;
				if (firstExit !== 0) throw new Error(await new Response(first.stderr).text());

				// The global broker's real idle clock must pass while the second client remains connected.
				await Bun.sleep(500);
				expect(await probeRelayServer(cdpUrl)).toBeTrue();

				second.stdin.end();
				const secondExit = await second.exited;
				if (secondExit !== 0) throw new Error(await new Response(second.stderr).text());
				expect(await waitUntil(async () => !(await probeRelayServer(cdpUrl)), 5_000)).toBeTrue();
			} finally {
				if (second.exitCode === null) second.kill();
				await second.exited;
			}
		} finally {
			if (first.exitCode === null) first.kill();
			await first.exited;
			const rescue = await createDaemonBrokerClient(globalRuntimeDir, {
				runtimeDir: globalRuntimeDir,
				idleGraceMs: 200,
			});
			try {
				await rescue.request({ op: "shutdown" });
			} catch {
				// The last-client grace may already have stopped the broker.
			}
			rescue.close();
			await fs.rm(home, { recursive: true, force: true });
		}
	}, 30_000);
});
