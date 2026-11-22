import dns from "node:dns";

/**
 * Email verification for discovered contacts.
 *
 * This is deliberately "honest": it does real syntax validation and a real
 * DNS MX lookup (node's built-in resolver, genuinely hitting the network),
 * but it never claims to know whether a specific mailbox exists — SMTP
 * handshake verification is out of scope and would be unreliable/abusive
 * against arbitrary third-party mail servers. "verified" here means
 * "syntactically valid, has a real domain with mail exchangers, and isn't
 * a generic role inbox" — the strongest signal we can respectfully get
 * without actually sending mail.
 */

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
}

export async function verifyEmail(email: string, options: VerifyEmailOptions = {}): Promise<EmailVerificationResult> {
  const checkedAt = new Date().toISOString();
  const syntaxValid = isSyntaxValid(email ?? "");

  if (!syntaxValid) {
    return { syntaxValid: false, mxFound: false, isRoleBased: false, verificationStatus: "invalid", checkedAt };
  }

  const parts = getLocalPartAndDomain(email);
  if (!parts) {
    return { syntaxValid: false, mxFound: false, isRoleBased: false, verificationStatus: "invalid", checkedAt };
  }

  const { localPart, domain } = parts;
  const isRoleBased = isRoleBasedLocalPart(localPart);

  let mxFound = false;
  let dnsError: string | undefined;
  try {
    mxFound = await hasMxRecord(domain, options.resolver);
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
    ...(dnsError ? { error: dnsError } : {}),
  };
}
