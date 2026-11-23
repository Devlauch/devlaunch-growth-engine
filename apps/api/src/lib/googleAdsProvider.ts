import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";
import type { AdCampaignPerformance, AdsChannelProvider } from "./channelProviders.js";
import { NotConfiguredError } from "./channelProviders.js";

/**
 * Real Google Ads API client, upgrading channelProviders.ts's
 * NotConfiguredGoogleAdsProvider stub (Milestone 6 / P5). No real Google
 * Ads OAuth app/developer token is available in this environment — every
 * request path below is real, working HTTP client code, exercised only
 * against mocked `fetch` responses in tests, never against the live API.
 * That gap is reported as BLOCKED, not hidden.
 *
 * API shape verified against Google's own published documentation:
 *   - OAuth2 token exchange/refresh: Google's standard OAuth2 token
 *     endpoint, https://oauth2.googleapis.com/token (documented at
 *     https://developers.google.com/identity/protocols/oauth2/web-server#offline),
 *     POST with `grant_type=refresh_token`, `client_id`, `client_secret`,
 *     `refresh_token` as `application/x-www-form-urlencoded` body fields,
 *     returning `{ access_token, expires_in, scope, token_type }` — a
 *     refresh-token exchange response never includes a new refresh_token.
 *     A tenant's one-time authorization-code exchange (the first leg of
 *     the OAuth2 flow, before a refresh_token exists) is documented as the
 *     same endpoint with `grant_type=authorization_code` +
 *     `code`/`redirect_uri` instead — `exchangeAuthorizationCode` below
 *     implements that leg; which flow runs is the caller's
 *     (routes/integrations.ts's connect handler's) job, not this client's.
 *   - Reporting: Google Ads API v17 REST interface, documented at
 *     https://developers.google.com/google-ads/api/rest/overview —
 *     POST https://googleads.googleapis.com/v17/customers/{customerId}
 *     /googleAds:search, headers `Authorization: Bearer <access_token>`,
 *     `developer-token: <developer_token>`, and (when operating via an MCC)
 *     `login-customer-id: <manager_customer_id>`; body
 *     `{ "query": "<GAQL>" }`. GAQL verified against
 *     https://developers.google.com/google-ads/api/docs/query/overview —
 *     this client queries the `campaign` resource joined with
 *     `metrics.impressions`, `metrics.clicks`, `metrics.cost_micros` over
 *     `segments.date` (cost is reported in micros — 1,000,000 micros = one
 *     unit of the account's currency; converted to cents here via
 *     Math.round(cost_micros / 10_000)).
 *   - Errors: a non-200 response carries a `{"error":{"code","message",
 *     "status","details":[{"errors":[{"errorCode","message"}]}] }}` body
 *     (Google's standard API error envelope, documented at
 *     https://developers.google.com/google-ads/api/docs/best-practices/diagnosing-errors).
 */

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ADS_API_VERSION = "v17";
const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const DEFAULT_TIMEOUT_MS = 20_000;

export class GoogleAdsApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GoogleAdsApiError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export class GoogleAdsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Google Ads API request timed out after ${timeoutMs}ms`);
    this.name = "GoogleAdsTimeoutError";
  }
}

export class GoogleAdsNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Google Ads API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GoogleAdsNetworkError";
  }
}

export interface GoogleAdsFetcher {
  (url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response>;
}

function defaultFetcher(): GoogleAdsFetcher {
  return (url, init) => fetch(url, init);
}

// ---------------------------------------------------------------------------
// OAuth2
// ---------------------------------------------------------------------------

export interface GoogleOAuthTokenResult {
  accessToken: string;
  expiresInSeconds: number | null;
  scope: string | null;
  tokenType: string | null;
}

async function postForm(
  url: string,
  form: Record<string, string>,
  options: { timeoutMs?: number; fetcher?: GoogleAdsFetcher } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new GoogleAdsTimeoutError(timeoutMs);
    throw new GoogleAdsNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new GoogleAdsApiError(
      (body?.error_description as string) ?? (body?.error as string) ?? `Google OAuth2 token endpoint returned HTTP ${response.status}`,
      response.status,
    );
  }
  return body ?? {};
}

/** Refreshes a short-lived access token from a long-lived refresh token —
 * the normal path once a tenant has completed the OAuth2 consent flow once. */
export async function refreshGoogleAdsAccessToken(
  credentials: { clientId: string; clientSecret: string; refreshToken: string },
  options: { timeoutMs?: number; fetcher?: GoogleAdsFetcher } = {},
): Promise<GoogleOAuthTokenResult> {
  const body = await postForm(
    GOOGLE_OAUTH_TOKEN_URL,
    {
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    },
    options,
  );
  return {
    accessToken: body.access_token as string,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : null,
    scope: (body.scope as string) ?? null,
    tokenType: (body.token_type as string) ?? null,
  };
}

/** The one-time authorization-code exchange (first OAuth2 leg) — exchanges
 * the `code` the Google consent screen redirected back with for an initial
 * access_token + refresh_token pair. The refresh_token from this response
 * is what gets stored (encrypted) as this tenant's long-lived credential;
 * it is returned here but never logged. */
export async function exchangeGoogleAdsAuthorizationCode(
  credentials: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  options: { timeoutMs?: number; fetcher?: GoogleAdsFetcher } = {},
): Promise<GoogleOAuthTokenResult & { refreshToken: string | null }> {
  const body = await postForm(
    GOOGLE_OAUTH_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code: credentials.code,
      redirect_uri: credentials.redirectUri,
    },
    options,
  );
  return {
    accessToken: body.access_token as string,
    refreshToken: (body.refresh_token as string) ?? null,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : null,
    scope: (body.scope as string) ?? null,
    tokenType: (body.token_type as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * Google Ads is a per-tenant OAuth connection (each tenant advertises from
 * its own Google Ads account) — the refresh token and customer id are
 * stored via the EXISTING integrationCredentials.ts mechanism
 * (integrations.encrypted_credential_ref carries the refresh token;
 * non-secret config carries customerId/loginCustomerId), never a second
 * credential store. GOOGLE_ADS_CLIENT_ID/_CLIENT_SECRET/_DEVELOPER_TOKEN
 * are platform-level (the single registered OAuth app + developer token
 * this deployment uses for every tenant) and so remain env vars, same
 * convention as every other provider's env fallback in config/env.ts.
 */
export interface GoogleAdsTenantCredential {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId: string | null;
}

export async function resolveGoogleAdsCredential(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<GoogleAdsTenantCredential | null> {
  const clientId = env.googleAdsClientId;
  const clientSecret = env.googleAdsClientSecret;
  const developerToken = env.googleAdsDeveloperToken;
  if (!clientId || !clientSecret || !developerToken) return null;

  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "google_ads");
  const refreshToken = resolved?.secret ?? env.googleAdsRefreshToken ?? null;
  const customerId = (resolved?.config?.customerId as string | undefined) ?? env.googleAdsCustomerId ?? null;
  if (!refreshToken || !customerId) return null;

  return {
    clientId,
    clientSecret,
    developerToken,
    refreshToken,
    customerId: customerId.replace(/-/g, ""),
    loginCustomerId: ((resolved?.config?.loginCustomerId as string | undefined) ?? null)?.replace(/-/g, "") ?? null,
  };
}

// ---------------------------------------------------------------------------
// GAQL reporting
// ---------------------------------------------------------------------------

interface RawGaqlSearchResponse {
  results?: Array<{
    campaign?: { id?: string; name?: string };
    metrics?: { impressions?: string; clicks?: string; costMicros?: string };
    segments?: { date?: string };
  }>;
  error?: { message?: string };
}

/** Runs one GAQL query against the Google Ads Search endpoint for
 * `customerId` and returns the raw (unpaginated — bounded by the caller's
 * query LIMIT) result rows. Real error bodies are surfaced as
 * GoogleAdsApiError; never silently swallowed. */
export async function runGoogleAdsQuery(
  credential: GoogleAdsTenantCredential,
  accessToken: string,
  gaql: string,
  options: { timeoutMs?: number; fetcher?: GoogleAdsFetcher } = {},
): Promise<RawGaqlSearchResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "developer-token": credential.developerToken,
  };
  if (credential.loginCustomerId) headers["login-customer-id"] = credential.loginCustomerId;

  let response: Response;
  try {
    response = await fetcher(`${GOOGLE_ADS_API_BASE}/customers/${credential.customerId}/googleAds:search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: gaql }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new GoogleAdsTimeoutError(timeoutMs);
    throw new GoogleAdsNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  let body: RawGaqlSearchResponse | null = null;
  try {
    body = (await response.json()) as RawGaqlSearchResponse;
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new GoogleAdsApiError(body?.error?.message ?? `Google Ads API returned HTTP ${response.status}`, response.status);
  }
  return body ?? {};
}

// ---------------------------------------------------------------------------
// AdsChannelProvider adapter
// ---------------------------------------------------------------------------

/**
 * Real AdsChannelProvider backed by the Google Ads API. `campaignExternalId`
 * is the Google Ads campaign.id. Queries the trailing 30 days
 * (segments.date, inclusive) and sums impressions/clicks/cost across that
 * range — never fabricated; every number here is copied verbatim/summed
 * from Google's own response rows.
 */
export class GoogleAdsProvider implements AdsChannelProvider {
  readonly name = "google_ads";

  constructor(private readonly credential: GoogleAdsTenantCredential) {}

  async getCampaignPerformance(campaignExternalId: string): Promise<AdCampaignPerformance> {
    const token = await refreshGoogleAdsAccessToken(this.credential);

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const gaql = `
      SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, segments.date
      FROM campaign
      WHERE campaign.id = ${JSON.stringify(campaignExternalId).replace(/^"|"$/g, "")}
        AND segments.date BETWEEN '${fmt(periodStart)}' AND '${fmt(periodEnd)}'
    `.trim();

    const response = await runGoogleAdsQuery(this.credential, token.accessToken, gaql);
    const rows = response.results ?? [];

    let impressions = 0;
    let clicks = 0;
    let costMicros = 0;
    for (const row of rows) {
      impressions += Number(row.metrics?.impressions ?? 0);
      clicks += Number(row.metrics?.clicks ?? 0);
      costMicros += Number(row.metrics?.costMicros ?? 0);
    }

    return {
      campaignExternalId,
      impressions,
      clicks,
      spendCents: Math.round(costMicros / 10_000), // cost_micros: 1,000,000 = 1 currency unit = 100 cents
      periodStart: fmt(periodStart),
      periodEnd: fmt(periodEnd),
    };
  }
}

/** Honest stub mirroring NotConfiguredGoogleAdsProvider's exact convention. */
export class NotConfiguredGoogleAdsClientProvider implements AdsChannelProvider {
  readonly name = "google_ads (not configured)";

  async getCampaignPerformance(_campaignExternalId: string): Promise<never> {
    throw new NotConfiguredError(
      "Google Ads is not configured for this tenant/project (no connected google_ads integration and no " +
        "GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET/GOOGLE_ADS_DEVELOPER_TOKEN/customer id available). Connect " +
        "Google Ads via POST .../integrations/google_ads/connect first. Refusing to fabricate spend/impressions/clicks.",
    );
  }
}

/** Builds the real-or-stub Google Ads provider for one tenant/project —
 * the real factory callers should use, mirroring getSocialPostProvider()'s
 * shape in channelProviders.ts. */
export async function buildGoogleAdsProviderForTenant(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<AdsChannelProvider> {
  const credential = await resolveGoogleAdsCredential(tenantDb, tenantId, projectId);
  return credential ? new GoogleAdsProvider(credential) : new NotConfiguredGoogleAdsClientProvider();
}
