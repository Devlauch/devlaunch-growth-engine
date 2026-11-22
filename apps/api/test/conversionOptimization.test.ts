import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts / learningLoop.test.ts: fake the
// pg pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { conversionOptimizationRouter, experimentsRouter } = await import("../src/routes/conversionOptimization.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { auditLandingPage } = await import("../src/lib/landingPageAudit.js");
const { computeFunnelDropoff, computeDropoffPercent } = await import("../src/lib/funnelDropoff.js");
const { generateExperimentSuggestions } = await import("../src/lib/experimentSuggestions.js");

// conversionOptimizationRouter and experimentsRouter are the SAME Router
// instance (see conversionOptimization.ts) — mounting it once below is
// correct and mirrors how the real app.ts wiring must mount it (mounting
// the same instance twice at an identical path would run requireAuth/
// requireTenantMembership, and open a pooled transaction, twice per
// request).

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/conversion-optimization", conversionOptimizationRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const EXPERIMENT_1 = "55555555-5555-5555-5555-555555555555";
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

const projectRow = { rowCount: 1, rows: [{ "?column?": 1 }] };

function undefinedTableError(): Error & { code: string } {
  const err = new Error('relation "some_table" does not exist') as Error & { code: string };
  err.code = "42P01";
  return err;
}

/* ---------------------------------------------------------------------- */
/* landingPageAudit.ts: CTA / form / counts / findings                     */
/* ---------------------------------------------------------------------- */

describe("auditLandingPage", () => {
  function fakeFetch(html: string, ok = true, status = 200) {
    return vi.fn(async () => ({
      ok,
      status,
      text: async () => html,
    })) as unknown as typeof fetch;
  }

  it("detects a CTA, a form, word count, and heading count on a healthy page", async () => {
    const html = `
      <html><body>
        <h1>Welcome</h1>
        <h2>Why us</h2>
        <p>${"word ".repeat(60)}</p>
        <form><input /></form>
        <a href="/signup">Sign Up</a>
      </body></html>`;
    const result = await auditLandingPage("https://example.com", { fetchImpl: fakeFetch(html) });

    expect(result.loadStatus).toBe("ok");
    expect(result.hasCta).toBe(true);
    expect(result.hasForm).toBe(true);
    expect(result.headingCount).toBe(2);
    expect(result.wordCount).toBeGreaterThan(50);
    expect(result.findings).toEqual([]);
  });

  it("flags no_cta_detected and no_conversion_path when neither a CTA nor a form is present", async () => {
    const html = `<html><body><h1>Title</h1><p>${"word ".repeat(60)}</p></body></html>`;
    const result = await auditLandingPage("https://example.com", { fetchImpl: fakeFetch(html) });

    expect(result.hasCta).toBe(false);
    expect(result.hasForm).toBe(false);
    const issues = result.findings.map((f) => f.issue);
    expect(issues).toContain("no_cta_detected");
    expect(issues).toContain("no_conversion_path");
  });

  it("flags thin_content and no_headings on a sparse page", async () => {
    const html = `<html><body><p>Hi</p><form></form></body></html>`;
    const result = await auditLandingPage("https://example.com", { fetchImpl: fakeFetch(html) });

    const issues = result.findings.map((f) => f.issue);
    expect(issues).toContain("thin_content");
    expect(issues).toContain("no_headings");
    expect(issues).not.toContain("no_conversion_path"); // has a form, even if no CTA copy
  });

  it("degrades to loadStatus 'error' on a non-2xx response, without throwing", async () => {
    const result = await auditLandingPage("https://example.com", { fetchImpl: fakeFetch("", false, 500) });
    expect(result.loadStatus).toBe("error");
    expect(result.hasCta).toBe(false);
    expect(result.wordCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("degrades to loadStatus 'timeout' on an AbortError, without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;

    const result = await auditLandingPage("https://example.com", { fetchImpl });
    expect(result.loadStatus).toBe("timeout");
  });

  it("degrades to loadStatus 'error' on a generic network failure, without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;

    const result = await auditLandingPage("https://example.com", { fetchImpl });
    expect(result.loadStatus).toBe("error");
  });
});

/* ---------------------------------------------------------------------- */
/* funnelDropoff.ts: math + degradation                                    */
/* ---------------------------------------------------------------------- */

describe("computeDropoffPercent", () => {
  it("computes a real percentage drop between two stages", () => {
    expect(computeDropoffPercent(100, 25)).toBe(75);
  });

  it("guards against division by zero when the source stage is empty", () => {
    expect(computeDropoffPercent(0, 0)).toBe(0);
  });

  it("returns 0 (not negative) only when counts are equal, and a negative number if a stage somehow grows", () => {
    expect(computeDropoffPercent(10, 10)).toBe(0);
    expect(computeDropoffPercent(10, 20)).toBe(-100);
  });
});

describe("computeFunnelDropoff", () => {
  function makeTenantDb(responses: unknown[]) {
    const q = vi.fn();
    for (const r of responses) {
      if (r instanceof Error) q.mockRejectedValueOnce(r);
      else q.mockResolvedValueOnce(r);
    }
    q.mockResolvedValue(undefined); // SAVEPOINT/RELEASE no-ops beyond the queued list
    return { query: q } as unknown as import("pg").PoolClient;
  }

  it("computes real stage counts and drop-off percentages when all tables exist", async () => {
    const tenantDb = makeTenantDb([
      undefined, // SAVEPOINT discovered
      { rows: [{ count: 100 }] }, // discovered_organizations
      undefined, // RELEASE
      undefined, // SAVEPOINT qualified
      { rows: [{ count: 40 }] }, // qualified
      undefined, // RELEASE
      undefined, // SAVEPOINT contacted
      { rows: [{ count: 20 }] }, // contacted
      undefined, // RELEASE
      undefined, // SAVEPOINT replied
      { rows: [{ count: 5 }] }, // replied
      undefined, // RELEASE
    ]);

    const result = await computeFunnelDropoff(tenantDb, TENANT_A, PROJECT_1);

    expect(result.stages).toEqual([
      { stage: "discovered", count: 100 },
      { stage: "qualified", count: 40 },
      { stage: "contacted", count: 20 },
      { stage: "replied", count: 5 },
    ]);
    expect(result.dropoffs).toEqual([
      { fromStage: "discovered", toStage: "qualified", dropoffPercent: 60 },
      { fromStage: "qualified", toStage: "contacted", dropoffPercent: 50 },
      { fromStage: "contacted", toStage: "replied", dropoffPercent: 75 },
    ]);
  });

  it("degrades gracefully when a dependent table is missing, reporting an honest zero via SAVEPOINT rollback", async () => {
    const tenantDb = makeTenantDb([
      undefined, // SAVEPOINT discovered
      undefinedTableError(), // discovered_organizations missing
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      undefined, // SAVEPOINT qualified
      undefinedTableError(), // lead_scores missing
      undefined, // ROLLBACK TO SAVEPOINT
      undefined, // RELEASE SAVEPOINT
      { rows: [{ count: 3 }] }, // fallback: leads.status = 'qualified' only
      undefined, // SAVEPOINT contacted
      { rows: [{ count: 0 }] }, // contacted
      undefined, // RELEASE
      undefined, // SAVEPOINT replied
      { rows: [{ count: 0 }] }, // replied
      undefined, // RELEASE
    ]);

    const result = await computeFunnelDropoff(tenantDb, TENANT_A, PROJECT_1);

    expect(result.stages[0]).toEqual({ stage: "discovered", count: 0 });
    expect(result.stages[1]).toEqual({ stage: "qualified", count: 3 });
    // discovered -> qualified: fromCount 0 guards div-by-zero -> 0, not NaN/Infinity.
    expect(result.dropoffs[0].dropoffPercent).toBe(0);
  });

  it("re-throws a non-missing-table error instead of silently degrading", async () => {
    const tenantDb = makeTenantDb([
      undefined, // SAVEPOINT discovered
      new Error("connection reset"), // unrelated real error
    ]);

    await expect(computeFunnelDropoff(tenantDb, TENANT_A, PROJECT_1)).rejects.toThrow("connection reset");
  });
});

/* ---------------------------------------------------------------------- */
/* experimentSuggestions.ts: input-driven generation                       */
/* ---------------------------------------------------------------------- */

describe("generateExperimentSuggestions", () => {
  it("suggests a CTA experiment from a no_cta_detected finding", () => {
    const suggestions = generateExperimentSuggestions(
      [{ issue: "no_cta_detected", detail: "no CTA copy found", severity: "high" }],
      { stages: [], dropoffs: [] },
    );

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].name.toLowerCase()).toContain("call-to-action");
    expect(suggestions[0].hypothesis).toContain("no CTA copy found");
  });

  it("suggests a funnel-stage experiment from a notable drop-off", () => {
    const suggestions = generateExperimentSuggestions([], {
      stages: [
        { stage: "discovered", count: 100 },
        { stage: "qualified", count: 10 },
      ],
      dropoffs: [{ fromStage: "discovered", toStage: "qualified", dropoffPercent: 90 }],
    });

    expect(suggestions.length).toBe(1);
    expect(suggestions[0].name).toContain("discovered-to-qualified");
    expect(suggestions[0].hypothesis).toContain("90.0%");
  });

  it("returns an empty array when there is nothing notable (clean audit, low drop-off)", () => {
    const suggestions = generateExperimentSuggestions([], {
      stages: [
        { stage: "discovered", count: 100 },
        { stage: "qualified", count: 90 },
      ],
      dropoffs: [{ fromStage: "discovered", toStage: "qualified", dropoffPercent: 10 }],
    });

    expect(suggestions).toEqual([]);
  });
});

/* ---------------------------------------------------------------------- */
/* Routes: experiments CRUD + results aggregation                          */
/* ---------------------------------------------------------------------- */

describe("experiments CRUD", () => {
  it("creates an experiment with status 'suggested'", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      {
        rowCount: 1,
        rows: [
          {
            id: EXPERIMENT_1,
            name: "Add a CTA",
            hypothesis: "h",
            variant_a_description: "a",
            variant_b_description: "b",
            status: "suggested",
          },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Add a CTA", hypothesis: "h", variantADescription: "a", variantBDescription: "b" });

    expect(res.status).toBe(201);
    expect(res.body.experiment.status).toBe("suggested");
  });

  it("rejects creating an experiment missing a required field", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), projectRow]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments`)
      .set("X-Dev-User-Id", USER_1)
      .send({ name: "Missing fields" });

    expect(res.status).toBe(400);
  });

  it("allows suggested -> running, setting started_at", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "suggested" }] }, // loadExperimentOr404
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "running", started_at: new Date().toISOString() }] }, // UPDATE
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments/${EXPERIMENT_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "running" });

    expect(res.status).toBe(200);
    expect(res.body.experiment.status).toBe("running");
  });

  it("rejects an invalid status transition (suggested -> completed) with 409", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "suggested" }] },
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments/${EXPERIMENT_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "completed" });

    expect(res.status).toBe(409);
  });

  it("rejects a transition out of a terminal status (completed -> running) with 409", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "completed" }] },
    ]);

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments/${EXPERIMENT_1}`)
      .set("X-Dev-User-Id", USER_1)
      .send({ status: "running" });

    expect(res.status).toBe(409);
  });
});

describe("experiment results recording + aggregation", () => {
  it("rejects recording a result where conversions exceed visitors (validated before hitting the DB)", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "running" }] }, // loadExperimentOr404
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments/${EXPERIMENT_1}/results`)
      .set("X-Dev-User-Id", USER_1)
      .send({ variant: "a", visitors: 5, conversions: 10 });

    expect(res.status).toBe(400);
    // Never reached the INSERT.
    const insertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO experiment_results"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("records a valid result", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "running" }] },
      {
        rowCount: 1,
        rows: [{ id: "res-1", experiment_id: EXPERIMENT_1, variant: "a", visitors: 50, conversions: 5 }],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments/${EXPERIMENT_1}/results`)
      .set("X-Dev-User-Id", USER_1)
      .send({ variant: "a", visitors: 50, conversions: 5 });

    expect(res.status).toBe(201);
    expect(res.body.result.variant).toBe("a");
  });

  it("reports 'not enough data yet' when a variant is under the minimum sample size", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "running" }] }, // loadExperimentOr404
      {
        rowCount: 2,
        rows: [
          { variant: "a", total_visitors: "10", total_conversions: "2" }, // below 20 threshold
          { variant: "b", total_visitors: "30", total_conversions: "9" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments/${EXPERIMENT_1}/results`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.winner).toBeNull();
    expect(res.body.note).toBe("not enough data yet");
  });

  it("declares a real winner once both variants clear the minimum sample size", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rowCount: 1, rows: [{ id: EXPERIMENT_1, status: "running" }] },
      {
        rowCount: 2,
        rows: [
          { variant: "a", total_visitors: "100", total_conversions: "10" }, // 10%
          { variant: "b", total_visitors: "100", total_conversions: "25" }, // 25%
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments/${EXPERIMENT_1}/results`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.winner).toBe("b");
    expect(res.body.note).toBeNull();
  });
});

describe("router wiring", () => {
  it("exports conversionOptimizationRouter and experimentsRouter as the same Router instance", () => {
    expect(conversionOptimizationRouter).toBe(experimentsRouter);
  });
});

describe("tenant isolation", () => {
  it("denies GET /experiments when the caller has no active membership in the requested tenant", async () => {
    const app = buildApp();
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/conversion-optimization/experiments`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(403);
  });
});
