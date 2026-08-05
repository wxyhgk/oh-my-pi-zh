import type { ResolvedThinkingLevel } from "@wxyhgk/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Effort,
	Model,
	ProviderSessionState,
	ServiceTier,
	ServiceTierByFamily,
	SimpleStreamOptions,
} from "@wxyhgk/pi-ai";
import { resolveModelServiceTier, streamSimple } from "@wxyhgk/pi-ai";
import { buildModelProviderPriorityRank } from "@wxyhgk/pi-catalog/identity";
import { replaceTabs, truncateToWidth } from "@wxyhgk/pi-tui";
import { formatDuration, getProjectDir, prompt } from "@wxyhgk/pi-utils";
import chalk from "chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import { buildServiceTierByFamily, serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import cachePrefixTemplate from "../prompts/bench/cache-prefix.md" with { type: "text" };
import cachePrefixChunk from "../prompts/bench/cache-prefix-chunk.md" with { type: "text" };
import cacheSuffixTemplate from "../prompts/bench/cache-suffix.md" with { type: "text" };
import benchPrompt from "../prompts/bench.md" with { type: "text" };
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";

const DEFAULT_RUNS = 10;
const DEFAULT_PAR = 4;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_CACHE_MAX_TOKENS = 64;
const DEFAULT_CACHE_PREFIX_BYTES = 8_192;
const DEFAULT_CACHE_PAIRS = 1;
const DEFAULT_CACHE_CONCURRENCY = 1;
const ERROR_WIDTH = 110;
const BENCH_PROMPT = benchPrompt.trim();
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const CACHE_PREFIX_CHUNK = cachePrefixChunk;
const CACHE_PREFIX_PLACEHOLDER = "__OMP_CACHE_BENCH_RAW_PREFIX__";
const CACHE_PREFIX_CHUNK_BYTES = UTF8_ENCODER.encode(CACHE_PREFIX_CHUNK).byteLength;
const RESPONSE_CACHE_STATUS_HEADERS = ["cf-aig-cache-status"] as const;

export interface BenchCommandArgs {
	models: string[];
	flags: {
		runs?: number;
		maxTokens?: number;
		prompt?: string;
		/** Service-tier setting value (`none` omits); overrides the configured `serviceTier` setting. */
		serviceTier?: string;
		json?: boolean;
		par?: number;
		cache?: boolean;
		cachePrefixFile?: string;
		cachePrefixBytes?: number;
		cachePairs?: number;
		cacheConcurrency?: number;
	};
}

export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

export interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

export interface BenchRunSuccess {
	ok: true;
	ttftMs: number;
	durationMs: number;
	outputTokens: number;
	/** Output tokens/sec over the total request duration. */
	tokensPerSecond: number;
}

export interface BenchRunFailure {
	ok: false;
	error: string;
}

export type BenchRunResult = BenchRunSuccess | BenchRunFailure;

export type CacheObservation =
	| "prompt_cache_read_observed"
	| "prompt_cache_write_observed"
	| "response_cache_hit_observed"
	| "no_provider_proof";

export interface BenchCacheUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
}

export interface BenchCacheRunReport {
	phase: "cold" | "warm";
	result: BenchRunResult;
	usage?: BenchCacheUsage;
	requestIdObserved: boolean;
	observations: CacheObservation[];
}

export interface BenchCachePairReport {
	cold: BenchCacheRunReport;
	warm: BenchCacheRunReport;
	/** The nominal cold request showed cache reuse, so it is not a true cold baseline. */
	coldAlreadyWarm: boolean;
	/** Structural-only comparisons: prompt text and cache keys are never emitted. */
	stablePrefix: true;
	suffixChanged: true;
	promptCacheKeyStable: true;
	statefulResponsesDisabled: true;
	freshProviderSessionState: true;
	/** "unavailable" when a transport does not expose the provider payload locally. */
	payloadStructureStable: boolean | "unavailable";
}

export interface BenchAverages {
	ttftMs: number;
	durationMs: number;
	outputTokens: number;
	tokensPerSecond: number;
}

export interface BenchModelReport {
	/** Selector as the user typed it (e.g. "opus" or "gemini-3.5:low"). */
	selector: string;
	/** Resolved `provider/id`. */
	model: string;
	/** Explicit thinking level from a `:level` selector suffix; undefined = provider default. */
	thinking?: ResolvedThinkingLevel;
	results: BenchRunResult[];
	/** Averages over successful runs; null when every run failed. */
	average: BenchAverages | null;
	cachePairs?: BenchCachePairReport[];
}

export interface BenchSummary {
	runs: number;
	maxTokens: number;
	models: BenchModelReport[];
	failures: number;
	/** Requested per-family service tiers, resolved per model before reaching the wire. */
	serviceTierByFamily?: ServiceTierByFamily;
	cache?: {
		pairs: number;
		concurrency: number;
	};
}

type BenchStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface BenchDependencies {
	createRuntime?: () => Promise<BenchRuntime>;
	randomSessionId?: () => string;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
	streamSimple?: BenchStreamSimple;
	now?: () => number;
	readTextFile?: (path: string, maxBytes: number) => Promise<string>;
	stdoutIsTTY?: boolean;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function normalizePositiveInteger(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`--${name} 应为正整数,实际为 ${value}`);
	}
	return value;
}

function closeProviderSessionStates(providerSessionState: Map<string, ProviderSessionState>): void {
	for (const state of providerSessionState.values()) {
		state.close();
	}
	providerSessionState.clear();
}

function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "image_end":
			return true;
		default:
			return false;
	}
}

/** Final message carries visible output — non-empty text/thinking, an image, or a tool call. */
function hasVisibleFinalContent(message: AssistantMessage): boolean {
	return message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.length > 0;
			case "thinking":
				return block.thinking.length > 0;
			case "image":
			case "redactedThinking":
			case "toolCall":
				return true;
			default:
				return false;
		}
	});
}

interface CacheRequestCapture {
	payloadStructure?: string;
	requestIdObserved: boolean;
	responseCacheHit: boolean;
	usage?: BenchCacheUsage;
}

function payloadStructure(payload: unknown): string {
	if (payload === null) return "null";
	if (Array.isArray(payload)) return `[${payload.map(payloadStructure).join(",")}]`;
	if (typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${key}:${payloadStructure(record[key])}`)
			.join(",")}}`;
	}
	return typeof payload;
}

function asNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function captureUsage(message: AssistantMessage): BenchCacheUsage {
	const usage = message.usage;
	return {
		inputTokens: asNonNegativeNumber(usage.input),
		outputTokens: asNonNegativeNumber(usage.output),
		cacheReadTokens: asNonNegativeNumber(usage.cacheRead),
		cacheWriteTokens: asNonNegativeNumber(usage.cacheWrite),
		totalTokens: asNonNegativeNumber(usage.totalTokens),
		cost: asNonNegativeNumber(usage.cost?.total),
	};
}

function cacheObservations(capture: CacheRequestCapture): CacheObservation[] {
	const observations: CacheObservation[] = [];
	if ((capture.usage?.cacheReadTokens ?? 0) > 0) observations.push("prompt_cache_read_observed");
	if ((capture.usage?.cacheWriteTokens ?? 0) > 0) observations.push("prompt_cache_write_observed");
	if (capture.responseCacheHit) observations.push("response_cache_hit_observed");
	return observations.length > 0 ? observations : ["no_provider_proof"];
}

function cacheRunReport(
	phase: BenchCacheRunReport["phase"],
	result: BenchRunResult,
	capture: CacheRequestCapture,
): BenchCacheRunReport {
	return {
		phase,
		result,
		usage: capture.usage,
		requestIdObserved: capture.requestIdObserved,
		observations: cacheObservations(capture),
	};
}

function truncateUtf8ByteLength(bytes: Uint8Array, maxBytes: number): number {
	const end = Math.min(bytes.byteLength, maxBytes);
	if (end === 0) return 0;

	let sequenceStart = end - 1;
	while (sequenceStart > 0 && (bytes[sequenceStart]! & 0b1100_0000) === 0b1000_0000) sequenceStart--;

	const leadingByte = bytes[sequenceStart]!;
	const sequenceLength =
		leadingByte <= 0b0111_1111
			? 1
			: leadingByte >= 0b1100_0010 && leadingByte <= 0b1101_1111
				? 2
				: leadingByte >= 0b1110_0000 && leadingByte <= 0b1110_1111
					? 3
					: leadingByte >= 0b1111_0000 && leadingByte <= 0b1111_0100
						? 4
						: 1;
	return sequenceLength > end - sequenceStart ? sequenceStart : end;
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
	const file = Bun.file(path);
	const bytes = new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
	const end = truncateUtf8ByteLength(bytes, maxBytes);
	return UTF8_DECODER.decode(bytes.subarray(0, end));
}

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = UTF8_ENCODER.encode(text);
	const end = truncateUtf8ByteLength(bytes, maxBytes);
	return end === bytes.byteLength ? text : UTF8_DECODER.decode(bytes.subarray(0, end));
}

function generatedCachePrefix(bytes: number): string {
	return truncateUtf8(CACHE_PREFIX_CHUNK.repeat(Math.ceil(bytes / CACHE_PREFIX_CHUNK_BYTES)), bytes);
}

function renderCacheBenchmarkPrefix(prefix: string, namespace: string): string {
	const rendered = prompt.render(cachePrefixTemplate, {
		prefix: CACHE_PREFIX_PLACEHOLDER,
		namespace,
	});
	if (!rendered.includes(CACHE_PREFIX_PLACEHOLDER)) {
		throw new Error("缓存基准前缀模板缺少其原始前缀占位符");
	}
	// Render the static wrapper first, then inject caller bytes so prompt
	// normalization cannot trim spaces or collapse blank lines in prefix files.
	// Function replacer: a prefix containing `$&`/`$'`/`` $` `` must not be
	// expanded as a string-replacement pattern.
	return rendered.replace(CACHE_PREFIX_PLACEHOLDER, () => prefix);
}

async function resolveCachePrefix(
	flags: BenchCommandArgs["flags"],
	readTextFile: (path: string, maxBytes: number) => Promise<string>,
): Promise<string> {
	const bytes = normalizePositiveInteger("cache-prefix-bytes", flags.cachePrefixBytes, DEFAULT_CACHE_PREFIX_BYTES);
	const prefix = flags.cachePrefixFile
		? await readTextFile(flags.cachePrefixFile, bytes)
		: generatedCachePrefix(bytes);
	return truncateUtf8(prefix, bytes);
}

function cacheBenchmarkMessages(stablePrefix: string, suffix: string): Context["messages"] {
	const timestamp = Date.now();
	return [
		{ role: "user", content: stablePrefix, timestamp, attribution: "user" },
		{ role: "user", content: suffix, timestamp, attribution: "user" },
	];
}

async function runWithConcurrency<T>(
	count: number,
	concurrency: number,
	run: (index: number) => Promise<T>,
): Promise<T[]> {
	const results = new Array<T>(count);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < count) {
			const index = next++;
			results[index] = await run(index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
	return results;
}

function formatCacheCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

function formatCachePairLine(pair: BenchCachePairReport, index: number, total: number): string {
	const formatPhase = (run: BenchCacheRunReport, alreadyWarm = false) => {
		if (!run.result.ok) {
			return `${run.phase} 失败:${truncateToWidth(replaceTabs(run.result.error), ERROR_WIDTH)}`;
		}
		const usage = run.usage;
		return `${run.phase}${alreadyWarm ? " (已预热)" : ""} ${run.observations.join(", ")} ${chalk.dim("输入")} ${usage?.inputTokens ?? 0} ${chalk.dim("缓存读取")} ${usage?.cacheReadTokens ?? 0} ${chalk.dim("缓存写入")} ${usage?.cacheWriteTokens ?? 0} ${chalk.dim("输出")} ${usage?.outputTokens ?? run.result.outputTokens} ${chalk.dim("总计")} ${usage?.totalTokens ?? 0} ${chalk.dim("费用")} ${formatCacheCost(usage?.cost ?? 0)} ${chalk.dim("TTFT")} ${formatMs(run.result.ttftMs)} ${chalk.dim("耗时")} ${formatMs(run.result.durationMs)} ${chalk.dim("吞吐量")} ${run.result.tokensPerSecond.toFixed(1)}/s`;
	};
	return `  ${chalk.dim(`第 ${index + 1}/${total} 对`)} ${formatPhase(pair.cold, pair.coldAlreadyWarm)}; ${formatPhase(pair.warm)}`;
}

interface BenchRequestOptions {
	apiKey: ApiKeyResolver;
	sessionId: string;
	prompt: string;
	/** Native OMP messages; cache mode splits the stable prefix from the suffix. */
	contextMessages?: Context["messages"];
	maxTokens: number;
	/** Explicit effort from a `:level` selector suffix; absent = provider default. */
	reasoning?: Effort;
	/** Only set for an explicit `:off` suffix — some endpoints reject disablement. */
	disableReasoning?: boolean;
	/** Requested service tier passed to `streamSimple`; absent omits the option. The provider layer applies scope/support gating before it reaches the wire. */
	serviceTier?: ServiceTier;
	promptCacheKey?: string;
	statefulResponses?: false;
	cacheCapture?: CacheRequestCapture;
}

async function runBenchRequest(
	model: Model<Api>,
	options: BenchRequestOptions,
	streamFn: BenchStreamSimple,
	now: () => number,
): Promise<BenchRunResult> {
	const startedAt = now();
	let firstTokenAt: number | undefined;
	const providerSessionState = new Map<string, ProviderSessionState>();
	try {
		const context: Context = {
			// Codex's Responses endpoint 400s with "Instructions are required" when no
			// system prompt is present — same guard as eval's completion bridge.
			systemPrompt: ["You are a helpful assistant."],
			messages: options.contextMessages ?? [
				{ role: "user", content: options.prompt, timestamp: Date.now(), attribution: "user" },
			],
		};
		const stream = streamFn(model, context, {
			apiKey: options.apiKey,
			sessionId: options.sessionId,
			maxTokens:
				model.maxTokens !== null && Number.isFinite(model.maxTokens) && model.maxTokens > 0
					? Math.min(options.maxTokens, model.maxTokens)
					: options.maxTokens,
			reasoning: options.reasoning,
			promptCacheKey: options.promptCacheKey,
			statefulResponses: options.statefulResponses,
			onPayload: options.cacheCapture
				? payload => {
						options.cacheCapture!.payloadStructure = payloadStructure(payload);
						return undefined;
					}
				: undefined,
			onResponse: options.cacheCapture
				? response => {
						options.cacheCapture!.requestIdObserved = Boolean(response.requestId);
						options.cacheCapture!.responseCacheHit = RESPONSE_CACHE_STATUS_HEADERS.some(
							header => response.headers[header]?.trim().toLowerCase() === "hit",
						);
					}
				: undefined,
			disableReasoning: options.disableReasoning,
			serviceTier: options.serviceTier,
			providerSessionState,
			preferWebsockets: true,
			// pi-ai opts every OpenRouter request into response caching (1h TTL).
			// Bench sends a byte-identical request each run, so within the TTL
			// OpenRouter replays the cached generation with zeroed usage — the run
			// shows "tokens 0, TPS 0.0" at line speed. Opt back out so every run
			// measures a fresh generation.
			headers: model.provider === "openrouter" ? { "X-OpenRouter-Cache": "false" } : undefined,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (firstTokenAt === undefined && isFirstTokenEvent(event)) {
				firstTokenAt = now();
			}
			if (event.type === "error") {
				return { ok: false, error: event.error.errorMessage ?? "请求失败" };
			}
			if (event.type === "done") {
				message = event.message;
			}
		}
		message ??= await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			return { ok: false, error: message.errorMessage ?? "请求失败" };
		}
		const rawDuration = message.duration ?? now() - startedAt;
		const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
		const rawTtft = message.ttft ?? (firstTokenAt === undefined ? durationMs : firstTokenAt - startedAt);
		const ttftMs = Number.isFinite(rawTtft) && rawTtft > 0 ? rawTtft : 0;
		const outputTokens = Number.isFinite(message.usage.output) && message.usage.output > 0 ? message.usage.output : 0;
		// A run that streamed no content (no delta/end event set firstTokenAt),
		// carries no visible final content, and measured no output tokens
		// benchmarked nothing — a genuinely empty stream (e.g. a gateway that 200s
		// with an empty body). Surface it as a failure instead of a misleading
		// 0-token "✓". Streaming and buffered providers that produce content keep
		// passing even when usage is omitted.
		if (firstTokenAt === undefined && outputTokens === 0 && !hasVisibleFinalContent(message)) {
			return {
				ok: false,
				error: `提供商未返回任何输出(0 token,流为空;停止原因:${message.stopReason ?? "未知"})`,
			};
		}
		if (options.cacheCapture) options.cacheCapture.usage = captureUsage(message);
		return {
			ok: true,
			ttftMs,
			durationMs,
			outputTokens,
			// TPS over the TOTAL request duration, deliberately not the post-TTFT
			// decode window: reasoning models can spend seconds generating hidden
			// thinking tokens (counted in usage.output) before the first visible
			// byte, so "duration - TTFT" inflates TPS several-fold on providers
			// that buffer or hide reasoning (e.g. google vs google-vertex).
			tokensPerSecond: durationMs > 0 ? (outputTokens * 1000) / durationMs : 0,
		};
	} catch (error) {
		return { ok: false, error: getErrorMessage(error) };
	} finally {
		closeProviderSessionStates(providerSessionState);
	}
}

function buildModelReport(
	selector: string,
	model: Model<Api>,
	thinking: ResolvedThinkingLevel | undefined,
	results: BenchRunResult[],
): BenchModelReport {
	const successes = results.filter((result): result is BenchRunSuccess => result.ok);
	const average =
		successes.length === 0
			? null
			: {
					ttftMs: successes.reduce((sum, r) => sum + r.ttftMs, 0) / successes.length,
					durationMs: successes.reduce((sum, r) => sum + r.durationMs, 0) / successes.length,
					outputTokens: successes.reduce((sum, r) => sum + r.outputTokens, 0) / successes.length,
					tokensPerSecond: successes.reduce((sum, r) => sum + r.tokensPerSecond, 0) / successes.length,
				};
	return { selector, model: formatModelString(model), thinking, results, average };
}

function formatBenchModelLabel(report: BenchModelReport): string {
	return formatModelSelectorValue(report.model, report.thinking);
}

function formatMs(ms: number): string {
	return formatDuration(Math.max(0, Math.round(ms)));
}

function formatRunLine(result: BenchRunResult, index: number, total: number): string {
	const prefix = chalk.dim(`第 ${index + 1}/${total} 次`);
	if (result.ok) {
		return `  ${chalk.green("✓")} ${prefix} ${chalk.dim("TTFT")} ${formatMs(result.ttftMs)} ${chalk.dim("TPS")} ${result.tokensPerSecond.toFixed(1)}/s ${chalk.dim("token")} ${result.outputTokens} ${chalk.dim("总计")} ${formatMs(result.durationMs)}`;
	}
	return `  ${chalk.red("✗")} ${prefix} ${chalk.red(truncateToWidth(replaceTabs(result.error).replace(/\r?\n/g, " "), ERROR_WIDTH))}`;
}

export function formatBenchTable(summary: BenchSummary): string {
	const ranked = [...summary.models].sort((a, b) => {
		if (a.average === null && b.average === null) return 0;
		if (a.average === null) return 1;
		if (b.average === null) return -1;
		return b.average.tokensPerSecond - a.average.tokensPerSecond;
	});
	const rows = ranked.map(report => ({
		model: formatBenchModelLabel(report),
		ttft: report.average ? formatMs(report.average.ttftMs) : "-",
		tps: report.average ? `${report.average.tokensPerSecond.toFixed(1)}/s` : "-",
		tokens: report.average ? String(Math.round(report.average.outputTokens)) : "-",
		total: report.average ? formatMs(report.average.durationMs) : "-",
		failed: report.results.filter(result => !result.ok).length,
	}));
	const headers = { model: "模型", ttft: "TTFT", tps: "TPS", tokens: "token", total: "总计" } as const;
	const width = (key: keyof typeof headers): number =>
		Math.max(headers[key].length, ...rows.map(row => row[key].length));
	const lines = [
		[
			headers.model.padEnd(width("model")),
			headers.ttft.padEnd(width("ttft")),
			headers.tps.padEnd(width("tps")),
			headers.tokens.padEnd(width("tokens")),
			headers.total.padEnd(width("total")),
		]
			.join("  ")
			.trimEnd(),
	];
	for (const row of rows) {
		const failedSuffix = row.failed > 0 ? `  ${chalk.red(`(${row.failed} 次失败)`)}` : "";
		lines.push(
			[
				row.model.padEnd(width("model")),
				row.ttft.padEnd(width("ttft")),
				row.tps.padEnd(width("tps")),
				row.tokens.padEnd(width("tokens")),
				row.total.padEnd(width("total")),
			]
				.join("  ")
				.trimEnd() + failedSuffix,
		);
	}
	return `${lines.map((line, index) => (index === 0 ? chalk.dim(line) : line)).join("\n")}\n`;
}

async function createDefaultRuntime(): Promise<BenchRuntime> {
	const authStorage = await discoverAuthStorage();
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return {
			modelRegistry,
			settings,
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}

/** Highest-priority provider variant: native/OAuth transports outrank mirrors. */
function pickHighestPriorityProvider(models: Model<Api>[], providerOrder?: readonly string[]): Model<Api> | undefined {
	if (models.length <= 1) return models[0];
	const priority = buildModelProviderPriorityRank(providerOrder);
	return [...models].sort((a, b) => {
		const aRank = priority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = priority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		return aRank - bRank;
	})[0];
}

/**
 * Bench resolves selectors against the entire catalog (credentials are ignored),
 * so an ambiguous id shared by several providers can land on one the user never
 * authenticated. For non-pinned selectors, redirect to an equivalent model under
 * a provider with configured auth. An explicit `provider/id` selector is honored
 * verbatim — even unauthenticated — so forced benchmarking keeps working.
 */
function resolveAuthenticatedAlternative(
	selector: string,
	model: Model<Api>,
	modelRegistry: BenchModelRegistry,
	providerOrder?: readonly string[],
): Model<Api> | undefined {
	if (!modelRegistry.hasConfiguredAuth) return undefined;
	// A pinned `provider/...` selector is authoritative; never redirect off it.
	if (selector.trim().toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) return undefined;
	if (modelRegistry.hasConfiguredAuth(model)) return undefined;

	const seen = new Set<string>();
	const authenticated: Model<Api>[] = [];
	const consider = (candidate: Model<Api>): void => {
		const key = `${candidate.provider}/${candidate.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (modelRegistry.hasConfiguredAuth?.(candidate)) authenticated.push(candidate);
	};
	// Same-id fallback for equivalent entries under providers with configured auth.
	for (const candidate of modelRegistry.getAll()) {
		if (candidate.id === model.id) consider(candidate);
	}
	return pickHighestPriorityProvider(authenticated, providerOrder);
}

function resolveBenchModels(
	selectors: string[],
	modelRegistry: BenchModelRegistry,
	settings: Settings | undefined,
	writeStderr: (text: string) => void,
): BenchTarget[] {
	const preferences = getModelMatchPreferences(settings);
	const resolved: BenchTarget[] = [];
	const errors: string[] = [];
	for (const selector of selectors) {
		// Bench intentionally resolves against the full catalog first, then applies
		// its own exact-id credential fallback below. Using the CLI resolver's
		// authenticated default here would silently redirect non-equivalent bare
		// ids and suppress the warning for equivalent cross-provider models.
		const result = resolveCliModel({
			cliModel: selector,
			modelRegistry,
			availableModels: modelRegistry.getAll(),
			settings,
			preferences,
		});
		if (result.error) {
			errors.push(`${selector}:${result.error}`);
			continue;
		}
		if (!result.model) {
			errors.push(`${selector}:未找到模型`);
			continue;
		}
		if (result.warning) writeStderr(`${chalk.yellow(`警告:${result.warning}`)}\n`);
		let model = result.model;
		const authSelector = result.configuredPatterns?.[result.configuredPatternIndex ?? 0] ?? selector;
		const authenticated = resolveAuthenticatedAlternative(
			authSelector,
			model,
			modelRegistry,
			preferences.providerOrder,
		);
		if (authenticated) {
			writeStderr(
				`${chalk.yellow(
					`警告:没有“${model.provider}”的凭据;将改用 ${formatModelString(authenticated)} 进行基准测试。如需强制使用,请固定“${formatModelString(model)}”。`,
				)}\n`,
			);
			model = authenticated;
		}
		resolved.push({
			selector,
			model,
			thinking: resolveThinkingLevelForModel(model, concreteThinkingLevel(result.thinkingLevel)),
		});
	}
	if (errors.length > 0) {
		throw new Error(`无法解析${errors.length === 1 ? "模型" : "多个模型"}:\n${errors.join("\n")}`);
	}
	return resolved;
}
function assertCacheModeSupported(targets: BenchTarget[]): void {
	if (targets.some(({ model }) => model.api === "openai-codex-responses")) {
		throw new Error("--cache 不支持 openai-codex-responses,因为 Codex WebSocket 链式调用无法产生独立的提示词缓存对");
	}
}

export async function runBenchCommand(command: BenchCommandArgs, deps: BenchDependencies = {}): Promise<BenchSummary> {
	const cacheMode = command.flags.cache === true;
	const cacheFlagsUsed =
		command.flags.cachePrefixFile !== undefined ||
		command.flags.cachePrefixBytes !== undefined ||
		command.flags.cachePairs !== undefined ||
		command.flags.cacheConcurrency !== undefined;
	if (!cacheMode && cacheFlagsUsed) throw new Error("缓存标志需要 --cache");
	if (cacheMode && command.flags.runs !== undefined) throw new Error("使用 --cache 时请用 --cache-pairs 代替 --runs");
	if (cacheMode && command.flags.prompt !== undefined) throw new Error("--cache 会构建自己的稳定前缀提示词");
	if (cacheMode && (command.flags.par ?? 1) > 1) {
		throw new Error("--par 无法并行冷/热对;请改用 --cache-concurrency");
	}

	const cachePairs = cacheMode
		? normalizePositiveInteger("cache-pairs", command.flags.cachePairs, DEFAULT_CACHE_PAIRS)
		: undefined;
	const cacheConcurrency = cacheMode
		? normalizePositiveInteger("cache-concurrency", command.flags.cacheConcurrency, DEFAULT_CACHE_CONCURRENCY)
		: undefined;
	const runs = cacheMode ? cachePairs! * 2 : normalizePositiveInteger("runs", command.flags.runs, DEFAULT_RUNS);
	const maxTokens = normalizePositiveInteger(
		"max-tokens",
		command.flags.maxTokens,
		cacheMode ? DEFAULT_CACHE_MAX_TOKENS : DEFAULT_MAX_TOKENS,
	);
	const par =
		command.flags.par !== undefined ? normalizePositiveInteger("par", command.flags.par, DEFAULT_PAR) : DEFAULT_PAR;
	const benchmarkPrompt = command.flags.prompt?.trim() || BENCH_PROMPT;
	const json = command.flags.json === true;
	const randomSessionId = deps.randomSessionId ?? (() => Bun.randomUUIDv7());
	const readTextFile = deps.readTextFile ?? readBoundedUtf8File;
	const cachePrefix = cacheMode ? await resolveCachePrefix(command.flags, readTextFile) : undefined;
	const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
	const setExitCode =
		deps.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});
	const streamFn = deps.streamSimple ?? streamSimple;
	const now = deps.now ?? (() => performance.now());
	const interactive = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
	if (command.models.length === 0) {
		throw new Error("请至少传入一个模型选择器,例如 `omp-zh bench opus gpt-5.2`");
	}

	const runtime = await (deps.createRuntime ?? createDefaultRuntime)();
	try {
		const targets = resolveBenchModels(command.models, runtime.modelRegistry, runtime.settings, writeStderr);
		if (cacheMode) assertCacheModeSupported(targets);
		// Explicit `--service-tier` (a single value broadcast across families) wins;
		// otherwise fall back to the configured per-family `tier.*` settings. Each
		// model resolves its own family's tier below before reaching the wire.
		const flagTier = command.flags.serviceTier ? serviceTierSettingToTier(command.flags.serviceTier) : undefined;
		const serviceTierByFamily = command.flags.serviceTier
			? serviceTierForAllFamilies(flagTier)
			: buildServiceTierByFamily(
					runtime.settings?.get("tier.openai") ?? "none",
					runtime.settings?.get("tier.anthropic") ?? "none",
					runtime.settings?.get("tier.google") ?? "none",
				);
		if (!json && flagTier) writeStdout(`${chalk.dim(`服务层:${flagTier}`)}\n`);
		const reports: BenchModelReport[] = [];
		for (const { selector, model, thinking } of targets) {
			if (!json) {
				const resolvedModel = formatModelSelectorValue(formatModelString(model), thinking);
				const resolvedNote = selector === resolvedModel ? "" : chalk.dim(` (${selector})`);
				writeStdout(`${chalk.bold(resolvedModel)}${resolvedNote}\n`);
			}
			const results: BenchRunResult[] = [];

			// Preflight check: let's verify credentials before starting any runs.
			// This matches the old sequential break behavior exactly and avoids launching/printing
			// multiple failures.
			const testSessionId = randomSessionId();
			const preflightKey = await runtime.modelRegistry.getApiKey(model, testSessionId);
			if (!preflightKey) {
				const failure: BenchRunFailure = {
					ok: false,
					error: `提供商“${model.provider}”没有凭据。请运行 \`omp-zh\` 并使用 /login,或设置提供商的 API 密钥。`,
				};
				results.push(failure);
				if (!json) writeStdout(`${formatRunLine(failure, 0, runs)}\n`);
				const report = buildModelReport(selector, model, thinking, results);
				if (cacheMode) report.cachePairs = [];
				reports.push(report);
				continue;
			}

			const serviceTier = resolveModelServiceTier(serviceTierByFamily, model);
			if (cacheMode) {
				const pairs = await runWithConcurrency(
					cachePairs!,
					cacheConcurrency!,
					async (pairIndex): Promise<BenchCachePairReport> => {
						const cacheNamespace = randomSessionId();
						const promptCacheKey = `bench-cache:${cacheNamespace}`;
						const stablePrefix = renderCacheBenchmarkPrefix(cachePrefix!, cacheNamespace);
						const coldSuffix = prompt.render(cacheSuffixTemplate, { variant: "A" }).trim();
						const warmSuffix = prompt.render(cacheSuffixTemplate, { variant: "B" }).trim();
						const coldCapture: CacheRequestCapture = {
							requestIdObserved: false,
							responseCacheHit: false,
						};
						// Keep the gateway's credential selection stable for both phases.
						// Provider-session state is still recreated by runBenchRequest and
						// stateful Responses chaining is disabled below.
						const credentialAffinitySessionId = pairIndex === 0 ? testSessionId : randomSessionId();
						const credentialResolver = runtime.modelRegistry.resolver(model, credentialAffinitySessionId);
						const coldResult = await runBenchRequest(
							model,
							{
								apiKey: credentialResolver,
								sessionId: credentialAffinitySessionId,
								prompt: coldSuffix,
								contextMessages: cacheBenchmarkMessages(stablePrefix, coldSuffix),
								maxTokens,
								reasoning: toReasoningEffort(thinking),
								disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
								serviceTier,
								promptCacheKey,
								statefulResponses: false,
								cacheCapture: coldCapture,
							},
							streamFn,
							now,
						);
						const warmCapture: CacheRequestCapture = {
							requestIdObserved: false,
							responseCacheHit: false,
						};
						const warmResult = await runBenchRequest(
							model,
							{
								apiKey: credentialResolver,
								sessionId: credentialAffinitySessionId,
								prompt: warmSuffix,
								contextMessages: cacheBenchmarkMessages(stablePrefix, warmSuffix),
								maxTokens,
								reasoning: toReasoningEffort(thinking),
								disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
								serviceTier,
								promptCacheKey,
								statefulResponses: false,
								cacheCapture: warmCapture,
							},
							streamFn,
							now,
						);
						return {
							cold: cacheRunReport("cold", coldResult, coldCapture),
							warm: cacheRunReport("warm", warmResult, warmCapture),
							coldAlreadyWarm: (coldCapture.usage?.cacheReadTokens ?? 0) > 0 || coldCapture.responseCacheHit,
							stablePrefix: true,
							suffixChanged: true,
							promptCacheKeyStable: true,
							statefulResponsesDisabled: true,
							freshProviderSessionState: true,
							payloadStructureStable:
								coldCapture.payloadStructure === undefined || warmCapture.payloadStructure === undefined
									? "unavailable"
									: coldCapture.payloadStructure === warmCapture.payloadStructure,
						};
					},
				);
				for (const pair of pairs) results.push(pair.cold.result, pair.warm.result);
				const report = buildModelReport(selector, model, thinking, results);
				report.cachePairs = pairs;
				reports.push(report);
				if (!json) {
					for (const [index, pair] of pairs.entries()) {
						writeStdout(`${formatCachePairLine(pair, index, pairs.length)}\n`);
					}
				}
				continue;
			}

			// We will launch up to `par` workers/requests concurrently.
			// To keep output clean, non-JSON output emits entries in correct index order.
			let nextToPrint = 0;
			const runWorker = async (index: number) => {
				const sessionId = index === 0 ? testSessionId : randomSessionId();
				const result = await runBenchRequest(
					model,
					{
						apiKey: runtime.modelRegistry.resolver(model, sessionId),
						sessionId,
						prompt: benchmarkPrompt,
						maxTokens,
						reasoning: toReasoningEffort(thinking),
						disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
						serviceTier,
					},
					streamFn,
					now,
				);
				results[index] = result;
			};
			const queue = Array.from({ length: runs }, (_, i) => i);
			const activeWorkers: Promise<void>[] = [];
			const processNext = async (): Promise<void> => {
				if (queue.length === 0) return;
				const index = queue.shift()!;
				if (!json && interactive) writeStdout(chalk.dim(`  … 第 ${index + 1}/${runs} 次流式运行\n`));
				await runWorker(index);
				if (!json) {
					while (nextToPrint < runs && results[nextToPrint] !== undefined) {
						writeStdout(`${formatRunLine(results[nextToPrint], nextToPrint, runs)}\n`);
						nextToPrint++;
					}
				}
				await processNext();
			};
			for (let worker = 0; worker < Math.min(par, runs); worker++) activeWorkers.push(processNext());
			await Promise.all(activeWorkers);
			reports.push(buildModelReport(selector, model, thinking, results));
		}
		const failures = reports.reduce((sum, report) => sum + report.results.filter(result => !result.ok).length, 0);
		const summary: BenchSummary = {
			runs,
			maxTokens,
			models: reports,
			failures,
			serviceTierByFamily,
			...(cacheMode ? { cache: { pairs: cachePairs!, concurrency: cacheConcurrency! } } : {}),
		};
		if (json) {
			writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
		} else if (!cacheMode && (reports.length > 1 || runs > 1)) {
			writeStdout(`\n${formatBenchTable(summary)}`);
		}
		if (failures > 0) setExitCode(1);
		return summary;
	} finally {
		runtime.close?.();
	}
}
