import { describe, it, expect, vi, beforeEach } from "vitest";

const { ingestLead } = await import("../src/lib/leadIngestion.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const OWNER_1 = "owner-1";

function fakeClient() {
  return { query: vi.fn() } as unknown as { query: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ingestLead — real notification on lead capture", () => {
  it("writes a lead row, an audit_events row, AND a real in-app notification to the tenant's owners/admins", async () => {
    const client = fakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: "lead-1", created_at: "2026-01-01T00:00:00.000Z" }] }) // INSERT leads
      .mockResolvedValueOnce(undefined) // INSERT audit_events
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: OWNER_1 }] }) // notifyTenantOwnersAndAdmins: memberships lookup
      .mockResolvedValueOnce(undefined); // INSERT notifications

    const result = await ingestLead({
      client: client as never,
      tenantId: TENANT_A,
      projectId: PROJECT_1,
      input: { name: "Jane Doe", email: "jane@example.com" },
      source: "public_widget",
    });

    expect(result.id).toBe("lead-1");

    const notificationInsertCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO notifications"),
    );
    expect(notificationInsertCall).toBeDefined();
    const [, params] = notificationInsertCall!;
    expect(params[0]).toBe(TENANT_A);
    expect(params[1]).toBe(OWNER_1);
    expect(params[2]).toBe("lead.captured");
    expect(params[3]).toBe("New lead captured");
    expect(params[4]).toContain("Jane Doe");

    // Never fabricated: the recipient came from the real memberships
    // lookup, never a hardcoded id.
    const membershipsLookupCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM memberships"),
    );
    expect(membershipsLookupCall![1]).toEqual([TENANT_A, null]);
  });

  it("notifies no one (writes zero notification rows) when the tenant has no active owner/admin yet", async () => {
    const client = fakeClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: "lead-2", created_at: "2026-01-01T00:00:00.000Z" }] }) // INSERT leads
      .mockResolvedValueOnce(undefined) // INSERT audit_events
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // notifyTenantOwnersAndAdmins: memberships lookup, none found

    await ingestLead({
      client: client as never,
      tenantId: TENANT_A,
      projectId: PROJECT_1,
      input: { email: "lead@example.com" },
      source: "public_widget",
    });

    const notificationInsertCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO notifications"),
    );
    expect(notificationInsertCall).toBeUndefined();
  });
});
