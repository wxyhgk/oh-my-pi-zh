/**
 * Hub tool — the single agent-coordination surface: peer messaging over the
 * IrcBus, lifecycle control for async background jobs, and supervision of
 * project-scoped long-running processes (launch).
 *
 * Op families:
 * - messaging: `send` (with `to`), `inbox`, `list`, `wait` (with `from`);
 * - jobs: `wait` (bare or with `ids`), `cancel`, `jobs`;
 * - processes: `start`, `ps`, `logs`, `stop`, `restart`, `describe`, plus
 *   `send`/`wait` when they carry a process `name`.
 *
 * The unified `wait` blocks until the FIRST of: a matching peer message, a
 * watched job settling, the wait window elapsing, or a steering interrupt.
 * Job results always deliver themselves when they finish — `wait` exists for
 * when the agent has nothing else to do.
 */

import { type } from "@wxyhgk/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@wxyhgk/pi-agent-core";
import type { ToolExample } from "@wxyhgk/pi-ai";
import type { Component } from "@wxyhgk/pi-tui";
import { prompt } from "@wxyhgk/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { IrcBus } from "../../irc/bus";
import type { Theme } from "../../modes/theme/theme";
import hubDescription from "../../prompts/tools/hub.md" with { type: "text" };
import type { AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";
import {
	buildJobResult,
	executeCancel,
	executeJobsSnapshot,
	jobsRenderCall,
	jobsRenderResult,
	noMatchingJobsResult,
	nothingToWaitForResult,
	resolvePollWindow,
	snapshotJobs,
	visibleJobs,
} from "./jobs";
import {
	executeLaunch,
	type LaunchParams,
	type LaunchRenderArgs,
	type LaunchToolDetails,
	launchRenderCall,
	launchRenderResult,
} from "./launch";
import {
	drainPendingInbox,
	executeInbox,
	executeList,
	executeMessageWait,
	executeSend,
	messageResult,
	messagingRenderCall,
	messagingRenderResult,
	normalizeIrcTimeoutMs,
} from "./messaging";
import { type HubDetails, type HubRenderArgs, hubErrorResult } from "./types";

export { isWaitingPollDetails } from "./jobs";
export type { LaunchParams, LaunchToolDetails } from "./launch";
export { createIrcMessageCard, isIrcEnabled } from "./messaging";
export * from "./types";

const hubSchema = type({
	op: type(
		"'send' | 'wait' | 'inbox' | 'list' | 'jobs' | 'cancel' | 'start' | 'ps' | 'logs' | 'stop' | 'restart' | 'describe'",
	).describe("hub 操作"),
	"to?": type("string").describe('send:收件人 Agent id 或 "all"'),
	"message?": type("string").describe("send:消息正文"),
	"replyTo?": type("string").describe("send:被回复的消息 id"),
	"await?": type("boolean").describe('send:等待收件人回复(与 to:"all" 一起使用时无效)'),
	"from?": type("string").describe("wait:只接受来自该 Agent id 的消息"),
	"ids?": type("string[]").describe("wait:要监听的 job id(省略 = 所有运行中的 job);cancel:要终止的 job id"),
	"timeoutMs?": type("number").describe("wait(消息/job):超时毫秒数(0 表示无限等待)"),
	"peek?": type("boolean").describe("inbox:列出消息但不消费它们"),
	"name?": type("string <= 48").describe("进程操作:项目作用域内稳定的 launch 名称"),
	"application?": type("string > 0").describe("start:可执行文件或应用程序路径"),
	"args?": type("string[]").describe("start:直接传给应用程序的 argv"),
	"env?": type({ "[string]": "string" }).describe("start:额外的环境变量"),
	"cwd?": type("string").describe("start:工作目录;默认为会话目录"),
	"pty?": type("boolean").describe("start:分配交互式 PTY;默认为 true"),
	"ready?": type({
		"log?": type("string > 0").describe("与输出匹配的正则"),
		"port?": type("number").describe("必须接受连接的 TCP 端口"),
		"host?": type("string > 0").describe("TCP 就绪检查主机;默认 127.0.0.1"),
		"timeout?": type("number > 0").describe("等待秒数;默认 30"),
	}).describe("start:就绪条件;所有提供的条件都必须满足"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start:重启策略;默认为 no"),
	"persist?": type("boolean").describe("start:最后一个 omp 客户端退出后仍继续存活;默认为 false"),
	"detached?": type("boolean").describe(
		"start:每次 omp 和 broker 退出后仍继续存活;隐含 persist 并禁用 PTY 输入",
	),
	"lines?": type("number > 0").describe("logs:输出行数;默认 100,最多 1000"),
	"head?": type("boolean").describe("logs:从头读取而非从尾部"),
	"grep?": type("string > 0").describe("logs:正则筛选"),
	"follow?": type("boolean").describe("logs:等待比 cursor 更新的输出"),
	"cursor?": type("number >= 0").describe("logs:先前调用返回的输出 cursor"),
	"for?": type("'ready' | 'exit'").describe("带 name 的 wait:生命周期条件;默认 exit"),
	"pattern?": type("string > 0").describe("带 name 的 wait:输出正则;优先于 for"),
	"text?": type("string > 0").describe("带 name 的 send:stdin 文本"),
	"enter?": type("boolean").describe("带 name 的 send:在文本后追加 Enter;默认为 true"),
	"keys?": type("string[]").describe("带 name 的 send:文本后的终端按键"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe(
		"带 name 的 send:进程树信号",
	),
	"timeout?": type("number > 0").describe("带 name 的 logs/stop/wait:最大秒数;默认 30(stop:5)"),
});

type HubParams = typeof hubSchema.infer;

interface MessagingDeps {
	registry: AgentRegistry;
	senderId: string;
	settings: ToolSession["settings"];
}

const PROGRESS_INTERVAL_MS = 500;

/** Mutating process ops require exec approval; messaging, jobs, and inspection are read-only. */
function hubApproval(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	const op = params.op;
	switch (op) {
		case "wait":
		case "inbox":
		case "list":
		case "jobs":
		case "cancel":
		case "ps":
		case "logs":
		case "describe":
			return "read";
		case "send": {
			// Peer DMs are read-tier; writing to a process stdin is exec-tier.
			const name = "name" in params ? params.name : undefined;
			const to = "to" in params ? params.to : undefined;
			return typeof name === "string" && name.length > 0 && !to ? "exec" : "read";
		}
		default:
			// start / stop / restart and anything unrecognized.
			return "exec";
	}
}

export class HubTool implements AgentTool<typeof hubSchema, HubDetails> {
	readonly name = "hub";
	readonly approval = hubApproval;
	readonly label = "中心";
	readonly summary = "向对等 Agent 发消息、控制后台 job,并监督长时间运行的进程";
	readonly description: string;
	readonly parameters = hubSchema;
	readonly strict = true;
	readonly interruptible = (params: Partial<HubParams>): boolean => {
		if (params.op === "wait") return true;
		return params.op === "logs" && params.follow === true;
	};
	readonly loadMode = "essential";

	readonly examples: readonly ToolExample<typeof hubSchema.infer>[] = [
		{
			caption: "列出对等 Agent",
			call: { op: "list" },
		},
		{
			caption: "即发即忘的私信 —— 同样的 send 会唤醒空闲/已暂停的对等 Agent",
			call: {
				op: "send",
				to: "AuthLoader",
				message: "Still touching src/server/auth.ts? I need to add a 401 path.",
			},
		},
		{
			caption: "没有答案就无法继续时的往返等待",
			call: {
				op: "send",
				to: "Main",
				message: "JWT or session cookies for the auth flow?",
				await: true,
			},
		},
		{
			caption: "完全阻塞:等待第一个完成的 job 或收到的消息",
			call: { op: "wait" },
		},
		{
			caption: "阻塞直到某个对等 Agent 回复",
			call: { op: "wait", from: "AuthLoader", timeoutMs: 60000 },
		},
		{
			caption: "终止挂起的后台 job",
			call: { op: "cancel", ids: ["bash_a1b2c3"] },
		},
		{
			caption: "不等待,直接快照所有后台 job",
			call: { op: "jobs" },
		},
		{
			caption: "启动开发服务器,等待其日志横幅与端口就绪",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "从 cursor 之后持续跟踪进程输出",
			call: { op: "logs", name: "web", follow: true, cursor: 1842, timeout: 30 },
		},
		{
			caption: "通过 stdin 驱动 REPL/调试器",
			call: { op: "send", name: "debugger", text: "breakpoint set --name main" },
		},
		{
			caption: "中断进程",
			call: { op: "send", name: "debugger", keys: ["CTRL_C"] },
		},
		{
			caption: "阻塞直到进程就绪",
			call: { op: "wait", name: "web", for: "ready", timeout: 30 },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(hubDescription);
	}

	/** Messaging deps when this session can address peers; null otherwise. */
	#messaging(): MessagingDeps | null {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry || !senderId) return null;
		return { registry, senderId, settings: this.session.settings };
	}

	async execute(
		_toolCallId: string,
		params: HubParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<HubDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<HubDetails>> {
		switch (params.op) {
			case "list": {
				const messaging = this.#messaging();
				if (!messaging) return hubErrorResult("当前会话无法进行对等消息传递。", { op: "list" });
				return executeList(messaging.registry, messaging.senderId);
			}
			case "send": {
				const toPeer = params.to?.trim();
				const toProcess = params.name?.trim();
				if (toPeer && toProcess) {
					return hubErrorResult('op="send" 时 `to`(对等 Agent)与 `name`(进程)互斥。', {
						op: "send",
					});
				}
				if (toProcess) return this.#launch(params, "send", signal);
				const messaging = this.#messaging();
				if (!messaging) return hubErrorResult("当前会话无法进行对等消息传递。", { op: "send" });
				return executeSend(messaging, params, signal);
			}
			case "inbox": {
				const messaging = this.#messaging();
				if (!messaging) return hubErrorResult("当前会话无法进行对等消息传递。", { op: "inbox" });
				return executeInbox(messaging.registry, messaging.senderId, params.peek);
			}
			case "wait":
				if (params.name?.trim()) return this.#launch(params, "wait", signal);
				return this.#executeWait(params, signal, onUpdate);
			case "cancel": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("cancel");
				if (!params.ids?.length) {
					return hubErrorResult('op="cancel" 需要提供 `ids`。', { op: "cancel", jobs: [] });
				}
				return await executeCancel(this.session, manager, this.#ownerId(), params.ids);
			}
			case "jobs": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("jobs");
				return executeJobsSnapshot(this.session, manager, this.#ownerId());
			}
			case "start":
			case "ps":
			case "logs":
			case "stop":
			case "restart":
			case "describe":
				return this.#launch(params, params.op === "ps" ? "list" : params.op, signal);
			default:
				return hubErrorResult("未知的 hub 操作。", { op: params.op });
		}
	}

	/** Job visibility scope: everything the calling agent owns (tests/SDK without an agent id see all). */
	#ownerId(): string | undefined {
		return this.session.getAgentId?.() ?? undefined;
	}

	#asyncDisabled(op: "cancel" | "jobs"): AgentToolResult<HubDetails> {
		return {
			content: [{ type: "text", text: "异步执行已禁用;没有可用的后台 job。" }],
			details: { op, jobs: [] },
		};
	}

	/** Route a process-supervision op to the launch broker, honoring `launch.enabled`. */
	async #launch(
		params: HubParams,
		op: LaunchParams["op"],
		signal?: AbortSignal,
	): Promise<AgentToolResult<HubDetails>> {
		if (!this.session.settings.get("launch.enabled")) {
			return hubErrorResult("进程监督已禁用(launch.enabled=false)。", { op: params.op });
		}
		const { op: _hubOp, ...rest } = params;
		return executeLaunch(this.session, { ...rest, op }, signal);
	}

	/**
	 * Unified wait: race the caller's running jobs against incoming peer
	 * messages. Returns on the FIRST settled job, the first matching message,
	 * window expiry, or abort — never "when everything finishes"; the model
	 * re-issues to keep waiting. With no job legs it degrades to a pure
	 * message wait; with no messaging it is exactly the old job poll.
	 */
	async #executeWait(
		params: HubParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<HubDetails>,
	): Promise<AgentToolResult<HubDetails>> {
		const messaging = this.#messaging();
		const manager = this.session.asyncJobManager;
		const ownerId = this.#ownerId();
		const from = params.from?.trim() || undefined;

		// A message already buffered on the session satisfies the wait first.
		if (messaging) {
			const pending = drainPendingInbox(messaging.registry, messaging.senderId, from);
			if (pending) return messageResult(messaging.senderId, pending);
		}

		// Resolve which jobs to watch:
		// - explicit `ids` → exactly those (owner-scoped; missing ids corrected);
		// - omitted → every running job the caller owns.
		const ids = params.ids;
		const jobsToWatch = manager
			? ids?.length
				? visibleJobs(manager, ids, ownerId)
				: manager.getRunningJobs(ownerId ? { ownerId } : undefined)
			: [];
		if (manager && ids?.length && jobsToWatch.length === 0) {
			return noMatchingJobsResult(this.session, ids);
		}
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (manager && jobsToWatch.length > 0 && runningJobs.length === 0) {
			// Every explicitly watched job already settled — immediate snapshot.
			return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
		}

		if (!manager || runningJobs.length === 0) {
			// No job legs: pure message wait — or nothing to block on at all.
			if (!messaging) return nothingToWaitForResult(this.session);
			if (!from) {
				// A bare wait can only be satisfied by a running peer eventually
				// sending something; with none, return the snapshot immediately
				// instead of blocking a full message-timeout window.
				const hasRunningPeer = messaging.registry
					.listVisibleTo(messaging.senderId)
					.some(ref => ref.status === "running");
				if (!hasRunningPeer) return nothingToWaitForResult(this.session);
			}
			return executeMessageWait(messaging, { from, timeoutMs: params.timeoutMs }, signal);
		}

		// Wait window: explicit timeout wins (0 = no window); otherwise the
		// `async.pollWaitDuration` fixed value or smart ladder. The ladder
		// starts at the floor and climbs as the agent waits in a tight loop,
		// then resets once it steps away (see AsyncJobManager.nextPollWaitMs).
		const window = resolvePollWindow(this.session, manager, ownerId);
		const windowMs = params.timeoutMs !== undefined ? normalizeIrcTimeoutMs(params.timeoutMs) : window.waitMs;
		const usedSmartWindow = window.smart && params.timeoutMs === undefined;

		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);

		// Message leg: park a bus waiter with no timeout of its own — the race
		// window governs. Cancelled via sentinel so late losers do not reject.
		const busAbort = messaging ? new AbortController() : undefined;
		const busCancelled = new Error("hub wait settled");
		let removeBusAbortListener: (() => void) | undefined;
		const busLeg =
			messaging && busAbort
				? IrcBus.global()
						.wait(messaging.senderId, { from }, 0, busAbort.signal)
						.then(
							message => ({ message, error: null as Error | null }),
							error => ({
								message: null,
								error:
									error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
							}),
						)
				: undefined;
		if (busLeg) racePromises.push(busLeg);
		if (busAbort && signal) {
			if (signal.aborted) {
				busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
			} else {
				const onAbort = (): void => {
					busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeBusAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}

		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = windowMs > 0 ? setTimeout(() => timeoutResolve(), windowMs) : undefined;
		if (timeoutHandle) racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const emitProgress = () => {
			if (!onUpdate) return;
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobsToWatch) },
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (progressTimer) clearInterval(progressTimer);
			busAbort?.abort(busCancelled);
			removeBusAbortListener?.();
			if (usedSmartWindow) {
				// Reset the idle-gap clock: escalate if the agent waits again soon,
				// drop back to the floor once it goes quiet for a while.
				manager.recordPollWaitEnd(ownerId);
			}
		}

		// A message consumed by the bus waiter must never be dropped — it wins
		// even a photo-finish race (job results re-deliver themselves; a
		// dequeued message would otherwise be lost).
		if (busLeg && messaging) {
			const settled = await busLeg;
			if (settled.message) return messageResult(messaging.senderId, settled.message);
		}

		return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
	}
}

// =============================================================================
// TUI Renderer — dispatches to the preserved messaging/job/launch renderings.
// =============================================================================

const LAUNCH_OPS: Record<string, true> = {
	start: true,
	ps: true,
	logs: true,
	stop: true,
	restart: true,
	describe: true,
};

/** Launch-style call: an explicit process op, or `send`/`wait` targeting a process `name`. */
function isLaunchStyleArgs(args: HubRenderArgs | undefined): boolean {
	if (!args?.op) return false;
	if (LAUNCH_OPS[args.op]) return true;
	return (args.op === "send" || args.op === "wait") && !!args.name && !args.to && !args.from;
}

/** Job-style call: job ops, or a `wait` that does not target a peer or process. */
function isJobStyleArgs(args: HubRenderArgs | undefined): boolean {
	switch (args?.op) {
		case "jobs":
		case "cancel":
			return true;
		case "wait":
			return !!args.ids?.length || (!args.from && !args.name);
		default:
			return false;
	}
}

/** Launch details carry process/broker state; coordination details never define these keys. */
function isLaunchDetails(details: HubDetails): details is LaunchToolDetails {
	// `state`/`cursor` cover logs results, which may carry neither a daemon
	// snapshot nor terminal rows; coordination details never define these keys.
	return (
		"daemon" in details ||
		"daemons" in details ||
		"terminalRows" in details ||
		"spec" in details ||
		"state" in details ||
		"cursor" in details
	);
}

/** Hub args → launch renderer args: `ps` is the broker's `list`; everything else is verbatim. */
function toLaunchArgs(args: HubRenderArgs | undefined): LaunchRenderArgs {
	if (!args) return {};
	const { op, ...rest } = args;
	return { ...rest, op: op === "ps" ? "list" : op };
}

export const hubToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	// Only launch pending frames consume the spinner (broker RPC in flight);
	// messaging/job pending frames are static, exactly as before the merge.
	animatedPendingPreview: (args: unknown): boolean => isLaunchStyleArgs(args as HubRenderArgs | undefined),

	renderCall(args: HubRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		if (isLaunchStyleArgs(args)) return launchRenderCall(toLaunchArgs(args), options, uiTheme);
		return isJobStyleArgs(args)
			? jobsRenderCall(args, options, uiTheme)
			: messagingRenderCall(args, options, uiTheme);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: HubDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: HubRenderArgs,
	): Component {
		// Results dispatch on what actually happened, falling back to the call
		// shape when details are absent (framework-generated errors).
		const details = result.details;
		if (details && isLaunchDetails(details)) {
			return launchRenderResult({ ...result, details }, options, uiTheme, toLaunchArgs(args));
		}
		const coordination = details;
		if (coordination && (Array.isArray(coordination.jobs) || Array.isArray(coordination.agents))) {
			return jobsRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		}
		if (
			coordination &&
			("receipts" in coordination || "waited" in coordination || "inbox" in coordination || "peers" in coordination)
		) {
			return messagingRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		}
		// Detail-less or op-only results (validation errors, disabled gates).
		if (isLaunchStyleArgs(args))
			return launchRenderResult({ ...result, details: undefined }, options, uiTheme, toLaunchArgs(args));
		if (isJobStyleArgs(args)) return jobsRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		return messagingRenderResult({ ...result, details: coordination }, options, uiTheme, args);
	},
};
