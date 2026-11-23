import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeSiteAnalytics } from "../lib/siteAnalytics.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/site-analytics
 * (app.ts is off-limits this round — see this feature's handback for the
 * exact mount line, same convention as growthAnalyticsRouter).
 *
 * Milestone 2 (P1): real website-traffic numbers — unique visitors,
 * sessions, pageviews, a bounce-rate-style ratio, top referrers, top
 * landing pages — composed from the new site_visitors/site_sessions/
 * site_pageviews tables (see apps/api/src/lib/siteAnalytics.ts for the real
 * SQL behind every number, including the bot-exclusion logic). A separate,
 * new route from growthAnalytics.ts (kept untouched/out of scope this
 * round) — see this feature's handback for how the two relate.
 */
export const siteAnalyticsRouter = Router({ mergeParams: true });
siteAnalyticsRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /site-analytics?sinceDays=30 */
siteAnalyticsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const sinceDaysRaw = typeof req.query.sinceDays === "string" ? req.query.sinceDays : undefined;
    const sinceDays = sinceDaysRaw ? z.coerce.number().int().min(1).max(3650).parse(sinceDaysRaw) : undefined;

    const analytics = await computeSiteAnalytics(req.tenantDb!, req.tenantId!, projectId, { sinceDays });
    res.json({ siteAnalytics: analytics });
  } catch (err) {
    next(err);
  }
});
