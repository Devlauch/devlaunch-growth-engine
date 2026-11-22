import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";
import type { DecisionMakerCandidate, DecisionMakerProvider, DecisionMakerLookupInput } from "./decisionMakerProvider.js";

/**
 * Real Hunter.io API client: Domain Search (contact discovery) + Email
 * Verifier (paid verification tier). No real Hunter API key is available in
 * this environment (see docs/PHASE_2_HUNTER_VALIDATION.md) — every request
 * path here is real, working HTTP client code, but it has only ever been
 * exercised against mocked `fetch` responses in this codebase's test suite,
 * never against Hunter's live API. That specific gap is reported as BLOCKED
 * in the deliverable doc, not hidden.
 *
 * API shape verified against Hunter's own published documentation
 * (https://hunter.io/api-documentation/v2, fetched during this work) rather
 * than assumed:
 *   - Auth: `api_key` query parameter on every request (also documented:
 *     X-API-KEY header / Authorization: Bearer are accepted alternatives —
 *     this client uses the query-param form, which is what Hunter's own
 *     docs lead with and what every example URL in the docs uses).
 *   - Domain Search: GET /v2/domain-search?domain=...&api_key=...,
 *     paginated via `limit` (default 10, max 100) + `offset` (default 0),
 *     with `meta.results` giving the total match count (and
 *     `meta.results_approximate` when that count is a capped lower bound).
 *   - Email Verifier: GET /v2/email-verifier?email=...&api_key=...,
 *     returning `data.status` (valid/invalid/accept_all/webmail/
 *     disposable/unknown) plus supporting booleans (regexp, mx_records,
 *     smtp_server, smtp_check, accept_all, disposable, webmail, block) and
 *     `data.score`. Can return 202 (still processing — the docs say poll
 *     the same endpoint) or 222 (SMTP check failed, retry later).
 *   - Errors: `{"errors":[{"id","code","details"}]}` body shape; 401 for a
 *     bad/missing key, 403 for a per-second/minute rate limit, 429 for a
 *     plan/usage-limit ceiling, 5xx for Hunter-side failures.
 *   - Credits: successful responses MAY include `X-Credits-Used` and
 *     `X-Credits-Unit` headers — captured when present, left null/unknown
 *     when Hunter doesn't send them, never guessed.
 */

const HUNTER_BASE_URL = "https://api.hunter.io/v2";
const DEFAULT_TIMEOUT_MS = 15_000;
const DOMAIN_SEARCH_PAGE_SIZE = 100; // Hunter's documented maximum `limit`.
const DOMAIN_SEARCH_MAX_PAGES = 10; // Hard safety cap (10 * 100 = 1,000 contacts/domain/run).

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HunterNotConfiguredError extends Error {
  constructor(message = "Hunter is not configured (no tenant credential and no HUNTER_API_KEY fallback).") {
    super(message);
    this.name = "HunterNotConfiguredError";
  }
}

/** A real, classified failure response from Hunter's API (never thrown for a merely-empty result). */
export class HunterApiError extends Error {
  readonly status: number;
  readonly code: string | number | null;
  readonly details: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: string | number | null, details: string | null) {
    super(message);
    this.name = "HunterApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    // 403 (per-second/minute rate limit), 429 (usage-limit ceiling, which
    // can still be transient near a monthly reset) and 5xx are all worth a
    // caller retrying later; 400/401/404/422 are not (the request itself is
    // wrong, or the key is invalid — retrying won't help).
    this.retryable = status === 403 || status === 429 || status >= 500;
  }
}

export class HunterTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Hunter API request timed out after ${timeoutMs}ms`);
    this.name = "HunterTimeoutError";
  }
}

export class HunterNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Hunter API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HunterNetworkError";
  }
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the Hunter API key to use for one tenant/project: the tenant's
 * own encrypted credential (set via integrationCredentials.ts) always takes
 * priority; env.hunterApiKey is only a dev-mode/global fallback — same
 * convention as every other optional provider key in config/env.ts. Returns
 * null (never throws) if neither is configured — callers decide whether
 * that's a hard error (NotConfiguredHunterProvider) or just "skip this
 * tier" (combined email verification).
 */
export async function resolveHunterApiKey(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  // getIntegrationCredential's declared param is the full pg.PoolClient, but
  // it only ever calls .query() on it (see integrationCredentials.ts) — this
  // narrow cast keeps every caller/test here free to pass a `{ query }`-only
  // fake, exactly like the rest of this module's functions, rather than
  // forcing a full real PoolClient through test doubles everywhere.
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "hunter");
  return resolved?.secret ?? env.hunterApiKey ?? null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export interface HunterRequestOutcome<T> {
  data: T;
  /** Hunter's own credit-usage headers for this call, when present. Never guessed. */
  credits: { used: number | null; unit: string | null };
}

export interface HunterFetcher {
  (url: string, init: { signal: AbortSignal }): Promise<Response>;
}

/** Injectable for tests. Defaults to the real global fetch. */
function defaultFetcher(): HunterFetcher {
  return (url, init) => fetch(url, init);
}

async function hunterGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: HunterFetcher } = {},
): Promise<HunterRequestOutcome<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();

  const url = new URL(`${HUNTER_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("api_key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(url.toString(), { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new HunterTimeoutError(timeoutMs);
    }
    throw new HunterNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  const creditsUsedHeader = response.headers.get("X-Credits-Used");
  const credits = {
    used: creditsUsedHeader !== null && creditsUsedHeader !== "" ? Number(creditsUsedHeader) : null,
    unit: response.headers.get("X-Credits-Unit"),
  };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  // 202 (still processing) and 222 (SMTP check failed, retry later) are
  // technically within fetch's 200-299 "ok" range, but neither is a
  // settled, usable response for Hunter's Email Verifier — both need
  // special "not finished yet" handling by the caller (see
  // verifyEmailWithHunter), so they're surfaced the same way a genuine
  // error status would be, via a thrown HunterApiError the caller can
  // distinguish by status code, rather than silently treated as success.
  const isUnsettled = response.status === 202 || response.status === 222;

  if (!response.ok || isUnsettled) {
    const errors = (body as { errors?: { id?: string; code?: string | number; details?: string }[] } | null)?.errors;
    const first = errors?.[0];
    throw new HunterApiError(
      first?.details ?? (isUnsettled ? `Hunter API request not yet settled (HTTP ${response.status})` : `Hunter API returned HTTP ${response.status}`),
      response.status,
      first?.code ?? null,
      first?.details ?? null,
    );
  }

  return { data: body as T, credits };
}

// ---------------------------------------------------------------------------
// Domain Search (contact discovery)
// ---------------------------------------------------------------------------

export interface HunterEmailSource {
  domain: string | null;
  uri: string | null;
  extractedOn: string | null;
}

/** One contact record from a Hunter Domain Search response. Every field here
 * traces directly to a field Hunter's API actually returned — see the field
 * mapping comment on `mapDomainSearchResponse` below. Hunter's Domain Search
 * response does not include a provider-assigned unique id per email record
 * (confirmed against its documented response shape) — `value` (the email
 * address itself) is the closest thing to a stable per-record identifier
 * Hunter exposes, and is used as `providerRecordId` for provenance
 * purposes. */
export interface HunterContactRecord {
  email: string | null;
  providerRecordId: string | null;
  type: "personal" | "generic" | null;
  provenance: "found" | "inferred" | null;
  confidence: number | null;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  seniority: string | null;
  department: string | null;
  phoneNumber: string | null;
  linkedin: string | null;
  twitter: string | null;
  sources: HunterEmailSource[];
  priorVerification: { date: string | null; status: string | null } | null;
}

export interface HunterDomainSearchPage {
  domain: string;
  organization: string | null;
  pattern: string | null;
  acceptAll: boolean;
  disposable: boolean;
  webmail: boolean;
  contacts: HunterContactRecord[];
  meta: { results: number; resultsApproximate: boolean; limit: number; offset: number };
  credits: { used: number | null; unit: string | null };
}

interface RawHunterDomainSearchResponse {
  data?: {
    domain?: string;
    organization?: string | null;
    pattern?: string | null;
    accept_all?: boolean;
    disposable?: boolean;
    webmail?: boolean;
    emails?: Array<{
      value?: string | null;
      type?: string | null;
      provenance?: string | null;
      confidence?: number | null;
      first_name?: string | null;
      last_name?: string | null;
      position?: string | null;
      seniority?: string | null;
      department?: string | null;
      phone_number?: string | null;
      linkedin?: string | null;
      twitter?: string | null;
      sources?: Array<{ domain?: string | null; uri?: string | null; extracted_on?: string | null }>;
      verification?: { date?: string | null; status?: string | null } | null;
    }>;
  };
  meta?: { results?: number; results_approximate?: boolean; limit?: number; offset?: number };
}

function mapDomainSearchResponse(
  domain: string,
  outcome: HunterRequestOutcome<RawHunterDomainSearchResponse>,
): HunterDomainSearchPage {
  const { data } = outcome;
  const emails = data.data?.emails ?? [];
  return {
    domain: data.data?.domain ?? domain,
    organization: data.data?.organization ?? null,
    pattern: data.data?.pattern ?? null,
    acceptAll: data.data?.accept_all ?? false,
    disposable: data.data?.disposable ?? false,
    webmail: data.data?.webmail ?? false,
    contacts: emails.map((e) => ({
      email: e.value ?? null,
      providerRecordId: e.value ?? null,
      type: e.type === "personal" || e.type === "generic" ? e.type : null,
      provenance: e.provenance === "found" || e.provenance === "inferred" ? e.provenance : null,
      confidence: typeof e.confidence === "number" ? e.confidence : null,
      firstName: e.first_name ?? null,
      lastName: e.last_name ?? null,
      position: e.position ?? null,
      seniority: e.seniority ?? null,
      department: e.department ?? null,
      phoneNumber: e.phone_number ?? null,
      linkedin: e.linkedin ?? null,
      twitter: e.twitter ?? null,
      sources: (e.sources ?? []).map((s) => ({
        domain: s.domain ?? null,
        uri: s.uri ?? null,
        extractedOn: s.extracted_on ?? null,
      })),
      priorVerification: e.verification ? { date: e.verification.date ?? null, status: e.verification.status ?? null } : null,
    })),
    meta: {
      results: data.meta?.results ?? emails.length,
      resultsApproximate: data.meta?.results_approximate ?? false,
      limit: data.meta?.limit ?? emails.length,
      offset: data.meta?.offset ?? 0,
    },
    credits: outcome.credits,
  };
}

export interface HunterDomainSearchOptions {
  limit?: number;
  offset?: number;
  timeoutMs?: number;
  fetcher?: HunterFetcher;
}

/** One page of Hunter's Domain Search. Callers that want every contact
 * should use `searchDomainAllPages` instead, which handles pagination. */
export async function searchDomainPage(
  domain: string,
  apiKey: string,
  options: HunterDomainSearchOptions = {},
): Promise<HunterDomainSearchPage> {
  const outcome = await hunterGet<RawHunterDomainSearchResponse>(
    "/domain-search",
    { domain, limit: options.limit ?? DOMAIN_SEARCH_PAGE_SIZE, offset: options.offset ?? 0 },
    apiKey,
    { timeoutMs: options.timeoutMs, fetcher: options.fetcher },
  );
  return mapDomainSearchResponse(domain, outcome);
}

/**
 * Walks every page of Hunter's Domain Search for `domain`, using
 * `meta.results` to know when to stop (and `resultsApproximate` to know
 * when that total is only a lower bound). Bounded by
 * `DOMAIN_SEARCH_MAX_PAGES` so a single call can never run away against an
 * enormous or misreported result count.
 */
export async function searchDomainAllPages(
  domain: string,
  apiKey: string,
  options: Omit<HunterDomainSearchOptions, "offset"> & { maxPages?: number } = {},
): Promise<{ contacts: HunterContactRecord[]; pages: HunterDomainSearchPage[]; truncated: boolean }> {
  const limit = options.limit ?? DOMAIN_SEARCH_PAGE_SIZE;
  const maxPages = options.maxPages ?? DOMAIN_SEARCH_MAX_PAGES;

  const pages: HunterDomainSearchPage[] = [];
  const contacts: HunterContactRecord[] = [];
  let offset = 0;
  let truncated = false;

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const page = await searchDomainPage(domain, apiKey, { ...options, limit, offset });
    pages.push(page);
    contacts.push(...page.contacts);

    const fetchedSoFar = offset + page.contacts.length;
    if (page.contacts.length === 0 || fetchedSoFar >= page.meta.results) {
      truncated = false;
      break;
    }
    offset += limit;
    if (pageNum === maxPages - 1) truncated = true;
  }

  return { contacts, pages, truncated };
}

// ---------------------------------------------------------------------------
// Email Verifier
// ---------------------------------------------------------------------------

export type HunterVerifierStatus = "valid" | "invalid" | "accept_all" | "webmail" | "disposable" | "unknown";

export interface HunterEmailVerifierResult {
  email: string;
  status: HunterVerifierStatus;
  score: number | null;
  regexp: boolean | null;
  gibberish: boolean | null;
  disposable: boolean | null;
  webmail: boolean | null;
  mxRecords: boolean | null;
  smtpServer: boolean | null;
  smtpCheck: boolean | null;
  acceptAll: boolean | null;
  block: boolean | null;
  verifiedAt: string | null;
  /** True if Hunter returned 202/222 (still processing / SMTP check
   * temporarily failed) rather than a settled result — callers should treat
   * this as "unknown for now", not as a provider error. */
  inProgress: boolean;
  credits: { used: number | null; unit: string | null };
}

interface RawHunterVerifierResponse {
  data?: {
    status?: string;
    score?: number | null;
    email?: string;
    regexp?: boolean | null;
    gibberish?: boolean | null;
    disposable?: boolean | null;
    webmail?: boolean | null;
    mx_records?: boolean | null;
    smtp_server?: boolean | null;
    smtp_check?: boolean | null;
    accept_all?: boolean | null;
    block?: boolean | null;
    verification?: { date?: string | null; status?: string | null } | null;
  };
}

const VALID_VERIFIER_STATUSES: readonly HunterVerifierStatus[] = [
  "valid",
  "invalid",
  "accept_all",
  "webmail",
  "disposable",
  "unknown",
];

/**
 * Calls Hunter's Email Verifier for one address. Hunter's docs say this
 * request can take up to 20s server-side and may return 202 (not yet
 * finished — poll again) instead of a final result; a 222 means an SMTP
 * check failed and suggests retrying later. Both are surfaced via
 * `inProgress: true` rather than thrown as errors — neither is a provider
 * failure, both just mean "no settled answer yet".
 */
export async function verifyEmailWithHunter(
  email: string,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: HunterFetcher } = {},
): Promise<HunterEmailVerifierResult> {
  let outcome: HunterRequestOutcome<RawHunterVerifierResponse>;
  try {
    outcome = await hunterGet<RawHunterVerifierResponse>("/email-verifier", { email }, apiKey, options);
  } catch (err) {
    if (err instanceof HunterApiError && (err.status === 202 || err.status === 222)) {
      return {
        email,
        status: "unknown",
        score: null,
        regexp: null,
        gibberish: null,
        disposable: null,
        webmail: null,
        mxRecords: null,
        smtpServer: null,
        smtpCheck: null,
        acceptAll: null,
        block: null,
        verifiedAt: null,
        inProgress: true,
        credits: { used: null, unit: null },
      };
    }
    throw err;
  }

  const d = outcome.data.data ?? {};
  const status = VALID_VERIFIER_STATUSES.includes(d.status as HunterVerifierStatus)
    ? (d.status as HunterVerifierStatus)
    : "unknown";

  return {
    email: d.email ?? email,
    status,
    score: typeof d.score === "number" ? d.score : null,
    regexp: d.regexp ?? null,
    gibberish: d.gibberish ?? null,
    disposable: d.disposable ?? null,
    webmail: d.webmail ?? null,
    mxRecords: d.mx_records ?? null,
    smtpServer: d.smtp_server ?? null,
    smtpCheck: d.smtp_check ?? null,
    acceptAll: d.accept_all ?? null,
    block: d.block ?? null,
    verifiedAt: d.verification?.date ?? null,
    inProgress: false,
    credits: outcome.credits,
  };
}

// ---------------------------------------------------------------------------
// DecisionMakerProvider adapter
// ---------------------------------------------------------------------------

/**
 * Adapts Hunter's Domain Search onto the existing `DecisionMakerProvider`
 * interface (decisionMakerProvider.ts) so Hunter can be dropped straight
 * into `buildDecisionMakerWaterfall()` ahead of
 * `NotConfiguredDecisionMakerProvider`, without that waterfall or its
 * callers needing any changes.
 *
 * Divergence from a "pure" DecisionMakerProvider: Hunter's response carries
 * materially more fidelity than `DecisionMakerCandidate` can represent
 * (per-source timestamps, Hunter's own confidence score, seniority/
 * department, pagination metadata, accept-all/disposable domain flags,
 * credit usage). Rather than lossily cramming all of that into
 * `DecisionMakerCandidate` or widening that shared interface for one
 * provider, this class implements `findDecisionMakers` as a thin,
 * intentionally-lossy adapter for waterfall compatibility, and separately
 * exposes `searchDomain`/`searchDomainAllPages` (above) as the
 * full-fidelity path real Hunter-specific callers (the Hunter contact
 * discovery route/job) should use directly. This mirrors how
 * `companyEnrichment.ts` already composes richer provider-specific data
 * without changing the shared scoring interfaces.
 *
 * `sourceConfidence` mapping (never invents "verified"): Hunter's own
 * `provenance` field distinguishes a directly-found record ('found') from
 * one it inferred from a pattern/heuristic ('inferred') — mapped 1:1 onto
 * `DecisionMakerCandidate.sourceConfidence`'s 'verified'/'inferred'.
 * 'unconfirmed' is never produced by this adapter (Hunter doesn't expose a
 * third tier); it remains available in the shared type for other
 * providers.
 */
export class HunterProvider implements DecisionMakerProvider {
  readonly name = "hunter";

  constructor(private readonly apiKey: string) {}

  async findDecisionMakers(input: DecisionMakerLookupInput): Promise<DecisionMakerCandidate[]> {
    if (!input.domain) return [];
    const { contacts } = await searchDomainAllPages(input.domain, this.apiKey);
    return contacts
      .filter((c) => c.email !== null)
      .map((c): DecisionMakerCandidate => ({
        // DecisionMakerCandidate.name is a required string (the shared
        // interface has no "unknown name" case) — when Hunter gave us no
        // real first/last name (a role/generic inbox), the email address
        // itself (real data Hunter actually returned) is used rather than
        // fabricating a person's name.
        name: c.firstName || c.lastName ? [c.firstName, c.lastName].filter(Boolean).join(" ") : (c.email as string),
        title: c.position,
        email: c.email,
        phone: c.phoneNumber,
        sourceUrl: c.sources[0]?.uri ?? null,
        sourceConfidence: c.provenance === "found" ? "verified" : "inferred",
      }))
      // never fabricate a candidate with a null name AND null title when
      // Hunter gave us nothing to go on beyond a bare role email — those
      // are still real/useful but filtered to the (email-only) minimum
      // identity already enforced at the DB layer, not dropped here.
      ;
  }
}

/** Honest stub mirroring `NotConfiguredDecisionMakerProvider`'s exact
 * convention (decisionMakerProvider.ts) for when neither a tenant
 * credential nor `HUNTER_API_KEY` is configured. */
export class NotConfiguredHunterProvider implements DecisionMakerProvider {
  readonly name = "hunter_not_configured";

  async findDecisionMakers(_input: DecisionMakerLookupInput): Promise<never> {
    throw new HunterNotConfiguredError(
      "Hunter is not configured (no tenant credential via integrationCredentials.ts and no HUNTER_API_KEY fallback). " +
        "Refusing to fabricate a decision-maker contact.",
    );
  }
}

/** Builds the real-or-stub Hunter provider for one tenant/project, mirroring
 * `buildDecisionMakerWaterfall()`'s shape so a caller can prepend this to
 * that waterfall once desired. */
export async function buildHunterProvider(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<DecisionMakerProvider> {
  const apiKey = await resolveHunterApiKey(tenantDb, tenantId, projectId);
  return apiKey ? new HunterProvider(apiKey) : new NotConfiguredHunterProvider();
}
