import type { CleanseAssignment, CleanseDiagnostic, CleanseFileIssues, CleanseSeverity } from "./types";

const SEVERITY_WEIGHT: Record<CleanseSeverity, number> = {
	error: 5,
	warning: 3,
	info: 1,
};

/** Estimate repair burden from severity and available location/fix evidence. */
export function diagnosticWeight(diagnostic: CleanseDiagnostic): number {
	let weight = SEVERITY_WEIGHT[diagnostic.severity];
	if (diagnostic.line === undefined) weight += 2;
	if (!diagnostic.code) weight += 1;
	if (!diagnostic.suggestion) weight += 1;
	return weight;
}

/** Group diagnostics by file while keeping project-level failures together. */
export function groupDiagnosticsByFile(diagnostics: readonly CleanseDiagnostic[]): CleanseFileIssues[] {
	const groups = new Map<string, CleanseDiagnostic[]>();
	for (const diagnostic of diagnostics) {
		const key = diagnostic.file ?? "";
		const existing = groups.get(key);
		if (existing) existing.push(diagnostic);
		else groups.set(key, [diagnostic]);
	}
	return [...groups.entries()]
		.map(([file, entries]) => ({
			file: file || undefined,
			diagnostics: entries.sort(compareDiagnostics),
			weight: entries.reduce((sum, diagnostic) => sum + diagnosticWeight(diagnostic), 0),
		}))
		.sort((left, right) => right.weight - left.weight || (left.file ?? "").localeCompare(right.file ?? ""));
}

/** Balance whole-file workloads with longest-processing-time bin packing. */
export function balanceDiagnostics(diagnostics: readonly CleanseDiagnostic[], maxAgents: number): CleanseAssignment[] {
	if (!Number.isInteger(maxAgents) || maxAgents <= 0) {
		throw new Error("maxAgents 必须为正整数");
	}
	const groups = groupDiagnosticsByFile(diagnostics);
	if (groups.length === 0) return [];
	const count = Math.min(maxAgents, groups.length);
	const assignments: CleanseAssignment[] = Array.from({ length: count }, (_, index) => ({
		index,
		groups: [],
		weight: 0,
	}));
	for (const group of groups) {
		let lightest = assignments[0];
		for (let index = 1; index < assignments.length; index += 1) {
			const candidate = assignments[index];
			if (
				candidate.weight < lightest.weight ||
				(candidate.weight === lightest.weight && candidate.groups.length < lightest.groups.length) ||
				(candidate.weight === lightest.weight &&
					candidate.groups.length === lightest.groups.length &&
					candidate.index < lightest.index)
			) {
				lightest = candidate;
			}
		}
		lightest.groups.push(group);
		lightest.weight += group.weight;
	}
	for (const assignment of assignments) {
		assignment.groups.sort((left, right) => (left.file ?? "").localeCompare(right.file ?? ""));
	}
	return assignments;
}

function compareDiagnostics(left: CleanseDiagnostic, right: CleanseDiagnostic): number {
	return (
		(left.line ?? 0) - (right.line ?? 0) ||
		(left.column ?? 0) - (right.column ?? 0) ||
		left.checker.localeCompare(right.checker) ||
		left.message.localeCompare(right.message)
	);
}
