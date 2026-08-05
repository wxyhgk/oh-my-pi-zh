/**
 * Run on-disk storage maintenance.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { gcHelp as commandHelp } from "../cli/command-help";
import { collectGcErrors, type GcCommandArgs, runGcCommand } from "../cli/gc-cli";

export default class Gc extends Command {
	static description = commandHelp.description;
	static flags = {
		apply: Flags.boolean({ description: "应用更改（默认为 dry-run 预览）" }),
		json: Flags.boolean({ description: "输出 JSON" }),
		"agent-dir": Flags.string({ description: "要维护的 Agent 目录" }),
		blobs: Flags.boolean({ description: "清理无引用的 blob" }),
		archive: Flags.boolean({ description: "归档冷会话" }),
		wal: Flags.boolean({ description: "对历史/模型数据库的 WAL 文件执行检查点" }),
		"cold-archive-after-days": Flags.integer({ description: "归档前的最小会话天数" }),
		"retain-newest-global": Flags.integer({ description: "始终保留最近多少个会话为活动状态" }),
		"retain-newest-per-cwd": Flags.integer({ description: "每个 cwd 始终保留最近多少个会话为活动状态" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gc);
		const cmd: GcCommandArgs = {
			flags: {
				apply: flags.apply,
				json: flags.json,
				agentDir: flags["agent-dir"],
				blobs: flags.blobs,
				archive: flags.archive,
				wal: flags.wal,
				coldArchiveAfterDays: flags["cold-archive-after-days"],
				retainNewestGlobal: flags["retain-newest-global"],
				retainNewestPerCwd: flags["retain-newest-per-cwd"],
			},
		};
		const result = await runGcCommand(cmd);
		const errors = collectGcErrors(result);
		if (errors.length > 0) {
			process.stderr.write(
				`GC 完成，但有 ${errors.length} 个错误：\n${errors.map(error => `- ${error}`).join("\n")}\n`,
			);
			process.exitCode = 1;
		}
	}
}
