import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { startWorkflow, advanceWorkflow } from "../workflow/engine.js";

/**
 * Phase 4 orchestration API. Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/workflows (wiring into
 * app.ts is left to the orchestrator session, not done here).
 *
 * Every route here runs inside the request-scoped transaction opened by
 * requireTenantMembership (req.tenantDb), same convention as
 * routes/onboarding.ts and routes/icpProfiles.ts.
 */
export const workflowsRouter = Router({ mergeParams: true });
workflowsRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

// Loose by design — the orchestration pipeline's first stage adapts
// whatever subset of these is supplied (see
// apps/api/src/workflow/stageRegistry.ts's runClientOnboardingStage).
const startWorkflowSchema = z.object({
  industry: z.string().trim().max(100).optional(),
  targetAudience: z.string().trim().max(2000).optional(),
  budget: z.union([z.string().trim().max(200), z.number()]).optional(),
  goals: z.union([z.array(z.string().trim().max(500)).max(50), z.string().trim().max(2000)]).optional(),
  website: z.string().trim().max(2000).optional(),
});

/** POST /workflows — starts a new workflow run and executes its first stage. */
workflowsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = startWorkflowSchema.parse(req.body ?? {});

    const { workflowRun, stageResult } = await startWorkflow(req.tenantDb!, req.tenantId!, projectId, body);
    res.status(201).json({ workflowRun, stageResult });
  } catch (err) {
    next(err);
  }
});

/** GET /workflows — lists all workflow runs for this project. */
workflowsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM workflow_runs WHERE project_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [projectId, req.tenantId],
    );
    res.json({ workflowRuns: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /workflows/:id — the run plus its full stage-result history, in order. */
workflowsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const workflowRunId = paramId(req, "id");

    const runResult = await req.tenantDb!.query(
      `SELECT * FROM workflow_runs WHERE id = $1 AND project_id = $2 AND tenant_id = $3`,
      [workflowRunId, projectId, req.tenantId],
    );
    if (runResult.rowCount === 0) throw Errors.notFound("Workflow run not found");

    const stageResultsResult = await req.tenantDb!.query(
      `SELECT * FROM workflow_stage_results WHERE workflow_run_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [workflowRunId, req.tenantId],
    );

    res.json({ workflowRun: runResult.rows[0], stageResults: stageResultsResult.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /workflows/:id/advance — runs exactly one more stage attempt. The
 * one endpoint a human (or future scheduler) calls repeatedly to drive the
 * pipeline forward; also the endpoint that re-runs the approval gate after
 * a human has approved pending drafts elsewhere in the app.
 */
workflowsRouter.post("/:id/advance", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const workflowRunId = paramId(req, "id");

    const { workflowRun, stageResult } = await advanceWorkflow(req.tenantDb!, req.tenantId!, workflowRunId);
    res.json({ workflowRun, stageResult });
  } catch (err) {
    next(err);
  }
});
