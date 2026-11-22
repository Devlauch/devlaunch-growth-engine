import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts / scoring.test.ts: fake the pg
// pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { onboardingRouter } = await import("../src/routes/onboarding.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/onboarding", onboardingRouter);
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

describe("GET /onboarding/templates", () => {
  it("returns all 4 industry templates as short previews, not full content", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/templates`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(4);

    const keys = res.body.templates.map((t: { key: string }) => t.key).sort();
    expect(keys).toEqual(["agency", "education", "local_services", "saas"]);

    for (const t of res.body.templates as Record<string, unknown>[]) {
      expect(typeof t.label).toBe("string");
      expect(typeof t.valuePropositionPreview).toBe("string");
      expect(Array.isArray(t.icpProfileNames)).toBe(true);
      expect(typeof t.scoringCriteriaCount).toBe("number");
      expect(typeof t.sequenceStepCount).toBe("number");
      // Preview only — the full criteria/ICP/sequence content isn't leaked here.
      expect(t.scoringCriteria).toBeUndefined();
      expect(t.icpProfiles).toBeUndefined();
      expect(t.sequenceTemplate).toBeUndefined();
    }
  });

  it("denies the request when the caller has no active membership in the tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/templates`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });
});

describe("POST /onboarding/apply validation", () => {
  it("rejects an unknown industryTemplate", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/apply`)
      .set("X-Dev-User-Id", USER_1)
      .send({ website: "https://acme.example", offer: "We help you grow.", industryTemplate: "space_travel" });

    expect(res.status).toBe(400);
  });

  it("rejects a non-URL website", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 1, rows: [{}] }]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/apply`)
      .set("X-Dev-User-Id", USER_1)
      .send({ website: "not-a-url", offer: "We help you grow.", industryTemplate: "saas" });

    expect(res.status).toBe(400);
  });
});

describe("POST /onboarding/apply happy path", () => {
  it("applies the education template end-to-end", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [
          {
            id: "profile-1",
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            industry: "education",
            website_url: "https://devpilot.example",
            value_proposition: "Job-ready DevOps courses.",
          },
        ],
      }, // project_profiles upsert
      { rowCount: 0, rows: [] }, // existing icp_profiles names
      { rowCount: 1, rows: [{ id: "icp-1", name: "Career Switchers", is_primary: true }] },
      { rowCount: 1, rows: [{ id: "icp-2", name: "Recent Graduates", is_primary: false }] },
      { rowCount: 1, rows: [{ id: "icp-3", name: "Upskilling Professionals", is_primary: false }] },
      { rowCount: 0, rows: [] }, // existing rubric by name
      { rowCount: 0, rows: [] }, // existing active rubric
      {
        rowCount: 1,
        rows: [{ id: "rubric-1", name: "Education / Online Academy starter rubric", is_active: true }],
      },
      undefined, // SAVEPOINT onboarding_sequence
      { rowCount: 0, rows: [] }, // existing sequence by name
      { rowCount: 1, rows: [{ id: "seq-1", name: "Education enrollment nurture", is_active: true }] },
      { rowCount: 1, rows: [{ id: "step-1" }] },
      { rowCount: 1, rows: [{ id: "step-2" }] },
      { rowCount: 1, rows: [{ id: "step-3" }] },
      { rowCount: 1, rows: [{ id: "step-4" }] },
      undefined, // RELEASE SAVEPOINT onboarding_sequence
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/apply`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        website: "https://devpilot.example",
        offer: "Job-ready DevOps courses.",
        industryTemplate: "education",
      });

    expect(res.status).toBe(201);
    expect(res.body.profileUpdated).toBe(true);
    expect(res.body.icpProfilesCreated).toHaveLength(3);
    expect(res.body.rubricCreated.name).toBe("Education / Online Academy starter rubric");
    expect(res.body.sequenceCreated).toMatchObject({ id: "seq-1", name: "Education enrollment nurture" });
    expect(res.body.sequenceCreated.steps).toHaveLength(4);
    expect(res.body.notes).toEqual([]);

    const profileUpsertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO project_profiles"),
    );
    expect(profileUpsertCall).toBeDefined();
  });

  it("applies the saas template end-to-end", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: "profile-1", industry: "saas", website_url: "https://acme-saas.example", value_proposition: "Pipeline visibility, automated." }],
      },
      { rowCount: 0, rows: [] }, // existing icp names
      { rowCount: 1, rows: [{ id: "icp-1", name: "Series A-B RevOps Leaders", is_primary: true }] },
      { rowCount: 1, rows: [{ id: "icp-2", name: "IT/Security Evaluators", is_primary: false }] },
      { rowCount: 1, rows: [{ id: "icp-3", name: "Economic Buyer (CRO/CFO)", is_primary: false }] },
      { rowCount: 0, rows: [] }, // existing rubric by name
      { rowCount: 0, rows: [] }, // existing active rubric
      { rowCount: 1, rows: [{ id: "rubric-1", name: "B2B SaaS starter rubric", is_active: true }] },
      undefined, // SAVEPOINT
      { rowCount: 0, rows: [] }, // existing sequence
      { rowCount: 1, rows: [{ id: "seq-1", name: "SaaS outbound sequence", is_active: true }] },
      { rowCount: 1, rows: [{ id: "step-1" }] },
      { rowCount: 1, rows: [{ id: "step-2" }] },
      { rowCount: 1, rows: [{ id: "step-3" }] },
      { rowCount: 1, rows: [{ id: "step-4" }] },
      { rowCount: 1, rows: [{ id: "step-5" }] },
      undefined, // RELEASE SAVEPOINT
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/apply`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        website: "https://acme-saas.example",
        offer: "Pipeline visibility, automated.",
        industryTemplate: "saas",
      });

    expect(res.status).toBe(201);
    expect(res.body.icpProfilesCreated).toHaveLength(3);
    expect(res.body.rubricCreated.name).toBe("B2B SaaS starter rubric");
    expect(res.body.sequenceCreated.steps).toHaveLength(5);
    expect(res.body.notes).toEqual([]);
  });
});

describe("POST /onboarding/apply existing-config guards", () => {
  it("does not deactivate an existing active rubric; creates the new one as inactive and notes it", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "profile-1" }] }, // project_profiles upsert
      { rowCount: 0, rows: [] }, // existing icp names
      { rowCount: 1, rows: [{ id: "icp-1", name: "Career Switchers", is_primary: true }] },
      { rowCount: 1, rows: [{ id: "icp-2", name: "Recent Graduates", is_primary: false }] },
      { rowCount: 1, rows: [{ id: "icp-3", name: "Upskilling Professionals", is_primary: false }] },
      { rowCount: 0, rows: [] }, // existing rubric by this template's name -> none
      { rowCount: 1, rows: [{ id: "rubric-existing", name: "Some other rubric", is_active: true }] }, // an active rubric already exists
      { rowCount: 1, rows: [{ id: "rubric-new", name: "Education / Online Academy starter rubric", is_active: false }] },
      undefined, // SAVEPOINT
      { rowCount: 0, rows: [] }, // existing sequence
      { rowCount: 1, rows: [{ id: "seq-1", name: "Education enrollment nurture", is_active: true }] },
      { rowCount: 1, rows: [{ id: "step-1" }] },
      { rowCount: 1, rows: [{ id: "step-2" }] },
      { rowCount: 1, rows: [{ id: "step-3" }] },
      { rowCount: 1, rows: [{ id: "step-4" }] },
      undefined, // RELEASE SAVEPOINT
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/apply`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        website: "https://devpilot.example",
        offer: "Job-ready DevOps courses.",
        industryTemplate: "education",
      });

    expect(res.status).toBe(201);
    expect(res.body.rubricCreated.is_active).toBe(false);
    expect(res.body.notes).toContain(
      "An active rubric already existed for this project; the new rubric was created as inactive rather than replacing it",
    );

    const rubricInsertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO scoring_rubrics"),
    );
    expect(rubricInsertCall).toBeDefined();
    const insertArgs = rubricInsertCall?.[1] as unknown[];
    expect(insertArgs[insertArgs.length - 1]).toBe(false); // is_active param
  });

  it("gracefully skips sequence creation when the sequences table doesn't exist yet, without failing the request", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "profile-1" }] }, // project_profiles upsert
      { rowCount: 0, rows: [] }, // existing icp names
      { rowCount: 1, rows: [{ id: "icp-1", name: "Career Switchers", is_primary: true }] },
      { rowCount: 1, rows: [{ id: "icp-2", name: "Recent Graduates", is_primary: false }] },
      { rowCount: 1, rows: [{ id: "icp-3", name: "Upskilling Professionals", is_primary: false }] },
      { rowCount: 0, rows: [] }, // existing rubric by name
      { rowCount: 0, rows: [] }, // existing active rubric
      { rowCount: 1, rows: [{ id: "rubric-1", name: "Education / Online Academy starter rubric", is_active: true }] },
    ]);
    queryMock.mockResolvedValueOnce(undefined); // SAVEPOINT onboarding_sequence
    queryMock.mockRejectedValueOnce(
      Object.assign(new Error('relation "sequences" does not exist'), { code: "42P01" }),
    ); // SELECT sequences -> table missing
    queryMock.mockResolvedValueOnce(undefined); // ROLLBACK TO SAVEPOINT onboarding_sequence

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/apply`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        website: "https://devpilot.example",
        offer: "Job-ready DevOps courses.",
        industryTemplate: "education",
      });

    expect(res.status).toBe(201);
    expect(res.body.sequenceCreated).toBeNull();
    expect(res.body.notes).toContain("sequences table not available yet, skipped");
    // the rest of the apply still went through
    expect(res.body.profileUpdated).toBe(true);
    expect(res.body.icpProfilesCreated).toHaveLength(3);
    expect(res.body.rubricCreated.name).toBe("Education / Online Academy starter rubric");

    const rollbackCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("ROLLBACK TO SAVEPOINT"),
    );
    expect(rollbackCall).toBeDefined();
  });

  it("skips re-inserting an ICP profile whose name already exists for the project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: "profile-1" }] }, // project_profiles upsert
      { rowCount: 1, rows: [{ name: "Career Switchers", is_primary: true }] }, // existing icp names: already has one
      { rowCount: 1, rows: [{ id: "icp-2", name: "Recent Graduates", is_primary: false }] },
      { rowCount: 1, rows: [{ id: "icp-3", name: "Upskilling Professionals", is_primary: false }] },
      { rowCount: 0, rows: [] }, // existing rubric by name
      { rowCount: 0, rows: [] }, // existing active rubric
      { rowCount: 1, rows: [{ id: "rubric-1", name: "Education / Online Academy starter rubric", is_active: true }] },
      undefined, // SAVEPOINT
      { rowCount: 0, rows: [] }, // existing sequence
      { rowCount: 1, rows: [{ id: "seq-1", name: "Education enrollment nurture", is_active: true }] },
      { rowCount: 1, rows: [{ id: "step-1" }] },
      { rowCount: 1, rows: [{ id: "step-2" }] },
      { rowCount: 1, rows: [{ id: "step-3" }] },
      { rowCount: 1, rows: [{ id: "step-4" }] },
      undefined, // RELEASE SAVEPOINT
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/onboarding/apply`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        website: "https://devpilot.example",
        offer: "Job-ready DevOps courses.",
        industryTemplate: "education",
      });

    expect(res.status).toBe(201);
    expect(res.body.icpProfilesCreated).toHaveLength(2);
    expect(res.body.notes).toContain('ICP profile "Career Switchers" already existed, skipped');
  });
});
