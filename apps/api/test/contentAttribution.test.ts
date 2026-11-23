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

const { contentAttributionRouter } = await import("../src/routes/contentAttribution.js");
const { listCalendarItemAttribution, listDraftAttribution, getContentAttribution } = await import(
  "../src/lib/contentAttribution.js"
);
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/content-attribution", contentAttributionRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CONTENT_ITEM_1 = "88888888-8888-8888-8888-888888888888";
const LANDING_PAGE_1 = "99999999-9999-9999-9999-999999999999";
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

const RAW_TAGGED_ROW = {
  content_kind: "calendar_item",
  content_id: CONTENT_ITEM_1,
  title: "5 Ways to Cut Cloud Spend",
  format: "blog",
  landing_page_id: LANDING_PAGE_1,
  landing_page_slug: "cut-cloud-spend",
  landing_page_status: "published",
  lead_count: "3",
  qualified_lead_count: "1",
  form_submit_event_count: "4",
};

const RAW_UNTAGGED_ROW = {
  content_kind: "calendar_item",
  content_id: "77777777-7777-7777-7777-777777777777",
  title: "Untagged LinkedIn post",
  format: "linkedin_post",
  landing_page_id: null,
  landing_page_slug: null,
  landing_page_status: null,
  lead_count: "0",
  qualified_lead_count: "0",
  form_submit_event_count: "0",
};

describe("contentAttribution lib", () => {
  function fakeTenantDb() {
    return { query: queryMock };
  }

  it("listCalendarItemAttribution coerces bigint-as-string counts into real numbers", async () => {
    queueResponses([{ rowCount: 1, rows: [RAW_TAGGED_ROW] }]);

    const rows = await listCalendarItemAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(rows).toHaveLength(1);
    expect(rows[0].lead_count).toBe(3);
    expect(rows[0].qualified_lead_count).toBe(1);
    expect(typeof rows[0].lead_count).toBe("number");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("FROM content_calendar_items");
    expect(sql).toContain("landing_pages");
    expect(sql).toContain("custom_fields ->> 'landingPageId'");
    expect(params).toEqual([TENANT_A, PROJECT_1, 50, 0]);
  });

  it("listDraftAttribution queries content_drafts with the same join shape", async () => {
    queueResponses([{ rowCount: 0, rows: [] }]);

    const rows = await listDraftAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(rows).toEqual([]);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("FROM content_drafts");
  });

  it("getContentAttribution reports untaggedContentCount honestly for content with no landing page tagged", async () => {
    queueResponses([
      { rowCount: 1, rows: [RAW_TAGGED_ROW] }, // calendar items
      { rowCount: 1, rows: [RAW_UNTAGGED_ROW] }, // drafts (reusing same raw shape for simplicity)
    ]);

    const summary = await getContentAttribution(fakeTenantDb() as never, TENANT_A, PROJECT_1);

    expect(summary.rows).toHaveLength(2);
    expect(summary.untaggedContentCount).toBe(1);
    expect(summary.note).toContain("never been tagged");
  });
});

describe("GET /content-attribution", () => {
  it("returns content attribution rows plus an honest untagged count", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [RAW_TAGGED_ROW] }, // calendar items query
      { rowCount: 1, rows: [RAW_UNTAGGED_ROW] }, // drafts query
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-attribution`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.contentAttribution).toHaveLength(2);
    expect(res.body.contentAttribution[0].lead_count).toBe(3);
    expect(res.body.untaggedContentCount).toBe(1);
    expect(typeof res.body.note).toBe("string");
  });

  it("404s when the project does not exist in this tenant", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]); // project lookup: not found

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/content-attribution`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});
