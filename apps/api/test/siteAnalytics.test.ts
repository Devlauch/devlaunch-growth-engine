import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { siteAnalyticsRouter } = await import("../src/routes/siteAnalytics.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/site-analytics", siteAnalyticsRouter);
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

describe("GET /api/v1/tenants/:tenantId/projects/:projectId/site-analytics (route-level)", () => {
  it("composes real unique-visitor/session/pageview/bounce-rate/referrer/landing-page numbers, bot sessions excluded", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 42 }] }, // uniqueVisitors
      { rowCount: 1, rows: [{ count: 60 }] }, // sessions
      { rowCount: 1, rows: [{ count: 3 }] }, // botSessions
      { rowCount: 1, rows: [{ count: 150 }] }, // pageviews
      { rowCount: 1, rows: [{ count: 30 }] }, // singlePageviewSessions
      {
        rowCount: 2,
        rows: [
          { referrer: "https://google.com/", count: 25 },
          { referrer: "https://twitter.com/", count: 10 },
        ],
      }, // topReferrers
      {
        rowCount: 1,
        rows: [{ landing_url: "https://customer-site.example/pricing", count: 20 }],
      }, // topLandingPages
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/site-analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const sa = res.body.siteAnalytics;
    expect(sa.uniqueVisitors).toBe(42);
    expect(sa.sessions).toBe(60);
    expect(sa.pageviews).toBe(150);
    expect(sa.bounceRate).toBe(0.5);
    expect(sa.botSessionsExcluded).toBe(3);
    expect(sa.topReferrers).toEqual([
      { referrer: "https://google.com/", count: 25 },
      { referrer: "https://twitter.com/", count: 10 },
    ]);
    expect(sa.topLandingPages).toEqual([{ landingUrl: "https://customer-site.example/pricing", count: 20 }]);
  });

  it("reports bounceRate as null (never a fabricated ratio) when there are zero sessions", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ count: 0 }] }, // uniqueVisitors
      { rowCount: 1, rows: [{ count: 0 }] }, // sessions
      { rowCount: 1, rows: [{ count: 0 }] }, // botSessions
      { rowCount: 1, rows: [{ count: 0 }] }, // pageviews
      { rowCount: 1, rows: [{ count: 0 }] }, // singlePageviewSessions
      { rowCount: 0, rows: [] }, // topReferrers
      { rowCount: 0, rows: [] }, // topLandingPages
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/site-analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.siteAnalytics.bounceRate).toBeNull();
    expect(res.body.siteAnalytics.sessions).toBe(0);
  });

  it("404s when the project doesn't belong to the tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // project does not exist
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/site-analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});
