import { verifyEmail, type EmailVerificationResult, type VerifyEmailOptions } from "./emailVerification.js";
import {
  verifyEmailWithHunter,
  HunterApiError,
  HunterTimeoutError,
  HunterNetworkError,
  type HunterFetcher,
} from "./hunterProvider.js";

/**
 * Combined (free DNS tier + optional paid Hunter tier) email verification.
 * This module composes the EXISTING, unmodified `verifyEmail` (DNS-based,
 * free — emailVerification.ts) with a new, optional Hunter Email Verifier
 * tier — it never replaces or reimplements the free tier.
 *
 * Status model: the free tier's own
 * `valid|invalid|risky|role_based|unknown`-shaped `verificationStatus`
 * field (actual enum: 'verified'|'unverified'|'role_based'|'risky'|
 * 'invalid' — see emailVerification.ts) is preserved UNCHANGED on
 * `freeTier` below. A SEPARATE `combinedStatus` field exposes the broader
 * enum this task asked for:
 *
 *   valid | invalid | risky | accept_all | unknown | not_verified | provider_error
 *
 * (`role_based` is also still surfaced, alongside those seven, as
 * `combinedStatus: "role_based"` when the free tier flagged a role inbox
 * and Hunter was never consulted — a role inbox isn't well-described by
 * any of the other seven, and collapsing it into one of them would be
 * exactly the kind of overclaiming this task asks us NOT to do.)
 *
 * Mapping table (see docs/PHASE_2_HUNTER_VALIDATION.md for the full
 * rationale):
 *   free tier "invalid"          -> combinedStatus "invalid"   (Hunter is
 *                                    never called for a syntactically
 *                                    invalid address — there's nothing
 *                                    Hunter could add, and it would waste a
 *                                    real API credit on a request that can
 *                                    only fail).
 *   no Hunter credential at all  -> combinedStatus "not_verified" (except
 *                                    role_based, see above) — the free tier
 *                                    already never claims mailbox-level
 *                                    proof, so "not_verified" here means
 *                                    "no paid verification tier ran",
 *                                    not "we don't know if it's valid".
 *   Hunter status "valid"        -> "valid"
 *   Hunter status "invalid"      -> "invalid"
 *   Hunter status "accept_all"   -> "accept_all"  (NEVER "valid" — an
 *                                    accept-all mail server accepts every
 *                                    address at that domain whether or not
 *                                    a real mailbox exists behind it, so
 *                                    this is explicitly its own, weaker
 *                                    category, exactly per this task's
 *                                    "do not report accept-all as
 *                                    verified" requirement).
 *   Hunter status "disposable"   -> "invalid" (a disposable/temp-mail
 *                                    address is not a legitimate business
 *                                    contact regardless of technical
 *                                    deliverability).
 *   Hunter status "webmail"      -> "valid" only if Hunter's own
 *                                    `smtp_check === true` AND
 *                                    `accept_all === false`; "invalid" only
 *                                    if `smtp_check === false`; "unknown"
 *                                    otherwise. ("webmail" on its own is
 *                                    informational — a personal Gmail/
 *                                    Outlook-style address — not a
 *                                    deliverability verdict.)
 *   Hunter status "unknown"      -> "unknown"
 *   Hunter 202/222 (in progress) -> "unknown" (`inProgress: true`)
 *   Hunter HTTP/network/timeout
 *     error                      -> "provider_error" (never silently
 *                                    downgraded to "unknown" — a real
 *                                    provider failure is a distinct,
 *                                    visible outcome).
 */

export type CombinedVerificationStatus =
  | "valid"
  | "invalid"
  | "risky"
  | "accept_all"
  | "unknown"
  | "not_verified"
  | "provider_error"
  | "role_based";

export interface CombinedEmailVerificationResult {
  email: string;
  freeTier: EmailVerificationResult;
  hunterTier: {
    ran: boolean;
    result: Awaited<ReturnType<typeof verifyEmailWithHunter>> | null;
    error: { kind: "HunterApiError" | "HunterTimeoutError" | "HunterNetworkError"; message: string; status?: number } | null;
  };
  combinedStatus: CombinedVerificationStatus;
  checkedAt: string;
}

function mapHunterStatus(hunterResult: Awaited<ReturnType<typeof verifyEmailWithHunter>>): CombinedVerificationStatus {
  if (hunterResult.inProgress) return "unknown";
  switch (hunterResult.status) {
    case "valid":
      return "valid";
    case "invalid":
      return "invalid";
    case "accept_all":
      return "accept_all";
    case "disposable":
      return "invalid";
    case "webmail":
      if (hunterResult.smtpCheck === true && hunterResult.acceptAll === false) return "valid";
      if (hunterResult.smtpCheck === false) return "invalid";
      return "unknown";
    case "unknown":
    default:
      return "unknown";
  }
}

export interface VerifyEmailWithHunterOptions extends VerifyEmailOptions {
  /** When null/undefined, the Hunter tier is skipped entirely (reported as
   * `hunterTier.ran: false`, combinedStatus falls back to "not_verified"/
   * "role_based"/"invalid" per the free-tier result alone). */
  hunterApiKey?: string | null;
  hunterFetcher?: HunterFetcher;
  hunterTimeoutMs?: number;
}

/**
 * Runs the free DNS tier first (always), then — only if `syntaxValid` and a
 * Hunter API key is given — the Hunter Email Verifier tier as a confirming/
 * upgrading signal. Never calls Hunter for a syntactically invalid address
 * (see mapping table above). Never throws for a Hunter-side failure — that
 * is reported as `combinedStatus: "provider_error"` with the real error
 * preserved on `hunterTier.error`, so a flaky Hunter API never breaks a
 * caller's larger verification flow (same resilience convention as
 * `findDecisionMakers` never throwing).
 */
export async function verifyEmailCombined(
  email: string,
  options: VerifyEmailWithHunterOptions = {},
): Promise<CombinedEmailVerificationResult> {
  const checkedAt = new Date().toISOString();
  const freeTier = await verifyEmail(email, options);

  const base = {
    email,
    freeTier,
    checkedAt,
  };

  if (freeTier.verificationStatus === "invalid") {
    return { ...base, hunterTier: { ran: false, result: null, error: null }, combinedStatus: "invalid" };
  }

  if (!options.hunterApiKey) {
    const combinedStatus: CombinedVerificationStatus =
      freeTier.verificationStatus === "role_based"
        ? "role_based"
        : freeTier.verificationStatus === "risky"
          ? "risky"
          : "not_verified";
    return { ...base, hunterTier: { ran: false, result: null, error: null }, combinedStatus };
  }

  try {
    const hunterResult = await verifyEmailWithHunter(email, options.hunterApiKey, {
      timeoutMs: options.hunterTimeoutMs,
      fetcher: options.hunterFetcher,
    });
    return {
      ...base,
      hunterTier: { ran: true, result: hunterResult, error: null },
      combinedStatus: mapHunterStatus(hunterResult),
    };
  } catch (err) {
    const kind = err instanceof HunterApiError
      ? "HunterApiError"
      : err instanceof HunterTimeoutError
        ? "HunterTimeoutError"
        : err instanceof HunterNetworkError
          ? "HunterNetworkError"
          : "HunterNetworkError";
    return {
      ...base,
      hunterTier: {
        ran: true,
        result: null,
        error: {
          kind,
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof HunterApiError ? { status: err.status } : {}),
        },
      },
      combinedStatus: "provider_error",
    };
  }
}
