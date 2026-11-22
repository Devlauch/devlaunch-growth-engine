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

/**
 * Looks for an existing discovered_contacts row matching the given email
 * (exact, normalized) or name within the same organization. Email match is
 * checked first; name is a fallback for sources without an email.
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

  if (contact.name && contact.name.trim().length > 0) {
    const byName = await tenantDb.query(
      `SELECT id, name, email FROM discovered_contacts
       WHERE organization_id = $1 AND name = $2
       LIMIT 1`,
      [organizationId, contact.name.trim()],
    );
    if (byName.rowCount && byName.rowCount > 0) {
      return byName.rows[0] as DuplicateContactMatch;
    }
  }

  return null;
}
