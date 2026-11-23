import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocked-pg-pool unit-test style as revenueIntelligence.test.ts /
// campaignAttribution.test.ts.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { visitorRevenueAttributionRouter } = await import("../src/routes/visitorRevenueAttribution.js");
const { computeVisitorRevenueAttribution } = await import("../src/lib/visitorRevenueAttribution.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/visitor-attribution", visitorRevenueAttributionRouter);
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

function fakeTenantDb() {
  return { query: queryMock };
}

const GOOGLE_CPC_ROW = {
  channel_source: "google",
  channel_medium: "cpc",
  channel_campaign_or_landing: "spring-sale",
  visitor_count: "40",
  lead_count: "6",
  qualified_lead_count: "4",
  deals_won: "2",
  customers_won: "2",
  revenue: "9000.00",
};

const DIRECT_ROW = {
  channel_source: "direct",
  channel_medium: null,
  channel_campaign_or_landing: "(none)",
  visitor_count: "15",
  lead_count: "1",
  qualified_lead_count: "0",
  deals_won: "0",
  customers_won: "0",
  revenue: "0",
};

describe("computeVisitorRevenueAttribution (lib)", () => {
  it("computes a real per-channel visitor -> lead -> deal -> revenue rollup with CAC/ROI against recorded acquisition_costs", async () => {
    queueResponses([
      // SAVEPOINT + channel rollup query + RELEASE SAVEPOINT (runOptionalWide success path)
      undefined,
      { rowCount: 2, rows: [GOOGLE_CPC_ROW, DIRECT_ROW] },
      undefined,
      // SAVEPOINT + acquisition_costs query + RELEASE SAVEPOINT
      undefined,
      { rowCount: 1, rows: [{ channel: "google", total_spend_cents: "100000" }] },
      undefined,
      // SAVEPOINT + unattributed-lead-count query + RELEASE SAVEPOINT
      undefined,
      { rowCount: 1, rows: [{ count: 3 }] },
      undefined,
    ]);

    const result = await computeVisitorRevenueAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.degraded).toBe(false);
    expect(result.channels).toHaveLength(2);

    const google = result.channels.find((c) => c.channelSource === "google")!;
    expect(google.channelMedium).toBe("cpc");
    expect(google.channelCampaignOrLandingPage).toBe("spring-sale");
    expect(google.visitorCount).toBe(40);
    expect(google.leadCount).toBe(6);
    expect(google.qualifiedLeadCount).toBe(4);
    expect(google.customersWon).toBe(2);
    expect(google.revenue).toBe(9000);
    expect(google.spend).toBe(1000); // 100000 cents = $1000
    // CAC = 1000 / 2 = 500
    expect(google.cac).toEqual({ value: 500, currency: "USD", customersWon: 2, totalSpend: 1000 });
    // ROI = (9000 - 1000) / 1000 = 8
    expect(google.roi).toEqual({ value: 8, totalRevenue: 9000, totalSpend: 1000 });

    const direct = result.channels.find((c) => c.channelSource === "direct")!;
    expect(direct.spend).toBeNull();
    expect(direct.cac).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No spend has been recorded"),
    });

    expect(result.totals.visitorCount).toBe(55);
    expect(result.totals.revenue).toBe(9000);
    expect(result.totals.recordedSpend).toBe(1000);
    expect(result.unattributedLeadCount).toBe(3);
  });

  it("reports an honest empty result (never a fabricated rollup) when site_visitors/site_sessions/leads.visitor_id don't exist yet in this environment", async () => {
    const undefinedTableError = Object.assign(new Error('relation "site_visitors" does not exist'), {
      code: "42P01",
    });
    queryMock
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockRejectedValueOnce(undefinedTableError) // channel rollup query
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined); // RELEASE SAVEPOINT

    const result = await computeVisitorRevenueAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(result.degraded).toBe(true);
    expect(result.channels).toEqual([]);
    expect(result.totals).toEqual({
      visitorCount: 0,
      leadCount: 0,
      qualifiedLeadCount: 0,
      dealsWon: 0,
      customersWon: 0,
      revenue: 0,
      recordedSpend: 0,
    });
    expect(result.degradedNote).toMatch(/does not fully exist yet/);
    expect(result.unattributedLeadCount).toBe(0);
  });

  it("reports null spend (never a guessed number) for a channel with no acquisition_costs row at all", async () => {
    queueResponses([
      undefined,
      { rowCount: 1, rows: [GOOGLE_CPC_ROW] },
      undefined,
      undefined,
      { rowCount: 0, rows: [] }, // no acquisition_costs rows recorded for this tenant/project at all
      undefined,
      undefined,
      { rowCount: 1, rows: [{ count: 0 }] },
      undefined,
    ]);

    const result = await computeVisitorRevenueAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    const google = result.channels.find((c) => c.channelSource === "google")!;
    expect(google.spend).toBeNull();
    expect(google.cac).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No spend has been recorded"),
    });
  });
});

describe("GET /visitor-attribution (route)", () => {
  it("returns the per-channel visitor-to-revenue rollup for the project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      undefined,
      { rowCount: 1, rows: [GOOGLE_CPC_ROW] },
      undefined,
      undefined,
      { rowCount: 0, rows: [] },
      undefined,
      undefined,
      { rowCount: 1, rows: [{ count: 0 }] },
      undefined,
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/visitor-attribution`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.visitorRevenueAttribution.channels).toHaveLength(1);
    expect(res.body.visitorRevenueAttribution.channels[0].channelSource).toBe("google");
  });

  it("404s when the project does not exist in this tenant", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]); // project lookup: not found

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/visitor-attribution`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});
