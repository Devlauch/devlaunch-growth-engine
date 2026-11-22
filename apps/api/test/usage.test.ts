import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same unit-test pattern as analytics.test.ts: mock the DB pool so this
// never needs real Postgres, and assert every aggregate query stays
// scoped to the authenticated tenant_id.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { usageRouter } = await import("../src/routes/usage.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/usage", usageRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
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

describe("tenant isolation on usage routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // membership lookup: none
      undefined, // ROLLBACK
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/usage/overview`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("FROM usage_events"), expect.anything());
    expect(releaseMock).toHaveBeenCalled();
  });

  it("never lets a request for tenant A read tenant B's usage_events rows", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ event_type: "lead_captured", count: 3, quantity: "3" }] }, // byType
      { rowCount: 1, rows: [{ day: "2026-11-20", event_type: "lead_captured", quantity: "3" }] }, // perDay
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/usage/overview`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);

    const byTypeCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM usage_events") && sql.includes("GROUP BY event_type"),
    );
    expect(byTypeCall).toBeDefined();
    expect(byTypeCall![1]).toEqual([TENANT_A]);

    const perDayCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM usage_events") && sql.includes("GROUP BY day, event_type"),
    );
    expect(perDayCall).toBeDefined();
    expect(perDayCall![1]).toEqual([TENANT_A]);
  });
});

describe("usage overview — real aggregates only, never fabricated", () => {
  it("groups by event_type correctly and never pads ai_tokens with a fabricated number", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 3,
        rows: [
          { event_type: "agent_run", count: 4, quantity: "4" },
          { event_type: "api_request", count: 12, quantity: "812" },
          { event_type: "lead_captured", count: 7, quantity: "7" },
          // no ai_tokens row at all — no agent in this codebase reports a real token count
        ],
      },
      {
        rowCount: 2,
        rows: [
          { day: "2026-11-20", event_type: "agent_run", quantity: "2" },
          { day: "2026-11-21", event_type: "agent_run", quantity: "2" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/usage/overview`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.summary.agent_run).toEqual({ count: 4, quantity: 4 });
    expect(res.body.summary.api_request).toEqual({ count: 12, quantity: 812 });
    expect(res.body.summary.lead_captured).toEqual({ count: 7, quantity: 7 });
    // honest empty bucket, not a fabricated count/quantity
    expect(res.body.summary.ai_tokens).toEqual({ count: 0, quantity: 0 });
    expect(res.body.perDay).toEqual([
      { day: "2026-11-20", eventType: "agent_run", quantity: 2 },
      { day: "2026-11-21", eventType: "agent_run", quantity: 2 },
    ]);
  });

  it("returns every category empty (not zero-padded with fake history) when there is no usage at all", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/usage/overview`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      agent_run: { count: 0, quantity: 0 },
      api_request: { count: 0, quantity: 0 },
      lead_captured: { count: 0, quantity: 0 },
      ai_tokens: { count: 0, quantity: 0 },
    });
    expect(res.body.perDay).toEqual([]);
  });
});
