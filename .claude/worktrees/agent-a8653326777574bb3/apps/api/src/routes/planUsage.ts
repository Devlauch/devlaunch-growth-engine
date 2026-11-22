import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { PLAN_LIMITS, PLAN_NAMES } from "../config/planLimits.js";
import { getQuotaUsage, QUOTA_RESOURCES } from "../lib/quota.js";

export const planRouter = Router({ mergeParams: true });
planRouter.use(requireAuth, requireTenantMembership);

// Same local owner/admin-membership-role gate used by routes/memberships.ts
// (there's no shared RBAC helper in this codebase yet).
//
// TODO(rbac): replace with the shared requireRole/RBAC middleware once the
// parallel RBAC work lands — this duplicate is intentional until then.
function requireRole(req: Request, allowed: readonly string[]) {
  if (!req.membershipRole || !allowed.includes(req.membershipRole)) {
    throw Errors.forbidden(`Requires one of role: ${allowed.join(", ")}`);
  }
}

/**
 * GET /api/v1/tenants/:tenantId/plan
 *
 * Returns the tenant's current plan, that plan's limits, and real current
 * usage counts (each a COUNT(*) query — see src/lib/quota.ts) against each
 * limit. Never fabricates a usage number.
 */
planRouter.get("/", async (req, res, next) => {
  try {
    const usages = await Promise.all(
      QUOTA_RESOURCES.map((resource) => getQuotaUsage(req.tenantDb!, req.tenantId as string, resource)),
    );
    const plan = usages[0]!.plan;

    res.json({
      plan,
      limits: PLAN_LIMITS[plan],
      usage: Object.fromEntries(usages.map((u) => [u.resource, { current: u.current, limit: u.limit }])),
    });
  } catch (err) {
    next(err);
  }
});

const patchPlanSchema = z.object({
  plan: z.enum(PLAN_NAMES),
});

/**
 * PATCH /api/v1/tenants/:tenantId/plan — owner-only.
 *
 * MANUAL / ADMIN ACTION ONLY. This endpoint does not charge a card, call a
 * payment provider, or process any real billing event of any kind — there
 * is no payment integration anywhere in this codebase. It simply updates
 * the tenant's `plan` column, standing in for whatever out-of-band manual
 * process (an invoice, a signed contract, a support ticket) actually moved
 * the tenant to a new plan. Never present this as "processing a payment".
 */
planRouter.patch("/", async (req, res, next) => {
  try {
    requireRole(req, ["owner"]);
    const body = patchPlanSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE tenants SET plan = $2 WHERE id = $1 RETURNING id, slug, name, plan`,
      [req.tenantId, body.plan],
    );
    if (result.rowCount === 0) throw Errors.notFound("Tenant not found");

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'tenant.plan_changed', 'tenant', $1, $3::jsonb)`,
      [req.tenantId, req.userId, JSON.stringify({ newPlan: body.plan })],
    );

    res.json({ tenant: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
