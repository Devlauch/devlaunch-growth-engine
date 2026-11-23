import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeRevenueIntelligence } from "../lib/revenueIntelligence.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/revenue-intelligence
 *
 * Phase 7, Revenue Intelligence — the real, missing final rollup connecting
 * campaigns (both outbound `campaigns` and discovery `prospecting_campaigns`)
 * -> qualified leads -> meetings booked -> deals won -> real recorded
 * revenue -> CAC -> ROI, per campaign. See
 * apps/api/src/lib/revenueIntelligence.ts for exactly which existing
 * modules this composes (campaignAttribution's member join,
 * prospectingCampaigns' discovered-org provenance join) and the one new
 * thing it adds (the per-campaign revenue/CAC/ROI rollup itself, reusing
 * growthRevenueAnalytics.ts's computeCacRoi honest-math helper verbatim).
 *
 * NOTE: like campaignAttributionRouter and growthAnalyticsRouter, this
 * router is intentionally not wired into app.ts here (file boundaries for
 * this task excluded app.ts) — mount it the same way, at the path above.
 */
export const revenueIntelligenceRouter = Router({ mergeParams: true });
revenueIntelligenceRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/revenue-intelligence */
revenueIntelligenceRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const revenueIntelligence = await computeRevenueIntelligence(req.tenantDb!, req.tenantId!, projectId);
    res.json({ revenueIntelligence });
  } catch (err) {
    next(err);
  }
});
