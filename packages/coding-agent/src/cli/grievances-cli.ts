/**
 * CLI handler for `omp grievances` — view, clean, and manually push reported tool issues.
 */
import chalk from "chalk";
import { Settings } from "../config/settings";
import { flushGrievances, openAutoQaDb } from "../tools/report-tool-issue";

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

export interface ListGrievancesOptions {
	limit: number;
	tool?: string;
	json: boolean;
}

export interface CleanGrievancesOptions {
	/** Delete a single grievance by id. */
	id?: number;
	/** Delete every grievance recorded for this tool name. */
	tool?: string;
	/** Delete every grievance regardless of tool/id. */
	all?: boolean;
	/** Output the deletion count as JSON instead of a status message. */
	json?: boolean;
}

export interface PushGrievancesOptions {
	/** Emit the {@link FlushResult} as JSON instead of a status line. */
	json?: boolean;
}
export async function listGrievances(options: ListGrievancesOptions): Promise<void> {
	const db = openAutoQaDb();
	if (!db) {
		if (options.json) {
			console.log("[]");
		} else {
			console.log(chalk.dim("未找到反馈数据库。自动 QA 尚未记录任何报告(或已被禁用)。"));
		}
		return;
	}

	try {
		let rows: GrievanceRow[];
		if (options.tool) {
			rows = db
				.prepare("SELECT id, model, version, tool, report FROM grievances WHERE tool = ? ORDER BY id DESC LIMIT ?")
				.all(options.tool, options.limit) as GrievanceRow[];
		} else {
			rows = db
				.prepare("SELECT id, model, version, tool, report FROM grievances ORDER BY id DESC LIMIT ?")
				.all(options.limit) as GrievanceRow[];
		}

		if (options.json) {
			console.log(JSON.stringify(rows, null, 2));
			return;
		}

		if (rows.length === 0) {
			console.log(chalk.dim("尚未记录任何反馈。"));
			return;
		}

		for (const row of rows) {
			console.log(
				`${chalk.dim(`#${row.id}`)} ${chalk.cyan(row.tool)} ${chalk.dim(`(${row.model} v${row.version})`)}`,
			);
			console.log(`  ${row.report}`);
			console.log();
		}

		console.log(chalk.dim(`显示最近 ${rows.length} 条${options.tool ? `(工具:${options.tool})` : ""}`));
	} finally {
		db.close();
	}
}

/**
 * Delete grievances from the auto-QA database.
 *
 * Selectors are mutually exclusive in intent — exactly one of `id`, `tool`, or
 * `all` is required. Multiple selectors are rejected to prevent ambiguous deletes
 * (e.g. `--id 5 --all` would be a footgun). Returns silently when the database
 * does not exist yet.
 */
export async function cleanGrievances(options: CleanGrievancesOptions): Promise<void> {
	const selectors = [options.id !== undefined, !!options.tool, !!options.all].filter(Boolean).length;
	if (selectors === 0) {
		console.error(chalk.red("请从 --id、--tool、--all 中恰好指定一个。"));
		process.exitCode = 1;
		return;
	}
	if (selectors > 1) {
		console.error(chalk.red("--id、--tool 和 --all 互斥。"));
		process.exitCode = 1;
		return;
	}

	const db = openAutoQaDb();
	if (!db) {
		if (options.json) {
			console.log(JSON.stringify({ deleted: 0 }));
		} else {
			console.log(chalk.dim("未找到反馈数据库。自动 QA 尚未记录任何报告(或已被禁用)。"));
		}
		return;
	}

	try {
		let deleted = 0;
		if (options.id !== undefined) {
			const result = db.prepare("DELETE FROM grievances WHERE id = ?").run(options.id);
			deleted = Number(result.changes);
		} else if (options.tool) {
			const result = db.prepare("DELETE FROM grievances WHERE tool = ?").run(options.tool);
			deleted = Number(result.changes);
		} else {
			const result = db.prepare("DELETE FROM grievances").run();
			deleted = Number(result.changes);
			// Reset the autoincrement counter so a fresh slate starts at #1 again.
			// `sqlite_sequence` only exists if AUTOINCREMENT was ever used; ignore failures.
			try {
				db.prepare("DELETE FROM sqlite_sequence WHERE name = 'grievances'").run();
			} catch {
				/* sequence table missing on a brand-new db — nothing to reset */
			}
		}

		if (options.json) {
			console.log(JSON.stringify({ deleted }));
			return;
		}

		if (deleted === 0) {
			console.log(chalk.dim("没有匹配的反馈可删除。"));
			return;
		}

		const scope =
			options.id !== undefined ? `#${options.id}` : options.tool ? `(工具:${options.tool})` : "(全部记录)";
		console.log(chalk.green(`已删除 ${deleted} 条反馈 ${scope}。`));
	} finally {
		db.close();
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Manual push (`omp grievances push`)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Single-line ANSI progress reporter. `update(done)` rewrites the line via
 * `\r`; `finish()` newlines out so subsequent log lines land cleanly. On a
 * non-TTY stdout (CI, pipes) both calls no-op so log files don't fill with
 * carriage-return noise.
 */
interface ProgressBar {
	update(done: number): void;
	finish(): void;
}

function makeProgressBar(total: number, width = 30): ProgressBar {
	const isTty = !!process.stdout.isTTY;
	if (!isTty || total === 0) {
		return { update: () => undefined, finish: () => undefined };
	}
	const render = (done: number): void => {
		const ratio = Math.min(1, done / total);
		const filled = Math.round(ratio * width);
		const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
		const pct = `${Math.floor(ratio * 100)
			.toString()
			.padStart(3, " ")}%`;
		process.stdout.write(`\r${chalk.cyan("正在推送")} [${bar}] ${pct} ${done}/${total}`);
	};
	render(0);
	return {
		update: render,
		finish: () => process.stdout.write("\n"),
	};
}

/**
 * Manually drain every unpushed grievance to the configured backend,
 * ignoring the user-facing consent gate (manual push is the user's
 * explicit "yes ship these now" intent).
 *
 * Requires endpoint configuration (default `qa.omp.sh/v1/grievances`).
 */
export async function pushGrievances(options: PushGrievancesOptions): Promise<void> {
	const db = openAutoQaDb();
	if (!db) {
		if (options.json) {
			console.log(JSON.stringify({ pushed: 0, ok: false, skipped: true, reason: "no_db" }));
		} else {
			console.log(chalk.dim("未找到反馈数据库——没有可推送的内容。"));
		}
		return;
	}
	const settings = await Settings.init();
	let bar: ProgressBar = { update: () => undefined, finish: () => undefined };
	let total = 0;

	try {
		const result = await flushGrievances(db, settings, {
			bypassConsent: true,
			onStart: t => {
				total = t;
				if (!options.json) bar = makeProgressBar(t);
			},
			onProgress: pushed => bar.update(pushed),
		});
		bar.finish();

		if (options.json) {
			console.log(JSON.stringify(result));
			return;
		}

		if (result.skipped) {
			console.log(
				chalk.yellow("推送已跳过——未配置端点。请设置 `dev.autoqaPush.endpoint` 或 `PI_AUTO_QA_PUSH_URL`。"),
			);
			return;
		}
		if (total === 0) {
			console.log(chalk.dim("没有可推送的内容——所有反馈都已发送。"));
			return;
		}
		if (result.ok) {
			console.log(chalk.green(`已推送 ${result.pushed}/${total} 条反馈。`));
			return;
		}
		const remaining = total - result.pushed;
		console.log(chalk.red(`推送失败,已推送 ${result.pushed}/${total};仍有 ${remaining} 条反馈未推送。`));
		process.exitCode = 1;
	} finally {
		db.close();
	}
}
