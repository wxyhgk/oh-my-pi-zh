import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

interface CliProcessResult {
	exitCode: number;
	output: string;
	error: string;
}

async function runSetupPython(cwd: string, envOverrides?: NodeJS.ProcessEnv): Promise<CliProcessResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
		...envOverrides,
	};
	delete env.VIRTUAL_ENV;
	delete env.CONDA_DEFAULT_ENV;
	delete env.CONDA_PREFIX;
	const proc = Bun.spawn([process.execPath, cliEntry, "setup", "python", "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const output = new Response(proc.stdout).text();
	const error = new Response(proc.stderr).text();
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, output, error]);
	return { exitCode, output: stdout, error: stderr };
}

describe("omp setup python", () => {
	let projectDir: TempDir | undefined;

	afterEach(async () => {
		await projectDir?.remove();
		projectDir = undefined;
	});

	it.skipIf(process.platform === "win32")(
		"probes the project-configured interpreter instead of the PATH interpreter",
		async () => {
			projectDir = TempDir.createSync("@omp-setup-python-");
			const cwd = projectDir.path();
			const interpreter = path.join(cwd, "configured-python");
			await Bun.write(interpreter, "#!/bin/sh\nexit 0\n");
			await fs.chmod(interpreter, 0o755);
			await Bun.write(path.join(cwd, ".omp", "config.yml"), `python:\n  interpreter: ${interpreter}\n`);

			const result = await runSetupPython(cwd);

			expect(result.error).toBe("");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toMatchObject({
				available: true,
				pythonPath: interpreter,
				usingManagedEnv: false,
			});
		},
	);
	it.skipIf(process.platform === "win32")("prefers the project venv over the PATH interpreter", async () => {
		projectDir = TempDir.createSync("@omp-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, ".venv", "bin", "python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 0\n");
		await fs.chmod(interpreter, 0o755);

		const result = await runSetupPython(cwd);

		expect(result.error).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toMatchObject({
			available: true,
			pythonPath: interpreter,
			usingManagedEnv: false,
		});
	});
	it.skipIf(process.platform === "win32")("does not let the global probe bypass skip setup validation", async () => {
		projectDir = TempDir.createSync("@omp-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, "configured-python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 23\n");
		await fs.chmod(interpreter, 0o755);
		await Bun.write(path.join(cwd, ".omp", "config.yml"), `python:\n  interpreter: ${interpreter}\n`);

		const result = await runSetupPython(cwd, { PI_PYTHON_SKIP_CHECK: "1" });

		expect(result.error).toBe("");
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.output)).toMatchObject({
			available: false,
			pythonPath: interpreter,
			usingManagedEnv: false,
		});
	});
});
