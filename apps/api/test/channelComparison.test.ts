import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocked-pg-pool unit-test style as campaignAttribution.test.ts.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { channelPerformanceRouter } = await import("../src/routes/contentAttribution.js");
const { getChannelPerformance } = await import("../src/lib/channelComparison.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/channel-performance", channelPerformanceRouter);
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

describe("getChannelPerformance", () => {
  function fakeTenantDb() {
    return { query: queryMock };
  }

  it("reports cost-per-customer and ROI as real numbers when spend and won deals both exist", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            campaign_channel: "email",
            campaign_count: "2",
            lead_count: "20",
            qualified_lead_count: "8",
            customer_count: "4",
            total_revenue: "40000",
            total_spend: "4000",
          },
        ],
      },
    ]);

    const rows = await getChannelPerformance(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(rows).toHaveLength(1);
    expect(rows[0].campaign_channel).toBe("email");
    expect(rows[0].lead_count).toBe(20);
    expect(rows[0].customer_count).toBe(4);
    expect(rows[0].costPerCustomer).toEqual({
      value: 1000,
      currency: "USD",
      totalSpend: 4000,
      customerCount: 4,
    });
    expect(rows[0].roi).toEqual({ value: 9, totalRevenue: 40000, totalSpend: 4000 });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("FROM campaigns");
    expect(sql).toContain("GROUP BY campaign_channel");
    expect(params).toEqual([TENANT_A, PROJECT_1]);
  });

  it("reports not_available with a reason when no spend is recorded for a channel (never fabricates a figure)", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            campaign_channel: "social",
            campaign_count: "1",
            lead_count: "5",
            qualified_lead_count: "2",
            customer_count: "0",
            total_revenue: null,
            total_spend: null,
          },
        ],
      },
    ]);

    const rows = await getChannelPerformance(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(rows[0].costPerCustomer).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No campaign spend has been recorded"),
    });
    expect(rows[0].roi).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No campaign spend has been recorded"),
    });
  });

  it("reports cost-per-customer as not_available when spend exists but no deals are won yet", async () => {
    queueResponses([
      {
        rowCount: 1,
        rows: [
          {
            campaign_channel: "event",
            campaign_count: "1",
            lead_count: "3",
            qualified_lead_count: "0",
            customer_count: "0",
            total_revenue: null,
            total_spend: "500",
          },
        ],
      },
    ]);

    const rows = await getChannelPerformance(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(rows[0].costPerCustomer).toEqual({
      value: "not_available",
      reason: expect.stringContaining("No deals have been won yet"),
    });
    // Spend of 500 against 0 revenue is a real, computable (negative) ROI — not "not_available".
    expect(rows[0].roi).toEqual({ value: -1, totalRevenue: 0, totalSpend: 500 });
  });
});

describe("GET /channel-performance", () => {
  it("returns per-channel rows for the project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            campaign_channel: "email",
            campaign_count: "1",
            lead_count: "10",
            qualified_lead_count: "4",
            customer_count: "2",
            total_revenue: "6000",
            total_spend: "2000",
          },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/channel-performance`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.channelPerformance).toHaveLength(1);
    expect(res.body.channelPerformance[0].campaign_channel).toBe("email");
    expect(res.body.channelPerformance[0].customer_count).toBe(2);
  });

  it("404s when the project does not exist in this tenant", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]); // project lookup: not found

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/channel-performance`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});
