import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as cleanseAgent from "@wxyhgk/pi-coding-agent/cleanse/agent";
import { balanceDiagnostics } from "@wxyhgk/pi-coding-agent/cleanse/balance";
import * as cleanseCheckers from "@wxyhgk/pi-coding-agent/cleanse/checkers";
import { runCleanseCommand } from "@wxyhgk/pi-coding-agent/cleanse/index";
import { runCleanseLoop } from "@wxyhgk/pi-coding-agent/cleanse/loop";
import { parseCleanseDiagnostics } from "@wxyhgk/pi-coding-agent/cleanse/parsers";
import { createCleanseProgressReporter } from "@wxyhgk/pi-coding-agent/cleanse/progress";
import type {
	CleanseAgentOutcome,
	CleanseDiagnostic,
	CleanseDiagnosticReport,
} from "@wxyhgk/pi-coding-agent/cleanse/types";
import { resolveCliArgv } from "@wxyhgk/pi-coding-agent/cli-commands";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("cleanse diagnostics", () => {
	test("parses cargo clippy JSON into a project-relative actionable diagnostic", () => {
		const stdout = JSON.stringify({
			reason: "compiler-message",
			message: {
				message: "useless use of vec!",
				code: { code: "clippy::useless_vec" },
				level: "warning",
				spans: [
					{
						file_name: "src/main.rs",
						is_primary: true,
						line_start: 2,
						column_start: 18,
						line_end: 2,
						column_end: 31,
						suggested_replacement: "[1, 2, 3]",
					},
				],
			},
		});

		const diagnostics = parseCleanseDiagnostics("rust", {
			checker: "cargo clippy (.)",
			projectCwd: "/repo",
			checkerCwd: "/repo",
			stdout,
			stderr: "",
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			checker: "cargo clippy (.)",
			file: "src/main.rs",
			line: 2,
			column: 18,
			endLine: 2,
			endColumn: 31,
			code: "clippy::useless_vec",
			severity: "warning",
			message: "useless use of vec!",
			suggestion: "[1, 2, 3]",
		});
	});

	test("keeps files intact while balancing weighted burden across N agents", () => {
		const diagnostics = [
			...fileDiagnostics("a.rs", 4),
			...fileDiagnostics("b.rs", 3),
			...fileDiagnostics("c.rs", 2),
			...fileDiagnostics("d.rs", 1),
		];

		const assignments = balanceDiagnostics(diagnostics, 2);

		expect(assignments).toHaveLength(2);
		expect(assignments.map(assignment => assignment.weight).sort((left, right) => left - right)).toEqual([25, 25]);
		const assignedFiles = assignments.flatMap(assignment => assignment.groups.map(group => group.file));
		expect(assignedFiles).toHaveLength(4);
		expect(new Set(assignedFiles).size).toBe(4);
		expect(balanceDiagnostics(diagnostics, 12)).toHaveLength(4);
	});

	test("discovers package test scripts only when test mode is enabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-tests-"));
		try {
			await Bun.write(
				path.join(root, "package.json"),
				JSON.stringify({
					packageManager: "bun@1.3.14",
					scripts: { test: `bun -e "process.exit(3)"` },
				}),
			);
			await Bun.write(path.join(root, "src", "index.ts"), "export const value = 1;\n");

			const withoutTests = await cleanseCheckers.discoverCleanseDiagnosticSuite(root);
			const withTests = await cleanseCheckers.discoverCleanseDiagnosticSuite(root, { includeTests: true });
			const report = await withTests.run();

			expect(withoutTests.checkCount).toBe(0);
			expect(withTests.checkCount).toBe(1);
			expect(report.checks[0]).toMatchObject({
				label: "bun test (.)",
				exitCode: 3,
			});
			expect(report.diagnostics[0]?.message).toContain("bun test (.) 失败,退出码 3");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("excludes generated Bazel trees from checker discovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cleanse-ignore-"));
		try {
			await Bun.write(path.join(root, "src", "index.ts"), "export const value = 1;\n");
			await Bun.write(
				path.join(root, "bazel-output", "fixture", "package.json"),
				JSON.stringify({ scripts: { test: `bun -e "process.exit(3)"` } }),
			);

			const suite = await cleanseCheckers.discoverCleanseDiagnosticSuite(root, { includeTests: true });

			expect(suite.checkCount).toBe(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("cleanse progress", () => {
	test("updates an interactive completion bar as workers finish", () => {
		const writes: string[] = [];
		const progress = createCleanseProgressReporter({
			isTTY: true,
			write(text) {
				writes.push(text);
				return true;
			},
		});

		progress.start(2);
		progress.complete();
		progress.complete();
		progress.finish();

		expect(writes).toHaveLength(4);
		for (const update of writes.slice(0, 3)) {
			expect(update.startsWith("\r修复中 [")).toBe(true);
			expect(update.endsWith("\x1b[K")).toBe(true);
		}
		expect(writes[0]).toContain("0/2");
		expect(writes[1]).toContain("1/2");
		expect(writes[2]).toContain("2/2");
		expect(writes[3]).toBe("\n");
	});

	test("updates the command's TTY bar as repair workers finish", async () => {
		const output: string[] = [];
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		const initial = report([...fileDiagnostics("a.rs", 1), ...fileDiagnostics("b.rs", 1)]);
		const clean = report([]);
		let runCount = 0;
		const suite: cleanseCheckers.CleanseDiagnosticSuite = {
			checkCount: 1,
			skipped: [],
			async run() {
				runCount += 1;
				return runCount === 1 ? initial : clean;
			},
		};
		let hooks: cleanseAgent.CleanseAgentHooks | undefined;
		const runtime: cleanseAgent.CleanseAgentRuntime = {
			model: "test/model",
			sessionFile: "/tmp/cleanse.jsonl",
			async dispatch(assignments) {
				return assignments.map((assignment, index) => {
					const name = `CleanseW1A${index + 1}`;
					hooks?.onStart?.(name, assignment);
					const outcome: CleanseAgentOutcome = { name, success: true, output: "" };
					hooks?.onFinish?.(outcome, assignment);
					return outcome;
				});
			},
			async close() {},
		};
		vi.spyOn(cleanseCheckers, "discoverCleanseDiagnosticSuite").mockResolvedValue(suite);
		vi.spyOn(cleanseAgent, "createCleanseAgentRuntime").mockImplementation(async options => {
			hooks = options.hooks;
			return runtime;
		});

		try {
			const result = await runCleanseCommand({ maxAgents: 2 });

			expect(result.status).toBe("clean");
			const updates = output.filter(chunk => chunk.startsWith("\r修复中 ["));
			expect(updates).toHaveLength(3);
			expect(updates[0]).toContain("0/2");
			expect(updates[1]).toContain("1/2");
			expect(updates[2]).toContain("2/2");
		} finally {
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	test("stays silent for non-TTY output", () => {
		const writes: string[] = [];
		const progress = createCleanseProgressReporter({
			isTTY: false,
			write(text) {
				writes.push(text);
				return true;
			},
		});

		progress.start(1);
		progress.complete();
		progress.finish();

		expect(writes).toEqual([]);
	});
});

describe("cleanse orchestration", () => {
	test("dispatches no more than N agents once and verifies their combined edits", async () => {
		const initial = report([
			...fileDiagnostics("a.rs", 2),
			...fileDiagnostics("b.rs", 1),
			...fileDiagnostics("c.rs", 1),
		]);
		const clean = report([]);
		let dispatches = 0;
		let assignmentCount = 0;

		const result = await runCleanseLoop(
			{ maxAgents: 2, initialReport: initial },
			{
				collect: async () => clean,
				dispatch: async assignments => {
					dispatches += 1;
					assignmentCount = assignments.length;
					return assignments.map(
						(assignment, index): CleanseAgentOutcome => ({
							name: `CleanseW1A${index + 1}`,
							success: true,
							output: assignment.groups.map(group => group.file).join(", "),
						}),
					);
				},
			},
		);

		expect(dispatches).toBe(1);
		expect(assignmentCount).toBe(2);
		expect(result.status).toBe("clean");
		expect(result.report.diagnostics).toEqual([]);
	});

	test("reports unresolved diagnostics without spawning a second batch", async () => {
		const initial = report(fileDiagnostics("a.rs", 1));
		let dispatches = 0;

		const result = await runCleanseLoop(
			{ maxAgents: 8, initialReport: initial },
			{
				collect: async () => initial,
				dispatch: async () => {
					dispatches += 1;
					return [];
				},
			},
		);

		expect(dispatches).toBe(1);
		expect(result.status).toBe("stalled");
		expect(result.report.diagnostics).toHaveLength(1);
	});

	test("routes cleanse as a top-level command", () => {
		expect(resolveCliArgv(["cleanse", "-n", "4", "-m", "opus"])).toEqual({
			argv: ["cleanse", "-n", "4", "-m", "opus"],
		});
	});
});

function fileDiagnostics(file: string, count: number): CleanseDiagnostic[] {
	return Array.from({ length: count }, (_, index) => ({
		checker: "checker",
		file,
		line: index + 1,
		code: `E${index + 1}`,
		severity: "error",
		message: `problem ${index + 1}`,
		suggestion: "known fix",
	}));
}

function report(diagnostics: CleanseDiagnostic[]): CleanseDiagnosticReport {
	return {
		checks: [],
		diagnostics,
		skipped: [],
	};
}
