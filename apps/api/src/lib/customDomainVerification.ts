/**
 * Real custom-domain DNS ownership verification for landing pages
 * (Milestone 3) — closes the gap the audit and 263_create_landing_pages.sql's
 * own comment document: `custom_domain` was store-only, with no DNS/CDN
 * provisioning logic anywhere.
 *
 * This mirrors apps/api/src/lib/dnsVerification.ts's EXACT style and
 * conventions, not a new DNS-checking approach: a real
 * `dns.promises.resolveTxt` lookup (node's built-in resolver, genuinely
 * hitting the network) with an injectable resolver so tests never touch
 * real DNS, and graceful degradation — any DNS resolution failure
 * (NXDOMAIN, ENOTFOUND, SERVFAIL, timeout, etc.) is mapped to a
 * `{ status: "not_found" }`-shaped outcome rather than thrown. Nothing here
 * ever throws out of a function body.
 *
 * Flow:
 *   1. generateVerificationToken() — a real, unique, cryptographically
 *      random token (not a sequential/guessable id), generated once and
 *      persisted (landing_pages.verification_token — see migration
 *      511_add_domain_verification_to_landing_pages.sql).
 *   2. The tenant is told (by the route layer) to publish it as a TXT
 *      record at `_devlaunch-verify.<domain>` with that exact token value.
 *   3. verifyCustomDomainOwnership() does a real TXT lookup at that name
 *      and confirms the token is present among the records returned —
 *      only then does landing_pages.verification_status move to
 *      'verified' (route layer's responsibility; this module is a pure
 *      check, it never writes to the database itself).
 */
import dns from "node:dns";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";

export interface TxtResolver {
  resolveTxt: typeof dns.promises.resolveTxt;
}

export interface CustomDomainVerificationOptions {
  /** Injectable for tests — defaults to node's real dns.promises. */
  resolver?: TxtResolver;
}

export type CustomDomainVerificationStatus = "verified" | "not_found" | "invalid_domain";

export interface CustomDomainVerificationResult {
  status: CustomDomainVerificationStatus;
  /** The exact DNS name checked (`_devlaunch-verify.<domain>`), for surfacing in the API response/UI instructions. */
  recordName: string;
  /** All TXT record values found at recordName (joined chunks), for debugging a near-miss (typo, wrong value, etc.). */
  foundRecords?: string[];
}

/**
 * Generates a real, unique verification token: 32 random bytes, base64url
 * encoded (`crypto.randomBytes`, node's CSPRNG — never Math.random or any
 * other non-cryptographic source). Each landing page gets its own token;
 * a domain can be re-verified at any time by generating a fresh token if
 * the tenant ever needs to re-prove ownership (e.g. after a domain
 * transfer to a different tenant).
 */
export function generateVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The exact DNS name a tenant must publish the TXT record at for a given domain. */
export function verificationRecordName(domain: string): string {
  return `${env.customDomainVerificationTxtPrefix}.${domain}`;
}

const DOMAIN_REGEX = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/** A conservative, real-world-domain-shaped check — rejects empty/malformed input before ever touching DNS. */
export function isPlausibleDomain(domain: string): boolean {
  return typeof domain === "string" && domain.length > 0 && domain.length <= 253 && DOMAIN_REGEX.test(domain.trim());
}

function joinTxtRecord(chunks: string[]): string {
  return chunks.join("");
}

/**
 * Checks whether `token` is published as a TXT record at
 * `_devlaunch-verify.<domain>`. Returns `{ status: "invalid_domain" }`
 * without ever touching the network for a malformed domain;
 * `{ status: "not_found" }` for any DNS failure or a record set that
 * doesn't contain the token; `{ status: "verified" }` only when the exact
 * token is present among the TXT records returned.
 */
export async function verifyCustomDomainOwnership(
  domain: string,
  token: string,
  options: CustomDomainVerificationOptions = {},
): Promise<CustomDomainVerificationResult> {
  const recordName = verificationRecordName(domain);

  if (!isPlausibleDomain(domain) || !token) {
    return { status: "invalid_domain", recordName };
  }

  const resolver = options.resolver ?? dns.promises;
  let txtRecords: string[][];
  try {
    const result = await resolver.resolveTxt(recordName);
    txtRecords = Array.isArray(result) ? result : [];
  } catch {
    // NXDOMAIN, ENOTFOUND, SERVFAIL, timeout, etc. — same honest
    // can't-distinguish-cause mapping as dnsVerification.ts.
    return { status: "not_found", recordName };
  }

  const joined = txtRecords.map(joinTxtRecord);
  if (joined.some((record) => record.trim() === token)) {
    return { status: "verified", recordName, foundRecords: joined };
  }

  return { status: "not_found", recordName, foundRecords: joined };
}
