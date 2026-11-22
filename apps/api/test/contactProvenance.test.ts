import { describe, it, expect, vi } from "vitest";
import { recordDiscoveryEvent, recordVerificationEvent, listProvenanceForContact, getFreshVerificationEvent } from "../src/lib/contactProvenance.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const CONTACT = "33333333-3333-3333-3333-333333333333";
const ORG = "44444444-4444-4444-4444-444444444444";

describe("contactProvenance: append-only", () => {
  it("inserts a discovery event with discovered_at set and verified_at left null", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ id: "evt-1", event_type: "discovery" }] });
    await recordDiscoveryEvent(
      { query: queryMock } as never,
      {
        tenantId: TENANT,
        projectId: PROJECT,
        contactId: CONTACT,
        organizationId: ORG,
        operationId: "op-1",
        source: "hunter:domain-search:emails[]",
        providerRecordId: "jane@acme.com",
        confidence: 92,
        payload: { value: "jane@acme.com" },
      },
    );
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/event_type.*'discovery'/s);
    expect(sql).toMatch(/discovered_at/);
    expect(sql).not.toMatch(/UPDATE/i);
  });

  it("inserts a verification event with verified_at and verification_result set", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ id: "evt-2", event_type: "verification" }] });
    await recordVerificationEvent(
      { query: queryMock } as never,
      {
        tenantId: TENANT,
        projectId: PROJECT,
        contactId: CONTACT,
        organizationId: ORG,
        operationId: "op-2",
        source: "hunter:email-verifier",
        verificationResult: "valid",
        evidence: { status: "valid" },
      },
    );
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/verified_at/);
    expect(params).toContain("valid");
  });

  it("a retried operation (same operationId/contact/event_type/source) hits ON CONFLICT DO NOTHING rather than erroring or duplicating", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] }); // simulates the conflict path: RETURNING yields no row
    const result = await recordDiscoveryEvent(
      { query: queryMock } as never,
      {
        tenantId: TENANT,
        projectId: PROJECT,
        contactId: CONTACT,
        organizationId: ORG,
        operationId: "retry-op",
        source: "hunter:domain-search:emails[]",
        providerRecordId: null,
        confidence: null,
        payload: {},
      },
    );
    expect(result).toBeNull(); // absorbed silently — no throw, no duplicate row claimed.
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT/);
    expect(sql).toMatch(/DO NOTHING/);
  });

  it("returns full provenance history in chronological order, scoped to tenant_id", async () => {
    const rows = [
      { id: "evt-1", event_type: "discovery", created_at: "2026-01-01T00:00:00Z" },
      { id: "evt-2", event_type: "verification", created_at: "2026-01-02T00:00:00Z" },
    ];
    const queryMock = vi.fn().mockResolvedValue({ rows });
    const result = await listProvenanceForContact({ query: queryMock } as never, TENANT, CONTACT);
    expect(result).toEqual(rows);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toMatch(/ORDER BY created_at ASC/);
    expect(params).toEqual([TENANT, CONTACT]);
  });

  it("getFreshVerificationEvent only looks within the freshness window", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    await getFreshVerificationEvent({ query: queryMock } as never, CONTACT, 60_000);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/event_type = 'verification'/);
    expect(sql).toMatch(/milliseconds/);
    expect(params).toEqual([CONTACT, 60_000]);
  });
});
