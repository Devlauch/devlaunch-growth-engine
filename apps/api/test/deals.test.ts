import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as sequences.test.ts / messaging.test.ts: fake the
// pg pool so these are true unit tests, no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { dealsRouter } = await import("../src/routes/deals.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/deals", dealsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const DEAL_1 = "66666666-6666-6666-6666-666666666666";
const USER_1 = "user-1";
const OWNER_1 = "77777777-7777-7777-7777-777777777777";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "sales") {
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

describe("POST /deals", () => {
  it("creates a deal for a real lead in this project, defaulting stage to 'new'", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists in project
      {
        rowCount: 1,
        rows: [
          {
            id: DEAL_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            stage: "new",
            value_amount: null,
          },
        ],
      }, // INSERT deals
      { rowCount: 1, rows: [] }, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1 });

    expect(res.status).toBe(201);
    expect(res.body.deal.stage).toBe("new");
    expect(res.body.deal.lead_id).toBe(LEAD_1);
  });

  it("404s when the lead does not belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead NOT found in project
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1 });

    expect(res.status).toBe(404);
  });

  it("validates ownerUserId against active tenant membership before creating the deal", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists
      { rowCount: 0, rows: [] }, // assertActiveTenantMember: not an active member
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, ownerUserId: OWNER_1 });

    expect(res.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO deals"))).toBe(
      false,
    );
  });
});

describe("PATCH /deals/:id", () => {
  it("bumps stage_changed_at (via the CASE expression param) only when stage actually changes", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "new" }] }, // loadDealOr404
      {
        rowCount: 1,
        rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "contacted" }],
      }, // UPDATE deals
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/${DEAL_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ stage: "contacted" });

    expect(res.status).toBe(200);
    expect(res.body.deal.stage).toBe("contacted");

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE deals"),
    );
    expect(updateCall).toBeDefined();
    // params: [dealId, tenantId, stage, hasValueAmount, valueAmount, hasExpectedCloseDate,
    //          expectedCloseDate, hasOwnerUserId, ownerUserId, stageChanged]
    expect(updateCall![1][9]).toBe(true); // stageChanged = true ('new' -> 'contacted')
  });

  it("rejects an empty patch body", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "new" }] }, // loadDealOr404
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/${DEAL_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });

  // Ported from milestone3-phase2 (packages/db/migrations/
  // 442_add_outcome_reasons_to_deals.sql): lostReason/wonReason capture on
  // terminal-stage transitions.
  it("rejects moving a deal to 'lost' without a lostReason", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "proposal" }] }, // loadDealOr404
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/${DEAL_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ stage: "lost" });

    expect(res.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("UPDATE deals"))).toBe(
      false,
    );
  });

  it("accepts moving a deal to 'lost' with a lostReason and persists it", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "proposal" }] }, // loadDealOr404
      {
        rowCount: 1,
        rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "lost", lost_reason: "Budget cut" }],
      }, // UPDATE deals
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/${DEAL_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ stage: "lost", lostReason: "Budget cut" });

    expect(res.status).toBe(200);
    expect(res.body.deal.lost_reason).toBe("Budget cut");

    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE deals"));
    expect(updateCall).toBeDefined();
    // params: [..., stageChanged(9), lostReason(10), wonReason(11)]
    expect(updateCall![1][10]).toBe("Budget cut");
    expect(updateCall![1][11]).toBeNull();
  });

  it("accepts moving a deal to 'won' with no wonReason (optional)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "proposal" }] }, // loadDealOr404
      {
        rowCount: 1,
        rows: [{ id: DEAL_1, tenant_id: TENANT_A, project_id: PROJECT_1, stage: "won" }],
      }, // UPDATE deals
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/${DEAL_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ stage: "won" });

    expect(res.status).toBe(200);
    expect(res.body.deal.stage).toBe("won");
  });
});

describe("GET /deals/customers", () => {
  it("reads the customers view, scoped to this tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ lead_id: LEAD_1, tenant_id: TENANT_A, project_id: PROJECT_1, won_deal_id: DEAL_1, won_deal_value: "500.00" }],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/customers`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    const customerCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM customers"),
    );
    expect(customerCall![1]).toEqual([TENANT_A, PROJECT_1]);
  });
});

describe("POST /deals/assignments", () => {
  it("assigns a lead to an active tenant member", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists
      { rowCount: 1, rows: [{}] }, // assertActiveTenantMember: active
      {
        rowCount: 1,
        rows: [{ id: "assign-1", tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1, assigned_user_id: OWNER_1 }],
      }, // INSERT lead_assignments
      { rowCount: 1, rows: [] }, // audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/assignments`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, assignedUserId: OWNER_1 });

    expect(res.status).toBe(201);
    expect(res.body.assignment.assigned_user_id).toBe(OWNER_1);
  });

  it("rejects assigning to a user who is not an active member of this tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{}] }, // lead exists
      { rowCount: 0, rows: [] }, // assertActiveTenantMember: not found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/assignments`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, assignedUserId: OWNER_1 });

    expect(res.status).toBe(400);
  });
});

describe("POST /deals/check-stalled", () => {
  it("creates a crm_tasks + follow_up_tasks pair for each stalled deal found", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: DEAL_1,
            lead_id: LEAD_1,
            stage: "proposal",
            owner_user_id: OWNER_1,
            stage_changed_at: "2026-01-01T00:00:00Z",
          },
        ],
      }, // SELECT stalled deals
      { rowCount: 1, rows: [{ id: "crm-task-1" }] }, // INSERT crm_tasks
      { rowCount: 1, rows: [{ id: "follow-up-1" }] }, // INSERT follow_up_tasks
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/check-stalled`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.followUpsCreated).toHaveLength(1);
    expect(res.body.followUpsCreated[0]).toEqual({
      dealId: DEAL_1,
      leadId: LEAD_1,
      crmTaskId: "crm-task-1",
      followUpTaskId: "follow-up-1",
    });

    const insertCrmTaskCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO crm_tasks"),
    );
    expect(insertCrmTaskCall).toBeDefined();
    const insertFollowUpCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO follow_up_tasks"),
    );
    expect(insertFollowUpCall).toBeDefined();
  });

  it("no-ops when nothing is stalled", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // SELECT stalled deals: none
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/check-stalled`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.followUpsCreated).toEqual([]);
  });
});
