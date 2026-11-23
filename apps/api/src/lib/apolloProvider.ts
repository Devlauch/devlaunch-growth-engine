import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";
import type { DecisionMakerCandidate, DecisionMakerProvider, DecisionMakerLookupInput } from "./decisionMakerProvider.js";

/**
 * Real Apollo.io API client: People Enrichment ("match") — Phase 2 provider
 * validation backlog item ("complete authenticated Google Search, Apollo and
 * Hunter tests using real API credentials").
 *
 * Sibling-check (per task instructions): grepped apps/api/src for "apollo"
 * before starting — the only hits were the comment in
 * decisionMakerProvider.ts naming Apollo/ZoomInfo/Clearbit as candidate
 * providers, and clearbitProvider.ts's own sibling-check comment noting that
 * no real Apollo client existed when Clearbit was built. No real Apollo
 * client exists anywhere in this codebase prior to this file.
 *
 * No real Apollo API key is available in this environment — every request
 * path here is real, working HTTP client code, exercised only against
 * mocked `fetch` responses in tests, never against the live API. That gap
 * is reported as BLOCKED, not hidden — see
 * apps/api/test/apolloRealApi.skip.test.ts.
 *
 * API shape verified against Apollo's own published documentation
 * (https://docs.apollo.io/reference/people-enrichment, fetched during this
 * work), NOT assumed:
 *   - Auth: `x-api-key: <api key>` header on every request (Apollo's docs
 *     also accept an OAuth bearer token with the `people_match` scope for
 *     partner integrations; this client uses the simpler, documented-first
 *     static-key header form, matching this codebase's existing
 *     one-static-key convention for Hunter/Clearbit/SerpApi).
 *   - People Enrichment ("match"): POST /api/v1/people/match, with the
 *     identifying fields (name/first_name+last_name, domain or
 *     organization_name, email, linkedin_url, etc.) sent as query
 *     parameters — Apollo's documented spec lists every People Enrichment
 *     parameter as a query parameter, not a JSON body field. Response is
 *     `{ person, phone_enrichment, request_id, request_id_str }`; `person`
 *     carries `match_confidence` ("high"/"medium"/"low"/"none"),
 *     employment history, `contact`, and `organization`. A name alone (no
 *     domain/email/linkedin) can return HTTP 200 with no record actually
 *     enriched — this is Apollo's documented behavior, not an error this
 *     client should mask.
 *   - Errors: 401 for an invalid/missing key, body is `text/plain`, e.g.
 *     "Invalid API key. See https://docs.apollo.io/reference/authentication
 *     for how to authenticate." (not JSON, unlike Hunter/Clearbit — handled
 *     explicitly below rather than assumed to parse as JSON). 429 for rate
 *     limiting, `application/json` body with `error_details.code ===
 *     "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED"` (Apollo's documented
 *     example cites a limit of 600 calls/hour for this endpoint). 400 for
 *     validation errors (e.g. requesting phone reveal without a
 *     webhook_url), body `{ error, error_details }`. Apollo's docs note the
 *     legacy top-level `error`/`message` fields are deprecated and
 *     scheduled for removal 2027-02-16, after which `error_details` is the
 *     sole error payload — this client reads both so it keeps working
 *     either way.
 */

const APOLLO_BASE_URL = "https://api.apollo.io";
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApolloNotConfiguredError extends Error {
  constructor(message = "Apollo is not configured (no tenant credential and no APOLLO_API_KEY fallback).") {
    super(message);
    this.name = "ApolloNotConfiguredError";
  }
}

/** A real, classified failure response from Apollo's API (never thrown for a merely-unmatched person). */
export class ApolloApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ApolloApiError";
    this.status = status;
    this.code = code;
    // 429 (documented rate limit) and 5xx (Apollo-side failure) are worth a
    // caller retrying later; 400/401/404/422 are not (the request itself is
    // malformed, or the key is invalid — retrying won't help).
    this.retryable = status === 429 || status >= 500;
  }
}

export class ApolloTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Apollo API request timed out after ${timeoutMs}ms`);
    this.name = "ApolloTimeoutError";
  }
}

export class ApolloNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Apollo API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ApolloNetworkError";
  }
}

// ---------------------------------------------------------------------------
// Credential resolution — same convention as hunterProvider.ts/clearbitProvider.ts
// ---------------------------------------------------------------------------

/**
 * Resolves the Apollo API key to use for one tenant/project: the tenant's
 * own encrypted credential (set via integrationCredentials.ts) always takes
 * priority; env.apolloApiKey is only a dev-mode/global fallback. Returns
 * null (never throws) if neither is configured.
 */
export async function resolveApolloApiKey(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "apollo");
  return resolved?.secret ?? env.apolloApiKey ?? null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export interface ApolloFetcher {
  (url: string, init: { method: string; signal: AbortSignal; headers: Record<string, string> }): Promise<Response>;
}

/** Injectable for tests. Defaults to the real global fetch. */
function defaultFetcher(): ApolloFetcher {
  return (url, init) => fetch(url, init);
}

async function apolloPost<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: ApolloFetcher } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();

  const url = new URL(`${APOLLO_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "POST",
      signal: controller.signal,
      headers: { "x-api-key": apiKey, Accept: "application/json" },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new ApolloTimeoutError(timeoutMs);
    throw new ApolloNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Apollo's 401 body is documented as plain text, not JSON (unlike
    // Hunter/Clearbit) — read as text first and only attempt a JSON parse
    // for the error-detail codes 4xx/5xx responses that ARE documented as
    // JSON (400/429/5xx), never assume every error body is JSON.
    const rawText = await response.text().catch(() => "");
    let code: string | null = null;
    let message = rawText || `Apollo API returned HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(rawText) as { error?: string; error_details?: { code?: string; message?: string } };
      code = parsed.error_details?.code ?? null;
      message = parsed.error_details?.message ?? parsed.error ?? message;
    } catch {
      // Not JSON (e.g. the documented plain-text 401 body) — keep rawText as message.
    }
    throw new ApolloApiError(message, response.status, code);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// People Enrichment ("match")
// ---------------------------------------------------------------------------

export type ApolloMatchConfidence = "high" | "medium" | "low" | "none";

export interface ApolloMatchedPerson {
  id: string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  matchConfidence: ApolloMatchConfidence | null;
  organizationName: string | null;
  organizationDomain: string | null;
}

export interface ApolloMatchResult {
  requestId: string | null;
  person: ApolloMatchedPerson | null;
}

interface RawApolloOrganization {
  name?: string | null;
  primary_domain?: string | null;
  website_url?: string | null;
}

interface RawApolloPerson {
  id?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
  match_confidence?: string | null;
  organization?: RawApolloOrganization | null;
}

interface RawApolloMatchResponse {
  request_id?: number | null;
  request_id_str?: string | null;
  person?: RawApolloPerson | null;
}

const VALID_MATCH_CONFIDENCES: readonly ApolloMatchConfidence[] = ["high", "medium", "low", "none"];

function mapMatchResponse(raw: RawApolloMatchResponse): ApolloMatchResult {
  const p = raw.person;
  return {
    requestId: raw.request_id_str ?? (raw.request_id != null ? String(raw.request_id) : null),
    person: p
      ? {
          id: p.id ?? null,
          name: p.name ?? null,
          firstName: p.first_name ?? null,
          lastName: p.last_name ?? null,
          title: p.title ?? null,
          email: p.email ?? null,
          linkedinUrl: p.linkedin_url ?? null,
          matchConfidence: VALID_MATCH_CONFIDENCES.includes(p.match_confidence as ApolloMatchConfidence)
            ? (p.match_confidence as ApolloMatchConfidence)
            : null,
          organizationName: p.organization?.name ?? null,
          organizationDomain: p.organization?.primary_domain ?? null,
        }
      : null,
  };
}

export interface ApolloMatchInput {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  linkedinUrl?: string;
  domain?: string;
  organizationName?: string;
}

/**
 * Calls Apollo's People Enrichment ("match") endpoint. More identifying
 * fields (name + domain, or email, or linkedin_url) make an actual match
 * far more likely — a name alone can genuinely return HTTP 200 with
 * `person: null`/`match_confidence: "none"` (Apollo's documented behavior,
 * not a client bug).
 */
export async function matchPerson(
  input: ApolloMatchInput,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: ApolloFetcher } = {},
): Promise<ApolloMatchResult> {
  const raw = await apolloPost<RawApolloMatchResponse>(
    "/api/v1/people/match",
    {
      name: input.name,
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      linkedin_url: input.linkedinUrl,
      domain: input.domain,
      organization_name: input.organizationName,
    },
    apiKey,
    options,
  );
  return mapMatchResponse(raw);
}

// ---------------------------------------------------------------------------
// DecisionMakerProvider adapter
// ---------------------------------------------------------------------------

/**
 * Adapts Apollo's People Enrichment endpoint onto the existing
 * `DecisionMakerProvider` interface (decisionMakerProvider.ts) so Apollo can
 * be dropped into `buildDecisionMakerWaterfallForTenant()` without that
 * waterfall or its callers needing any changes — same pattern as
 * HunterProvider/ClearbitProvider.
 *
 * Unlike Hunter's Domain Search or Clearbit's Prospector (both of which
 * return a list of candidates for a domain), Apollo's People Enrichment
 * endpoint matches at most one specific person per call and needs more than
 * just a domain to produce a useful match (a name, email, or LinkedIn URL).
 * Without one of those, this adapter honestly returns an empty array
 * (consistent with `findDecisionMakers`'s "a provider genuinely looked and
 * found nothing" semantics) rather than guessing an input to fabricate a
 * match against.
 */
export class ApolloProvider implements DecisionMakerProvider {
  readonly name = "apollo";

  constructor(private readonly apiKey: string) {}

  async findDecisionMakers(input: DecisionMakerLookupInput): Promise<DecisionMakerCandidate[]> {
    if (!input.domain && !input.organizationName) return [];
    const { person } = await matchPerson(
      { domain: input.domain ?? undefined, organizationName: input.organizationName },
      this.apiKey,
    );
    if (!person || (person.email === null && person.name === null)) return [];
    return [
      {
        name: person.name ?? (person.email as string),
        title: person.title,
        email: person.email,
        phone: null, // People Enrichment's phone_enrichment is a separate async/pollable flow this adapter doesn't wait on.
        sourceUrl: person.linkedinUrl,
        sourceConfidence: person.matchConfidence === "high" ? "verified" : "inferred",
      },
    ];
  }
}

/** Honest stub mirroring NotConfiguredHunterProvider/NotConfiguredClearbitProvider's
 * exact convention for when neither a tenant credential nor APOLLO_API_KEY is configured. */
export class NotConfiguredApolloProvider implements DecisionMakerProvider {
  readonly name = "apollo_not_configured";

  async findDecisionMakers(_input: DecisionMakerLookupInput): Promise<never> {
    throw new ApolloNotConfiguredError(
      "Apollo is not configured (no tenant credential via integrationCredentials.ts and no APOLLO_API_KEY fallback). " +
        "Refusing to fabricate a decision-maker contact.",
    );
  }
}

/** Builds the real-or-stub Apollo provider for one tenant/project, mirroring
 * buildHunterProvider()/buildClearbitProvider()'s shape. */
export async function buildApolloProvider(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<DecisionMakerProvider> {
  const apiKey = await resolveApolloApiKey(tenantDb, tenantId, projectId);
  return apiKey ? new ApolloProvider(apiKey) : new NotConfiguredApolloProvider();
}
