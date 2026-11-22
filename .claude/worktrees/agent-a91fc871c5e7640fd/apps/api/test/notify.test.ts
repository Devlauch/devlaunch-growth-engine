import { describe, it, expect, vi, beforeEach } from "vitest";

const { notify, notifyTenantOwnersAndAdmins } = await import("../src/lib/notify.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const OWNER_1 = "owner-1";
const ADMIN_1 = "admin-1";
const ACTOR_1 = "actor-1";

function fakeClient() {
  return { query: vi.fn() } as unknown as { query: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notify", () => {
  it("writes exactly one notification row for the given recipient", async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce(undefined);

    await notify({
      client: client as never,
      tenantId: TENANT_A,
      userId: OWNER_1,
      type: "lead.captured",
      title: "New lead captured",
      body: "Jane Doe was captured via your website widget.",
      linkUrl: "/tenants/t1/projects/p1#leads-section",
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO notifications");
    expect(params).toEqual([
      TENANT_A,
      OWNER_1,
      "lead.captured",
      "New lead captured",
      "Jane Doe was captured via your website widget.",
      "/tenants/t1/projects/p1#leads-section",
    ]);
  });
});

describe("notifyTenantOwnersAndAdmins", () => {
  it("notifies every active owner/admin found via a real memberships lookup", async () => {
    const client = fakeClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ user_id: OWNER_1 }, { user_id: ADMIN_1 }] }) // memberships lookup
      .mockResolvedValueOnce(undefined) // notify owner
      .mockResolvedValueOnce(undefined); // notify admin

    await notifyTenantOwnersAndAdmins({
      client: client as never,
      tenantId: TENANT_A,
      type: "lead.captured",
      title: "New lead captured",
      body: "A new lead came in.",
    });

    const membershipsCall = client.query.mock.calls[0];
    expect(membershipsCall[0]).toContain("role IN ('owner', 'admin')");
    expect(membershipsCall[1]).toEqual([TENANT_A, null]);

    const insertCalls = client.query.mock.calls.slice(1);
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1]).toEqual(
      expect.arrayContaining([TENANT_A, OWNER_1, "lead.captured"]),
    );
    expect(insertCalls[1][1]).toEqual(
      expect.arrayContaining([TENANT_A, ADMIN_1, "lead.captured"]),
    );
  });

  it("excludes the acting user when excludeUserId is passed, never notifying someone of their own action", async () => {
    const client = fakeClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: OWNER_1 }] }) // memberships lookup (ACTOR_1 excluded in SQL)
      .mockResolvedValueOnce(undefined); // notify owner

    await notifyTenantOwnersAndAdmins({
      client: client as never,
      tenantId: TENANT_A,
      excludeUserId: ACTOR_1,
      type: "campaign.submitted_for_approval",
      title: "Campaign awaiting your approval",
      body: 'Campaign "Launch" was submitted for approval.',
    });

    const membershipsCall = client.query.mock.calls[0];
    expect(membershipsCall[1]).toEqual([TENANT_A, ACTOR_1]);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
