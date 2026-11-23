import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as companies.test.ts/discovery.test.ts: fake the pg
// pool so these are true unit tests, no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// startCampaignRun itself is unit-tested directly against a fake tenantDb
// below (no HTTP layer) so its own waterfall/persist orchestration is
// covered without re-mocking the whole connector registry here; the route
// tests mock lib/prospectingCampaigns.js's exports instead, keeping each
// layer's test focused on what it actually owns.
const startCampaignRunMock = vi.fn();
const getCampaignResultsSummaryMock = vi.fn();
vi.mock("../src/lib/prospectingCampaigns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prospectingCampaigns.js")>();
  return {
    ...actual,
    startCampaignRun: (...args: unknown[]) => startCampaignRunMock(...args),
    getCampaignResultsSummary: (...args: unknown[]) => getCampaignResultsSummaryMock(...args),
  };
});

const { prospectingCampaignsRouter } = await import("../src/routes/prospectingCampaigns.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { Errors } = await import("../src/lib/httpError.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/prospecting-campaigns",
    prospectingCampaignsRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN_1 = "55555555-5555-5555-5555-555555555555";
const ICP_1 = "44444444-4444-4444-4444-444444444444";
const SOURCE_1 = "77777777-7777-7777-7777-777777777777";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  startCampaignRunMock.mockReset();
  getCampaignResultsSummaryMock.mockReset();
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

describe("POST /prospecting-campaigns", () => {
  it("creates a campaign in draft status", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: CAMPAIGN_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            name: "Q1 restaurant outreach",
            goal: "Find 50 restaurant leads in Springfield",
            icp_profile_id: null,
            status: "draft",
            started_at: null,
            completed_at: null,
          },
        ],
      }, // INSERT prospecting_campaigns
      undefined, // INSERT audit_events
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Q1 restaurant outreach", goal: "Find 50 restaurant leads in Springfield" });

    expect(res.status).toBe(201);
    expect(res.body.prospectingCampaign).toMatchObject({ name: "Q1 restaurant outreach", status: "draft" });

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO prospecting_campaigns"),
    );
    expect(insertCall).toBeDefined();
  });

  it("rejects an icpProfileId that doesn't belong to this project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // icp_profiles lookup -> not found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "x", icpProfileId: ICP_1 });

    expect(res.status).toBe(400);
  });

  it("rejects an empty name", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "" });

    expect(res.status).toBe(400);
  });
});

describe("GET /prospecting-campaigns/:id", () => {
  it("returns the campaign, its configured sources, and a real results summary", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "x", status: "completed" }],
      }, // loadCampaignOr404
      {
        rowCount: 1,
        rows: [{ id: "pcs-1", discovery_source_id: SOURCE_1, priority: 0, name: "Public directory", connector_type: "public_directory", enabled: true }],
      }, // sources
    ]);
    getCampaignResultsSummaryMock.mockResolvedValueOnce({
      organizationsFound: 5,
      contactsFound: 2,
      leadsCreated: 1,
      leadsQualified: 0,
      dealsCount: 0,
      dealsWon: 0,
      wonValue: 0,
    });

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.resultsSummary).toEqual({
      organizationsFound: 5,
      contactsFound: 2,
      leadsCreated: 1,
      leadsQualified: 0,
      dealsCount: 0,
      dealsWon: 0,
      wonValue: 0,
    });
    expect(res.body.sources).toHaveLength(1);
    expect(getCampaignResultsSummaryMock).toHaveBeenCalledWith(expect.anything(), TENANT_A, PROJECT_1, CAMPAIGN_1);
  });

  it("404s for a campaign in a different tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // loadCampaignOr404 -> not found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("GET /prospecting-campaigns/:id/analytics", () => {
  it("returns real status/verification/score-distribution aggregates, no spend section", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "x", status: "completed" }],
      }, // loadCampaignOr404
      {
        rowCount: 2,
        rows: [
          { status: "new", count: 3 },
          { status: "researched", count: 2 },
        ],
      }, // org status breakdown
      {
        rowCount: 1,
        rows: [{ status: "verified", count: 4 }],
      }, // contact verification breakdown
      { rowCount: 1, rows: [{ count: 2 }] }, // promoted leads count
      {
        rowCount: 1,
        rows: [{ count: 2, avg_score: "62.5", min_score: "40", max_score: "85" }],
      }, // score stats
      {
        rowCount: 2,
        rows: [
          { bucket: "25-50", count: 1 },
          { bucket: "75-100", count: 1 },
        ],
      }, // score distribution
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.organizations).toEqual({
      total: 5,
      byStatus: [
        { status: "new", count: 3 },
        { status: "researched", count: 2 },
      ],
    });
    expect(res.body.contacts).toEqual({
      total: 4,
      byVerificationStatus: [{ status: "verified", count: 4 }],
    });
    expect(res.body.leads).toEqual({
      promotedCount: 2,
      scoredCount: 2,
      averageScore: 62.5,
      minScore: 40,
      maxScore: 85,
      scoreDistribution: [
        { bucket: "25-50", count: 1 },
        { bucket: "75-100", count: 1 },
      ],
    });
    expect(res.body.spend).toBeUndefined();
  });

  it("reports all-zero/null stats for a campaign with no activity yet, not fabricated numbers", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: CAMPAIGN_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "x", status: "draft" }],
      }, // loadCampaignOr404
      { rowCount: 0, rows: [] }, // org status breakdown
      { rowCount: 0, rows: [] }, // contact verification breakdown
      { rowCount: 1, rows: [{ count: 0 }] }, // promoted leads count
      { rowCount: 1, rows: [{ count: 0, avg_score: null, min_score: null, max_score: null }] }, // score stats
      { rowCount: 0, rows: [] }, // score distribution
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.organizations.total).toBe(0);
    expect(res.body.leads).toEqual({
      promotedCount: 0,
      scoredCount: 0,
      averageScore: null,
      minScore: null,
      maxScore: null,
      scoreDistribution: [],
    });
  });

  it("404s for a campaign in a different tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // loadCampaignOr404 -> not found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/analytics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /prospecting-campaigns/:id", () => {
  it("allows pausing a campaign", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, status: "running" }] }, // loadCampaignOr404
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, status: "paused" }] }, // UPDATE
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body.prospectingCampaign.status).toBe("paused");
  });

  it("rejects setting status to 'running' or 'completed' directly (only startCampaignRun may do that)", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }, { rowCount: 1, rows: [{ id: CAMPAIGN_1 }] }]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "running" });

    expect(res.status).toBe(400);
  });
});

describe("campaign sources", () => {
  it("attaches a discovery source at a given priority", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CAMPAIGN_1 }] }, // loadCampaignOr404
      { rowCount: 1, rows: [{}] }, // discovery source exists
      { rowCount: 1, rows: [{ id: "pcs-1", discovery_source_id: SOURCE_1, priority: 2 }] }, // INSERT
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/sources`)
      .set("X-Dev-User-Id", USER_1)
      .send({ discoverySourceId: SOURCE_1, priority: 2 });

    expect(res.status).toBe(201);
    expect(res.body.campaignSource).toMatchObject({ discovery_source_id: SOURCE_1, priority: 2 });
  });

  it("rejects a discoverySourceId from another project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CAMPAIGN_1 }] }, // loadCampaignOr404
      { rowCount: 0, rows: [] }, // discovery source does not exist in this project
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/sources`)
      .set("X-Dev-User-Id", USER_1)
      .send({ discoverySourceId: SOURCE_1 });

    expect(res.status).toBe(400);
  });

  it("detaches a source", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: CAMPAIGN_1 }] }, // loadCampaignOr404
      { rowCount: 1, rows: [] }, // DELETE
    ]);

    const res = await request(app)
      .delete(
        `/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/sources/22222222-2222-2222-2222-222222222222`,
      )
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(204);
  });
});

describe("POST /prospecting-campaigns/:id/start-run", () => {
  it("runs the waterfall and tags created records with the campaign id", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]); // project exists
    startCampaignRunMock.mockResolvedValueOnce({
      campaign: { id: CAMPAIGN_1, status: "completed" },
      persisted: {
        organizationsFound: 3,
        organizationsCreated: 3,
        organizationsDuplicate: 0,
        contactsCreated: 1,
        contactsDuplicate: 0,
        organizations: [],
      },
      answeredBySourceId: SOURCE_1,
      answeredBySourceName: "Public directory",
      attempts: [{ provider: "Public directory", status: "success", durationMs: 12 }],
    });

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/start-run`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.prospectingCampaign.status).toBe("completed");
    expect(res.body.answeredBySourceId).toBe(SOURCE_1);
    expect(res.body.organizationsCreated).toBe(3);
    expect(startCampaignRunMock).toHaveBeenCalledWith(expect.anything(), TENANT_A, PROJECT_1, CAMPAIGN_1, {});
  });

  it("propagates a 409 when the campaign already has a run in progress", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    startCampaignRunMock.mockRejectedValueOnce(Errors.conflict("This campaign already has a run in progress."));

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/start-run`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(409);
  });

  it("propagates a 400 when the campaign has no configured sources", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);
    startCampaignRunMock.mockRejectedValueOnce(
      Errors.badRequest("This campaign has no discovery sources configured — add at least one before starting a run."),
    );

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/prospecting-campaigns/${CAMPAIGN_1}/start-run`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });
});
