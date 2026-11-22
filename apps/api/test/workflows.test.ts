import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts / onboarding.test.ts: fake the
// pg pool for the route-level (HTTP) tests.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { workflowsRouter } = await import("../src/routes/workflows.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const engine = await import("../src/workflow/engine.js");

// Same fake-PoolClient style as workflowApprovalAndExecutionStage.test.ts:
// engine.ts functions take a PoolClient directly, so for the
// stage-to-stage progression / pause-resume / failure / completion tests
// below we call them directly rather than through express+supertest, and
// inject stub StageExecutors via the (test-only) registryOverride param
// instead of exercising the real client_onboarding SQL each time.
function makeDirectQueryMock(responses: unknown[]) {
  const m = vi.fn();
  for (const r of responses) m.mockResolvedValueOnce(r);
  return m;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/workflows", workflowsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const RUN_1 = "44444444-4444-4444-4444-444444444444";
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
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

function workflowRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_1,
    tenant_id: TENANT_A,
    project_id: PROJECT_1,
    status: "running",
    current_stage: "client_onboarding",
    input_config: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("POST /workflows — starts a run and executes client_onboarding for real", () => {
  it("creates a workflow_runs row and applies the saas template via the real industryTemplates-based stage", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [workflowRunRow()] }, // INSERT workflow_runs
      { rowCount: 1, rows: [workflowRunRow()] }, // loadRun (inside advanceWorkflow)
      { rowCount: 0, rows: [] }, // loadPriorStageResults -> none yet
      // --- runClientOnboardingStage's real queries ---
      {
        rowCount: 1,
        rows: [{ id: "profile-1", industry: "saas", website_url: null, value_proposition: "x" }],
      }, // project_profiles upsert
      { rowCount: 0, rows: [] }, // existing icp names
      { rowCount: 1, rows: [{ id: "icp-1", name: "Series A-B RevOps Leaders", is_primary: true }] },
      { rowCount: 1, rows: [{ id: "icp-2", name: "IT/Security Evaluators", is_primary: false }] },
      { rowCount: 1, rows: [{ id: "icp-3", name: "Economic Buyer (CRO/CFO)", is_primary: false }] },
      { rowCount: 0, rows: [] }, // existing rubric by name
      { rowCount: 0, rows: [] }, // existing active rubric
      { rowCount: 1, rows: [{ id: "rubric-1", name: "B2B SaaS starter rubric", is_active: true }] },
      undefined, // SAVEPOINT workflow_onboarding_sequence
      { rowCount: 0, rows: [] }, // existing sequence
      { rowCount: 1, rows: [{ id: "seq-1", name: "SaaS outbound sequence", is_active: true }] },
      { rowCount: 1, rows: [{ id: "step-1" }] },
      { rowCount: 1, rows: [{ id: "step-2" }] },
      { rowCount: 1, rows: [{ id: "step-3" }] },
      { rowCount: 1, rows: [{ id: "step-4" }] },
      { rowCount: 1, rows: [{ id: "step-5" }] },
      undefined, // RELEASE SAVEPOINT
      // --- back in advanceWorkflow ---
      { rowCount: 1, rows: [{ id: "stage-result-1", stage: "client_onboarding", status: "completed" }] }, // INSERT workflow_stage_results
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "research" })] }, // UPDATE workflow_runs -> running/research
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/workflows`)
      .set("X-Dev-User-Id", USER_1)
      .send({ industry: "saas", targetAudience: "RevOps leaders", budget: "$5k/mo", goals: ["more pipeline"] });

    expect(res.status).toBe(201);
    expect(res.body.workflowRun.current_stage).toBe("research");
    expect(res.body.stageResult.status).toBe("completed");

    const profileInsertCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO project_profiles"),
    );
    expect(profileInsertCall).toBeDefined();
  });
});

describe("GET /workflows and GET /workflows/:id", () => {
  it("lists runs for the project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [workflowRunRow()] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/workflows`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.workflowRuns).toHaveLength(1);
  });

  it("returns the run plus its full stage-result history", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [workflowRunRow()] }, // run lookup
      { rowCount: 1, rows: [{ id: "sr-1", stage: "client_onboarding", status: "completed" }] }, // stage results
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/workflows/${RUN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.workflowRun.id).toBe(RUN_1);
    expect(res.body.stageResults).toHaveLength(1);
  });

  it("404s when the run doesn't belong to this project/tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // run not found
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/workflows/${RUN_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("engine.advanceWorkflow — stage-to-stage progression (direct, stubbed executors)", () => {
  function stubResult(stage: string, status: "completed" | "failed" | "needs_approval" = "completed") {
    return {
      stage,
      status,
      summary: `${stage} done`,
      data: { ran: stage },
    };
  }

  it("advances through two consecutive stages, moving current_stage forward each time", async () => {
    const dbQuery = makeDirectQueryMock([
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "research" })] }, // loadRun
      { rowCount: 1, rows: [{ stage: "client_onboarding", data: {}, summary: "onboarding done" }] }, // priorStageResults
      { rowCount: 1, rows: [{ id: "sr-research" }] }, // insert stage result
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "lead_generation" })] }, // update run
    ]);
    const tenantDb = { query: dbQuery } as any;
    const researchExecutor = vi.fn(async () => stubResult("research"));

    const { workflowRun, stageResult } = await engine.advanceWorkflow(tenantDb, TENANT_A, RUN_1, {
      research: researchExecutor,
    });

    expect(researchExecutor).toHaveBeenCalledTimes(1);
    expect(workflowRun.current_stage).toBe("lead_generation");
    expect(stageResult?.id).toBe("sr-research");
  });

  it("needs_approval pauses the run on the same stage, and a later advance re-runs that same stage", async () => {
    const executor = vi.fn(async () => stubResult("content_campaign", "needs_approval"));

    const dbQuery1 = makeDirectQueryMock([
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "content_campaign", status: "running" })] }, // loadRun
      { rowCount: 0, rows: [] }, // priorStageResults
      { rowCount: 1, rows: [{ id: "sr-1" }] }, // insert stage result
      {
        rowCount: 1,
        rows: [workflowRunRow({ current_stage: "content_campaign", status: "awaiting_approval" })],
      }, // update run -> awaiting_approval
    ]);
    const tenantDb1 = { query: dbQuery1 } as any;

    const first = await engine.advanceWorkflow(tenantDb1, TENANT_A, RUN_1, { content_campaign: executor });
    expect(first.workflowRun.status).toBe("awaiting_approval");
    expect(first.workflowRun.current_stage).toBe("content_campaign");

    // Second advance: loadRun now reports awaiting_approval/content_campaign
    // (not completed/failed), so it is NOT a no-op — it re-runs the same stage.
    const dbQuery2 = makeDirectQueryMock([
      {
        rowCount: 1,
        rows: [workflowRunRow({ current_stage: "content_campaign", status: "awaiting_approval" })],
      }, // loadRun
      { rowCount: 1, rows: [{ stage: "client_onboarding", data: {}, summary: "ok" }] }, // priorStageResults
      { rowCount: 1, rows: [{ id: "sr-2" }] }, // insert stage result
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "approval_compliance_gate", status: "running" })] }, // update run -> next stage
    ]);
    const tenantDb2 = { query: dbQuery2 } as any;
    const executor2 = vi.fn(async () => stubResult("content_campaign", "completed"));

    const second = await engine.advanceWorkflow(tenantDb2, TENANT_A, RUN_1, { content_campaign: executor2 });
    expect(executor2).toHaveBeenCalledTimes(1);
    expect(second.workflowRun.current_stage).toBe("approval_compliance_gate");
  });

  it("records a failed stage result and marks the run failed without throwing/crashing", async () => {
    const dbQuery = makeDirectQueryMock([
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "research" })] }, // loadRun
      { rowCount: 0, rows: [] }, // priorStageResults
      { rowCount: 1, rows: [{ id: "sr-failed", status: "failed" }] }, // insert failed stage result
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "research", status: "failed" })] }, // update run -> failed
    ]);
    const tenantDb = { query: dbQuery } as any;
    const throwingExecutor = vi.fn(async () => {
      throw new Error("crawl timed out");
    });

    const { workflowRun, stageResult } = await engine.advanceWorkflow(tenantDb, TENANT_A, RUN_1, {
      research: throwingExecutor,
    });

    expect(workflowRun.status).toBe("failed");
    expect(stageResult?.status).toBe("failed");

    // Terminal: a second advance on a failed run is a no-op, no executor call.
    const dbQuery2 = makeDirectQueryMock([
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "research", status: "failed" })] }, // loadRun
    ]);
    const tenantDb2 = { query: dbQuery2 } as any;
    const neverCalled = vi.fn();
    const noop = await engine.advanceWorkflow(tenantDb2, TENANT_A, RUN_1, { research: neverCalled });
    expect(neverCalled).not.toHaveBeenCalled();
    expect(noop.stageResult).toBeNull();
  });

  it("transitions to the terminal 'completed' status after the last stage (analytics_learning)", async () => {
    const dbQuery = makeDirectQueryMock([
      { rowCount: 1, rows: [workflowRunRow({ current_stage: "analytics_learning" })] }, // loadRun
      { rowCount: 0, rows: [] }, // priorStageResults
      { rowCount: 1, rows: [{ id: "sr-final" }] }, // insert stage result
      {
        rowCount: 1,
        rows: [
          workflowRunRow({
            current_stage: "analytics_learning",
            status: "completed",
            completed_at: "2026-01-02T00:00:00.000Z",
          }),
        ],
      }, // update run -> completed
    ]);
    const tenantDb = { query: dbQuery } as any;
    const executor = vi.fn(async () => stubResult("analytics_learning", "completed"));

    const { workflowRun } = await engine.advanceWorkflow(tenantDb, TENANT_A, RUN_1, {
      analytics_learning: executor,
    });

    expect(workflowRun.status).toBe("completed");
    expect(workflowRun.completed_at).not.toBeNull();
  });
});
