import type { PoolClient } from "pg";

/**
 * Deduplication helpers for discovered organizations/contacts. Connectors
 * (public directories, website crawls, CSV uploads) regularly re-surface
 * the same organization or contact across runs; these normalizers + lookup
 * queries let callers detect that before inserting a duplicate row, in
 * addition to the DB-level unique indexes (see
 * packages/db/migrations/027_create_discovered_organizations.sql and
 * 028_create_discovered_contacts.sql) which are the last line of defense.
 */

const COMMON_ORG_SUFFIXES = [
  "private limited",
  "pvt ltd",
  "pvt. ltd.",
  "pvt ltd.",
  "pvt. ltd",
  // Australia/NZ/South Africa's equivalent of "Pvt Ltd" — previously
  // missing, which meant "Acme Pty Ltd" only had its trailing "ltd"
  // stripped (by the entry below) and normalized to "acme pty" instead of
  // "acme", so it silently failed to dedup against the same company listed
  // elsewhere as plain "Acme". Listed ahead of the bare "ltd"/"limited"
  // entries so the combined suffix is recognized as one unit.
  "pty ltd",
  "pty. ltd.",
  "pty ltd.",
  "pty. ltd",
  "pty limited",
  "proprietary limited",
  "limited",
  "ltd",
  "llc",
  "l.l.c.",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
];

/**
 * Normalizes a domain or URL into a bare, lowercase, domain-shaped string
 * suitable for exact-match dedup. Returns null if the input isn't
 * domain-shaped after stripping protocol/www/path.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (value.length === 0) return null;

  // Strip protocol.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Drop any path/query/fragment/port.
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.split(":")[0] ?? "";
  // Strip leading www.
  value = value.replace(/^www\./, "");
  // Strip trailing dot (FQDN form).
  value = value.replace(/\.$/, "");

  if (value.length === 0) return null;

  // Domain-shaped: labels of alnum/hyphen separated by dots, a dotted TLD,
  // no spaces or other invalid characters.
  const domainRe = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (!domainRe.test(value)) return null;

  return value;
}

/**
 * Normalizes an organization name for fuzzy-ish exact matching: lowercase,
 * strip common legal-entity suffixes (Inc, LLC, Ltd, Pvt Ltd, Corp, Co),
 * strip punctuation, collapse whitespace.
 */
export function normalizeOrgName(input: string | null | undefined): string {
  if (!input || typeof input !== "string") return "";
  let value = input.trim().toLowerCase();

  // Strip punctuation (keep alphanumerics and spaces).
  value = value.replace(/[.,'"`’‘()&/\\-]/g, " ");
  value = value.replace(/\s+/g, " ").trim();

  // Strip a trailing legal-entity suffix (possibly more than one, e.g.
  // "Acme Corp Inc").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMMON_ORG_SUFFIXES) {
      const suffixNoPunct = suffix.replace(/[.]/g, "");
      const re = new RegExp(`\\s${suffixNoPunct.replace(/\s+/g, "\\s+")}$`);
      if (re.test(value)) {
        value = value.replace(re, "").trim();
        changed = true;
      }
    }
  }

  return value.replace(/\s+/g, " ").trim();
}

/** Normalizes an email for exact-match dedup: lowercase + trim. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (value.length === 0) return null;
  return value;
}

export interface DuplicateOrganizationMatch {
  id: string;
  name: string;
  domain: string | null;
}

export interface DuplicateContactMatch {
  id: string;
  name: string | null;
  email: string | null;
}

/**
 * Looks for an existing discovered_organizations row matching the given
 * domain (exact, normalized) or name (exact, normalized) within the same
 * tenant+project. Domain match is checked first since it's the stronger
 * signal; name is a fallback for sources that don't expose a domain.
 */
export async function findDuplicateOrganization(
  tenantDb: Pick<PoolClient, "query">,
  projectId: string,
  org: { domain?: string | null; name?: string | null },
): Promise<DuplicateOrganizationMatch | null> {
  const normalizedDomain = normalizeDomain(org.domain);
  const normalizedName = normalizeOrgName(org.name);

  if (normalizedDomain) {
    const byDomain = await tenantDb.query(
      `SELECT id, name, domain FROM discovered_organizations
       WHERE project_id = $1 AND normalized_domain = $2
       LIMIT 1`,
      [projectId, normalizedDomain],
    );
    if (byDomain.rowCount && byDomain.rowCount > 0) {
      return byDomain.rows[0] as DuplicateOrganizationMatch;
    }
  }

  if (normalizedName) {
    const byName = await tenantDb.query(
      `SELECT id, name, domain FROM discovered_organizations
       WHERE project_id = $1 AND normalized_name = $2
       LIMIT 1`,
      [projectId, normalizedName],
    );
    if (byName.rowCount && byName.rowCount > 0) {
      return byName.rows[0] as DuplicateOrganizationMatch;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fuzzy name-similarity (tier 2 dedup)
//
// Ported from milestone3-phase2 (apps/api/src/lib/dedup.ts, Track 2) as an
// ADDITION alongside the exact-match tier above, not a replacement of it. The
// exact-normalized matching above already catches a surprising amount of
// near-miss cases "for free" — normalizeOrgName() strips legal suffixes and
// punctuation, so "Acme Inc." and "Acme, Incorporated" both normalize to the
// same "acme" string and match EXACTLY, no fuzzy logic required. The real
// gap exact matching cannot close:
//   - Same company, genuinely different domain strings that aren't a simple
//     www./protocol variant (e.g. "acme.com" vs "acme.io" — a company that
//     operates two TLDs, or a connector that resolved a redirect/alias
//     domain) — normalizeDomain() correctly treats these as different
//     domains (they ARE different domains), so the domain tier naturally
//     misses this and falls through to the name tier.
//   - Same company, name strings that differ by more than a legal suffix —
//     a dropped/added word ("Acme Technologies" vs "Acme Tech"), a leading
//     article ("The Weather Company" vs "Weather Company"), a minor
//     misspelling/typo a human or OCR-ish source introduced.
// For these, this module never auto-merges — only a human can confirm two
// genuinely different name strings refer to the same real company. Instead,
// findPossibleDuplicateOrganization() below runs ONLY after the exact tier
// (findDuplicateOrganization, domain then normalized name) has already
// missed, and flags a conservative fuzzy match via the `possible_duplicate_of`
// column (see packages/db/migrations/441_add_possible_duplicate_to_discovered_organizations.sql)
// for human review in the dashboard — it is never treated as a duplicate for
// skip-insert purposes the way findDuplicateOrganization's exact matches are.
// HARD REQUIREMENT: nothing in this section may auto-merge or write a merge
// on its own; see "flag-only, never auto-merge" test coverage in
// apps/api/test/dedup.test.ts.
// ---------------------------------------------------------------------------

/**
 * Classic Levenshtein (single-character insert/delete/substitute) edit
 * distance, O(a.length * b.length) time and O(b.length) space (rolling two
 * rows rather than a full matrix). No new dependency — this is the entire
 * well-known algorithm, not a stub.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = new Array<number>(b.length + 1);
  let currRow = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + substitutionCost, // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[b.length];
}

/** Levenshtein distance normalized into a 0-1 similarity (1 = identical). */
function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Jaccard similarity over whitespace-separated word tokens: catches
 * word-reordering / a single dropped-or-added word ("Acme Global Robotics"
 * vs "Global Acme Robotics", or "Acme Robotics" vs "Acme Robotics Inc" —
 * though the latter is normally already handled by normalizeOrgName's suffix
 * stripping before this is ever reached) better than a pure edit-distance
 * score would, since Levenshtein penalizes a whole reordered/inserted word
 * heavily even though it's a weak signal of a genuinely different company.
 */
function tokenOverlapSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize += 1;
  }
  const unionSize = new Set([...tokensA, ...tokensB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Combined 0-1 similarity score for two already-normalized org names: the
 * better (higher) of character-level (Levenshtein) and word-level (token
 * Jaccard) similarity, so either a typo-level difference OR a
 * word-reordering/minor-word difference can earn a high score without
 * requiring both signals to agree. Exported for direct unit testing.
 */
export function orgNameSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  return Math.max(levenshteinSimilarity(a, b), tokenOverlapSimilarity(a, b));
}

/**
 * Conservative on purpose: this threshold only ever gates a "flag for human
 * review" outcome, never an auto-merge, but a threshold that's too low would
 * flood the review queue with unrelated companies that happen to share a
 * common word ("Acme Consulting" vs "Beta Consulting"). 0.82 requires names
 * to be a near-miss (a handful of character edits, or nearly all words
 * shared), not merely related.
 */
const FUZZY_ORG_NAME_MATCH_THRESHOLD = 0.82;

/**
 * Minimum normalized-name length considered for fuzzy matching. Very short
 * normalized names (e.g. "co", "abc") produce noisy, high-similarity-by-
 * coincidence scores against unrelated short names, so they're excluded
 * from the fuzzy tier entirely (exact matching still applies to them).
 */
const FUZZY_ORG_NAME_MIN_LENGTH = 4;

/**
 * True when two normalized org names are similar enough to flag as a
 * possible duplicate, but NOT identical (identical strings are already
 * caught by findDuplicateOrganization's exact-match tier, and this is only
 * ever meant to run after that tier has already missed).
 */
export function isFuzzyOrgNameMatch(normalizedA: string, normalizedB: string): boolean {
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return false;
  if (normalizedA.length < FUZZY_ORG_NAME_MIN_LENGTH || normalizedB.length < FUZZY_ORG_NAME_MIN_LENGTH) return false;
  return orgNameSimilarity(normalizedA, normalizedB) >= FUZZY_ORG_NAME_MATCH_THRESHOLD;
}

/** Bound on how many existing organizations are pulled back as fuzzy-match
 * candidates for one new organization — this scores candidates in JS
 * (Levenshtein isn't a built-in SQL operator, and adding a Postgres
 * extension like pg_trgm is out of scope here), so it has to stay bounded
 * rather than scanning an unbounded table. Newest-first so an active
 * project's recent discovery runs (the likeliest source of a near-duplicate
 * from a second provider in the same campaign) are favored over old
 * archived rows once a project has more than this many organizations. */
const FUZZY_CANDIDATE_SCAN_LIMIT = 500;

/**
 * Tier-2 dedup check: looks for an existing discovered_organizations row
 * whose normalized name is a close-but-not-exact match (see
 * isFuzzyOrgNameMatch) to the given organization, within the same
 * tenant+project. Callers MUST only invoke this after findDuplicateOrganization
 * has already returned null for the same input — this never re-checks for an
 * exact match, and a result here is never treated as a confirmed duplicate:
 * it is surfaced to callers purely so they can record it as
 * `possible_duplicate_of` for a human to review, never to skip an insert or
 * silently merge two rows. Returns the single best-scoring candidate above
 * the threshold (or null if none clears it).
 *
 * This function never writes to the database and never merges rows — it
 * only reads candidates and returns a match for the CALLER to decide what to
 * do with (e.g. set `possible_duplicate_of` on insert). It must stay that
 * way: flag-only, never auto-merge.
 */
export async function findPossibleDuplicateOrganization(
  tenantDb: Pick<PoolClient, "query">,
  projectId: string,
  org: { name?: string | null },
  excludeOrganizationId?: string,
): Promise<DuplicateOrganizationMatch | null> {
  const normalizedName = normalizeOrgName(org.name);
  if (!normalizedName || normalizedName.length < FUZZY_ORG_NAME_MIN_LENGTH) return null;

  const candidates = await tenantDb.query(
    `SELECT id, name, domain, normalized_name FROM discovered_organizations
     WHERE project_id = $1 AND normalized_name IS NOT NULL AND id != COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY discovered_at DESC
     LIMIT ${FUZZY_CANDIDATE_SCAN_LIMIT}`,
    [projectId, excludeOrganizationId ?? null],
  );

  let best: (DuplicateOrganizationMatch & { normalized_name: string }) | null = null;
  let bestScore = 0;
  for (const row of candidates.rows as (DuplicateOrganizationMatch & { normalized_name: string })[]) {
    if (!isFuzzyOrgNameMatch(normalizedName, row.normalized_name)) continue;
    const score = orgNameSimilarity(normalizedName, row.normalized_name);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (!best) return null;
  return { id: best.id, name: best.name, domain: best.domain };
}

/**
 * Normalizes a person's name for fuzzy-ish exact matching: lowercase, trim,
 * collapse internal whitespace. Mirrors normalizeOrgName/normalizeDomain's
 * normalize-before-compare approach — a contact name has no dedicated
 * `normalized_name` column (unlike discovered_organizations.normalized_name
 * or discovered_contacts.normalized_email), so this is applied at query time
 * on both sides of the comparison instead.
 */
export function normalizeContactName(input: string | null | undefined): string {
  if (!input || typeof input !== "string") return "";
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Normalizes a person's name for fuzzy-ish exact matching: lowercase, trim,
 * collapse internal whitespace. Mirrors normalizeOrgName/normalizeDomain's
 * normalize-before-compare approach — a contact name has no dedicated
 * `normalized_name` column (unlike discovered_organizations.normalized_name
 * or discovered_contacts.normalized_email), so this is applied at query time
 * on both sides of the comparison instead.
 */
export function normalizeContactName(input: string | null | undefined): string {
  if (!input || typeof input !== "string") return "";
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Looks for an existing discovered_contacts row matching the given email
 * (exact, normalized) or name within the same organization. Email match is
 * checked first; name is a fallback for sources without an email.
 *
 * The name fallback compares normalized values (trimmed, lowercased,
 * whitespace-collapsed) rather than a raw exact string match — two
 * connector runs surfacing "Jane Doe" and "jane  doe" (different casing or
 * double-spacing from a scraped page) are the same real person and must
 * dedup, not silently create a second discovered_contacts row for the same
 * lead. Previously this compared `name = $2` verbatim, so any casing or
 * whitespace difference across runs/sources defeated the dedup guard this
 * function exists to provide.
 */
export async function findDuplicateContact(
  tenantDb: Pick<PoolClient, "query">,
  organizationId: string,
  contact: { email?: string | null; name?: string | null },
): Promise<DuplicateContactMatch | null> {
  const normalizedEmail = normalizeEmail(contact.email);

  if (normalizedEmail) {
    const byEmail = await tenantDb.query(
      `SELECT id, name, email FROM discovered_contacts
       WHERE organization_id = $1 AND normalized_email = $2
       LIMIT 1`,
      [organizationId, normalizedEmail],
    );
    if (byEmail.rowCount && byEmail.rowCount > 0) {
      return byEmail.rows[0] as DuplicateContactMatch;
    }
  }

  const normalizedName = normalizeContactName(contact.name);
  if (normalizedName.length > 0) {
    const byName = await tenantDb.query(
      `SELECT id, name, email FROM discovered_contacts
       WHERE organization_id = $1 AND lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = $2
       LIMIT 1`,
      [organizationId, normalizedName],
    );
    if (byName.rowCount && byName.rowCount > 0) {
      return byName.rows[0] as DuplicateContactMatch;
    }
  }

  return null;
}
