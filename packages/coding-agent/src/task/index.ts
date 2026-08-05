/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import type { Theme } from "../modes/theme/theme";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskAsyncContractTemplate from "../prompts/tools/task-async-contract.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { TASK_EFFORTS, type TaskEffort } from "../thinking";
import { truncateForPrompt } from "../tools/approval";
import { isIrcEnabled } from "../tools/hub";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { isScoutSpawnable, resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	getTaskSchema,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { AsyncJobManager } from "../async";
import { hasResolvableTranscript } from "../internal-urls/registry-helpers";
import { AgentRegistry } from "../registry/agent-registry";
import { type DiscoveryResult, discoverAgents } from "./discovery";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import { resolveEffectiveSubagentPolicy, runStructuredSubagent, StructuredSubagentError } from "./structured-subagent";

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, {
		assignment: assignment.trim(),
	});
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"hub",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(无输出) 已消耗 ${result.requests} 次请求` : "(无输出)";
}

interface TaskDescriptionOptions {
	agents: AgentDefinition[];
	isolationEnabled: boolean;
	applyIsolatedChanges: boolean;
	disabledAgents: string[];
	batchEnabled: boolean;
	effortEnabled: boolean;
	asyncEnabled: boolean;
	ircEnabled: boolean;
	parentSpawns: string;
}

/** Render the tool description from a cached agent list and current settings. */
function renderDescription(options: TaskDescriptionOptions): string {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns);
	const spawningDisabled = !spawnPolicy.enabled;
	let filteredAgents =
		options.disabledAgents.length > 0
			? options.agents.filter(agent => !options.disabledAgents.includes(agent.name))
			: options.agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (spawnPolicy.allowedAgents !== null) {
		const allowed = new Set(spawnPolicy.allowedAgents);
		filteredAgents = filteredAgents.filter(agent => allowed.has(agent.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
	}));
	const scoutAvailable = isScoutSpawnable(options.disabledAgents, options.parentSpawns);
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		scoutAvailable,
		spawningDisabled,
		defaultAgent: spawnPolicy.defaultAgent,
		isolationEnabled: options.isolationEnabled,
		applyIsolatedChanges: options.applyIsolatedChanges,
		batchEnabled: options.batchEnabled,
		effortEnabled: options.effortEnabled,
		asyncEnabled: options.asyncEnabled,
		hasBlockingAgents: renderedAgents.some(agent => agent.blocking),
		ircEnabled: options.ircEnabled,
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject legacy fields and shape/configuration combinations the current tool
 * cannot accept. `outputSchema` is a first-class per-spawn field; stale
 * `schema` remains an eval-only alias and is rejected.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if (Object.hasOwn(params, "schema")) {
		return "task 工具使用 `outputSchema`;请重命名过时的 `schema` 字段。";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch 已禁用,因此 task 工具不接受 ${disallowed.map(f => `\`${f}\``).join(" 或 ")}。请每次调用用一个 \`task\` 派生一个 Agent,或启用 task.batch 设置。`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` — `tasks`
 * non-empty with per-item `task` instructions and unique names, `context`
 * non-empty, no top-level `task` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */

/** Reject an out-of-range `effort` selector on internal/stale-transcript calls that bypass the wire schema. */
function validateEffort(effort: TaskEffort | undefined, label: string): string | undefined {
	if (effort === undefined || TASK_EFFORTS.includes(effort)) return undefined;
	return `${label} 包含无效的 \`effort\` 值 ${JSON.stringify(effort)}。请使用 "lo"、"med" 或 "hi"。`;
}

function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "缺少 `tasks`。请至少提供一个任务项({ name?, agent?, task })。";
		}
		if (hasTask) {
			return "顶层 `task` 不属于批量结构。请把任务放在 `tasks[]` 项中。";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.task !== "string" || item.task.trim() === "") {
				return `任务 ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""} 缺少 \`task\`。每个任务都需要完整、自包含的指令。`;
			}
			const effortError = validateEffort(item.effort, `任务 ${i + 1}${item.name ? ` (\`${item.name}\`)` : ""}`);
			if (effortError) return effortError;
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `重复的任务名 ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}。同一调用中提供的名称必须唯一(不区分大小写)。`;
			}
			seen.set(key, name);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "缺少 `context`。请提供此批次的共享背景——目标、约束条件以及任务之间共享的任何约定。";
		}
		return undefined;
	}
	if (!hasTask) {
		return batchEnabled
			? "缺少 `tasks`。请提供 `tasks` 数组(每项一个子代理)并附共享 `context`。"
			: "缺少 `task`。请为 Agent 提供完整、自包含的指令。";
	}
	return validateEffort(params.effort, "该调用");
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — `#runSpawn`
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("outputSchema" in params) item.outputSchema = params.outputSchema;
	if ("schemaMode" in params) item.schemaMode = params.schemaMode;
	if ("effort" in params) item.effort = params.effort;
	if ("isolated" in params) item.isolated = params.isolated;
	return [item];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (params.context !== undefined) spawn.context = params.context;
	if ("outputSchema" in item) spawn.outputSchema = item.outputSchema;
	if ("schemaMode" in item) spawn.schemaMode = item.schemaMode;
	if ("effort" in item) spawn.effort = item.effort;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	return spawn;
}

/** One sync-executed spawn: its item, position in the original call, and (for mixed calls) a pre-claimed agent id. */
interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line.
 */
function mergeSyncPayloads(
	spawns: SyncSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`任务 ${item.name?.trim() || `#${index + 1}`}:启动前已取消。`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
	};
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	scoutAvailable = true,
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	const specialist = scoutAvailable
		? `请查看 Agent 列表寻找更贴近的专长类型——例如只读调研应使用 ` +
			`\`agent: "scout"\`,它运行在更快的模型上。`
		: `请查看 Agent 列表寻找更贴近的专长类型。`;
	return `提示:本次调用派生了 ${generics.length} 个通用 \`${generics[0]}\` 工作 Agent。${specialist}`;
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via the
 * hub when one call creates ≥2 live siblings and it still holds spawn
 * capacity. Returns undefined when there is nothing to coordinate or peer
 * messaging is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return (
		`协调:${items.length} 个同级 Agent 正在同时运行。如果它们的工作有重叠,请在编辑共享文件之前 ` +
		`通过 \`hub\` 相互发送消息(按 id,或 "all" 广播)——实时协调优于串行交接。用 \`hub\` op:"list" 查看谁在做什么。`
	);
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
	scoutAvailable?: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.scoutAvailable),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends Error {}

/**
 * Process-level memo for create-time agent discovery, keyed by resolved cwd.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process and the
 * walk-up + plugin-registry scan in `discoverAgents` is identical for a given
 * cwd, so repeat creations reuse the first scan. Execution-time discovery
 * (`#runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * the memo automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.name === "string" && params.name.trim()) {
			lines.push(`名称:${truncateForPrompt(params.name)}`);
		}
		if (typeof params.task === "string") {
			lines.push(`任务:\n${truncateForPrompt(params.task)}`);
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`上下文:\n${truncateForPrompt(params.context)}`);
		}
		const tasks: unknown[] = Array.isArray(params.tasks) ? params.tasks : [];
		if (tasks.length > 0) {
			const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
			const effectiveAgent = (item: unknown): string => {
				if (item && typeof item === "object" && "agent" in item) {
					const agent = item.agent;
					if (typeof agent === "string" && agent.trim()) return agent.trim();
				}
				return defaultAgent;
			};
			const agentCounts = new Map<string, number>();
			for (const item of tasks) {
				const agent = effectiveAgent(item);
				agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
			}
			const agentSummary = [...agentCounts].map(([agent, count]) => `${agent} ×${count}`).join(", ");
			lines.push(`批量 Agent:${truncateForPrompt(agentSummary)}`);

			const firstTask = tasks[0];
			if (firstTask && typeof firstTask === "object") {
				if ("name" in firstTask && typeof firstTask.name === "string" && firstTask.name.trim()) {
					lines.push(`名称:${truncateForPrompt(firstTask.name)}`);
				}
				lines.push(`Agent:${truncateForPrompt(effectiveAgent(firstTask))}`);
				if ("task" in firstTask && typeof firstTask.task === "string") {
					lines.push(`任务:\n${truncateForPrompt(firstTask.task)}`);
				}
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} 个其他任务`);
			}
		}
		return lines;
	};
	readonly label = "任务";
	readonly summary = "派生 Agent 完成委派的任务";
	readonly strict = false;
	readonly loadMode = "essential";
	// Arktype validates model calls against the active wire schema, but the flat
	// single-spawn schema carries `"+": "delete"`: a batch `{ context, tasks[] }`
	// payload has those keys stripped, then fails on the now-missing `task` with
	// the misleading `task must be a string (was missing)`. That preempts the
	// tool's own actionable shape checks (`validateShapeParams` /
	// `validateSpawnParams`), which never run. Lenient validation forwards the
	// raw args to `execute()` on any arktype failure so those checks surface the
	// real reason ("enable task.batch, or use the flat `task` shape"). Valid
	// calls still normalize through arktype; `execute()` resolves `agent`
	// defaults independently, so the success path is unchanged.
	readonly lenientArgValidation = true;
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Resized in
	 * place from `task.maxConcurrency` before every acquire/release so a
	 * mid-session settings change (UI toggle, `/settings`) applies to both new
	 * spawns and work already parked in the semaphore queue.
	 */
	#spawnSemaphore: Semaphore | undefined;

	get parameters(): TaskToolSchemaInstance {
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = !planMode && this.session.settings.get("task.isolation.mode") !== "none";
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.enableEffort"),
			defaultAgent,
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current task settings. */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription({
			agents: this.#discoveredAgents,
			isolationEnabled: !planMode && isolationMode !== "none",
			applyIsolatedChanges: this.session.settings.get("task.isolation.apply"),
			disabledAgents,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.enableEffort"),
			asyncEnabled: this.session.settings.get("async.enabled"),
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			parentSpawns: this.session.getSessionSpawns() ?? "*",
		});
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	#getSpawnSemaphore(): Semaphore {
		const max = this.session.settings.get("task.maxConcurrency");
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
	}

	/**
	 * Resolve the shared policy before detached work exists. The resulting
	 * policy intentionally stays local: executor dispatch resolves again from
	 * normalized task params rather than smuggling internal policy over the
	 * task wire contract.
	 */
	#resolveSpawnPreflight(params: TaskParams) {
		return resolveEffectiveSubagentPolicy({
			session: this.session,
			invocationKind: "task",
			assignment: (params.task ?? "").trim(),
			context: this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined,
			agent: params.agent,
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
			blockedAgent: this.#blockedAgent,
			enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
			enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
		});
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgentsForCreate(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = repairTaskParams(rawParams as TaskParams);
		// Schema defaults fill `agent` for model calls, but internal callers
		// and stale transcripts can bypass arktype. `spawnParamsFor` resolves each
		// item's agent type against the session's actual default agent.
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		const batchEnabled = this.#isBatchEnabled();
		const validationError = validateShapeParams(batchEnabled, params) ?? validateSpawnParams(params, batchEnabled);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const spawnItems = resolveSpawnItems(params);
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		// Resolve every item before choosing an execution path. No executor or
		// job manager may observe a batch unless every effective policy is valid.
		const preflights = await Promise.all(
			normalizedSpawnParams.map(async spawn => {
				try {
					return { policy: await this.#resolveSpawnPreflight(spawn) };
				} catch (error) {
					return { error: error instanceof StructuredSubagentError ? error.message : String(error) };
				}
			}),
		);
		const preflightFailures = preflights
			.map((preflight, index) => ("error" in preflight ? { index, error: preflight.error } : undefined))
			.filter((failure): failure is { index: number; error: string } => failure !== undefined);
		if (preflightFailures.length > 0) {
			if (!batchEnabled) {
				return createTaskModeError(`任务执行失败:${preflightFailures[0]!.error}`);
			}
			return createTaskModeError(
				preflightFailures
					.map(({ index, error }) => {
						const item = spawnItems[index]!;
						return `任务 ${item.name?.trim() || `#${index + 1}`} 预检失败:${error}`;
					})
					.join("\n"),
			);
		}
		const policies = preflights.map(preflight => preflight.policy!);
		const itemBlocking = policies.map(policy => policy.effectiveAgent.blocking === true);

		// Execution mode is per item: an item whose agent type declares
		// `blocking: true` runs inline on this turn (the parent waits on its
		// result); every other item becomes a background job when async
		// execution is available.
		const asyncEnabled = this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];
		const depthCapacity = canSpawnAtDepth(
			this.session.settings.get("task.maxRecursionDepth") ?? 2,
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);

		if (!manager || asyncItems.length === 0) {
			// Sync fallback: async execution disabled, orphaned host that never
			// wired a job manager, or every item's agent type declares
			// `blocking: true`.
			if (asyncEnabled && !this.session.asyncJobManager) {
				logger.warn("task: 未注册 AsyncJobManager,回退到同步执行");
			}
			const advisory = this.session.suppressSpawnAdvisory
				? undefined
				: composeSpawnAdvisory({
						agents: resolvedAgents,
						items: asyncItems,
						depthCapacity,
						ircEnabled,
						willRunAsync: false,
						scoutAvailable: isScoutSpawnable(
							this.session.settings.get("task.disabledAgents") as string[] | undefined,
							this.session.getSessionSpawns?.() ?? "*",
						),
					});
			const result = await this.#executeSyncFanout(
				toolCallId,
				params,
				spawnItems.map((item, index) => ({ item, index })),
				defaultAgent,
				signal,
				onUpdate,
			);
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		}

		// Coordination only makes sense for spawns that keep running after this
		// call returns (the async subset). Blocking items have already completed
		// by then, so a "coordinate while they run" hint would misfire.
		const advisory = this.session.suppressSpawnAdvisory
			? undefined
			: composeSpawnAdvisory({
					agents: resolvedAgents,
					items: asyncItems,
					depthCapacity,
					ircEnabled,
					willRunAsync: asyncItems.length > 0,
					scoutAvailable: isScoutSpawnable(
						this.session.settings.get("task.disabledAgents") as string[] | undefined,
						this.session.getSessionSpawns?.() ?? "*",
					),
				});
		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
		const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};
		if (asyncItems.length === 0) {
			return withAdvisory(
				await this.#executeSyncFanout(
					toolCallId,
					params,
					spawnItems.map((item, index) => ({ item, index })),
					defaultAgent,
					signal,
					onUpdate,
				),
			);
		}

		// Async IDs are claimed before job registration, so retain the fallback
		// manager on the session rather than recreating it for every call.
		let outputManager = this.session.agentOutputManager;
		if (!outputManager) {
			outputManager = new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			this.session.agentOutputManager = outputManager;
		}
		const callStartedAt = Date.now();
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			index: number;
			blocking: boolean;
			progress: AgentProgress;
		}> = [];
		for (const [index, item] of spawnItems.entries()) {
			const agentType = resolvedAgents[index]!;
			const policy = policies[index]!;
			const agentSource = policy.agent.source;
			const agentId = await outputManager.allocate(item.name?.trim() || generateTaskName());
			const assignment = (item.task ?? "").trim();
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					status: "pending",
					task: renderSubagentUserPrompt(assignment),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}
		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const syncSpawns = spawns.filter(spawn => spawn.blocking);
		const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

		// Aggregate state for the one tool call. Async spawns report into the
		// shared progress snapshot through their jobs: the async half stays
		// "running" until every job settles, then turns "failed" if any spawn
		// failed. Blocking spawns run inline below and land in `results` before
		// the call returns, so post-return job updates never drop them.
		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = asyncSpawns[0].agentId;
		const syncResults: SingleResult[] = [];
		let syncUsage: Usage | undefined;
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskToolDetails => ({
			projectAgentsDir: syncProjectAgentsDir,
			results: [...syncResults],
			totalDurationMs: Date.now() - callStartedAt,
			usage: syncUsage,
			outputPaths: syncOutputPaths,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: primaryJobId,
				type: "task",
			},
		});

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of asyncSpawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				settledCount += 1;
				failedCount += 1;
			}
		}

		if (started.length === 0 && syncSpawns.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `启动后台任务作业失败:${failedSchedules.join("; ")}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` 未能调度 ${failedSchedules.length} 个派生:${failedSchedules.join("; ")}。`
				: "";
		const coordinationHint = [
			started.length === 1
				? ircEnabled
					? `在运行期间通过 \`hub\` send 私信 \`${started[0].agentId}\` 协调;仅使用 \`hub\` 检查(\`jobs\`)、等待或取消卡住的任务。`
					: `使用 \`hub\` 检查(\`jobs\`)、等待或取消卡住的任务。`
				: ircEnabled
					? `在运行期间通过 \`hub\` send 私信这些 id 协调;仅使用 \`hub\` 检查(\`jobs\`)、等待或取消卡住的任务。`
					: `使用 \`hub\` 按 id 检查(\`jobs\`)、等待或取消卡住的任务。`,
			taskAsyncContractTemplate.trim(),
		].join("\n");

		if (syncSpawns.length === 0) {
			if (spawns.length === 1) {
				const { agentId, jobId } = started[0];
				onUpdate?.({
					content: [{ type: "text", text: `已派生 Agent \`${agentId}\`...` }],
					details: buildAsyncDetails(),
				});
				return withAdvisory({
					content: [
						{
							type: "text",
							text: `已派生 Agent \`${agentId}\`(作业 \`${jobId}\`)。其结果会在 yield 时自动送达,除非先被已结算的 \`hub jobs\`/\`wait\` 快照消费。${coordinationHint}`,
						},
					],
					details: buildAsyncDetails(),
				});
			}
			const startedListing = started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n");
			onUpdate?.({
				content: [{ type: "text", text: `已派生 ${started.length} 个 Agent...` }],
				details: buildAsyncDetails(),
			});
			return withAdvisory({
				content: [
					{
						type: "text",
						text: `已使用 ${agentLabel} 派生 ${started.length} 个后台 Agent。${scheduleFailureSummary} 每个结果都会在 yield 时自动送达,除非先被已结算的 \`hub jobs\`/\`wait\` 快照消费。\n${startedListing}\n${coordinationHint}`,
					},
				],
				details: buildAsyncDetails(),
			});
		}

		// Mixed call: the async jobs above already run detached; the blocking
		// subset runs inline and gates the call's return — exactly what each
		// agent type declares (`blocking: true` = the parent waits on it).
		const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `正在内联运行 ${syncLabel};已派生 ${started.length} 个后台 Agent...`,
				},
			],
			details: buildAsyncDetails(),
		});
		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns: syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index, preAllocatedId: spawn.agentId })),
			onItemProgress: onUpdate
				? (index, progress) => {
						const spawn = spawns.find(candidate => candidate.index === index);
						if (spawn) spawn.progress = { ...progress, index };
						onUpdate({
							content: [{ type: "text", text: `正在内联运行 ${syncLabel}...` }],
							details: buildAsyncDetails(),
						});
					}
				: undefined,
		});
		const merged = mergeSyncPayloads(
			syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
			payloads,
		);
		syncResults.push(...merged.results);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		// Settle the inline spawns' progress rows from their merged results so
		// post-return job updates carry final statuses, not the last snapshot.
		for (let position = 0; position < syncSpawns.length; position++) {
			const spawn = syncSpawns[position];
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				spawn.progress.status = result.aborted
					? "aborted"
					: result.exitCode === 0 && !result.error
						? "completed"
						: "failed";
				spawn.progress.durationMs = result.durationMs;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
		}

		const spawnedSummary =
			started.length > 0
				? `已派生 ${started.length} 个后台 Agent。${scheduleFailureSummary} 每个结果都会在 yield 时自动送达,除非先被已结算的 \`hub jobs\`/\`wait\` 快照消费。\n${started.map(({ agentId, jobId }) => `- \`${agentId}\` (作业 \`${jobId}\`)`).join("\n")}\n${coordinationHint}`
				: scheduleFailureSummary.trim();
		const text = [merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return withAdvisory({
			content: [{ type: "text", text: text.length > 0 ? text : "无结果。" }],
			details: buildAsyncDetails(),
		});
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its yield text. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManager;
		toolCallId: string;
		spawnParams: TaskParams;
		agentId: string;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
	}): string {
		const { manager, toolCallId, spawnParams, agentId, progress, ircEnabled, buildDetails, onUpdate, onSettled } =
			options;
		const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
			if (aborted) {
				const ref = AgentRegistry.global().get(agentId);
				const transcript = (await hasResolvableTranscript(agentId))
					? `会话记录:history://${agentId}`
					: "会话记录不可用";
				if (ref?.status === "idle" || ref?.status === "parked") {
					const followUp = ircEnabled ? "通过 `hub` 发送消息以恢复; " : "";
					return `\n\n${agentId} 已停止但仍可恢复 — ${followUp}${transcript}`;
				}
				return `\n\n${agentId} 已中止 — ${transcript}`;
			}
			const followUp = ircEnabled ? "通过 `hub` 发送消息以跟进; " : "";
			return `\n\n${agentId} 现已空闲 — ${followUp}会话记录:history://${agentId}`;
		};
		return manager.register(
			"task",
			agentId,
			async ({ signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const semaphore = this.#getSpawnSemaphore();
				let semaphoreHeld = false;
				// Every release funnels through here: the flag flips before the
				// release so no path — acquire-time abort, executor failure, or a
				// future refactor that reorders the branches — can return a permit
				// twice. Releasing a permit this job never acquired would steal one
				// from a running job and let a later spawn start past
				// task.maxConcurrency.
				const releasePermit = () => {
					if (!semaphoreHeld) return;
					semaphoreHeld = false;
					this.#releaseSpawnSemaphore();
				};
				try {
					await semaphore.acquire(runSignal);
					semaphoreHeld = true;
				} catch {
					// Fall through so an acquire-time abort goes through the same
					// path as the post-acquire race below: progress + onSettled
					// have to fire even when the spawn never reached the executor,
					// otherwise the batch aggregate state stays "running" forever.
				}
				const acquiredAt = Date.now();
				if (!semaphoreHeld || runSignal.aborted) {
					releasePermit();
					progress.status = "aborted";
					onSettled?.(true);
					throw new Error("执行前已中止");
				}
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(
						`正在运行后台任务 ${agentId}...`,
						buildDetails() as unknown as Record<string, unknown>,
					);
					const forwardSyncProgress: AgentToolUpdateCallback<TaskToolDetails> = async update => {
						const nextProgress = update.details?.progress?.[0];
						if (nextProgress) {
							// The job body owns status and identity (id/index/agent);
							// copy only the live metrics the subagent streams so the
							// polling row reflects the resolved model, reasoning level,
							// and running counters without reverting the "running"
							// status back to the subagent's initial "pending" snapshot.
							progress.resolvedModel = nextProgress.resolvedModel;
							progress.resolvedModelIsFallback = nextProgress.resolvedModelIsFallback;
							progress.tokens = nextProgress.tokens;
							progress.requests = nextProgress.requests;
							progress.contextTokens = nextProgress.contextTokens;
							progress.contextWindow = nextProgress.contextWindow;
							progress.cost = nextProgress.cost;
							progress.toolCount = nextProgress.toolCount;
							progress.currentTool = nextProgress.currentTool;
							progress.lastIntent = nextProgress.lastIntent;
							progress.recentTools = nextProgress.recentTools.slice();
							progress.recentOutput = nextProgress.recentOutput.slice();
							progress.retryState = nextProgress.retryState;
							progress.retryFailure = nextProgress.retryFailure;
						}
						const updateText =
							update.content.find(part => part.type === "text")?.text ?? `正在运行后台任务 ${agentId}...`;
						await reportProgress(updateText, buildDetails() as unknown as Record<string, unknown>);
					};
					const result = await this.#executeSync(
						toolCallId,
						spawnParams,
						runSignal,
						forwardSyncProgress,
						agentId,
						progress.index,
						true,
						{ invokedAt: startedAt, acquiredAt },
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(无输出)";
					const singleResult = result.details?.results[0];
					// A missing result means the sync path failed at the tool level
					// (results: []) — treat it as a failure, not success.
					const resultFailed = !singleResult || (singleResult.aborted ?? false) || singleResult.exitCode !== 0;
					progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
					progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					progress.retryState = undefined;
					if (singleResult?.resolvedModel) {
						progress.resolvedModel = singleResult.resolvedModel;
						progress.resolvedModelIsFallback = singleResult.resolvedModelIsFallback;
					} else {
						delete progress.resolvedModel;
						delete progress.resolvedModelIsFallback;
					}
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? `后台任务 ${agentId} 失败。`
						: `后台任务 ${agentId} 已完成。`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const deliveryText = `${finalText}${await buildFollowUpHint(singleResult?.aborted === true)}`;
					if (resultFailed) {
						// Mark the job itself failed; the failed agent stays interrogable.
						throw new TaskJobError(deliveryText);
					}
					return deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					onSettled?.(true);
					const statusText = `后台任务 ${agentId} 失败。`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const message = error instanceof Error ? error.message : String(error);
					const hint = AgentRegistry.global().get(agentId) ? await buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				} finally {
					releasePermit();
				}
			},
			{
				id: agentId,
				agentId,
				queued: true,
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: text => {
					onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
				},
			},
		);
	}

	/**
	 * Sync fan-out (async unavailable, or every item's agent type is
	 * `blocking: true`): run every spawn to completion inline and merge the
	 * per-spawn payloads into a single tool result. The session-scoped
	 * semaphore still bounds concurrency across parallel task calls.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawns: SyncSpawnRef[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawns.length === 1) {
			const spawn = spawns[0]!;
			const semaphore = this.#getSpawnSemaphore();
			const invokedAt = Date.now();
			await semaphore.acquire(signal);
			const acquiredAt = Date.now();
			try {
				return await this.#executeSync(
					toolCallId,
					spawnParamsFor(params, spawn.item, defaultAgent),
					signal,
					onUpdate,
					spawn.preAllocatedId,
					spawn.index,
					false,
					{ invokedAt, acquiredAt },
				);
			} finally {
				this.#releaseSpawnSemaphore();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `正在运行 ${spawns.length} 个 Agent...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns,
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
		});

		const merged = mergeSyncPayloads(spawns, payloads);
		return {
			content: [{ type: "text", text: merged.contentParts.join("\n\n") }],
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	/**
	 * Run a set of spawns to completion inline, bounded by the session spawn
	 * semaphore. `preAllocatedId` reuses an id claimed up front (mixed calls);
	 * `index` is each item's position in the original call so progress rows and
	 * merged results keep stable ordering. Per-item progress snapshots flow
	 * through `onItemProgress`. Returns per-spawn payloads in input order;
	 * `undefined` marks a spawn cancelled before it started.
	 */
	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const semaphore = this.#getSpawnSemaphore();
		const { results } = await mapWithConcurrencyLimitAllSettled(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const invokedAt = Date.now();
				let semaphoreHeld = false;
				try {
					await semaphore.acquire(workerSignal);
					semaphoreHeld = true;
				} catch (error) {
					if (workerSignal.aborted) return undefined;
					throw error;
				}
				const acquiredAt = Date.now();
				try {
					const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined;
					return await this.#executeSync(
						toolCallId,
						spawnParamsFor(params, spawn.item, defaultAgent),
						workerSignal,
						itemOnUpdate,
						spawn.preAllocatedId,
						spawn.index,
						false,
						{ invokedAt, acquiredAt },
					);
				} finally {
					if (semaphoreHeld) this.#releaseSpawnSemaphore();
				}
			},
			signal,
		);
		return results.map((settled, position) => {
			if (!settled) return undefined;
			if (settled.status === "fulfilled") return settled.value;
			const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
			const item = spawns[position].item;
			return {
				content: [
					{
						type: "text",
						text: `任务 ${item.name?.trim() || `#${spawns[position].index + 1}`} 失败:${message}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		});
	}

	/**
	 * Synchronous execution of one spawn. Used as the body of every
	 * async job and directly by the sync fallback (no job manager / blocking
	 * agent) and by in-process callers that need the result inline (e.g. the
	 * commit flow's analyze_files tool).
	 */
	async #executeSync(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(toolCallId, params, signal, onUpdate, preAllocatedId, spawnIndex, detached, launchTiming);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const assignment = (params.task ?? "").trim();
		const context = this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined;
		let latestProgress: AgentProgress | undefined;
		try {
			const execution = await runStructuredSubagent({
				session: this.session,
				invocationKind: "task",
				assignment,
				context,
				agent: params.agent,
				...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
				...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
				...(params.effort !== undefined ? { effort: params.effort } : {}),
				identity: { id: preAllocatedId, label: params.name },
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
				blockedAgent: this.#blockedAgent,
				enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
				enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
				maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
				signal,
				onProgress: progress => {
					latestProgress = { ...progress, recentTools: progress.recentTools.slice() };
					onUpdate?.({
						content: [{ type: "text", text: `正在运行 Agent ${progress.id}...` }],
						details: {
							projectAgentsDir: null,
							results: [],
							totalDurationMs: Date.now() - startTime,
							progress: [latestProgress],
						},
					});
				},
			});
			return this.#buildResultPayload(
				execution.result,
				execution.policy.discovery.projectAgentsDir,
				Date.now() - startTime,
				execution.mergeSummary,
			);
		} catch (error) {
			const message = error instanceof StructuredSubagentError ? error.message : String(error);
			return {
				content: [{ type: "text", text: `任务执行失败:${message}` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					...(latestProgress ? { progress: [latestProgress] } : {}),
				},
			};
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		const status = result.aborted
			? "已取消"
			: result.exitCode === 0 && result.error
				? "合并失败"
				: result.exitCode === 0
					? "已完成"
					: `失败(退出码 ${result.exitCode})`;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
		// the parent so it can resume via irc instead of redoing the work.
		const refStatus = AgentRegistry.global().get(result.id)?.status;
		const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? result.abortReason : undefined,
			resumable,
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}
