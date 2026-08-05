import { type ApiKey, type ApiKeyResolver, type AuthStorage, withAuth } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import { resolveXAIHttpTransport, type XAIHttpProvider, type XAIHttpTransport } from "../../../lib/xai-http";
import type { SearchCitation, SearchResponse, SearchSource, SearchUsage } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const XAI_WEB_SEARCH_MODEL = "grok-4.5";
// grok-4.5 defaults reasoning.effort to "high"; xAI documents "low" for
// latency-sensitive agentic use and simple tool calling
// (docs.x.ai/developers/model-capabilities/text/reasoning). Web search is
// latency-sensitive, so pin these calls low regardless of their configured timeout.
const XAI_WEB_SEARCH_REASONING_EFFORT = "low";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 30;

interface XAIUrlCitationAnnotation {
	type?: string;
	url?: string | null;
	title?: string | null;
	text?: string | null;
	cited_text?: string | null;
}

interface XAIResponseContentPart {
	type?: string;
	text?: string | null;
	output_text?: string | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
}

interface XAIResponseOutputItem {
	content?: XAIResponseContentPart[] | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
}

interface XAIResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

interface XAIResponsesResponse {
	id?: string;
	model?: string;
	output_text?: string | null;
	output?: XAIResponseOutputItem[] | null;
	annotations?: XAIUrlCitationAnnotation[] | null;
	citations?: string[] | null;
	usage?: XAIResponsesUsage | null;
}

/**
 * Query syntax re-emitted for the Grok search agent. `site:`/`-site:` are
 * stripped because hosts map natively onto the web_search domain filters;
 * `before:`/`after:` stay in the query text — the Responses web_search tool
 * has no date parameters (`from_date`/`to_date` exist only on `x_search` and
 * the deprecated Live Search `search_parameters`, which now returns 410) and
 * the agent honors the tokens as natural-language hints.
 */
const XAI_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	inUrl: true,
	inTitle: true,
	filetype: true,
	dateRange: true,
};

/** xAI web_search accepts at most 5 allowed or excluded domains per request. */
const MAX_DOMAIN_FILTERS = 5;

/** Bare hosts of `site:` values (`github.com/anthropics` → `github.com`), deduped, capped at 5; path parts are enforced by the central constraint filter. */
function domainFilterList(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const slash = site.indexOf("/");
		hosts.add(slash === -1 ? site : site.slice(0, slash));
		if (hosts.size === MAX_DOMAIN_FILTERS) break;
	}
	return [...hosts];
}

function buildRequestBody(params: SearchParams): Record<string, unknown> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const webSearchTool: Record<string, unknown> = { type: "web_search" };
	let query = params.query;
	if (parsed.hasDirectives) {
		query = formatQuery(parsed, XAI_QUERY_SYNTAX);
		// allowed_domains and excluded_domains are mutually exclusive per
		// request; prefer the allow list, the central filter enforces exclusions.
		if (parsed.sites.length > 0) {
			webSearchTool.filters = { allowed_domains: domainFilterList(parsed.sites) };
		} else if (parsed.excludedSites.length > 0) {
			webSearchTool.filters = { excluded_domains: domainFilterList(parsed.excludedSites) };
		}
	}

	const body: Record<string, unknown> = {
		model: XAI_WEB_SEARCH_MODEL,
		input: [
			{ role: "system", content: params.systemPrompt },
			{ role: "user", content: query },
		],
		tools: [webSearchTool],
		reasoning: { effort: XAI_WEB_SEARCH_REASONING_EFFORT },
	};

	if (params.maxOutputTokens !== undefined) {
		body.max_output_tokens = params.maxOutputTokens;
	}
	if (params.temperature !== undefined) {
		body.temperature = params.temperature;
	}

	return body;
}

async function postXAIResponses(
	apiKey: string,
	params: SearchParams,
	body: Record<string, unknown>,
	transport: XAIHttpTransport,
): Promise<Response> {
	return (params.fetch ?? fetch)(`${transport.baseURL.replace(/\/+$/, "")}/responses`, {
		method: "POST",
		headers: {
			...transport.headers,
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});
}

function throwXAIResponsesError(status: number, errorText: string): never {
	const classified = classifyProviderHttpError("xai", status, errorText);
	if (classified) throw classified;
	throw new SearchProviderError("xai", `xAI Responses API 错误(${status}): ${errorText}`, status);
}

async function callXAIResponses(
	apiKey: string,
	params: SearchParams,
	transport: XAIHttpTransport,
): Promise<XAIResponsesResponse> {
	const requestBody = buildRequestBody(params);
	const response = await postXAIResponses(apiKey, params, requestBody, transport);

	if (!response.ok) {
		throwXAIResponsesError(response.status, await response.text());
	}

	return (await response.json()) as XAIResponsesResponse;
}

function addCitationSource(
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
	url: string,
	title?: string | null,
	citedText?: string | null,
): void {
	const trimmedUrl = url.trim();
	if (!trimmedUrl || seenUrls.has(trimmedUrl)) return;
	seenUrls.add(trimmedUrl);
	const sourceTitle = title?.trim() || trimmedUrl;
	const sourceSnippet = citedText?.trim() || undefined;

	sources.push({
		title: sourceTitle,
		url: trimmedUrl,
		snippet: sourceSnippet,
	});
	citations.push({
		title: sourceTitle,
		url: trimmedUrl,
		citedText: sourceSnippet,
	});
}

function collectAnnotationSources(
	annotations: readonly XAIUrlCitationAnnotation[] | null | undefined,
	sources: SearchSource[],
	citations: SearchCitation[],
	seenUrls: Set<string>,
): void {
	if (!annotations) return;
	for (const annotation of annotations) {
		if (annotation.type !== "url_citation" || !annotation.url) continue;
		addCitationSource(
			sources,
			citations,
			seenUrls,
			annotation.url,
			annotation.title,
			annotation.cited_text ?? annotation.text,
		);
	}
}

function parseAnswer(response: XAIResponsesResponse): string | undefined {
	const topLevelText = response.output_text?.trim();
	if (topLevelText) return topLevelText;

	const answerParts: string[] = [];
	for (const item of response.output ?? []) {
		for (const part of item.content ?? []) {
			const text = part.output_text ?? part.text;
			if ((part.type === "output_text" || part.type === "text") && text?.trim()) {
				answerParts.push(text.trim());
			}
		}
	}

	const answer = answerParts.join("\n").trim();
	return answer ? answer : undefined;
}

function parseUsage(usage: XAIResponsesUsage | null | undefined): SearchUsage | undefined {
	if (!usage) return undefined;
	const parsed: SearchUsage = {};
	const inputTokens = usage.input_tokens ?? usage.inputTokens;
	const outputTokens = usage.output_tokens ?? usage.outputTokens;
	const totalTokens = usage.total_tokens ?? usage.totalTokens;

	if (typeof inputTokens === "number") parsed.inputTokens = inputTokens;
	if (typeof outputTokens === "number") parsed.outputTokens = outputTokens;
	if (typeof totalTokens === "number") parsed.totalTokens = totalTokens;

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function applyResultCap(
	sources: SearchSource[],
	citations: SearchCitation[],
	resultCap: number,
): { sources: SearchSource[]; citations: SearchCitation[] } {
	return {
		sources: sources.slice(0, resultCap),
		citations: citations.slice(0, resultCap),
	};
}

function parseResponse(response: XAIResponsesResponse, resultCap: number): SearchResponse {
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const seenUrls = new Set<string>();

	collectAnnotationSources(response.annotations, sources, citations, seenUrls);
	for (const item of response.output ?? []) {
		collectAnnotationSources(item.annotations, sources, citations, seenUrls);
		for (const part of item.content ?? []) {
			collectAnnotationSources(part.annotations, sources, citations, seenUrls);
		}
	}
	for (const url of response.citations ?? []) {
		addCitationSource(sources, citations, seenUrls, url);
	}
	const limited = applyResultCap(sources, citations, resultCap);

	return {
		provider: "xai",
		answer: parseAnswer(response),
		sources: limited.sources,
		citations: limited.citations.length > 0 ? limited.citations : undefined,
		usage: parseUsage(response.usage),
		model: response.model,
		requestId: response.id,
		authMode: "api_key",
	};
}

/**
 * Prefer `xai-oauth` only when its resolver cannot be shadowed by the shared
 * `XAI_API_KEY` fallback before reaching a lower-priority dedicated source.
 */
function shouldPreferXAIOAuth(authStorage: AuthStorage): boolean {
	if ($env.XAI_OAUTH_TOKEN) return true;

	const origin = authStorage.getCredentialOrigin("xai-oauth");
	if (!origin || origin.kind === "env") return false;
	if ((origin.kind === "api_key" || origin.kind === "fallback") && $env.XAI_API_KEY) return false;
	return true;
}

interface XAIWebSearchAuth {
	provider: XAIHttpProvider;
	keyOrResolver: ApiKey;
}

function resolveXAIWebSearchAuth(params: SearchParams): XAIWebSearchAuth {
	const xaiResolver = params.authStorage.resolver("xai", {
		sessionId: params.sessionId,
	});
	const xaiOAuthOrigin = params.authStorage.getCredentialOrigin("xai-oauth");
	if (!shouldPreferXAIOAuth(params.authStorage)) {
		return { provider: "xai", keyOrResolver: xaiResolver };
	}

	const xaiOAuthResolver = params.authStorage.resolver("xai-oauth", {
		sessionId: params.sessionId,
	});
	const keyOrResolver: ApiKeyResolver = async ctx => {
		const xaiOAuthKey = await xaiOAuthResolver(ctx);
		if (xaiOAuthKey) {
			const borrowedSharedEnvKey =
				xaiOAuthOrigin?.kind === "oauth" &&
				Boolean($env.XAI_API_KEY) &&
				xaiOAuthKey === $env.XAI_API_KEY &&
				xaiOAuthKey !== $env.XAI_OAUTH_TOKEN;
			if (!borrowedSharedEnvKey) return xaiOAuthKey;
		}
		return xaiResolver(ctx);
	};
	return { provider: "xai-oauth", keyOrResolver };
}

/** Execute xAI Responses API web search. */
export async function searchXAI(params: SearchParams): Promise<SearchResponse> {
	const auth = resolveXAIWebSearchAuth(params);
	const transport = params.modelRegistry
		? resolveXAIHttpTransport(params.modelRegistry, auth.provider, XAI_WEB_SEARCH_MODEL)
		: { baseURL: XAI_DEFAULT_BASE_URL };
	const customEndpoint = transport.baseURL.replace(/\/+$/, "") !== XAI_DEFAULT_BASE_URL;
	const credentialOrigin = params.authStorage.getCredentialOrigin(auth.provider);
	if (
		customEndpoint &&
		auth.provider === "xai-oauth" &&
		(credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env")
	) {
		throw new SearchProviderError(
			"xai",
			`拒绝将官方 xAI OAuth 凭据发送到自定义端点 ${transport.baseURL}。请为提供商 "xai-oauth" 配置 API 密钥。`,
		);
	}
	const keyOrResolver: ApiKey = customEndpoint
		? params.authStorage.resolver(auth.provider, { sessionId: params.sessionId })
		: auth.keyOrResolver;

	const resultCap = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await withAuth(keyOrResolver, (key: string) => callXAIResponses(key, params, transport), {
		signal: params.signal,
		missingKeyMessage: '未找到 xAI 凭据。请设置 XAI_API_KEY 或为提供商 "xai" 配置 API 密钥。',
	});
	return parseResponse(response, resultCap);
}

/** Search provider for xAI web search. */
export class XAIProvider extends SearchProvider {
	readonly id = "xai";
	readonly label = "xAI";

	isAvailable(authStorage: AuthStorage): boolean {
		return shouldPreferXAIOAuth(authStorage) || authStorage.hasAuth("xai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchXAI(params);
	}
}
