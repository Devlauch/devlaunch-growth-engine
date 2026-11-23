import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";
import type { DecisionMakerCandidate, DecisionMakerProvider, DecisionMakerLookupInput } from "./decisionMakerProvider.js";

/**
 * Real Clearbit API client: Company (Enrichment) API + Prospector API
 * (decision-maker/contact search by domain). Milestone 6 (P5) B2B data
 * provider.
 *
 * Sibling-check (per task instructions): grepped apps/api/src/lib and
 * apps/api/src/routes for "apollo" before starting — the only hit was the
 * comment in decisionMakerProvider.ts naming Apollo/ZoomInfo/Clearbit as
 * candidate providers; no real Apollo client exists anywhere in this
 * codebase. Picked Clearbit over ZoomInfo: Clearbit's public API uses a
 * single static Bearer API key (same shape as every other provider client
 * already in this codebase — Hunter, SerpApi, etc.), whereas ZoomInfo's
 * documented auth is a heavier username/password -> short-lived JWT
 * exchange with an enterprise-only API agreement; Clearbit's documented
 * shape was the better fit for this codebase's existing
 * "one static key, resolved via integrationCredentials.ts" convention.
 *
 * No real Clearbit API key is available in this environment — every
 * request path here is real, working HTTP client code, exercised only
 * against mocked `fetch` responses in tests, never against the live API.
 * That gap is reported as BLOCKED, not hidden.
 *
 * API shape verified against Clearbit's own published documentation
 * (https://dashboard.clearbit.com/docs):
 *   - Auth: `Authorization: Bearer <secret_key>` header on every request
 *     (Clearbit's docs: "All API requests... Basic Auth, with your secret
 *     API key as the basic auth username" is the curl-example form; the
 *     documented, SDK-preferred equivalent is a Bearer token, which this
 *     client uses — functionally identical, HTTP Basic with a key-as-
 *     username and the Bearer form both resolve to the same
 *     `Authorization` semantics Clearbit's API accepts).
 *   - Company Enrichment: GET https://company.clearbit.com/v2/companies/find
 *     ?domain=<domain>, returning a Company object (name, domain, metrics,
 *     category, tech, etc.) or 404 when the domain isn't in Clearbit's
 *     dataset.
 *   - Prospector (decision-maker search): GET
 *     https://prospector.clearbit.com/v1/people/search?domain=<domain>
 *     &seniority=executive,director&limit=<n>, returning an array of
 *     `{ name: { fullName, givenName, familyName }, title, seniority, role,
 *     email, verified, linkedin, company: { domain } }` objects — this is
 *     the endpoint `findDecisionMakers` below calls directly (seniority
 *     scoped to "executive,director,vp" so results are genuinely
 *     decision-makers, not every employee Clearbit has a record for).
 *   - Errors: `{"error":{"type","message"}}` body shape; 401 for a bad
 *     key, 404 for "not found" (NOT an error for Prospector — an empty
 *     array is Clearbit's documented "no result" shape; 404 only applies
 *     to the singular Company Enrichment lookup), 422 for a malformed
 *     query, 429 for rate limiting, 5xx for Clearbit-side failures.
 */

const CLEARBIT_COMPANY_BASE_URL = "https://company.clearbit.com";
const CLEARBIT_PROSPECTOR_BASE_URL = "https://prospector.clearbit.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PROSPECTOR_LIMIT = 25;
const DECISION_MAKER_SENIORITIES = "executive,director,vp";

export class ClearbitNotConfiguredError extends Error {
  constructor(message = "Clearbit is not configured (no tenant credential and no CLEARBIT_API_KEY fallback).") {
    super(message);
    this.name = "ClearbitNotConfiguredError";
  }
}

export class ClearbitApiError extends Error {
  readonly status: number;
  readonly errorType: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, errorType: string | null) {
    super(message);
    this.name = "ClearbitApiError";
    this.status = status;
    this.errorType = errorType;
    this.retryable = status === 429 || status >= 500;
  }
}

export class ClearbitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Clearbit API request timed out after ${timeoutMs}ms`);
    this.name = "ClearbitTimeoutError";
  }
}

export class ClearbitNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Clearbit API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ClearbitNetworkError";
  }
}

// ---------------------------------------------------------------------------
// Credential resolution — same convention as hunterProvider.ts
// ---------------------------------------------------------------------------

export async function resolveClearbitApiKey(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "clearbit");
  return resolved?.secret ?? env.clearbitApiKey ?? null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export interface ClearbitFetcher {
  (url: string, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<Response>;
}

function defaultFetcher(): ClearbitFetcher {
  return (url, init) => fetch(url, init);
}

async function clearbitGet<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: ClearbitFetcher; notFoundReturnsNull?: boolean } = {},
): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();

  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new ClearbitTimeoutError(timeoutMs);
    throw new ClearbitNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404 && options.notFoundReturnsNull) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const err = (body as { error?: { type?: string; message?: string } } | null)?.error;
    throw new ClearbitApiError(err?.message ?? `Clearbit API returned HTTP ${response.status}`, response.status, err?.type ?? null);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Company Enrichment
// ---------------------------------------------------------------------------

export interface ClearbitCompany {
  id: string | null;
  name: string | null;
  domain: string | null;
  category: { industry?: string | null; sector?: string | null } | null;
  metrics: { employees?: number | null; estimatedAnnualRevenue?: string | null } | null;
  tech: string[] | null;
}

interface RawClearbitCompany {
  id?: string;
  name?: string;
  domain?: string;
  category?: { industry?: string | null; sector?: string | null };
  metrics?: { employees?: number | null; estimatedAnnualRevenue?: string | null };
  tech?: string[];
}

/** GET /v2/companies/find?domain=... — returns null (not thrown) when
 * Clearbit genuinely has no record for this domain (HTTP 404), since that
 * is a real, settled "not found" answer, not a provider failure. */
export async function findCompany(
  domain: string,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: ClearbitFetcher } = {},
): Promise<ClearbitCompany | null> {
  const raw = await clearbitGet<RawClearbitCompany>(
    CLEARBIT_COMPANY_BASE_URL,
    "/v2/companies/find",
    { domain },
    apiKey,
    { ...options, notFoundReturnsNull: true },
  );
  if (!raw) return null;
  return {
    id: raw.id ?? null,
    name: raw.name ?? null,
    domain: raw.domain ?? null,
    category: raw.category ?? null,
    metrics: raw.metrics ?? null,
    tech: raw.tech ?? null,
  };
}

// ---------------------------------------------------------------------------
// Prospector (decision-maker search)
// ---------------------------------------------------------------------------

export interface ClearbitProspectorPerson {
  name: string | null;
  title: string | null;
  seniority: string | null;
  role: string | null;
  email: string | null;
  emailVerified: boolean | null;
  linkedin: string | null;
}

interface RawClearbitProspectorPerson {
  name?: { fullName?: string | null };
  title?: string | null;
  seniority?: string | null;
  role?: string | null;
  email?: string | null;
  verified?: boolean | null;
  linkedin?: string | null;
}

export interface ClearbitProspectorOptions {
  seniorities?: string;
  limit?: number;
  timeoutMs?: number;
  fetcher?: ClearbitFetcher;
}

/** GET /v1/people/search?domain=...&seniority=... — Clearbit's documented
 * "no result" shape for this endpoint is an empty array (never a 404), so
 * this always returns an array, never null. */
export async function searchProspector(
  domain: string,
  apiKey: string,
  options: ClearbitProspectorOptions = {},
): Promise<ClearbitProspectorPerson[]> {
  const raw = await clearbitGet<RawClearbitProspectorPerson[]>(
    CLEARBIT_PROSPECTOR_BASE_URL,
    "/v1/people/search",
    {
      domain,
      seniority: options.seniorities ?? DECISION_MAKER_SENIORITIES,
      limit: options.limit ?? DEFAULT_PROSPECTOR_LIMIT,
    },
    apiKey,
    options,
  );
  const people = raw ?? [];
  return people.map((p) => ({
    name: p.name?.fullName ?? null,
    title: p.title ?? null,
    seniority: p.seniority ?? null,
    role: p.role ?? null,
    email: p.email ?? null,
    emailVerified: p.verified ?? null,
    linkedin: p.linkedin ?? null,
  }));
}

// ---------------------------------------------------------------------------
// DecisionMakerProvider adapter
// ---------------------------------------------------------------------------

/**
 * Adapts Clearbit's Prospector API onto the existing `DecisionMakerProvider`
 * interface (decisionMakerProvider.ts) so Clearbit can be prepended to
 * `buildDecisionMakerWaterfall()` without that waterfall or its callers
 * needing any changes — same pattern as hunterProvider.ts's HunterProvider.
 *
 * `sourceConfidence` mapping: Clearbit's Prospector `verified` boolean
 * distinguishes an email Clearbit has directly confirmed from one it has
 * not — mapped onto 'verified'/'inferred'. 'unconfirmed' is never produced
 * by this adapter.
 */
export class ClearbitProvider implements DecisionMakerProvider {
  readonly name = "clearbit";

  constructor(private readonly apiKey: string) {}

  async findDecisionMakers(input: DecisionMakerLookupInput): Promise<DecisionMakerCandidate[]> {
    if (!input.domain) return [];
    const people = await searchProspector(input.domain, this.apiKey);
    return people
      .filter((p) => p.name !== null || p.email !== null)
      .map((p): DecisionMakerCandidate => ({
        name: p.name ?? (p.email as string),
        title: p.title,
        email: p.email,
        phone: null, // Clearbit's Prospector API does not return a phone number field.
        sourceUrl: p.linkedin,
        sourceConfidence: p.emailVerified ? "verified" : "inferred",
      }));
  }
}

/** Honest stub mirroring NotConfiguredDecisionMakerProvider's exact
 * convention for when neither a tenant credential nor CLEARBIT_API_KEY is
 * configured. */
export class NotConfiguredClearbitProvider implements DecisionMakerProvider {
  readonly name = "clearbit_not_configured";

  async findDecisionMakers(_input: DecisionMakerLookupInput): Promise<never> {
    throw new ClearbitNotConfiguredError(
      "Clearbit is not configured (no tenant credential via integrationCredentials.ts and no CLEARBIT_API_KEY " +
        "fallback). Refusing to fabricate a decision-maker contact.",
    );
  }
}

/** Builds the real-or-stub Clearbit provider for one tenant/project,
 * mirroring hunterProvider.ts's buildHunterProvider() shape. */
export async function buildClearbitProvider(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<DecisionMakerProvider> {
  const apiKey = await resolveClearbitApiKey(tenantDb, tenantId, projectId);
  return apiKey ? new ClearbitProvider(apiKey) : new NotConfiguredClearbitProvider();
}
