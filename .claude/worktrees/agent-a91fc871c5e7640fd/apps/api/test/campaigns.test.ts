import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the DB pool so this is a true unit test: no real Postgres needed.
// requireTenantMembership and the route handlers both get a fake pg
// client whose query() we control per test (same pattern as
// projects.test.ts / tenantMiddleware.test.ts / publicLeads.test.ts).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { campaignsRouter } = await import("../src/routes/campaigns.js");
const { approvalsRouter } = await import("../src/routes/approvals.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/campaigns", campaignsRouter);
  app.use("/api/v1/tenants/:tenantId/approvals", approvalsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN_1 = "44444444-4444-4444-4444-444444444444";
const APPROVAL_1 = "55555555-5555-5555-5555-555555555555";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("tenant isolation on campaigns routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // membership lookup: none
      undefined, // ROLLBACK
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/campaigns`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("FROM campaigns"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });

  it("scopes the campaigns list query to the authenticated tenant_id, never a different tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // campaigns list
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaigns`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.campaigns).toEqual([]);

    const listCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("FROM campaigns"));
    expect(listCall).toBeDefined();
    expect(listCall![1]).toEqual([TENANT_A, PROJECT_1]);
  });
});

describe("campaign status transitions", () => {
  it("creates a campaign in 'draft' status by default", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Launch week", status: "draft" }],
      }, // INSERT ... RETURNING
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaigns`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Launch week" });

    expect(res.status).toBe(201);
    expect(res.body.campaign.status).toBe("draft");
  });

  it("moves a draft campaign to pending_approval and creates an approvals row referencing it", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Launch week", status: "draft" }] }, // loadCampaignOr404
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, status: "pending_approval" }] }, // UPDATE campaigns ... status = pending_approval
      { rowCount: 1, rows: [{ id: APPROVAL_1, campaign_id: CAMPAIGN_1, status: "pending", requested_by: USER_1, requested_at: "2026-01-01" }] }, // INSERT approvals
      undefined, // audit insert
      { rowCount: 0, rows: [] }, // notifyTenantOwnersAndAdmins: memberships lookup
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaigns/${CAMPAIGN_1}/submit-for-approval`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(201);
    expect(res.body.campaign.status).toBe("pending_approval");
    expect(res.body.approval.campaign_id).toBe(CAMPAIGN_1);
    expect(res.body.approval.status).toBe("pending");

    const insertApprovalCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO approvals"),
    );
    expect(insertApprovalCall).toBeDefined();
    expect(insertApprovalCall![1]).toEqual([TENANT_A, CAMPAIGN_1, USER_1, expect.stringContaining("Launch week")]);
  });

  it("rejects submit-for-approval when the campaign is not currently draft", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Launch week", status: "pending_approval" }] }, // loadCampaignOr404
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaigns/${CAMPAIGN_1}/submit-for-approval`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(409);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO approvals"), expect.anything());
  });

  it("approving a campaign-type approval flips the campaign to 'approved'", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [{ id: APPROVAL_1, agent_execution_id: null, campaign_id: CAMPAIGN_1, status: "approved", reviewed_by: USER_1, decision_notes: null, reviewed_at: "2026-01-02" }],
      }, // UPDATE approvals ... RETURNING
      { rowCount: 1, rows: [] }, // UPDATE campaigns SET status = 'approved'
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/approvals/${APPROVAL_1}/decision`)
      .set("X-Dev-User-Id", USER_1)
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.approval.status).toBe("approved");

    const updateCampaignCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE campaigns"),
    );
    expect(updateCampaignCall).toBeDefined();
    expect(updateCampaignCall![1]).toEqual([CAMPAIGN_1, TENANT_A, "approved"]);
  });
});

describe("draft-only editing", () => {
  it("rejects editing a non-draft campaign (409) and never issues the UPDATE", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Launch week", status: "approved" }] }, // loadCampaignOr404
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Renamed" });

    expect(res.status).toBe(409);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE campaigns"), expect.anything());
  });

  it("allows editing a draft campaign", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Launch week", status: "draft" }] }, // loadCampaignOr404
      {
        rowCount: 1,
        rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Renamed", status: "draft" }],
      }, // UPDATE ... RETURNING
      undefined, // audit insert
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.campaign.name).toBe("Renamed");
  });
});
