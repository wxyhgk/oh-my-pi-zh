/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import { truncateToWidth } from "@wxyhgk/pi-tui/utils";
import { APP_NAME, formatDuration, formatNumber, formatPercent } from "@wxyhgk/pi-utils";
import chalk from "chalk";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Argument Parser
// =============================================================================

/**
 * Parse stats subcommand arguments.
 * Returns undefined if not a stats command.
 */
export function parseStatsArgs(args: string[]): StatsCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "stats") {
		return undefined;
	}

	const result: StatsCommandArgs = {
		port: 3847,
		json: false,
		summary: false,
	};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json" || arg === "-j") {
			result.json = true;
		} else if (arg === "--summary" || arg === "-s") {
			result.summary = true;
		} else if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
			result.port = parseInt(args[++i], 10);
		} else if (arg.startsWith("--port=")) {
			result.port = parseInt(arg.split("=")[1], 10);
		}
	}

	return result;
}

function formatCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { getDashboardStats, syncAllSessions, getTotalMessageCount, startServer, closeDb } = await import(
		"@wxyhgk/omp-stats"
	);

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("正在同步会话文件...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`已从 ${files} 个文件同步 ${processed} 条新记录(共 ${total} 条)\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		await printStatsSummary();
		return;
	}

	// Start the dashboard server
	const { port } = await startServer(cmd.port);
	console.log(chalk.green(`仪表盘地址:http://localhost:${port}`));

	// Open browser
	const url = `http://localhost:${port}`;
	openPath(url);

	console.log("按 Ctrl+C 停止\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\n正在关闭...\n");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@wxyhgk/omp-stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold("\n=== AI 用量统计 ===\n"));

	console.log(chalk.bold("总计:"));
	console.log(`  请求数:${formatNumber(overall.totalRequests)}(错误 ${formatNumber(overall.failedRequests)})`);
	console.log(`  错误率:${formatPercent(overall.errorRate)}`);
	console.log(`  总 token 数:${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  输入 token:${formatNumber(overall.totalInputTokens)}`);
	console.log(`  输出 token:${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  缓存命中率:${formatPercent(overall.cacheRate)}`);
	console.log(`  总费用:${formatCost(overall.totalCost)}`);
	console.log(`  高级请求数:${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  平均耗时:${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  平均 TTFT:${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  平均 token/s:${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\n按模型:"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}:${formatNumber(m.totalRequests)} 次请求,${formatCost(m.totalCost)},缓存命中率 ${formatPercent(m.cacheRate)}`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\n按目录:"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}:${formatNumber(f.totalRequests)} 次请求,${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}

// =============================================================================
// Help
// =============================================================================

export function printStatsHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} stats`)} - AI 用量统计仪表盘

${chalk.bold("用法:")}
  ${APP_NAME} stats [options]

${chalk.bold("选项:")}
  -p, --port <port>  仪表盘服务器端口(默认:3847)
  -j, --json         以 JSON 输出统计并退出
  -s, --summary      在控制台打印摘要并退出
  -h, --help         显示此帮助信息

${chalk.bold("示例:")}
  ${APP_NAME} stats              # 启动仪表盘服务器
  ${APP_NAME} stats --json       # 以 JSON 打印统计
  ${APP_NAME} stats --summary    # 在控制台打印摘要
  ${APP_NAME} stats --port 8080  # 使用自定义端口启动

${chalk.bold("指标:")}
  - 总请求数与错误率
  - token 用量(输入、输出、缓存)
  - 费用明细
  - 平均耗时与首 token 时间(TTFT)
  - 每秒 token 吞吐量
`);
}
