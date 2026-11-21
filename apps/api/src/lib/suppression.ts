import type { PoolClient } from "pg";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Roadmap item 18, "Suppression and consent" — the single enforcement
 * surface for compliance checks before any outbound send. No real sending
 * pipeline exists yet in this codebase (by design); this module is built
 * standalone so that whenever messaging/sequence send code lands, it has a
 * single, already-tested gate to call: checkSendEligibility().
 *
 * Every function here takes a tenant-scoped `tenantDb` (a `pg.PoolClient`,
 * exactly like `req.tenantDb` set by src/middleware/tenant.ts) plus an
 * explicit `tenantId`, and queries ONLY by tenant_id — never relying on RLS
 * alone — so these functions are safe to call from contexts (e.g. a worker
 * processing a send queue) that may not go through the HTTP tenant
 * middleware at all, as long as they open a client, set
 * app.current_tenant_id, and pass the matching tenantId here.
 */

export interface SuppressionCheckInput {
  email?: string | null;
  phone?: string | null;
  channel: "email" | "whatsapp" | "phone" | "sms";
}

export interface SuppressionCheckResult {
  suppressed: boolean;
  reason?: string;
}

/**
 * Checks suppression_list for a matching email/phone + channel row (or a
 * channel='all' row, which suppresses every channel for that identifier).
 * Returns the first match found; email is checked case-insensitively.
 */
export async function isSuppressed(
  tenantDb: PoolClient,
  tenantId: string,
  input: SuppressionCheckInput,
): Promise<SuppressionCheckResult> {
  const { email, phone, channel } = input;
  if (!email && !phone) {
    return { suppressed: false };
  }

  const result = await tenantDb.query<{ reason: string }>(
    `SELECT reason FROM suppression_list
     WHERE tenant_id = $1
       AND channel IN ($2, 'all')
       AND (
         ($3::text IS NOT NULL AND lower(email) = lower($3))
         OR ($4::text IS NOT NULL AND phone = $4)
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, channel, email ?? null, phone ?? null],
  );

  if (result.rowCount === 0) {
    return { suppressed: false };
  }
  return { suppressed: true, reason: result.rows[0].reason };
}

export interface ConsentCheckInput {
  leadId?: string | null;
  email?: string | null;
  phone?: string | null;
  channel: "email" | "whatsapp" | "phone" | "linkedin" | "sms";
}

/**
 * Checks consent_records for the most recent matching row (by leadId, else
 * email, else phone, for the given channel) and returns its consent_given
 * value. No matching row at all => no consent on file => false.
 */
export async function hasConsent(
  tenantDb: PoolClient,
  tenantId: string,
  input: ConsentCheckInput,
): Promise<boolean> {
  const { leadId, email, phone, channel } = input;
  if (!leadId && !email && !phone) {
    return false;
  }

  const result = await tenantDb.query<{ consent_given: boolean }>(
    `SELECT consent_given FROM consent_records
     WHERE tenant_id = $1
       AND channel = $2
       AND (
         ($3::uuid IS NOT NULL AND lead_id = $3)
         OR ($4::text IS NOT NULL AND lower(email) = lower($4))
         OR ($5::text IS NOT NULL AND phone = $5)
       )
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [tenantId, channel, leadId ?? null, email ?? null, phone ?? null],
  );

  if (result.rowCount === 0) {
    return false;
  }
  return result.rows[0].consent_given === true;
}

export interface CountrySendCheckInput {
  countryCode: string;
  channel: "email" | "whatsapp" | "phone" | "sms";
}

export interface CountrySendCheckResult {
  allowed: boolean;
  requiresExplicitConsent: boolean;
}

/**
 * Looks up country_send_settings for this tenant+country+channel. A tenant
 * opts INTO restrictions by adding a row; with none configured for a given
 * country, this defaults to { allowed: true, requiresExplicitConsent: false
 * } — documented default-open behavior, so a tenant doesn't have to
 * enumerate every country up front to use the rest of this feature.
 */
export async function isCountrySendAllowed(
  tenantDb: PoolClient,
  tenantId: string,
  input: CountrySendCheckInput,
): Promise<CountrySendCheckResult> {
  const { countryCode, channel } = input;

  const result = await tenantDb.query<{ sending_allowed: boolean; requires_explicit_consent: boolean }>(
    `SELECT sending_allowed, requires_explicit_consent FROM country_send_settings
     WHERE tenant_id = $1 AND country_code = $2 AND channel = $3`,
    [tenantId, countryCode.toUpperCase(), channel],
  );

  if (result.rowCount === 0) {
    return { allowed: true, requiresExplicitConsent: false };
  }

  const row = result.rows[0];
  return { allowed: row.sending_allowed === true, requiresExplicitConsent: row.requires_explicit_consent === true };
}

export interface SendEligibilityInput {
  leadId?: string | null;
  email?: string | null;
  phone?: string | null;
  channel: "email" | "whatsapp" | "phone" | "sms";
  countryCode?: string | null;
}

export interface SendEligibilityResult {
  eligible: boolean;
  blockReasons: string[];
}

/**
 * The single gate future send code (messaging/sequences, once built) MUST
 * call before dispatching any outbound message. Composes suppression,
 * consent, and country-policy checks into one call and collects EVERY
 * reason sending would be blocked — it does not stop at the first — so
 * callers/UIs can show a full explanation rather than a single opaque
 * rejection.
 *
 * Contract:
 *   checkSendEligibility(tenantDb, tenantId, { leadId?, email?, phone?, channel, countryCode? })
 *     => Promise<{ eligible: boolean; blockReasons: string[] }>
 *
 * blockReasons entries are one of:
 *   "suppressed:<reason>"            - a suppression_list match (reason is
 *                                      one of unsubscribed/bounced/
 *                                      complained/manual/legal_request)
 *   "consent_required"                - the resolved country policy (or an
 *                                      explicit countryCode-less default)
 *                                      requires explicit consent and none
 *                                      (or a false/absent one) is on file
 *   "country_not_allowed"              - country_send_settings explicitly
 *                                      disallows sending for this
 *                                      country+channel
 */
export async function checkSendEligibility(
  tenantDb: PoolClient,
  tenantId: string,
  input: SendEligibilityInput,
): Promise<SendEligibilityResult> {
  const { leadId, email, phone, channel, countryCode } = input;
  const blockReasons: string[] = [];

  const suppression = await isSuppressed(tenantDb, tenantId, { email, phone, channel });
  if (suppression.suppressed) {
    blockReasons.push(`suppressed:${suppression.reason ?? "unknown"}`);
  }

  let requiresExplicitConsent = false;
  if (countryCode) {
    const countryCheck = await isCountrySendAllowed(tenantDb, tenantId, { countryCode, channel });
    if (!countryCheck.allowed) {
      blockReasons.push("country_not_allowed");
    }
    requiresExplicitConsent = countryCheck.requiresExplicitConsent;
  }

  if (requiresExplicitConsent) {
    const consented = await hasConsent(tenantDb, tenantId, { leadId, email, phone, channel });
    if (!consented) {
      blockReasons.push("consent_required");
    }
  }

  return { eligible: blockReasons.length === 0, blockReasons };
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens
//
// No real send pipeline exists yet to have generated these, but future send
// code MUST call generateUnsubscribeToken() when building any outbound
// message's unsubscribe link, so that POST /api/v1/public/unsubscribe
// (src/routes/compliance.ts) can verify it and record the opt-out without
// trusting a raw tenantId/email pair supplied by an anonymous caller.
//
// Design: HMAC-SHA256 over `${tenantId}:${identifierKind}:${identifier}:${issuedAt}`
// using a server-side secret, base64url-encoded as
// `${payload}.${signature}`. Reuses env.jwtAccessSecret rather than adding a
// new env var — it's already a server-side-only secret never exposed to
// clients, and an unsubscribe token has the same trust requirement (a
// value only this server could have produced), so a second secret would
// add configuration surface without adding safety.
//
// No expiry: an unsubscribe link in a real outbound email may be clicked
// weeks or months after send (mailbox left unread), and a link that stops
// working "to protect the user" would instead block a legitimate opt-out —
// the one outcome this feature exists to make easy. Tampering is rejected
// unconditionally via constant-time HMAC comparison.
// ---------------------------------------------------------------------------

const UNSUB_TOKEN_SECRET = env.jwtAccessSecret;

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string | null {
  try {
    return Buffer.from(input, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", UNSUB_TOKEN_SECRET).update(payload).digest("base64url");
}

export interface UnsubscribeTokenSubject {
  tenantId: string;
  leadId?: string | null;
  email?: string | null;
}

/**
 * Builds an opaque unsubscribe token for a lead identified either by
 * leadId or by email (at least one is required). Future send code calls
 * this once per outbound message to embed in its unsubscribe link.
 */
export function generateUnsubscribeToken(subject: UnsubscribeTokenSubject): string {
  const { tenantId, leadId, email } = subject;
  if (!leadId && !email) {
    throw new Error("generateUnsubscribeToken requires leadId or email");
  }

  const payloadObj = {
    t: tenantId,
    l: leadId ?? null,
    e: email ?? null,
    iat: Date.now(),
  };
  const payload = b64urlEncode(JSON.stringify(payloadObj));
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export interface VerifiedUnsubscribeToken {
  tenantId: string;
  leadId: string | null;
  email: string | null;
}

/**
 * Verifies a token produced by generateUnsubscribeToken(). Returns null for
 * any malformed, tampered, or otherwise invalid token (including a
 * signature mismatch) — callers must treat null as "reject the request",
 * never attempt to partially trust the decoded payload.
 */
export function verifyUnsubscribeToken(token: string): VerifiedUnsubscribeToken | null {
  if (typeof token !== "string" || token.length === 0) return null;

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1) return null;

  const payload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expectedSignature = sign(payload);
  const sigBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const decoded = b64urlDecode(payload);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as { t?: unknown; l?: unknown; e?: unknown; iat?: unknown };
    if (typeof parsed.t !== "string" || !parsed.t) return null;
    if (!parsed.l && !parsed.e) return null;
    return {
      tenantId: parsed.t,
      leadId: typeof parsed.l === "string" ? parsed.l : null,
      email: typeof parsed.e === "string" ? parsed.e : null,
    };
  } catch {
    return null;
  }
}
