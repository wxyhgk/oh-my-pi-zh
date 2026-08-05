import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "resources-no-templates-mcp.ts");

describe("omp read MCP resources", () => {
	let root: string;
	let projectDir: string;
	let agentDir: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-mcp-"));
		projectDir = path.join(root, "project");
		agentDir = path.join(root, "agent");
		await Promise.all([fs.mkdir(projectDir), fs.mkdir(agentDir)]);
		await Bun.write(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					fixture: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH],
					},
				},
			}),
		);
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	async function runRead(resourceUri: string): Promise<{ exitCode: number; output: string; error: string }> {
		const proc = Bun.spawn([process.execPath, CLI_ENTRY, "read", resourceUri], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: root,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: agentDir,
			},
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);
		return { exitCode, output, error };
	}

	it("discovers MCP before reading a server-advertised native URI", async () => {
		const { exitCode, output, error } = await runRead("test://alpha");

		expect(exitCode).toBe(0);
		expect(error).toBe("");
		expect(output).toContain("fixture content for test://alpha");
	}, 30_000);

	it("discovers MCP before reading a server-advertised opaque URI", async () => {
		const { exitCode, output, error } = await runRead("urn:fixture:gamma");

		expect(exitCode).toBe(0);
		expect(error).toBe("");
		expect(output).toContain("fixture content for urn:fixture:gamma");
	}, 30_000);

	it("keeps the mcp:// wrapper working in the standalone CLI", async () => {
		const { exitCode, output, error } = await runRead("mcp://test://beta");

		expect(exitCode).toBe(0);
		expect(error).toBe("");
		expect(output).toContain("fixture content for test://beta");
	}, 30_000);

	it("exits after an MCP resource read error", async () => {
		const { exitCode, output, error } = await runRead("test://missing");

		expect(exitCode).toBe(1);
		expect(output).toBe("");
		expect(error).toContain('没有 MCP 服务器提供资源 "test://missing"');
	}, 30_000);
});
