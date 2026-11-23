import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as growthRevenueAnalytics.test.ts: fake the pg pool,
// no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { crmDashboardRouter } = await import("../src/routes/crmDashboard.js");
const { computeCrmDashboard } = await import("../src/lib/crmDashboard.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/crm-dashboard", crmDashboardRouter);
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

/** A successful runOptional call issues SAVEPOINT, the real query, RELEASE SAVEPOINT. */
function runOptionalOk(rows: unknown[]) {
  return [undefined, { rowCount: rows.length, rows }, undefined];
}

/**
 * The exact query sequence computeGrowthRevenueAnalytics issues (reused
 * verbatim by computeCrmDashboard for salesConversion/totalLeads) — see
 * growthRevenueAnalytics.test.ts, same order.
 */
function growthRevenueAnalyticsResponses() {
  return [
    { rowCount: 1, rows: [{ count: 10 }] }, // totalLeads
    { rowCount: 1, rows: [{ count: 4 }] }, // withReferrer
    { rowCount: 0, rows: [] }, // byReferrer
    { rowCount: 1, rows: [{ source: "internal", count: 10 }] }, // bySource
    { rowCount: 0, rows: [] }, // byUtmSource
    ...runOptionalOk([]), // byDiscoverySource
    ...runOptionalOk([{ count: 5, avg_score: "62.5" }]), // qualifiedCombined
    { rowCount: 1, rows: [{ count: 2 }] }, // meetingsInPeriod
    { rowCount: 0, rows: [] }, // meetingsByType
    { rowCount: 0, rows: [] }, // meetingsByStatus
    { rowCount: 2, rows: [{ stage: "won", count: 2 }, { stage: "new", count: 3 }] }, // dealStageCounts
    { rowCount: 1, rows: [{ total_spend: null }] }, // spend
    { rowCount: 1, rows: [{ count: 2, total_value: "3000.00" }] }, // customers (with value)
  ];
}

describe("computeCrmDashboard (direct unit test against a fake client)", () => {
  it("composes pipeline value by stage, period won/lost, upcoming meetings, overdue tasks and lead-to-customer conversion", async () => {
    const fakeClient = { query: queryMock } as unknown as import("pg").PoolClient;
    queueResponses([
      ...growthRevenueAnalyticsResponses(),
      // pipelineResult
      {
        rowCount: 2,
        rows: [
          { stage: "new", deal_count: 3, total_value: "1500.00" },
          { stage: "won", deal_count: 2, total_value: "4000.00" },
        ],
      },
      // dealsPeriodResult
      {
        rowCount: 1,
        rows: [{ stage: "won", count: 2, total_value: "4000.00" }],
      },
      // upcomingMeetingsResult
      {
        rowCount: 1,
        rows: [{ id: "meeting-1", lead_id: "lead-1", type: "demo", scheduled_at: "2026-12-01T10:00:00Z" }],
      },
      // overdueTasksResult
      {
        rowCount: 1,
        rows: [
          {
            id: "task-1",
            lead_id: "lead-2",
            task_type: "follow_up",
            title: "Deal stalled",
            due_at: "2026-11-01T00:00:00Z",
          },
        ],
      },
      // customersResult (plain count)
      { rowCount: 1, rows: [{ count: 2 }] },
    ]);

    const result = await computeCrmDashboard(fakeClient, TENANT_A, PROJECT_1, { sinceDays: 30 });

    expect(result.periodDays).toBe(30);
    expect(result.pipelineByStage).toEqual([
      { stage: "new", dealCount: 3, totalValue: 1500 },
      { stage: "won", dealCount: 2, totalValue: 4000 },
    ]);
    expect(result.dealsThisPeriod).toEqual({
      won: { count: 2, totalValue: 4000 },
      lost: { count: 0, totalValue: 0 },
    });
    expect(result.upcomingMeetings).toEqual([
      { id: "meeting-1", leadId: "lead-1", type: "demo", scheduledAt: "2026-12-01T10:00:00Z" },
    ]);
    expect(result.overdueFollowUpTasks).toEqual([
      { id: "task-1", leadId: "lead-2", taskType: "follow_up", title: "Deal stalled", dueAt: "2026-11-01T00:00:00Z" },
    ]);
    expect(result.leadToCustomerConversion).toEqual({
      totalLeads: 10,
      totalCustomers: 2,
      rate: 0.2,
    });
    // salesConversion is reused verbatim from growthRevenueAnalytics, not recomputed.
    expect(result.salesConversion).toEqual({
      totalDeals: 5,
      wonDeals: 2,
      lostDeals: 0,
      openDeals: 3,
      winRate: 1,
      leadToDealRate: 0.5,
    });
  });

  it("reports a null conversion rate (never a fabricated number) when there are no leads yet", async () => {
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
      { rowCount: 1, rows: [{ total_spend: null }] }, // spend
      { rowCount: 1, rows: [{ count: 0, total_value: null }] }, // customers
      { rowCount: 0, rows: [] }, // pipelineResult
      { rowCount: 0, rows: [] }, // dealsPeriodResult
      { rowCount: 0, rows: [] }, // upcomingMeetingsResult
      { rowCount: 0, rows: [] }, // overdueTasksResult
      { rowCount: 1, rows: [{ count: 0 }] }, // customersResult
    ]);

    const result = await computeCrmDashboard(fakeClient, TENANT_A, PROJECT_1);

    expect(result.leadToCustomerConversion).toEqual({ totalLeads: 0, totalCustomers: 0, rate: null });
    expect(result.pipelineByStage).toEqual([]);
    expect(result.upcomingMeetings).toEqual([]);
    expect(result.overdueFollowUpTasks).toEqual([]);
  });
});

describe("GET /crm-dashboard (route-level)", () => {
  it("404s when the project does not belong to this tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // project NOT found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-dashboard`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("200s with a composed dashboard for a valid project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      ...growthRevenueAnalyticsResponses(),
      { rowCount: 0, rows: [] }, // pipelineResult
      { rowCount: 0, rows: [] }, // dealsPeriodResult
      { rowCount: 0, rows: [] }, // upcomingMeetingsResult
      { rowCount: 0, rows: [] }, // overdueTasksResult
      { rowCount: 1, rows: [{ count: 2 }] }, // customersResult
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/crm-dashboard`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.crmDashboard.leadToCustomerConversion.totalLeads).toBe(10);
    expect(res.body.crmDashboard.leadToCustomerConversion.totalCustomers).toBe(2);
  });
});
