/**
 * TTSR CLI command handlers.
 *
 * `omp ttsr test` — feed a snippet (inline text, `--file`, or stdin) through the
 * real TTSR matching pipeline (`TtsrManager.checkSnapshot` for regex conditions,
 * `checkAstSnapshot` for ast-grep conditions) and report which rules would
 * trigger. The match context (`--source`, `--tool`, `--path`) is honored so
 * glob/AST/scope-scoped rules evaluate the same way they do in a live session.
 *
 * `omp ttsr list` — show every TTSR-registered rule the current project/user
 * config would load, with its conditions, scope, and source.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AstMatchStrictness, astMatch, FileType, type GlobMatch, glob } from "@oh-my-pi/pi-natives";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import chalk from "chalk";
import { BUILTIN_DEFAULTS_PROVIDER_ID, compileRuleCondition, type Rule, ruleCapability } from "../capability/rule";
import { bucketRules } from "../capability/rule-buckets";
import { Settings } from "../config/settings";
import type { TtsrSettings } from "../config/settings-schema";
import { initializeWithSettings, loadCapability } from "../discovery";
import { buildRuleFromMarkdown, createSourceMeta } from "../discovery/helpers";
import type { TtsrManager } from "../export/ttsr";

export type TtsrAction = "test" | "list" | "scan";

export const TTSR_ACTIONS: TtsrAction[] = ["test", "list", "scan"];
export const TTSR_SOURCES: TtsrMatchSource[] = ["text", "thinking", "tool"];

export type TtsrMatchSource = "text" | "thinking" | "tool";

interface TtsrMatchContext {
	source: TtsrMatchSource;
	toolName?: string;
	filePaths?: string[];
	streamKey?: string;
}

export interface TtsrTestArgs {
	/** Inline snippet text. */
	snippet?: string;
	/** Snippet file path, or `-` for stdin. */
	file?: string;
	/** Path to a rule markdown file to test in isolation (skips project loading). */
	rule?: string;
	/** TTSR match source; when omitted, inferred from --file (tool for source files, text otherwise). */
	source?: TtsrMatchSource;
	/** Tool name when `source === "tool"` (e.g. "edit", "write"). */
	tool?: string;
	/** Candidate file path used for scope/glob matching and AST language inference. */
	filePath?: string;
	/** Show every evaluated rule, not just triggered ones. */
	verbose?: boolean;
}

export interface TtsrScanArgs {
	/** Directory to glob and scan files in. */
	directory?: string;
	/** Path to a rule markdown file to test in isolation (skips project loading). */
	rule?: string;
	/** Respect gitignore files while discovering scan candidates. Defaults to true. */
	gitignore?: boolean;
	/** Maximum file size to scan in bytes; 0 disables the limit. */
	maxBytes?: number;
	/** Show details. */
	verbose?: boolean;
}

export interface TtsrCommandArgs {
	action: TtsrAction;
	test?: TtsrTestArgs;
	scan?: TtsrScanArgs;
	json?: boolean;
}

interface RuleMatchDetail {
	name: string;
	path: string;
	sourceProvider?: string;
	/** Conditions that matched the snippet. */
	matched: { regex: string[]; ast: string[] };
	/** All conditions defined on the rule (for verbose display). */
	defined: { regex: string[]; ast: string[] };
	skippedAst?: string;
}

interface TestReport {
	source: TtsrMatchSource;
	tool?: string;
	filePath?: string;
	snippetPreview: string;
	snippetBytes: number;
	evaluated: number;
	triggered: RuleMatchDetail[];
	notTriggered: RuleMatchDetail[];
	/**
	 * Set when a file path was supplied but the match source was inferred as
	 * `text` (extension absent from {@link SOURCE_FILE_EXT}), so callers can
	 * surface why a source file was evaluated against a prose context.
	 */
	inferenceNote?: string;
}

const STDIN_MARKER = "-";
/** Extensions treated as source files for default tool-context inference. */
const SOURCE_FILE_EXT =
	/^\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|cc|cpp|h|hpp|rb|php|lua|css|scss|html|json|ya?ml|toml|md|mdc|cs|razor|cshtml|fs|fsx|vb|sh|bash|sql|zig|dart|scala|ex|exs|proto|tf)$/i;

const BINARY_PROBE_BYTES = 8192;
const DEFAULT_MAX_SCAN_BYTES = 5 * 1024 * 1024;

type ReadSkipReason = "binary" | "large" | "unreadable";

interface ScanSkipSummary {
	binary: number;
	large: number;
	unreadable: number;
	noRelevantRules: number;
}

interface ScanRegexCondition {
	pattern: string;
	regex: RegExp;
}

interface ScanScopePlan {
	toolName?: string;
	pathGlob?: Bun.Glob;
}

interface ScanRulePlan {
	rule: Rule;
	globalPathGlobs?: Bun.Glob[];
	defaultToolScope: boolean;
	scopes: ScanScopePlan[];
	regexConditions: ScanRegexCondition[];
	astConditions: string[];
	astPrefilters: RegExp[];
	astRequiresFullScan: boolean;
}

interface ScanFileCandidate {
	path: string;
	size?: number;
}

async function readSnippet(opts: { snippet?: string; file?: string }): Promise<string> {
	if (opts.file) {
		if (opts.file === STDIN_MARKER) {
			return await Bun.stdin.text();
		}
		const resolved = path.resolve(opts.file);
		const file = Bun.file(resolved);
		if (!(await file.exists())) {
			throw new Error(`未找到代码片段文件:${resolved}`);
		}
		return await file.text();
	}
	if (opts.snippet !== undefined) return opts.snippet;
	if (process.stdin.isTTY === false) return await Bun.stdin.text();
	throw new Error("未提供代码片段。请传入内联文本、--file <path>,或通过 --file - 从管道输入。");
}

function previewSnippet(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > 80 ? `${single.slice(0, 77)}…` : single;
}

function deriveLang(filePaths: string[] | undefined): string | undefined {
	for (const filePath of filePaths ?? []) {
		const ext = path.extname(filePath.replaceAll("\\", "/"));
		if (ext.length > 1) return ext.slice(1).toLowerCase();
	}
	return undefined;
}

async function regexMatches(rule: Rule, snippet: string): Promise<string[]> {
	const out: string[] = [];
	for (const pattern of rule.condition ?? []) {
		try {
			if (compileRuleCondition(pattern).test(snippet)) out.push(pattern);
		} catch {
			// Invalid regex — skip; the manager already warned at registration.
		}
	}
	return out;
}

async function astMatches(rule: Rule, snippet: string, lang: string): Promise<string[]> {
	const out: string[] = [];
	for (const pattern of rule.astCondition ?? []) {
		try {
			const result = await astMatch({
				patterns: [pattern],
				source: snippet,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
			});
			if (result.totalMatches > 0) out.push(pattern);
		} catch {
			// Treat as no match (manager logs at runtime).
		}
	}
	return out;
}

/**
 * Run the snippet through the manager's real match paths and collect, for each
 * triggered rule, which of its conditions fired. Returns triggered + the full
 * evaluated set (so callers can render not-triggered entries too).
 */
async function evaluate(
	manager: TtsrManager,
	rules: readonly Rule[],
	snippet: string,
	context: TtsrMatchContext,
): Promise<{ triggered: RuleMatchDetail[]; notTriggered: RuleMatchDetail[] }> {
	const regexHit = manager.checkSnapshot(snippet, context);
	const astHit =
		context.source === "tool" && context.filePaths && context.filePaths.length > 0
			? await manager.checkAstSnapshot(snippet, context)
			: [];
	const hitNames = new Set<string>([...regexHit, ...astHit].map(r => r.name));

	const lang = deriveLang(context.filePaths);
	const astEligible = context.source === "tool" && !!lang;

	const triggered: RuleMatchDetail[] = [];
	const notTriggered: RuleMatchDetail[] = [];
	for (const rule of rules) {
		const regex = await regexMatches(rule, snippet);
		const ast = astEligible ? await astMatches(rule, snippet, lang!) : [];
		const detail: RuleMatchDetail = {
			name: rule.name,
			path: rule.path,
			sourceProvider: rule._source?.provider,
			matched: { regex, ast },
			defined: { regex: rule.condition ?? [], ast: rule.astCondition ?? [] },
		};
		if (!astEligible && (rule.astCondition ?? []).length > 0) {
			detail.skippedAst = "astCondition 需要 --source tool 和带文件扩展名的 --path";
		}
		(hitNames.has(rule.name) ? triggered : notTriggered).push(detail);
	}
	return { triggered, notTriggered };
}

async function createTtsrManager(settings?: TtsrSettings): Promise<TtsrManager> {
	const { TtsrManager } = await import("../export/ttsr");
	return new TtsrManager(settings);
}

function filterTtsrRulesForScan(
	rules: readonly Rule[],
	options: { builtinRules?: boolean; disabledRules?: readonly string[] } = {},
): Rule[] {
	const includeBuiltin = options.builtinRules !== false;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}
	return rules.filter(rule => {
		if (disabled.has(rule.name)) return false;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return false;
		return (rule.condition && rule.condition.length > 0) || (rule.astCondition && rule.astCondition.length > 0);
	});
}

async function loadProjectTtsrRules(cwd: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	const manager = await createTtsrManager(ttsrSettings);
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	bucketRules(result.items, manager, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	return { rules: manager.getRules(), manager };
}

async function loadProjectScanRules(cwd: string): Promise<Rule[]> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	if (!ttsrSettings.enabled) {
		return [];
	}
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	return filterTtsrRulesForScan(result.items, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
}

async function readIsolatedRule(rulePath: string): Promise<Rule> {
	const resolved = path.resolve(rulePath);
	const file = Bun.file(resolved);
	if (!(await file.exists())) {
		throw new Error(`未找到规则文件:${resolved}`);
	}
	const content = await file.text();
	const name = path.basename(resolved).replace(/\.(md|mdc)$/, "");
	return buildRuleFromMarkdown(name, content, resolved, createSourceMeta("ttsr-cli", resolved, "project"), {
		ruleName: name,
	});
}

async function loadIsolatedRule(rulePath: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const rule = await readIsolatedRule(rulePath);
	const manager = await createTtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		builtinRules: true,
		disabledRules: [],
	});
	if (!manager.addRule(rule)) {
		throw new Error(
			`规则“${rule.name}”没有可用的 TTSR 条件。请在其 frontmatter 中添加 \`condition\`(正则)或 \`astCondition\`(ast-grep 模式)。`,
		);
	}
	return { rules: manager.getRules(), manager };
}

async function loadIsolatedScanRule(rulePath: string): Promise<Rule[]> {
	const rule = await readIsolatedRule(rulePath);
	return filterTtsrRulesForScan([rule]);
}

async function runTest(args: TtsrTestArgs, json: boolean, cwd: string): Promise<void> {
	if (args.source && !TTSR_SOURCES.includes(args.source)) {
		throw new Error(`无效的 --source:${args.source}。可选值:${TTSR_SOURCES.join(", ")}`);
	}

	const snippet = await readSnippet(args);

	// Infer match context: when the user points --file at a source file and
	// doesn't pick a source, default to tool/edit with that path so tool-scoped
	// rules (the common case, e.g. tool:edit(*.ts)) match like they would live.
	const filePath = args.filePath ?? (args.file && args.file !== STDIN_MARKER ? path.resolve(args.file) : undefined);
	const source: TtsrMatchSource =
		args.source ?? (filePath && SOURCE_FILE_EXT.test(path.extname(filePath)) ? "tool" : "text");
	const tool = args.tool ?? (source === "tool" ? "edit" : undefined);

	// A supplied source file whose extension is unknown falls through to the
	// text (prose) context, where tool-scoped rules can never match. Surface
	// that so a false negative reads as a context mismatch, not a bad regex.
	const inferenceNote =
		!args.source && filePath && source === "text"
			? `从 '${path.extname(filePath) || filePath}' 推断 --source text(不在源文件扩展名集合中);请传入 --source tool --tool edit 以评估 tool 作用域的规则`
			: undefined;

	const context: TtsrMatchContext = {
		source,
		toolName: tool,
		filePaths: filePath ? [filePath] : undefined,
	};

	const { rules, manager } = args.rule ? await loadIsolatedRule(args.rule) : await loadProjectTtsrRules(cwd);

	if (rules.length === 0) {
		const msg = args.rule
			? "规则已注册,但没有产生任何 TTSR 条目。"
			: "该项目未注册任何 TTSR 规则。请向规则文件添加 `condition` 或 `astCondition`,然后重新运行。";
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		} else {
			process.stderr.write(`${chalk.yellow(msg)}\n`);
		}
		process.exit(1);
	}

	const { triggered, notTriggered } = await evaluate(manager, rules, snippet, context);

	const report: TestReport = {
		source,
		tool,
		filePath,
		snippetPreview: previewSnippet(snippet),
		snippetBytes: snippet.length,
		evaluated: rules.length,
		triggered,
		notTriggered,
		inferenceNote,
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}

	renderTestReport(report, args.verbose ?? false, args.rule !== undefined);
}

function renderTestReport(report: TestReport, verbose: boolean, isolated: boolean): void {
	const ctxLabel = report.source === "tool" ? `tool:${report.tool ?? "?"}` : report.source;
	const pathLabel = report.filePath ? ` path=${report.filePath}` : "";
	process.stdout.write(
		`${chalk.bold("TTSR 测试")} — source=${chalk.cyan(ctxLabel)}${pathLabel} snippet=${chalk.dim(`${report.snippetBytes}b`)}\n`,
	);
	process.stdout.write(`${chalk.dim(`  "${report.snippetPreview}"`)}\n\n`);
	if (report.inferenceNote) {
		process.stdout.write(`${chalk.yellow(`提示:${report.inferenceNote}`)}\n\n`);
	}

	if (report.triggered.length === 0) {
		process.stdout.write(`${chalk.red("没有规则被触发。")}(评估了 ${report.evaluated} 条规则)\n`);
	} else {
		process.stdout.write(`${chalk.green.bold(`已触发(${report.triggered.length})`)}\n`);
		for (const detail of report.triggered) renderRuleDetail(detail, true);
	}

	if (verbose && report.notTriggered.length > 0) {
		process.stdout.write(`\n${chalk.dim(`未触发(${report.notTriggered.length})`)}\n`);
		for (const detail of report.notTriggered) renderRuleDetail(detail, false);
	}

	if (isolated && report.triggered.length === 0) {
		process.exitCode = 1;
	}
}
function renderRuleDetail(detail: RuleMatchDetail, hit: boolean): void {
	const mark = hit ? chalk.green("✓") : chalk.red("✗");
	const condParts: string[] = [];
	// For triggered rules, show which conditions fired. For not-triggered
	// rules (verbose), show the rule's full condition set so users can see
	// what would match.
	const regex = hit ? detail.matched.regex : detail.defined.regex;
	const ast = hit ? detail.matched.ast : detail.defined.ast;
	if (regex.length > 0) {
		condParts.push(`condition: ${regex.map(c => chalk.yellow(`/${c}/`)).join(", ")}`);
	}
	if (ast.length > 0) {
		condParts.push(`astCondition: ${ast.map(c => chalk.magenta(c)).join(", ")}`);
	}
	if (detail.skippedAst) {
		condParts.push(chalk.dim(`astCondition: ${detail.skippedAst}`));
	}
	const condLabel = condParts.length > 0 ? condParts.join("  ") : chalk.dim("没有活动条件");
	const provider = detail.sourceProvider ? chalk.dim(` [${detail.sourceProvider}]`) : "";
	process.stdout.write(`  ${mark} ${chalk.bold(detail.name)}  ${condLabel}${provider}\n`);
}

async function runList(json: boolean, cwd: string): Promise<void> {
	const { rules } = await loadProjectTtsrRules(cwd);

	if (json) {
		process.stdout.write(
			`${JSON.stringify(
				rules.map(r => ({
					name: r.name,
					path: r.path,
					provider: r._source?.provider,
					condition: r.condition ?? [],
					astCondition: r.astCondition ?? [],
					scope: r.scope ?? [],
					globs: r.globs ?? [],
					description: r.description,
				})),
			)}\n`,
		);
		return;
	}

	if (rules.length === 0) {
		process.stdout.write(`${chalk.yellow("该项目未注册任何 TTSR 规则。")}\n`);
		return;
	}

	process.stdout.write(`${chalk.bold(`TTSR 规则(${rules.length})`)}\n`);
	for (const rule of rules) {
		const condParts: string[] = [];
		if ((rule.condition ?? []).length > 0) condParts.push(`condition: ${rule.condition!.join(", ")}`);
		if ((rule.astCondition ?? []).length > 0) condParts.push(`astCondition: ${rule.astCondition!.join(", ")}`);
		if ((rule.scope ?? []).length > 0) condParts.push(`scope: ${rule.scope!.join(", ")}`);
		if ((rule.globs ?? []).length > 0) condParts.push(`globs: ${rule.globs!.join(", ")}`);
		const provider = rule._source?.provider ? chalk.dim(` [${rule._source.provider}]`) : "";
		process.stdout.write(
			`  ${chalk.bold(rule.name)}${provider} ${chalk.dim(condParts.join("  ") || "无条件")}\n`,
		);
		if (rule.description) process.stdout.write(`${chalk.dim(`    ${rule.description}`)}\n`);
	}
}

function normalizeScanPath(pathValue: string): string {
	return pathValue.replaceAll("\\", "/");
}

function isWithinDirectory(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function matchesScanGlob(glob: Bun.Glob, filePaths: string[] | undefined): boolean {
	if (!filePaths || filePaths.length === 0) {
		return false;
	}
	for (const filePath of filePaths) {
		const normalized = normalizeScanPath(filePath);
		if (glob.match(normalized)) {
			return true;
		}
		const slashIndex = normalized.lastIndexOf("/");
		const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
		if (basename !== normalized && glob.match(basename)) {
			return true;
		}
	}
	return false;
}

function compileScanPathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
	if (!globs || globs.length === 0) {
		return undefined;
	}
	const compiled = globs
		.map(globPattern => globPattern.trim())
		.filter(globPattern => globPattern.length > 0)
		.map(globPattern => new Bun.Glob(globPattern));
	return compiled.length > 0 ? compiled : undefined;
}

function parseScanToolScopeToken(token: string): ScanScopePlan | undefined {
	const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
		token,
	);
	if (!match) {
		return undefined;
	}
	const groups = match.groups;
	const hasToolPrefix = groups?.prefix !== undefined;
	const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
	const pathPattern = groups?.path?.trim();
	return {
		toolName,
		pathGlob: pathPattern ? new Bun.Glob(pathPattern) : undefined,
	};
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compileAstPrefilter(pattern: string): RegExp | undefined {
	if (/\bas\s*\{/.test(pattern)) {
		return /\bas\b(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*\{/;
	}
	const ignored = new Set(["if", "as", "const", "let", "var", "return", "true", "false", "null", "undefined"]);
	const tokens = pattern
		.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)
		?.filter(token => !ignored.has(token) && !/^[A-Z_]+$/.test(token))
		.sort((a, b) => b.length - a.length);
	const token = tokens?.[0];
	return token ? new RegExp(`\\b${escapeRegexLiteral(token)}\\b`) : undefined;
}

function compileScanRulePlans(rules: Rule[]): ScanRulePlan[] {
	return rules.map(rule => {
		const scopes: ScanScopePlan[] = [];
		let defaultToolScope = !rule.scope || rule.scope.length === 0;
		for (const rawScope of rule.scope ?? []) {
			const token = rawScope.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0 || normalizedToken === "text" || normalizedToken === "thinking") {
				continue;
			}
			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scopes.push({});
				continue;
			}
			const scope = parseScanToolScopeToken(token);
			if (!scope) {
				continue;
			}
			if (!scope.toolName && !scope.pathGlob) {
				defaultToolScope = true;
				continue;
			}
			scopes.push(scope);
		}
		const regexConditions: ScanRegexCondition[] = [];
		for (const pattern of rule.condition ?? []) {
			try {
				regexConditions.push({ pattern, regex: compileRuleCondition(pattern) });
			} catch {
				// Same behavior as TtsrManager: invalid regex conditions are unusable.
			}
		}
		const astConditions = (rule.astCondition ?? [])
			.map(pattern => pattern.trim())
			.filter(pattern => pattern.length > 0);
		const astPrefilters: RegExp[] = [];
		let astRequiresFullScan = false;
		for (const pattern of astConditions) {
			const prefilter = compileAstPrefilter(pattern);
			if (prefilter) {
				astPrefilters.push(prefilter);
			} else {
				astRequiresFullScan = true;
			}
		}
		return {
			rule,
			globalPathGlobs: compileScanPathGlobs(rule.globs),
			defaultToolScope,
			scopes,
			regexConditions,
			astConditions,
			astPrefilters,
			astRequiresFullScan,
		};
	});
}

function scanRulePlanMatchesPath(plan: ScanRulePlan, filePaths: string[]): boolean {
	return !plan.globalPathGlobs || plan.globalPathGlobs.some(pathGlob => matchesScanGlob(pathGlob, filePaths));
}

function scanRulePlanMatchesToolScope(plan: ScanRulePlan, filePaths: string[]): boolean {
	if (!scanRulePlanMatchesPath(plan, filePaths)) {
		return false;
	}
	if (plan.defaultToolScope) {
		return true;
	}
	for (const scope of plan.scopes) {
		if (scope.pathGlob && !matchesScanGlob(scope.pathGlob, filePaths)) {
			continue;
		}
		if (!scope.toolName || scope.toolName === "edit" || scope.toolName === "write") {
			return true;
		}
	}
	return false;
}

function scanRulePlanMayMatchAst(plan: ScanRulePlan, fileContent: string): boolean {
	return (
		plan.astConditions.length > 0 &&
		(plan.astRequiresFullScan || plan.astPrefilters.some(prefilter => prefilter.test(fileContent)))
	);
}

async function scanRulePlanMatchesContent(
	plan: ScanRulePlan,
	fileContent: string,
	lang: string | undefined,
	includeDetails: boolean,
): Promise<RuleMatchDetail | undefined> {
	let regexHit = false;
	const matchedRegex: string[] = [];
	for (const condition of plan.regexConditions) {
		condition.regex.lastIndex = 0;
		if (condition.regex.test(fileContent)) {
			regexHit = true;
			if (includeDetails) {
				matchedRegex.push(condition.pattern);
			}
		}
	}

	const matchedAst: string[] = [];
	let astHit = false;
	if ((includeDetails || !regexHit) && lang && plan.astConditions.length > 0) {
		if (includeDetails) {
			matchedAst.push(...(await astMatches(plan.rule, fileContent, lang)));
			astHit = matchedAst.length > 0;
		} else {
			try {
				const result = await astMatch({
					patterns: plan.astConditions,
					source: fileContent,
					lang,
					strictness: AstMatchStrictness.Smart,
					limit: 1,
				});
				astHit = result.matches.length > 0;
			} catch {
				astHit = false;
			}
		}
	}

	if (!regexHit && !astHit) {
		return undefined;
	}
	return {
		name: plan.rule.name,
		path: plan.rule.path,
		sourceProvider: plan.rule._source?.provider,
		matched: { regex: matchedRegex, ast: matchedAst },
		defined: { regex: plan.rule.condition ?? [], ast: plan.rule.astCondition ?? [] },
	};
}

async function scanAnyAstConditionMatches(
	plans: ScanRulePlan[],
	fileContent: string,
	lang: string | undefined,
): Promise<boolean | undefined> {
	if (!lang) {
		return false;
	}
	const patterns = plans.flatMap(plan => plan.astConditions);
	if (patterns.length === 0) {
		return false;
	}
	try {
		const result = await astMatch({
			patterns,
			source: fileContent,
			lang,
			strictness: AstMatchStrictness.Smart,
			limit: 1,
		});
		if (result.matches.length > 0) {
			return true;
		}
		return result.parseErrors && result.parseErrors.length > 0 ? undefined : false;
	} catch {
		return undefined;
	}
}

async function discoverScanFiles(scanDir: string, cwd: string, gitignore: boolean): Promise<ScanFileCandidate[]> {
	const globRoot = isWithinDirectory(scanDir, cwd) ? cwd : scanDir;
	const relativeScanDir = normalizeScanPath(path.relative(globRoot, scanDir));
	const pattern = relativeScanDir === "" ? "**/*" : `${relativeScanDir}/**/*`;
	try {
		const result = await glob({
			pattern,
			path: globRoot,
			gitignore,
			hidden: true,
			fileType: FileType.File,
		});
		const candidates: ScanFileCandidate[] = [];
		for (const match of result.matches as GlobMatch[]) {
			const absPath = path.resolve(globRoot, match.path);
			const filePath = normalizeScanPath(path.relative(scanDir, absPath));
			if (
				filePath.length === 0 ||
				filePath.startsWith("..") ||
				path.isAbsolute(filePath) ||
				filePath === ".git" ||
				filePath.startsWith(".git/")
			) {
				continue;
			}
			candidates.push({ path: filePath, size: match.size });
		}
		candidates.sort((a, b) => a.path.localeCompare(b.path));
		return candidates;
	} catch {
		return [];
	}
}

async function readScanFileText(
	absPath: string,
	maxBytes: number,
	knownSize: number | undefined,
): Promise<{ content: string } | { skip: ReadSkipReason }> {
	const file = Bun.file(absPath);
	try {
		const fileSize = knownSize ?? file.size;
		if (maxBytes > 0 && fileSize > maxBytes) {
			return { skip: "large" };
		}
		const probeBytes = Math.min(fileSize, BINARY_PROBE_BYTES);
		if (probeBytes > 0) {
			const prefix = new Uint8Array(await file.slice(0, probeBytes).arrayBuffer());
			if (prefix.includes(0)) {
				return { skip: "binary" };
			}
		}
		return { content: await file.text() };
	} catch {
		return { skip: "unreadable" };
	}
}

function countSkipped(skipped: ScanSkipSummary): number {
	return skipped.binary + skipped.large + skipped.unreadable + skipped.noRelevantRules;
}

async function runScan(args: TtsrScanArgs, json: boolean, cwd: string): Promise<void> {
	const scanDir = args.directory ? path.resolve(cwd, args.directory) : cwd;
	if (!fs.existsSync(scanDir)) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: `目录不存在:${scanDir}` })}\n`);
		} else {
			process.stderr.write(`${chalk.red(`错误:扫描目录不存在:${scanDir}`)}\n`);
		}
		process.exit(1);
	}

	const rules = args.rule ? await loadIsolatedScanRule(args.rule) : await loadProjectScanRules(cwd);

	if (rules.length === 0) {
		const msg = args.rule
			? "规则已注册,但没有产生任何 TTSR 条目。"
			: "该项目未注册任何 TTSR 规则。";
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		} else {
			process.stderr.write(`${chalk.yellow(msg)}\n`);
		}
		process.exit(1);
	}

	const scanRulePlans = compileScanRulePlans(rules).filter(
		plan => plan.regexConditions.length > 0 || plan.astConditions.length > 0,
	);
	if (scanRulePlans.length === 0) {
		const msg = args.rule
			? "规则已注册,但没有产生可用的 TTSR 条件。"
			: "该项目未注册任何可用的 TTSR 规则。";
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		} else {
			process.stderr.write(`${chalk.yellow(msg)}\n`);
		}
		process.exit(1);
	}

	const gitignore = args.gitignore ?? true;
	const maxBytes = Math.max(0, args.maxBytes ?? DEFAULT_MAX_SCAN_BYTES);
	const includeDetails = json || (args.verbose ?? false);
	const files = await discoverScanFiles(scanDir, cwd, gitignore);
	const emptySkipped: ScanSkipSummary = { binary: 0, large: 0, unreadable: 0, noRelevantRules: 0 };
	if (files.length === 0) {
		const msg = `在 ${scanDir} 中未找到可扫描的文件`;
		if (json) {
			process.stdout.write(
				`${JSON.stringify({
					files: [],
					summary: {
						totalFiles: 0,
						scannedFiles: 0,
						matchedFiles: 0,
						totalMatches: 0,
						evaluatedRules: scanRulePlans.length,
						skippedFiles: 0,
						skipped: emptySkipped,
						gitignore,
						maxBytes,
					},
				})}\n`,
			);
		} else {
			process.stdout.write(`${chalk.yellow(msg)}\n`);
		}
		return;
	}

	const fileResults: Array<{ file: string; matches: RuleMatchDetail[] }> = [];
	const skipped: ScanSkipSummary = { binary: 0, large: 0, unreadable: 0, noRelevantRules: 0 };
	let scannedFiles = 0;
	let matchedFiles = 0;
	let totalMatches = 0;

	for (const candidate of files) {
		const file = candidate.path;
		const absPath = path.resolve(scanDir, file);
		const relToProj = path.relative(cwd, absPath).replaceAll("\\", "/");
		const basename = path.basename(absPath);
		const filePaths = [absPath.replaceAll("\\", "/"), relToProj, basename];
		const relevantPlans = scanRulePlans.filter(plan => scanRulePlanMatchesToolScope(plan, filePaths));
		if (relevantPlans.length === 0) {
			skipped.noRelevantRules++;
			continue;
		}

		const readResult = await readScanFileText(absPath, maxBytes, candidate.size);
		if ("skip" in readResult) {
			skipped[readResult.skip]++;
			continue;
		}
		const fileContent = readResult.content;
		const lang = deriveLang(filePaths);
		scannedFiles++;

		const fileTriggeredDetails: RuleMatchDetail[] = [];
		let fileMatchCount = 0;
		const pendingAstPlans: ScanRulePlan[] = [];
		for (const plan of relevantPlans) {
			const detail = includeDetails
				? await scanRulePlanMatchesContent(plan, fileContent, lang, true)
				: await scanRulePlanMatchesContent(plan, fileContent, undefined, false);
			if (detail) {
				fileMatchCount++;
				if (includeDetails) {
					fileTriggeredDetails.push(detail);
				}
				continue;
			}
			if (!includeDetails && scanRulePlanMayMatchAst(plan, fileContent)) {
				pendingAstPlans.push(plan);
			}
		}
		if (!includeDetails && (await scanAnyAstConditionMatches(pendingAstPlans, fileContent, lang)) !== false) {
			for (const plan of pendingAstPlans) {
				const detail = await scanRulePlanMatchesContent(plan, fileContent, lang, false);
				if (!detail) {
					continue;
				}
				fileMatchCount++;
			}
		}

		if (fileMatchCount > 0) {
			matchedFiles++;
			totalMatches += fileMatchCount;
			if (includeDetails) {
				fileResults.push({
					file: relToProj,
					matches: fileTriggeredDetails,
				});
			}
		}
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				files: fileResults.map(fr => ({
					filePath: fr.file,
					matches: fr.matches.map(m => ({
						name: m.name,
						path: m.path,
						matched: m.matched,
					})),
				})),
				summary: {
					totalFiles: files.length,
					scannedFiles,
					matchedFiles,
					totalMatches,
					evaluatedRules: scanRulePlans.length,
					skippedFiles: countSkipped(skipped),
					skipped,
					gitignore,
					maxBytes,
				},
			})}\n`,
		);
	} else {
		process.stdout.write(
			`${chalk.bold("TTSR 扫描")} — 目录=${chalk.cyan(scanDir)} 文件=${chalk.dim(files.length)} 已扫描=${chalk.dim(scannedFiles)} 规则=${chalk.dim(scanRulePlans.length)} gitignore=${chalk.dim(gitignore ? "开" : "关")} 最大字节=${chalk.dim(maxBytes === 0 ? "关" : String(maxBytes))}\n`,
		);
		if (countSkipped(skipped) > 0) {
			process.stdout.write(
				`${chalk.dim(`  已跳过:二进制=${skipped.binary} 过大=${skipped.large} 不可读=${skipped.unreadable} 无相关规则=${skipped.noRelevantRules}`)}\n`,
			);
		}

		if (matchedFiles === 0) {
			process.stdout.write(
				`${chalk.green.bold("未找到匹配的规则。")}(在 ${scannedFiles}/${files.length} 个文件上评估了 ${rules.length} 条规则)\n`,
			);
		} else {
			process.stdout.write(
				`${chalk.red.bold("发现违规/匹配:")}(${totalMatches} 个匹配,分布在 ${matchedFiles} 个文件中)\n`,
			);
			if (!includeDetails) {
				process.stdout.write(`${chalk.dim("  使用 --verbose 重新运行以列出匹配的文件和条件")}\n`);
				return;
			}

			process.stdout.write("\n");
			for (const fr of fileResults) {
				process.stdout.write(`${chalk.bold.underline(fr.file)}\n`);
				for (const detail of fr.matches) {
					renderRuleDetail(detail, true);
				}
				process.stdout.write("\n");
			}
		}
	}
}

export async function runTtsrCommand(cmd: TtsrCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	if (cmd.action === "test") {
		if (!cmd.test) {
			process.stderr.write(`${chalk.red("错误:`ttsr test` 需要提供代码片段、--file 或管道输入的 stdin")}\n`);
			process.exit(1);
		}
		await runTest(cmd.test, cmd.json ?? false, cwd);
		return;
	}
	if (cmd.action === "list") {
		await runList(cmd.json ?? false, cwd);
		return;
	}
	if (cmd.action === "scan") {
		if (!cmd.scan) {
			process.stderr.write(`${chalk.red("错误:缺少 scan 参数")}\n`);
			process.exit(1);
		}
		await runScan(cmd.scan, cmd.json ?? false, cwd);
		return;
	}
	process.stderr.write(`${chalk.red(`错误:未知的 ttsr 操作:${cmd.action}`)}\n`);
	process.exit(1);
}
