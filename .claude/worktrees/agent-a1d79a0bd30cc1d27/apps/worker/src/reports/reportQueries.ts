import type { PoolClient } from "pg";

/**
 * Real SQL aggregates for a generated client report. Mirrors the exact
 * query style/shape of apps/api/src/routes/analytics.ts's GET /overview
 * (leads/campaigns/agent_executions, grouped by status, scoped to
 * tenant_id + project_id) — nothing here is estimated, sampled, or
 * invented. The only addition beyond /overview is a period-scoped "new
 * leads" count (leads created within [periodStart, periodEnd)), since a
 * client report is inherently about a time window.
 */
export interface ReportStatusCount {
  status: string;
  count: number;
}

export interface ReportData {
  leadsTotal: number;
  leadsByStatus: ReportStatusCount[];
  newLeadsInPeriod: number;
  campaignsByStatus: ReportStatusCount[];
  agentExecutionsByStatus: ReportStatusCount[];
}

export async function loadReportData(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ReportData> {
  const [leadsTotal, leadsByStatus, newLeads, campaignsByStatus, executionsByStatus] = await Promise.all([
    tenantDb.query(`SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2`, [
      tenantId,
      projectId,
    ]),
    tenantDb.query(
      `SELECT status, count(*)::int AS count
       FROM leads
       WHERE tenant_id = $1 AND project_id = $2
       GROUP BY status
       ORDER BY status`,
      [tenantId, projectId],
    ),
    tenantDb.query(
      `SELECT count(*)::int AS count
       FROM leads
       WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3 AND created_at < $4`,
      [tenantId, projectId, periodStart.toISOString(), periodEnd.toISOString()],
    ),
    tenantDb.query(
      `SELECT status, count(*)::int AS count
       FROM campaigns
       WHERE tenant_id = $1 AND project_id = $2
       GROUP BY status
       ORDER BY status`,
      [tenantId, projectId],
    ),
    tenantDb.query(
      `SELECT ae.status, count(*)::int AS count
       FROM agent_executions ae
       JOIN agent_instances ai ON ai.id = ae.agent_instance_id
       WHERE ae.tenant_id = $1 AND ai.project_id = $2
       GROUP BY ae.status
       ORDER BY ae.status`,
      [tenantId, projectId],
    ),
  ]);

  return {
    leadsTotal: leadsTotal.rows[0]?.count ?? 0,
    leadsByStatus: leadsByStatus.rows,
    newLeadsInPeriod: newLeads.rows[0]?.count ?? 0,
    campaignsByStatus: campaignsByStatus.rows,
    agentExecutionsByStatus: executionsByStatus.rows,
  };
}
