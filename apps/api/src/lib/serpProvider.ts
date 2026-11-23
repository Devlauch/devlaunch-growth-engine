import { env } from "../config/env.js";
import type { RankingCheckResult, RankingProvider } from "./keywordRankingStub.js";
import { NotConfiguredError, NotConfiguredRankingProvider } from "./keywordRankingStub.js";

/**
 * Real SERP keyword-ranking client, upgrading keywordRankingStub.ts's
 * NotConfiguredRankingProvider (Milestone 6 / P5). No real SerpApi key is
 * available in this environment — every request path below is real,
 * working HTTP client code, exercised only against mocked `fetch`
 * responses in this codebase's tests, never against the live API. That gap
 * is reported as BLOCKED, not hidden.
 *
 * Provider chosen: SerpApi (https://serpapi.com), a well-documented,
 * commonly-used Google SERP scraping API. API shape verified against
 * SerpApi's own published documentation
 * (https://serpapi.com/search-api, https://serpapi.com/organic-results):
 *   - Auth: `api_key` query parameter on every request (SerpApi's docs lead
 *     with this form; `Authorization: Bearer <key>` is also documented as
 *     an accepted alternative, but the query-param form is what every
 *     example request in SerpApi's own docs uses — same convention
 *     hunterProvider.ts followed for Hunter.io).
 *   - Search: GET https://serpapi.com/search.json?engine=google&q=<keyword>
 *     &api_key=<key>&num=<n>&hl=<lang>&gl=<country>, returning (among other
 *     top-level keys) `organic_results`: an array of
 *     `{ position, title, link, displayed_link, snippet, ... }` objects, in
 *     rank order starting at position 1. There is no built-in "rank for my
 *     domain" endpoint — the documented approach (per SerpApi's own FAQ/
 *     blog on rank tracking) is to run the query and scan organic_results
 *     for the first result whose `link`/`displayed_link` host matches the
 *     domain being tracked, which is exactly what `checkRanking` does below.
 *   - Errors: a non-200 response, or a 200 response with a top-level
 *     `error` string field (SerpApi returns errors this way even on HTTP
 *     200 for some failure modes, e.g. an invalid api_key) — both are
 *     classified as SerpApiError here.
 *   - `search_metadata.status` is also documented ("Success"/"Error") and
 *     is treated the same way as the `error` field when present.
 */

const SERPAPI_BASE_URL = "https://serpapi.com/search.json";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RESULT_COUNT = 100; // SerpApi's documented max useful `num` for a single-page rank check.

export class SerpApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "SerpApiError";
    this.status = status;
    this.retryable = status === null || status === 429 || status >= 500;
  }
}

export class SerpApiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`SerpApi request timed out after ${timeoutMs}ms`);
    this.name = "SerpApiTimeoutError";
  }
}

export class SerpApiNetworkError extends Error {
  constructor(cause: unknown) {
    super(`SerpApi request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SerpApiNetworkError";
  }
}

export interface SerpFetcher {
  (url: string, init: { signal: AbortSignal }): Promise<Response>;
}

function defaultFetcher(): SerpFetcher {
  return (url, init) => fetch(url, init);
}

interface RawSerpOrganicResult {
  position?: number;
  title?: string;
  link?: string;
  displayed_link?: string;
}

interface RawSerpApiResponse {
  error?: string;
  search_metadata?: { status?: string };
  organic_results?: RawSerpOrganicResult[];
}

/** Extracts the registrable host from a URL/displayed-link string, lower-cased,
 * stripping a leading "www." — good enough to match e.g. "example.com"
 * against both "https://example.com/pricing" and "www.example.com". */
function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export interface SerpApiCheckOptions {
  /** Google locale ("us", "uk", ...). Optional — SerpApi defaults to "us" when omitted. */
  country?: string;
  /** Google UI language ("en", ...). Optional. */
  language?: string;
  numResults?: number;
  timeoutMs?: number;
  fetcher?: SerpFetcher;
}

/**
 * Real SerpApi-backed RankingProvider. Calls SerpApi's Google Search engine
 * for `keyword`, scans `organic_results` in rank order, and returns the
 * position (1-indexed, exactly as SerpApi reports it) of the first result
 * whose host matches `domain` — or `position: null` when the domain isn't
 * found within the results SerpApi returned (a genuine "not ranking in the
 * results we checked", never guessed/estimated).
 */
export class SerpApiRankingProvider implements RankingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: SerpApiCheckOptions = {},
  ) {}

  async checkRanking(keyword: string, domain: string): Promise<RankingCheckResult> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetcher = this.options.fetcher ?? defaultFetcher();

    const url = new URL(SERPAPI_BASE_URL);
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", keyword);
    url.searchParams.set("num", String(this.options.numResults ?? DEFAULT_RESULT_COUNT));
    if (this.options.country) url.searchParams.set("gl", this.options.country);
    if (this.options.language) url.searchParams.set("hl", this.options.language);
    url.searchParams.set("api_key", this.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(url.toString(), { signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new SerpApiTimeoutError(timeoutMs);
      throw new SerpApiNetworkError(err);
    } finally {
      clearTimeout(timer);
    }

    let body: RawSerpApiResponse | null;
    try {
      body = (await response.json()) as RawSerpApiResponse;
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw new SerpApiError(body?.error ?? `SerpApi returned HTTP ${response.status}`, response.status);
    }
    if (body?.error || body?.search_metadata?.status === "Error") {
      throw new SerpApiError(body?.error ?? "SerpApi reported search_metadata.status = 'Error'", response.status);
    }

    const targetHost = hostOf(domain);
    const results = body?.organic_results ?? [];
    const match = results.find((r) => {
      const host = hostOf(r.link) ?? hostOf(r.displayed_link);
      return host !== null && targetHost !== null && (host === targetHost || host.endsWith(`.${targetHost}`));
    });

    return {
      position: match?.position ?? null,
      source: "serpapi",
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Resolves the real RankingProvider when SERPAPI_API_KEY is configured,
 * falling back to the honest NotConfiguredRankingProvider stub otherwise —
 * same injectable/graceful-degradation convention as every other optional
 * provider key in this codebase (see config/env.ts). Callers (seo.ts's
 * POST /keyword-rankings) should use this instead of constructing either
 * provider directly.
 */
export function getRankingProvider(options: SerpApiCheckOptions = {}): RankingProvider {
  if (!env.serpApiKey) return new NotConfiguredRankingProvider("SerpApi (https://serpapi.com)");
  return new SerpApiRankingProvider(env.serpApiKey, options);
}

export { NotConfiguredError };
