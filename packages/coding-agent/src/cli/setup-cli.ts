/**
 * Setup CLI command handler.
 *
 * Handles `omp setup` for onboarding and `omp setup <component>` for optional dependencies.
 */
import * as path from "node:path";
import { APP_NAME, getProjectDir, getPythonEnvDir } from "@wxyhgk/pi-utils";
import chalk from "chalk";
import { Settings, settings } from "../config/settings";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { theme } from "../modes/theme/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODEL_OPTIONS } from "../tts";
import { selectSetupModel } from "./setup-model-picker";

export type SetupComponent = "python" | "speech";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "speech"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`用法:${APP_NAME} setup <component>`));
		console.error(`有效组件:${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(`未知组件:${component}`));
		console.error(`有效组件:${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(cwd: string, interpreter?: string): Promise<PythonCheckResult> {
	const availability = await checkPythonKernelAvailability(cwd, interpreter, { forceProbe: true });
	return {
		available: availability.ok,
		pythonPath: availability.pythonPath,
		usingManagedEnv: availability.pythonPath === managedPythonPath(),
		managedEnvPath: MANAGED_PYTHON_ENV,
	};
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `omp setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const cwd = getProjectDir();
	const projectSettings = await Settings.init({ cwd });
	const interpreter = projectSettings.get("python.interpreter")?.trim() || undefined;
	const check = await checkPythonSetup(cwd, interpreter);

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} 未找到 Python`));
		console.error(chalk.dim("请安装 Python 3.8+ 或在 python.interpreter 中设置其可执行文件路径"));
		process.exit(1);
	}

	console.log(chalk.dim(`Python:${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(`正在使用受管理的环境:${check.managedEnvPath}`));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} Python 执行环境已就绪`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} Python 解释器报告失败`));
	process.exit(1);
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function buildSpeechComponents(): SpeechComponent[] {
	return [
		{
			name: "语音转文字模型",
			isReady: () => isSttModelCached(settings.get("stt.modelName")),
			status: async () => {
				const key = settings.get("stt.modelName");
				return (await isSttModelCached(key)) ? key : `${key} — 未下载`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"语音转文字模型",
					[...STT_MODEL_OPTIONS],
					settings.get("stt.modelName"),
				);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.set("stt.modelName", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(settings.get("stt.modelName"), progress =>
					onProgress({ stage: `正在下载 ${progress.label} 模型`, percent: progress.percent }),
				),
		},
		{
			name: "文字转语音模型",
			isReady: () => isTtsModelCached(settings.get("tts.localModel")),
			status: async () => {
				const key = settings.get("tts.localModel");
				return (await isTtsModelCached(key)) ? key : `${key} — 模型/运行时未安装`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"文字转语音模型",
					[...TTS_LOCAL_MODEL_OPTIONS],
					settings.get("tts.localModel"),
				);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.set("tts.localModel", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(settings.get("tts.localModel"), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error("下载本地文字转语音模型失败。");
			},
		},
	];
}

/**
 * Unified `omp setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	await Settings.init({ cwd: getProjectDir() });
	const components = buildSpeechComponents();

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold("语音依赖:"));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green("[正常]") : chalk.yellow("[缺失]");
			console.log(`  ${mark} ${component.name}:${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${component.name} 已就绪`));
			continue;
		}
		console.log(chalk.dim(`正在准备 ${component.name}...`));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : `设置 ${component.name} 失败`;
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} 语音功能已就绪`));
	console.log(
		chalk.dim(
			"通过 stt.enabled 启用语音转文字,然后按住空格键说话(或绑定 app.stt.toggle);通过 speechgen.enabled 启用语音生成工具;通过 speech.enabled 让回复朗读出来。",
		),
	);
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - 运行引导设置或安装可选功能的依赖

${chalk.bold("用法:")}
  ${APP_NAME} setup                     运行引导向导
  ${APP_NAME} setup <component> [options]

${chalk.bold("组件:")}
  python    验证 Python 3 解释器可用于执行代码
  speech    选择并下载语音转文字和文字转语音模型

${chalk.bold("选项:")}
  -c, --check   仅检查依赖是否已安装,不执行安装
  --json        以 JSON 输出状态

${chalk.bold("示例:")}
  ${APP_NAME} setup                 运行引导向导
  ${APP_NAME} setup python          检查 Python 执行依赖
  ${APP_NAME} setup speech          选择并下载 STT 和 TTS 模型
  ${APP_NAME} setup speech --check  检查语音依赖是否可用
  ${APP_NAME} setup python --check  检查 Python 执行环境是否可用
`);
}
