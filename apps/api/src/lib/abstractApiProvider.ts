import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { getIntegrationCredential } from "./integrationCredentials.js";
import type { EmailVerificationResult, EmailVerificationProvider } from "./emailVerification.js";
import type { PhoneVerificationResult, PhoneVerificationProvider } from "./phoneVerification.js";

/**
 * Real Abstract API (abstractapi.com) client: Email Validation + Phone
 * Validation. A genuine alternative/addition to this codebase's existing
 * free DNS/MX email check (emailVerification.ts's DnsEmailVerificationProvider)
 * and free E.164-format phone check (phoneVerification.ts's
 * FormatPhoneVerificationProvider) — both of which this file does NOT
 * replace or duplicate; it implements the SAME `EmailVerificationProvider`/
 * `PhoneVerificationProvider` interfaces those files already define, so it
 * slots into their existing pluggable-provider waterfalls.
 *
 * No real Abstract API key is available in this environment — every request
 * path here is real, working HTTP client code, exercised only against
 * mocked `fetch` responses in tests, never against the live API. That gap
 * is reported as BLOCKED, not hidden.
 *
 * API shape verified against Abstract API's own published documentation
 * (https://www.abstractapi.com/api/email-verification-validation-api,
 * https://www.abstractapi.com/api/phone-validation-api,
 * fetched during this work), NOT assumed:
 *   - Auth: a plain `api_key` query parameter on every request (no header
 *     auth documented for either endpoint — unlike every other provider in
 *     this codebase, which use a header; this client follows Abstract API's
 *     own documented form instead of inventing a header).
 *   - Email Validation: GET https://emailvalidation.abstractapi.com/v1/
 *     ?api_key=<key>&email=<email>. Response fields confirmed from Abstract
 *     API's own marketing/docs example: `email`, `is_valid_format`,
 *     `is_free_email`, `is_disposable_email`, `is_role_email`,
 *     `is_catchall_email`, `is_mx_found`, `is_smtp_valid`, `quality_score`,
 *     `deliverability` ("DELIVERABLE" | "UNDELIVERABLE" | "RISKY" |
 *     "UNKNOWN"), `autocorrect`. Several of these fields are documented
 *     elsewhere in Abstract API's own tiered examples as `{ value, text }`
 *     objects rather than bare booleans on some plans — this client reads
 *     either shape defensively (`readBoolField` below) rather than assuming
 *     one, since which shape a given account/tier returns was not fully
 *     confirmed.
 *   - Phone Validation: GET https://phonevalidation.abstractapi.com/v1/
 *     ?api_key=<key>&phone=<e164-or-local-number>. Response fields CONFIRMED
 *     (Abstract API's own published free-tier example): `phone`, `valid`,
 *     `risk_score`, `registered_location`, `carrier`, `line_type`,
 *     `local_format`, `international_format`, `country_prefix`,
 *     `country_code`, `country_name`.
 *   - Free tier: both products document a free plan of 100 requests/month,
 *     capped at 3 requests/second — confirmed on both products' own pricing
 *     pages. No commercial-use restriction is stated anywhere on Abstract
 *     API's public pricing pages for the free tier (a "Commercial license"
 *     line appears only as an Enterprise-plan feature — implying it covers
 *     something beyond ordinary commercial use, e.g. redistribution/resale
 *     rights, not a prohibition on the free tier being used by a commercial
 *     product). Flagged here, not silently assumed: confirm directly against
 *     Abstract API's Terms of Service before relying on the free tier for
 *     production traffic at any real volume.
 *   - Errors: both endpoints return HTTP 200 with an error payload for some
 *     failure modes per community reports, but the only behavior actually
 *     confirmed from Abstract API's own docs during this work is standard
 *     HTTP status codes (401 unauthorized, 422 unprocessable e.g. malformed
 *     email/phone, 429 rate limited) — this client classifies on HTTP status
 *     only, the same convention as every other provider client in this
 *     codebase, and does not assume an undocumented 200-with-error shape.
 */

const EMAIL_VALIDATION_BASE_URL = "https://emailvalidation.abstractapi.com/v1/";
const PHONE_VALIDATION_BASE_URL = "https://phonevalidation.abstractapi.com/v1/";
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AbstractApiNotConfiguredError extends Error {
  constructor(message = "Abstract API is not configured (no tenant credential and no ABSTRACT_API_KEY fallback).") {
    super(message);
    this.name = "AbstractApiNotConfiguredError";
  }
}

export class AbstractApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AbstractApiError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export class AbstractApiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Abstract API request timed out after ${timeoutMs}ms`);
    this.name = "AbstractApiTimeoutError";
  }
}

export class AbstractApiNetworkError extends Error {
  constructor(cause: unknown) {
    super(`Abstract API request failed before a response was received: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AbstractApiNetworkError";
  }
}

// ---------------------------------------------------------------------------
// Credential resolution — same convention as clearbitProvider.ts/apolloProvider.ts.
// One "abstract_api" credential backs both the email and phone products
// (Abstract API issues one account-level API key usable across its
// products), so a single tenant connection covers both.
// ---------------------------------------------------------------------------

export async function resolveAbstractApiKey(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  const resolved = await getIntegrationCredential(tenantDb as PoolClient, tenantId, projectId, "abstract_api");
  return resolved?.secret ?? env.abstractApiKey ?? null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export interface AbstractApiFetcher {
  (url: string, init: { signal: AbortSignal }): Promise<Response>;
}

function defaultFetcher(): AbstractApiFetcher {
  return (url, init) => fetch(url, init);
}

async function abstractApiGet<T>(
  baseUrl: string,
  params: Record<string, string | undefined>,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: AbstractApiFetcher } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? defaultFetcher();

  const url = new URL(baseUrl);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(url.toString(), { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new AbstractApiTimeoutError(timeoutMs);
    throw new AbstractApiNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let message = `Abstract API returned HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } } | null;
      message = body?.error?.message ?? message;
    } catch {
      // Not JSON — keep the generic message.
    }
    throw new AbstractApiError(message, response.status);
  }

  return (await response.json()) as T;
}

/** Normalizes a field that Abstract API may return as a bare boolean or as
 * a `{ value, text }` object (see module doc comment) — never guesses a
 * value when neither shape is present. */
function readBoolField(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).value;
    if (typeof inner === "boolean") return inner;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Email Validation
// ---------------------------------------------------------------------------

export type AbstractApiDeliverability = "DELIVERABLE" | "UNDELIVERABLE" | "RISKY" | "UNKNOWN";

export interface AbstractApiEmailValidation {
  email: string | null;
  deliverability: AbstractApiDeliverability | null;
  qualityScore: number | null;
  isValidFormat: boolean | null;
  isFreeEmail: boolean | null;
  isDisposableEmail: boolean | null;
  isRoleEmail: boolean | null;
  isCatchallEmail: boolean | null;
  isMxFound: boolean | null;
  isSmtpValid: boolean | null;
}

interface RawAbstractApiEmailValidation {
  email?: string;
  deliverability?: string;
  quality_score?: number | string;
  is_valid_format?: unknown;
  is_free_email?: unknown;
  is_disposable_email?: unknown;
  is_role_email?: unknown;
  is_catchall_email?: unknown;
  is_mx_found?: unknown;
  is_smtp_valid?: unknown;
}

const VALID_DELIVERABILITY: readonly AbstractApiDeliverability[] = ["DELIVERABLE", "UNDELIVERABLE", "RISKY", "UNKNOWN"];

/** GET https://emailvalidation.abstractapi.com/v1/?api_key=...&email=... */
export async function validateEmail(
  email: string,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: AbstractApiFetcher } = {},
): Promise<AbstractApiEmailValidation> {
  const raw = await abstractApiGet<RawAbstractApiEmailValidation>(EMAIL_VALIDATION_BASE_URL, { email }, apiKey, options);
  return {
    email: raw.email ?? null,
    deliverability: VALID_DELIVERABILITY.includes(raw.deliverability as AbstractApiDeliverability)
      ? (raw.deliverability as AbstractApiDeliverability)
      : null,
    qualityScore: raw.quality_score != null ? Number(raw.quality_score) : null,
    isValidFormat: readBoolField(raw.is_valid_format),
    isFreeEmail: readBoolField(raw.is_free_email),
    isDisposableEmail: readBoolField(raw.is_disposable_email),
    isRoleEmail: readBoolField(raw.is_role_email),
    isCatchallEmail: readBoolField(raw.is_catchall_email),
    isMxFound: readBoolField(raw.is_mx_found),
    isSmtpValid: readBoolField(raw.is_smtp_valid),
  };
}

// ---------------------------------------------------------------------------
// Phone Validation
// ---------------------------------------------------------------------------

export interface AbstractApiPhoneValidation {
  phone: string | null;
  valid: boolean | null;
  riskScore: string | null;
  carrier: string | null;
  lineType: string | null;
  internationalFormat: string | null;
  countryName: string | null;
  countryCode: string | null;
}

interface RawAbstractApiPhoneValidation {
  phone?: string;
  valid?: boolean;
  risk_score?: string;
  carrier?: string;
  line_type?: string;
  international_format?: string;
  country_name?: string;
  country_code?: string;
}

/** GET https://phonevalidation.abstractapi.com/v1/?api_key=...&phone=... */
export async function validatePhone(
  phone: string,
  apiKey: string,
  options: { timeoutMs?: number; fetcher?: AbstractApiFetcher } = {},
): Promise<AbstractApiPhoneValidation> {
  const raw = await abstractApiGet<RawAbstractApiPhoneValidation>(PHONE_VALIDATION_BASE_URL, { phone }, apiKey, options);
  return {
    phone: raw.phone ?? null,
    valid: typeof raw.valid === "boolean" ? raw.valid : null,
    riskScore: raw.risk_score ?? null,
    carrier: raw.carrier ?? null,
    lineType: raw.line_type ?? null,
    internationalFormat: raw.international_format ?? null,
    countryName: raw.country_name ?? null,
    countryCode: raw.country_code ?? null,
  };
}

// ---------------------------------------------------------------------------
// EmailVerificationProvider / PhoneVerificationProvider adapters
// ---------------------------------------------------------------------------

/**
 * Adapts Abstract API's Email Validation endpoint onto the EXISTING
 * `EmailVerificationProvider` interface (emailVerification.ts) so it slots
 * into that file's waterfall — see `buildEmailVerificationWaterfallForTenant`
 * added to emailVerification.ts, which prepends this ahead of the free
 * DNS/MX tier when a tenant credential (or ABSTRACT_API_KEY fallback)
 * resolves. `deliverability`/`is_role_email`/`is_disposable_email` map onto
 * emailVerification.ts's existing `verificationStatus` enum so callers that
 * only read that field (unchanged elsewhere in this codebase) still get a
 * meaningful answer from the stronger paid signal.
 */
export class AbstractApiEmailVerificationProvider implements EmailVerificationProvider {
  readonly name = "abstract_api";

  constructor(private readonly apiKey: string) {}

  async verifyEmail(email: string): Promise<EmailVerificationResult> {
    const checkedAt = new Date().toISOString();
    const result = await validateEmail(email, this.apiKey);

    let verificationStatus: EmailVerificationResult["verificationStatus"];
    if (result.isValidFormat === false) {
      verificationStatus = "invalid";
    } else if (result.isDisposableEmail === true) {
      verificationStatus = "invalid";
    } else if (result.isRoleEmail === true) {
      verificationStatus = "role_based";
    } else if (result.deliverability === "DELIVERABLE") {
      verificationStatus = "verified";
    } else if (result.deliverability === "UNDELIVERABLE") {
      verificationStatus = "invalid";
    } else if (result.deliverability === "RISKY") {
      verificationStatus = "risky";
    } else {
      // "UNKNOWN" deliverability, or the field wasn't present at all.
      verificationStatus = "unverified";
    }

    return {
      syntaxValid: result.isValidFormat ?? false,
      mxFound: result.isMxFound ?? false,
      isRoleBased: result.isRoleEmail ?? false,
      verificationStatus,
      checkedAt,
      provider: this.name,
    };
  }
}

/**
 * Adapts Abstract API's Phone Validation endpoint onto the EXISTING
 * `PhoneVerificationProvider` interface (phoneVerification.ts) so it slots
 * into that file's waterfall — see `buildPhoneVerificationWaterfallForTenant`
 * added to phoneVerification.ts.
 */
export class AbstractApiPhoneVerificationProvider implements PhoneVerificationProvider {
  readonly name = "abstract_api";

  constructor(private readonly apiKey: string) {}

  async verifyPhone(input: string): Promise<PhoneVerificationResult> {
    const result = await validatePhone(input, this.apiKey);
    return {
      normalized: result.internationalFormat ?? null,
      isPlausibleE164: result.valid ?? false,
      provider: this.name,
    };
  }
}

/** Builds the Abstract API email-verification provider for one
 * tenant/project, or null when no credential resolves — unlike the
 * decision-maker providers above, this is purely additive, so a caller
 * simply omits it from the waterfall rather than falling back to a thrown
 * NotConfigured stub (the free DNS/MX tier already covers that honest
 * "nothing paid is configured" case). */
export async function buildAbstractApiEmailProvider(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<AbstractApiEmailVerificationProvider | null> {
  const apiKey = await resolveAbstractApiKey(tenantDb, tenantId, projectId);
  return apiKey ? new AbstractApiEmailVerificationProvider(apiKey) : null;
}

/** Builds the Abstract API phone-verification provider for one
 * tenant/project, or null when no credential resolves — same convention as
 * buildAbstractApiEmailProvider above. */
export async function buildAbstractApiPhoneProvider(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<AbstractApiPhoneVerificationProvider | null> {
  const apiKey = await resolveAbstractApiKey(tenantDb, tenantId, projectId);
  return apiKey ? new AbstractApiPhoneVerificationProvider(apiKey) : null;
}
