import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { $env, getProjectDir, isEnoent, prompt } from "@wxyhgk/pi-utils";
import { applyChangelogProposals } from "../../commit/changelog";
import { detectChangelogBoundaries } from "../../commit/changelog/detect";
import { parseUnreleasedSection } from "../../commit/changelog/parse";
import { formatCommitMessage } from "../../commit/message";
import { resolvePrimaryModel, resolveSmolModel } from "../../commit/model-selection";
import type { CommitCommandArgs, ConventionalAnalysis, NumstatEntry } from "../../commit/types";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { discoverAuthStorage, discoverContextFiles, loadCliExtensionProviders } from "../../sdk";
import * as git from "../../utils/git";
import { type ExistingChangelogEntries, runCommitAgentSession } from "./agent";
import { generateFallbackProposal } from "./fallback";
import { assignLockFilesToPlan } from "./lock-files";
import splitConfirmPrompt from "./prompts/split-confirm.md" with { type: "text" };
import type { CommitAgentState, CommitProposal, HunkSelector, SplitCommitPlan } from "./state";
import { computeDependencyOrder } from "./topo-sort";
import { detectTrivialChange } from "./trivial";

interface CommitExecutionContext {
	cwd: string;
	dryRun: boolean;
	push: boolean;
}

export async function runAgenticCommit(args: CommitCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);

	process.stdout.write("● 正在解析模型...\n");
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	await loadCliExtensionProviders(modelRegistry, settings, cwd);
	const stagedFilesPromise = (async () => {
		let stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
		if (stagedFiles.length === 0) {
			process.stdout.write("未检测到暂存的更改,正在暂存所有更改...\n");
			await git.stage.files(cwd);
			stagedFiles = await git.diff.changedFiles(cwd, { cached: true });
		}
		return stagedFiles;
	})();

	const primaryModelPromise = resolvePrimaryModel(args.model, settings, modelRegistry);
	const [primaryModelResult, stagedFiles] = await Promise.all([primaryModelPromise, stagedFilesPromise]);
	const { model: primaryModel, apiKey: primaryApiKey } = primaryModelResult;
	process.stdout.write(`  └─ ${primaryModel.name}\n`);

	const { model: agentModel, thinkingLevel: agentThinkingLevel } = await resolveSmolModel(
		settings,
		modelRegistry,
		primaryModel,
		primaryApiKey,
	);

	if (stagedFiles.length === 0) {
		process.stderr.write("没有可提交的更改。\n");
		return;
	}

	if (!args.noChangelog) {
		process.stdout.write("● 正在检测变更日志目标...\n");
	}
	const [changelogBoundaries, contextFiles, numstat, diff] = await Promise.all([
		args.noChangelog ? [] : detectChangelogBoundaries(cwd, stagedFiles),
		discoverContextFiles(cwd),
		git.diff.numstat(cwd, { cached: true }),
		git.diff(cwd, { cached: true }),
	]);
	const changelogTargets = changelogBoundaries.map(boundary => boundary.changelogPath);
	if (!args.noChangelog) {
		if (changelogTargets.length > 0) {
			for (const path of changelogTargets) {
				process.stdout.write(`  └─ ${path}\n`);
			}
		} else {
			process.stdout.write("  └─ (未找到)\n");
		}
	}

	process.stdout.write("● 正在发现上下文文件...\n");
	const agentsMdFiles = contextFiles.filter(file => file.path.endsWith("AGENTS.md"));
	if (agentsMdFiles.length > 0) {
		for (const file of agentsMdFiles) {
			process.stdout.write(`  └─ ${file.path}\n`);
		}
	} else {
		process.stdout.write("  └─ (未找到)\n");
	}
	const forceFallback = $env.PI_COMMIT_TEST_FALLBACK?.toLowerCase() === "true";
	if (forceFallback) {
		process.stdout.write("● 正在强制使用回退提交生成...\n");
		const fallbackProposal = generateFallbackProposal(numstat);
		await runSingleCommit(fallbackProposal, { cwd, dryRun: args.dryRun, push: args.push });
		return;
	}

	const trivialChange = detectTrivialChange(diff);
	if (trivialChange) {
		process.stdout.write(`● 检测到平凡更改:${trivialChange.summary}\n`);
		const trivialProposal: CommitProposal = {
			analysis: {
				type: trivialChange.type,
				scope: null,
				details: [],
				issueRefs: [],
			},
			summary: trivialChange.summary,
			warnings: [],
		};
		await runSingleCommit(trivialProposal, { cwd, dryRun: args.dryRun, push: args.push });
		return;
	}

	let existingChangelogEntries: ExistingChangelogEntries[] | undefined;
	if (!args.noChangelog && changelogTargets.length > 0) {
		existingChangelogEntries = await loadExistingChangelogEntries(changelogTargets);
		if (existingChangelogEntries.length === 0) {
			existingChangelogEntries = undefined;
		}
	}

	process.stdout.write("● 正在启动提交 Agent...\n");
	let agentSessionCompleted = false;

	try {
		await runCommitAgentSession({
			cwd,
			model: agentModel,
			thinkingLevel: agentThinkingLevel,
			settings,
			modelRegistry,
			authStorage,
			userContext: args.context,
			contextFiles,
			changelogTargets,
			requireChangelog: !args.noChangelog && changelogTargets.length > 0,
			diffText: diff,
			existingChangelogEntries,
			onComplete: async commitState => {
				agentSessionCompleted = true;
				await completeAgentCommitState(commitState, {
					cwd,
					dryRun: args.dryRun,
					push: args.push,
					noChangelog: args.noChangelog,
					changelogTargets,
					numstat,
				});
			},
		});
		return;
	} catch (error) {
		if (agentSessionCompleted) {
			throw error;
		}
		const errorMessage = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Agent 错误:${errorMessage}\n`);
		if (error instanceof Error && error.stack && $env.DEBUG) {
			process.stderr.write(`${error.stack}\n`);
		}
		process.stdout.write("● 正在使用回退提交生成...\n");
		const fallbackProposal = generateFallbackProposal(numstat);
		await runSingleCommit(fallbackProposal, { cwd, dryRun: args.dryRun, push: args.push });
		return;
	}
}

async function completeAgentCommitState(
	commitState: CommitAgentState,
	ctx: CommitExecutionContext & {
		noChangelog: boolean;
		changelogTargets: string[];
		numstat: NumstatEntry[];
	},
): Promise<void> {
	let usedFallback = false;
	if (!commitState.proposal && !commitState.splitProposal) {
		if ($env.PI_COMMIT_NO_FALLBACK?.toLowerCase() !== "true") {
			process.stdout.write("● Agent 未提供提案,正在使用回退...\n");
			commitState.proposal = generateFallbackProposal(ctx.numstat);
			usedFallback = true;
		}
	}

	let updatedChangelogFiles: string[] = [];
	if (!ctx.noChangelog && ctx.changelogTargets.length > 0 && !usedFallback) {
		if (!commitState.changelogProposal) {
			throw new Error("提交 Agent 未提供变更日志条目。");
		}
		process.stdout.write("● 正在应用变更日志条目...\n");
		const updated = await applyChangelogProposals({
			cwd: ctx.cwd,
			proposals: commitState.changelogProposal.entries,
			dryRun: ctx.dryRun,
			onProgress: message => {
				process.stdout.write(`  ├─ ${message}\n`);
			},
		});
		updatedChangelogFiles = updated.map(filePath => path.relative(ctx.cwd, filePath));
		if (updated.length > 0) {
			for (const filePath of updated) {
				process.stdout.write(`  └─ ${filePath}\n`);
			}
		} else {
			process.stdout.write("  └─ (无更改)\n");
		}
	}

	if (commitState.proposal) {
		await runSingleCommit(commitState.proposal, ctx);
		return;
	}

	if (commitState.splitProposal) {
		await runSplitCommit(commitState.splitProposal, {
			cwd: ctx.cwd,
			dryRun: ctx.dryRun,
			push: ctx.push,
			additionalFiles: updatedChangelogFiles,
		});
		return;
	}

	throw new Error("提交 Agent 未提供提案。");
}

async function runSingleCommit(proposal: CommitProposal, ctx: CommitExecutionContext): Promise<void> {
	if (proposal.warnings.length > 0) {
		process.stdout.write(formatWarnings(proposal.warnings));
	}
	const commitMessage = formatCommitMessage(proposal.analysis, proposal.summary);
	if (ctx.dryRun) {
		process.stdout.write("\n生成的提交消息:\n");
		process.stdout.write(`${commitMessage}\n`);
		return;
	}
	process.stdout.write("● 正在创建提交...\n");
	await git.commit(ctx.cwd, commitMessage);
	process.stdout.write("提交已创建。\n");
	if (ctx.push) {
		await git.push(ctx.cwd);
		process.stdout.write("已推送到远程。\n");
	}
}

async function runSplitCommit(
	plan: SplitCommitPlan,
	ctx: CommitExecutionContext & { additionalFiles?: string[] },
): Promise<void> {
	if (plan.warnings.length > 0) {
		process.stdout.write(formatWarnings(plan.warnings));
	}
	if (ctx.additionalFiles && ctx.additionalFiles.length > 0) {
		appendFilesToLastCommit(plan, ctx.additionalFiles);
	}
	const stagedFiles = await git.diff.changedFiles(ctx.cwd, { cached: true });
	assignLockFilesToPlan(plan, stagedFiles);
	const plannedFiles = new Set(plan.commits.flatMap(commit => commit.changes.map(change => change.path)));
	const missingFiles = stagedFiles.filter(file => !plannedFiles.has(file));
	if (missingFiles.length > 0) {
		throw new Error(`拆分提交计划缺少暂存文件:${missingFiles.join(", ")}`);
	}

	if (ctx.dryRun) {
		process.stdout.write("\n拆分提交计划(试运行):\n");
		for (const [index, commit] of plan.commits.entries()) {
			const analysis: ConventionalAnalysis = {
				type: commit.type,
				scope: commit.scope,
				details: commit.details,
				issueRefs: commit.issueRefs,
			};
			const message = formatCommitMessage(analysis, commit.summary);
			process.stdout.write(`提交 ${index + 1}:\n${message}\n`);
			const changeSummary = commit.changes
				.map(change => formatFileChangeSummary(change.path, change.hunks))
				.join(", ");
			process.stdout.write(`更改:${changeSummary}\n`);
		}
		return;
	}

	if (!(await confirmSplitCommitPlan(plan))) {
		process.stdout.write("拆分提交已被用户中止。\n");
		return;
	}

	const order = computeDependencyOrder(plan.commits);
	if ("error" in order) {
		throw new Error(order.error);
	}

	process.stdout.write("● 正在创建拆分提交...\n");
	const stagedDiff = await git.diff(ctx.cwd, { cached: true, binary: true });
	await git.stage.reset(ctx.cwd);
	for (const commitIndex of order) {
		const commit = plan.commits[commitIndex];
		await git.stage.hunks(ctx.cwd, commit.changes, { rawDiff: stagedDiff, diffCached: true });
		const analysis: ConventionalAnalysis = {
			type: commit.type,
			scope: commit.scope,
			details: commit.details,
			issueRefs: commit.issueRefs,
		};
		const message = formatCommitMessage(analysis, commit.summary);
		await git.commit(ctx.cwd, message);
		await git.stage.reset(ctx.cwd);
	}
	process.stdout.write("拆分提交已创建。\n");
	if (ctx.push) {
		await git.push(ctx.cwd);
		process.stdout.write("已推送到远程。\n");
	}
}

function appendFilesToLastCommit(plan: SplitCommitPlan, files: string[]): void {
	if (plan.commits.length === 0) return;
	const planned = new Set(plan.commits.flatMap(commit => commit.changes.map(change => change.path)));
	const targetCommit = plan.commits[plan.commits.length - 1];
	for (const file of files) {
		if (planned.has(file)) continue;
		targetCommit.changes.push({ path: file, hunks: { type: "all" } });
		planned.add(file);
	}
}

async function confirmSplitCommitPlan(plan: SplitCommitPlan): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return true;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const splitConfirmQuestion = prompt.render(splitConfirmPrompt, { count: plan.commits.length });
		const answer = await rl.question(splitConfirmQuestion);
		return ["y", "yes"].includes(answer.trim().toLowerCase());
	} finally {
		rl.close();
	}
}

function formatWarnings(warnings: string[]): string {
	return `警告:\n${warnings.map(warning => `- ${warning}`).join("\n")}\n`;
}

function formatFileChangeSummary(path: string, hunks: HunkSelector): string {
	if (hunks.type === "all") {
		return `${path} (全部)`;
	}
	if (hunks.type === "indices") {
		return `${path} (hunks ${hunks.indices.join(", ")})`;
	}
	return `${path} (行 ${hunks.start}-${hunks.end})`;
}

async function loadExistingChangelogEntries(paths: string[]): Promise<ExistingChangelogEntries[]> {
	const entries = await Promise.all(
		paths.map(async path => {
			let content: string;
			try {
				content = await Bun.file(path).text();
			} catch (err) {
				if (isEnoent(err)) return null;
				throw err;
			}
			try {
				const unreleased = parseUnreleasedSection(content);
				const sections = Object.entries(unreleased.entries)
					.filter(([, items]) => items.length > 0)
					.map(([name, items]) => ({ name, items }));
				if (sections.length > 0) {
					return { path, sections };
				}
			} catch {
				return null;
			}
			return null;
		}),
	);
	return entries.filter((entry): entry is ExistingChangelogEntries => entry !== null);
}
