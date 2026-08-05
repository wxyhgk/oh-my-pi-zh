/**
 * Jina Reader Web Search Provider
 *
 * Uses the Jina Reader `s.jina.ai` endpoint to fetch search results with
 * cleaned content.
 */

import { type AuthStorage, type FetchImpl, getEnvApiKey } from "@wxyhgk/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const JINA_SEARCH_URL = "https://s.jina.ai";
type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

export interface JinaSearchParams {
	query: string;
	num_results?: number;
	/** Single bare host for Jina's `X-Site` in-site search header. */
	site?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

interface JinaSearchResult {
	title?: string | null;
	url?: string | null;
	content?: string | null;
}

type JinaSearchResponse = JinaSearchResult[];

/** Find JINA_API_KEY from environment or .env files. */
export function findApiKey(): string | null {
	return getEnvApiKey("jina") ?? null;
}

/** Call Jina Reader search API. */
async function callJinaSearch(
	apiKey: string,
	query: string,
	site?: string,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
	timeoutMs?: number,
): Promise<JinaSearchResponse> {
	const requestUrl = `${JINA_SEARCH_URL}/${encodeURIComponent(query)}`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
	if (site) headers["X-Site"] = site;
	const response = await fetchImpl(requestUrl, {
		headers,
		signal: withHardTimeout(signal, timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("jina", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("jina", `Jina API 错误(${response.status}): ${errorText}`, response.status);
	}

	const payload = (await response.json()) as { data?: JinaSearchResponse } | null;
	return Array.isArray(payload?.data) ? payload.data : [];
}

/** Execute Jina web search. */
export async function searchJina(params: JinaSearchParams): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new Error("未找到 JINA_API_KEY。请在环境变量或 .env 文件中设置它。");
	}

	const response = await callJinaSearch(
		apiKey,
		params.query,
		params.site,
		params.signal,
		params.fetch,
		params.timeoutMs,
	);
	const sources: SearchSource[] = [];

	for (const result of response) {
		if (!result?.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.content ?? undefined,
		});
	}

	const limitedSources = params.num_results ? sources.slice(0, params.num_results) : sources;

	return {
		provider: "jina",
		sources: limitedSources,
	};
}

/** Search provider for Jina Reader. */
export class JinaProvider extends SearchProvider {
	readonly id = "jina";
	readonly label = "Jina";

	isAvailable(_authStorage: AuthStorage): boolean {
		return !!findApiKey();
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
		let query = params.query;
		let site: string | undefined;
		if (parsed.hasDirectives) {
			// Jina's X-Site header takes a single domain; with exactly one
			// include site, send its host there and strip site: tokens from
			// the query. Multiple sites stay inline (Bing-backed, parses them).
			if (parsed.sites.length === 1) site = parsed.sites[0]!.split("/")[0];
			query = formatQuery(parsed, {
				phrases: true,
				negation: true,
				site: !site,
				inTitle: true,
				inUrl: true,
				filetype: true,
			});
		}

		return searchJina({
			query,
			num_results: params.numSearchResults ?? params.limit,
			site,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			fetch: params.fetch,
		});
	}
}
