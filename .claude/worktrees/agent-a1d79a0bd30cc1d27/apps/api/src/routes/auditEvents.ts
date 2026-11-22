import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";

export const auditEventsRouter = Router({ mergeParams: true });
auditEventsRouter.use(requireAuth, requireTenantMembership);

/** GET /api/v1/tenants/:tenantId/audit-events */
auditEventsRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const source = typeof req.query.source === "string" ? req.query.source : undefined;

    const result = await req.tenantDb!.query(
      `SELECT id, actor_type, actor_user_id, actor_agent_instance_id, action, entity_type, entity_id, metadata, created_at
       FROM audit_events
       WHERE tenant_id = $1 AND ($2::text IS NULL OR metadata->>'source' = $2)
       ORDER BY created_at DESC
       LIMIT $3`,
      [req.tenantId, source ?? null, limit],
    );
    res.json({ auditEvents: result.rows });
  } catch (err) {
    next(err);
  }
});
