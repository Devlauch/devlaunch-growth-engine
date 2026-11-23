import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureProjectList, syncProjectSubscribers, createDraftCampaign, triggerCampaignSend, CampaignNotApprovedError } from "../src/lib/listmonkSync.js";
import type { ListmonkClient } from "../src/lib/listmonkClient.js";

function fakeClient(overrides: Partial<ListmonkClient> = {}): ListmonkClient {
  return {
    health: vi.fn().mockResolvedValue({ ok: true }),
    getOrCreateList: vi.fn().mockResolvedValue({ id: 1, uuid: "list-uuid", name: "My Project" }),
    upsertSubscriber: vi.fn().mockResolvedValue({ id: 100, uuid: "sub-uuid", email: "a@b.com", name: "A", status: "enabled" }),
    createCampaign: vi.fn().mockResolvedValue({ id: 50, uuid: "camp-uuid", name: "C", status: "draft" }),
    updateCampaignStatus: vi.fn().mockResolvedValue({ id: 50, uuid: "camp-uuid", name: "C", status: "running" }),
    getCampaign: vi.fn().mockResolvedValue({ id: 50, uuid: "camp-uuid", name: "C", status: "running" }),
    ...overrides,
  };
}

function fakeTenantDb() {
  const query = vi.fn();
  return { query };
}

const TENANT = "tenant-1";
const PROJECT = "project-1";
const INTEGRATION = "integration-1";

describe("ensureProjectList", () => {
  it("creates a remote list + mapping row on first use", async () => {
    const tenantDb = fakeTenantDb();
    tenantDb.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no existing mapping
      .mockResolvedValueOnce({ rows: [{ name: "Acme" }] }) // project name
      .mockResolvedValueOnce({ rows: [{ listmonk_list_id: 1 }] }); // insert
    const client = fakeClient();

    const result = await ensureProjectList(tenantDb as any, TENANT, PROJECT, INTEGRATION, client);

    expect(result.listmonkListId).toBe(1);
    expect(client.getOrCreateList).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing mapping without creating a second remote list", async () => {
    const tenantDb = fakeTenantDb();
    tenantDb.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ listmonk_list_id: 42 }] });
    const client = fakeClient();

    const result = await ensureProjectList(tenantDb as any, TENANT, PROJECT, INTEGRATION, client);

    expect(result.listmonkListId).toBe(42);
    expect(client.getOrCreateList).not.toHaveBeenCalled();
  });
});

describe("syncProjectSubscribers", () => {
  it("syncs an eligible lead and skips a suppressed one, never calling listmonk for the suppressed lead", async () => {
    const tenantDb = fakeTenantDb();
    tenantDb.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ listmonk_list_id: 1 }] }) // ensureProjectList: existing mapping
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { id: "lead-ok", name: "OK Lead", email: "ok@example.com" },
          { id: "lead-suppressed", name: "Suppressed Lead", email: "bad@example.com" },
        ],
      }) // leads query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // isSuppressed for ok@example.com: no match
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ listmonk_subscriber_id: 100 }] }) // upsert mapping row for ok lead
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ reason: "bounced" }] }) // isSuppressed for bad@example.com: suppressed
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // skipped_suppressed mapping row

    const client = fakeClient();

    const result = await syncProjectSubscribers(tenantDb as any, TENANT, PROJECT, INTEGRATION, client);

    expect(result.total).toBe(2);
    expect(result.synced).toBe(1);
    expect(result.skippedSuppressed).toBe(1);
    expect(client.upsertSubscriber).toHaveBeenCalledTimes(1);
    expect(client.upsertSubscriber).toHaveBeenCalledWith(expect.objectContaining({ email: "ok@example.com" }));
  });

  it("records a failed sync without throwing, so one bad lead doesn't abort the whole batch", async () => {
    const tenantDb = fakeTenantDb();
    tenantDb.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ listmonk_list_id: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "lead-1", name: "L", email: "l@example.com" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // not suppressed
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // failed mapping row insert

    const client = fakeClient({ upsertSubscriber: vi.fn().mockRejectedValue(new Error("listmonk unreachable")) });

    const result = await syncProjectSubscribers(tenantDb as any, TENANT, PROJECT, INTEGRATION, client);

    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe("listmonk unreachable");
  });
});

describe("createDraftCampaign", () => {
  it("creates a remote draft campaign + mapping row + a pending approval in one call", async () => {
    const tenantDb = fakeTenantDb();
    tenantDb.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ listmonk_list_id: 1 }] }) // ensureProjectList
      .mockResolvedValueOnce({ rows: [] }) // insert listmonk_campaigns mapping
      .mockResolvedValueOnce({ rows: [{ id: "approval-1" }] }); // insert approvals

    const client = fakeClient();

    const result = await createDraftCampaign(tenantDb as any, TENANT, PROJECT, INTEGRATION, client, {
      campaignId: "campaign-1",
      name: "Launch",
      subject: "Hello",
      body: "<p>Hi</p>",
      requestedBy: "user-1",
    });

    expect(result.listmonkCampaignId).toBe(50);
    expect(result.approvalId).toBe("approval-1");
    expect(client.createCampaign).toHaveBeenCalledTimes(1);
    expect(client.updateCampaignStatus).not.toHaveBeenCalled();
  });
});

describe("triggerCampaignSend", () => {
  it("refuses to send when campaigns.status is not 'approved'", async () => {
    const tenantDb = fakeTenantDb();
    tenantDb.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "pending_approval" }] });
    const client = fakeClient();

    await expect(triggerCampaignSend(tenantDb as any, TENANT, "campaign-1", client)).rejects.toThrow(CampaignNotApprovedError);
    expect(client.updateCampaignStatus).not.toHaveBeenCalled();
  });

  it("triggers a real send only once campaigns.status = 'approved'", async () => {
    const tenantDb = fakeTenantDb();
    tenantDb.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "approved" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ listmonk_campaign_id: 50 }] })
      .mockResolvedValueOnce({ rows: [] }); // update mapping row
    const client = fakeClient();

    const result = await triggerCampaignSend(tenantDb as any, TENANT, "campaign-1", client);

    expect(result.listmonkStatus).toBe("running");
    expect(client.updateCampaignStatus).toHaveBeenCalledWith(50, "running");
  });
});
