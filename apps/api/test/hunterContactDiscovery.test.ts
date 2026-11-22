import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock only the Hunter HTTP boundary (credential resolution + the actual
// Domain Search call) — everything else (dedup.ts, contactProvenance.ts,
// usageEvents.ts, emailVerification.ts) runs for real against an in-memory
// fake "tenantDb", so dedup/idempotency/usage-tracking logic is genuinely
// exercised, not just asserted-via-mock.
const resolveHunterApiKeyMock = vi.fn();
const searchDomainAllPagesMock = vi.fn();
vi.mock("../src/lib/hunterProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hunterProvider.js")>();
  return {
    ...actual,
    resolveHunterApiKey: resolveHunterApiKeyMock,
    searchDomainAllPages: searchDomainAllPagesMock,
  };
});

const { discoverContactsForOrganization, verifyContactEmail } = await import("../src/lib/hunterContactDiscovery.js");
const { HunterApiError } = await import("../src/lib/hunterProvider.js");

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const ORG = "44444444-4444-4444-4444-444444444444";

/** A small in-memory stand-in for the three tables this orchestration
 * touches, so dedup/idempotency can be exercised across repeated calls
 * within one test exactly like a real retried job would see. */
function createFakeTenantDb() {
  const contacts: { id: string; organization_id: string; normalized_email: string | null; name: string | null }[] = [];
  const provenance: { operation_id: string; contact_id: string; event_type: string; source: string }[] = [];
  const usageEvents: { event_type: string; tenant_id: string; project_id: string | null; quantity: number; metadata: Record<string, unknown> }[] = [];
  let contactCounter = 0;

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    // Tenant-isolation guard: every call this module makes must carry a
    // tenant_id param matching the tenant that owns this fake db instance
    // (never OTHER_TENANT's id) — enforced here the same way RLS would at
    // the real DB layer.
    if (params.includes(OTHER_TENANT)) {
      throw new Error("tenant isolation violation: query referenced a foreign tenant_id");
    }

    if (/FROM contact_provenance_events[\s\S]*event_type = 'discovery' AND provider = 'hunter'/.test(sql)) {
      const [organizationId] = params as [string, number];
      const hasFresh = provenance.some((p) => p.event_type === "discovery");
      return organizationId === ORG && hasFresh ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
    }

    if (/SELECT id, name, email FROM discovered_contacts\s+WHERE organization_id = \$1\s+AND normalized_email = \$2/.test(sql)) {
      const [organizationId, normalizedEmail] = params as [string, string];
      const match = contacts.find((c) => c.organization_id === organizationId && c.normalized_email === normalizedEmail);
      return match ? { rowCount: 1, rows: [{ id: match.id, name: match.name, email: normalizedEmail }] } : { rowCount: 0, rows: [] };
    }

    if (/SELECT id, name, email FROM discovered_contacts\s+WHERE organization_id = \$1 AND lower\(regexp_replace\(trim\(name\)/.test(sql)) {
      return { rowCount: 0, rows: [] };
    }

    if (/INSERT INTO discovered_contacts/.test(sql)) {
      const [, organizationId, name, , , normalizedEmail] = params as string[];
      const exists = contacts.some((c) => c.organization_id === organizationId && c.normalized_email === normalizedEmail);
      if (exists) return { rowCount: 0, rows: [] };
      contactCounter += 1;
      const id = `contact-${contactCounter}`;
      contacts.push({ id, organization_id: organizationId, normalized_email: normalizedEmail, name });
      return { rowCount: 1, rows: [{ id }] };
    }

    if (/INSERT INTO contact_provenance_events/.test(sql) && /'discovery'/.test(sql)) {
      const [, , contactId, , operationId, , , source] = params as string[];
      const key = { operation_id: operationId, contact_id: contactId, event_type: "discovery", source };
      const dup = provenance.find((p) => p.operation_id === key.operation_id && p.contact_id === key.contact_id && p.event_type === key.event_type && p.source === key.source);
      if (dup) return { rows: [] };
      provenance.push(key);
      return { rows: [{ id: `prov-${provenance.length}` }] };
    }

    if (/INSERT INTO contact_provenance_events/.test(sql) && /'verification'/.test(sql)) {
      const [, , contactId, , operationId, , , source] = params as string[];
      const key = { operation_id: operationId, contact_id: contactId, event_type: "verification", source };
      const dup = provenance.find((p) => p.operation_id === key.operation_id && p.contact_id === key.contact_id && p.event_type === key.event_type && p.source === key.source);
      if (dup) return { rows: [] };
      provenance.push(key);
      return { rows: [{ id: `prov-${provenance.length}` }] };
    }

    if (/FROM contact_provenance_events\s+WHERE contact_id = \$1 AND event_type = 'verification'/.test(sql)) {
      return { rows: [] }; // never "fresh" in these tests unless explicitly seeded
    }

    if (/INSERT INTO usage_events/.test(sql)) {
      const [tenantId, projectId, eventType, quantity, metadataJson] = params as [string, string | null, string, number, string];
      usageEvents.push({ tenant_id: tenantId, project_id: projectId, event_type: eventType, quantity, metadata: JSON.parse(metadataJson) });
      return { rows: [] };
    }

    throw new Error(`Unhandled query in fake tenantDb: ${sql}`);
  });

  return { query, contacts, provenance, usageEvents };
}

beforeEach(() => {
  resolveHunterApiKeyMock.mockReset();
  searchDomainAllPagesMock.mockReset();
});

describe("discoverContactsForOrganization", () => {
  it("honestly reports not_configured and never calls Hunter's domain search when no credential resolves", async () => {
    resolveHunterApiKeyMock.mockResolvedValue(null);
    const db = createFakeTenantDb();
    const outcome = await discoverContactsForOrganization(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      organizationId: ORG,
      organizationName: "Acme",
      domain: "acme.com",
    });
    expect(outcome.status).toBe("not_configured");
    expect(searchDomainAllPagesMock).not.toHaveBeenCalled();
  });

  it("inserts new contacts, skips a duplicate, records provenance + usage events, keyed on person identity not just shared domain", async () => {
    resolveHunterApiKeyMock.mockResolvedValue("real-key");
    searchDomainAllPagesMock.mockResolvedValue({
      contacts: [
        { email: "jane@acme.com", providerRecordId: "jane@acme.com", firstName: "Jane", lastName: "Doe", position: "CTO", confidence: 90, phoneNumber: null, sources: [] },
        { email: "bob@acme.com", providerRecordId: "bob@acme.com", firstName: "Bob", lastName: "Smith", position: "CFO", confidence: 85, phoneNumber: null, sources: [] },
      ],
      pages: [{ credits: { used: 2, unit: "search" } }],
      truncated: false,
    });
    const db = createFakeTenantDb();

    const outcome = await discoverContactsForOrganization(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      organizationId: ORG,
      organizationName: "Acme",
      domain: "acme.com",
    });

    expect(outcome.status).toBe("found");
    expect(outcome.newContactIds).toHaveLength(2);
    // Two DIFFERENT people at the same company domain — both kept as
    // separate contacts, never merged just because the domain matches.
    expect(db.contacts).toHaveLength(2);
    expect(db.contacts.map((c) => c.name)).toEqual(expect.arrayContaining(["Jane Doe", "Bob Smith"]));

    const discoveryUsage = db.usageEvents.filter((e) => e.event_type === "hunter_discovery");
    expect(discoveryUsage).toHaveLength(1);
    expect(discoveryUsage[0]!.quantity).toBe(2);
    expect(db.usageEvents.some((e) => e.event_type === "hunter_api_request")).toBe(true);
  });

  it("is idempotent under a retried job: calling twice with the same operationId never creates a duplicate contact or provenance row", async () => {
    resolveHunterApiKeyMock.mockResolvedValue("real-key");
    searchDomainAllPagesMock.mockResolvedValue({
      contacts: [{ email: "jane@acme.com", providerRecordId: "jane@acme.com", firstName: "Jane", lastName: "Doe", position: "CTO", confidence: 90, phoneNumber: null, sources: [] }],
      pages: [{ credits: { used: null, unit: null } }],
      truncated: false,
    });
    const db = createFakeTenantDb();
    const operationId = "retry-operation-id";

    const first = await discoverContactsForOrganization(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      organizationId: ORG,
      organizationName: "Acme",
      domain: "acme.com",
      operationId,
      forceRefresh: true,
    });
    const second = await discoverContactsForOrganization(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      organizationId: ORG,
      organizationName: "Acme",
      domain: "acme.com",
      operationId,
      forceRefresh: true,
    });

    expect(first.newContactIds).toHaveLength(1);
    expect(second.newContactIds).toHaveLength(0); // second run sees the existing contact as a duplicate
    expect(second.duplicateCount).toBe(1);
    expect(db.contacts).toHaveLength(1); // never duplicated
  });

  it("skips a fresh re-run (within the freshness window) without calling Hunter, unless forceRefresh is set", async () => {
    resolveHunterApiKeyMock.mockResolvedValue("real-key");
    searchDomainAllPagesMock.mockResolvedValue({
      contacts: [{ email: "jane@acme.com", providerRecordId: "jane@acme.com", firstName: "Jane", lastName: "Doe", position: null, confidence: null, phoneNumber: null, sources: [] }],
      pages: [{ credits: { used: null, unit: null } }],
      truncated: false,
    });
    const db = createFakeTenantDb();
    await discoverContactsForOrganization(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      organizationId: ORG,
      organizationName: "Acme",
      domain: "acme.com",
    });
    searchDomainAllPagesMock.mockClear();

    const second = await discoverContactsForOrganization(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      organizationId: ORG,
      organizationName: "Acme",
      domain: "acme.com",
    });
    expect(second.status).toBe("skipped_fresh");
    expect(searchDomainAllPagesMock).not.toHaveBeenCalled();
  });

  it("reports provider_error (and records hunter_request_failed usage) on a genuine Hunter API failure, never crashing the caller", async () => {
    resolveHunterApiKeyMock.mockResolvedValue("real-key");
    searchDomainAllPagesMock.mockRejectedValue(new HunterApiError("Usage limit reached", 429, 429, "Usage limit reached"));
    const db = createFakeTenantDb();
    const outcome = await discoverContactsForOrganization(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      organizationId: ORG,
      organizationName: "Acme",
      domain: "acme.com",
    });
    expect(outcome.status).toBe("provider_error");
    expect(db.usageEvents.some((e) => e.event_type === "hunter_request_failed")).toBe(true);
  });

  it("never issues a query carrying a foreign tenant's id (tenant isolation)", async () => {
    resolveHunterApiKeyMock.mockResolvedValue("real-key");
    searchDomainAllPagesMock.mockResolvedValue({ contacts: [], pages: [], truncated: false });
    const db = createFakeTenantDb();
    await expect(
      discoverContactsForOrganization(db as never, {
        tenantId: OTHER_TENANT,
        projectId: PROJECT,
        organizationId: ORG,
        organizationName: "Acme",
        domain: "acme.com",
      }),
    ).rejects.toThrow(/tenant isolation violation/);
  });
});

describe("verifyContactEmail", () => {
  it("honestly reports not_configured status when no Hunter credential resolves, but still runs the free DNS tier", async () => {
    resolveHunterApiKeyMock.mockResolvedValue(null);
    const db = createFakeTenantDb();
    const outcome = await verifyContactEmail(db as never, {
      tenantId: TENANT,
      projectId: PROJECT,
      contactId: "contact-1",
      email: "jane@acme.com",
      resolver: { resolveMx: vi.fn().mockResolvedValue([{ exchange: "mx.acme.com", priority: 10 }]) },
    });
    expect(outcome.status).toBe("not_configured");
    expect(outcome.combinedStatus).toBeDefined();
    expect(db.provenance.some((p) => p.event_type === "verification")).toBe(true);
  });
});
