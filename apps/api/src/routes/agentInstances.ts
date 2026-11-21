import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

export const agentInstancesRouter = Router({ mergeParams: true });
agentInstancesRouter.use(requireAuth, requireTenantMembership);

const createInstanceSchema = z.object({
  templateId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  config: z.record(z.string(), z.unknown()).optional(),
  schedule: z.string().trim().max(200).optional(),
});

async function assertProjectInTenant(req: import("express").Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/agent-instances */
agentInstancesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ai.id, ai.name, ai.status, ai.config, ai.schedule, ai.last_run_at, ai.created_at,
              at.key AS agent_key, at.version AS agent_version
       FROM agent_instances ai JOIN agent_templates at ON at.id = ai.template_id
       WHERE ai.project_id = $1 AND ai.tenant_id = $2
       ORDER BY ai.created_at ASC`,
      [projectId, req.tenantId],
    );
    res.json({ agentInstances: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/agent-instances */
agentInstancesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);
    const body = createInstanceSchema.parse(req.body);

    // Template must be visible (global, tenant_id IS NULL, or this
    // tenant's own) under the agent_templates RLS policy, which is already
    // in effect here since this handler runs inside requireTenantMembership's
    // tenant-scoped transaction.
    const template = await req.tenantDb!.query("SELECT id FROM agent_templates WHERE id = $1 AND is_active = true", [
      body.templateId,
    ]);
    if (template.rowCount === 0) {
      throw Errors.badRequest("Unknown or inactive templateId");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO agent_instances (tenant_id, project_id, template_id, name, config, schedule, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING id, name, status, config, schedule, created_at`,
      [req.tenantId, projectId, body.templateId, body.name, JSON.stringify(body.config ?? {}), body.schedule ?? null, req.userId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'agent_instance.created', 'agent_instance', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id],
    );

    res.status(201).json({ agentInstance: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
