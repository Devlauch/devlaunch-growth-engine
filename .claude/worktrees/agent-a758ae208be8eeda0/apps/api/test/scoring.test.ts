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

  it("404s recompute when the project has no active rubric", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: LEAD_1, email: "a@acme.com", company: "Acme", custom_fields: {} }] }, // lead exists
      { rowCount: 0, rows: [] }, // no active rubric
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}/recompute`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });

  it("recomputes a score from custom_fields evidence (full credit for a matched criterion, zero for a missing one)", async () => {
    const app = buildApp();
    const criteria = [
      { key: "budget_confirmed", label: "Budget confirmed", weight: 60 },
      { key: "decision_maker", label: "Talked to a decision maker", weight: 40 },
    ];
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: LEAD_1,
            email: null,
            company: null,
            custom_fields: { Budget_Confirmed: "yes, $50k" },
          },
        ],
      }, // lead exists, has matching custom_fields evidence (case-insensitive key)
      { rowCount: 1, rows: [{ id: RUBRIC_1, criteria, is_active: true }] }, // active rubric
      // no email/company on this lead, so no discovered_organizations lookups happen
      {
        rowCount: 1,
        rows: [
          {
            id: "score-1",
            lead_id: LEAD_1,
            rubric_id: RUBRIC_1,
            total_score: "60",
            criteria_evidence: {
              budget_confirmed: { score: 60, maxScore: 60, hasEvidence: true },
              decision_maker: { score: 0, maxScore: 40, hasEvidence: false },
            },
            why_summary: "...",
            next_research_note: "...",
          },
        ],
      }, // upsert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}/recompute`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.score.lead_id).toBe(LEAD_1);

    const upsertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO lead_scores"),
    );
    expect(upsertCall).toBeDefined();
    const params = upsertCall![1] as unknown[];
    // total_score (index 4) should reflect full credit for budget_confirmed only: 60/100 * 100 = 60.
    expect(params[4]).toBe(60);
    const criteriaEvidence = JSON.parse(params[5] as string);
    expect(criteriaEvidence.budget_confirmed.hasEvidence).toBe(true);
    expect(criteriaEvidence.budget_confirmed.score).toBe(60);
    expect(criteriaEvidence.decision_maker.hasEvidence).toBe(false);
    expect(criteriaEvidence.decision_maker.score).toBe(0);
    // ON CONFLICT upsert, not a plain insert.
    expect(upsertCall![0]).toContain("ON CONFLICT (lead_id) DO UPDATE");
  });

  it("scores 0 for every criterion when there is no matching evidence anywhere", async () => {
    const app = buildApp();
    const criteria = [{ key: "has_budget", label: "Has budget", weight: 100 }];
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: LEAD_1, email: "nobody@unknown-domain-xyz.com", company: "Totally Unmatched Co", custom_fields: {} }],
      }, // lead exists, no custom_fields evidence
      { rowCount: 1, rows: [{ id: RUBRIC_1, criteria, is_active: true }] }, // active rubric
      { rowCount: 0, rows: [] }, // no discovered_organizations match by domain
      { rowCount: 0, rows: [] }, // no discovered_organizations match by name
      {
        rowCount: 1,
        rows: [
          {
            id: "score-1",
            lead_id: LEAD_1,
            total_score: "0",
            criteria_evidence: { has_budget: { score: 0, maxScore: 100, hasEvidence: false } },
            why_summary: "...",
            next_research_note: "...",
          },
        ],
      }, // upsert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}/recompute`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const upsertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO lead_scores"),
    );
    const params = upsertCall![1] as unknown[];
    expect(params[4]).toBe(0);
  });

  it("finds org evidence by matched discovered_organizations/discovered_contacts data when custom_fields has none", async () => {
    const app = buildApp();
    const criteria = [{ key: "enterprise_scale", label: "Enterprise scale", weight: 100 }];
    const ORG_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: LEAD_1, email: "jane@acme.com", company: null, custom_fields: {} }],
      }, // lead exists
      { rowCount: 1, rows: [{ id: RUBRIC_1, criteria, is_active: true }] }, // active rubric
      {
        rowCount: 1,
        rows: [{ id: ORG_1, name: "Acme Corp", raw_metadata: { notes: "This is an enterprise scale deployment" } }],
      }, // matched by normalized_domain
      { rowCount: 0, rows: [] }, // no contacts
      {
        rowCount: 1,
        rows: [
          {
            id: "score-1",
            lead_id: LEAD_1,
            total_score: "100",
            criteria_evidence: { enterprise_scale: { score: 100, maxScore: 100, hasEvidence: true } },
            why_summary: "...",
            next_research_note: "...",
          },
        ],
      }, // upsert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/lead-scores/${LEAD_1}/recompute`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    const upsertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO lead_scores"),
    );
    const params = upsertCall![1] as unknown[];
    expect(params[4]).toBe(100);
    const criteriaEvidence = JSON.parse(params[5] as string);
    expect(criteriaEvidence.enterprise_scale.hasEvidence).toBe(true);
    expect(criteriaEvidence.enterprise_scale.evidenceSource).toContain(ORG_1);
  });
});
