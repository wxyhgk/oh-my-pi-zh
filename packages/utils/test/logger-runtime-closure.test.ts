import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoggerCacheSnapshot } from "./fixtures/logger-cache-snapshot";

const fixtureDir = path.join(import.meta.dir, "fixtures");
const probePath = path.join(fixtureDir, "logger-cache-probe.ts");
const positiveControlPath = path.join(fixtureDir, "logger-cache-positive-control.ts");
const roots: string[] = [];

interface ProbeResult {
	readonly snapshot: LoggerCacheSnapshot;
	readonly stdout: string;
	readonly stderr: string;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function runProbe(scenario: "import" | "console" | "file"): Promise<ProbeResult> {
	const root = await makeRoot("omp-logger-cache-");
	const outputPath = path.join(root, "result.json");
	const logsDir = path.join(root, "logs");
	await fs.mkdir(logsDir);
	const proc = Bun.spawn([process.execPath, probePath, scenario, outputPath, logsDir], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: { ...process.env, TZ: "Etc/GMT+5" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return {
		snapshot: JSON.parse(await fs.readFile(outputPath, "utf8")) as LoggerCacheSnapshot,
		stdout,
		stderr,
	};
}

async function runPositiveControl(): Promise<LoggerCacheSnapshot> {
	const root = await makeRoot("omp-logger-cache-control-");
	const outputPath = path.join(root, "result.json");
	const proc = Bun.spawn([process.execPath, positiveControlPath, outputPath], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(proc.stderr).text();
	expect(await proc.exited, await stderr).toBe(0);
	return JSON.parse(await fs.readFile(outputPath, "utf8")) as LoggerCacheSnapshot;
}

describe("central logger runtime closure", () => {
	test("detector observes the direct Winston positive control", async () => {
		const { winston } = await runPositiveControl();
		expect(winston.modules, JSON.stringify(winston)).toBeGreaterThan(0);
		expect(winston.bytes, JSON.stringify(winston)).toBeGreaterThan(0);
	}, 30_000);

	for (const scenario of ["import", "console", "file"] as const) {
		test(`${scenario} evaluates zero Winston runtime modules`, async () => {
			const { snapshot } = await runProbe(scenario);
			expect(
				{ modules: snapshot.winston.modules, bytes: snapshot.winston.bytes },
				JSON.stringify(snapshot.winston),
			).toEqual({ modules: 0, bytes: 0 });
		}, 30_000);
	}

	// Cold-cache probe children measure well under a second locally, but bun's
	// 5 s default test timeout SIGTERMed a probe (exit 143) on shared-core CI
	// runners; mirror logger-contract's 30 s ceiling for subprocess tests.
	test("rotation engine stays lazy until a file transport is constructed", async () => {
		const imported = await runProbe("import");
		const consoled = await runProbe("console");
		for (const result of [imported, consoled]) {
			expect(result.snapshot.fileStreamRotator.modules, JSON.stringify(result.snapshot)).toBe(0);
			expect(result.snapshot.moment.modules, JSON.stringify(result.snapshot)).toBe(0);
		}
		expect(imported.stdout).toBe("");
		expect(imported.stderr).toBe("");
		expect(consoled.stdout.endsWith(`${os.EOL}`)).toBe(true);
		expect(consoled.stderr).toBe("");

		const filed = await runProbe("file");
		expect(filed.snapshot.fileStreamRotator.modules, JSON.stringify(filed.snapshot)).toBeGreaterThan(0);
		expect(filed.snapshot.moment.modules, JSON.stringify(filed.snapshot)).toBeGreaterThan(0);
		expect(filed.stdout).toBe("");
		expect(filed.stderr).toBe("");
	}, 30_000);
	test("pins the deep rotation entrypoint to the reviewed package layout", async () => {
		const rootPackage = JSON.parse(
			await fs.readFile(path.resolve(import.meta.dir, "../../..", "package.json"), "utf8"),
		) as { workspaces?: { catalog?: Record<string, string> } };
		expect(rootPackage.workspaces?.catalog?.["winston-daily-rotate-file"]).toBe("5.0.0");
		expect(Bun.resolveSync("winston-daily-rotate-file/daily-rotate-file.js", import.meta.dir)).toEndWith(
			"/winston-daily-rotate-file/daily-rotate-file.js",
		);
	});
});
