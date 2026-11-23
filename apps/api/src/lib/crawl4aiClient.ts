/**
 * Slim, fetch-based Crawl4AI HTTP client for apps/api.
 *
 * apps/worker already has a full `HttpCrawl4AIBackend` class (see
 * apps/worker/src/agents/websiteCrawler.ts) plus robots.txt handling and a
 * domain rate limiter, used by `crawlOrganizationSite`. apps/api has no
 * runtime dependency on apps/worker (confirmed via apps/api/package.json —
 * no @devlaunch/worker dependency, and agents only execute inside the
 * worker process), so this is a deliberately small, direct `POST
 * {CRAWL4AI_BASE_URL}/crawl` client for apps/api's own competitor-crawl
 * route — not a copy of the full backend class, just the one HTTP call it
 * needs, same auth-token pattern verified against a live
 * `unclecode/crawl4ai:0.9.6` container (see
 * docs/CRAWL4AI_VERIFICATION.md and websiteCrawler.ts's own doc comment).
 *
 * Honesty contract: this client throws `Crawl4AINotConfiguredError` when
 * `CRAWL4AI_BASE_URL` isn't set, and `Crawl4AIUnreachableError` when the
 * service can't be reached or errors at the transport/service level —
 * never silently returns fabricated/empty page content standing in for a
 * real crawl.
 *
 * SSRF guard: the actual `fetch()` call below targets the operator-configured
 * `CRAWL4AI_BASE_URL`, not the caller-supplied `url` — but that `url` is the
 * real SSRF-relevant value, since it's what the (trusted) Crawl4AI service
 * will itself fetch on our behalf. `assertSafeUrl()` (../lib/ssrfGuard.ts)
 * validates it — DNS A/AAAA resolution + private/loopback/link-local/
 * metadata-range rejection — before it's ever sent, so this client can't be
 * used as an SSRF proxy against Crawl4AI's own network reachability.
 */
import { assertSafeUrl } from "./ssrfGuard.js";

/** A conservative, fixed, small set of paths probed on a competitor's own site. */
export const COMPETITOR_CANDIDATE_PATHS: string[] = ["/", "/about", "/pricing", "/blog"];

/** Hardening: a single crawl4ai `/crawl` call has no other timeout in this
 * call chain — a hung Crawl4AI service/target page would otherwise tie up
 * the request indefinitely. */
const CRAWL4AI_FETCH_TIMEOUT_MS = 20_000;

export class Crawl4AINotConfiguredError extends Error {
  constructor() {
    super("CRAWL4AI_BASE_URL is not configured — cannot crawl a competitor's site without a real Crawl4AI service.");
    this.name = "Crawl4AINotConfiguredError";
  }
}

export class Crawl4AIUnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Crawl4AI service at ${baseUrl} is unreachable or errored: ${causeMessage}`);
    this.name = "Crawl4AIUnreachableError";
    this.cause = cause;
  }
}

export interface Crawl4AIFetchResult {
  url: string;
  statusCode: number;
  html: string;
  title?: string;
}

function extractFirstResult(body: unknown): { html?: string; title?: string } {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const results = obj.results;
    if (Array.isArray(results) && results.length > 0 && results[0] && typeof results[0] === "object") {
      const r = results[0] as Record<string, unknown>;
      const metadata = r.metadata as Record<string, unknown> | undefined;
      return {
        html: typeof r.html === "string" ? r.html : typeof r.markdown === "string" ? r.markdown : undefined,
        title: typeof metadata?.title === "string" ? (metadata.title as string) : undefined,
      };
    }
    if (typeof obj.html === "string") {
      return { html: obj.html, title: typeof obj.title === "string" ? obj.title : undefined };
    }
  }
  return {};
}

/**
 * Fetches a single page via a running Crawl4AI HTTP service's `/crawl`
 * endpoint. Reads `baseUrl`/`apiToken` from `CRAWL4AI_BASE_URL` /
 * `CRAWL4AI_API_TOKEN` when not passed explicitly, same as
 * apps/worker's HttpCrawl4AIBackend.
 */
export async function fetchCompetitorPage(
  url: string,
  opts: { baseUrl?: string; apiToken?: string; fetchImpl?: typeof fetch } = {},
): Promise<Crawl4AIFetchResult> {
  const baseUrl = opts.baseUrl ?? process.env.CRAWL4AI_BASE_URL;
  if (!baseUrl) {
    throw new Crawl4AINotConfiguredError();
  }
  // SSRF guard — see file doc comment. Throws SsrfBlockedError before any
  // network call is made if `url` resolves to a private/internal address.
  await assertSafeUrl(url);
  const apiToken = opts.apiToken ?? process.env.CRAWL4AI_API_TOKEN;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let response: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/crawl`, {
      method: "POST",
      headers,
      body: JSON.stringify({ urls: [url] }),
      // Hardening: a crawl request has no timeout anywhere else in this
      // call chain — without this, a hung Crawl4AI service/page could tie
      // up a request indefinitely.
      signal: AbortSignal.timeout(CRAWL4AI_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Crawl4AIUnreachableError(baseUrl, err);
  }

  if (response.status >= 500) {
    throw new Crawl4AIUnreachableError(baseUrl, new Error(`HTTP ${response.status} ${response.statusText}`));
  }
  if (response.status === 401 || response.status === 403) {
    throw new Crawl4AIUnreachableError(
      baseUrl,
      new Error(`HTTP ${response.status}: crawl4ai rejected the request (missing/invalid CRAWL4AI_API_TOKEN?)`),
    );
  }
  if (!response.ok) {
    // A single page 404ing isn't a service-level failure.
    return { url, statusCode: response.status, html: "" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new Crawl4AIUnreachableError(baseUrl, err);
  }

  const result = extractFirstResult(body);
  return { url, statusCode: 200, html: result.html ?? "", title: result.title };
}
