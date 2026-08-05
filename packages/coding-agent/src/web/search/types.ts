/**
 * Web Search Types
 *
 * Unified types for web search responses across supported providers.
 */

export const SEARCH_PROVIDER_OPTIONS = [
	{
		value: "auto",
		label: "自动",
		description: "自动使用第一个已配置的网页搜索提供商",
	},
	{
		value: "perplexity",
		label: "Perplexity",
		description: "已配置时使用认证;显式选择时回退到匿名搜索",
	},
	{
		value: "gemini",
		label: "Gemini",
		description: "通过 Gemini 使用 Google 搜索 grounding(使用 google-gemini-cli 或 google-antigravity OAuth)",
	},
	{
		value: "anthropic",
		label: "Anthropic",
		description: "Claude 原生 web_search 工具(使用 Anthropic OAuth 或 ANTHROPIC_API_KEY)",
	},
	{
		value: "codex",
		label: "OpenAI",
		description: "OpenAI 原生 web_search(通过 /login openai-codex 使用 ChatGPT OAuth)",
	},
	{
		value: "xai",
		label: "xAI",
		description:
			"通过 xAI Responses API 的 Grok 网页搜索(通过 /login xai-oauth 使用 SuperGrok/X Premium+ OAuth,或使用 XAI_API_KEY)",
	},
	{ value: "zai", label: "Z.AI", description: "调用 Z.AI webSearchPrime MCP" },
	{ value: "exa", label: "Exa", description: "通过 /login exa 或 EXA_API_KEY 使用 API;显式选择时通过 MCP 无密钥回退" },
	{ value: "tinyfish", label: "TinyFish", description: "需要 TINYFISH_API_KEY" },
	{ value: "jina", label: "Jina", description: "需要 JINA_API_KEY" },
	{ value: "kagi", label: "Kagi", description: "需要 KAGI_API_KEY 与 Kagi Search API beta 访问权限" },
	{ value: "tavily", label: "Tavily", description: "需要 TAVILY_API_KEY" },
	{
		value: "firecrawl",
		label: "Firecrawl",
		description: "设置 FIRECRAWL_API_KEY 时使用 Firecrawl API;否则回退到无密钥模式",
	},
	{ value: "brave", label: "Brave", description: "需要 BRAVE_API_KEY" },
	{
		value: "kimi",
		label: "Kimi",
		description:
			"Kimi Code 搜索(通过 KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY 或 /login kimi-code 需要 Kimi Code Console 密钥;不接受 MOONSHOT_API_KEY)",
	},
	{ value: "parallel", label: "Parallel", description: "需要 PARALLEL_API_KEY" },
	{ value: "synthetic", label: "Synthetic", description: "需要 SYNTHETIC_API_KEY" },
	{ value: "searxng", label: "SearXNG", description: "需要 SEARXNG_ENDPOINT 或 searxng.endpoint" },
	{
		value: "startpage",
		label: "Startpage",
		description: "免凭据抓取 Startpage(Google 支持)结果;可能遭遇机器人验证挑战",
	},
	{
		value: "duckduckgo",
		label: "DuckDuckGo",
		description: "免凭据的尽力而为回退;在数据中心/共享出口 IP 上可能遭遇机器人验证挑战",
	},
	{
		value: "ecosia",
		label: "Ecosia",
		description: "免凭据、浏览器支持的 Ecosia(Google 支持)结果抓取",
	},
	{
		value: "google",
		label: "Google",
		description: "免凭据、浏览器支持的回退;较慢且可能遭遇机器人验证挑战",
	},
	{
		value: "mojeek",
		label: "Mojeek",
		description: "免凭据、浏览器支持的 Mojeek 独立索引抓取",
	},
	{
		value: "public",
		label: "公共网页",
		description: "并行查询所有免凭据引擎并合并去重结果",
	},
] as const;

/** Default hard timeout for each web-search provider transport. */
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 60;

/** Maximum configurable hard timeout for each web-search provider transport. */
export const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300;

/** Supported web search providers (every option except `auto`). */
export type SearchProviderId = Exclude<(typeof SEARCH_PROVIDER_OPTIONS)[number]["value"], "auto">;

/**
 * Auto-resolution priority order. Derived from {@link SEARCH_PROVIDER_OPTIONS}
 * (minus `auto`) so the settings/setup dropdown and `resolveProviderChain()`
 * share one source of truth and never drift apart.
 */
export const SEARCH_PROVIDER_ORDER: readonly SearchProviderId[] = SEARCH_PROVIDER_OPTIONS.flatMap(option =>
	option.value === "auto" ? [] : [option.value],
);

/** Concrete provider choices (no `auto` sentinel) — for list-valued settings like order/exclude. */
export const SEARCH_PROVIDER_CHOICES = SEARCH_PROVIDER_OPTIONS.filter(option => option.value !== "auto");

export const SEARCH_PROVIDER_PREFERENCES = ["auto", ...SEARCH_PROVIDER_ORDER] as const;

/** Display labels, derived from {@link SEARCH_PROVIDER_OPTIONS}. */
export const SEARCH_PROVIDER_LABELS = Object.fromEntries(
	SEARCH_PROVIDER_OPTIONS.flatMap(option => (option.value === "auto" ? [] : [[option.value, option.label] as const])),
) as Record<SearchProviderId, string>;

export function isSearchProviderId(value: string): value is SearchProviderId {
	return SEARCH_PROVIDER_ORDER.includes(value as SearchProviderId);
}

export function isSearchProviderPreference(value: string): value is SearchProviderId | "auto" {
	return SEARCH_PROVIDER_PREFERENCES.includes(value as SearchProviderId | "auto");
}

/** Source returned by search (all providers) */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

/** Citation with text reference (LLM-mediated providers) */
export interface SearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

/** Usage metrics */
export interface SearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** Anthropic: number of web search requests made */
	searchRequests?: number;
	/** Perplexity: combined token count */
	totalTokens?: number;
}

/** Unified response across providers */
export interface SearchResponse {
	provider: SearchProviderId | "none";
	/** Synthesized answer text (LLM-mediated providers) */
	answer?: string;
	/** Search result sources */
	sources: SearchSource[];
	/** Text citations with context */
	citations?: SearchCitation[];
	/** Intermediate search queries (anthropic) */
	searchQueries?: string[];
	/** Follow-up question suggestions (provider-dependent) */
	relatedQuestions?: string[];
	/** Token usage metrics */
	usage?: SearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
	/** Authentication mode used by the provider (e.g. oauth, api-key) */
	authMode?: string;
}

/** Provider-specific error with optional HTTP status */
export class SearchProviderError extends Error {
	constructor(
		public readonly provider: SearchProviderId,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "SearchProviderError";
	}
}

/** Anthropic API response types */
export interface AnthropicSearchResult {
	type: "web_search_result";
	title: string;
	url: string;
	encrypted_content: string;
	page_age: string | null;
}

export interface AnthropicCitation {
	type: "web_search_result_location";
	url: string;
	title: string;
	cited_text: string;
	encrypted_index: string;
}

export interface AnthropicContentBlock {
	type: string;
	/** Text content (for type="text") */
	text?: string;
	/** Citations in text block */
	citations?: AnthropicCitation[];
	/** Tool name (for type="server_tool_use") */
	name?: string;
	/** Tool input (for type="server_tool_use") */
	input?: { query: string };
	/** Search results (for type="web_search_tool_result") */
	content?: AnthropicSearchResult[];
}

export interface AnthropicApiResponse {
	id: string;
	model: string;
	content: AnthropicContentBlock[];
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		server_tool_use?: { web_search_requests: number };
	};
}

/** Perplexity API types */
export type PerplexityChatMessageRole = "system" | "user" | "assistant" | "tool";

export interface PerplexityUrl {
	url: string;
}

export interface PerplexityVideoUrl {
	url: string;
	frame_interval?: string | number;
}

export interface PerplexityContentTextChunk {
	type: "text";
	text: string;
}

export interface PerplexityContentImageChunk {
	type: "image_url";
	image_url: PerplexityUrl | string;
}

export interface PerplexityContentFileChunk {
	type: "file_url";
	file_url: PerplexityUrl | string;
	file_name?: string | null;
}

export interface PerplexityContentPdfChunk {
	type: "pdf_url";
	pdf_url: PerplexityUrl | string;
}

export interface PerplexityContentVideoChunk {
	type: "video_url";
	video_url: PerplexityVideoUrl | string;
}

export type PerplexityContentChunk =
	| PerplexityContentTextChunk
	| PerplexityContentImageChunk
	| PerplexityContentFileChunk
	| PerplexityContentPdfChunk
	| PerplexityContentVideoChunk;

export interface PerplexitySearchStepDetails {
	search_results: PerplexitySearchResult[];
	search_keywords: string[];
}

export interface PerplexityFetchUrlContentStepDetails {
	contents: PerplexitySearchResult[];
}

export interface PerplexityExecutePythonStepDetails {
	code: string;
	result: string;
}

export interface PerplexityReasoningStepInput {
	thought: string;
	type?: string | null;
	web_search?: PerplexitySearchStepDetails | null;
	fetch_url_content?: PerplexityFetchUrlContentStepDetails | null;
	execute_python?: PerplexityExecutePythonStepDetails | null;
}

export interface PerplexityReasoningStepOutput {
	thought: string;
	type?: string | null;
	web_search?: PerplexitySearchStepDetails | null;
	fetch_url_content?: PerplexityFetchUrlContentStepDetails | null;
	execute_python?: PerplexityExecutePythonStepDetails | null;
}

export interface PerplexityToolCallFunction {
	name?: string | null;
	arguments?: string | null;
}

export interface PerplexityToolCall {
	id?: string | null;
	type?: "function" | null;
	function?: PerplexityToolCallFunction | null;
}

export interface PerplexityMessageInput {
	role: PerplexityChatMessageRole;
	content: string | PerplexityContentChunk[] | null;
	reasoning_steps?: PerplexityReasoningStepInput[] | null;
	tool_calls?: PerplexityToolCall[] | null;
	tool_call_id?: string | null;
}

export interface PerplexityMessageOutput {
	role: PerplexityChatMessageRole;
	content: string | PerplexityContentChunk[] | null;
	reasoning_steps?: PerplexityReasoningStepOutput[] | null;
	tool_calls?: PerplexityToolCall[] | null;
	tool_call_id?: string | null;
}

export type PerplexityMessage = PerplexityMessageInput;

export interface PerplexityResponseFormatText {
	type: "text";
}

export interface PerplexityJSONSchema {
	schema: Record<string, unknown>;
	name?: string | null;
	description?: string | null;
	strict?: boolean | null;
}

export interface PerplexityResponseFormatJSONSchema {
	type: "json_schema";
	json_schema: PerplexityJSONSchema;
}

export interface PerplexityRegexSchema {
	regex: string;
	name?: string | null;
	description?: string | null;
	strict?: boolean | null;
}

export interface PerplexityResponseFormatRegex {
	type: "regex";
	regex: PerplexityRegexSchema;
}

export type PerplexityResponseFormat =
	| PerplexityResponseFormatText
	| PerplexityResponseFormatJSONSchema
	| PerplexityResponseFormatRegex;

export interface PerplexityParameterSpec {
	type: string;
	properties: Record<string, unknown>;
	required?: string[] | null;
	additional_properties?: boolean | null;
}

export interface PerplexityFunctionSpec {
	name: string;
	description: string;
	parameters: PerplexityParameterSpec;
	strict?: boolean | null;
}

export interface PerplexityToolSpec {
	type: "function";
	function: PerplexityFunctionSpec;
}

export interface PerplexityUserLocation {
	latitude?: number | null;
	longitude?: number | null;
	country?: string | null;
	city?: string | null;
	region?: string | null;
}

export interface PerplexitySearchOptions {
	search_context_size?: "low" | "medium" | "high";
	search_type?: "fast" | "pro" | "auto" | null;
	user_location?: PerplexityUserLocation | null;
	image_results_enhanced_relevance?: boolean;
}

export interface PerplexityRequest {
	max_tokens?: number | null;
	temperature?: number | null;
	n?: number | null;
	model: string;
	stream?: boolean | null;
	stop?: string | string[] | null;
	cum_logprobs?: boolean | null;
	logprobs?: boolean | null;
	top_logprobs?: number | null;
	best_of?: number | null;
	response_metadata?: Record<string, unknown> | null;
	response_format?: PerplexityResponseFormat | null;
	diverse_first_token?: boolean | null;
	_inputs?: number[] | null;
	_prompt_token_length?: number | null;
	messages: PerplexityMessageInput[];
	tools?: PerplexityToolSpec[] | null;
	tool_choice?: "none" | "auto" | "required" | null;
	parallel_tool_calls?: boolean | null;
	web_search_options?: PerplexitySearchOptions;
	search_mode?: "web" | "academic" | "sec" | null;
	return_images?: boolean | null;
	return_related_questions?: boolean | null;
	num_search_results?: number;
	num_images?: number;
	enable_search_classifier?: boolean | null;
	disable_search?: boolean | null;
	search_domain_filter?: string[] | null;
	search_language_filter?: string[] | null;
	search_tenant?: string | null;
	ranking_model?: string | null;
	latitude?: number | null;
	longitude?: number | null;
	country?: string | null;
	search_recency_filter?: "hour" | "day" | "week" | "month" | "year" | null;
	search_after_date_filter?: string | null;
	search_before_date_filter?: string | null;
	last_updated_before_filter?: string | null;
	last_updated_after_filter?: string | null;
	image_format_filter?: string[] | null;
	image_domain_filter?: string[] | null;
	safe_search?: boolean | null;
	file_workspace_id?: string | null;
	updated_before_timestamp?: number | null;
	updated_after_timestamp?: number | null;
	search_internal_properties?: Record<string, unknown> | null;
	use_threads?: boolean | null;
	thread_id?: string | null;
	stream_mode?: "full" | "concise";
	_debug_pro_search?: boolean;
	has_image_url?: boolean;
	reasoning_effort?: "minimal" | "low" | "medium" | "high" | null;
	language_preference?: string | null;
	user_original_query?: string | null;
	_force_new_agent?: boolean | null;
}

export interface PerplexitySearchResult {
	title: string;
	url: string;
	date?: string | null;
	last_updated?: string | null;
	snippet?: string;
	source?: "web" | "attachment";
}

export interface PerplexityCost {
	input_tokens_cost: number;
	output_tokens_cost: number;
	reasoning_tokens_cost?: number | null;
	request_cost?: number | null;
	citation_tokens_cost?: number | null;
	search_queries_cost?: number | null;
	total_cost: number;
}

export interface PerplexityUsageInfo {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	search_context_size?: string | null;
	citation_tokens?: number | null;
	num_search_queries?: number | null;
	reasoning_tokens?: number | null;
	cost: PerplexityCost;
}

export type PerplexityCompletionResponseType = "message" | "info" | "end_of_stream";

export type PerplexityCompletionResponseStatus = "PENDING" | "COMPLETED";

export interface PerplexityChoice {
	index: number;
	finish_reason?: "stop" | "length" | null;
	message: PerplexityMessageOutput;
	delta: PerplexityMessageOutput;
}

export interface PerplexityResponse {
	id: string;
	model: string;
	created: number;
	usage?: PerplexityUsageInfo | null;
	object?: string;
	choices: PerplexityChoice[];
	citations?: string[] | null;
	search_results?: PerplexitySearchResult[] | null;
	related_questions?: string[] | null;
	type?: PerplexityCompletionResponseType | null;
	status?: PerplexityCompletionResponseStatus | null;
}
