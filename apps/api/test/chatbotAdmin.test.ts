import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { chatbotAdminRouter } = await import("../src/routes/chatbotAdmin.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/chatbot", chatbotAdminRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const SOURCE_1 = "44444444-4444-4444-4444-444444444444";
const USER_1 = "user-1";
const BASE = `/api/v1/tenants/${TENANT_1}/projects/${PROJECT_1}/chatbot`;

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  delete process.env.CRAWL4AI_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Same mockMembership()/queueResponses() convention as competitors.test.ts:
// requireAuth is exercised for real via the dev-auth X-Dev-User-Id header
// (ALLOW_DEV_AUTH defaults to true), and requireTenantMembership is
// exercised for real against the mocked pg pool, so every request below
// must supply these 3 responses FIRST (BEGIN, set_config, membership
// lookup) before any route-level query mocks.
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

function mockProjectInTenant() {
  return { rowCount: 1, rows: [{ "?column?": 1 }] };
}

describe("GET/PATCH .../chatbot/config", () => {
  it("creates a default config row the first time it's requested", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(), // assertProjectInTenant
      { rowCount: 0, rows: [] }, // existing config: none
      { rowCount: 1, rows: [{ id: "cfg-1", project_id: PROJECT_1, enabled: false }] }, // insert
    ]);

    const app = buildApp();
    const res = await request(app).get(`${BASE}/config`).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.config.id).toBe("cfg-1");
  });

  it("updates only the fields provided", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(), // assertProjectInTenant
      { rowCount: 1, rows: [{ id: "cfg-1" }] }, // loadOrCreateConfig: existing
      { rowCount: 1, rows: [{ id: "cfg-1", enabled: true }] }, // update
    ]);

    const app = buildApp();
    const res = await request(app).patch(`${BASE}/config`).set("X-Dev-User-Id", USER_1).send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.config.enabled).toBe(true);
    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE chatbot_configs"));
    expect(updateCall![0]).toContain("enabled = $3");
  });

  it("rejects more than 3 qualifying questions", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 1, rows: [{ id: "cfg-1" }] },
    ]);

    const app = buildApp();
    const res = await request(app)
      .patch(`${BASE}/config`)
      .set("X-Dev-User-Id", USER_1)
      .send({ qualifyingQuestions: ["q1", "q2", "q3", "q4"] });

    expect(res.status).toBe(400);
  });
});

describe("knowledge-sources CRUD", () => {
  it("creates a manual entry as immediately approved and active", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      {
        rowCount: 1,
        rows: [{ id: SOURCE_1, question: "Q", answer: "A", origin: "manual", status: "approved", is_active: true }],
      },
    ]);

    const app = buildApp();
    const res = await request(app)
      .post(`${BASE}/knowledge-sources`)
      .set("X-Dev-User-Id", USER_1)
      .send({ question: "What is your refund policy?", answer: "30 days, no questions asked.", tags: ["refunds"] });

    expect(res.status).toBe(201);
    expect(res.body.knowledgeSource.status).toBe("approved");
    const insertCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO chatbot_knowledge_sources"));
    expect(insertCall![0]).toContain("'manual'");
    expect(insertCall![0]).toContain("'approved'");
  });

  it("rejects approving a knowledge source that isn't pending_review", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 1, rows: [{ id: SOURCE_1, status: "approved" }] }, // loadKnowledgeSourceOr404
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/knowledge-sources/${SOURCE_1}/approve`).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(409);
  });

  it("approves a pending_review website_import row, flipping it live", async () => {
    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      { rowCount: 1, rows: [{ id: SOURCE_1, status: "pending_review" }] }, // load
      { rowCount: 1, rows: [{ id: SOURCE_1, status: "approved", is_active: true }] }, // update
    ]);

    const app = buildApp();
    const res = await request(app).post(`${BASE}/knowledge-sources/${SOURCE_1}/approve`).set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.knowledgeSource.status).toBe("approved");
    expect(res.body.knowledgeSource.is_active).toBe(true);
  });
});

describe("POST .../knowledge-sources/import", () => {
  it("crawls each URL and inserts every extracted snippet as pending_review, never live", async () => {
    process.env.CRAWL4AI_BASE_URL = "http://crawl4ai.local";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "",
        json: async () => ({
          results: [{ html: "<p>What is your refund policy?</p><p>30 days, no questions asked.</p>", metadata: {} }],
        }),
      })),
    );

    queueResponses([
      ...mockMembership(),
      mockProjectInTenant(),
      {
        rowCount: 1,
        rows: [{ id: SOURCE_1, question: "What is your refund policy?", answer: "30 days, no questions asked.", origin: "website_import", status: "pending_review", is_active: false }],
      },
    ]);

    const app = buildApp();
    const res = await request(app)
      .post(`${BASE}/knowledge-sources/import`)
      .set("X-Dev-User-Id", USER_1)
      .send({ urls: ["https://client-site.example/faq"] });

    expect(res.status).toBe(201);
    expect(res.body.importedCount).toBe(1);
    expect(res.body.imported[0].status).toBe("pending_review");
    expect(res.body.imported[0].is_active).toBe(false);

    const insertCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO chatbot_knowledge_sources"));
    expect(insertCall![0]).toContain("'website_import'");
    expect(insertCall![0]).toContain("'pending_review'");
  });

  it("fails loudly (502) when Crawl4AI is unconfigured, rather than fabricating snippets", async () => {
    delete process.env.CRAWL4AI_BASE_URL;
    queueResponses([...mockMembership(), mockProjectInTenant()]);

    const app = buildApp();
    const res = await request(app)
      .post(`${BASE}/knowledge-sources/import`)
      .set("X-Dev-User-Id", USER_1)
      .send({ urls: ["https://client-site.example/faq"] });

    expect(res.status).toBe(502);
  });
});
