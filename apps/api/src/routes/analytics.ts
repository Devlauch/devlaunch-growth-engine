import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/analytics
 *
 * Adapts the written spec's `GET /api/v1/analytics/overview` to this
 * codebase's tenant/project-scoped route convention (see
 * docs/API_DEVIATIONS.md for why every route here carries :tenantId —
 * requireTenantMembership is the single place that decides "does this
 * request get to act as this tenant", and it needs :tenantId in the path
 * to run before anything else does).
 *
 * Every number returned here is a real SQL aggregate against existing
 * tables (leads, campaigns, agent_executions) for this tenant+project —
 * nothing is fabricated or estimated. An empty category comes back as an
 * empty array/zero count; the dashboard renders the existing EmptyState
 * for that, never a placeholder chart.
 */
export const analyticsRouter = Router({ mergeParams: true });
analyticsRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/analytics/overview */
analyticsRouter.get("/overview", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const [leadsTotal, leadsByStatus, campaignsByStatus, executionsByStatus, leadsPerDay] = await Promise.all([
      req.tenantDb!.query(`SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2`, [
        req.tenantId,
        projectId,
      ]),
      req.tenantDb!.query(
        `SELECT status, count(*)::int AS count
         FROM leads
         WHERE tenant_id = $1 AND project_id = $2
         GROUP BY status
         ORDER BY status`,
        [req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT status, count(*)::int AS count
         FROM campaigns
         WHERE tenant_id = $1 AND project_id = $2
         GROUP BY status
         ORDER BY status`,
        [req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT ae.status, count(*)::int AS count
         FROM agent_executions ae
         JOIN agent_instances ai ON ai.id = ae.agent_instance_id
         WHERE ae.tenant_id = $1 AND ai.project_id = $2
         GROUP BY ae.status
         ORDER BY ae.status`,
        [req.tenantId, projectId],
      ),
      req.tenantDb!.query(
        `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS count
         FROM leads
         WHERE tenant_id = $1 AND project_id = $2 AND created_at >= now() - interval '30 days'
         GROUP BY day
         ORDER BY day`,
        [req.tenantId, projectId],
      ),
    ]);

    res.json({
      leads: {
        total: leadsTotal.rows[0]?.count ?? 0,
        byStatus: leadsByStatus.rows,
        perDay: leadsPerDay.rows,
      },
      campaigns: {
        byStatus: campaignsByStatus.rows,
      },
      agentExecutions: {
        byStatus: executionsByStatus.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});
