import * as path from "node:path";
import { type } from "@wxyhgk/omptype";
import { Text } from "@wxyhgk/pi-tui";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths } from "../git";
import { dedupeStrings, normalizePathSpec } from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorage, type SessionRow } from "../storage";
import type { AutoresearchToolFactoryOptions, ExperimentState } from "../types";

export const HARNESS_FILENAME = "autoresearch.sh";
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;
const HARNESS_COMMIT_TITLE = "autoresearch: 环境设置";

const initExperimentSchema = type({
	name: type("string").describe("实验名称"),
	"goal?": type("string").describe("会话目标"),
	primary_metric: type("string").describe("主指标名称"),
	"metric_unit?": type("string").describe("指标单位(例如 ms、µs、mb)"),
	"direction?": type("'lower' | 'higher'").describe("更优方向(默认 lower)"),
	"secondary_metrics?": type("string[]").describe("次要指标名称"),
	"scope_paths?": type("string[]").describe("预计会被修改的路径"),
	"off_limits?": type("string[]").describe("禁止修改的路径"),
	"constraints?": type("string[]").describe("自由格式约束"),
	"max_iterations?": type("number").describe("每分段的软迭代上限"),
	"new_segment?": type("boolean").describe("在现有会话中开启新分段"),
});

interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

export function createInitExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof initExperimentSchema, InitExperimentDetails> {
	return {
		name: "init_experiment",
		label: "初始化实验",
		description:
			"Initialize or reconfigure the autoresearch session. On first call (Phase 1 → Phase 2 transition), requires `./autoresearch.sh` to exist and pending harness changes are auto-committed on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.",
		parameters: initExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorage(ctx.cwd);
			const runtime = options.getRuntime(ctx);

			const direction = params.direction ?? "lower";
			const metricUnit = params.metric_unit ?? "";
			const scopePaths = dedupeStrings((params.scope_paths ?? []).map(normalizePathSpec));
			const offLimits = dedupeStrings((params.off_limits ?? []).map(normalizePathSpec));
			const constraints = dedupeStrings(params.constraints ?? []);
			const secondaryMetrics = dedupeStrings(params.secondary_metrics ?? []);
			const goal = params.goal?.trim() || null;
			const maxIterations =
				params.max_iterations !== undefined && Number.isFinite(params.max_iterations) && params.max_iterations > 0
					? Math.floor(params.max_iterations)
					: null;
			const branch = (await git.branch.current(ctx.cwd)) ?? null;
			const onAutoresearchBranch = branch?.startsWith("autoresearch/") ?? false;

			const existing = storage.getActiveSessionForBranch(branch);
			const isNewSegmentInit = existing !== null && params.new_segment === true;
			const requiresHarness = !existing || isNewSegmentInit;

			if (requiresHarness) {
				const harnessExists = await Bun.file(path.join(ctx.cwd, HARNESS_FILENAME)).exists();
				if (!harnessExists) {
					return {
						content: [
							{
								type: "text",
								text: `错误:./${HARNESS_FILENAME} 不存在。autoresearch 的第一阶段是环境搭建 — 请编写 \`./${HARNESS_FILENAME}\`,使其以 0 退出并打印 \`METRIC <name>=<value>\`,通过 \`bash ${HARNESS_FILENAME}\` 验证后,再次调用 init_experiment。`,
							},
						],
					};
				}
			}

			let harnessCommitted = false;
			let commitWarning: string | null = null;
			if (requiresHarness && onAutoresearchBranch) {
				const dirty = await detectPendingChanges(ctx.cwd);
				if (dirty) {
					try {
						await git.stage.files(ctx.cwd, []);
						const message = buildHarnessCommitMessage(goal, params.name);
						await git.commit(ctx.cwd, message);
						harnessCommitted = true;
					} catch (err) {
						commitWarning = `自动提交环境更改失败:${err instanceof Error ? err.message : String(err)}。将在当前 HEAD 记录基线;discard 可能无法保留未提交的环境文件。`;
					}
				}
			}

			const baselineCommit = await tryReadHeadSha(ctx.cwd);

			let session: SessionRow;
			let createdSession = false;
			let bumpedSegment = false;
			let abandonedRuns = 0;

			if (!existing) {
				session = storage.openSession({
					name: params.name,
					goal,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					preferredCommand: DEFAULT_HARNESS_COMMAND,
					branch,
					baselineCommit,
					maxIterations,
					scopePaths,
					offLimits,
					constraints,
					secondaryMetrics,
				});
				createdSession = true;
			} else {
				abandonedRuns = storage.abandonPendingRuns(existing.id);
				const updates: Parameters<typeof storage.updateSession>[1] = {
					goal,
					maxIterations,
					scopePaths,
					offLimits,
					constraints,
					secondaryMetrics,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					branch,
				};
				if (isNewSegmentInit) {
					updates.baselineCommit = baselineCommit;
				}
				let updated = storage.updateSession(existing.id, updates);
				if (isNewSegmentInit) {
					updated = storage.bumpSegment(existing.id);
					bumpedSegment = true;
				}
				session = updated;
			}

			const loggedRuns = storage.listLoggedRuns(session.id);
			const state = buildExperimentState(session, loggedRuns);
			runtime.state = state;
			runtime.goal = session.goal;
			runtime.autoresearchMode = true;
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = null;
			runtime.lastRunNumber = null;
			runtime.lastRunSummary = null;
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const lines: string[] = [];
			if (abandonedRuns > 0) {
				lines.push(`重新配置前已放弃 ${abandonedRuns} 个待处理运行。`);
			}
			if (harnessCommitted && session.baselineCommit) {
				lines.push(`已在 ${session.baselineCommit.slice(0, 12)} 提交环境设置。`);
			}
			if (commitWarning) {
				lines.push(commitWarning);
			}
			if (createdSession) {
				lines.push(`已开始会话 #${session.id}:${session.name}`);
			} else if (bumpedSegment) {
				lines.push(`已将会话 #${session.id} 推进到分段 ${session.currentSegment}:${session.name}`);
			} else {
				lines.push(`已更新会话 #${session.id}(分段 ${session.currentSegment}):${session.name}`);
			}
			lines.push(
				`指标:${session.primaryMetric} (${session.metricUnit || "无单位"},${session.direction} 更优)`,
			);
			lines.push(`基准入口:${DEFAULT_HARNESS_COMMAND}`);
			if (session.scopePaths.length > 0) {
				lines.push(`范围内文件:${session.scopePaths.join(", ")}`);
			}
			if (session.offLimits.length > 0) {
				lines.push(`禁止范围:${session.offLimits.join(", ")}`);
			}
			if (session.maxIterations !== null) {
				lines.push(`每分段最大迭代次数:${session.maxIterations}`);
			}
			if (session.branch) {
				lines.push(`当前分支:${session.branch}`);
			}
			if (session.baselineCommit) {
				lines.push(`基线提交:${session.baselineCommit.slice(0, 12)}`);
			}
			if (createdSession) {
				lines.push(
					"第二阶段:迭代循环已激活。使用 `run_experiment` 运行基线实验并记录它。",
				);
			} else if (bumpedSegment) {
				lines.push("为新分段运行全新的基线。");
			}
			if (requiresHarness && !onAutoresearchBranch) {
				lines.push(
					"注意:当前不在专用 `autoresearch/*` 分支上 — `log_experiment discard` 只会还原运行修改过的文件,不会重置到基线。",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					state,
					createdSession,
					bumpedSegment,
					abandonedRuns,
					harnessCommitted,
					baselineCommit: session.baselineCommit,
				},
			};
		},
		renderCall(args, _options, theme): Text {
			return new Text(renderInitCall(args.name, theme), 0, 0);
		},
		renderResult(result): Text {
			const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
			return new Text(text, 0, 0);
		},
	};
}

function renderInitCall(name: string, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg("accent", truncateToWidth(replaceTabs(name), 100))}`;
}

async function tryReadHeadSha(cwd: string): Promise<string | null> {
	try {
		return (await git.head.sha(cwd)) ?? null;
	} catch {
		return null;
	}
}

async function detectPendingChanges(cwd: string): Promise<boolean> {
	try {
		const statusText = await git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true });
		const workDirPrefix = await git.show.prefix(cwd).catch(() => "");
		return parseWorkDirDirtyPaths(statusText, workDirPrefix).length > 0;
	} catch {
		return false;
	}
}

function buildHarnessCommitMessage(goal: string | null, name: string): string {
	const lines = [HARNESS_COMMIT_TITLE, "", `基准入口:${DEFAULT_HARNESS_COMMAND}`];
	if (goal) {
		lines.push(`目标:${goal}`);
	} else {
		lines.push(`会话:${name}`);
	}
	return lines.join("\n");
}
