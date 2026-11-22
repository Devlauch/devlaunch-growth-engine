import type { PoolClient } from "pg";
import { Errors } from "../lib/httpError.js";
import { getStageExecutor, stageRegistry as defaultStageRegistry } from "./stageRegistry.js";
import { WORKFLOW_STAGES, type StageExecutor, type StageResult, type WorkflowStage } from "./types.js";

export interface WorkflowRunRow {
  id: string;
  tenant_id: string;
  project_id: string;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  current_stage: WorkflowStage;
  input_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkflowStageResultRow {
  id: string;
  tenant_id: string;
  workflow_run_id: string;
  stage: WorkflowStage;
  status: "completed" | "failed" | "needs_approval";
  summary: string;
  data: Record<string, unknown>;
  approval_context: { entityType: string; entityIds: string[] } | null;
  started_at: string;
  completed_at: string;
  created_at: string;
}

/** Test-only hook: lets tests swap in fake StageExecutors without touching the real registry. */
type StageRegistryOverride = Partial<Record<WorkflowStage, StageExecutor>>;

function resolveExecutor(stage: WorkflowStage, registryOverride?: StageRegistryOverride): StageExecutor {
  if (registryOverride && registryOverride[stage]) {
    return registryOverride[stage]!;
  }
  if (registryOverride) {
    // An override was supplied (test mode) but doesn't cover this stage —
    // fall back to whatever's in the default registry rather than silently
    // using production executors for some stages and not others being a
    // surprise; still goes through getStageExecutor's NotImplemented path.
    return defaultStageRegistry[stage] ?? getStageExecutor(stage);
  }
  return getStageExecutor(stage);
}

function nextStage(stage: WorkflowStage): WorkflowStage | null {
  const idx = WORKFLOW_STAGES.indexOf(stage);
  if (idx === -1 || idx === WORKFLOW_STAGES.length - 1) return null;
  return WORKFLOW_STAGES[idx + 1];
}

async function loadRun(tenantDb: PoolClient, tenantId: string, workflowRunId: string): Promise<WorkflowRunRow> {
  const result = await tenantDb.query(
    `SELECT * FROM workflow_runs WHERE id = $1 AND tenant_id = $2`,
    [workflowRunId, tenantId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Workflow run not found");
  return result.rows[0] as WorkflowRunRow;
}

async function loadPriorStageResults(
  tenantDb: PoolClient,
  workflowRunId: string,
): Promise<Record<string, { data: Record<string, unknown>; summary: string }>> {
  // Most recent attempt per stage — workflow_stage_results keeps every
  // attempt (a stage can re-run, e.g. the approval gate after a human
  // approves drafts), so later stages should only see the latest one.
  const result = await tenantDb.query(
    `SELECT DISTINCT ON (stage) stage, data, summary
     FROM workflow_stage_results
     WHERE workflow_run_id = $1
     ORDER BY stage, created_at DESC`,
    [workflowRunId],
  );
  const out: Record<string, { data: Record<string, unknown>; summary: string }> = {};
  for (const row of result.rows as { stage: string; data: Record<string, unknown>; summary: string }[]) {
    out[row.stage] = { data: row.data, summary: row.summary };
  }
  return out;
}

async function insertStageResult(
  tenantDb: PoolClient,
  tenantId: string,
  workflowRunId: string,
  stage: WorkflowStage,
  result: Pick<StageResult, "status" | "summary" | "data" | "approvalContext">,
  startedAt: Date,
): Promise<WorkflowStageResultRow> {
  const inserted = await tenantDb.query(
    `INSERT INTO workflow_stage_results
       (tenant_id, workflow_run_id, stage, status, summary, data, approval_context, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, now())
     RETURNING *`,
    [
      tenantId,
      workflowRunId,
      stage,
      result.status,
      result.summary,
      JSON.stringify(result.data ?? {}),
      result.approvalContext ? JSON.stringify(result.approvalContext) : null,
      startedAt.toISOString(),
    ],
  );
  return inserted.rows[0] as WorkflowStageResultRow;
}

/**
 * Runs exactly one stage attempt for `workflowRunId` (whatever
 * current_stage currently is) and updates the run's status/current_stage
 * accordingly. Never throws for a stage-level failure — a thrown error
 * from the stage executor is caught, recorded as a 'failed' stage result,
 * and the run itself is marked 'failed'. Only truly unexpected conditions
 * (run not found, DB connectivity) propagate.
 *
 * `registryOverride` is test-only: production callers (routes/workflows.ts)
 * never pass it, so they always go through the real stageRegistry.
 */
export async function advanceWorkflow(
  tenantDb: PoolClient,
  tenantId: string,
  workflowRunId: string,
  registryOverride?: StageRegistryOverride,
): Promise<{ workflowRun: WorkflowRunRow; stageResult: WorkflowStageResultRow | null }> {
  const run = await loadRun(tenantDb, tenantId, workflowRunId);

  if (run.status === "completed" || run.status === "failed") {
    // Idempotent no-op: a terminal run never re-runs a stage.
    return { workflowRun: run, stageResult: null };
  }

  const stage = run.current_stage;
  const startedAt = new Date();

  let stageResult: StageResult;
  try {
    const executor = resolveExecutor(stage, registryOverride);
    stageResult = await executor({
      tenantId,
      projectId: run.project_id,
      workflowRunId,
      tenantDb,
      priorStageResults: await loadPriorStageResults(tenantDb, workflowRunId),
      inputConfig: run.input_config,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedRow = await insertStageResult(
      tenantDb,
      tenantId,
      workflowRunId,
      stage,
      { status: "failed", summary: `Stage "${stage}" failed: ${message}`, data: { error: message } },
      startedAt,
    );
    const updatedRun = await tenantDb.query(
      `UPDATE workflow_runs SET status = 'failed' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [workflowRunId, tenantId],
    );
    return { workflowRun: updatedRun.rows[0] as WorkflowRunRow, stageResult: failedRow };
  }

  const resultRow = await insertStageResult(
    tenantDb,
    tenantId,
    workflowRunId,
    stage,
    {
      status: stageResult.status,
      summary: stageResult.summary,
      data: stageResult.data,
      approvalContext: stageResult.approvalContext,
    },
    startedAt,
  );

  let updatedRun: WorkflowRunRow;
  if (stageResult.status === "needs_approval") {
    // current_stage stays unchanged so a later advance re-runs this same stage.
    const updated = await tenantDb.query(
      `UPDATE workflow_runs SET status = 'awaiting_approval' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [workflowRunId, tenantId],
    );
    updatedRun = updated.rows[0] as WorkflowRunRow;
  } else if (stageResult.status === "failed") {
    const updated = await tenantDb.query(
      `UPDATE workflow_runs SET status = 'failed' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [workflowRunId, tenantId],
    );
    updatedRun = updated.rows[0] as WorkflowRunRow;
  } else {
    // completed
    const next = nextStage(stage);
    if (next) {
      const updated = await tenantDb.query(
        `UPDATE workflow_runs SET status = 'running', current_stage = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [workflowRunId, tenantId, next],
      );
      updatedRun = updated.rows[0] as WorkflowRunRow;
    } else {
      const updated = await tenantDb.query(
        `UPDATE workflow_runs SET status = 'completed', completed_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [workflowRunId, tenantId],
      );
      updatedRun = updated.rows[0] as WorkflowRunRow;
    }
  }

  return { workflowRun: updatedRun, stageResult: resultRow };
}

/**
 * Inserts a new workflow_runs row (status 'running', current_stage
 * 'client_onboarding') and immediately runs the first stage attempt via
 * advanceWorkflow.
 */
export async function startWorkflow(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  inputConfig: Record<string, unknown>,
  registryOverride?: StageRegistryOverride,
): Promise<{ workflowRun: WorkflowRunRow; stageResult: WorkflowStageResultRow | null }> {
  const inserted = await tenantDb.query(
    `INSERT INTO workflow_runs (tenant_id, project_id, status, current_stage, input_config)
     VALUES ($1, $2, 'running', 'client_onboarding', $3::jsonb)
     RETURNING *`,
    [tenantId, projectId, JSON.stringify(inputConfig ?? {})],
  );
  const run = inserted.rows[0] as WorkflowRunRow;
  return advanceWorkflow(tenantDb, tenantId, run.id, registryOverride);
}
