import dns from "node:dns";

/**
 * DNS-based sending-domain authentication checks (SPF/DKIM/DMARC) for
 * roadmap item 14 ("Sending setup per tenant").
 *
 * This mirrors apps/api/src/lib/emailVerification.ts's style exactly: a
 * real `dns.promises.resolveTxt` lookup (node's built-in resolver,
 * genuinely hitting the network) with an injectable resolver so tests
 * never touch real DNS, and graceful degradation — a DNS resolution
 * failure (NXDOMAIN, ENOTFOUND, SERVFAIL, timeout, etc.) is mapped to
 * `{ status: "not_found" }` rather than thrown. None of these functions
 * ever throws out of the function body.
 *
 * What these checks can and can't tell you:
 *   - They verify that a syntactically valid SPF/DKIM/DMARC TXT record
 *     exists at the expected DNS location. That's a genuinely real,
 *     independently-checkable signal about deliverability readiness,
 *     obtainable without any paid ESP/mailbox-provider account.
 *   - They do NOT verify that the record's *content* is correct for this
 *     tenant's actual sending infrastructure (e.g. that the SPF record
 *     actually includes the right sending IP/provider) — that requires
 *     knowing what infra will send the mail, which doesn't exist yet in
 *     this phase. "pass" here means "a well-formed record of this type is
 *     published", not "your email will deliver".
 */

export type DnsCheckStatus = "pass" | "fail" | "not_found";

export interface TxtResolver {
  resolveTxt: typeof dns.promises.resolveTxt;
}

export interface DnsCheckOptions {
  /** Injectable for tests — defaults to node's real dns.promises. */
  resolver?: TxtResolver;
}

export interface SpfCheckResult {
  status: DnsCheckStatus;
  record?: string;
}

export interface DmarcCheckResult {
  status: DnsCheckStatus;
  record?: string;
  policy?: "none" | "quarantine" | "reject";
}

export interface DkimCheckResult {
  status: DnsCheckStatus;
  record?: string;
}

/** Joins a dns.promises.resolveTxt() record (string[] chunks) into one string. */
function joinTxtRecord(chunks: string[]): string {
  return chunks.join("");
}

async function resolveTxtRecords(domain: string, resolver: TxtResolver): Promise<string[][] | null> {
  try {
    const records = await resolver.resolveTxt(domain);
    return Array.isArray(records) ? records : null;
  } catch {
    // NXDOMAIN, ENOTFOUND, SERVFAIL, timeout, etc. — we can't distinguish
    // "domain doesn't exist" from "transient DNS failure" from here, and
    // either way we never found the record, so "not_found" is honest.
    return null;
  }
}

/**
 * Checks for an SPF record on `domain` itself: a TXT record whose value
 * starts with "v=spf1".
 */
export async function checkSpf(domain: string, options: DnsCheckOptions = {}): Promise<SpfCheckResult> {
  const resolver = options.resolver ?? dns.promises;
  const txtRecords = await resolveTxtRecords(domain, resolver);
  if (txtRecords === null) return { status: "not_found" };

  const joined = txtRecords.map(joinTxtRecord);
  const spfRecords = joined.filter((r) => r.trim().toLowerCase().startsWith("v=spf1"));
  if (spfRecords.length === 0) return { status: "not_found" };
  // RFC 7208: a domain must publish at most one SPF record. More than one
  // is a real, independently-checkable misconfiguration (most receivers
  // treat it as a permanent SPF failure) — "fail", not "pass".
  if (spfRecords.length > 1) return { status: "fail", record: spfRecords.join(" | ") };

  return { status: "pass", record: spfRecords[0] };
}

/**
 * Checks for a DMARC record at `_dmarc.<domain>`: a TXT record whose value
 * starts with "v=DMARC1", and parses its `p=` policy (none/quarantine/
 * reject) when present. A record that starts with v=DMARC1 but has no
 * parseable `p=` tag (malformed) is still reported as "pass" with the raw
 * record and no `policy` — "pass" means "a DMARC record exists", not "it's
 * a perfectly well-formed one with every optional tag".
 */
export async function checkDmarc(domain: string, options: DnsCheckOptions = {}): Promise<DmarcCheckResult> {
  const resolver = options.resolver ?? dns.promises;
  const txtRecords = await resolveTxtRecords(`_dmarc.${domain}`, resolver);
  if (txtRecords === null) return { status: "not_found" };

  const joined = txtRecords.map(joinTxtRecord);
  const dmarcRecords = joined.filter((r) => r.trim().toLowerCase().startsWith("v=dmarc1"));
  if (dmarcRecords.length === 0) return { status: "not_found" };
  // RFC 7489: more than one DMARC TXT record at _dmarc.<domain> means
  // receivers must ignore all of them — a real, checkable misconfiguration.
  if (dmarcRecords.length > 1) return { status: "fail", record: dmarcRecords.join(" | ") };

  const dmarcRecord = dmarcRecords[0];
  const policyMatch = dmarcRecord.match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i);
  const policy = policyMatch ? (policyMatch[1].toLowerCase() as "none" | "quarantine" | "reject") : undefined;
  if (!policy) {
    // Present and starts with v=DMARC1, but no parseable (or no) required
    // p= tag — a DMARC record without a policy isn't a usable one.
    return { status: "fail", record: dmarcRecord };
  }

  return { status: "pass", record: dmarcRecord, policy };
}

/**
 * Checks for a DKIM record at `<selector>._domainkey.<domain>`: a TXT
 * record whose value contains "v=DKIM1".
 *
 * DKIM selectors are provider/configuration-specific (e.g. "google",
 * "s1", "mandrill", a per-ESP generated string) — there is no universal
 * default to guess, and guessing wrong would silently report a false
 * "not_found" for a domain that actually has DKIM configured under a
 * different selector. Callers MUST supply the selector the tenant
 * actually published (e.g. from their ESP's setup instructions); this
 * function makes no attempt to discover it.
 */
export async function checkDkim(
  domain: string,
  selector: string,
  options: DnsCheckOptions = {},
): Promise<DkimCheckResult> {
  const resolver = options.resolver ?? dns.promises;
  const txtRecords = await resolveTxtRecords(`${selector}._domainkey.${domain}`, resolver);
  if (txtRecords === null) return { status: "not_found" };

  const joined = txtRecords.map(joinTxtRecord);
  const dkimRecords = joined.filter((r) => /v=dkim1/i.test(r));
  if (dkimRecords.length === 0) return { status: "not_found" };
  if (dkimRecords.length > 1) return { status: "fail", record: dkimRecords.join(" | ") };

  const dkimRecord = dkimRecords[0];
  // A DKIM TXT record must carry a public key ("p=") tag; an empty p=
  // means the key was revoked, and a record with neither is malformed.
  if (!/[;\s]p\s*=/i.test(`;${dkimRecord}`)) {
    return { status: "fail", record: dkimRecord };
  }

  return { status: "pass", record: dkimRecord };
}
