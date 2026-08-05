import { getProjectDir, sanitizeText } from "@wxyhgk/pi-utils";
import { shortenPath } from "../tools/render-utils";
import { type CleanseAgentRuntime, createCleanseAgentRuntime } from "./agent";
import { groupDiagnosticsByFile } from "./balance";
import { discoverCleanseDiagnosticSuite } from "./checkers";
import { runCleanseLoop } from "./loop";
import { createCleanseProgressReporter } from "./progress";
import type { CleanseAgentOutcome, CleanseAssignment, CleanseDiagnosticReport, CleanseLoopResult } from "./types";

const DEFAULT_MODEL = "@smol";
const DISPLAY_FILE_LIMIT = 50;

/** User-facing options for `omp cleanse`. */
export interface CleanseCommandOptions {
	maxAgents?: number;
	model?: string;
	includeTests?: boolean;
}

/** Observable completion state returned to the CLI adapter. */
export interface CleanseCommandResult {
	exitCode: number;
	status: "clean" | "unresolved" | "unsupported" | "cancelled";
	report: CleanseDiagnosticReport;
	sessionFile?: string;
}

/** Detect project diagnostics, dispatch one bounded repair batch, and verify it. */
export async function runCleanseCommand(options: CleanseCommandOptions = {}): Promise<CleanseCommandResult> {
	const maxAgents = options.maxAgents ?? 8;
	if (!Number.isInteger(maxAgents) || maxAgents <= 0) throw new Error("--agents 必须为正整数");
	const model = options.model?.trim() || DEFAULT_MODEL;
	const cwd = getProjectDir();
	const abortController = new AbortController();
	const abort = (): void => abortController.abort(new Error("清理已中断"));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let runtime: CleanseAgentRuntime | undefined;
	let loopResult: CleanseLoopResult | undefined;
	const progress = createCleanseProgressReporter();
	const interactiveFailures: CleanseAgentOutcome[] = [];
	let interactiveFailuresPrinted = false;
	const printInteractiveFailures = (): void => {
		if (!progress.interactive || interactiveFailuresPrinted) return;
		interactiveFailuresPrinted = true;
		for (const outcome of interactiveFailures) printAgentOutcome(outcome);
	};

	try {
		process.stdout.write("正在检测已配置的项目检查器...\n");
		const suite = await discoverCleanseDiagnosticSuite(cwd, { includeTests: options.includeTests });
		if (suite.checkCount === 0) {
			const report: CleanseDiagnosticReport = { checks: [], diagnostics: [], skipped: [...suite.skipped] };
			printSkippedChecks(report);
			process.stderr.write("未找到带有可用可执行文件的支持检查器。\n");
			return { exitCode: 1, status: "unsupported", report };
		}
		const initialReport = await suite.run(abortController.signal);
		printCheckReport(initialReport);
		if (initialReport.diagnostics.length === 0) {
			process.stdout.write(
				`干净:${initialReport.checks.length} 个检查器全部通过。\n`,
			);
			return { exitCode: 0, status: "clean", report: initialReport };
		}

		const assignments = groupDiagnosticsByFile(initialReport.diagnostics);
		const agentCount = Math.min(maxAgents, assignments.length);
		const fileCount = assignments.filter(group => group.file !== undefined).length;
		process.stdout.write(
			`在 ${fileCount} 个文件中发现 ${initialReport.diagnostics.length} 条诊断;正在启动 ${agentCount} 个子 Agent。\n`,
		);
		process.stdout.write(`正在解析模型 ${model}...\n`);
		const activeRuntime = await createCleanseAgentRuntime({
			cwd,
			model,
			hooks: {
				onStart(name, assignment) {
					if (progress.interactive) return;
					process.stdout.write(
						`[开始] ${name}:${formatAssignmentFiles(assignment)}(权重 ${assignment.weight})\n`,
					);
				},
				onFinish(outcome) {
					progress.complete();
					if (progress.interactive) {
						if (!outcome.success) interactiveFailures.push(outcome);
						return;
					}
					printAgentOutcome(outcome);
				},
			},
		});
		runtime = activeRuntime;
		process.stdout.write(`模型:${activeRuntime.model}\n会话:${shortenPath(activeRuntime.sessionFile)}\n`);
		loopResult = await runCleanseLoop(
			{ maxAgents, initialReport, signal: abortController.signal },
			{
				collect: signal => suite.run(signal),
				dispatch: (batch, wave, report, signal) => activeRuntime.dispatch(batch, wave, report, signal),
				onWave(_wave, batch) {
					process.stdout.write(
						`正在分派 ${batch.length} 个加权任务...\n`,
					);
					progress.start(batch.length);
				},
				onReport(_wave, report) {
					progress.finish();
					printInteractiveFailures();
					process.stdout.write(
						`验证:剩余 ${report.diagnostics.length} 条诊断。\n`,
					);
				},
			},
		);
		progress.finish();
		printInteractiveFailures();
		await activeRuntime.close(loopResult);
		if (loopResult.status === "cancelled") {
			process.stderr.write("清理已取消。\n");
			return {
				exitCode: 130,
				status: "cancelled",
				report: loopResult.report,
				sessionFile: activeRuntime.sessionFile,
			};
		}
		if (loopResult.status === "clean") {
			process.stdout.write("干净:所有检测到的诊断均已解决。\n");
			return { exitCode: 0, status: "clean", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
		}
		printRemaining(loopResult.report);
		return { exitCode: 1, status: "unresolved", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
	} catch (error) {
		if (!abortController.signal.aborted) throw error;
		const report: CleanseDiagnosticReport = loopResult?.report ?? { checks: [], diagnostics: [], skipped: [] };
		progress.finish();
		printInteractiveFailures();
		process.stderr.write("清理已取消。\n");
		return { exitCode: 130, status: "cancelled", report, sessionFile: runtime?.sessionFile };
	} finally {
		progress.finish();
		printInteractiveFailures();
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
		await runtime?.close(loopResult);
	}
}

function printAgentOutcome(outcome: CleanseAgentOutcome): void {
	if (outcome.success) {
		process.stdout.write(`[完成] ${outcome.name}${outcome.resolvedModel ? ` (${outcome.resolvedModel})` : ""}\n`);
		return;
	}
	const error = sanitizeText(outcome.error ?? "子 Agent 失败")
		.replace(/\s+/g, " ")
		.slice(0, 300);
	process.stderr.write(`[失败] ${outcome.name}:${error}\n`);
}

function printCheckReport(report: CleanseDiagnosticReport): void {
	for (const check of report.checks) {
		const count = check.diagnostics.length;
		process.stdout.write(`- ${check.label}:${count === 0 ? "通过" : `${count} 个问题`}\n`);
	}
	printSkippedChecks(report);
}

function printSkippedChecks(report: CleanseDiagnosticReport): void {
	for (const skipped of report.skipped) {
		process.stdout.write(`- ${skipped.label}:已跳过(${skipped.reason})\n`);
	}
}

function formatAssignmentFiles(assignment: CleanseAssignment): string {
	return assignment.groups.map(group => group.file ?? "<项目>").join(", ");
}

function printRemaining(report: CleanseDiagnosticReport): void {
	const groups = groupDiagnosticsByFile(report.diagnostics);
	process.stderr.write(
		`未解决:${report.diagnostics.length} 条诊断。\n`,
	);
	for (const group of groups.slice(0, DISPLAY_FILE_LIMIT)) {
		process.stderr.write(`- ${group.file ?? "<项目>"}:${group.diagnostics.length}\n`);
	}
	if (groups.length > DISPLAY_FILE_LIMIT) {
		process.stderr.write(`- ... 还有 ${groups.length - DISPLAY_FILE_LIMIT} 个文件\n`);
	}
}
