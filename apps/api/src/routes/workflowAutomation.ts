import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { runWorkflow } from "../lib/workflowEngine.js";

/**
 * workflowAutomationRouter: NOT mounted in app.ts by this change (file
 * boundaries for this task excluded app.ts — see this task's report for
 * the exact mount line to add). Intended mount path:
 *
 *   /api/v1/tenants/:tenantId/projects/:projectId/workflow-automation
 *
 * CRUD over workflow_definitions (packages/db/migrations/
 * 610_create_workflow_definitions.sql) plus:
 *   - POST   /:id/run        — fires this definition immediately (an
 *     'event'-style manual trigger, useful for testing a definition before
 *     relying on its scheduled/condition trigger, or for a genuinely
 *     event-triggered definition with no poller of its own).
 *   - GET    /:id/executions                — this definition's execution
 *     history (workflow_executions), newest first.
 *   - GET    /:id/executions/:executionId    — one execution's full
 *     per-node step history (workflow_execution_steps).
 *
 * Deliberately a SEPARATE router/path from the existing workflowsRouter
 * (mounted at .../workflows — the Phase 4 autonomous agent pipeline,
 * apps/api/src/workflow/) — these are two unrelated concepts (see
 * workflowEngine.ts's header comment), kept apart on purpose.
 */
export const workflowAutomationRouter = Router({ mergeParams: true });
workflowAutomationRouter.use(requireAuth, requireTenantMembership);

const TRIGGER_TYPES = ["scheduled", "condition", "event"] as const;
const NODE_TYPES = ["condition", "action"] as const;
const DEFINITION_STATUSES = ["active", "paused", "draft"] as const;

const nodeSchema = z.object({
  key: z.string().trim().min(1).max(100),
  type: z.enum(NODE_TYPES),
  config: z.record(z.unknown()),
  next: z.string().trim().min(1).max(100).nullish(),
  onTrue: z.string().trim().min(1).max(100).nullish(),
  onFalse: z.string().trim().min(1).max(100).nullish(),
});

const createDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  triggerType: z.enum(TRIGGER_TYPES),
  triggerConfig: z.record(z.unknown()).optional(),
  nodes: z.array(nodeSchema).max(100),
  status: z.enum(DEFINITION_STATUSES).optional(),
});

const updateDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  triggerType: z.enum(TRIGGER_TYPES).optional(),
  triggerConfig: z.record(z.unknown()).optional(),
  nodes: z.array(nodeSchema).max(100).optional(),
  status: z.enum(DEFINITION_STATUSES).optional(),
});

const runSchema = z.object({
  leadId: z.string().uuid().optional(),
  triggerPayload: z.record(z.unknown()).optional(),
});

const DEFINITION_COLUMNS = `id, tenant_id, project_id, name, trigger_type, trigger_config, nodes, status, created_at, updated_at`;
const EXECUTION_COLUMNS = `id, tenant_id, project_id, workflow_id, status, trigger_payload, dedupe_key, error, started_at, finished_at, created_at`;
const STEP_COLUMNS = `id, tenant_id, execution_id, node_key, status, input, output, started_at, finished_at, created_at`;

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string): Promise<void> {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [projectId, tenantId]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadDefinitionOr404(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  definitionId: string,
) {
  const result = await tenantDb.query(
    `SELECT ${DEFINITION_COLUMNS} FROM workflow_definitions WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [definitionId, tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Workflow definition not found");
  return result.rows[0];
}

// GET / — list every workflow_definitions row for this project.
workflowAutomationRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const result = await req.tenantDb!.query(
      `SELECT ${DEFINITION_COLUMNS} FROM workflow_definitions WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [tenantId, projectId],
    );
    res.json({ workflowDefinitions: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST / — create a new workflow_definitions row.
workflowAutomationRouter.post("/", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const parsed = createDefinitionSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest("Invalid workflow definition", parsed.error.flatten());
    const { name, triggerType, triggerConfig, nodes, status } = parsed.data;

    const result = await req.tenantDb!.query(
      `INSERT INTO workflow_definitions (tenant_id, project_id, name, trigger_type, trigger_config, nodes, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING ${DEFINITION_COLUMNS}`,
      [
        tenantId,
        projectId,
        name,
        triggerType,
        JSON.stringify(triggerConfig ?? {}),
        JSON.stringify(nodes),
        status ?? "active",
      ],
    );
    res.status(201).json({ workflowDefinition: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /:definitionId — one workflow_definitions row.
workflowAutomationRouter.get("/:definitionId", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId, definitionId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const definition = await loadDefinitionOr404(req.tenantDb!, tenantId, projectId, definitionId);
    res.json({ workflowDefinition: definition });
  } catch (err) {
    next(err);
  }
});

// PATCH /:definitionId — partial update.
workflowAutomationRouter.patch("/:definitionId", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId, definitionId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    await loadDefinitionOr404(req.tenantDb!, tenantId, projectId, definitionId);
    const parsed = updateDefinitionSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest("Invalid workflow definition update", parsed.error.flatten());
    const { name, triggerType, triggerConfig, nodes, status } = parsed.data;

    const result = await req.tenantDb!.query(
      `UPDATE workflow_definitions SET
         name = COALESCE($3, name),
         trigger_type = COALESCE($4, trigger_type),
         trigger_config = COALESCE($5::jsonb, trigger_config),
         nodes = COALESCE($6::jsonb, nodes),
         status = COALESCE($7, status)
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${DEFINITION_COLUMNS}`,
      [
        definitionId,
        tenantId,
        name ?? null,
        triggerType ?? null,
        triggerConfig !== undefined ? JSON.stringify(triggerConfig) : null,
        nodes !== undefined ? JSON.stringify(nodes) : null,
        status ?? null,
      ],
    );
    res.json({ workflowDefinition: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /:definitionId
workflowAutomationRouter.delete("/:definitionId", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId, definitionId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    await loadDefinitionOr404(req.tenantDb!, tenantId, projectId, definitionId);
    await req.tenantDb!.query(`DELETE FROM workflow_definitions WHERE id = $1 AND tenant_id = $2`, [definitionId, tenantId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /:definitionId/run — manual/event trigger via the real engine (apps/api/src/lib/workflowEngine.ts).
workflowAutomationRouter.post("/:definitionId/run", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId, definitionId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    await loadDefinitionOr404(req.tenantDb!, tenantId, projectId, definitionId);
    const parsed = runSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw Errors.badRequest("Invalid run request", parsed.error.flatten());
    const { leadId, triggerPayload } = parsed.data;

    const executionId = await runWorkflow(
      definitionId,
      { triggerType: "manual", triggeredByUserId: req.userId, ...(triggerPayload ?? {}) },
      { tenantDb: req.tenantDb!, tenantId, projectId, leadId },
    );
    res.status(202).json({ executionId });
  } catch (err) {
    next(err);
  }
});

// GET /:definitionId/executions — execution history, newest first.
workflowAutomationRouter.get("/:definitionId/executions", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId, definitionId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    await loadDefinitionOr404(req.tenantDb!, tenantId, projectId, definitionId);
    const result = await req.tenantDb!.query(
      `SELECT ${EXECUTION_COLUMNS} FROM workflow_executions WHERE workflow_id = $1 AND tenant_id = $2 ORDER BY started_at DESC LIMIT 200`,
      [definitionId, tenantId],
    );
    res.json({ executions: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /:definitionId/executions/:executionId — one execution's full per-node step history.
workflowAutomationRouter.get("/:definitionId/executions/:executionId", async (req, res, next) => {
  try {
    const tenantId = req.tenantId!;
    const { projectId, definitionId, executionId } = req.params as Record<string, string>;
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    await loadDefinitionOr404(req.tenantDb!, tenantId, projectId, definitionId);

    const execResult = await req.tenantDb!.query(
      `SELECT ${EXECUTION_COLUMNS} FROM workflow_executions WHERE id = $1 AND workflow_id = $2 AND tenant_id = $3`,
      [executionId, definitionId, tenantId],
    );
    if (execResult.rowCount === 0) throw Errors.notFound("Workflow execution not found");

    const stepsResult = await req.tenantDb!.query(
      `SELECT ${STEP_COLUMNS} FROM workflow_execution_steps WHERE execution_id = $1 AND tenant_id = $2 ORDER BY started_at ASC`,
      [executionId, tenantId],
    );
    res.json({ execution: execResult.rows[0], steps: stepsResult.rows });
  } catch (err) {
    next(err);
  }
});
