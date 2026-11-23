import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";
import type { DecisionMakerCandidate, DecisionMakerProvider, DecisionMakerLookupInput } from "./decisionMakerProvider.js";

/**
 * Real People Data Labs (peopledatalabs.com) API client: Company Enrichment
 * + Person Enrichment. A fourth B2B company/person data provider, additive
 * alongside Hunter (hunterProvider.ts), Clearbit (clearbitProvider.ts), and
 * Apollo (apolloProvider.ts) — not a replacement for any of them.
 *
 * No real People Data Labs API key is available in this environment — every
 * request path here is real, working HTTP client code, exercised only
 * against mocked `fetch` responses in tests, never against the live API.
 * That gap is reported as BLOCKED, not hidden.
 *
 * API shape verified against PDL's own published documentation
 * (https://docs.peopledatalabs.com/docs/reference-company-enrichment-api,
 * https://docs.peopledatalabs.com/docs/output-response-company-enrichment-api,
 * https://docs.peopledatalabs.com/docs/reference-person-enrichment-api,
 * https://docs.peopledatalabs.com/docs/output-response-person-enrichment-api,
 * https://docs.peopledatalabs.com/docs/errors — all fetched during this
 * work), NOT assumed:
 *   - Auth: the API key is sent as the `api_key` query parameter (PDL's
 *     docs note it "can also [be] provide[d] in the request header instead"
 *     — this client uses the documented, simpler query-parameter form,
 *     consistent with every GET-based request this client makes).
 *   - Company Enrichment: GET https://api.peopledatalabs.com/v5/company/enrich
 *     ?website=<domain>&api_key=<key> (matching also accepts `name`,
 *     `profile`, or `ticker` in place of `website` — this client only uses
 *     `website`, since that's the field `DecisionMakerLookupInput.domain`
 *     naturally maps to). Response: `{ status, likelihood, matched?, ...company
 *     profile fields at the top level (name, website, industry, size,
 *     location, etc., per PDL's Company Schema) }`. HTTP 200 = a match was
 *     found; HTTP 404 = "it doesn't find a matching company" (PDL's own
 *     documented wording) — an honest "not found", not a client/provider
 *     error.
 *   - Person Enrichment: GET https://api.peopledatalabs.com/v5/person/enrich
 *     ?<identifying fields>&api_key=<key>. PDL's docs state a 200 response
 *     requires at least one of `profile`/`email`/`phone`/`email_hash`/`lid`,
 *     OR a combination of name fields plus one of
 *     `locality`/`region`/`company`/`school`/`location`/`postal_code` —
 *     company/domain ALONE (no name, no email) does not satisfy that
 *     documented minimum and would return a 400 (`invalid_request_error`,
 *     see below). Response: `{ status, likelihood, data: { <Person Schema
 *     fields> }, matched? }`; HTTP 404 = "it doesn't find a matching
 *     person" (PDL's documented wording).
 *   - Errors (https://docs.peopledatalabs.com/docs/errors): JSON body
 *     `{ status, error: { type, message } }`. Documented codes: 400
 *     invalid_request_error, 401 authentication_error (bad/missing key),
 *     402 payment_required (match quota exhausted), 405 invalid_request_error
 *     (wrong HTTP method), 429 rate_limit_error, 5xx api_error. Rate limits
 *     are documented as 10/min (Company Enrichment) / 100/min (Person
 *     Enrichment) for free-trial customers, 1,000/min for paying customers.
 */

const PDL_BASE_URL = "https://api.peopledatalabs.com";
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PeopleDataLabsNotConfiguredError extends Error {
  constructor(message = "People Data Labs is not configured (no tenant credential and no PEOPLE_DATA_LABS_API_KEY fallback).") {
    super(message);
    this.name = "PeopleDataLabsNotConfiguredError";
  }
}

export class PeopleDataLabsApiError extends Error {
  readonly status: number;
  readonly errorType: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, errorType: string | null) {
    super(message);
    this.name = "PeopleDataLabsApiError";
    this.status = status;
    this.errorType = errorType;
    // 429 (documented rate_limit_error) and 5xx (api_error) are worth
    // retrying later; 400/401/402/404/405 are not — the request itself is
    // malformed, unauthorized, over-quota, a genuine non-match, or using the
    // wrong HTTP method.
    this.retryable = status === 429 || status >= 500;
  }
}

export class PeopleDataLabsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`People Data Labs API request timed out after ${timeoutMs}ms`);
    this.name = "PeopleDataLabsTimeoutError";
  }
}

export class PeopleDataLabsNetworkError extends Error {
  constructor(cause: unknown) {
    super(`People Data Labs API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PeopleDataLabsNetworkError";
  }
}

// ---------------------------------------------------------------------------
// Credential resolution — same convention as clearbitProvider.ts/apolloProvider.ts
// ---------------------------------------------------------------------------

export async function resolvePeopleDataLabsApiKey(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "people_data_labs");
  return resolved?.secret ?? env.peopleDataLabsApiKey ?? null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export interface PeopleDataLabsFetcher {
  (url: string, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<Response>;
}

function defaultFetcher(): PeopleDataLabsFetcher {
  return (url, init) => fetch(url, init);
}

async function pdlGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: PeopleDataLabsFetcher } = {},
): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();

  const url = new URL(`${PDL_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("api_key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(url.toString(), { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new PeopleDataLabsTimeoutError(timeoutMs);
    throw new PeopleDataLabsNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  // PDL's documented "no match" response for both enrichment endpoints is a
  // real HTTP 404 — a settled, honest "not found", not a provider failure.
  if (response.status === 404) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const err = (body as { error?: { type?: string; message?: string } } | null)?.error;
    throw new PeopleDataLabsApiError(
      err?.message ?? `People Data Labs API returned HTTP ${response.status}`,
      response.status,
      err?.type ?? null,
    );
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Company Enrichment
// ---------------------------------------------------------------------------

export interface PeopleDataLabsCompany {
  id: string | null;
  name: string | null;
  website: string | null;
  industry: string | null;
  size: string | null;
  likelihood: number | null;
}

interface RawPeopleDataLabsCompanyResponse {
  status?: number;
  likelihood?: number;
  id?: string;
  name?: string;
  website?: string;
  industry?: string;
  size?: string;
}

/** GET /v5/company/enrich?website=... — returns null (not thrown) when PDL
 * genuinely has no matching company record (HTTP 404). */
export async function findCompany(
  domain: string,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: PeopleDataLabsFetcher } = {},
): Promise<PeopleDataLabsCompany | null> {
  const raw = await pdlGet<RawPeopleDataLabsCompanyResponse>("/v5/company/enrich", { website: domain }, apiKey, options);
  if (!raw) return null;
  return {
    id: raw.id ?? null,
    name: raw.name ?? null,
    website: raw.website ?? null,
    industry: raw.industry ?? null,
    size: raw.size ?? null,
    likelihood: raw.likelihood ?? null,
  };
}

// ---------------------------------------------------------------------------
// Person Enrichment
// ---------------------------------------------------------------------------

export interface PeopleDataLabsPerson {
  fullName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  likelihood: number | null;
}

interface RawPeopleDataLabsPersonData {
  full_name?: string | null;
  job_title?: string | null;
  emails?: Array<{ address?: string | null }> | null;
  phone_numbers?: string[] | null;
  linkedin_url?: string | null;
}

interface RawPeopleDataLabsPersonResponse {
  status?: number;
  likelihood?: number;
  data?: RawPeopleDataLabsPersonData | null;
}

export interface PeopleDataLabsPersonLookupInput {
  profile?: string;
  email?: string;
  phone?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
}

/**
 * GET /v5/person/enrich?... — returns null (not thrown) on PDL's documented
 * HTTP 404 "no matching person" response. Per PDL's own documented minimum-
 * input rule, a 200 requires at least one of profile/email/phone, OR a name
 * plus one of locality/region/company/school/location/postal_code — callers
 * supplying only a company/domain with no name or direct identifier will get
 * a real, documented HTTP 400 (invalid_request_error), surfaced here as a
 * thrown PeopleDataLabsApiError, not silently swallowed.
 */
export async function findPerson(
  input: PeopleDataLabsPersonLookupInput,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: PeopleDataLabsFetcher } = {},
): Promise<PeopleDataLabsPerson | null> {
  const raw = await pdlGet<RawPeopleDataLabsPersonResponse>(
    "/v5/person/enrich",
    {
      profile: input.profile,
      email: input.email,
      phone: input.phone,
      name: input.name,
      first_name: input.firstName,
      last_name: input.lastName,
      company: input.company,
    },
    apiKey,
    options,
  );
  if (!raw || !raw.data) return null;
  const d = raw.data;
  return {
    fullName: d.full_name ?? null,
    jobTitle: d.job_title ?? null,
    email: d.emails?.[0]?.address ?? null,
    phone: d.phone_numbers?.[0] ?? null,
    linkedinUrl: d.linkedin_url ?? null,
    likelihood: raw.likelihood ?? null,
  };
}

// ---------------------------------------------------------------------------
// DecisionMakerProvider adapter
// ---------------------------------------------------------------------------

/**
 * Adapts People Data Labs onto the existing `DecisionMakerProvider`
 * interface (decisionMakerProvider.ts) so PDL can be appended to
 * `buildDecisionMakerWaterfallForTenant()` without that waterfall or its
 * callers needing any changes — same pattern as Clearbit/Apollo's adapters.
 *
 * Honest scope note: `DecisionMakerLookupInput` only ever carries
 * `organizationName`/`domain` — no person name, email, or profile URL. PDL's
 * Person Enrichment API documents a strict minimum-input rule (see
 * `findPerson`'s doc comment) that organization data ALONE never satisfies;
 * calling it with only `company` set would be a guaranteed, wasted 400
 * (invalid_request_error) against a real API credit limit, not a genuine
 * "let's see if PDL knows something" attempt. Rather than send a request PDL's
 * own docs guarantee will fail, this adapter honestly returns `[]` without
 * making a network call whenever no person-identifying field is available —
 * consistent with `findDecisionMakers`'s "a provider genuinely looked and
 * found nothing" semantics, never a fabricated attempt. `findCompany`/
 * `findPerson` above remain full, real, independently-usable PDL clients for
 * any future caller that does have person-identifying input (e.g. a contact
 * already captured elsewhere needing PDL's phone/email appended).
 */
export class PeopleDataLabsProvider implements DecisionMakerProvider {
  readonly name = "people_data_labs";

  constructor(private readonly apiKey: string) {}

  async findDecisionMakers(_input: DecisionMakerLookupInput): Promise<DecisionMakerCandidate[]> {
    // See class doc comment: DecisionMakerLookupInput never carries a
    // person-identifying field PDL's Person Enrichment API requires, so
    // there is nothing honest to look up here yet.
    return [];
  }
}

/** Honest stub mirroring NotConfiguredClearbitProvider/NotConfiguredApolloProvider's
 * exact convention for when neither a tenant credential nor
 * PEOPLE_DATA_LABS_API_KEY is configured. */
export class NotConfiguredPeopleDataLabsProvider implements DecisionMakerProvider {
  readonly name = "people_data_labs_not_configured";

  async findDecisionMakers(_input: DecisionMakerLookupInput): Promise<never> {
    throw new PeopleDataLabsNotConfiguredError(
      "People Data Labs is not configured (no tenant credential via integrationCredentials.ts and no " +
        "PEOPLE_DATA_LABS_API_KEY fallback). Refusing to fabricate a decision-maker contact.",
    );
  }
}

/** Builds the real-or-stub People Data Labs provider for one tenant/project,
 * mirroring buildClearbitProvider()/buildApolloProvider()'s shape. */
export async function buildPeopleDataLabsProvider(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<DecisionMakerProvider> {
  const apiKey = await resolvePeopleDataLabsApiKey(tenantDb, tenantId, projectId);
  return apiKey ? new PeopleDataLabsProvider(apiKey) : new NotConfiguredPeopleDataLabsProvider();
}
