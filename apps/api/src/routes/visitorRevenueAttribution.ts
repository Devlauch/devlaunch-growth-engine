import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeVisitorRevenueAttribution } from "../lib/visitorRevenueAttribution.js";

/**
 * Intended mount point: /api/v1/tenants/:tenantId/projects/:projectId/visitor-attribution
 *
 * The closing hop of the attribution chain — extends
 * apps/api/src/lib/revenueIntelligence.ts (per-CAMPAIGN qualified-leads ->
 * meetings -> deals won -> revenue -> CAC -> ROI) one step further back, to
 * the anonymous WEBSITE VISITOR who started the journey: first-touch
 * channel (UTM source/medium/campaign, or landing page when no UTM was
 * captured) -> visitors -> leads -> deals won -> real revenue -> CAC/ROI
 * against recorded acquisition_costs. See
 * apps/api/src/lib/visitorRevenueAttribution.ts for exactly which existing
 * tables/modules this composes and the one new rollup it adds.
 *
 * NOT wired into app.ts by this change (same file-boundary convention
 * revenueIntelligenceRouter's own comment documents) — mount it the same
 * way, at the path above, in a separate reconciliation pass.
 */
export const visitorRevenueAttributionRouter = Router({ mergeParams: true });
visitorRevenueAttributionRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/visitor-attribution */
visitorRevenueAttributionRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const visitorRevenueAttribution = await computeVisitorRevenueAttribution(req.tenantDb!, req.tenantId!, projectId);
    res.json({ visitorRevenueAttribution });
  } catch (err) {
    next(err);
  }
});
