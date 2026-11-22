/**
 * CSV export for discovered prospects (discovered_organizations +
 * discovered_contacts). Pure, DB-free formatting functions so they're easy
 * to unit test directly — the route (discovery.ts) only queries the rows
 * and calls these.
 */

export interface ExportOrganizationRow {
  name: string;
  domain: string | null;
  status: string;
  source_confidence: string | null;
  discovered_at: string | Date;
  source_url: string | null;
}

export interface ExportContactRow {
  organization_name: string;
  organization_domain: string | null;
  name: string | null;
  role_title: string | null;
  email: string | null;
  phone: string | null;
  contact_channel: string;
  verification_status: string;
  source_confidence: string | null;
}

/**
 * Escapes a single CSV field per RFC 4180: wraps in double quotes (and
 * doubles any embedded double quotes) whenever the value contains a comma,
 * double quote, or newline. null/undefined become an empty field, never the
 * literal string "null"/"undefined".
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvField).join(",");
}

const ORGANIZATION_HEADERS = ["Name", "Domain", "Status", "Source Confidence", "Discovered At", "Source URL"];

/** Builds a full CSV document (header row + one row per organization) of
 * qualified prospects for export. */
export function organizationsToCsv(rows: ExportOrganizationRow[]): string {
  const lines = [toRow(ORGANIZATION_HEADERS)];
  for (const row of rows) {
    const discoveredAt = row.discovered_at instanceof Date ? row.discovered_at.toISOString() : row.discovered_at;
    lines.push(
      toRow([row.name, row.domain, row.status, row.source_confidence, discoveredAt, row.source_url]),
    );
  }
  // CRLF line endings: the conventional CSV wire format, and what most
  // spreadsheet tools (Excel in particular) expect.
  return lines.join("\r\n") + "\r\n";
}

const CONTACT_HEADERS = [
  "Organization",
  "Organization Domain",
  "Contact Name",
  "Role / Title",
  "Email",
  "Phone",
  "Contact Channel",
  "Verification Status",
  "Source Confidence",
];

/** Builds a full CSV document (header row + one row per contact) of
 * qualified prospects' contacts for export. */
export function contactsToCsv(rows: ExportContactRow[]): string {
  const lines = [toRow(CONTACT_HEADERS)];
  for (const row of rows) {
    lines.push(
      toRow([
        row.organization_name,
        row.organization_domain,
        row.name,
        row.role_title,
        row.email,
        row.phone,
        row.contact_channel,
        row.verification_status,
        row.source_confidence,
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
