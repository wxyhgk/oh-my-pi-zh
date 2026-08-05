import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isRecord, ptree, sanitizeText } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { type CleanseParserKind, parseCleanseDiagnostics } from "./parsers";
import type { CleanseCheckResult, CleanseDiagnostic, CleanseDiagnosticReport, SkippedCleanseCheck } from "./types";

const IGNORED_DIRECTORIES: Record<string, true> = {
	".git": true,
	".hg": true,
	".svn": true,
	".terraform": true,
	".venv": true,
	build: true,
	coverage: true,
	dist: true,
	node_modules: true,
	target: true,
	vendor: true,
};
const MAX_FAILURE_OUTPUT = 12_000;
const SHELLCHECK_BATCH_SIZE = 200;

interface CheckerPlan {
	id: string;
	label: string;
	language: string;
	cwd: string;
	executable: string;
	args: string[];
	parser: CleanseParserKind;
	command: string;
	mutates: boolean;
}

interface PlanRequest {
	id: string;
	label: string;
	language: string;
	root: string;
	binaries: string[];
	args: string[];
	parser: CleanseParserKind;
	executable?: string;
	mutates?: boolean;
}

interface DiscoveryState {
	projectCwd: string;
	files: string[];
	plans: CheckerPlan[];
	skipped: SkippedCleanseCheck[];
	includeTests: boolean;
}

/** Optional checker families enabled for a cleanse run. */
export interface CleanseDiagnosticSuiteOptions {
	includeTests?: boolean;
}

/** Re-runnable checker set discovered from one project snapshot. */
export interface CleanseDiagnosticSuite {
	readonly checkCount: number;
	readonly skipped: readonly SkippedCleanseCheck[];
	run(signal?: AbortSignal): Promise<CleanseDiagnosticReport>;
}

/** Discover configured language checkers without installing missing tools. */
export async function discoverCleanseDiagnosticSuite(
	projectCwd: string,
	options: CleanseDiagnosticSuiteOptions = {},
): Promise<CleanseDiagnosticSuite> {
	const absoluteCwd = path.resolve(projectCwd);
	const resolvedCwd = await fs.realpath(absoluteCwd).catch(() => absoluteCwd);
	const state: DiscoveryState = {
		projectCwd: resolvedCwd,
		files: await listProjectFiles(resolvedCwd),
		plans: [],
		skipped: [],
		includeTests: options.includeTests === true,
	};
	await discoverRust(state);
	discoverGo(state);
	discoverPython(state);
	await discoverJavaScript(state);
	discoverRuby(state);
	discoverPhp(state);
	discoverSwift(state);
	discoverDart(state);
	discoverElixir(state);
	discoverShell(state);
	discoverHaskell(state);
	discoverTerraform(state);
	discoverLua(state);
	discoverCpp(state);
	discoverDotnet(state);
	discoverZig(state);
	discoverJvm(state);

	const allowedFiles = new Set(state.files);
	return {
		checkCount: state.plans.length,
		skipped: state.skipped,
		async run(signal?: AbortSignal): Promise<CleanseDiagnosticReport> {
			const mutatingChecks: CleanseCheckResult[] = [];
			for (const plan of state.plans) {
				if (plan.mutates) mutatingChecks.push(await runChecker(plan, resolvedCwd, allowedFiles, signal));
			}
			const parallelChecks = await Promise.all(
				state.plans.filter(plan => !plan.mutates).map(plan => runChecker(plan, resolvedCwd, allowedFiles, signal)),
			);
			const checks = [...mutatingChecks, ...parallelChecks];
			return {
				checks,
				diagnostics: deduplicateProjectDiagnostics(checks.flatMap(check => check.diagnostics)),
				skipped: [...state.skipped],
			};
		},
	};
}

async function listProjectFiles(cwd: string): Promise<string[]> {
	try {
		const [tracked, untracked] = await Promise.all([git.ls.files(cwd), git.ls.untracked(cwd)]);
		return normalizeFiles([...tracked, ...untracked]);
	} catch {
		const files: string[] = [];
		for await (const entry of new Bun.Glob("**/*").scan({ cwd, absolute: false, dot: true, onlyFiles: true })) {
			const normalized = entry.split(path.sep).join("/");
			if (hasIgnoredDirectory(normalized)) continue;
			files.push(normalized);
		}
		return normalizeFiles(files);
	}
}

function normalizeFiles(files: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const file of files) {
		const value = file.replaceAll("\\", "/").replace(/^\.\//, "");
		if (!value || hasIgnoredDirectory(value) || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized.sort();
}
function hasIgnoredDirectory(file: string): boolean {
	for (const segment of file.split("/")) {
		if (IGNORED_DIRECTORIES[segment] || segment.startsWith("bazel-")) return true;
	}
	return false;
}

function markerRoots(files: readonly string[], matches: (file: string, basename: string) => boolean): string[] {
	const roots: string[] = [];
	for (const file of files) {
		if (!matches(file, path.posix.basename(file))) continue;
		roots.push(path.posix.dirname(file));
	}
	return topmostRoots(roots);
}

function topmostRoots(roots: readonly string[]): string[] {
	const sorted = [...new Set(roots)].sort(
		(left, right) =>
			(left === "." ? 0 : left.split("/").length) - (right === "." ? 0 : right.split("/").length) ||
			left.localeCompare(right),
	);
	const selected: string[] = [];
	for (const root of sorted) {
		if (selected.some(parent => root === parent || (parent === "." ? true : root.startsWith(`${parent}/`)))) continue;
		selected.push(root);
	}
	return selected;
}

function containsExtension(files: readonly string[], extensions: readonly string[]): boolean {
	return files.some(file => extensions.some(extension => file.toLowerCase().endsWith(extension)));
}

function rootsForBasenames(files: readonly string[], basenames: Record<string, true>): string[] {
	return markerRoots(files, (_file, basename) => basenames[basename] === true);
}

function rootsForPattern(files: readonly string[], pattern: RegExp): string[] {
	return markerRoots(files, file => pattern.test(file));
}

function resolveBinary(state: DiscoveryState, root: string, names: readonly string[]): string | undefined {
	const cwd = path.resolve(state.projectCwd, root);
	const searchDirectories: string[] = [];
	let current = cwd;
	while (true) {
		searchDirectories.push(
			path.join(current, "node_modules", ".bin"),
			path.join(current, ".venv", process.platform === "win32" ? "Scripts" : "bin"),
			path.join(current, "venv", process.platform === "win32" ? "Scripts" : "bin"),
			path.join(current, "vendor", "bin"),
		);
		if (current === state.projectCwd) break;
		const parent = path.dirname(current);
		if (parent === current || (!parent.startsWith(`${state.projectCwd}${path.sep}`) && parent !== state.projectCwd))
			break;
		current = parent;
	}
	const searchPath = [...new Set(searchDirectories), Bun.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
	for (const name of names) {
		const executable = $which(name, { cwd, PATH: searchPath });
		if (executable) return executable;
	}
	return undefined;
}

function addPlan(state: DiscoveryState, request: PlanRequest): void {
	const cwd = path.resolve(state.projectCwd, request.root);
	const executable = request.executable ?? resolveBinary(state, request.root, request.binaries);
	const rootLabel = request.root === "." ? "." : request.root;
	if (!executable) {
		state.skipped.push({
			label: `${request.label} (${rootLabel})`,
			language: request.language,
			reason: `未找到可执行文件:${request.binaries.join(" 或 ")}`,
		});
		return;
	}
	const displayExecutable = path.basename(executable);
	state.plans.push({
		id: `${request.id}:${request.root}`,
		label: `${request.label} (${rootLabel})`,
		language: request.language,
		cwd,
		executable,
		args: request.args,
		parser: request.parser,
		command: formatCommand([displayExecutable, ...request.args]),
		mutates: request.mutates ?? false,
	});
}

function formatCommand(argv: readonly string[]): string {
	return argv.map(arg => (/^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

async function discoverRust(state: DiscoveryState): Promise<void> {
	for (const root of rootsForBasenames(state.files, { "Cargo.toml": true })) {
		const cargo = resolveBinary(state, root, ["cargo"]);
		if (!cargo) {
			addPlan(state, {
				id: "clippy",
				label: "cargo clippy",
				language: "Rust",
				root,
				binaries: ["cargo"],
				args: [],
				parser: "rust",
			});
			continue;
		}
		let packages: string[];
		try {
			packages = await cargoWorkspacePackages(state, root, cargo);
		} catch (error) {
			state.skipped.push({
				label: `cargo clippy (${root})`,
				language: "Rust",
				reason: `cargo metadata 失败:${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		if (packages.length === 0) {
			state.skipped.push({
				label: `cargo clippy (${root})`,
				language: "Rust",
				reason: "未找到第一方工作区包",
			});
			continue;
		}
		const packageArgs = packages.flatMap(packageName => ["--package", packageName]);
		addPlan(state, {
			id: "clippy",
			label: "cargo clippy",
			language: "Rust",
			root,
			binaries: ["cargo"],
			executable: cargo,
			args: [
				"clippy",
				"--fix",
				"--allow-dirty",
				"--all-targets",
				"--no-deps",
				"--allow-staged",
				"--broken-code",
				"--allow-no-vcs",
				...packageArgs,
				"--message-format=json",
				"--",
				"-D",
				"warnings",
			],
			parser: "rust",
			mutates: true,
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "cargo-test",
				label: "cargo test",
				language: "Rust",
				root,
				binaries: ["cargo"],
				executable: cargo,
				args: ["test", "--no-fail-fast", "--all-targets", ...packageArgs, "--message-format=json"],
				parser: "rust-test",
			});
		}
	}
}

async function cargoWorkspacePackages(state: DiscoveryState, root: string, cargo: string): Promise<string[]> {
	const manifest = path.resolve(state.projectCwd, root, "Cargo.toml");
	const result = await ptree.exec(
		[cargo, "metadata", "--no-deps", "--format-version=1", "--manifest-path", manifest],
		{
			cwd: path.resolve(state.projectCwd, root),
			stderr: "full",
			allowNonZero: true,
		},
	);
	if (!result.ok) {
		throw new Error(
			sanitizeText(result.stderr || result.stdout)
				.replace(/\s+/g, " ")
				.trim(),
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`无效的 JSON:${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("metadata 根不是对象");
	const workspaceMembers = new Set<string>();
	if (Array.isArray(parsed.workspace_members)) {
		for (const member of parsed.workspace_members) {
			if (typeof member === "string") workspaceMembers.add(member);
		}
	}
	const allowedFiles = new Set(state.files);
	const packages: string[] = [];
	if (!Array.isArray(parsed.packages)) return packages;
	for (const value of parsed.packages) {
		if (!isRecord(value) || typeof value.id !== "string" || !workspaceMembers.has(value.id)) continue;
		if (typeof value.name !== "string" || typeof value.manifest_path !== "string") continue;
		const relativeManifest = path.relative(state.projectCwd, value.manifest_path).split(path.sep).join("/");
		if (allowedFiles.has(relativeManifest)) packages.push(value.name);
	}
	return [...new Set(packages)].sort();
}

function discoverGo(state: DiscoveryState): void {
	const workRoots = rootsForBasenames(state.files, { "go.work": true });
	const roots = workRoots.length > 0 ? workRoots : rootsForBasenames(state.files, { "go.mod": true });
	for (const root of roots) {
		addPlan(state, {
			id: "go-vet",
			label: "go vet",
			language: "Go",
			root,
			binaries: ["go"],
			args: ["vet", "-json", "./..."],
			parser: "go",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "go-test",
				label: "go test",
				language: "Go",
				root,
				binaries: ["go"],
				args: ["test", "-json", "./..."],
				parser: "go-test",
			});
		}
	}
}

function discoverPython(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".py", ".pyi"])) return;
	const roots = rootsForBasenames(state.files, {
		".ruff.toml": true,
		"pyproject.toml": true,
		"ruff.toml": true,
		"setup.cfg": true,
		"tox.ini": true,
	});
	for (const root of roots.length > 0 ? roots : ["."]) {
		addPlan(state, {
			id: "ruff",
			label: "ruff",
			language: "Python",
			root,
			binaries: ["ruff"],
			args: ["check", "--output-format=json", "."],
			parser: "ruff",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "pytest",
				label: "pytest",
				language: "Python",
				root,
				binaries: ["pytest"],
				args: ["-q"],
				parser: "generic",
			});
		}
	}
	for (const root of rootsForBasenames(state.files, { "pyrightconfig.json": true })) {
		addPlan(state, {
			id: "pyright",
			label: "pyright",
			language: "Python",
			root,
			binaries: ["pyright"],
			args: ["--outputjson"],
			parser: "pyright",
		});
	}
}

async function discoverJavaScript(state: DiscoveryState): Promise<void> {
	if (!containsExtension(state.files, [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"])) return;
	for (const root of rootsForBasenames(state.files, { "biome.json": true, "biome.jsonc": true })) {
		addPlan(state, {
			id: "biome",
			label: "biome check",
			language: "JavaScript/TypeScript",
			root,
			binaries: ["biome"],
			args: ["check", ".", "--reporter=json"],
			parser: "biome",
		});
	}
	const eslintConfig =
		/(?:^|\/)(?:eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)|\.eslintrc(?:\.(?:js|cjs|json|yaml|yml))?)$/;
	for (const root of rootsForPattern(state.files, eslintConfig)) {
		addPlan(state, {
			id: "eslint",
			label: "eslint",
			language: "JavaScript/TypeScript",
			root,
			binaries: ["eslint"],
			args: [".", "--format=json"],
			parser: "eslint",
		});
	}
	for (const root of rootsForBasenames(state.files, { "tsconfig.json": true })) {
		addPlan(state, {
			id: "typescript",
			label: "TypeScript",
			language: "TypeScript",
			root,
			binaries: ["tsgo", "tsc"],
			args: ["--noEmit", "--pretty", "false"],
			parser: "generic",
		});
	}
	if (state.includeTests) await discoverPackageTests(state);
}

async function discoverPackageTests(state: DiscoveryState): Promise<void> {
	const candidates: Array<{ root: string; manager: string }> = [];
	for (const file of state.files) {
		if (path.posix.basename(file) !== "package.json") continue;
		let manifest: unknown;
		try {
			manifest = await Bun.file(path.resolve(state.projectCwd, file)).json();
		} catch {
			continue;
		}
		if (!isRecord(manifest) || !isRecord(manifest.scripts)) continue;
		const testScript = manifest.scripts.test;
		if (
			typeof testScript !== "string" ||
			!testScript.trim() ||
			testScript.toLowerCase().includes("no test specified")
		) {
			continue;
		}
		const root = path.posix.dirname(file);
		let manager =
			typeof manifest.packageManager === "string" ? manifest.packageManager.split("@", 1)[0].toLowerCase() : "";
		const prefix = root === "." ? "" : `${root}/`;
		if (!["bun", "npm", "pnpm", "yarn"].includes(manager)) {
			if (state.files.includes(`${prefix}bun.lock`) || state.files.includes(`${prefix}bun.lockb`)) manager = "bun";
			else if (state.files.includes(`${prefix}pnpm-lock.yaml`)) manager = "pnpm";
			else if (state.files.includes(`${prefix}yarn.lock`)) manager = "yarn";
			else manager = "npm";
		}
		candidates.push({ root, manager });
	}
	const selectedRoots = new Set(topmostRoots(candidates.map(candidate => candidate.root)));
	for (const candidate of candidates) {
		if (!selectedRoots.has(candidate.root)) continue;
		addPlan(state, {
			id: `${candidate.manager}-test`,
			label: `${candidate.manager} test`,
			language: "JavaScript/TypeScript",
			root: candidate.root,
			binaries: [candidate.manager],
			args: ["run", "test"],
			parser: "generic",
		});
	}
}

function discoverRuby(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".rb", ".rake"])) return;
	for (const root of rootsForBasenames(state.files, { ".rubocop.yml": true, ".rubocop.yaml": true })) {
		addPlan(state, {
			id: "rubocop",
			label: "rubocop",
			language: "Ruby",
			root,
			binaries: ["rubocop"],
			args: ["--format", "json", "--force-exclusion"],
			parser: "rubocop",
		});
	}
	if (state.includeTests) {
		for (const root of rootsForPattern(state.files, /(?:^|\/)(?:\.rspec|Gemfile)$/)) {
			addPlan(state, {
				id: "rspec",
				label: "RSpec",
				language: "Ruby",
				root,
				binaries: ["rspec"],
				args: ["--format", "progress"],
				parser: "generic",
			});
		}
	}
}

function discoverPhp(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".php"])) return;
	for (const root of rootsForPattern(state.files, /(?:^|\/)phpstan\.neon(?:\.dist)?$/)) {
		addPlan(state, {
			id: "phpstan",
			label: "PHPStan",
			language: "PHP",
			root,
			binaries: ["phpstan"],
			args: ["analyse", "--error-format=json", "--no-progress"],
			parser: "phpstan",
		});
	}
	for (const root of rootsForPattern(state.files, /(?:^|\/)psalm(?:\.xml|\.xml\.dist)$/)) {
		addPlan(state, {
			id: "psalm",
			label: "Psalm",
			language: "PHP",
			root,
			binaries: ["psalm"],
			args: ["--output-format=json", "--no-progress"],
			parser: "psalm",
		});
	}
	if (state.includeTests) {
		for (const root of rootsForPattern(state.files, /(?:^|\/)phpunit\.xml(?:\.dist)?$/)) {
			addPlan(state, {
				id: "phpunit",
				label: "PHPUnit",
				language: "PHP",
				root,
				binaries: ["phpunit"],
				args: [],
				parser: "generic",
			});
		}
	}
}

function discoverSwift(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".swift"])) return;
	const configured = rootsForBasenames(state.files, { ".swiftlint.yml": true });
	const roots = configured.length > 0 ? configured : rootsForBasenames(state.files, { "Package.swift": true });
	for (const root of roots) {
		addPlan(state, {
			id: "swiftlint",
			label: "SwiftLint",
			language: "Swift",
			root,
			binaries: ["swiftlint"],
			args: ["lint", "--reporter", "json", "--quiet"],
			parser: "swiftlint",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "swift-test",
				label: "swift test",
				language: "Swift",
				root,
				binaries: ["swift"],
				args: ["test"],
				parser: "generic",
			});
		}
	}
}

function discoverDart(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".dart"])) return;
	for (const root of rootsForBasenames(state.files, { "pubspec.yaml": true })) {
		addPlan(state, {
			id: "dart-analyze",
			label: "dart analyze",
			language: "Dart",
			root,
			binaries: ["dart"],
			args: ["analyze", "--format", "machine"],
			parser: "dart",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "dart-test",
				label: "dart test",
				language: "Dart",
				root,
				binaries: ["dart"],
				args: ["test", "--reporter", "json"],
				parser: "generic",
			});
		}
	}
}

function discoverElixir(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".ex", ".exs"])) return;
	for (const root of rootsForBasenames(state.files, { ".credo.exs": true })) {
		addPlan(state, {
			id: "credo",
			label: "Credo",
			language: "Elixir",
			root,
			binaries: ["mix"],
			args: ["credo", "--format=json"],
			parser: "credo",
		});
	}
	if (state.includeTests) {
		for (const root of rootsForBasenames(state.files, { "mix.exs": true })) {
			addPlan(state, {
				id: "mix-test",
				label: "mix test",
				language: "Elixir",
				root,
				binaries: ["mix"],
				args: ["test"],
				parser: "generic",
			});
		}
	}
}

function discoverShell(state: DiscoveryState): void {
	const shellFiles = state.files.filter(file => /\.(?:sh|bash|ksh|zsh)$/.test(file));
	if (shellFiles.length === 0) return;
	for (let index = 0; index < shellFiles.length; index += SHELLCHECK_BATCH_SIZE) {
		const batch = shellFiles.slice(index, index + SHELLCHECK_BATCH_SIZE);
		addPlan(state, {
			id: `shellcheck-${Math.floor(index / SHELLCHECK_BATCH_SIZE) + 1}`,
			label: "ShellCheck",
			language: "Shell",
			root: ".",
			binaries: ["shellcheck"],
			args: ["--format=json1", ...batch],
			parser: "shellcheck",
		});
	}
}

function discoverHaskell(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".hs", ".lhs"])) return;
	const roots = rootsForPattern(state.files, /(?:^|\/)(?:\.hlint\.yaml|stack\.yaml|cabal\.project|[^/]+\.cabal)$/);
	for (const root of roots.length > 0 ? roots : ["."]) {
		addPlan(state, {
			id: "hlint",
			label: "HLint",
			language: "Haskell",
			root,
			binaries: ["hlint"],
			args: ["--json", "."],
			parser: "hlint",
		});
		if (state.includeTests) {
			const prefix = root === "." ? "" : `${root}/`;
			const useStack = state.files.includes(`${prefix}stack.yaml`);
			addPlan(state, {
				id: useStack ? "stack-test" : "cabal-test",
				label: useStack ? "stack test" : "cabal test",
				language: "Haskell",
				root,
				binaries: [useStack ? "stack" : "cabal"],
				args: useStack ? ["test"] : ["test", "all"],
				parser: "generic",
			});
		}
	}
}

function discoverTerraform(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".tf"])) return;
	const configured = rootsForBasenames(state.files, { ".tflint.hcl": true });
	const roots = configured.length > 0 ? configured : rootsForPattern(state.files, /\.tf$/);
	for (const root of roots) {
		addPlan(state, {
			id: "tflint",
			label: "TFLint",
			language: "Terraform",
			root,
			binaries: ["tflint"],
			args: ["--format=json", "--recursive"],
			parser: "tflint",
		});
		addPlan(state, {
			id: "terraform-validate",
			label: "terraform validate",
			language: "Terraform",
			root,
			binaries: ["terraform"],
			args: ["validate", "-json"],
			parser: "terraform",
		});
	}
}

function discoverLua(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".lua"])) return;
	const configured = rootsForBasenames(state.files, { ".luacheckrc": true });
	for (const root of configured.length > 0 ? configured : ["."]) {
		addPlan(state, {
			id: "luacheck",
			label: "Luacheck",
			language: "Lua",
			root,
			binaries: ["luacheck"],
			args: ["."],
			parser: "generic",
		});
	}
	if (state.includeTests && state.files.some(file => /(?:^|\/)(?:spec|test)\/.*_spec\.lua$/.test(file))) {
		addPlan(state, {
			id: "busted",
			label: "Busted",
			language: "Lua",
			root: ".",
			binaries: ["busted"],
			args: [],
			parser: "generic",
		});
	}
}

function discoverCpp(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"])) return;
	for (const root of rootsForBasenames(state.files, { "compile_commands.json": true })) {
		addPlan(state, {
			id: "clang-tidy",
			label: "clang-tidy",
			language: "C/C++",
			root: ".",
			binaries: ["run-clang-tidy", "run-clang-tidy.py"],
			args: ["-quiet", "-p", path.resolve(state.projectCwd, root)],
			parser: "generic",
		});
	}
}

function discoverDotnet(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".cs", ".fs", ".vb"])) return;
	const solutions = rootsForPattern(state.files, /\.(?:sln|slnx)$/i);
	const roots = solutions.length > 0 ? solutions : rootsForPattern(state.files, /\.(?:csproj|fsproj|vbproj)$/i);
	for (const root of roots) {
		addPlan(state, {
			id: "dotnet-build",
			label: "dotnet build",
			language: ".NET",
			root,
			binaries: ["dotnet"],
			args: ["build", "--no-restore", "--nologo", "--verbosity", "quiet"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "dotnet-test",
				label: "dotnet test",
				language: ".NET",
				root,
				binaries: ["dotnet"],
				args: ["test", "--no-restore", "--nologo", "--verbosity", "quiet"],
				parser: "generic",
			});
		}
	}
}

function discoverZig(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".zig"])) return;
	for (const root of rootsForBasenames(state.files, { "build.zig": true })) {
		addPlan(state, {
			id: "zig-build",
			label: "zig build",
			language: "Zig",
			root,
			binaries: ["zig"],
			args: ["build"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "zig-test",
				label: "zig build test",
				language: "Zig",
				root,
				binaries: ["zig"],
				args: ["build", "test"],
				parser: "generic",
			});
		}
	}
}

function discoverJvm(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".java", ".kt", ".kts", ".scala"])) return;
	const gradleRoots = rootsForBasenames(state.files, {
		"build.gradle": true,
		"build.gradle.kts": true,
		"settings.gradle": true,
		"settings.gradle.kts": true,
	});
	for (const root of gradleRoots) {
		const unixWrapper = path.posix.join(root, "gradlew");
		const windowsWrapper = path.posix.join(root, "gradlew.bat");
		const wrapper = state.files.includes(unixWrapper)
			? path.resolve(state.projectCwd, unixWrapper)
			: state.files.includes(windowsWrapper)
				? path.resolve(state.projectCwd, windowsWrapper)
				: undefined;
		addPlan(state, {
			id: "gradle-check",
			label: "Gradle check",
			language: "JVM",
			root,
			binaries: ["gradle"],
			executable: wrapper,
			args: ["check", "-x", "test", "--console=plain", "--no-daemon"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "gradle-test",
				label: "Gradle test",
				language: "JVM",
				root,
				binaries: ["gradle"],
				executable: wrapper,
				args: ["test", "--console=plain", "--no-daemon"],
				parser: "generic",
			});
		}
	}
	for (const root of rootsForBasenames(state.files, { "pom.xml": true })) {
		const unixWrapper = path.posix.join(root, "mvnw");
		const windowsWrapper = path.posix.join(root, "mvnw.cmd");
		const wrapper = state.files.includes(unixWrapper)
			? path.resolve(state.projectCwd, unixWrapper)
			: state.files.includes(windowsWrapper)
				? path.resolve(state.projectCwd, windowsWrapper)
				: undefined;
		addPlan(state, {
			id: "maven-verify",
			label: "Maven verify",
			language: "JVM",
			root,
			binaries: ["mvn"],
			executable: wrapper,
			args: ["-q", "-DskipTests", "-DskipITs", "verify"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "maven-test",
				label: "Maven test",
				language: "JVM",
				root,
				binaries: ["mvn"],
				executable: wrapper,
				args: ["-q", "test"],
				parser: "generic",
			});
		}
	}
}

async function runChecker(
	plan: CheckerPlan,
	projectCwd: string,
	allowedFiles: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<CleanseCheckResult> {
	try {
		const result = await ptree.exec([plan.executable, ...plan.args], {
			cwd: plan.cwd,
			signal,
			stderr: "full",
			allowNonZero: true,
			allowAbort: false,
		});
		const parsedDiagnostics = parseCleanseDiagnostics(plan.parser, {
			checker: plan.label,
			projectCwd,
			checkerCwd: plan.cwd,
			stdout: result.stdout,
			stderr: result.stderr,
		});
		const diagnostics = parsedDiagnostics.filter(
			diagnostic => diagnostic.file === undefined || allowedFiles.has(diagnostic.file),
		);
		if (!result.ok && parsedDiagnostics.length === 0) {
			diagnostics.push(checkerFailureDiagnostic(plan, result.exitCode, result.stdout, result.stderr));
		}
		return {
			id: plan.id,
			label: plan.label,
			language: plan.language,
			cwd: path.relative(projectCwd, plan.cwd) || ".",
			command: plan.command,
			exitCode: result.exitCode,
			diagnostics,
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		return {
			id: plan.id,
			label: plan.label,
			language: plan.language,
			cwd: path.relative(projectCwd, plan.cwd) || ".",
			command: plan.command,
			exitCode: null,
			diagnostics: [
				checkerFailureDiagnostic(plan, null, "", error instanceof Error ? error.message : String(error)),
			],
		};
	}
}

function checkerFailureDiagnostic(
	plan: CheckerPlan,
	exitCode: number | null,
	stdout: string,
	stderr: string,
): CleanseDiagnostic {
	const output = sanitizeText([stderr, stdout].filter(Boolean).join("\n")).trim();
	const suffix = output ? `: ${output.slice(0, MAX_FAILURE_OUTPUT)}` : "";
	return {
		checker: plan.label,
		severity: "error",
		message: `${plan.label} 失败${exitCode === null ? "" : `,退出码 ${exitCode}`}${suffix}`,
	};
}

function deduplicateProjectDiagnostics(diagnostics: CleanseDiagnostic[]): CleanseDiagnostic[] {
	const seen = new Set<string>();
	const unique: CleanseDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const key = [
			diagnostic.file ?? "",
			diagnostic.line ?? "",
			diagnostic.column ?? "",
			diagnostic.code ?? "",
			diagnostic.message,
		].join("\u0000");
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(diagnostic);
	}
	return unique.sort(
		(left, right) =>
			(left.file ?? "").localeCompare(right.file ?? "") ||
			(left.line ?? 0) - (right.line ?? 0) ||
			left.message.localeCompare(right.message),
	);
}
