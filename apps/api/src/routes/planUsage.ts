import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { PLAN_LIMITS, PLAN_NAMES } from "../config/planLimits.js";
import { getQuotaUsage, QUOTA_RESOURCES } from "../lib/quota.js";
import { applyPlanChange } from "../lib/billingPlanSync.js";

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
    // Sequential, not Promise.all: these all share one pooled client
    // (req.tenantDb), which processes one query at a time regardless —
    // firing them "concurrently" only risks confusing interleaving with no
    // real parallelism benefit.
    const usages = [];
    for (const resource of QUOTA_RESOURCES) {
      usages.push(await getQuotaUsage(req.tenantDb!, req.tenantId as string, resource));
    }
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
 * payment provider, or process any real billing event of any kind by
 * itself — it simply updates the tenant's `plan` column, standing in for
 * whatever out-of-band manual process (an invoice, a signed contract, a
 * support ticket) actually moved the tenant to a new plan, OR for an
 * admin's manual override of what a real billing-provider webhook already
 * set (see routes/billingWebhooks.ts, Milestone 4) — this manual path
 * remains available and unchanged as a fallback/override, it is not
 * replaced by billing-provider automation. Never present this as
 * "processing a payment".
 *
 * Shares its actual plan-write + audit-trail logic with the
 * webhook-driven path via applyPlanChange() (lib/billingPlanSync.ts) —
 * extracted additively out of what used to be inline here; same SQL, same
 * params, same behavior as before.
 */
planRouter.patch("/", async (req, res, next) => {
  try {
    requireRole(req, ["owner"]);
    const body = patchPlanSchema.parse(req.body);

    const tenant = await applyPlanChange(req.tenantDb!, req.tenantId as string, body.plan, {
      type: "user",
      userId: req.userId as string,
    });

    res.json({ tenant });
  } catch (err) {
    next(err);
  }
});
