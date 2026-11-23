import type { PoolClient } from "pg";
import { runProviderWaterfall } from "./providerWaterfall.js";

/**
 * Basic, honest phone number handling for discovered contacts.
 *
 * We do NOT fabricate carrier/line-type lookups (that needs a paid
 * provider we don't have). What the real, free implementation
 * (`FormatPhoneVerificationProvider`) does:
 *  - normalize formatting (strip spaces, dashes, dots, parens)
 *  - require E.164 shape: a leading "+", a plausible country calling
 *    code (1-3 digits, no leading 0), and a plausible overall length
 *    (E.164 caps subscriber numbers at 15 digits total).
 *
 * Milestone 3 Phase 2 completion pass: `verifyPhone` now follows the same
 * pluggable-provider seam as decisionMakerProvider.ts/companyEnrichment.ts/
 * emailVerification.ts, reusing providerWaterfall.ts, so a real paid
 * carrier/line-type lookup (Twilio Lookup, NumVerify, etc.) is a drop-in
 * upgrade later — prepend it in `buildPhoneVerificationWaterfall` and
 * `verifyPhone`'s callers don't change at all.
 */

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export interface PhoneVerificationResult {
  normalized: string | null;
  isPlausibleE164: boolean;
  /** Which provider in the waterfall actually produced this result (see
   * buildPhoneVerificationWaterfall) — provenance for the verification
   * itself, analogous to source_confidence on discovered_contacts. */
  provider?: string;
}

/**
 * Strips common formatting characters (spaces, dashes, dots, parens) and
 * collapses a leading "00" international prefix to "+". Does not attempt
 * to add a country code if one isn't present — we don't know the
 * contact's country, so guessing would be dishonest.
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (value.length === 0) return null;

  // Strip everything except leading + and digits.
  const hasLeadingPlus = value.startsWith("+");
  value = value.replace(/[^\d]/g, "");
  if (hasLeadingPlus) {
    value = `+${value}`;
  } else if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }

  if (!value.startsWith("+")) return null;

  const digits = value.slice(1);
  if (digits.length === 0) return null;

  return `+${digits}`;
}

/**
 * E.164-ish plausibility check: "+", country calling code not starting
 * with 0, total digit count between 8 and 15 (E.164's hard max, with a
 * floor to reject obviously-too-short numbers).
 */
export function isPlausibleE164(value: string): boolean {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return false;
  return true;
}

/** Pluggable backend for `verifyPhone`. Implement this against a real paid
 * carrier/line-type lookup (Twilio Lookup, NumVerify, etc.) to back
 * verification with that provider — the rest of the app only ever depends
 * on this interface. */
export interface PhoneVerificationProvider {
  /** Stable, human-readable provider name, recorded as `result.provider`. */
  readonly name: string;
  verifyPhone(input: string): Promise<PhoneVerificationResult>;
}

/**
 * The real, free implementation available today: format normalization +
 * E.164 plausibility. Never throws and never returns an empty/null result,
 * so in the waterfall it is always the one that actually answers unless a
 * real paid provider is added ahead of it.
 */
export class FormatPhoneVerificationProvider implements PhoneVerificationProvider {
  readonly name = "format_e164";

  async verifyPhone(input: string): Promise<PhoneVerificationResult> {
    const normalized = normalizePhone(input);
    if (!normalized) {
      return { normalized: null, isPlausibleE164: false, provider: this.name };
    }
    return { normalized, isPlausibleE164: isPlausibleE164(normalized), provider: this.name };
  }
}

/**
 * Honest stand-in for a licensed carrier/line-type lookup provider we
 * don't have credentials for in this environment. Always throws — never
 * returns a fabricated "this number is a real, reachable mobile line"
 * result. Wire in a real client (implementing `PhoneVerificationProvider`)
 * once an API key exists.
 */
export class NotConfiguredCarrierLookupProvider implements PhoneVerificationProvider {
  constructor(private readonly providerName = "phone carrier/line-type lookup provider (e.g. Twilio Lookup/NumVerify)") {}

  readonly name = "not_configured";

  async verifyPhone(_input: string): Promise<never> {
    throw new NotConfiguredError(
      `${this.providerName} is not configured (no API key available in this environment). ` +
        `Implement PhoneVerificationProvider against a real provider and add it to the waterfall ` +
        `once credentials are available. Refusing to fabricate a carrier/line-type result.`,
    );
  }
}

/**
 * The phone-verification provider waterfall used in production. A real
 * paid carrier/line-type lookup provider, once credentials exist, is
 * prepended here — `verifyPhone` below doesn't change at all, since it
 * only ever depends on the `PhoneVerificationProvider` interface via
 * `runProviderWaterfall`.
 */
export function buildPhoneVerificationWaterfall(): PhoneVerificationProvider[] {
  return [new NotConfiguredCarrierLookupProvider(), new FormatPhoneVerificationProvider()];
}

/**
 * Tenant-aware waterfall, additive alongside `buildPhoneVerificationWaterfall`
 * above (unchanged, still used wherever no tenant context is available):
 * when a tenant's own Abstract API credential (or ABSTRACT_API_KEY dev-mode
 * fallback) resolves via `abstractApiProvider.ts#resolveAbstractApiKey`, a
 * real `AbstractApiPhoneVerificationProvider` is PREPENDED ahead of the
 * existing `[NotConfiguredCarrierLookupProvider,
 * FormatPhoneVerificationProvider]` pair — Abstract API's real
 * carrier/line-type lookup is a strictly stronger signal than the free
 * E.164-format-only check, so it is tried first; the free tier remains the
 * fallback when Abstract API errors or isn't configured for this tenant.
 */
export async function buildPhoneVerificationWaterfallForTenant(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<PhoneVerificationProvider[]> {
  const { buildAbstractApiPhoneProvider } = await import("./abstractApiProvider.js");
  const abstractApi = await buildAbstractApiPhoneProvider(tenantDb, tenantId, projectId);
  const providers: PhoneVerificationProvider[] = [];
  if (abstractApi) providers.push(abstractApi);
  providers.push(...buildPhoneVerificationWaterfall());
  return providers;
}

export async function verifyPhone(
  input: string,
  providers: PhoneVerificationProvider[] = buildPhoneVerificationWaterfall(),
): Promise<PhoneVerificationResult> {
  const outcome = await runProviderWaterfall<string, PhoneVerificationResult>(
    providers.map((p) => ({ name: p.name, run: (i: string) => p.verifyPhone(i) })),
    input,
    // A PhoneVerificationResult object is never null/an array, so the
    // default isEmpty would already treat it as non-empty — spelled out
    // here anyway for the same reason as emailVerification.ts.
    { isEmpty: () => false },
  );

  if (!outcome.result) {
    // Unreachable with the default waterfall (FormatPhoneVerificationProvider
    // never throws); stays an honest, typed fallback for a custom
    // `providers` list that is empty or all-throwing.
    return { normalized: null, isPlausibleE164: false };
  }

  return outcome.result;
}
