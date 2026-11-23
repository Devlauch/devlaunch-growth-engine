import type {
  ConnectorConfig,
  ConnectorDiscoveryResult,
  DiscoveredOrganization,
  SourceConnector,
} from "./types.js";
import { SlidingWindowRateLimiter } from "./rateLimiter.js";

/**
 * SourceConnector backed by Google's official Custom Search JSON API
 * (https://developers.google.com/custom-search/v1/overview). Purpose is
 * narrow and matches docs/DATA_PROVIDER_COMPLIANCE.md's "Google
 * Programmable Search" entry exactly: given a company name/keyword query,
 * find its official website/public presence — nothing more.
 *
 * Requires BOTH an API key and a configured Programmable Search Engine ID
 * (the same `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_ENGINE_ID` env vars
 * apps/api/src/config/env.ts reads as `env.googleSearchApiKey` /
 * `env.googleSearchEngineId`). This package cannot import apps/api's env.ts
 * (apps/api depends on this package, not the reverse — importing it back
 * would be a circular package dependency), so this connector reads the same
 * two process.env vars directly by the same names, exactly mirroring how
 * `OverpassDirectoryApiClient` is self-contained with no apps/api
 * dependency. Either missing means `NotConfiguredError` — never a
 * fabricated search result.
 *
 * CRITICAL compliance rule (see DATA_PROVIDER_COMPLIANCE.md, "do not
 * attempt to work around the cap by scraping google.com/search directly"):
 * if the configured key/engine is out of quota, this connector throws
 * `RateLimitedError`. It must NEVER fall back to scraping Google's public
 * search results page. This is a hard rule, not a cost/benefit tradeoff —
 * do not "fix" a rate-limited result by adding an HTML-scraping fallback.
 */

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

export interface GoogleSearchConnectorInput {
  /** Company name or keyword query, e.g. "Acme Robotics Springfield MO". */
  query: string;
  /** Number of results to request (Google's `num` param caps at 10 per call). */
  limit?: number;
}

interface GoogleCustomSearchErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
}

interface GoogleCustomSearchResponse extends GoogleCustomSearchErrorBody {
  items?: unknown;
}

const GOOGLE_CUSTOM_SEARCH_ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Real, working SourceConnector for Google Programmable Search. `fetchImpl`
 * and `clock` are injectable (same convention as
 * apps/api/src/lib/coreWebVitals.ts's `fetchImpl: typeof fetch = fetch`, and
 * rateLimiter.ts's injected-clock `acquire(now)`) so tests never make a real
 * network call and never depend on wall-clock timing.
 */
export class GoogleSearchConnector implements SourceConnector {
  readonly id = "google-search";
  readonly type = "licensed_api" as const;
  readonly termsNote =
    "Official Google Custom Search JSON API (www.googleapis.com/customsearch/v1), API-key + " +
    "Programmable Search Engine ID authenticated. Google's free tier caps at 100 queries/day as of " +
    "this writing (verify current terms before relying on this number); paid tiers raise that cap. " +
    "If the configured key/engine exhausts its quota, this connector reports rate_limited rather " +
    "than ever falling back to scraping google.com/search directly (see " +
    "docs/DATA_PROVIDER_COMPLIANCE.md) — a hard compliance rule, not a cost/benefit tradeoff. " +
    "Use case is narrow: finding a company's official website/public presence from a name or " +
    "keyword query, nothing more (no SERP scraping of competitor rankings, ads, etc.).";
  readonly defaultRateLimitPerMinute = 10;

  constructor(
    private readonly apiKey: string | null = process.env.GOOGLE_SEARCH_API_KEY ?? null,
    private readonly engineId: string | null = process.env.GOOGLE_SEARCH_ENGINE_ID ?? null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async discover(input: unknown, config: ConnectorConfig): Promise<ConnectorDiscoveryResult> {
    if (!config.enabled) {
      throw new Error("google-search connector is disabled for this tenant");
    }
    if (!this.apiKey || !this.engineId) {
      throw new NotConfiguredError(
        "Google Programmable Search is not configured (GOOGLE_SEARCH_API_KEY and/or " +
          "GOOGLE_SEARCH_ENGINE_ID is unset in this environment). Refusing to fabricate a search result.",
      );
    }

    const parsed = parseInput(input);

    const limiter = new SlidingWindowRateLimiter(config.rateLimitPerMinute || this.defaultRateLimitPerMinute);
    await limiter.acquire(this.clock);

    const num = Math.min(Math.max(parsed.limit ?? 5, 1), 10);
    const url =
      `${GOOGLE_CUSTOM_SEARCH_ENDPOINT}?key=${encodeURIComponent(this.apiKey)}` +
      `&cx=${encodeURIComponent(this.engineId)}&q=${encodeURIComponent(parsed.query)}&num=${num}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(
        `Google Custom Search request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 429) {
      throw new RateLimitedError("Google Custom Search rate limit/quota exceeded (HTTP 429).");
    }

    let body: GoogleCustomSearchResponse;
    try {
      body = (await res.json()) as GoogleCustomSearchResponse;
    } catch (err) {
      throw new MalformedResponseError(
        `Could not parse Google Custom Search response as JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const errorStatus = typeof body.error?.status === "string" ? body.error.status : undefined;
      const errorMessage =
        typeof body.error?.message === "string" ? body.error.message : `HTTP ${res.status}`;
      // Google surfaces quota exhaustion as a 403 with status
      // "RESOURCE_EXHAUSTED" (or a message mentioning rate/quota limits) in
      // some API versions/rollout states, rather than a 429 — treat that
      // honestly as rate_limited too, never as a silent empty result.
      if (res.status === 403 && (errorStatus === "RESOURCE_EXHAUSTED" || /rate.?limit|quota/i.test(errorMessage))) {
        throw new RateLimitedError(`Google Custom Search quota exceeded: ${errorMessage}`);
      }
      throw new Error(`Google Custom Search request failed (HTTP ${res.status}): ${errorMessage}`);
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const now = new Date().toISOString();
    const organizations: DiscoveredOrganization[] = [];

    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue; // Never trust a malformed item.
      const item = raw as Record<string, unknown>;
      if (typeof item.link !== "string" || !item.link) continue;

      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : undefined;
      const displayLink = typeof item.displayLink === "string" ? item.displayLink : undefined;
      const snippet = typeof item.snippet === "string" ? item.snippet : undefined;

      organizations.push({
        name: title ?? displayLink ?? item.link,
        domain: extractDomain(item.link),
        sourceUrl: item.link,
        discoveredAt: now,
        rawMetadata: {
          source: "google-programmable-search",
          query: parsed.query,
          displayLink,
          snippet,
        },
      });
    }

    // Google Custom Search is organization/website discovery only — it
    // never returns named contacts.
    return { organizations, contacts: {} };
  }
}

function extractDomain(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function parseInput(input: unknown): GoogleSearchConnectorInput {
  if (
    input &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>).query === "string" &&
    (input as Record<string, unknown>).query
  ) {
    const obj = input as Record<string, unknown>;
    return {
      query: obj.query as string,
      limit: typeof obj.limit === "number" ? obj.limit : undefined,
    };
  }
  throw new Error("google-search connector expects { query: string, limit?: number }");
}
