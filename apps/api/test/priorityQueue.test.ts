import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock the DB pool so this is a true unit test: no real Postgres, and no
// dependency on the scoring agent's lead_scores/lead_score_feedback
// migrations having actually run (same pattern as discovery.test.ts /
// campaigns.test.ts).
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { priorityQueueRouter } = await import("../src/routes/priorityQueue.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/priority-queue", priorityQueueRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "44444444-4444-4444-4444-444444444444";
const LEAD_2 = "55555555-5555-5555-5555-555555555555";
const USER_1 = "user-1";

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

function scoredRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LEAD_1,
    name: "Jane Doe",
    email: "jane@example.com",
    company: "Acme Inc",
    status: "new",
    source: "website_form",
    created_at: "2026-11-20T00:00:00.000Z",
    total_score: 87.5,
    why_summary: "Strong ICP fit",
    next_research_note: "Check funding round",
    computed_at: "2026-11-20T01:00:00.000Z",
    ...overrides,
  };
}

function unscoredRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LEAD_2,
    name: "No Score Yet",
    email: "noscore@example.com",
    company: "Beta LLC",
    status: "new",
    source: "manual",
    created_at: "2026-11-21T00:00:00.000Z",
    total_score: null,
    why_summary: null,
    next_research_note: null,
    computed_at: null,
    ...overrides,
  };
}

describe("GET /priority-queue", () => {
  it("rejects an invalid projectId", async () => {
    const app = buildApp();
    queueResponses([...mockMembership()]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/not-a-uuid/priority-queue`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });

  it("rejects an invalid status query param", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue`)
      .query({ status: "not_a_real_status" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range minScore", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue`)
      .query({ minScore: "150" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });

  it("404s when the project does not belong to the tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // project lookup misses
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("returns scored leads before unscored leads, with correct total and score shape", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 2 }] }, // count query
      { rowCount: 2, rows: [scoredRow(), unscoredRow()] }, // ordered rows (NULLS LAST assumed from SQL)
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(25);
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.leads[0].score).toEqual({
      totalScore: 87.5,
      whySummary: "Strong ICP fit",
      nextResearchNote: "Check funding round",
      computedAt: "2026-11-20T01:00:00.000Z",
    });
    expect(res.body.leads[1].score).toBeNull();

    // Verify the SQL actually encodes NULLS LAST + freshness tiebreaker,
    // and a LEFT JOIN so unscored leads aren't excluded.
    const rowsCall = queryMock.mock.calls[5];
    expect(rowsCall[0]).toMatch(/LEFT JOIN lead_scores/);
    expect(rowsCall[0]).toMatch(/total_score DESC NULLS LAST/);
    expect(rowsCall[0]).toMatch(/leads\.created_at DESC/);
  });

  it("applies the status filter to the WHERE clause", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 1 }] },
      { rowCount: 1, rows: [scoredRow({ status: "qualified" })] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue`)
      .query({ status: "qualified" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const countCall = queryMock.mock.calls[4];
    expect(countCall[0]).toMatch(/leads\.status = \$3/);
    expect(countCall[1]).toEqual([TENANT_A, PROJECT_1, "qualified"]);
  });

  it("computes pagination math (page/pageSize -> LIMIT/OFFSET)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 60 }] },
      { rowCount: 1, rows: [scoredRow()] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue`)
      .query({ page: "3", pageSize: "20" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(3);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.total).toBe(60);

    const rowsCall = queryMock.mock.calls[5];
    // params: tenantId, projectId, limit, offset -> offset = (3-1)*20 = 40
    expect(rowsCall[1]).toEqual([TENANT_A, PROJECT_1, 20, 40]);
  });

  it("clamps a pageSize above the max down to 100", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 0 }] },
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue`)
      .query({ pageSize: "500" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(100);

    const rowsCall = queryMock.mock.calls[5];
    expect(rowsCall[1]).toEqual([TENANT_A, PROJECT_1, 100, 0]);
  });
});

describe("GET /priority-queue/today", () => {
  it("returns an empty array, not placeholder rows, when nothing is scored yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // no scored+actionable leads
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue/today`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.leads).toEqual([]);
  });

  it("defaults the limit to 10 and includes computedAt for staleness", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [scoredRow()] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue/today`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.leads[0].score.computedAt).toBe("2026-11-20T01:00:00.000Z");

    const call = queryMock.mock.calls[4];
    expect(call[1]).toEqual([TENANT_A, PROJECT_1, 10]);
    expect(call[0]).toMatch(/status NOT IN \('approved_for_outreach', 'archived', 'rejected'\)/);
  });

  it("clamps an over-max limit down to 50", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue/today`)
      .query({ limit: "500" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const call = queryMock.mock.calls[4];
    expect(call[1]).toEqual([TENANT_A, PROJECT_1, 50]);
  });

  it("rejects a limit below 1", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/priority-queue/today`)
      .query({ limit: "0" })
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });
});
