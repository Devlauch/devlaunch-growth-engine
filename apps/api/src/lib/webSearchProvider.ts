import { env } from "../config/env.js";

/**
 * webSearchProvider.ts: pluggable external web-search provider layer for
 * agent-platform tools that need real-time, outside-DevLaunch information
 * (see agentPlatform/core/agentTools.ts's webSearchTool and the
 * marketResearchAgent/competitorIntelligenceAgent/icpResearchAgent agents
 * that attach it) — same "interface + real per-provider classes +
 * NotConfigured fallback + getXProvider() resolver" shape as
 * llmProvider.ts, deliberately mirrored so this codebase has one
 * consistent pluggable-external-provider convention.
 *
 * CRITICAL HONESTY STATEMENT (same convention as llmProvider.ts /
 * hunterProvider.ts / bookingProvider.ts): no real Tavily/Serper API key is
 * available anywhere in this environment. `TavilySearchProvider` and
 * `SerperSearchProvider` below are real, working client code written
 * against each provider's own currently-published API docs (cited below),
 * but neither has ever been exercised against the real api.tavily.com /
 * google.serper.dev — only against injected fake `fetch` responses in
 * test/webSearchProvider.test.ts.
 *
 * Dependency choice: minimal `fetch`-based clients, NOT an SDK package —
 * same consistency-with-the-existing-convention justification as
 * llmProvider.ts's own header comment.
 *
 * Tavily API shape (POST https://api.tavily.com/search) — CONFIRMED live
 * against Tavily's own published docs during this work
 * (docs.tavily.com/documentation/api-reference/endpoint/search and
 * docs.tavily.com/documentation/quickstart, fetched 2026-11-23):
 *   - Auth: `Authorization: Bearer <api_key>` header (NOT an `api_key`
 *     field in the request body — Tavily's docs show only the Bearer-header
 *     form in their own quickstart curl example: `-H "Authorization: Bearer
 *     tvly-YOUR_API_KEY"`; this supersedes the older api_key-in-body
 *     convention some third-party examples still show).
 *   - Request body: { query, max_results?, search_depth?: "basic" |
 *     "advanced" | "fast" | "ultra-fast", include_answer? }.
 *   - Response body: { results: [{ title, url, content, score,
 *     published_date? }], answer? } — `published_date` is present only
 *     when requested/applicable and null if undetectable.
 *   - Errors: no single documented error-body shape was found beyond HTTP
 *     status; this client classifies purely by status code (401 invalid
 *     key, 429 rate limit, 434 best-effort-tier overload, 5xx
 *     provider-side), same convention as llmProvider.ts.
 *   - Free tier: CONFIRMED (tavily.com/pricing, fetched 2026-11-23) — the
 *     free "Researcher" plan includes 1,000 API credits/month, no credit
 *     card required, unused credits do not carry over.
 *
 * Serper API shape (POST https://google.serper.dev/search) — CONFIRMED via
 * Serper's own documented request pattern (consistent across
 * serper.dev-sourced examples fetched during this work, 2026-11-23):
 *   - Auth: `X-API-KEY: <api_key>` header (not Bearer, not in the body).
 *   - Request body: { q, num? } (page/gl/hl/tbs also accepted, unused here).
 *   - Response body: { organic: [{ title, link, snippet, date?, position }] }.
 *   - Errors: no documented error-body shape beyond HTTP status; this
 *     client classifies purely by status code, same convention as above.
 *   - Free tier: CONFIRMED (serper.dev, fetched 2026-11-23) — 2,500 free
 *     queries on signup, no credit card required.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string | null;
}

export interface WebSearchOptions {
  maxResults?: number;
}

export interface WebSearchProvider {
  readonly name: string;
  /** True when this provider can actually make real calls (a real key is configured). */
  readonly isConfigured: boolean;
  search(query: string, opts?: WebSearchOptions): Promise<WebSearchResult[]>;
}

export class WebSearchNotConfiguredError extends Error {
  constructor(
    message = "No web-search provider is configured (set one of TAVILY_API_KEY, SERPER_API_KEY).",
  ) {
    super(message);
    this.name = "WebSearchNotConfiguredError";
  }
}

/** A real, classified failure response from a web-search API (never thrown for a merely-empty result set). */
export class WebSearchApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WebSearchApiError";
    this.status = status;
    // 429 (rate limit) and 5xx (provider-side) are worth a caller retrying
    // later; 400/401/404/422 mean the request/key itself is wrong. Same
    // classification rule as llmProvider.ts's LlmApiError.
    this.retryable = status === 429 || status >= 500;
  }
}

export class WebSearchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Web search API request timed out after ${timeoutMs}ms`);
    this.name = "WebSearchTimeoutError";
  }
}

export class WebSearchNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Web search API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WebSearchNetworkError";
  }
}

/**
 * Always honestly reports not-configured — used whenever no real
 * Tavily/Serper API key exists (every environment this codebase has
 * actually run in today). `search()` throws WebSearchNotConfiguredError
 * rather than ever returning fabricated results; real call sites (see
 * agentTools.ts's webSearchTool) check `isConfigured` first and return a
 * `{ status: "not_configured" }` shape instead of calling `search()` at
 * all, so this throw is a defensive backstop, not the primary
 * control-flow mechanism — same convention as llmProvider.ts's
 * NotConfiguredLlmProvider.
 */
export class NotConfiguredWebSearchProvider implements WebSearchProvider {
  readonly name = "not_configured";
  readonly isConfigured = false;

  async search(): Promise<WebSearchResult[]> {
    throw new WebSearchNotConfiguredError();
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 5;

export interface WebSearchFetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response>;
}

/** Injectable for tests. Defaults to the real global fetch. */
function defaultFetcher(): WebSearchFetcher {
  return (url, init) => fetch(url, init);
}

const TAVILY_BASE_URL = "https://api.tavily.com/search";

interface TavilySearchResponseBody {
  results?: { title?: string; url?: string; content?: string; score?: number; published_date?: string | null }[];
  answer?: string;
}

/** Real Tavily (AI-native web search, tavily.com) client — see this file's header comment for the exact confirmed request/response shape. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly name = "tavily";
  readonly isConfigured = true;

  constructor(
    private readonly apiKey: string,
    private readonly options: { timeoutMs?: number; fetcher?: WebSearchFetcher } = {},
  ) {}

  async search(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetcher = this.options.fetcher ?? defaultFetcher();

    const body: Record<string, unknown> = {
      query,
      max_results: opts.maxResults ?? DEFAULT_MAX_RESULTS,
      search_depth: "basic",
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(TAVILY_BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new WebSearchTimeoutError(timeoutMs);
      }
      throw new WebSearchNetworkError(err);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new WebSearchApiError(`Tavily API returned HTTP ${response.status}`, response.status);
    }

    let parsed: TavilySearchResponseBody | null = null;
    try {
      parsed = (await response.json()) as TavilySearchResponseBody;
    } catch {
      parsed = null;
    }

    return (parsed?.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
      publishedDate: r.published_date ?? null,
    }));
  }
}

const SERPER_BASE_URL = "https://google.serper.dev/search";

interface SerperSearchResponseBody {
  organic?: { title?: string; link?: string; snippet?: string; date?: string; position?: number }[];
}

/** Real Serper (Google Search results API, serper.dev) client — see this file's header comment for the exact confirmed request/response shape. */
export class SerperSearchProvider implements WebSearchProvider {
  readonly name = "serper";
  readonly isConfigured = true;

  constructor(
    private readonly apiKey: string,
    private readonly options: { timeoutMs?: number; fetcher?: WebSearchFetcher } = {},
  ) {}

  async search(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetcher = this.options.fetcher ?? defaultFetcher();

    const body: Record<string, unknown> = {
      q: query,
      num: opts.maxResults ?? DEFAULT_MAX_RESULTS,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(SERPER_BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-KEY": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new WebSearchTimeoutError(timeoutMs);
      }
      throw new WebSearchNetworkError(err);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new WebSearchApiError(`Serper API returned HTTP ${response.status}`, response.status);
    }

    let parsed: SerperSearchResponseBody | null = null;
    try {
      parsed = (await response.json()) as SerperSearchResponseBody;
    } catch {
      parsed = null;
    }

    return (parsed?.organic ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
      publishedDate: r.date ?? null,
    }));
  }
}

/**
 * Resolver: the one place every call site should go through. Returns a
 * real provider for whichever of TAVILY_API_KEY / SERPER_API_KEY is
 * configured, otherwise the honest NotConfiguredWebSearchProvider — never
 * throws for a plain missing-key situation, so callers always check
 * `.isConfigured` rather than try/catch-ing a missing-key error.
 *
 * Selection: `WEB_SEARCH_PROVIDER` (env.webSearchProviderOverride)
 * explicitly picks one ("tavily" | "serper") and throws at startup if that
 * provider's key isn't actually set — a deliberate fail-loud choice so a
 * misconfigured override is never silently ignored, same convention as
 * llmProvider.ts's getLlmProvider(). With no override, the first
 * configured key wins in this fixed priority order: tavily, serper —
 * tavily is an AI-native search API purpose-built for feeding LLM/agent
 * context (structured, relevance-scored results, optional synthesized
 * answer), a better fit for this platform's agent-grounding use case than
 * Serper's raw Google SERP scrape, so it is preferred when both are set.
 */
export function getWebSearchProvider(): WebSearchProvider {
  const override = env.webSearchProviderOverride;

  if (override === "tavily") {
    if (!env.tavilyApiKey) throw new WebSearchNotConfiguredError("WEB_SEARCH_PROVIDER=tavily but TAVILY_API_KEY is not set.");
    return new TavilySearchProvider(env.tavilyApiKey);
  }
  if (override === "serper") {
    if (!env.serperApiKey) throw new WebSearchNotConfiguredError("WEB_SEARCH_PROVIDER=serper but SERPER_API_KEY is not set.");
    return new SerperSearchProvider(env.serperApiKey);
  }

  if (env.tavilyApiKey) return new TavilySearchProvider(env.tavilyApiKey);
  if (env.serperApiKey) return new SerperSearchProvider(env.serperApiKey);
  return new NotConfiguredWebSearchProvider();
}
