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

/** Like queueResponses, but an Error entry is queued as a rejection instead of a resolution. */
function queueMixedResponses(responses: unknown[]) {
  for (const r of responses) {
    if (r instanceof Error) {
      queryMock.mockRejectedValueOnce(r);
    } else {
      queryMock.mockResolvedValueOnce(r);
    }
  }
}

/** A pg-style "relation does not exist" error, exactly what Postgres raises for a missing table. */
function undefinedTableError(tableName: string): Error {
  const err = new Error(`relation "${tableName}" does not exist`) as Error & { code?: string };
  err.code = "42P01";
  return err;
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

describe("analytics funnel — real counts, honest degradation when sibling tables are missing", () => {
  it("returns real counts straight from the aggregate queries when every funnel table exists", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      undefined, // SAVEPOINT (discovered_organizations)
      { rowCount: 1, rows: [{ count: 5 }] }, // discovered_organizations count
      undefined, // RELEASE SAVEPOINT
      { rowCount: 1, rows: [{ count: 20 }] }, // leads total
      undefined, // SAVEPOINT (qualified combined)
      { rowCount: 1, rows: [{ count: 8 }] }, // qualified combined (status OR score)
      undefined, // RELEASE SAVEPOINT
      undefined, // SAVEPOINT (contacted)
      { rowCount: 1, rows: [{ count: 6 }] }, // contacted
      undefined, // RELEASE SAVEPOINT
      undefined, // SAVEPOINT (replied)
      { rowCount: 1, rows: [{ count: 4 }] }, // replied
      undefined, // RELEASE SAVEPOINT
      undefined, // SAVEPOINT (demo)
      { rowCount: 1, rows: [{ count: 2 }] }, // demo (stopped_meeting_booked proxy)
      undefined, // RELEASE SAVEPOINT
      { rowCount: 2, rows: [{ source: "agent", count: 8 }, { source: "internal", count: 12 }] }, // bySource
      undefined, // SAVEPOINT (byChannel)
      { rowCount: 2, rows: [{ channel: "email", count: 5 }, { channel: "whatsapp", count: 3 }] }, // byChannel
      undefined, // RELEASE SAVEPOINT
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/analytics/funnel`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.funnel.discovered.discoveredOrganizations.count).toBe(5);
    expect(res.body.funnel.discovered.discoveredOrganizations.note).toBeUndefined();
    expect(res.body.funnel.discovered.leads.count).toBe(20);
    expect(res.body.funnel.qualified.count).toBe(8);
    expect(res.body.funnel.qualified.note).toBeUndefined();
    expect(res.body.funnel.contacted.count).toBe(6);
    expect(res.body.funnel.replied.count).toBe(4);
    expect(res.body.funnel.demo.count).toBe(2);
    expect(res.body.funnel.demo.note).toMatch(/stopped_meeting_booked/);
    expect(res.body.funnel.demo.degradedNote).toBeUndefined();
    // won is never fabricated — no schema status represents it.
    expect(res.body.funnel.won).toEqual({
      count: 0,
      note: expect.stringContaining("no 'won' lead status exists"),
    });
    expect(res.body.breakdowns.bySource).toEqual([
      { source: "agent", count: 8 },
      { source: "internal", count: 12 },
    ]);
    expect(res.body.breakdowns.bySegment).toEqual({
      breakdown: [],
      note: expect.stringContaining("icp_profiles"),
    });
    expect(res.body.breakdowns.byChannel.breakdown).toEqual([
      { channel: "email", count: 5 },
      { channel: "whatsapp", count: 3 },
    ]);
    expect(res.body.breakdowns.byChannel.note).toBeUndefined();
    expect(res.body.breakdowns.byMessageVariant.breakdown).toEqual(res.body.breakdowns.byChannel.breakdown);

    // Every real query must stay scoped to the authenticated tenant/project.
    const discoveredCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM discovered_organizations"),
    );
    expect(discoveredCall![1]).toEqual([TENANT_A, PROJECT_1]);
  });

  it("degrades honestly (never 500s, never fabricates) when none of the newer funnel tables exist yet", async () => {
    const app = buildApp();
    queueMixedResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      undefined, // SAVEPOINT (discovered_organizations)
      undefinedTableError("discovered_organizations"),
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      { rowCount: 1, rows: [{ count: 9 }] }, // leads total (leads always exists)
      undefined, // SAVEPOINT (qualified combined)
      undefinedTableError("lead_scores"),
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      { rowCount: 1, rows: [{ count: 3 }] }, // fallback: status-only qualified count
      undefined, // SAVEPOINT (contacted)
      undefinedTableError("message_drafts"),
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      undefined, // SAVEPOINT (replied)
      undefinedTableError("lead_replies"),
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      undefined, // SAVEPOINT (demo)
      undefinedTableError("sequence_enrollments"),
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      { rowCount: 1, rows: [{ source: "internal", count: 9 }] }, // bySource (leads always exists)
      undefined, // SAVEPOINT (byChannel)
      undefinedTableError("message_draft_variants"),
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/analytics/funnel`)
      .set("X-Dev-User-Id", USER_1);

    // The missing sibling tables must never turn into a 500.
    expect(res.status).toBe(200);
    expect(res.body.funnel.discovered.discoveredOrganizations).toEqual({
      count: 0,
      note: expect.stringContaining("discovered_organizations table does not exist"),
    });
    expect(res.body.funnel.discovered.leads.count).toBe(9);
    // qualified degrades to the status-only half of the union, honestly noted.
    expect(res.body.funnel.qualified.count).toBe(3);
    expect(res.body.funnel.qualified.note).toContain("lead_scores table does not exist");
    expect(res.body.funnel.contacted).toEqual({
      count: 0,
      note: expect.stringContaining("message_drafts table does not exist"),
    });
    expect(res.body.funnel.replied).toEqual({
      count: 0,
      note: expect.stringContaining("lead_replies table does not exist"),
    });
    expect(res.body.funnel.demo.count).toBe(0);
    expect(res.body.funnel.demo.degradedNote).toContain("sequence_enrollments table does not exist");
    expect(res.body.funnel.won).toEqual({
      count: 0,
      note: expect.stringContaining("no 'won' lead status exists"),
    });
    expect(res.body.breakdowns.bySource).toEqual([{ source: "internal", count: 9 }]);
    expect(res.body.breakdowns.byChannel).toEqual({
      breakdown: [],
      note: expect.stringContaining("message_draft_variants table does not exist"),
    });
    expect(releaseMock).toHaveBeenCalled();
  });
});
