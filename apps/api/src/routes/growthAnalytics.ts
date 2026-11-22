import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeGrowthRevenueAnalytics } from "../lib/growthRevenueAnalytics.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/growth-analytics
 *
 * Roadmap item 7, "Growth/Revenue Analytics" — composes website traffic,
 * lead source attribution, lead qualification, meetings booked, sales
 * conversion rate, and customer acquisition cost/ROI into one endpoint. See
 * apps/api/src/lib/growthRevenueAnalytics.ts for the real SQL behind every
 * number here (nothing fabricated: CAC/ROI honestly report
 * "not_available" rather than a guessed figure when spend/deal data is
 * missing).
 */
export const growthAnalyticsRouter = Router({ mergeParams: true });
growthAnalyticsRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /growth-analytics?sinceDays=30 */
growthAnalyticsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const sinceDaysRaw = typeof req.query.sinceDays === "string" ? req.query.sinceDays : undefined;
    const sinceDays = sinceDaysRaw ? z.coerce.number().int().min(1).max(3650).parse(sinceDaysRaw) : undefined;

    const analytics = await computeGrowthRevenueAnalytics(req.tenantDb!, req.tenantId!, projectId, { sinceDays });
    res.json({ growthAnalytics: analytics });
  } catch (err) {
    next(err);
  }
});
