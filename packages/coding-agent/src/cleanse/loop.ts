import { balanceDiagnostics } from "./balance";
import type { CleanseAgentOutcome, CleanseAssignment, CleanseDiagnosticReport, CleanseLoopResult } from "./types";

/** Runtime seams for one bounded diagnose, dispatch, and verify pass. */
export interface CleanseLoopDependencies {
	collect(signal?: AbortSignal): Promise<CleanseDiagnosticReport>;
	dispatch(
		assignments: CleanseAssignment[],
		wave: number,
		report: CleanseDiagnosticReport,
		signal?: AbortSignal,
	): Promise<CleanseAgentOutcome[]>;
	onWave?(wave: number, assignments: readonly CleanseAssignment[]): void;
	onReport?(wave: number, report: CleanseDiagnosticReport): void;
}

/** Inputs controlling one complete cleanse loop. */
export interface CleanseLoopOptions {
	maxAgents: number;
	initialReport: CleanseDiagnosticReport;
	signal?: AbortSignal;
}

/** Dispatch at most `maxAgents` workers once, then verify their combined edits. */
export async function runCleanseLoop(
	options: CleanseLoopOptions,
	dependencies: CleanseLoopDependencies,
): Promise<CleanseLoopResult> {
	const initialReport = options.initialReport;
	if (initialReport.diagnostics.length === 0) {
		return { status: "clean", waves: 0, report: initialReport, outcomes: [] };
	}
	if (options.signal?.aborted) {
		return { status: "cancelled", waves: 0, report: initialReport, outcomes: [] };
	}
	const wave = 1;
	const assignments = balanceDiagnostics(initialReport.diagnostics, options.maxAgents);
	dependencies.onWave?.(wave, assignments);
	const outcomes = await dependencies.dispatch(assignments, wave, initialReport, options.signal);
	if (options.signal?.aborted) {
		return { status: "cancelled", waves: 1, report: initialReport, outcomes };
	}
	const report = await dependencies.collect(options.signal);
	dependencies.onReport?.(wave, report);
	return {
		status: report.diagnostics.length === 0 ? "clean" : "stalled",
		waves: 1,
		report,
		outcomes,
	};
}
