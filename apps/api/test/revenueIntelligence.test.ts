import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocked-pg-pool unit-test style as campaignAttribution.test.ts /
// growthRevenueAnalytics.test.ts.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { revenueIntelligenceRouter } = await import("../src/routes/revenueIntelligence.js");
const { computeRevenueIntelligence } = await import("../src/lib/revenueIntelligence.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/revenue-intelligence", revenueIntelligenceRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN_1 = "77777777-7777-7777-7777-777777777777";
const PROSPECTING_CAMPAIGN_1 = "88888888-8888-8888-8888-888888888888";
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

function fakeTenantDb() {
  return { query: queryMock };
}

const OUTBOUND_ROW_WITH_SPEND = {
  campaign_id: CAMPAIGN_1,
  campaign_name: "Q1 outbound",
  campaign_status: "approved",
  spend: "500.00",
  qualified_leads: "8",
  meetings_booked: "3",
  deals_won: "2",
  customers_won: "2",
  revenue: "4000.00",
};

const OUTBOUND_ROW_NO_SPEND_NO_CUSTOMERS = {
  campaign_id: "99999999-9999-9999-9999-999999999999",
  campaign_name: "Cold outreach (new)",
  campaign_status: "draft",
  spend: null,
  qualified_leads: "1",
  meetings_booked: "0",
  deals_won: "0",
  customers_won: "0",
  revenue: null,
};

const PROSPECTING_ROW = {
  campaign_id: PROSPECTING_CAMPAIGN_1,
  campaign_name: "Discovery batch 1",
  campaign_status: "completed",
  spend: "100.00",
  qualified_leads: "4",
  meetings_booked: "1",
  deals_won: "0",
  customers_won: "0",
  revenue: "0",
};

describe("computeRevenueIntelligence (lib)", () => {
  it("computes a real per-campaign CAC/ROI from qualified leads -> meetings -> deals won -> revenue", async () => {
    queueResponses([
      { rowCount: 1, rows: [OUTBOUND_ROW_WITH_SPEND] }, // outbound query
      { rowCount: 1, rows: [PROSPECTING_ROW] }, // prospecting query
    ]);

    const result = await computeRevenueIntelligence(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.campaigns).toHaveLength(2);
    const outbound = result.campaigns.find((c) => c.campaignId === CAMPAIGN_1)!;
    expect(outbound.campaignType).toBe("outbound");
    expect(outbound.qualifiedLeads).toBe(8);
    expect(outbound.meetingsBooked).toBe(3);
    expect(outbound.dealsWon).toBe(2);
    expect(outbound.customersWon).toBe(2);
    expect(outbound.revenue).toBe(4000);
    expect(outbound.spend).toBe(500);
    // CAC = 500 / 2 = 250
    expect(outbound.cac).toEqual({ value: 250, currency: "USD", customersWon: 2, totalSpend: 500 });
    // ROI = (4000 - 500) / 500 = 7
    expect(outbound.roi).toEqual({ value: 7, totalRevenue: 4000, totalSpend: 500 });

    const prospecting = result.campaigns.find((c) => c.campaignId === PROSPECTING_CAMPAIGN_1)!;
    expect(prospecting.campaignType).toBe("prospecting");
    expect(prospecting.qualifiedLeads).toBe(4);
    expect(prospecting.spend).toBe(100);

    expect(result.totals.qualifiedLeads).toBe(12);
    expect(result.totals.meetingsBooked).toBe(4);
    expect(result.totals.revenue).toBe(4000);
    expect(result.totals.recordedSpend).toBe(600);
  });

  it("reports CAC/ROI as 'not_available' with an insufficient_data reason — never a fabricated zero — when spend is missing or no customers have been won yet", async () => {
    queueResponses([
      { rowCount: 1, rows: [OUTBOUND_ROW_NO_SPEND_NO_CUSTOMERS] }, // outbound: no spend recorded
      { rowCount: 1, rows: [{ ...PROSPECTING_ROW, spend: "250.00", customers_won: "0", deals_won: "0", revenue: "0" }] }, // prospecting: spend recorded but no customers won
    ]);

    const result = await computeRevenueIntelligence(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    const noSpendCampaign = result.campaigns.find((c) => c.campaignName === "Cold outreach (new)")!;
    expect(noSpendCampaign.spend).toBeNull();
    expect(noSpendCampaign.cac).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No spend has been recorded"),
    });
    expect(noSpendCampaign.roi).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No spend has been recorded"),
    });

    const spendButNoCustomers = result.campaigns.find((c) => c.campaignId === PROSPECTING_CAMPAIGN_1)!;
    expect(spendButNoCustomers.customersWon).toBe(0);
    expect(spendButNoCustomers.cac).toEqual({
      value: "not_available",
      reason: expect.stringContaining("insufficient_data"),
    });
  });
});

describe("GET /revenue-intelligence (route)", () => {
  it("returns the per-campaign rollup for the project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [OUTBOUND_ROW_WITH_SPEND] }, // outbound query
      { rowCount: 1, rows: [PROSPECTING_ROW] }, // prospecting query
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/revenue-intelligence`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.revenueIntelligence.campaigns).toHaveLength(2);
    expect(res.body.revenueIntelligence.totals.customersWon).toBe(2);
  });

  it("404s when the project does not exist in this tenant", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]); // project lookup: not found

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/revenue-intelligence`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});
