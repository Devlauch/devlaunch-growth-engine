/**
 * Real HMAC-SHA256-signed, time-limited download links for lead-magnet
 * files (Milestone 3) — mirrors lib/suppression.ts's unsubscribe-token
 * design and lib/chatwootIdentity.ts's constant-time-comparison style
 * exactly, with one difference: these DO expire (an unsubscribe link must
 * keep working indefinitely; a lead-magnet download link is deliberately
 * bounded, same rationale a signed cloud-storage URL would have).
 *
 * Scheme: signature = HMAC-SHA256(secret, `${resourceId}.${expiresAtMs}`),
 * hex-encoded. The caller gets back `{ expires, sig }` to attach as query
 * params; `verifySignedDownload` re-derives the expected signature and
 * constant-time-compares it, then separately checks `expires` against the
 * current time. A tampered resourceId/expires value always fails the HMAC
 * check first — expiry is never evaluated for a request whose signature
 * doesn't check out.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

function secret(): string {
  return env.leadMagnetDownloadSecret ?? env.jwtAccessSecret;
}

function sign(resourceId: string, expiresAtMs: number): string {
  return createHmac("sha256", secret()).update(`${resourceId}.${expiresAtMs}`).digest("hex");
}

export interface SignedDownload {
  expires: number;
  sig: string;
}

/** Builds a fresh signed `{ expires, sig }` pair valid for `ttlSeconds` from now. */
export function buildSignedDownload(resourceId: string, ttlSeconds: number): SignedDownload {
  const expires = Date.now() + Math.max(1, ttlSeconds) * 1000;
  return { expires, sig: sign(resourceId, expires) };
}

/**
 * Verifies a `{ expires, sig }` pair against `resourceId`. Returns false for
 * any tampered, malformed, or expired link — never partially trusts one.
 */
export function verifySignedDownload(resourceId: string, expiresRaw: string | undefined, sigRaw: string | undefined): boolean {
  if (!expiresRaw || !sigRaw) return false;

  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires)) return false;

  const expected = sign(resourceId, expires);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(sigRaw, "utf8");
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return false;
  }

  return Date.now() <= expires;
}
