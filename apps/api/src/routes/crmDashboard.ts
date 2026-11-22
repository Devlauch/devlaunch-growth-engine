import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeCrmDashboard } from "../lib/crmDashboard.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/crm-dashboard
 *
 * CRM module "Dashboard" — pipeline value by stage, deals won/lost this
 * period, upcoming meetings, overdue follow-up tasks, and lead-to-customer
 * conversion rate. See apps/api/src/lib/crmDashboard.ts for the real SQL
 * (and what it reuses from growthRevenueAnalytics.ts rather than
 * recomputing).
 */
export const crmDashboardRouter = Router({ mergeParams: true });
crmDashboardRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /crm-dashboard?sinceDays=30 */
crmDashboardRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const sinceDaysRaw = typeof req.query.sinceDays === "string" ? req.query.sinceDays : undefined;
    const sinceDays = sinceDaysRaw ? z.coerce.number().int().min(1).max(3650).parse(sinceDaysRaw) : undefined;

    const dashboard = await computeCrmDashboard(req.tenantDb!, req.tenantId!, projectId, { sinceDays });
    res.json({ crmDashboard: dashboard });
  } catch (err) {
    next(err);
  }
});
