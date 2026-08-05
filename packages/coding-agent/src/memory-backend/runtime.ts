import type { AgentSession } from "../session/agent-session";
import { resolveMemoryBackend } from "./resolve";
import type {
	MemoryBackendId,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSearchOptions,
	MemoryRuntimeContext,
} from "./types";
export function createMemoryRuntimeContext(context: MemoryBackendOperationContext): MemoryRuntimeContext {
	const settings = context.session?.settings;
	return {
		async status() {
			if (!settings) {
				return {
					backend: "off" as const,
					active: false,
					writable: false,
					searchable: false,
					message: "没有活动的 Agent 会话。",
				};
			}
			const backend = await resolveMemoryBackend(settings);
			return backend.status
				? await backend.status(context)
				: {
						backend: backend.id,
						active: backend.id !== "off",
						writable: false,
						searchable: false,
						message: "该记忆后端不提供结构化状态。",
					};
		},
		async search(query: string, options?: MemoryBackendSearchOptions) {
			if (!settings) return unavailableSearch("off", query, "没有活动的 Agent 会话。");
			const backend = await resolveMemoryBackend(settings);
			return backend.search
				? await backend.search(context, query, options)
				: unavailableSearch(backend.id, query, `记忆搜索不适用于 ${backend.id} 后端。`);
		},
		async save(input: string | MemoryBackendSaveInput) {
			if (!settings) return unavailableSave("off", "没有活动的 Agent 会话。");
			const backend = await resolveMemoryBackend(settings);
			const normalized = typeof input === "string" ? { content: input } : input;
			return backend.save
				? await backend.save(context, normalized)
				: unavailableSave(backend.id, `记忆保存不适用于 ${backend.id} 后端。`);
		},
	};
}

export function createSessionMemoryRuntimeContext(
	session: AgentSession,
	agentDir: string,
	cwd: string,
): MemoryRuntimeContext {
	return createMemoryRuntimeContext({ agentDir, cwd, session });
}

function unavailableSearch(backend: MemoryBackendId, query: string, message: string) {
	return { backend, query, count: 0, items: [], message };
}

function unavailableSave(backend: MemoryBackendId, message: string) {
	return { backend, stored: 0, message };
}
