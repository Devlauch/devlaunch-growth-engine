import type {
  ConnectorConfig,
  ConnectorDiscoveryResult,
  DiscoveredOrganization,
  SourceConnector,
} from "./types.js";
import { SlidingWindowRateLimiter } from "./rateLimiter.js";

/**
 * SourceConnector backed by Apollo.io's official REST API — organization
 * ("company") search via the `mixed_companies/search` endpoint
 * (https://api.apollo.io/api/v1/mixed_companies/search), authenticated with
 * an API key. See docs/DATA_PROVIDER_COMPLIANCE.md's "Apollo.io" entry.
 *
 * HONESTY NOTE (per this codebase's hard rule, see
 * docs/PROSPECTING_ENGINE_STATUS.md): the exact response shape coded below
 * is based on Apollo's public API documentation as of this writing, NOT
 * verified against a live call with a real API key (no APOLLO_API_KEY is
 * available in this environment). Every field is read defensively
 * (typeof-checked, nothing destructured blindly) and this connector never
 * fabricates an organization/domain Apollo's response didn't actually
 * contain. Apollo's `mixed_companies/search` response has historically
 * split matches across two possible array keys — `organizations` (not yet
 * in the caller's Apollo account) and `accounts` (already saved to it) —
 * so both are checked defensively rather than assuming only one is present.
 *
 * This package cannot import apps/api's env.ts (apps/api depends on this
 * package, not the reverse), so this connector reads `APOLLO_API_KEY` from
 * process.env directly by the same name env.ts uses as `env.apolloApiKey` —
 * same self-contained convention as `OverpassDirectoryApiClient` and
 * `GoogleSearchConnector`.
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

/** Distinct from a generic request failure so callers (and the dashboard)
 * can tell "your Apollo API key is wrong/expired" apart from a transient
 * network/server problem — the two call for completely different user
 * action (re-enter credentials vs. just retry later). */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface ApolloConnectorInput {
  /** Company name or keyword query, e.g. "Acme Robotics". */
  query: string;
  limit?: number;
  /** 1-based page number for Apollo's own pagination — real pagination,
   * not just a fixed first page. */
  page?: number;
  /** Apollo's `organization_locations` filter, e.g. ["California, US",
   * "London, UK"]. Caller-supplied, never hardcoded to one geography. */
  locations?: string[];
  /** Apollo's `q_organization_keyword_tags` filter — free-text
   * industry/keyword tags, e.g. ["saas", "fintech"]. Caller-supplied,
   * never hardcoded to one industry. */
  industries?: string[];
  /** Apollo's `organization_num_employees_ranges` filter, e.g.
   * ["1,10", "11,50"] (Apollo's own documented range-string format).
   * Caller-supplied, never hardcoded to one company-size band. */
  employeeRanges?: string[];
}

interface ApolloCompanySearchResponse {
  organizations?: unknown;
  accounts?: unknown;
  error?: unknown;
}

const APOLLO_COMPANY_SEARCH_ENDPOINT = "https://api.apollo.io/api/v1/mixed_companies/search";
const FETCH_TIMEOUT_MS = 15_000;
/** Bounded retry for transient failures only (network error, 5xx) — never
 * for 401/403 (retrying won't fix a bad key) or 429 (the waterfall/caller's
 * own rate-limit handling is the right response to that, not a blind retry
 * that could make the throttling worse). */
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

/**
 * Real SourceConnector for Apollo.io organization search. `fetchImpl` and
 * `clock` are injectable for tests, same convention as
 * `GoogleSearchConnector`/`OverpassDirectoryApiClient`.
 */
export class ApolloConnector implements SourceConnector {
  readonly id = "apollo-company-search";
  readonly type = "licensed_api" as const;
  readonly termsNote =
    "Official Apollo.io REST API (api.apollo.io), API-key authenticated. Apollo's terms restrict " +
    "re-sale/re-distribution of their data and require respecting individuals' opt-out requests " +
    "communicated back to Apollo — this platform does not yet report opt-outs back to Apollo " +
    "automatically (documented limitation, see docs/DATA_PROVIDER_COMPLIANCE.md). Apollo enforces " +
    "per-minute and per-day caps by plan; this connector self-throttles via the configured " +
    "rate_limit_per_minute and additionally honors an HTTP 429 response rather than retrying blindly.";
  readonly defaultRateLimitPerMinute = 20;

  constructor(
    private readonly apiKey: string | null = process.env.APOLLO_API_KEY ?? null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async discover(input: unknown, config: ConnectorConfig): Promise<ConnectorDiscoveryResult> {
    if (!config.enabled) {
      throw new Error("apollo-company-search connector is disabled for this tenant");
    }
    if (!this.apiKey) {
      throw new NotConfiguredError(
        "Apollo.io is not configured (APOLLO_API_KEY is unset in this environment). Refusing to " +
          "fabricate an organization record.",
      );
    }

    const parsed = parseInput(input);

    const limiter = new SlidingWindowRateLimiter(config.rateLimitPerMinute || this.defaultRateLimitPerMinute);
    await limiter.acquire(this.clock);

    const perPage = Math.min(Math.max(parsed.limit ?? 10, 1), 100);
    const requestBody: Record<string, unknown> = {
      q_organization_name: parsed.query,
      page: Math.max(parsed.page ?? 1, 1),
      per_page: perPage,
    };
    // Caller-supplied filters only — never a hardcoded industry/geography/
    // company-size band. Omitted entirely (not sent as empty arrays) when
    // not requested, matching Apollo's own documented "absent = no filter"
    // convention for these params.
    if (parsed.locations && parsed.locations.length > 0) requestBody.organization_locations = parsed.locations;
    if (parsed.industries && parsed.industries.length > 0) requestBody.q_organization_keyword_tags = parsed.industries;
    if (parsed.employeeRanges && parsed.employeeRanges.length > 0) {
      requestBody.organization_num_employees_ranges = parsed.employeeRanges;
    }

    const { res, body } = await this.fetchWithRetry(requestBody);

    if (!res.ok) {
      const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      throw new Error(`Apollo company-search request failed: ${message}`);
    }

    const rawOrgs = [
      ...(Array.isArray(body.organizations) ? body.organizations : []),
      ...(Array.isArray(body.accounts) ? body.accounts : []),
    ];

    const now = new Date().toISOString();
    const organizations: DiscoveredOrganization[] = [];

    for (const raw of rawOrgs) {
      if (!raw || typeof raw !== "object") continue; // Never trust a malformed item.
      const org = raw as Record<string, unknown>;
      const name = typeof org.name === "string" && org.name.trim() ? org.name.trim() : undefined;
      if (!name) continue; // No real name in the response — never invent one.

      const websiteUrl = typeof org.website_url === "string" ? org.website_url : undefined;
      const primaryDomain = typeof org.primary_domain === "string" ? org.primary_domain : undefined;
      const domain = primaryDomain ?? (websiteUrl ? extractDomain(websiteUrl) : undefined);
      const linkedinUrl = typeof org.linkedin_url === "string" ? org.linkedin_url : undefined;
      const sourceUrl = websiteUrl ?? linkedinUrl ?? (domain ? `https://${domain}` : undefined);
      if (!sourceUrl) continue; // No usable URL to attribute this record to.

      organizations.push({
        name,
        domain,
        sourceUrl,
        discoveredAt: now,
        rawMetadata: {
          source: "apollo",
          apolloOrganizationId: typeof org.id === "string" ? org.id : undefined,
          industry: typeof org.industry === "string" ? org.industry : undefined,
          linkedinUrl,
          query: parsed.query,
        },
      });
    }

    // Company/organization discovery only — contact-level data comes from
    // ApolloDecisionMakerProvider (apps/api/src/lib/apolloDecisionMakerProvider.ts),
    // not this connector.
    return { organizations, contacts: {} };
  }

  /**
   * Issues the Apollo request, retrying up to MAX_TRANSIENT_RETRIES times
   * (exponential backoff via the injectable `sleep`) for a network failure
   * or a 5xx response only. A 401/403 is classified as AuthenticationError
   * immediately (retrying won't fix a bad key); a 429 is classified as
   * RateLimitedError immediately (the waterfall/caller should back off, not
   * this method retrying blindly and compounding the throttle).
   */
  private async fetchWithRetry(
    requestBody: Record<string, unknown>,
  ): Promise<{ res: Response; body: ApolloCompanySearchResponse }> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(APOLLO_COMPANY_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey as string,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_TRANSIENT_RETRIES) {
          await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw new Error(
          `Apollo company-search request failed after ${attempt + 1} attempt(s): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthenticationError(
          `Apollo company-search authentication failed (HTTP ${res.status}) — the configured ` +
            `APOLLO_API_KEY is missing, invalid, or lacks permission for this endpoint.`,
        );
      }
      if (res.status === 429) {
        throw new RateLimitedError("Apollo company-search rate limit exceeded (HTTP 429).");
      }
      if (res.status >= 500 && attempt < MAX_TRANSIENT_RETRIES) {
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      let body: ApolloCompanySearchResponse;
      try {
        body = (await res.json()) as ApolloCompanySearchResponse;
      } catch (err) {
        throw new MalformedResponseError(
          `Could not parse Apollo response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { res, body };
    }

    // Unreachable in practice (the loop always returns or throws above) —
    // kept only so TypeScript sees every path as returning/throwing.
    throw lastError instanceof Error ? lastError : new Error("Apollo company-search request failed");
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function extractDomain(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function parseInput(input: unknown): ApolloConnectorInput {
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
      page: typeof obj.page === "number" ? obj.page : undefined,
      locations: isStringArray(obj.locations) ? obj.locations : undefined,
      industries: isStringArray(obj.industries) ? obj.industries : undefined,
      employeeRanges: isStringArray(obj.employeeRanges) ? obj.employeeRanges : undefined,
    };
  }
  throw new Error(
    "apollo-company-search connector expects { query: string, limit?: number, page?: number, " +
      "locations?: string[], industries?: string[], employeeRanges?: string[] }",
  );
}
