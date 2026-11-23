import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

vi.mock("../src/lib/internalLinking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/internalLinking.js")>();
  return {
    ...actual,
    analyzeInternalLinking: vi.fn(),
  };
});

const { seoCampaignsRouter } = await import("../src/routes/seoCampaigns.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { analyzeInternalLinking } = await import("../src/lib/internalLinking.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/seo-campaigns", seoCampaignsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN_1 = "55555555-5555-5555-5555-555555555555";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  vi.mocked(analyzeInternalLinking).mockReset();
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

const SAMPLE_EXTRACTED_KEYWORDS = [
  { keyword: "invoicing", frequency: 10 },
  { keyword: "invoices", frequency: 6 },
  { keyword: "payroll", frequency: 4 },
];

describe("GET /seo-campaigns/keyword-clusters", () => {
  it("returns an honest empty result when no growth analysis has run yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // no growth_analyses row
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns/keyword-clusters`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.clusters).toEqual([]);
    expect(res.body.note).toMatch(/run a growth analysis|run one/i);
  });

  it("clusters the project's real extracted keywords deterministically", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ extracted_keywords: SAMPLE_EXTRACTED_KEYWORDS }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns/keyword-clusters`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.clusters.length).toBeGreaterThan(0);
    const invoiceCluster = res.body.clusters.find((c: { label: string }) => c.label === "invoicing");
    expect(invoiceCluster).toBeDefined();
    expect(invoiceCluster.keywords.map((k: { keyword: string }) => k.keyword).sort()).toEqual(
      ["invoices", "invoicing"].sort(),
    );
  });
});

describe("POST /seo-campaigns", () => {
  it("creates a campaign from custom target keywords", async () => {
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
            name: "Invoicing push",
            domain: null,
            target_keywords: ["invoicing", "invoices"],
            source_cluster: null,
            status: "active",
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Invoicing push", targetKeywords: ["invoicing", "invoices"] });

    expect(res.status).toBe(201);
    expect(res.body.campaign.id).toBe(CAMPAIGN_1);
  });

  it("creates a campaign from a cluster key, resolving it against the project's latest keywords", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ extracted_keywords: SAMPLE_EXTRACTED_KEYWORDS }] }, // loadLatestExtractedKeywords
      {
        rowCount: 1,
        rows: [{ id: CAMPAIGN_1, name: "Invoicing push", target_keywords: ["invoicing", "invoices"] }],
      },
    ]);

    // clusterKey for the "invoicing"/"invoices" group — stem "invoic".
    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Invoicing push", clusterKey: "invoic" });

    expect(res.status).toBe(201);
  });

  it("rejects a body with neither targetKeywords nor clusterKey", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Nothing picked" });

    expect(res.status).toBe(400);
  });
});

describe("GET /seo-campaigns/:id", () => {
  it("returns campaign + content/technical progress", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: CAMPAIGN_1,
            name: "Invoicing push",
            domain: "example.com",
            target_keywords: ["invoicing"],
          },
        ],
      }, // loadCampaignOr404
      { rowCount: 1, rows: [{ id: "cal-1", name: "Nov calendar", start_date: "2026-11-01" }] }, // calendars
      {
        rowCount: 2,
        rows: [
          { status: "draft", count: 3 },
          { status: "approved", count: 2 },
        ],
      }, // items grouped by status
      {
        rowCount: 2,
        rows: [
          { broken_links_count: 1, missing_meta_count: 0, audited_at: "2026-11-10T00:00:00Z" },
          { broken_links_count: 5, missing_meta_count: 2, audited_at: "2026-11-01T00:00:00Z" },
        ],
      }, // seo_audits trend
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.contentProgress.itemsTotal).toBe(5);
    expect(res.body.contentProgress.itemsApproved).toBe(2);
    expect(res.body.technicalProgress.status).toBe("trend");
    expect(res.body.technicalProgress.latestIssueCount).toBe(1);
    expect(res.body.technicalProgress.previousIssueCount).toBe(7);
  });

  it("reports no_domain honestly when the campaign has no domain set", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, name: "x", domain: null, target_keywords: [] }] },
      { rowCount: 0, rows: [] }, // calendars
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns/${CAMPAIGN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.technicalProgress.status).toBe("no_domain");
    expect(res.body.contentProgress.itemsTotal).toBe(0);
  });
});

describe("POST /seo-campaigns/:id/internal-link-suggestions", () => {
  it("flags suggestions that match the campaign's own target keywords", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: CAMPAIGN_1, name: "x", domain: "example.com", target_keywords: ["invoicing"] }],
      }, // loadCampaignOr404
    ]);
    vi.mocked(analyzeInternalLinking).mockResolvedValueOnce({
      domain: "example.com",
      pagesCrawled: 2,
      suggestions: [
        {
          fromUrl: "https://example.com/pricing",
          toUrl: "https://example.com/features",
          clusterKey: "invoic",
          clusterLabel: "invoicing",
          sharedKeywords: ["invoicing", "invoices"],
          reason: "shared cluster",
        },
      ],
    });

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns/${CAMPAIGN_1}/internal-link-suggestions`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].matchesCampaign).toBe(true);
  });

  it("rejects when neither the request nor the campaign has a domain", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: CAMPAIGN_1, name: "x", domain: null, target_keywords: [] }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/seo-campaigns/${CAMPAIGN_1}/internal-link-suggestions`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });
});
