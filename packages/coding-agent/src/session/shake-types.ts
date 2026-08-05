/**
 * Public shape of the `shake` operation, kept in a dependency-free leaf module
 * so slash-command registries and controllers can import `formatShakeSummary`
 * without pulling in the heavy `agent-session` module graph (which would form
 * an import cycle through the slash-command registry).
 */

/** Mode selector for `AgentSession.shake`. */
export type ShakeMode = "elide" | "images";

/** Outcome of an `AgentSession.shake` run. */
export interface ShakeResult {
	mode: ShakeMode;
	/** Whole tool-call results dropped. */
	toolResultsDropped: number;
	/** Large fenced/XML blocks dropped. */
	blocksDropped: number;
	/** Image blocks removed (images mode only). */
	imagesDropped?: number;
	/** Estimated context tokens reclaimed. */
	tokensFreed: number;
	/** Session artifact holding the dropped originals, when persisted. */
	artifactId?: string;
}

/** One-line operator summary of a {@link ShakeResult} (shared by TUI + ACP). */
export function formatShakeSummary(result: ShakeResult): string {
	if (result.mode === "images") {
		const n = result.imagesDropped ?? 0;
		return n === 0
			? "此会话中未找到图片。"
			: `已从本会话中移除 ${n} 张图片。`;
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) {
		parts.push(`${result.toolResultsDropped} 条工具结果`);
	}
	if (result.blocksDropped > 0) {
		parts.push(`${result.blocksDropped} 个块`);
	}
	if (parts.length === 0) return "没有可清理的内容。";
	return `已清理 ${parts.join(" + ")}（释放约 ${result.tokensFreed} token）。`;
}
