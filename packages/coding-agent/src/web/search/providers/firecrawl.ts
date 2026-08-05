/**
 * Firecrawl Web Search Provider
 *
 * Calls Firecrawl's search API and maps web results into the unified
 * SearchResponse shape used by the web search tool.
 */
import {
	type AuthStorage,
	type FetchImpl,
	getEnvApiKey,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	withAuth,
} from "@wxyhgk/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery, type StructuredQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;

const RECENCY_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

export interface FirecrawlSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	/** Explicit `tbs` (custom date range); takes precedence over `recency`. */
	tbs?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface FirecrawlWebResult {
	title?: string | null;
	url?: string | null;
	description?: string | null;
	markdown?: string | null;
}

interface FirecrawlSearchResponse {
	id?: string | null;
	data?: {
		web?: FirecrawlWebResult[] | null;
	} | null;
}

/** Resolve Firecrawl API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("firecrawl", sessionId, { signal });
}

function buildRequestBody(params: FirecrawlSearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		limit: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
		sources: [{ type: "web" }],
	};
	const tbs = params.tbs ?? (params.recency ? RECENCY_TBS[params.recency] : undefined);
	if (tbs) {
		body.tbs = tbs;
	}
	return body;
}

async function callFirecrawlSearch(
	apiKey: string | undefined,
	params: FirecrawlSearchParams,
): Promise<FirecrawlSearchResponse> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const response = await (params.fetch ?? fetch)(FIRECRAWL_SEARCH_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(buildRequestBody(params)),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("firecrawl", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"firecrawl",
			`Firecrawl API 错误(${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as FirecrawlSearchResponse;
}

/** ISO `YYYY-MM-DD` to Google `MM/DD/YYYY` for `tbs=cdr` custom date ranges. */
function toGoogleDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	return `${month}/${day}/${year}`;
}

/**
 * Map explicit `before:`/`after:` bounds to a Firecrawl `tbs` custom date
 * range (`cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY`), or undefined when the
 * query carries no absolute date bounds.
 */
function buildDateTbs(parsed: StructuredQuery): string | undefined {
	if (!parsed.after && !parsed.before) return undefined;
	const parts = ["cdr:1"];
	if (parsed.after) parts.push(`cd_min:${toGoogleDate(parsed.after)}`);
	if (parsed.before) parts.push(`cd_max:${toGoogleDate(parsed.before)}`);
	return parts.join(",");
}

/** Execute Firecrawl web search. */
export async function searchFirecrawl(params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	let query = params.query;
	let tbs: string | undefined;
	if (parsed.hasDirectives) {
		// Firecrawl search is SERP-backed: the query supports Google operators
		// (site:, inurl:, intitle:, quotes, -, OR). Absolute date bounds move to
		// the native tbs param and are stripped from the query string.
		tbs = buildDateTbs(parsed);
		query = formatQuery(parsed, tbs ? { ...GOOGLE_QUERY_SYNTAX, dateRange: false } : GOOGLE_QUERY_SYNTAX);
	}
	const firecrawlParams: FirecrawlSearchParams = {
		query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		tbs,
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		fetch: params.fetch,
	};
	const keyResolver = params.authStorage.resolver("firecrawl", {
		sessionId: params.sessionId,
	});
	const numResults = clampNumResults(firecrawlParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const resolvedKey = await resolveApiKeyOnce(keyResolver, params.signal);
	let data: FirecrawlSearchResponse;
	if (resolvedKey) {
		// Reuse the preflight credential for the initial authenticated attempt.
		const seededResolver = seedApiKeyResolver(resolvedKey, keyResolver);
		data = await withAuth(seededResolver, key => callFirecrawlSearch(key, firecrawlParams), {
			signal: params.signal,
		});
	} else {
		// Keyless mode — omit Authorization header
		data = await callFirecrawlSearch(undefined, firecrawlParams);
	}

	const sources: SearchSource[] = [];

	for (const result of data.data?.web ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.description ?? result.markdown ?? undefined,
		});
	}

	return {
		provider: "firecrawl",
		sources: sources.slice(0, numResults),
		requestId: data.id ?? undefined,
		authMode: resolvedKey ? "api_key" : "keyless",
	};
}

/** Search provider for Firecrawl web search. */
export class FirecrawlProvider extends SearchProvider {
	readonly id = "firecrawl";
	readonly label = "Firecrawl";

	/**
	 * Auto-chain admission: requires a credential so an unconfigured Firecrawl
	 * doesn't displace other providers that the user has set up with API keys.
	 */
	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("firecrawl") || !!getEnvApiKey("firecrawl");
	}

	/**
	 * Firecrawl supports keyless mode, so an explicit user selection
	 * (`webSearch: firecrawl`) works without any credential configured.
	 */
	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchFirecrawl(params);
	}
}
