import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { growthAnalyticsRouter } = await import("../src/routes/growthAnalytics.js");
const { computeGrowthRevenueAnalytics, computeCacRoi } = await import("../src/lib/growthRevenueAnalytics.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/growth-analytics", growthAnalyticsRouter);
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

function mockMembership(role = "analyst") {
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

/** A successful runOptional call issues SAVEPOINT, the real query, RELEASE SAVEPOINT. */
function runOptionalOk(rows: unknown[]) {
  return [undefined, { rowCount: rows.length, rows }, undefined];
}

describe("computeGrowthRevenueAnalytics (route-level)", () => {
  it("reports CAC and ROI as 'not_available' (never a fabricated number) when no campaign spend is recorded", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 10 }] }, // totalLeads
      { rowCount: 1, rows: [{ count: 4 }] }, // withReferrer
      { rowCount: 1, rows: [] }, // byReferrer
      { rowCount: 1, rows: [{ source: "internal", count: 10 }] }, // bySource
      { rowCount: 1, rows: [] }, // byUtmSource
      ...runOptionalOk([{ name: "Directory A", count: 3 }]), // byDiscoverySource
      ...runOptionalOk([{ count: 5, avg_score: "62.5" }]), // qualifiedCombined
      { rowCount: 1, rows: [{ count: 2 }] }, // meetingsInPeriod
      { rowCount: 2, rows: [{ type: "call", count: 1 }, { type: "demo", count: 1 }] }, // meetingsByType
      { rowCount: 1, rows: [{ status: "scheduled", count: 2 }] }, // meetingsByStatus
      { rowCount: 2, rows: [{ stage: "won", count: 1 }, { stage: "new", count: 3 }] }, // dealStageCounts
      { rowCount: 1, rows: [{ total_spend: null }] }, // spend: nothing recorded
      { rowCount: 1, rows: [{ count: 1, total_value: "1000.00" }] }, // customers
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const ga = res.body.growthAnalytics;
    expect(ga.customerAcquisitionCost).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No campaign spend"),
    });
    expect(ga.roi).toEqual({ value: "not_available", reason: expect.stringContaining("No campaign spend") });
    expect(ga.salesConversion).toEqual({
      totalDeals: 4,
      wonDeals: 1,
      lostDeals: 0,
      openDeals: 3,
      winRate: 1,
      leadToDealRate: 0.4,
    });
    expect(ga.leadQualification.qualifiedCount).toBe(5);
    expect(ga.leadQualification.averageScore).toBe(62.5);
    expect(ga.meetingsBooked.totalInPeriod).toBe(2);
  });

  it("computes a real CAC and ROI once spend IS recorded", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 10 }] }, // totalLeads
      { rowCount: 1, rows: [{ count: 4 }] }, // withReferrer
      { rowCount: 1, rows: [] }, // byReferrer
      { rowCount: 1, rows: [{ source: "internal", count: 10 }] }, // bySource
      { rowCount: 1, rows: [] }, // byUtmSource
      ...runOptionalOk([]), // byDiscoverySource
      ...runOptionalOk([{ count: 5, avg_score: "62.5" }]), // qualifiedCombined
      { rowCount: 1, rows: [{ count: 2 }] }, // meetingsInPeriod
      { rowCount: 0, rows: [] }, // meetingsByType
      { rowCount: 0, rows: [] }, // meetingsByStatus
      { rowCount: 1, rows: [{ stage: "won", count: 2 }] }, // dealStageCounts
      { rowCount: 1, rows: [{ total_spend: "1000.00" }] }, // spend recorded
      { rowCount: 1, rows: [{ count: 2, total_value: "3000.00" }] }, // customers: 2 won, $3000 revenue
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const ga = res.body.growthAnalytics;
    expect(ga.customerAcquisitionCost).toEqual({
      value: 500,
      currency: "USD",
      customersWon: 2,
      totalSpend: 1000,
    });
    // ROI = (revenue - spend) / spend = (3000 - 1000) / 1000 = 2
    expect(ga.roi).toEqual({ value: 2, totalRevenue: 3000, totalSpend: 1000 });
  });

  it("degrades gracefully (honest zero/note, never a 500) when lead_scores doesn't exist yet in this environment", async () => {
    const missingTableErr = Object.assign(new Error("relation lead_scores does not exist"), { code: "42P01" });
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 10 }] }, // totalLeads
      { rowCount: 1, rows: [{ count: 4 }] }, // withReferrer
      { rowCount: 1, rows: [] }, // byReferrer
      { rowCount: 1, rows: [{ source: "internal", count: 10 }] }, // bySource
      { rowCount: 1, rows: [] }, // byUtmSource
      ...runOptionalOk([]), // byDiscoverySource
      undefined, // qualifiedCombined: SAVEPOINT
    ]);
    queryMock.mockRejectedValueOnce(missingTableErr); // qualifiedCombined: the query itself, 42P01
    queueResponses([
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      { rowCount: 1, rows: [{ count: 3 }] }, // fallback: leads.status = 'qualified' only
      { rowCount: 1, rows: [{ count: 0 }] }, // meetingsInPeriod
      { rowCount: 0, rows: [] }, // meetingsByType
      { rowCount: 0, rows: [] }, // meetingsByStatus
      { rowCount: 0, rows: [] }, // dealStageCounts
      { rowCount: 1, rows: [{ total_spend: null }] }, // spend
      { rowCount: 1, rows: [{ count: 0, total_value: null }] }, // customers
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/growth-analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const ga = res.body.growthAnalytics;
    expect(ga.leadQualification.qualifiedCount).toBe(3);
    expect(ga.leadQualification.averageScore).toBeNull();
    expect(ga.leadQualification.note).toContain("lead_scores table does not exist yet");
  });
});

describe("computeGrowthRevenueAnalytics (direct unit test against a fake client)", () => {
  it("honestly reports CAC not_available when spend is recorded but zero customers won", async () => {
    const fakeClient = { query: queryMock } as unknown as import("pg").PoolClient;
    queueResponses([
      { rowCount: 1, rows: [{ count: 0 }] }, // totalLeads
      { rowCount: 1, rows: [{ count: 0 }] }, // withReferrer
      { rowCount: 0, rows: [] }, // byReferrer
      { rowCount: 0, rows: [] }, // bySource
      { rowCount: 0, rows: [] }, // byUtmSource
      ...runOptionalOk([]), // byDiscoverySource
      ...runOptionalOk([{ count: 0, avg_score: null }]), // qualifiedCombined
      { rowCount: 1, rows: [{ count: 0 }] }, // meetingsInPeriod
      { rowCount: 0, rows: [] }, // meetingsByType
      { rowCount: 0, rows: [] }, // meetingsByStatus
      { rowCount: 0, rows: [] }, // dealStageCounts
      { rowCount: 1, rows: [{ total_spend: "500.00" }] }, // spend recorded
      { rowCount: 1, rows: [{ count: 0, total_value: null }] }, // customers: none won
    ]);

    const result = await computeGrowthRevenueAnalytics(fakeClient, TENANT_A, PROJECT_1, { sinceDays: 7 });

    expect(result.customerAcquisitionCost).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No deals have been won"),
    });
    expect(result.periodDays).toBe(7);
  });
});

describe("computeCacRoi (shared honest-math helper, reused by revenueIntelligence.ts's per-campaign rollup)", () => {
  it("computes a real CAC/ROI when spend and customers are both present", () => {
    const { cac, roi } = computeCacRoi(1000, 4, 6000);
    expect(cac).toEqual({ value: 250, currency: "USD", customersWon: 4, totalSpend: 1000 });
    expect(roi).toEqual({ value: 5, totalRevenue: 6000, totalSpend: 1000 });
  });

  it("reports 'not_available' (never 0) when spend was never recorded", () => {
    const { cac, roi } = computeCacRoi(null, 0, 0);
    expect(cac).toEqual({ value: "not_available", reason: expect.stringContaining("No spend has been recorded") });
    expect(roi).toEqual({ value: "not_available", reason: expect.stringContaining("No spend has been recorded") });
  });

  it("reports an 'insufficient_data' reason (never a fabricated zero) when spend is recorded but no customers have been won yet", () => {
    const { cac, roi } = computeCacRoi(500, 0, 0);
    expect(cac).toEqual({ value: "not_available", reason: expect.stringContaining("insufficient_data") });
    // ROI only depends on spend being non-null and non-zero, so it IS computable here (0 revenue vs. real spend).
    expect(roi).toEqual({ value: -1, totalRevenue: 0, totalSpend: 500 });
  });

  it("reports an 'insufficient_data' ROI reason when recorded spend is exactly 0 (division by zero, not fabrication)", () => {
    const { roi } = computeCacRoi(0, 2, 1000);
    expect(roi).toEqual({ value: "not_available", reason: expect.stringContaining("insufficient_data") });
  });
});
