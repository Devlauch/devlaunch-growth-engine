import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { computeDealHealth, type DealHealthSignals } from "../src/lib/dealHealth.js";

describe("computeDealHealth (pure)", () => {
  const baseDeal = {
    stage: "qualified" as const,
    stage_changed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    value_amount: null,
  };
  const noSignals: DealHealthSignals = {
    latestMeeting: null,
    latestReply: null,
    lastActivityAt: null,
    typicalDealValue: null,
  };

  it("returns 100 with an honest explanation for an already-won deal, ignoring other signals", () => {
    const result = computeDealHealth({ ...baseDeal, stage: "won" }, noSignals);
    expect(result.score).toBe(100);
    expect(result.why[0]).toMatch(/already reached 'won'/);
  });

  it("returns 0 with an honest explanation for an already-lost deal", () => {
    const result = computeDealHealth({ ...baseDeal, stage: "lost" }, noSignals);
    expect(result.score).toBe(0);
    expect(result.why[0]).toMatch(/already reached 'lost'/);
  });

  it("never fabricates a missing meeting/reply/activity signal — says so explicitly instead", () => {
    const result = computeDealHealth(baseDeal, noSignals);
    expect(result.why.some((w) => /No meeting scheduled yet/.test(w))).toBe(true);
    expect(result.why.some((w) => /No reply has been received/.test(w))).toBe(true);
    expect(result.why.some((w) => /No recorded activity/.test(w))).toBe(true);
    expect(result.why.some((w) => /No deal value/.test(w))).toBe(true);
  });

  it("scores higher for a deal with an interested reply and a completed meeting with a next step than an identical deal with neither", () => {
    const now = new Date();
    const strong = computeDealHealth(
      baseDeal,
      {
        latestMeeting: { status: "completed", next_step: "Send proposal", scheduled_at: now.toISOString() },
        latestReply: { classification: "interested", received_at: now.toISOString() },
        lastActivityAt: now.toISOString(),
        typicalDealValue: null,
      },
      now,
    );
    const weak = computeDealHealth(baseDeal, noSignals, now);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("penalizes a deal whose most recent reply was 'unsubscribe' more than one with no reply at all", () => {
    const now = new Date();
    const unsubscribed = computeDealHealth(
      baseDeal,
      { ...noSignals, latestReply: { classification: "unsubscribe", received_at: now.toISOString() } },
      now,
    );
    const noReply = computeDealHealth(baseDeal, noSignals, now);
    expect(unsubscribed.score).toBeLessThan(noReply.score);
  });

  it("penalizes a deal stalled past the stall threshold relative to one freshly moved", () => {
    const now = new Date();
    const stalled = computeDealHealth(
      { ...baseDeal, stage_changed_at: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString() },
      noSignals,
      now,
    );
    const fresh = computeDealHealth(
      { ...baseDeal, stage_changed_at: now.toISOString() },
      noSignals,
      now,
    );
    expect(stalled.score).toBeLessThan(fresh.score);
    expect(stalled.why.some((w) => /over the 7-day stall threshold/.test(w))).toBe(true);
  });

  it("clamps the final score into [0, 100]", () => {
    const now = new Date();
    const worst = computeDealHealth(
      { ...baseDeal, stage: "new", stage_changed_at: new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString() },
      {
        latestMeeting: { status: "no_show", next_step: null, scheduled_at: now.toISOString() },
        latestReply: { classification: "unsubscribe", received_at: now.toISOString() },
        lastActivityAt: new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString(),
        typicalDealValue: 1000,
      },
      now,
    );
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });

  it("only scores the deal-value signal when a real typical value AND a real deal value are both present", () => {
    const now = new Date();
    const noTypical = computeDealHealth({ ...baseDeal, value_amount: 500 }, { ...noSignals, typicalDealValue: null }, now);
    expect(noTypical.why.some((w) => /Not enough other deals/.test(w))).toBe(true);
  });
});

// --- Route-level tests (mocked pg client, same convention as deals.test.ts) ---

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { dealHealthRouter } = await import("../src/routes/dealHealth.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/deals", dealHealthRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const DEAL_1 = "66666666-6666-6666-6666-666666666666";
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

describe("GET /deals/:dealId/health (route)", () => {
  it("404s when the deal does not exist in this tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // deal not found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/${DEAL_1}/health`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("computes a real health score from real queries for an open deal with no signals yet", async () => {
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
            stage: "contacted",
            stage_changed_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            value_amount: null,
          },
        ],
      }, // deal
      { rowCount: 0, rows: [] }, // latest meeting
      { rowCount: 0, rows: [] }, // latest reply
      { rowCount: 1, rows: [{ max: null }] }, // meeting activity max
      { rowCount: 1, rows: [{ max: null }] }, // reply activity max
      { rowCount: 1, rows: [{ max: null }] }, // note activity max
      { rowCount: 1, rows: [{ max: null }] }, // task activity max
      { rowCount: 1, rows: [{ avg_value: null, cnt: "0" }] }, // typical value
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/${DEAL_1}/health`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.dealId).toBe(DEAL_1);
    expect(typeof res.body.score).toBe("number");
    expect(Array.isArray(res.body.why)).toBe(true);
    expect(res.body.why.some((w: string) => /No meeting scheduled yet/.test(w))).toBe(true);
  });

  it("validates the dealId route param as a uuid", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/deals/not-a-uuid/health`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });
});
