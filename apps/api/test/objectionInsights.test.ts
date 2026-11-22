import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { objectionInsightsRouter } = await import("../src/routes/meetingPrep.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/objection-insights", objectionInsightsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "user-1";

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

function url(qs = "") {
  return `/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/objection-insights${qs}`;
}

describe("GET /objection-insights", () => {
  it("404s when the project does not belong to this tenant", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]); // project not found

    const res = await request(app).get(url()).set("X-Dev-User-Id", USER_1);
    expect(res.status).toBe(404);
  });

  it("reports insufficient_data when there are fewer than 5 objection-flavored replies", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 10 }] }, // total replies
      { rowCount: 2, rows: [
          { id: "r1", lead_id: "lead-1", received_at: "2026-01-01T00:00:00Z" },
          { id: "r2", lead_id: "lead-2", received_at: "2026-01-08T00:00:00Z" },
        ] }, // objection-flavored replies (only 2, below MIN_SAMPLE_SIZE)
      { rowCount: 2, rows: [
          { week_start: "2026-01-01", count: 1 },
          { week_start: "2026-01-08", count: 1 },
        ] }, // weekly buckets
    ]);

    const res = await request(app).get(url()).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.insights.totalObjectionFlavoredReplies).toBe(2);
    expect(res.body.insights.sufficientSampleSize).toBe(false);
    expect(res.body.insights.trend).toBe("insufficient_data");
    expect(res.body.insights.proxyClassification).toBe("not_now");
    expect(res.body.insights.proxyCaveat).toMatch(/no dedicated 'objection' value/);
  });

  it("reports a real increasing trend with sufficient sample size", async () => {
    const app = buildApp();
    const replies = [
      { id: "r1", lead_id: "lead-1", received_at: "2026-01-01T00:00:00Z" },
      { id: "r2", lead_id: "lead-2", received_at: "2026-01-02T00:00:00Z" },
      { id: "r3", lead_id: "lead-3", received_at: "2026-01-15T00:00:00Z" },
      { id: "r4", lead_id: "lead-4", received_at: "2026-01-16T00:00:00Z" },
      { id: "r5", lead_id: "lead-5", received_at: "2026-01-17T00:00:00Z" },
      { id: "r6", lead_id: "lead-6", received_at: "2026-01-18T00:00:00Z" },
    ];
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 20 }] }, // total replies
      { rowCount: replies.length, rows: replies }, // objection-flavored replies
      {
        rowCount: 2,
        rows: [
          { week_start: "2025-12-29", count: 2 },
          { week_start: "2026-01-12", count: 4 },
        ],
      }, // weekly buckets: clear increase
    ]);

    const res = await request(app).get(url()).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.insights.totalObjectionFlavoredReplies).toBe(6);
    expect(res.body.insights.distinctLeadsWithObjection).toBe(6);
    expect(res.body.insights.sufficientSampleSize).toBe(true);
    expect(res.body.insights.trend).toBe("increasing");
  });

  it("accepts a custom lookbackDays query param", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 0 }] }, // total replies
      { rowCount: 0, rows: [] }, // objection-flavored replies
      { rowCount: 0, rows: [] }, // weekly buckets
    ]);

    const res = await request(app).get(url("?lookbackDays=30")).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.insights.totalObjectionFlavoredReplies).toBe(0);
    expect(res.body.insights.trend).toBe("insufficient_data");
    // lookbackDays is passed through as a query-bound interval literal, not
    // echoed back directly — assert the query used it.
    expect(
      queryMock.mock.calls.some(
        ([sql, params]) => typeof sql === "string" && sql.includes("lead_replies") && Array.isArray(params) && params.includes(30),
      ),
    ).toBe(true);
  });
});
