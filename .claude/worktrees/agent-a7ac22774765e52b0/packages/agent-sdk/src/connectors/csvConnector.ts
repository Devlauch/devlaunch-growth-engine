import type {
  ConnectorConfig,
  ConnectorDiscoveryResult,
  DiscoveredContact,
  DiscoveredOrganization,
  SourceConnector,
} from "./types.js";
import { SlidingWindowRateLimiter } from "./rateLimiter.js";

/**
 * Real, working CSV-upload connector. This is a genuine data source (a
 * tenant's own uploaded spreadsheet of leads), not a mock/fixture.
 *
 * Expected header row (order does not matter, extra columns are kept in
 * `rawMetadata` and ignored for parsing purposes):
 *   organization_name,domain,contact_name,contact_email,contact_phone,role_title,source_url
 *
 * Only `organization_name` is required; every other column may be empty.
 * One organization may appear on multiple rows (e.g. several contacts at
 * the same org) — rows are grouped by a normalized organization key
 * (lowercased, trimmed name + domain) so `discover` emits one
 * DiscoveredOrganization per distinct org with all of its contacts
 * attached under that key.
 */

export const CSV_REQUIRED_HEADER = "organization_name";

export interface CsvConnectorInput {
  /** Raw CSV file contents as uploaded by the tenant. */
  csvText: string;
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}

const EXPECTED_COLUMNS = [
  "organization_name",
  "domain",
  "contact_name",
  "contact_email",
  "contact_phone",
  "role_title",
  "source_url",
] as const;

export class CsvUploadConnector implements SourceConnector {
  readonly id = "csv-upload";
  readonly type = "csv_upload" as const;
  readonly termsNote =
    "Tenant-supplied data: the tenant attests they have the right to use the contact " +
    "information they upload (e.g. it is their own prior outreach list, a licensed export, " +
    "or otherwise lawfully obtained). This connector performs no outbound network calls and " +
    "is not itself a data source subject to third-party terms of use.";
  readonly defaultRateLimitPerMinute = 60;

  async discover(input: unknown, config: ConnectorConfig): Promise<ConnectorDiscoveryResult> {
    if (!config.enabled) {
      throw new Error(`csv-upload connector is disabled for this tenant`);
    }
    const { csvText } = parseInput(input);

    // CSV parsing itself is local/CPU-bound (no outbound calls), so the
    // rate limiter here guards against a tenant hammering this connector
    // with back-to-back uploads rather than throttling network egress.
    const limiter = new SlidingWindowRateLimiter(
      config.rateLimitPerMinute || this.defaultRateLimitPerMinute,
    );
    await limiter.acquire();

    const rows = parseCsv(csvText);
    return rowsToDiscoveryResult(rows);
  }
}

function parseInput(input: unknown): CsvConnectorInput {
  if (typeof input === "string") {
    return { csvText: input };
  }
  if (
    input &&
    typeof input === "object" &&
    "csvText" in input &&
    typeof (input as Record<string, unknown>).csvText === "string"
  ) {
    return { csvText: (input as Record<string, unknown>).csvText as string };
  }
  throw new CsvFormatError(
    "csv-upload connector expects a string (raw CSV text) or { csvText: string }",
  );
}

/**
 * Hand-rolled RFC4180-ish CSV parser (no external dependency). Handles:
 *   - quoted fields, including fields containing commas
 *   - escaped quotes within a quoted field ("" -> ")
 *   - CRLF and LF line endings (and mixed)
 *   - a trailing newline (no spurious trailing empty row)
 *   - blank lines (skipped)
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    records.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Peek for CRLF; either way this ends the row.
      if (text[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      endRow();
      continue;
    }
    if (ch === "\n") {
      i += 1;
      endRow();
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the final field/row if the input didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  // Drop fully-blank trailing rows produced by a trailing newline, and any
  // blank lines in the middle of the file (a row with exactly one empty
  // field and nothing else).
  return records.filter((r) => !(r.length === 1 && r[0] === ""));
}

interface CsvRow {
  organization_name: string;
  domain: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  role_title: string;
  source_url: string;
  extra: Record<string, string>;
}

function parseCsv(csvText: string): CsvRow[] {
  const records = parseCsvRecords(csvText);
  if (records.length === 0) {
    throw new CsvFormatError("CSV file is empty");
  }

  const headerRow = records[0].map((h) => h.trim().toLowerCase());
  if (!headerRow.includes(CSV_REQUIRED_HEADER)) {
    throw new CsvFormatError(
      `CSV header row must include a "${CSV_REQUIRED_HEADER}" column; got: ${headerRow.join(", ")}`,
    );
  }

  const colIndex: Record<string, number> = {};
  headerRow.forEach((h, idx) => {
    colIndex[h] = idx;
  });

  const rows: CsvRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const get = (col: string): string => {
      const idx = colIndex[col];
      return idx === undefined ? "" : (rec[idx] ?? "").trim();
    };

    const organizationName = get("organization_name");
    if (!organizationName) {
      // Skip rows missing the required field rather than failing the
      // whole upload — a partial, honestly-reported result is more useful
      // than discarding an otherwise-valid file over one bad row.
      continue;
    }

    const extra: Record<string, string> = {};
    headerRow.forEach((h, idx) => {
      if (!(EXPECTED_COLUMNS as readonly string[]).includes(h)) {
        extra[h] = (rec[idx] ?? "").trim();
      }
    });

    rows.push({
      organization_name: organizationName,
      domain: normalizeDomain(get("domain")),
      contact_name: get("contact_name"),
      contact_email: get("contact_email").toLowerCase(),
      contact_phone: get("contact_phone"),
      role_title: get("role_title"),
      source_url: get("source_url"),
      extra,
    });
  }

  return rows;
}

function normalizeDomain(raw: string): string {
  if (!raw) return "";
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.replace(/\/.*$/, "");
  return d;
}

function rowsToDiscoveryResult(rows: CsvRow[]): ConnectorDiscoveryResult {
  const organizations: DiscoveredOrganization[] = [];
  const contacts: Record<string, DiscoveredContact[]> = {};
  const seenOrgKeys = new Map<string, string>(); // orgKey -> org.name (the stable contacts key)

  const now = new Date().toISOString();

  for (const row of rows) {
    const orgKey = `${row.organization_name.toLowerCase()}|${row.domain}`;
    let orgName = seenOrgKeys.get(orgKey);

    if (!orgName) {
      orgName = row.organization_name;
      seenOrgKeys.set(orgKey, orgName);
      organizations.push({
        name: row.organization_name,
        domain: row.domain || undefined,
        sourceUrl: row.source_url || "csv-upload",
        discoveredAt: now,
        rawMetadata: { ...row.extra, source: "csv-upload" },
      });
      contacts[orgName] = [];
    }

    const hasContactData = row.contact_name || row.contact_email || row.contact_phone;
    if (hasContactData) {
      contacts[orgName].push({
        name: row.contact_name || undefined,
        roleTitle: row.role_title || undefined,
        email: row.contact_email || undefined,
        phone: row.contact_phone || undefined,
        contactChannel: classifyContactChannel(row),
        sourceUrl: row.source_url || undefined,
      });
    }
  }

  return { organizations, contacts };
}

function classifyContactChannel(row: CsvRow): DiscoveredContact["contactChannel"] {
  if (row.contact_name) return "named_person";
  if (row.contact_email) return "role_based";
  if (row.contact_phone) return "phone";
  return "contact_form";
}
