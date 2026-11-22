import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocked-pg-pool unit-test style as sequences.test.ts / compliance.test.ts.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { campaignAttributionRouter } = await import("../src/routes/campaignAttribution.js");
const { listCampaignAttribution, getCampaignAttribution } = await import("../src/lib/campaignAttribution.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/campaign-attribution", campaignAttributionRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN_1 = "77777777-7777-7777-7777-777777777777";
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

const RAW_ATTRIBUTION_ROW = {
  tenant_id: TENANT_A,
  project_id: PROJECT_1,
  campaign_id: CAMPAIGN_1,
  campaign_name: "Q1 outbound",
  campaign_status: "approved",
  campaign_channel: "email",
  member_count: "10",
  active_member_count: "9",
  sequence_enrollment_count: "8",
  sequence_active_count: "3",
  sequence_completed_count: "2",
  conversion_count: "1",
  unsubscribed_count: "1",
  bounced_count: "0",
  stopped_for_reply_count: "2",
  reply_count: "4",
  interested_reply_count: "2",
  unsubscribe_reply_count: "1",
  not_now_reply_count: "1",
  wrong_person_reply_count: "0",
};

describe("campaignAttribution lib (listCampaignAttribution / getCampaignAttribution)", () => {
  function fakeTenantDb() {
    return { query: queryMock };
  }

  it("coerces every bigint-as-string COUNT(...) column from the view into a real number", async () => {
    queueResponses([{ rowCount: 1, rows: [RAW_ATTRIBUTION_ROW] }]);

    const rows = await listCampaignAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(rows).toHaveLength(1);
    expect(rows[0].member_count).toBe(10);
    expect(rows[0].conversion_count).toBe(1);
    expect(rows[0].reply_count).toBe(4);
    expect(typeof rows[0].member_count).toBe("number");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("FROM campaign_attribution");
    expect(params).toEqual([TENANT_A, PROJECT_1, 50, 0]);
  });

  it("getCampaignAttribution returns null when no row matches (e.g. campaign not in this tenant/project)", async () => {
    queueResponses([{ rowCount: 0, rows: [] }]);

    const row = await getCampaignAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1, CAMPAIGN_1);

    expect(row).toBeNull();
  });
});

describe("GET /campaign-attribution", () => {
  it("lists attribution rows, numerically coerced, for the project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [RAW_ATTRIBUTION_ROW] }, // SELECT * FROM campaign_attribution
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaign-attribution`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.campaignAttribution).toHaveLength(1);
    expect(res.body.campaignAttribution[0].campaign_id).toBe(CAMPAIGN_1);
    expect(res.body.campaignAttribution[0].member_count).toBe(10);
  });

  it("404s when the project does not exist in this tenant", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]); // project lookup: not found

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaign-attribution`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("GET /campaign-attribution/:campaignId", () => {
  it("returns a single campaign's attribution row", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [RAW_ATTRIBUTION_ROW] }, // SELECT * FROM campaign_attribution WHERE campaign_id = ...
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaign-attribution/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.campaignAttribution.campaign_name).toBe("Q1 outbound");
    expect(res.body.campaignAttribution.conversion_count).toBe(1);
  });

  it("404s when the campaign has no attribution row", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // no matching campaign_attribution row
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/campaign-attribution/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});
