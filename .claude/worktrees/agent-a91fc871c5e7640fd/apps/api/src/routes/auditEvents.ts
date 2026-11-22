import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";

export const auditEventsRouter = Router({ mergeParams: true });
auditEventsRouter.use(requireAuth, requireTenantMembership);

/**
 * GET /api/v1/tenants/:tenantId/audit-events
 *
 * Paginated, and filterable by action / entity_type (exact match) in
 * addition to the existing `source` filter (metadata->>'source'), which
 * backs the dashboard's Audit Log page (apps/dashboard/src/pages/AuditLogPage.tsx).
 */
auditEventsRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const action = typeof req.query.action === "string" ? req.query.action : undefined;
    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;

    const result = await req.tenantDb!.query(
      `SELECT id, actor_type, actor_user_id, actor_agent_instance_id, action, entity_type, entity_id, metadata, created_at
       FROM audit_events
       WHERE tenant_id = $1
         AND ($2::text IS NULL OR metadata->>'source' = $2)
         AND ($3::text IS NULL OR action = $3)
         AND ($4::text IS NULL OR entity_type = $4)
       ORDER BY created_at DESC
       LIMIT $5 OFFSET $6`,
      [req.tenantId, source ?? null, action ?? null, entityType ?? null, limit, offset],
    );
    res.json({ auditEvents: result.rows, limit, offset });
  } catch (err) {
    next(err);
  }
});
