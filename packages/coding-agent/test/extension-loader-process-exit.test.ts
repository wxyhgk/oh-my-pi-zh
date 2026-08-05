/**
 * Regression test for #3680: third-party extension / hook modules that call
 * `process.exit()` at the top level must not terminate the host OMP process.
 *
 * The harness intercepts the load via `withHostGuard`; this test pins that the
 * intercepted error surfaces as a per-module load failure (so OMP keeps going)
 * instead of crashing the test runner.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadHooks } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/loader";
import { ExtensionExitError, withHostGuard } from "@oh-my-pi/pi-coding-agent/extensibility/utils";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("extension/hook loader process.exit guard (#3680)", () => {
	let project: TempDir | undefined;

	beforeEach(() => {
		project = TempDir.createSync("@omp-exit-guard-");
	});

	afterEach(() => {
		project?.removeSync();
		project = undefined;
	});

	const writeModule = (relativePath: string, source: string): string => {
		expect(project).toBeDefined();
		const filePath = path.join(project!.path(), relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, source);
		return filePath;
	};

	const runProbe = async (probe: string, preload: string[] = []) => {
		const preloadArgs = preload.flatMap(file => ["--preload", file]);
		const proc = Bun.spawn([process.execPath, ...preloadArgs, "-e", probe], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Real process signals cannot use fake timers; this only bounds a wedged child.
		const watchdog = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 2000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		} finally {
			clearTimeout(watchdog);
		}
	};

	const runGuardedShutdownProbe = (trigger: "sigint" | "fatal") => {
		const action =
			trigger === "sigint"
				? 'process.kill(process.pid, "SIGINT");'
				: 'void Promise.reject(new Error("probe fatal"));';
		return runProbe(`
import { postmortem } from "@oh-my-pi/pi-utils";
import { withHostGuard } from "@oh-my-pi/pi-coding-agent/extensibility/utils";

postmortem.register("probe-cleanup", reason => {
	process.stdout.write(\`cleanup:\${reason}\\n\`);
});
void withHostGuard(async () => {
	process.stdout.write("guard-active\\n");
	${action}
	// Keep the real child event loop alive so the platform can deliver SIGINT.
	await Bun.sleep(10_000);
});
`);
	};

	it("converts a top-level process.exit in an extension into a load error", async () => {
		const ext = writeModule("rogue-extension.ts", "process.exit(0)\n");
		const cwd = project!.path();
		const originalExit = process.exit;

		const result = await loadExtensions([ext], cwd);

		expect(process.exit).toBe(originalExit);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(ext);
		expect(result.errors[0].error).toContain("process.exit(0)");
	});

	it("converts a top-level process.exit in a hook into a load error", async () => {
		const hook = writeModule("rogue-hook.ts", "process.exit(42)\n");
		const cwd = project!.path();
		const originalExit = process.exit;

		const result = await loadHooks([hook], cwd);

		expect(process.exit).toBe(originalExit);
		expect(result.hooks).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(hook);
		expect(result.errors[0].error).toContain("process.exit(42)");
	});

	it("converts hard exits from extension and hook factories into load errors", async () => {
		const extension = writeModule("factory-exit-extension.ts", "export default function(pi) { process.exit(31); }\n");
		const hook = writeModule("factory-exit-hook.ts", "export default function(pi) { process.exit(32); }\n");
		const reallyExitExtension = writeModule(
			"factory-really-exit-extension.ts",
			"export default function(pi) { process.reallyExit(33); }\n",
		);
		const cwd = project!.path();
		const originalExit = process.exit;
		const originalReallyExit = process.reallyExit;

		const extensionResult = await loadExtensions([extension], cwd);
		const hookResult = await loadHooks([hook], cwd);
		const reallyExitResult = await loadExtensions([reallyExitExtension], cwd);

		expect(process.exit).toBe(originalExit);
		expect(process.reallyExit).toBe(originalReallyExit);
		expect(extensionResult.extensions).toEqual([]);
		expect(extensionResult.errors).toHaveLength(1);
		expect(extensionResult.errors[0].path).toBe(extension);
		expect(extensionResult.errors[0].error).toContain("process.exit(31)");
		expect(hookResult.hooks).toEqual([]);
		expect(hookResult.errors).toHaveLength(1);
		expect(hookResult.errors[0].path).toBe(hook);
		expect(hookResult.errors[0].error).toContain("process.exit(32)");
		expect(reallyExitResult.extensions).toEqual([]);
		expect(reallyExitResult.errors).toHaveLength(1);
		expect(reallyExitResult.errors[0].path).toBe(reallyExitExtension);
		expect(reallyExitResult.errors[0].error).toContain("process.reallyExit(33)");
	});

	it("loads sibling modules even when one of them tries to exit", async () => {
		const bad = writeModule("rogue-extension.ts", "process.exit(0)\n");
		const good = writeModule(
			"good-extension.ts",
			"export default function(pi) { pi.registerCommand('ok', { handler: async () => {} }); }\n",
		);
		const cwd = project!.path();

		const result = await loadExtensions([bad, good], cwd);

		expect(result.errors.map(e => e.path)).toEqual([bad]);
		expect(result.extensions.map(e => path.basename(e.path))).toEqual(["good-extension.ts"]);
	});

	it("restores process.exit after a synchronous throw inside the guarded callback", async () => {
		const originalExit = process.exit;

		await expect(
			withHostGuard(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(process.exit).toBe(originalExit);
	});

	it("raises ExtensionExitError when the guarded callback calls process.exit", async () => {
		const originalExit = process.exit;

		await expect(withHostGuard(async () => process.exit(7))).rejects.toBeInstanceOf(ExtensionExitError);

		expect(process.exit).toBe(originalExit);
	});

	it("keeps postmortem.quit behind the extension exit guard", async () => {
		const { exitCode, stdout, stderr } = await runProbe(`
import { postmortem } from "@oh-my-pi/pi-utils";
import { withHostGuard } from "@oh-my-pi/pi-coding-agent/extensibility/utils";

try {
	await withHostGuard(() => postmortem.quit(37));
} catch (err) {
	process.stdout.write(\`\${err instanceof Error ? err.name : "UnknownError"}:\${String(err)}\\n\`);
}
`);

		expect(exitCode).toBe(0);
		expect(stdout).toContain(
			"ExtensionExitError:ExtensionExitError: 在受保护的扩展/钩子加载期间,模块调用了 process.exit(37)",
		);
		expect(stderr).toBe("");
	});

	it("lets host SIGINT exit once while a guarded callback remains pending", async () => {
		const { exitCode, stdout, stderr } = await runGuardedShutdownProbe("sigint");

		expect(exitCode).toBe(130);
		expect(stdout).toBe("guard-active\ncleanup:sigint\n");
		expect(stderr).not.toContain("[Unhandled Rejection]");
		expect(stderr).not.toContain("ExtensionExitError");
	});

	it("lets fatal cleanup exit once while a guarded callback remains pending", async () => {
		const { exitCode, stdout, stderr } = await runGuardedShutdownProbe("fatal");

		expect(exitCode).toBe(1);
		expect(stdout).toBe("guard-active\ncleanup:unhandled_rejection\n");
		expect(stderr.match(/\[Unhandled Rejection\]/g)).toHaveLength(1);
		expect(stderr).toContain("Error: probe fatal");
		expect(stderr).not.toContain("ExtensionExitError");
	});

	it("exits cleanly on host SIGHUP when postmortem initialized inside a guard window (#7393)", async () => {
		// Mirror the shipped bundle: postmortem's exit primitive is first resolved
		// while withHostGuard has replaced process.reallyExit with a throwing stub.
		// A preload swaps reallyExit before the entry's static postmortem import
		// evaluates; the entry then restores it (as the guard's finally does) and
		// self-SIGHUPs (the TUI terminal-disconnect path). A lazily resolved exit
		// primitive must pick up the restored native reallyExit and exit 129
		// instead of looping on ExtensionExitError.
		const preload = writeModule(
			"guard-init-preload.ts",
			"globalThis.__ompNativeReallyExit = process.reallyExit;\n" +
				'process.reallyExit = (() => { throw new Error("guarded during init"); });\n',
		);
		const { exitCode, stdout, stderr } = await runProbe(
			`
import { postmortem } from "@oh-my-pi/pi-utils";
postmortem.register("probe", reason => process.stdout.write(\`cleanup:\${reason}\\n\`));
process.reallyExit = globalThis.__ompNativeReallyExit;
process.stdout.write("armed\\n");
process.kill(process.pid, "SIGHUP");
// Keep the real child event loop alive so the platform can deliver SIGHUP;
// real signal delivery cannot be driven by fake timers.
await Bun.sleep(10_000);
`,
			[preload],
		);

		expect(exitCode).toBe(129);
		expect(stdout).toBe("armed\ncleanup:sighup\n");
		expect(stderr).not.toContain("ExtensionExitError");
		expect(stderr).not.toContain("Unhandled Rejection");
	});

	it("only the outermost guard restores process.exit when guards nest", async () => {
		const originalExit = process.exit;

		await withHostGuard(async () => {
			const outer = process.exit;
			expect(outer).not.toBe(originalExit);

			await withHostGuard(async () => {
				expect(process.exit).toBe(outer);
			});

			expect(process.exit).toBe(outer);
		});

		expect(process.exit).toBe(originalExit);
	});
});
