import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/agent-executions */
export const projectAgentExecutionsRouter = Router({ mergeParams: true });
projectAgentExecutionsRouter.use(requireAuth, requireTenantMembership);

projectAgentExecutionsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const result = await req.tenantDb!.query(
      `SELECT e.id, e.status, e.trigger, e.input, e.output, e.error, e.started_at, e.finished_at, e.created_at,
              ai.id AS agent_instance_id, ai.name AS agent_instance_name
       FROM agent_executions e
       JOIN agent_instances ai ON ai.id = e.agent_instance_id
       WHERE e.tenant_id = $1 AND ai.project_id = $2
       ORDER BY e.created_at DESC
       LIMIT 100`,
      [req.tenantId, projectId],
    );
    res.json({ agentExecutions: result.rows });
  } catch (err) {
    next(err);
  }
});

/** Mounted at /api/v1/tenants/:tenantId/agent-executions/:executionId */
export const tenantAgentExecutionRouter = Router({ mergeParams: true });
tenantAgentExecutionRouter.use(requireAuth, requireTenantMembership);

tenantAgentExecutionRouter.get("/:executionId", async (req, res, next) => {
  try {
    const executionId = z.string().uuid().parse(req.params.executionId);
    const result = await req.tenantDb!.query(
      `SELECT id, agent_instance_id, status, trigger, input, output, error, started_at, finished_at, created_at
       FROM agent_executions WHERE id = $1 AND tenant_id = $2`,
      [executionId, req.tenantId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Execution not found");

    const row = result.rows[0];
    res.json({
      executionId: row.id,
      status: row.status,
      result: row.status === "succeeded" ? row.output : undefined,
      error: row.status === "failed" && row.error ? { code: "execution_failed", message: row.error } : undefined,
      agentInstanceId: row.agent_instance_id,
      trigger: row.trigger,
      input: row.input,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});
