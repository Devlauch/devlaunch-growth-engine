import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts / campaigns.test.ts: fake the pg
// pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { scoringRubricsRouter, leadScoresRouter } = await import("../src/routes/scoring.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/scoring-rubrics",
    scoringRubricsRouter,
  );
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/lead-scores",
    leadScoresRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const RUBRIC_1 = "77777777-7777-7777-7777-777777777777";
const LEAD_1 = "88888888-8888-8888-8888-888888888888";
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

describe("scoring-rubrics route validation", () => {
  it("rejects creating a rubric with no criteria", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/scoring-rubrics`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Default rubric", criteria: [] });

    expect(res.status).toBe(400);
  });

  it("rejects a criterion with a non-positive weight", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/scoring-rubrics`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Default rubric", criteria: [{ key: "x", label: "X", weight: 0 }] });

    expect(res.status).toBe(400);
  });

  it("creates a rubric with valid criteria", async () => {
    const app = buildApp();
    const criteria = [{ key: "company_size", label: "Company size fits ICP", weight: 40 }];
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: RUBRIC_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            name: "Default rubric",
            criteria,
            is_active: true,
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/scoring-rubrics`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Default rubric", criteria });

    expect(res.status).toBe(201);
    expect(res.body.scoringRubric.name).toBe("Default rubric");
  });

  it("lists rubrics for a project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: RUBRIC_1, name: "Default rubric" }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/scoring-rubrics`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.scoringRubrics).toHaveLength(1);
  });

  it("rejects a PATCH with no fields to update", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/scoring-rubrics/${RUBRIC_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(400);
  });

  it("404s a PATCH to a rubric that doesn't exist", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // rubric lookup
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/scoring-rubrics/${RUBRIC_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ isActive: false });

    expect(res.status).toBe(404);
  });
});

describe("lead-scores route", () => {
  it("404s GET when no score has been computed for the lead yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
      { rowCount: 0, rows: [] }, // no lead_scores row
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("returns the current score for a lead", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
      {
        rowCount: 1,
        rows: [{ id: "score-1", lead_id: LEAD_1, total_score: "75", why_summary: "..." }],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.leadScore.lead_id).toBe(LEAD_1);
  });

  it("404s when the lead itself doesn't exist", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // lead lookup
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("rejects feedback with an invalid feedback value", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}/feedback`)
      .set("X-Dev-User-Id", USER_1)
      .send({ feedback: "meh" });

    expect(res.status).toBe(400);
  });

  it("inserts good/bad feedback for a lead", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
      {
        rowCount: 1,
        rows: [{ id: "fb-1", lead_id: LEAD_1, user_id: USER_1, feedback: "good", note: "Great fit" }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}/feedback`)
      .set("X-Dev-User-Id", USER_1)
      .send({ feedback: "good", note: "Great fit" });

    expect(res.status).toBe(201);
    expect(res.body.feedback.feedback).toBe("good");

    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO lead_score_feedback"),
    );
    expect(insertCall).toBeDefined();
  });

  it("returns 501 for recompute (not yet wired to evidence sources)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1 }] }, // lead exists
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}/recompute`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(501);
  });
});
