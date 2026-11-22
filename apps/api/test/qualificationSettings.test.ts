import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Ported from the isolated milestone3-phase2 branch, same mocking pattern
// as deals.test.ts/leadPromotion.test.ts: fake the pg pool, true unit
// tests, no real Postgres/RLS involved.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { qualificationSettingsRouter } = await import("../src/routes/qualificationSettings.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/qualification-settings",
    qualificationSettingsRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "owner") {
  return [undefined, undefined, { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("tenant isolation on qualification-settings routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/qualification-settings`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("FROM qualification_settings"),
      expect.anything(),
    );
  });
});

describe("GET qualification-settings", () => {
  it("returns null (never a fabricated default) when this project has no row yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // no qualification_settings row
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/qualification-settings`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.qualificationSettings).toBeNull();
  });

  it("returns the configured row when one exists", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "qs1", min_score_to_qualify: 70 }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/qualification-settings`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.qualificationSettings.min_score_to_qualify).toBe(70);
  });
});

describe("PUT qualification-settings", () => {
  it("rejects a threshold outside 0-100", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .put(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/qualification-settings`)
      .set("X-Dev-User-Id", USER_1)
      .send({ minScoreToQualify: 150 });

    expect(res.status).toBe(400);
  });

  it("upserts the project's single row via ON CONFLICT", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "qs1", min_score_to_qualify: 65 }] }, // upsert RETURNING
    ]);

    const res = await request(app)
      .put(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/qualification-settings`)
      .set("X-Dev-User-Id", USER_1)
      .send({ minScoreToQualify: 65 });

    expect(res.status).toBe(200);
    expect(res.body.qualificationSettings.min_score_to_qualify).toBe(65);

    const upsertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO qualification_settings"),
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall![0]).toContain("ON CONFLICT (project_id) DO UPDATE");
  });
});
