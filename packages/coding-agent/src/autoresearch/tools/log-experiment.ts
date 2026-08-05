import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@wxyhgk/omptype";
import { Text } from "@wxyhgk/pi-tui";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { computeRunModifiedPaths, getCurrentAutoresearchBranch, parseWorkDirDirtyPaths } from "../git";
import {
	ensureNumericMetricMap,
	formatNum,
	mergeAsi,
	pathMatchesSpec,
	sanitizeAsi,
	tryGitPrefix,
	tryGitStatus,
} from "../helpers";
import {
	buildExperimentState,
	computeConfidence,
	currentResults,
	findBaselineSecondary,
	findBestKeptMetric,
} from "../state";
import { openAutoresearchStorageIfExists, type SessionRow } from "../storage";
import type {
	ASIData,
	AutoresearchToolFactoryOptions,
	ExperimentResult,
	ExperimentState,
	LogDetails,
	NumericMetricMap,
} from "../types";

const EXPERIMENT_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment", "update_notes"];

const logExperimentSchema = type({
	metric: type("number").describe("主指标值"),
	status: type("'keep'|'discard'|'crash'|'checks_failed'").describe("运行结果"),
	description: type("string").describe("简短的运行描述"),
	"metrics?": type({ "[string]": "number" }).describe("次要指标"),
	"asi?": type({ "[string]": "unknown" }).describe("自由格式的结构化元数据"),
	"commit?": type("string").describe("覆盖已记录的提交哈希"),
	"justification?": type("string").describe("保留越界运行时的必填项"),
	"flag_runs?": type({
		run_id: type("number.integer").describe("要标记的运行 ID"),
		reason: type("string").describe("为何怀疑该运行"),
	})
		.array()
		.describe("将更早的运行标记为可疑"),
});

export function createLogExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof logExperimentSchema, LogDetails> {
	return {
		name: "log_experiment",
		label: "记录实验",
		description:
			"Log the result of the latest run_experiment. Records the metric, optional ASI metadata, modified paths, and scope deviations. On `keep`, modified files are committed; on `discard`/`crash`/`checks_failed`, the worktree is reverted. Pass `flag_runs` to mark earlier runs as suspect; flagged runs are excluded from baseline and best-metric math.",
		parameters: logExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			const currentBranch = (await git.branch.current(ctx.cwd)) ?? null;
			const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
			if (!storage || !session) {
				return {
					content: [
						{
							type: "text",
							text: "错误:当前分支没有活动的 autoresearch 会话。请先调用 init_experiment。",
						},
					],
				};
			}
			const pendingRun = storage.getPendingRun(session.id);
			if (!pendingRun) {
				return {
					content: [{ type: "text", text: "错误:没有可用的待处理运行。请先运行 run_experiment。" }],
				};
			}

			const runtime = options.getRuntime(ctx);

			const flaggedRuns: LogDetails["flaggedRuns"] = [];
			for (const flag of params.flag_runs ?? []) {
				const target = storage.getRunById(flag.run_id);
				if (!target || target.sessionId !== session.id) continue;
				storage.flagRun(flag.run_id, flag.reason);
				flaggedRuns.push({ runId: flag.run_id, reason: flag.reason });
			}

			const branchName = await getCurrentAutoresearchBranch(options.pi, ctx.cwd);
			const onAutoresearchBranch = branchName !== null;

			let allModified: string[];
			if (onAutoresearchBranch) {
				// On a dedicated autoresearch branch every iteration starts from a clean
				// worktree (init_experiment baseline + previous keep commit / discard reset),
				// so any currently-dirty path is the agent's iteration change. Off-branch we
				// can't tell user dirt apart from agent edits, so we keep the (lossy)
				// preRunDirtyPaths filter.
				const statusText = await tryGitStatus(ctx.cwd);
				const workDirPrefix = await tryGitPrefix(ctx.cwd);
				allModified = parseWorkDirDirtyPaths(statusText, workDirPrefix);
			} else {
				const { modifiedTracked, modifiedUntracked } = await detectModifiedPaths(
					ctx.cwd,
					pendingRun.preRunDirtyPaths,
				);
				allModified = [...modifiedTracked, ...modifiedUntracked];
			}
			const scopeDeviations = computeScopeDeviations(allModified, session);

			const justification = params.justification?.trim() || null;
			const warnings: string[] = [];

			const headSha = await tryReadHeadSha(ctx.cwd);
			const explicitCommit = params.commit?.trim();
			let commitHash = explicitCommit && explicitCommit.length > 0 ? explicitCommit : headSha;

			let gitNote: string | null = null;
			if (params.status === "keep") {
				if (onAutoresearchBranch && allModified.length > 0) {
					const commitResult = await commitKeptExperiment(
						ctx.cwd,
						params.description,
						params.status,
						params.metric,
						params.metrics ?? {},
						allModified,
						session.primaryMetric,
					);
					if (commitResult.error) {
						return {
							content: [{ type: "text", text: `Error: ${commitResult.error}` }],
						};
					}
					gitNote = commitResult.note ?? null;
					const newSha = await tryReadHeadSha(ctx.cwd);
					if (newSha) commitHash = newSha;
				} else if (!onAutoresearchBranch) {
					warnings.push("已跳过自动提交:当前不在专用 autoresearch 分支上。修改的文件仍保留在工作区中。");
				} else if (allModified.length === 0) {
					gitNote = "无可提交内容";
				}
				if (scopeDeviations.length > 0) {
					if (justification === null) {
						warnings.push(
							`保留的越界修改未说明理由:${scopeDeviations.join(", ")}。下次请传入 \`justification\`,或在之后的 log_experiment 中用 \`flag_runs\` 标记该条目(如果是失误的话)。`,
						);
					} else {
						warnings.push(`保留的越界修改(已说明理由):${scopeDeviations.join(", ")}`);
					}
				}
			} else {
				const revertResult = await revertFailedExperiment(
					ctx.cwd,
					pendingRun.preRunDirtyPaths,
					onAutoresearchBranch,
				);
				if (revertResult.error) {
					return {
						content: [{ type: "text", text: `Error: ${revertResult.error}` }],
					};
				}
				gitNote = revertResult.note ?? null;
			}

			const metric = params.metric;
			const secondaryMetrics: NumericMetricMap = mergeMetrics(
				pendingRun.parsedMetrics,
				params.metrics,
				session.primaryMetric,
			);
			const asi: ASIData | undefined = mergeAsi(pendingRun.parsedAsi, sanitizeAsi(params.asi));

			if (pendingRun.parsedPrimary !== null && metric !== pendingRun.parsedPrimary) {
				warnings.push(`记录的指标 ${metric} 与解析出的主指标 ${pendingRun.parsedPrimary} 不同。两个值均已存储。`);
			}

			const loggedAt = Date.now();
			const tentativeRun = storage.markRunLogged({
				runId: pendingRun.id,
				status: params.status,
				description: params.description,
				metric,
				metrics: secondaryMetrics,
				asi: asi ?? null,
				commitHash,
				confidence: null,
				modifiedPaths: allModified,
				scopeDeviations,
				justification,
				loggedAt,
			});

			// Recompute confidence with this run included
			const refreshedSession = storage.getSessionById(session.id) ?? session;
			const loggedRuns = storage.listLoggedRuns(session.id);
			const stateForConfidence = buildExperimentState(refreshedSession, loggedRuns);
			const confidence = computeConfidence(
				stateForConfidence.results,
				stateForConfidence.currentSegment,
				stateForConfidence.bestDirection,
			);
			storage.updateRunConfidence(tentativeRun.id, confidence);

			const finalState = buildExperimentState(refreshedSession, storage.listLoggedRuns(session.id));
			runtime.state = finalState;
			runtime.runningExperiment = null;
			runtime.lastRunSummary = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = null;
			runtime.lastRunNumber = null;
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;

			const experiment: ExperimentResult = {
				runNumber: tentativeRun.id,
				commit: (commitHash ?? "").slice(0, 12),
				metric,
				metrics: secondaryMetrics,
				status: params.status,
				description: params.description,
				timestamp: loggedAt,
				segment: pendingRun.segment,
				confidence,
				asi,
				modifiedPaths: allModified,
				scopeDeviations,
				justification,
				flagged: false,
				flaggedReason: null,
			};

			const segmentRunCount = currentResults(finalState.results, finalState.currentSegment).length;
			if (finalState.maxExperiments !== null && segmentRunCount >= finalState.maxExperiments) {
				runtime.autoresearchMode = false;
				options.pi.appendEntry(
					"autoresearch-control",
					runtime.goal ? { mode: "off", goal: runtime.goal } : { mode: "off" },
				);
				await options.pi.setActiveTools(
					options.pi.getActiveTools().filter(name => !EXPERIMENT_TOOL_NAMES.includes(name)),
				);
			}

			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const wallClockSeconds = pendingRun.durationMs !== null ? pendingRun.durationMs / 1000 : null;
			const text = buildLogText(
				finalState,
				experiment,
				segmentRunCount,
				wallClockSeconds,
				gitNote,
				warnings,
				flaggedRuns,
			);

			return {
				content: [{ type: "text", text }],
				details: {
					experiment,
					state: finalState,
					wallClockSeconds,
					scopeDeviations,
					justification,
					flaggedRuns,
				},
			};
		},
		renderCall(args, _options, theme): Text {
			const color = args.status === "keep" ? "success" : args.status === "discard" ? "warning" : "error";
			const description = truncateToWidth(replaceTabs(args.description), 100);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("log_experiment"))} ${theme.fg(color, args.status)} ${theme.fg("muted", description)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme): Text {
			const details = result.details;
			if (!details) {
				return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
			}
			return new Text(renderSummary(details, theme), 0, 0);
		},
	};
}

interface KeepCommitResult {
	error?: string;
	note?: string;
}

async function commitKeptExperiment(
	cwd: string,
	description: string,
	status: ExperimentResult["status"],
	metric: number,
	metrics: NumericMetricMap,
	files: string[],
	primaryMetric: string,
): Promise<KeepCommitResult> {
	if (files.length === 0) return { note: "无可提交内容" };
	try {
		await git.stage.files(cwd, files);
	} catch (err) {
		return { error: `git add 失败:${err instanceof Error ? err.message : String(err)}` };
	}
	if (!(await git.diff.has(cwd, { cached: true, files }))) {
		return { note: "无可提交内容" };
	}
	const payload: { [key: string]: string | number } = {
		status,
		[primaryMetric]: metric,
	};
	for (const [name, value] of Object.entries(metrics)) {
		payload[name] = value;
	}
	const commitMessage = `${description}\n\n结果:${JSON.stringify(payload)}`;
	try {
		const commitResult = await git.commit(cwd, commitMessage, { files });
		const summary = `${commitResult.stdout}${commitResult.stderr}`.split("\n").find(line => line.trim().length > 0);
		return { note: summary?.trim() ?? "已提交" };
	} catch (err) {
		return { error: `git commit 失败:${err instanceof Error ? err.message : String(err)}` };
	}
}

async function revertFailedExperiment(
	cwd: string,
	preRunDirtyPaths: string[],
	onAutoresearchBranch: boolean,
): Promise<KeepCommitResult> {
	if (onAutoresearchBranch) {
		// Discard reverts only the current iteration's uncommitted changes — never
		// rewinds prior `keep` commits. Reset to HEAD so any kept improvements
		// already on the branch survive.
		try {
			await git.reset(cwd, { hard: true, target: "HEAD" });
			await git.clean(cwd);
			return { note: "工作区已重置到 HEAD" };
		} catch (err) {
			return { error: `git reset/clean 失败:${err instanceof Error ? err.message : String(err)}` };
		}
	}

	const statusText = await tryGitStatus(cwd);
	const workDirPrefix = await tryGitPrefix(cwd);
	const { tracked, untracked } = computeRunModifiedPaths(preRunDirtyPaths, statusText, workDirPrefix);
	const total = tracked.length + untracked.length;
	if (total === 0) return { note: "无可还原内容" };
	if (tracked.length > 0) {
		try {
			await git.restore(cwd, { files: tracked, source: "HEAD", staged: true, worktree: true });
		} catch (err) {
			return { error: `git restore 失败:${err instanceof Error ? err.message : String(err)}` };
		}
	}
	for (const filePath of untracked) {
		try {
			fs.rmSync(path.join(cwd, filePath), { force: true, recursive: true });
		} catch {
			// best effort
		}
	}
	return { note: `已还原 ${total} 个文件` };
}

async function detectModifiedPaths(
	cwd: string,
	preRunDirtyPaths: string[],
): Promise<{ modifiedTracked: string[]; modifiedUntracked: string[] }> {
	const statusText = await tryGitStatus(cwd);
	const workDirPrefix = await tryGitPrefix(cwd);
	const { tracked, untracked } = computeRunModifiedPaths(preRunDirtyPaths, statusText, workDirPrefix);
	return { modifiedTracked: tracked, modifiedUntracked: untracked };
}

function computeScopeDeviations(modifiedPaths: string[], session: SessionRow): string[] {
	const deviations: string[] = [];
	for (const filePath of modifiedPaths) {
		if (session.offLimits.some(spec => pathMatchesSpec(filePath, spec))) {
			deviations.push(filePath);
			continue;
		}
		if (session.scopePaths.length > 0 && !session.scopePaths.some(spec => pathMatchesSpec(filePath, spec))) {
			deviations.push(filePath);
		}
	}
	return deviations;
}

function mergeMetrics(
	parsed: NumericMetricMap | null,
	overrides: NumericMetricMap | undefined,
	primaryMetricName: string,
): NumericMetricMap {
	const merged: NumericMetricMap = {};
	for (const [name, value] of Object.entries(parsed ?? {})) {
		if (name === primaryMetricName) continue;
		merged[name] = value;
	}
	for (const [name, value] of Object.entries(ensureNumericMetricMap(overrides))) {
		merged[name] = value;
	}
	return merged;
}

async function tryReadHeadSha(cwd: string): Promise<string | null> {
	try {
		return (await git.head.sha(cwd)) ?? null;
	} catch {
		return null;
	}
}

function buildLogText(
	state: ExperimentState,
	experiment: ExperimentResult,
	segmentRunCount: number,
	wallClockSeconds: number | null,
	gitNote: string | null,
	warnings: string[],
	flaggedRuns: LogDetails["flaggedRuns"],
): string {
	const displayRunNumber = experiment.runNumber ?? state.results.length;
	const lines = [`已记录运行 #${displayRunNumber}:${experiment.status} - ${experiment.description}`];
	if (wallClockSeconds !== null) {
		lines.push(`实际耗时:${wallClockSeconds.toFixed(1)}s`);
	}
	if (state.bestMetric !== null) {
		lines.push(`基线 ${state.metricName}:${formatNum(state.bestMetric, state.metricUnit)}`);
	}
	if (segmentRunCount > 1 && state.bestMetric !== null && experiment.metric !== state.bestMetric) {
		const delta = ((experiment.metric - state.bestMetric) / state.bestMetric) * 100;
		const sign = delta > 0 ? "+" : "";
		lines.push(`本次运行:${formatNum(experiment.metric, state.metricUnit)} (${sign}${delta.toFixed(1)}%)`);
	} else {
		lines.push(`本次运行:${formatNum(experiment.metric, state.metricUnit)}`);
	}
	if (Object.keys(experiment.metrics).length > 0) {
		const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
		const parts = Object.entries(experiment.metrics).map(([name, value]) => {
			const unit = state.secondaryMetrics.find(metric => metric.name === name)?.unit ?? "";
			const baseline = baselineSecondary[name];
			if (baseline === undefined || baseline === 0 || segmentRunCount === 1) {
				return `${name}: ${formatNum(value, unit)}`;
			}
			const delta = ((value - baseline) / baseline) * 100;
			const sign = delta > 0 ? "+" : "";
			return `${name}: ${formatNum(value, unit)} (${sign}${delta.toFixed(1)}%)`;
		});
		lines.push(`次要指标:${parts.join("  ")}`);
	}
	const bestKept = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection);
	if (bestKept !== null && state.bestMetric !== null && bestKept !== state.bestMetric) {
		lines.push(`最佳保留 ${state.metricName}:${formatNum(bestKept, state.metricUnit)}`);
	}
	if (experiment.asi) {
		const asiSummary = Object.entries(experiment.asi)
			.map(([key, value]) => `${key}: ${truncateAsiValue(value)}`)
			.join(" | ");
		lines.push(`ASI: ${asiSummary}`);
	}
	if (state.confidence !== null) {
		const status = state.confidence >= 2 ? "很可能真实" : state.confidence >= 1 ? "边缘" : "在噪声范围内";
		lines.push(`置信度:${state.confidence.toFixed(1)}x 噪声底(${status})`);
	}
	if (gitNote) {
		lines.push(`Git:${gitNote}`);
	}
	if (state.maxExperiments !== null) {
		lines.push(`进度:当前分段 ${segmentRunCount}/${state.maxExperiments} 次运行`);
		if (segmentRunCount >= state.maxExperiments) {
			lines.push(`已达到最大实验次数(${state.maxExperiments})。Autoresearch 模式现已关闭。`);
		}
	}
	if (flaggedRuns.length > 0) {
		const formatted = flaggedRuns.map(({ runId, reason }) => `#${runId} (${reason})`).join(", ");
		lines.push(`已标记:${formatted}`);
	}
	for (const warning of warnings) {
		lines.push(`警告:${warning}`);
	}
	return lines.join("\n");
}

function truncateAsiValue(value: ASIData[string]): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function renderSummary(details: LogDetails, theme: Theme): string {
	const { experiment, state } = details;
	const color = experiment.status === "keep" ? "success" : experiment.status === "discard" ? "warning" : "error";
	let summary = `${theme.fg(color, experiment.status.toUpperCase())} ${theme.fg("muted", truncateToWidth(replaceTabs(experiment.description), 100))}`;
	summary += ` ${theme.fg("accent", `${state.metricName}=${formatNum(experiment.metric, state.metricUnit)}`)}`;
	if (state.bestMetric !== null) {
		summary += ` ${theme.fg("dim", `基线 ${formatNum(state.bestMetric, state.metricUnit)}`)}`;
	}
	if (state.confidence !== null) {
		summary += ` ${theme.fg("dim", `置信 ${state.confidence.toFixed(1)}x`)}`;
	}
	if (details.scopeDeviations.length > 0) {
		summary += ` ${theme.fg("warning", `越界:${details.scopeDeviations.length}`)}`;
	}
	return summary;
}
