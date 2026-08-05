import type { MemoryBackendId } from "./types";

/**
 * Fallback text for `/memory stats` and `/memory diagnose` when the active
 * backend's hook is missing or returns nothing.
 *
 * The `off` backend isn't a real backend a user picked among several
 * stats-capable options — it's the no-op state memory falls back to by
 * default — so it gets its own message instead of the generic
 * "not available for the X backend" template, which would otherwise read as
 * the self-contradictory "not available for the off backend".
 *
 * Shared by both the TUI (`CommandController.handleMemoryCommand`) and the
 * ACP/RPC slash-command handler so the two surfaces stay consistent.
 */
export function memoryStatsUnavailableMessage(backendId: MemoryBackendId, action: "stats" | "diagnose"): string {
	if (backendId === "off") return "记忆后端已关闭——没有可显示的内容。";
	return `记忆${action === "stats" ? "统计" : "诊断"}不适用于 ${backendId} 后端。`;
}
