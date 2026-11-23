import dns from "node:dns";
import type { PoolClient } from "pg";
import { runProviderWaterfall } from "./providerWaterfall.js";

/**
 * Email verification for discovered contacts.
 *
 * The real, free implementation (`DnsEmailVerificationProvider`) does real
 * syntax validation and a real DNS MX lookup (node's built-in resolver,
 * genuinely hitting the network), but it never claims to know whether a
 * specific mailbox exists — SMTP handshake verification is out of scope
 * and would be unreliable/abusive against arbitrary third-party mail
 * servers. "verified" here means "syntactically valid, has a real domain
 * with mail exchangers, and isn't a generic role inbox" — the strongest
 * signal we can respectfully get without actually sending mail.
 *
 * Milestone 3 Phase 2 completion pass: this now exposes the same
 * pluggable-provider seam as decisionMakerProvider.ts/
 * companyEnrichment.ts, reusing providerWaterfall.ts, so a real paid
 * bounce-prediction provider (ZeroBounce/NeverBounce/Kickbox, etc.) is a
 * drop-in upgrade later — prepend it in `buildEmailVerificationWaterfall`
 * and `verifyEmail`'s callers don't change at all. Today the waterfall is
 * `[NotConfiguredBounceVerificationProvider, DnsEmailVerificationProvider]`:
 * the honest stub is tried first (and always throws, recorded as an
 * "error" attempt) so the free DNS/syntax check — which never throws and
 * is therefore always the one that actually answers today — is correctly
 * the fallback, not pretended to be the primary signal.
 */

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

// A reasonably robust (not naive single-line) RFC-5322-ish check. This is
// intentionally not the "one true regex" (nothing fully implements 5322),
// but it correctly handles quoted local parts, +tags, subdomains, and
// rejects the common broken cases (double dots, leading/trailing dots,
// missing @, spaces, multiple @ signs).
const EMAIL_RE =
  /^(?:[a-zA-Z0-9_'^&/+!`{}|~#$%*?=-]+(?:\.[a-zA-Z0-9_'^&/+!`{}|~#$%*?=-]+)*|"(?:[^"\\]|\\.)+")@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

// Known generic/role-based local-parts. Role-based is a valid, expected
// category for discovered contacts (lots of orgs only expose info@/sales@
// style inboxes) — it is NOT a rejection, just a different bucket.
const ROLE_BASED_LOCAL_PARTS = new Set([
  "info",
  "contact",
  "admin",
  "administrator",
  "noreply",
  "no-reply",
  "support",
  "sales",
  "hello",
  "help",
  "office",
  "enquiries",
  "inquiries",
  "marketing",
  "hr",
  "careers",
  "jobs",
  "press",
  "media",
  "billing",
  "accounts",
  "webmaster",
  "postmaster",
  "team",
  "general",
]);

export interface EmailVerificationResult {
  syntaxValid: boolean;
  mxFound: boolean;
  isRoleBased: boolean;
  verificationStatus: "verified" | "unverified" | "role_based" | "risky" | "invalid";
  checkedAt: string;
  domain?: string;
  error?: string;
  /** Which provider in the waterfall actually produced this result (see
   * buildEmailVerificationWaterfall) — provenance for the verification
   * itself, analogous to source_confidence on discovered_contacts. */
  provider?: string;
}

export function isSyntaxValid(email: string): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (trimmed.includes("..")) return false;
  return EMAIL_RE.test(trimmed);
}

export function getLocalPartAndDomain(email: string): { localPart: string; domain: string } | null {
  const trimmed = email.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return null;
  return {
    localPart: trimmed.slice(0, atIndex).replace(/^"|"$/g, ""),
    domain: trimmed.slice(atIndex + 1).toLowerCase(),
  };
}

export function isRoleBasedLocalPart(localPart: string): boolean {
  const normalized = localPart.trim().toLowerCase();
  if (ROLE_BASED_LOCAL_PARTS.has(normalized)) return true;
  // Also catch common variants like "info+something" or "no.reply"
  const stripped = normalized.replace(/[._-]/g, "");
  for (const candidate of ROLE_BASED_LOCAL_PARTS) {
    if (stripped === candidate.replace(/[._-]/g, "")) return true;
  }
  return false;
}

/**
 * Resolves MX records for a domain. Returns `true` if at least one MX
 * record is found. Network/DNS failures (NXDOMAIN, timeout, server
 * failure, etc.) resolve to `false` rather than throwing — callers must be
 * able to treat a flaky/slow DNS server as "couldn't confirm", not a crash.
 */
export async function hasMxRecord(
  domain: string,
  resolver: Pick<typeof dns.promises, "resolveMx"> = dns.promises,
): Promise<boolean> {
  try {
    const records = await resolver.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

export interface VerifyEmailOptions {
  /** Injectable for tests — defaults to node's real dns.promises. */
  resolver?: Pick<typeof dns.promises, "resolveMx">;
  /** Injectable waterfall for tests / future real-provider wiring. Defaults
   * to `buildEmailVerificationWaterfall({ resolver })`. */
  providers?: EmailVerificationProvider[];
}

/** Pluggable backend for `verifyEmail`. Implement this against a real paid
 * bounce-prediction provider (ZeroBounce/NeverBounce/Kickbox/etc.) to back
 * verification with that provider — the rest of the app only ever depends
 * on this interface. */
export interface EmailVerificationProvider {
  /** Stable, human-readable provider name, recorded as `result.provider`. */
  readonly name: string;
  verifyEmail(email: string): Promise<EmailVerificationResult>;
}

/**
 * The real, free implementation available today: syntax + MX lookup +
 * role-based classification. Never throws (DNS failures degrade to
 * "risky", not an exception) and never returns an empty/null result, so in
 * the waterfall it is always the one that actually answers unless a real
 * paid provider is added ahead of it.
 */
export class DnsEmailVerificationProvider implements EmailVerificationProvider {
  readonly name = "dns_mx_syntax";

  constructor(private readonly resolver?: Pick<typeof dns.promises, "resolveMx">) {}

  async verifyEmail(email: string): Promise<EmailVerificationResult> {
    const checkedAt = new Date().toISOString();
    const syntaxValid = isSyntaxValid(email ?? "");

    if (!syntaxValid) {
      return {
        syntaxValid: false,
        mxFound: false,
        isRoleBased: false,
        verificationStatus: "invalid",
        checkedAt,
        provider: this.name,
      };
    }

    const parts = getLocalPartAndDomain(email);
    if (!parts) {
      return {
        syntaxValid: false,
        mxFound: false,
        isRoleBased: false,
        verificationStatus: "invalid",
        checkedAt,
        provider: this.name,
      };
    }

    const { localPart, domain } = parts;
    const isRoleBased = isRoleBasedLocalPart(localPart);

    let mxFound = false;
    let dnsError: string | undefined;
    try {
      mxFound = await hasMxRecord(domain, this.resolver);
    } catch (err) {
      dnsError = err instanceof Error ? err.message : String(err);
    }

    let verificationStatus: EmailVerificationResult["verificationStatus"];
    if (!mxFound) {
      // Could genuinely be a nonexistent domain, or just a transient DNS
      // failure — we can't tell the difference from here, so "risky" rather
      // than "invalid" (invalid is reserved for syntax failures we're sure of).
      verificationStatus = "risky";
    } else if (isRoleBased) {
      verificationStatus = "role_based";
    } else {
      verificationStatus = "verified";
    }

    return {
      syntaxValid,
      mxFound,
      isRoleBased,
      verificationStatus,
      checkedAt,
      domain,
      provider: this.name,
      ...(dnsError ? { error: dnsError } : {}),
    };
  }
}

/**
 * Honest stand-in for a licensed bounce-prediction/mailbox-verification
 * provider we don't have credentials for in this environment. Always
 * throws — never returns a fabricated "this mailbox actually exists"
 * result. Wire in a real client (implementing `EmailVerificationProvider`)
 * once an API key exists.
 */
export class NotConfiguredBounceVerificationProvider implements EmailVerificationProvider {
  constructor(
    private readonly providerName = "email bounce-prediction provider (e.g. ZeroBounce/NeverBounce/Kickbox)",
  ) {}

  readonly name = "not_configured";

  async verifyEmail(_email: string): Promise<never> {
    throw new NotConfiguredError(
      `${this.providerName} is not configured (no API key available in this environment). ` +
        `Implement EmailVerificationProvider against a real provider and add it to the waterfall ` +
        `once credentials are available. Refusing to fabricate a mailbox-verification result.`,
    );
  }
}

/**
 * The email-verification provider waterfall used in production. A real
 * paid bounce-prediction provider, once credentials exist, is prepended
 * here — `verifyEmail` below doesn't change at all, since it only ever
 * depends on the `EmailVerificationProvider` interface via
 * `runProviderWaterfall`.
 */
export function buildEmailVerificationWaterfall(
  options: { resolver?: Pick<typeof dns.promises, "resolveMx"> } = {},
): EmailVerificationProvider[] {
  return [new NotConfiguredBounceVerificationProvider(), new DnsEmailVerificationProvider(options.resolver)];
}

/**
 * Tenant-aware waterfall, additive alongside `buildEmailVerificationWaterfall`
 * above (which is unchanged and still used wherever no tenant context is
 * available): when a tenant's own Abstract API credential (or
 * ABSTRACT_API_KEY dev-mode fallback) resolves via
 * `abstractApiProvider.ts#resolveAbstractApiKey` — same per-tenant
 * encrypted-credential convention every other real provider in this
 * codebase uses — a real `AbstractApiEmailVerificationProvider` is
 * PREPENDED ahead of the existing `[NotConfiguredBounceVerificationProvider,
 * DnsEmailVerificationProvider]` pair. Abstract API's deliverability check
 * (a real SMTP-level signal) is a strictly stronger answer than the free
 * DNS/MX-only check, so it is tried first; the free tier remains the
 * fallback when Abstract API itself errors (rate-limited, network failure,
 * etc.) or isn't configured for this tenant, so this is a pure addition —
 * never a regression for a tenant with no Abstract API credential.
 */
export async function buildEmailVerificationWaterfallForTenant(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  options: { resolver?: Pick<typeof dns.promises, "resolveMx"> } = {},
): Promise<EmailVerificationProvider[]> {
  const { buildAbstractApiEmailProvider } = await import("./abstractApiProvider.js");
  const abstractApi = await buildAbstractApiEmailProvider(tenantDb, tenantId, projectId);
  const providers: EmailVerificationProvider[] = [];
  if (abstractApi) providers.push(abstractApi);
  providers.push(...buildEmailVerificationWaterfall(options));
  return providers;
}

export async function verifyEmail(email: string, options: VerifyEmailOptions = {}): Promise<EmailVerificationResult> {
  const providers = options.providers ?? buildEmailVerificationWaterfall({ resolver: options.resolver });

  const outcome = await runProviderWaterfall<string, EmailVerificationResult>(
    providers.map((p) => ({ name: p.name, run: (e: string) => p.verifyEmail(e) })),
    email,
    // An EmailVerificationResult object is never null/an array, so the
    // default isEmpty would already treat it as non-empty — spelled out
    // here anyway so it's clear this waterfall never falls through past a
    // provider that actually returned a result (only past one that threw).
    { isEmpty: () => false },
  );

  // DnsEmailVerificationProvider never throws and always returns a result,
  // so with the default waterfall this is unreachable — but a caller could
  // pass a custom `providers` list that is empty or all-throwing, so this
  // stays an honest, typed fallback rather than a non-null assertion.
  if (!outcome.result) {
    const checkedAt = new Date().toISOString();
    return {
      syntaxValid: false,
      mxFound: false,
      isRoleBased: false,
      verificationStatus: "invalid",
      checkedAt,
      error: "No email verification provider produced a result.",
    };
  }

  return outcome.result;
}
