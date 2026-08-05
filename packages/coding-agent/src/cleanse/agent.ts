import { getProjectDir, prompt } from "@wxyhgk/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { mapWithConcurrencyLimitAllSettled } from "../task/parallel";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { ToolSession } from "../tools";
import { EventBus } from "../utils/event-bus";
import assignmentPrompt from "./prompts/assignment.md" with { type: "text" };
import type {
	CleanseAgentOutcome,
	CleanseAssignment,
	CleanseCheckResult,
	CleanseDiagnostic,
	CleanseDiagnosticReport,
	CleanseLoopResult,
} from "./types";

const MAX_DIAGNOSTIC_MESSAGE = 4_000;

/** Hooks used by the standalone command to render subagent lifecycle progress. */
export interface CleanseAgentHooks {
	onStart?(name: string, assignment: CleanseAssignment): void;
	onFinish?(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void;
}

/** Persisted parent session that dispatches file-disjoint cleanse workers. */
export interface CleanseAgentRuntime {
	readonly model: string;
	readonly sessionFile: string;
	dispatch(
		assignments: CleanseAssignment[],
		wave: number,
		report: CleanseDiagnosticReport,
		signal?: AbortSignal,
	): Promise<CleanseAgentOutcome[]>;
	close(result?: CleanseLoopResult): Promise<void>;
}

/** Resolve the requested model and create a fresh persisted cleanse session. */
export async function createCleanseAgentRuntime(options: {
	cwd?: string;
	model: string;
	hooks?: CleanseAgentHooks;
}): Promise<CleanseAgentRuntime> {
	const cwd = options.cwd ?? getProjectDir();
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const resolved = resolveCliModel({ cliModel: options.model, modelRegistry, settings });
	if (resolved.error || !resolved.model) {
		throw new Error(resolved.error ?? `未找到模型 "${options.model}"`);
	}
	const modelSelector = resolved.selector ?? formatModelString(resolved.model);
	const modelDisplay = formatModelString(resolved.model);
	const sessionManager = SessionManager.create(cwd);
	await sessionManager.setSessionName("Cleanse", "auto");
	sessionManager.appendCustomEntry("cleanse", {
		status: "running",
		model: modelDisplay,
		selector: options.model,
	});
	await sessionManager.ensureOnDisk();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("无法持久化清理会话");
	const eventBus = new EventBus();
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		suppressSpawnAdvisory: true,
		enableLsp: true,
		enableIrc: true,
		enableMCP: false,
		eventBus,
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionManager.getSessionId(),
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getArtifactManager: () => sessionManager.getArtifactManager(),
		getAgentId: () => MAIN_AGENT_ID,
		getSessionSpawns: () => "sonic",
		getModelString: () => modelSelector,
		getActiveModelString: () => modelSelector,
		getActiveModel: () => resolved.model,
		sessionManager,
		settings,
		authStorage,
		modelRegistry,
	};
	let closed = false;

	return {
		model: modelDisplay,
		sessionFile,
		async dispatch(
			assignments: CleanseAssignment[],
			wave: number,
			report: CleanseDiagnosticReport,
			signal?: AbortSignal,
		): Promise<CleanseAgentOutcome[]> {
			sessionManager.appendCustomEntry("cleanse_wave", {
				wave,
				assignments: assignments.map(assignment => ({
					weight: assignment.weight,
					files: assignment.groups.map(group => group.file ?? "<project>"),
				})),
			});
			const settled = await mapWithConcurrencyLimitAllSettled(
				assignments,
				assignments.length,
				async (assignment, index, workerSignal) => {
					const name = `CleanseW${wave}A${index + 1}`;
					options.hooks?.onStart?.(name, assignment);
					const result = await runStructuredSubagent({
						session: toolSession,
						invocationKind: "task",
						assignment: renderAssignment(assignment, assignments, wave, index + 1, report.checks),
						agent: "sonic",
						model: modelSelector,
						identity: { label: name },
						index,
						enableLsp: true,
						enableIrc: true,
						signal: workerSignal,
					});
					const outcome: CleanseAgentOutcome = {
						name,
						success: result.result.exitCode === 0 && !result.result.error && result.result.aborted !== true,
						output: result.result.output,
						error: result.result.error ?? (result.result.stderr || undefined),
						resolvedModel: result.result.resolvedModel,
					};
					options.hooks?.onFinish?.(outcome, assignment);
					return outcome;
				},
				signal,
			);
			const outcomes: CleanseAgentOutcome[] = [];
			for (let index = 0; index < settled.results.length; index += 1) {
				const result = settled.results[index];
				if (!result) {
					outcomes.push({ name: `CleanseW${wave}A${index + 1}`, success: false, output: "", error: "已取消" });
				} else if (result.status === "fulfilled") {
					outcomes.push(result.value);
				} else {
					const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
					const outcome = { name: `CleanseW${wave}A${index + 1}`, success: false, output: "", error };
					options.hooks?.onFinish?.(outcome, assignments[index]);
					outcomes.push(outcome);
				}
			}
			return outcomes;
		},
		async close(result?: CleanseLoopResult): Promise<void> {
			if (closed) return;
			closed = true;
			sessionManager.appendCustomEntry("cleanse", {
				status: result?.status ?? "interrupted",
				waves: result?.waves ?? 0,
				remaining: result?.report.diagnostics.length,
			});
			await sessionManager.close();
		},
	};
}

function renderAssignment(
	assignment: CleanseAssignment,
	allAssignments: readonly CleanseAssignment[],
	wave: number,
	worker: number,
	checks: readonly CleanseCheckResult[],
): string {
	const hasProjectIssues = assignment.groups.some(group => group.file === undefined);
	const files = assignment.groups.flatMap(group => (group.file ? [group.file] : []));
	const writeScope = [
		...(files.length > 0 ? files.map(file => `- ${file}`) : ["- No file is named by the project-level diagnostic."]),
		...(hasProjectIssues ? ["- Minimal additional files strictly required by project-level diagnostics."] : []),
	].join("\n");
	return prompt.render(assignmentPrompt, {
		wave,
		worker,
		write_scope: writeScope,
		diagnostics: formatDiagnostics(assignment.groups.flatMap(group => group.diagnostics)),
		checker_commands: formatCheckerCommands(checks),
		peer_assignments: formatPeerAssignments(assignment, allAssignments),
	});
}

function formatDiagnostics(diagnostics: readonly CleanseDiagnostic[]): string {
	return diagnostics
		.map(diagnostic => {
			const location = diagnostic.file
				? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`
				: "<project>";
			const code = diagnostic.code ? ` ${diagnostic.code}` : "";
			const message = diagnostic.message.slice(0, MAX_DIAGNOSTIC_MESSAGE);
			const suggestion = diagnostic.suggestion ? `\n  Suggested fix: ${diagnostic.suggestion}` : "";
			return `- [${diagnostic.severity}] ${location} — ${diagnostic.checker}${code}: ${message}${suggestion}`;
		})
		.join("\n");
}

function formatCheckerCommands(checks: readonly CleanseCheckResult[]): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const check of checks) {
		const key = `${check.cwd}\u0000${check.command}`;
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(`- [${check.cwd}] ${check.command}`);
	}
	return lines.join("\n") || "- No command metadata available.";
}

function formatPeerAssignments(current: CleanseAssignment, assignments: readonly CleanseAssignment[]): string {
	const lines: string[] = [];
	for (const assignment of assignments) {
		if (assignment.index === current.index) continue;
		const files = assignment.groups.map(group => group.file ?? "<project-level>").join(", ");
		lines.push(`- Worker ${assignment.index + 1}: ${files}`);
	}
	return lines.join("\n") || "- None.";
}
