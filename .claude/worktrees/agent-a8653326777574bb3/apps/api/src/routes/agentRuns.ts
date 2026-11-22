import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { enforceQuota } from "../lib/quota.js";
import { enqueueAgentRun } from "../lib/queue.js";
import type { AgentRunResult } from "@devlaunch/agent-sdk";
import { logger } from "../lib/logger.js";

export const agentRunsRouter = Router({ mergeParams: true });
agentRunsRouter.use(requireAuth, requireTenantMembership);

const createRunSchema = z.object({
  agentInstanceId: z.string().uuid(),
  input: z.unknown(),
  idempotencyKey: z.string().trim().max(200).optional(),
});

/**
 * POST /api/v1/tenants/:tenantId/projects/:projectId/agent-runs
 *
 * Creates an agent_executions row (status: queued), enqueues it onto the
 * worker's Redis/BullMQ queue, and returns an AgentRunResult. Poll
 * GET /api/v1/tenants/:tenantId/agent-executions/:executionId (or the
 * project-scoped list) to see it progress to running -> succeeded/failed.
 */
agentRunsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const body = createRunSchema.parse(req.body);

    const instance = await req.tenantDb!.query(
      `SELECT ai.id, ai.status, at.key AS agent_key
       FROM agent_instances ai JOIN agent_templates at ON at.id = ai.template_id
       WHERE ai.id = $1 AND ai.project_id = $2 AND ai.tenant_id = $3`,
      [body.agentInstanceId, projectId, req.tenantId],
    );
    if (instance.rowCount === 0) {
      throw Errors.notFound("Agent instance not found");
    }
    const agentInstance = instance.rows[0];
    if (agentInstance.status !== "active") {
      throw Errors.badRequest(`Agent instance is ${agentInstance.status}, not active`);
    }

    // Idempotency: if a key is given and an execution already exists for
    // it (stashed in input._idempotencyKey), return that one instead of
    // creating a duplicate run.
    if (body.idempotencyKey) {
      const existing = await req.tenantDb!.query(
        `SELECT id, status FROM agent_executions
         WHERE tenant_id = $1 AND agent_instance_id = $2 AND input->>'_idempotencyKey' = $3`,
        [req.tenantId, body.agentInstanceId, body.idempotencyKey],
      );
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0];
        const result: AgentRunResult = { executionId: row.id, status: row.status };
        res.status(200).json(result);
        return;
      }
    }

    // Subscription-plan quota enforcement: a real COUNT(*) of today's agent
    // runs for this tenant, checked before creating one more. Deliberately
    // after the idempotency-key lookup above, so retrying an already-queued
    // run via the same idempotencyKey never gets blocked by a quota that
    // run itself already counts against.
    await enforceQuota(req.tenantDb!, req.tenantId as string, "agentRunsPerDay");

    const inputWithKey = {
      ...(typeof body.input === "object" && body.input !== null ? (body.input as Record<string, unknown>) : { value: body.input }),
      ...(body.idempotencyKey ? { _idempotencyKey: body.idempotencyKey } : {}),
    };

    const execution = await req.tenantDb!.query(
      `INSERT INTO agent_executions (tenant_id, agent_instance_id, status, trigger, input)
       VALUES ($1, $2, 'queued', 'api', $3::jsonb)
       RETURNING id`,
      [req.tenantId, body.agentInstanceId, JSON.stringify(inputWithKey)],
    );
    const executionId = execution.rows[0].id;

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'agent_execution.queued', 'agent_execution', $3, $4::jsonb)`,
      [req.tenantId, req.userId, executionId, JSON.stringify({ agentKey: agentInstance.agent_key })],
    );

    try {
      await enqueueAgentRun({
        executionId,
        tenantId: req.tenantId as string,
        projectId,
        agentId: agentInstance.agent_key,
        input: body.input,
      });
    } catch (err) {
      logger.error({ err, executionId }, "failed to enqueue agent run; marking execution failed");
      await req.tenantDb!.query(
        `UPDATE agent_executions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [executionId, "Failed to enqueue job"],
      );
      const result: AgentRunResult = {
        executionId,
        status: "failed",
        error: { code: "enqueue_failed", message: "Failed to enqueue agent run" },
      };
      res.status(502).json(result);
      return;
    }

    const result: AgentRunResult = { executionId, status: "queued" };
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});
