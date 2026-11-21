import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same unit-test pattern as campaigns.test.ts: mock the DB pool so this
// never needs real Postgres, and assert that every aggregate query is
// scoped to the authenticated tenant_id/project_id.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { analyticsRouter } = await import("../src/routes/analytics.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/analytics", analyticsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
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

describe("tenant isolation on analytics routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // membership lookup: none
      undefined, // ROLLBACK
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/analytics/overview`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("FROM leads"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });

  it("404s when the project does not belong to the tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // project lookup: none
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/analytics/overview`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("analytics overview — real aggregates only", () => {
  it("returns real counts straight from the aggregate queries, never fabricated numbers", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 7 }] }, // leads total
      { rowCount: 2, rows: [{ status: "new", count: 5 }, { status: "qualified", count: 2 }] }, // leads by status
      { rowCount: 1, rows: [{ status: "draft", count: 3 }] }, // campaigns by status
      { rowCount: 0, rows: [] }, // executions by status (none yet)
      { rowCount: 1, rows: [{ day: "2026-11-20", count: 7 }] }, // leads per day
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/analytics/overview`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.leads.total).toBe(7);
    expect(res.body.leads.byStatus).toEqual([
      { status: "new", count: 5 },
      { status: "qualified", count: 2 },
    ]);
    expect(res.body.campaigns.byStatus).toEqual([{ status: "draft", count: 3 }]);
    expect(res.body.agentExecutions.byStatus).toEqual([]);
    expect(res.body.leads.perDay).toEqual([{ day: "2026-11-20", count: 7 }]);

    const leadsTotalCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("count(*)::int AS count FROM leads"),
    );
    expect(leadsTotalCall).toBeDefined();
    expect(leadsTotalCall![1]).toEqual([TENANT_A, PROJECT_1]);
  });

  it("returns zero/empty aggregates (not fabricated placeholders) for a project with no data", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 0 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/analytics/overview`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.leads.total).toBe(0);
    expect(res.body.leads.byStatus).toEqual([]);
    expect(res.body.campaigns.byStatus).toEqual([]);
    expect(res.body.agentExecutions.byStatus).toEqual([]);
    expect(res.body.leads.perDay).toEqual([]);
  });
});
