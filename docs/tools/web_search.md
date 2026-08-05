# web_search

> 通过第一个可用的搜索提供商运行一次网络查询,并返回 LLM 格式的答案、来源 URL 以及可选的引用。

## 来源
- 入口:`packages/coding-agent/src/web/search/index.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/web-search.md`
- 主要协作模块:
  - `packages/coding-agent/src/web/search/provider.ts` — 惰性提供商注册表;可用性链。
  - `packages/coding-agent/src/web/search/types.ts` — 统一的 `SearchResponse` / `SearchProviderError` 类型。
  - `packages/coding-agent/src/web/search/render.ts` — TUI 渲染器详情类型。
  - `packages/coding-agent/src/web/search/providers/base.ts` — 提供商接口与共享参数契约。
  - `packages/coding-agent/src/web/search/providers/utils.ts` — 凭据查找;来源规范化。
  - `packages/coding-agent/src/web/search/providers/browser-headers.ts` — 供抓取型提供商使用的共享 Chromium 导航请求头。
  - `packages/coding-agent/src/web/search/query.ts` — Google 风格查询解析、提供商语法格式化以及宽松的结果筛选。
  - `packages/coding-agent/src/web/search/providers/browser-page.ts` — 供抓取型提供商使用的共享 fetch/无头浏览器页面加载器。
  - `packages/coding-agent/src/web/search/providers/anthropic.ts` — Claude 网络搜索提供商。
  - `packages/coding-agent/src/web/search/providers/brave.ts` — Brave Search API 适配器。
  - `packages/coding-agent/src/web/search/providers/codex.ts` — OpenAI Codex SSE 适配器。
  - `packages/coding-agent/src/web/search/providers/duckduckgo.ts` — DuckDuckGo HTML 前端抓取器。
  - `packages/coding-agent/src/web/search/providers/ecosia.ts` — Ecosia 浏览器驱动抓取器。
  - `packages/coding-agent/src/web/search/providers/exa.ts` — Exa API 或 MCP 适配器。
  - `packages/coding-agent/src/web/search/providers/firecrawl.ts` — Firecrawl 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/gemini.ts` — Gemini grounding SSE 适配器。
  - `packages/coding-agent/src/web/search/providers/google.ts` — Google 浏览器驱动 SERP 抓取器。
  - `packages/coding-agent/src/web/search/providers/jina.ts` — Jina Reader 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/kagi.ts` — Kagi 提供商封装。
  - `packages/coding-agent/src/web/search/providers/kimi.ts` — Kimi 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/mojeek.ts` — Mojeek 浏览器驱动抓取器(独立索引)。
  - `packages/coding-agent/src/web/search/providers/parallel.ts` — Parallel 提供商封装。
  - `packages/coding-agent/src/web/search/providers/perplexity.ts` — Perplexity API / OAuth 适配器。
  - `packages/coding-agent/src/web/search/providers/public.ts` — 对所有免凭据引擎的聚合(Public Web)。
  - `packages/coding-agent/src/web/search/providers/searxng.ts` — 自托管 SearXNG 适配器。
  - `packages/coding-agent/src/web/search/providers/startpage.ts` — Startpage(Google 代理)表单流程抓取器。
  - `packages/coding-agent/src/web/search/providers/synthetic.ts` — 合成搜索适配器。
  - `packages/coding-agent/src/web/search/providers/tavily.ts` — Tavily 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/tinyfish.ts` — TinyFish 搜索适配器。
  - `packages/coding-agent/src/web/search/providers/xai.ts` — xAI Responses 网络搜索适配器。
  - `packages/coding-agent/src/web/search/providers/zai.ts` — Z.AI 远程 MCP 适配器。
  - `packages/coding-agent/src/web/parallel.ts` — 并行搜索/提取 HTTP 客户端。
  - `packages/coding-agent/src/web/kagi.ts` — Kagi HTTP 客户端。
  - `packages/coding-agent/src/tools/index.ts` — 内置工具注册与启用开关。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `query` | `string` | 是 | 原始查询。编排器会解析 Google 风格指令(`site:`/`-site:`、`after:`/`before:`、`inurl:`、`intitle:`、`filetype:`、带引号的短语、排除项以及 `OR`),以便提供商映射到原生筛选器或受支持的语法;原始字符串仍会提供给适配器。 |
| `recency` | `"day" \| "week" \| "month" \| "year"` | 否 | 相对时间筛选。由 Brave、Perplexity、Tavily、SearXNG、Kagi、TinyFish、Firecrawl、DuckDuckGo、Startpage、Google 和 Mojeek 实现;其他适配器会忽略它。 |
| `limit` | `number` | 否 | 要返回的最大结果数。通常当缺少 `num_search_results` 时,会成为提供商请求的结果数参数。TinyFish 在切片前用它进行分页抓取。xAI 仅将合并后的值作为解析来源/引用的本地上限,默认为 `10`,最大 `30`。 |
| `max_tokens` | `number` | 否 | 仅由 Anthropic、Gemini、xAI 和 Perplexity API 密钥模式作为提供商的 token 上限(`maxOutputTokens`、`max_tokens` 或 xAI 的 `max_output_tokens`)传递。其他提供商忽略它。 |
| `temperature` | `number` | 否 | 仅由支持采样参数的 Anthropic 模型、Gemini、xAI 和 Perplexity API 密钥模式传递。其他提供商/模型路径会忽略或省略它。 |
| `num_search_results` | `number` | 否 | 请求的搜索广度或本地结果上限。大多数提供商会将其发送给上游。TinyFish 将其限制在 `1..20`,默认 `10`,按页作为 `num_results` 发送,并在切片前分页。xAI 在 `limit` 之前将其用作本地解析结果上限,默认为 `10`,最大 `30`;当前的 Responses `web_search` 工具没有上游结果数字段。 |

## 输出
该工具返回单个文本内容块以及结构化的 `details`。

- `content`: `[{ type: "text", text: string }]`
- `details`: 来自 `packages/coding-agent/src/web/search/render.ts` 的 `SearchRenderDetails`
  - `response: SearchResponse`
  - `error?: string`

`text` 由 `packages/coding-agent/src/web/search/index.ts` 中的 `formatForLLM()` 生成。关于放宽查询约束的说明会首先输出:

- 如果存在 `response.answer`,则首先输出。
- 如果存在来源,则每个来源输出一条(仅当同时生成了答案时才输出带来源数量的 `## Sources` 标题):
  - `[n] <title> (<formatted age or published date>)`
  - `    <url>`
  - 可选的摘要行,截断至 240 个字符。
- 如果存在引用,则随后输出 `## Citations` 部分,包含 URL/标题以及截断至 240 个字符的可选引用文本。
- 如果存在相关问题,则随后输出 `## Related` 项目符号列表。
- 如果存在搜索查询,则输出 `Search queries: <n>` 部分,上限为前 3 个查询,每个 120 个字符。

当提供商不可用或提供商尝试失败时,失败输出不会在工具边界抛出。相反,工具会返回:

- `content[0].text = "Error: ..."`
- `details.response.provider = <last attempted provider> | "none"`
- `details.error = ...`

流式:无。`WebSearchTool.execute()` 将其 `AbortSignal` 转发给 `executeSearch()`,而 `executeSearch()` 将其传递给提供商。如果在回退处理期间信号被中止,`throwIfAborted(signal)` 会重新抛出取消,而不是返回 `"Error: ..."` 文本结果。

每个提供商搜索传输都会收到来自 `providers.webSearchTimeoutSeconds` 的硬超时(默认 `60`,最大 `300`)。当该传输超过上限时,自动链会记录提供商失败并前进到下一个候选。该设置不是整条链的截止时间,提供商可能施加更短的上游、重试或聚合限制。请设置一个正数的秒数,例如 `omp config set providers.webSearchTimeoutSeconds 180`,用于较慢的模型驱动搜索。

## 流程
1. `packages/coding-agent/src/web/search/index.ts` 中的 `WebSearchTool.execute()` 直接委托给 `executeSearch()`。
2. `executeSearch()` 用 `parseSearchQuery()` 解析一次 `query`,然后计算有序的提供商候选,而不急切加载它们的模块:
   - 如果内部 `params.provider` 已设置且不是 `"auto"`,则该提供商是唯一候选,并被视为显式;
   - 否则使用配置的候选顺序。显式列在 `providers.webSearchOrder` 中的条目使用 `isExplicitlyAvailable()`;普通回退条目使用 `isAvailable()`。
3. `resolveProviderCandidates()` 优先处理来自 `providers.webSearchOrder` 的有效首次出现 ID,然后按 `SEARCH_PROVIDER_ORDER` 追加未列出的提供商。空列表保留内置顺序。`providers.webSearchExclude` 从自动/配置链以及 Public Web 扇出中移除提供商。内部按请求强制指定的提供商绕过该配置链。
4. 如果没有可用候选(例如,设置排除了所有免凭据引擎且未配置任何带密钥/OAuth 的提供商),`executeSearch()` 返回 `Error: No web search provider configured.`,且 `details.response.provider = "none"`。
5. 按顺序对每个提供商,`executeSearch()` 调用 `provider.search()`,参数为:
   - `query`,
   - `limit`、`recency`、`temperature`、`maxOutputTokens`、`numSearchResults`,
   - 由 `providers.webSearchTimeoutSeconds` 推导的 `timeoutMs`,
   - 来自 `packages/coding-agent/src/prompts/system/web-search.md` 的 `systemPrompt`,
   - 解析后的结构化查询,包括已识别的指令以及日期/域名/标题/URL/文件类型约束。
6. 提供商响应后,`applyQueryConstraints()` 对其来源进行宽松的后置筛选,以处理上游不保证的约束。它依次应用每个可筛选维度;任何会消除所有剩余结果的维度都会被放宽,并输出以 `Note: no results matched ...` 开头的说明。答案/引用文本不会被重写。
7. 没有可渲染内容(`hasRenderableSearchContent()` 返回 false)的 `SearchResponse` 会被作为 `SearchProviderError`(状态 `204`)拒绝,以便循环前进到下一个提供商。在第一个可渲染响应上,`formatForLLM()` 将说明、答案、来源、引用、相关问题以及搜索查询渲染为一个文本块。
8. 如果提供商抛出异常,`executeSearch()` 记录该错误并尝试下一个提供商。没有提供商级别的并行扇出;回退是顺序的。
9. 在所有候选都失败后,`formatSearchProviderFailure()` 规范化每个错误:
   - Anthropic 的 `404` 变为 `Anthropic web search returned 404 (model or endpoint not found).`
   - `401`/`403` 变为 `<Provider> authorization failed ...`,但 Z.AI 除外,它保留其原始消息。
   - 其他 `SearchProviderError` 透出 `error.message`。
10. 如果有多个提供商失败,最终消息为 `All web search providers failed: <provider/error>; ...`;否则就是规范化后的最后一个错误。

## 模式 / 变体
- **提供商选择**
  - **强制提供商**:内部调用方可以传入 `provider`;非 `auto` 值是唯一尝试的提供商,并使用 `isExplicitlyAvailable()`,而 `auto`(或省略)则走配置链。该字段不在面向模型的 schema 中。
  - **配置顺序**:`setSearchProviderOrder()` 优先处理 `providers.webSearchOrder` 中有效且首次出现的提供商 ID;未列出的提供商按内置相对顺序跟随。列出的提供商是显式选择,通过 `isExplicitlyAvailable()` 解析,因此 Perplexity、Exa 和 Firecrawl 可以使用它们的未认证/无密钥路径。
  - **排除的提供商**:`setExcludedSearchProviders()` 从自动/配置链以及 Public Web 扇出中移除提供商。通过 `packages/coding-agent/src/config/provider-globals.ts` 从 `providers.webSearchExclude` 接入。
  - **默认自动链顺序**(23 个提供商):`perplexity`, `gemini`, `anthropic`, `codex`, `xai`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, `startpage`, `duckduckgo`, `ecosia`, `google`, `mojeek`, `public`(`packages/coding-agent/src/web/search/types.ts` 中的 `SEARCH_PROVIDER_ORDER`)。`public` 仅限显式:其 `isAvailable()` 返回 `false`,因此自动链永远不会隐式扇出到它。
- **提供商超时**:`providers.webSearchTimeoutSeconds` 为每个提供商的搜索传输提供硬上限,之后自动链前进。默认为 `60`;无效的非正数值回退到该默认值,超过 `300` 的值会被封顶,而提供商特定的上游或聚合限制可能仍然更短。
- **提供商适配器**
  - **Perplexity** — `packages/coding-agent/src/web/search/providers/perplexity.ts`
    - 可用性:认证尝试顺序为 `PERPLEXITY_COOKIES` -> `agent.db` 中的 OAuth token -> 直接 Perplexity API 密钥 -> OpenRouter 密钥 -> 匿名 ask 端点回退。自动链要求直接 Perplexity 认证(cookies、OAuth 或 Perplexity 凭据);显式选择始终可用,可以使用 OpenRouter 或匿名搜索。
    - OAuth/cookie/匿名模式:POST 到 `https://www.perplexity.ai/rest/sse/perplexity_ask`,消费 SSE,合并部分事件,提取答案和来源 URL,设置 `authMode: "oauth"`(未认证回退为 `"anonymous"`)。
    - API 密钥模式:POST 到 `https://api.perplexity.ai/chat/completions`,参数为 `model: "sonar-pro"`、`search_mode: "web"`、`num_search_results`、可选的 `search_recency_filter`、`max_tokens`、`temperature`。
    - `num_search_results` 仅在 API 密钥模式下控制上游 API 的广度。`limit` 在两种认证模式下都单独保留为 `num_results`,并在解析后对返回的 `sources` 进行切片。
    - 输出可能包含 `answer`、`sources`、`citations`、`usage`、`model`、`requestId`、`authMode`。
  - **Gemini** — `packages/coding-agent/src/web/search/providers/gemini.ts`
    - 可用性:`agent.db` 中 `google-gemini-cli` / `google-antigravity` 的 OAuth 凭据,或 Google Developer API 密钥。
    - 查询:启用 Google Search grounding 的 SSE `streamGenerateContent` 调用。Antigravity 认证尝试两个回退端点,并在 token 刷新后重试一次 `401/403/400 invalid auth`;`429/5xx` 以指数退避和服务器提供的重试延迟重试,由 `5 * 60 * 1000` ms 的限流预算封顶。
    - 模型:`providers.webSearchGeminiModel` 选择 Gemini grounding 模型;`GEMINI_SEARCH_MODEL` 覆盖它。默认为 `gemini-2.5-flash`。
    - `max_tokens` 和 `temperature` 作为 `generationConfig.maxOutputTokens` / `generationConfig.temperature` 传递。
    - `limit` 和 `num_search_results` 在分发前合并在一起。
    - 输出可能包含 `answer`、`sources`、`citations`、`searchQueries`、`usage`、`model`。
  - **Anthropic** — `packages/coding-agent/src/web/search/providers/anthropic.ts`
    - 可用性:`ANTHROPIC_SEARCH_API_KEY` 环境变量,否则 `authStorage.hasAuth("anthropic")`;当没有设置搜索专用密钥时,搜索凭据来自 `authStorage.getApiKey("anthropic")`。
    - 搜索专用的环境变量覆盖(不影响聊天补全):
      - `ANTHROPIC_SEARCH_API_KEY` — 最高优先级的搜索认证;仅对搜索调用覆盖 `ANTHROPIC_API_KEY` / OAuth / `ANTHROPIC_FOUNDRY_API_KEY`。
      - `ANTHROPIC_SEARCH_BASE_URL` — 仅搜索的基础 URL,用于 `ANTHROPIC_SEARCH_API_KEY` 或回退的 Anthropic 凭据;覆盖 `ANTHROPIC_BASE_URL`(Foundry 模式下还有 `FOUNDRY_BASE_URL`);默认为 `https://api.anthropic.com`。
      - `ANTHROPIC_SEARCH_MODEL` — 搜索模型;默认为 `claude-haiku-4-5`。
    - 查询:启用 web-search 工具的 Claude Messages API。
    - `max_tokens` 会传递。`temperature` 仅对支持采样参数的模型传递;对于 Opus 4.7+、Sonnet 5+ 和 Fable/Mythos 5+ 会被省略,因为这些 API 拒绝采样参数。
    - `limit` 和 `num_search_results` 在分发前合并在一起:`num_results = params.numSearchResults ?? params.limit`。
    - 输出可能包含 `answer`、`sources`、`citations`、`searchQueries`、`usage.searchRequests`、`model`、`requestId`。
  - **Codex** — `packages/coding-agent/src/web/search/providers/codex.ts`
    - 可用性:`agent.db` 中 `openai-codex` 的 OAuth 凭据;在搜索期间惰性刷新。自定义模型注册表端点可以改用配置的 API 密钥/命令凭据,但官方 OAuth/环境凭据会被自定义端点拒绝。
    - 查询:使用托管的 `web_search` 和 `search_context_size: "high"` 流式传输 Codex Responses 端点。Google 风格指令会在查询中重新输出。
    - `PI_CODEX_WEB_SEARCH_MODEL` 强制一次模型尝试。否则适配器按优先顺序尝试内置的 ChatGPT 账户安全模型(`gpt-5.6-luna`、`terra`、`sol`、`gpt-5.5`、…),仅对受支持的模型重试失败前进。Responses-Lite 模型使用自动工具选择;没有 `web_search_call` 的补全会被拒绝,而不是作为已搜索内容呈现。
    - 忽略 `recency`、`max_tokens` 和 `temperature`。`num_search_results ?? limit` 在本地切片解析出的来源。
    - 输出可能包含 `answer`、`sources`、`usage`、`model`、`requestId`。如果流没有 `url_citation` 注解,适配器回退到答案中的 markdown 链接和裸 URL。
  - **xAI** — `packages/coding-agent/src/web/search/providers/xai.ts`
    - 可用性:共享认证策略偏好时的 xAI OAuth,或 `xai` 凭据,如 `XAI_API_KEY`。
    - 查询:POST Responses API,模型 `grok-4.5`,`tools: [{ type: "web_search", ... }]`,推理强度 `low`。支持自定义模型注册表端点,但官方 xAI OAuth 凭据会被自定义端点拒绝。
    - 最多五个 `site:` 或 `-site:` 主机映射到互斥的 `allowed_domains` / `excluded_domains` 筛选器(允许列表优先);路径限制保留给中央筛选。绝对日期保留为查询提示,因为当前的 Responses `web_search` 工具没有日期字段。
    - `max_tokens` 和 `temperature` 会传递。`num_search_results`(或 `limit`)仅在本地限制解析的来源/引用,默认 `10`,最大 `30`;它不会作为上游搜索计数参数发送。
    - 输出可能包含 `answer`、`sources`、`citations`、`usage`、`model`、`requestId`、`authMode: "api_key"`。
  - **Z.AI** — `packages/coding-agent/src/web/search/providers/zai.ts`
    - 可用性:`zai` 的环境变量或 `agent.db` 凭据。
    - 查询:针对远程 MCP 工具 `web_search_prime`,JSON-RPC `tools/call` 到 `https://api.z.ai/api/mcp/web_search_prime/mcp`。
    - 提供商内部的回退链:当较早尝试以参数形状错误失败时,依次尝试 `{query,count}`、`{search_query,count}`、`{search_query, search_engine:"search-prime", count}`。
    - `limit` 和 `num_search_results` 在分发前合并在一起。
    - 输出可能包含解析后的自由文本 `answer`、`sources`、`requestId`。
  - **Exa** — `packages/coding-agent/src/web/search/providers/exa.ts`
    - 可用性:`EXA_API_KEY` 或 `exa` 的存储凭据(包括通过 `/login exa` 添加的)允许 Exa 进入自动链;设置不得显式禁用 `exa.enabled` 或 `exa.enableSearch`。显式选择(在 `providers.webSearchOrder` 中列出 `exa`,或强制 `provider: exa`)即使没有凭据也能到达 Exa,并回退到公共 MCP。
    - 查询:使用解析出的 Exa API 密钥 POST `https://api.exa.ai/search`,否则针对远程 MCP 工具 `web_search_exa` 进行 JSON-RPC `tools/call` 到 `https://mcp.exa.ai/mcp`。
    - `limit` 和 `num_search_results` 在分发前合并在一起。
    - 输出:由最多 3 个结果摘要综合的 `answer`、`sources`、`requestId`。
  - **TinyFish** — `packages/coding-agent/src/web/search/providers/tinyfish.ts`
    - 可用性:`TINYFISH_API_KEY` 或 `tinyfish` 的 `agent.db` 凭据。
    - 查询:GET `https://api.search.tinyfish.ai`,带 `X-API-Key` 和 `query`;`recency` 映射到 `recency_minutes`。
    - `limit` / `num_search_results`:合并为 `params.numSearchResults ?? params.limit`,限制在 `1..20`,默认 `10`。TinyFish 没有计数参数,每页最多返回 10 个结果;对于超过第一页的计数,适配器在本地切片前抓取文档化的 `page` 值(`0`,需要时再 `1`)。输出 `sources`、`authMode: "api_key"`。
  - **Jina** — `packages/coding-agent/src/web/search/providers/jina.ts`
    - 可用性:仅 `JINA_API_KEY`。
    - 查询:对 `https://s.jina.ai/<encoded query>` 的类 GET 抓取,带 bearer 认证。
    - 忽略 `recency`、`max_tokens` 和 `temperature`。
    - `limit` / `num_search_results`:适配器在提供时将来源切片为 `params.numSearchResults ?? params.limit`;否则返回所有负载条目。
    - 输出:仅 `sources`。
  - **Kagi** — `packages/coding-agent/src/web/search/providers/kagi.ts`、`packages/coding-agent/src/web/kagi.ts`
    - 可用性:`kagi` 的环境变量或 `agent.db` 凭据。
    - 查询:POST `https://kagi.com/api/v1/search`,带 `Authorization: Bearer <key>` 和 JSON 主体 `{ query, workflow: "search", limit, filters?: { after } }`。`recency` 映射到 `filters.after`,作为 UTC `YYYY-MM-DD` 字符串(`day`/`week`/`month`/`year`)。
    - `limit` 和 `num_search_results` 在分发前合并在一起,限制在 `1..40`,默认 `10`。
    - 输出:`sources`(`data.search` + `data.video` + `data.news` + `data.infobox` 的拼接,视频/新闻/信息框结果在标题中标记)、`relatedQuestions`(`data.adjacent_question` + `data.related_search` `props.question`)、`answer`(`data.direct_answer[0].snippet ?? title`)、`requestId`(`meta.trace`)。
  - **Tavily** — `packages/coding-agent/src/web/search/providers/tavily.ts`
    - 可用性:通过 `findCredential()` 从环境变量或 `agent.db` 获取 API 密钥。
    - 查询:POST `https://api.tavily.com/search`。
    - `recency` 映射到 Tavily 的 `time_range`;代码明确将 `topic` 保持在默认的一般范围,而不是收窄到新闻。
    - `limit` / `num_search_results`:适配器使用 `params.numSearchResults ?? params.limit`,限制在 `5..20`,默认 `5`。
    - 输出:`answer`、`sources`、`requestId`、`authMode: "api_key"`。
  - **Firecrawl** — `packages/coding-agent/src/web/search/providers/firecrawl.ts`
    - 可用性:凭据允许它进入自动链;显式/配置的选择始终可用,并在没有解析出凭据时使用无密钥模式。
    - 查询:POST `https://api.firecrawl.dev/v2/search`,带 `sources: [{ type: "web" }]`。Google 风格操作符被格式化为查询;`recency` 和解析出的绝对日期映射到 `tbs`。
    - `limit` / `num_search_results`:合并并限制在 `1..100`,默认 `10`;输出 `sources`、`requestId` 和 `authMode: "api_key" | "keyless"`。
  - **Brave** — `packages/coding-agent/src/web/search/providers/brave.ts`
    - 可用性:仅 `BRAVE_API_KEY`。
    - 查询:GET `https://api.search.brave.com/res/v1/web/search`,带 `count`、`extra_snippets=true` 和用于 `recency` 的 `freshness=pd|pw|pm|py`。
    - `limit` / `num_search_results`:`params.numSearchResults ?? params.limit`,限制在 `1..20`,默认 `10`。
    - 输出:`sources`、`requestId`。
  - **Kimi** — `packages/coding-agent/src/web/search/providers/kimi.ts`
    - 可用性:`MOONSHOT_SEARCH_API_KEY`、`KIMI_SEARCH_API_KEY` 或 `kimi-code` 的 `agent.db` 凭据。`MOONSHOT_API_KEY` 和存储的 `moonshot` 凭据会被有意拒绝,因为 Open Platform 密钥无法认证 Kimi Code 搜索服务。
    - 查询:POST 到 `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` / 默认 `https://api.kimi.com/coding/v1/search`,带 `text_query`、`limit`、`enable_page_crawling`、`timeout_seconds: 30`。
    - `limit` / `num_search_results`:`params.numSearchResults ?? params.limit`,限制在 `1..20`,默认 `10`。
    - 输出:`sources`、`requestId`。
  - **Parallel** — `packages/coding-agent/src/web/search/providers/parallel.ts`、`packages/coding-agent/src/web/parallel.ts`
    - 可用性:`parallel` 的环境变量或 `agent.db` 凭据。
    - 查询:POST `https://api.parallel.ai/v1beta/search`,带 `objective=query`、`search_queries=[query]`、`mode:"fast"`、`max_chars_per_result: 10000`、beta 请求头 `search-extract-2025-10-10`。
    - 尽管名字如此,这里没有提供商扇出;当前适配器总是发送一个单元素的 `search_queries` 数组。
    - `limit` 和 `num_search_results` 在分发前合并在一起,限制在 `1..40`,默认 `10`。
    - 输出:`sources`、`requestId`。
  - **Synthetic** — `packages/coding-agent/src/web/search/providers/synthetic.ts`
    - 可用性:`synthetic` 的环境变量或 `agent.db` 凭据。
    - 查询:POST `https://api.synthetic.new/v2/search`,带 `{ query }`。
    - 忽略 `recency`、`max_tokens` 和 `temperature`。
    - `limit` 和 `num_search_results` 在分发前合并在一起。
    - 输出:仅 `sources`。
  - **SearXNG** — `packages/coding-agent/src/web/search/providers/searxng.ts`
    - 可用性:`searxng.endpoint` 设置或 `SEARXNG_ENDPOINT` 环境变量提供的端点。
    - 查询:GET `<endpoint>/search?format=json&q=...`;可选设置添加 `categories` 和 `language`。
    - 认证优先级:Basic 认证(`searxng.basicUsername` / `searxng.basicPassword` 或环境变量等价物)优先于 bearer token(`searxng.token` / `SEARXNG_TOKEN`)。Basic 凭据会针对 RFC 7617 限制进行验证。
    - `recency` 映射到 `time_range`;`week` 降级为 `month`,因为 SearXNG 不支持周。
    - `limit` 和 `num_search_results` 在分发前合并在一起,限制在 `1..20`,默认 `10`。
    - 输出:`sources`、来自 `suggestions` 的 `relatedQuestions`。
  - **DuckDuckGo** — `packages/coding-agent/src/web/search/providers/duckduckgo.ts`
    - 可用性:始终可用;无需 API 密钥。
    - 查询:POST 无 JS HTML 前端 `https://html.duckduckgo.com/html/`,带 `q`、`kl=us-en` 和可选的 `df` 时间筛选(`d`/`w`/`m`/`y`);解析结果列表并解包 `//duckduckgo.com/l/?uddg=…` 重定向 URL。
    - `recency` 映射到 `df`;`day|week|month|year` 之外的值被忽略。
    - `limit` / `num_search_results`:合并并限制在 `1..20`,默认 `10`;输出仅暴露 `sources`(DuckDuckGo 的 HTML 页面不返回独立的摘要)。
    - 当 DuckDuckGo 对数据中心或共享出口 IP 限流时,它会提供机器人检测挑战(HTTP 200/202,带 `anomaly-modal` 主体)。适配器检测到这一点并抛出 `SearchProviderError`,以便编排器以明确的原因回退到下一个配置的提供商。
  - **Startpage** — `packages/coding-agent/src/web/search/providers/startpage.ts`
    - 可用性:始终可用;无需 API 密钥。它代理 Google 的索引,GET 首页以获取 `sc` 反机器人表单 token,然后 POST `/sp/search`(带无 token 的 GET 回退)。`recency` 映射到 `with_date=d|w|m|y`。
    - 机器人/挑战或同意页面抛出提供商标记的 `SearchProviderError`(429),以便链前进。
  - **Google / Ecosia / Mojeek** — `providers/google.ts`、`providers/ecosia.ts`、`providers/mojeek.ts`
    - 可用性:始终可用;无需 API 密钥。`browserFetch`(`providers/browser-page.ts`)首先尝试带浏览器配置的普通 fetch,并将 fetch 失败、非 2xx 状态和挑战主体升级到共享的隐身无头浏览器(`acquireBrowser`);注入的 `params.fetch`(测试)永远不会升级。
    - Google:通过首页植入 cookies,然后加载渲染后的 SERP;`recency` 映射到 `tbs=qdr:*`。Ecosia 位于 Cloudflare 之后(因此需要浏览器);其自然结果由 Google 驱动;`recency` 是服务端空操作,被静默忽略。Mojeek 面向 ALTCHA 工作量证明墙,浏览器路径会自动求解;`recency` 映射到 `since=day|week|month|year`。
    - 挑战页面(Google `unusual traffic`、Ecosia Firewall、Mojeek ALTCHA/robot 403)抛出提供商标记的 `SearchProviderError`(429)。
  - **Public Web** — `packages/coding-agent/src/web/search/providers/public.ts`
    - 可用性:仅显式选择(`isAvailable()` 为 `false`;`isExplicitlyAvailable()` 为 `true`)。
    - 查询:扇出到五个免凭据引擎(`startpage`、`google`、`duckduckgo`、`ecosia`、`mojeek`,减去被排除的),然后合并。URL 在规范键上去重(去掉 `www.` 的主机、规范化的尾部斜杠、保留查询、去除片段),按跨引擎共识排名,然后按每个引擎的最佳排名;最长的摘要获胜。
    - 截止时间竞争:在所有引擎全部完成、5 秒软截止时间且至少一次成功、或 30 秒硬上限中最早的时刻返回;落后者被中止。单个引擎失败可以容忍;只有每个引擎都失败时才失败。

## 副作用
- 网络
  - 调用一个或多个外部搜索提供商(通过 HTTPS),直到一个成功或全部失败。
  - 提供商特定的传输包括 JSON POST、JSON GET、SSE 流式(Perplexity OAuth/API、Gemini、Codex)以及 HTTP 上的 JSON-RPC(Z.AI)。
- 子进程 / 原生绑定
  - 大多数 HTTP/API 适配器不派生任何进程。Google、Ecosia 和 Mojeek 首先尝试普通 fetch,但失败、非 2xx 或受挑战的生产响应可以获取项目共享的、由 broker 拥有的无头 Chromium。没有 CLI worker 条目的主机(如嵌入式 SDK 主机)改为启动进程本地 Chromium。
  - 此回退可以启动 Chromium 进程并创建其浏览器配置文件生命周期。首次使用浏览器时,它还可能将 Chromium 下载到 omp Puppeteer 缓存中,除非有系统 Chromium 或 `PUPPETEER_EXECUTABLE_PATH` 可用。搜索适配器本身不使用任何原生绑定。
- 会话状态(转录、记忆、作业、检查点、注册表)
  - 在 `packages/coding-agent/src/web/search/provider.ts` 中使用模块全局的提供商实例缓存。
  - 在同一文件中使用模块全局的首选提供商设置。
  - `packages/coding-agent/src/tools/index.ts` 通过 `session.settings.get("web_search.enabled")` 门控工具可用性。
- 后台工作 / 取消
  - 许多提供商适配器接受 `AbortSignal`;`WebSearchTool.execute()` 将工具调用信号传入 `executeSearch()`,后者将其作为 `params.signal` 转发给提供商,并在回退期间重新抛出取消。

## 限制与上限
- 提供商自动顺序长度:23 个提供商(`packages/coding-agent/src/web/search/types.ts` 中的 `SEARCH_PROVIDER_ORDER`)。
- `formatForLLM()` 将来源摘要和引用文本截断至 240 个字符(`packages/coding-agent/src/web/search/index.ts`)。
- `formatForLLM()` 最多输出 3 个搜索查询,每个截断至 120 个字符(`packages/coding-agent/src/web/search/index.ts`)。
- Brave 结果数:默认 `10`,最大 `20`(`packages/coding-agent/src/web/search/providers/brave.ts` 中的 `DEFAULT_NUM_RESULTS`、`MAX_NUM_RESULTS`)。
- TinyFish 本地结果数:默认 `10`,最大 `20`;API 没有计数参数,每页最多返回 10 个结果,因此适配器抓取文档化的页(`page=0`,需要时再 `page=1`)并在本地切片(`packages/coding-agent/src/web/search/providers/tinyfish.ts`)。
- DuckDuckGo 结果数:默认 `10`,最大 `20`(`packages/coding-agent/src/web/search/providers/duckduckgo.ts`)。
- Startpage / Google / Ecosia / Mojeek 结果数:默认 `10`,最大 `20`(它们的 `providers/*.ts` 模块)。
- Public Web 结果数:默认 `15`,最大 `30`;扇出软截止时间 `5s`,硬上限 `30s`(`packages/coding-agent/src/web/search/providers/public.ts`)。
- Tavily 结果数:默认 `5`,最大 `20`(`packages/coding-agent/src/web/search/providers/tavily.ts`)。
- Firecrawl 结果数:默认 `10`,最大 `100`(`packages/coding-agent/src/web/search/providers/firecrawl.ts`)。
- Kimi 结果数:默认 `10`,最大 `20`;请求超时字段固定为 `30` 秒(`packages/coding-agent/src/web/search/providers/kimi.ts`)。
- Parallel 结果数:默认 `10`,最大 `40`;每个结果的摘录上限 `10_000` 个字符(`packages/coding-agent/src/web/search/providers/parallel.ts`、`packages/coding-agent/src/web/parallel.ts`)。
- Kagi 结果数:默认 `10`,最大 `40`(`packages/coding-agent/src/web/search/providers/kagi.ts`)。
- SearXNG 结果数:默认 `10`,最大 `20`(`packages/coding-agent/src/web/search/providers/searxng.ts`)。
- xAI 本地来源/引用上限:`num_search_results` 优先于 `limit`,省略/无效/为零 => 默认 `10`,最大 `30`;该计数不会发送到上游(`packages/coding-agent/src/web/search/providers/xai.ts`)。
- Perplexity API 密钥模式默认值:`max_tokens = 8192`、`temperature = 0.2`、`num_search_results = 20`(`packages/coding-agent/src/web/search/providers/perplexity.ts`)。
- Anthropic 默认值:模型 `claude-haiku-4-5`,提供商省略 `max_tokens` 时 `DEFAULT_MAX_TOKENS = 4096`(`packages/coding-agent/src/web/search/providers/anthropic.ts`)。
- Gemini 重试:每个端点最多 `3` 次重试,基础延迟 `1000` ms,限流延迟预算 `5 * 60 * 1000` ms(`packages/coding-agent/src/web/search/providers/gemini.ts`)。

## 错误
- 工具级别的无提供商情况返回正常的工具结果,带 `Error: No web search provider configured.`;它不会抛出。
- 工具级别的全失败情况也返回正常的工具结果,带 `Error: ...`;消息是单个规范化的提供商错误,或以分号分隔的所有失败提供商摘要。
- 提供商适配器通常为 HTTP 或协议失败抛出 `SearchProviderError(provider, message, status)`。
- 可用性探测在许多提供商中有意吞掉查找错误,并通过 `isApiKeyAvailable()` 报告 `false`。
- 每个提供商的显著失败:
  - Anthropic:缺少凭据抛出普通 `Error`;`404` 由 `formatProviderError()` 重新映射为特殊的最终消息。
  - Perplexity:缺少认证抛出普通 `Error`;OAuth 流的 `error_code` 事件变为 `SearchProviderError("perplexity", ...)`。
  - Gemini:认证刷新、端点回退和重试逻辑是内部的;最终耗尽的失败表现为 `SearchProviderError("gemini", ...)`。
  - Codex 和 Gemini 在 `200` 之后 HTTP 响应没有主体时都会失败。
  - Z.AI 将格式错误的 SSE/JSON-RPC 负载视为提供商错误,并且只跨请求变体重试参数形状失败。
  - 如果 Basic 认证字段不完整或无效,SearXNG `findAuth()` 可以在任何 HTTP 调用之前抛出配置错误。

## 备注
- 面向模型的 schema 不暴露 `provider`,但内部调用方可以通过 `SearchQueryParams` 强制指定一个。
- `executeSearch()` 惰性遍历 `resolveProviderCandidates()`;`resolveProviderChain()` 仍然是加载每个候选的兼容性辅助函数。提供商实例被缓存,通过 `getSearchProviderLabel()` 请求标签不会触发导入。
- 大多数提供商将 `limit` 和 `num_search_results` 视为同一个数字,因为适配器传递 `params.numSearchResults ?? params.limit`。Perplexity 保留这两个概念。TinyFish 将合并后的值用作本地上限,每页序列化 `num_results`,并在需要更多结果时分页。xAI 仅用它来限制解析的来源/引用(`10` 默认,`30` 最大)。
- `recency` 在 Brave、Perplexity、Tavily、SearXNG、Kagi、TinyFish、Firecrawl、DuckDuckGo、Startpage、Google 和 Mojeek 中有原生或引擎查询映射。xAI 保留绝对日期指令作为自然语言查询提示,因为其当前的 Responses 工具没有日期参数;Ecosia 忽略时间范围。Public Web 将请求传递给它自己的引擎。
- `packages/coding-agent/src/config/settings-schema.ts` 使用共享的 `SEARCH_PROVIDER_PREFERENCES` / `SEARCH_PROVIDER_OPTIONS` 元数据,因此设置选择器和设置向导暴露 `auto` 以及自动链中的每个提供商。
- 免凭据抓取器关闭自动链:Startpage 和 DuckDuckGo 位于浏览器驱动的 Ecosia、Google 和 Mojeek 路径之前;`public` 列在最后,永远不会被自动选择。
- `/login exa` 将粘贴的密钥存储在 AuthStorage 中;Exa 在未认证的 `https://mcp.exa.ai/mcp` 回退之前解析存储的或环境的凭据。
