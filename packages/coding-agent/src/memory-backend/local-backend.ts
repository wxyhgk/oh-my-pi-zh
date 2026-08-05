import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged. On top of it, `save()` persists `learn`-tool lessons to
 * `learned.md` (so `status()` reports `writable: true`); structured search is
 * still unavailable.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd);
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
	async save(context, input) {
		return saveLearnedLesson(context.agentDir, context.cwd, input);
	},
	async status() {
		return {
			backend: "local" as const,
			active: true,
			writable: true,
			searchable: false,
			message: "本地 rollout 摘要记忆已启用;`learn` 工具的经验教训会保存到 learned.md。暂不支持结构化搜索。",
		};
	},
};
