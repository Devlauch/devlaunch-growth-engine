import type { PoolClient } from "pg";
import { computeGrowthRevenueAnalytics } from "./growthRevenueAnalytics.js";

/**
 * crmDashboard.ts: the CRM module's own "Dashboard" view — pipeline value by
 * stage, deals won/lost this period, upcoming meetings, overdue follow-up
 * tasks, and lead-to-customer conversion rate.
 *
 * This is a READ-ONLY composition over existing tables, same discipline as
 * activityTimeline.ts: nothing here is a new table, nothing is cached.
 * Sales-conversion math (won/lost/open deal counts, win rate,
 * lead-to-deal rate) is NOT recomputed here — it is reused verbatim from
 * growthRevenueAnalytics.ts's computeGrowthRevenueAnalytics(), which already
 * does this exact math for GET /growth-analytics. The pieces that function
 * does NOT compute (per-stage pipeline *value*, which meetings are still
 * upcoming, which follow-up tasks are overdue, and a plain lead-to-customer
 * count/rate) are added here as their own focused queries.
 */

export interface CrmDashboardOptions {
  /** How far back "deals won/lost this period" looks. Default 30. */
  sinceDays?: number;
  /** Max rows returned for upcoming meetings / overdue tasks lists. Default 20. */
  listLimit?: number;
}

export interface PipelineStageSummary {
  stage: string;
  dealCount: number;
  totalValue: number;
}

export interface UpcomingMeetingSummary {
  id: string;
  leadId: string;
  type: string;
  scheduledAt: string;
}

export interface OverdueFollowUpTaskSummary {
  id: string;
  leadId: string;
  taskType: string;
  title: string;
  dueAt: string;
}

export interface CrmDashboard {
  periodDays: number;
  pipelineByStage: PipelineStageSummary[];
  dealsThisPeriod: {
    won: { count: number; totalValue: number };
    lost: { count: number; totalValue: number };
  };
  upcomingMeetings: UpcomingMeetingSummary[];
  overdueFollowUpTasks: OverdueFollowUpTaskSummary[];
  leadToCustomerConversion: {
    totalLeads: number;
    totalCustomers: number;
    rate: number | null;
  };
  /** Reused verbatim from growthRevenueAnalytics.ts — see this file's header comment. */
  salesConversion: Awaited<ReturnType<typeof computeGrowthRevenueAnalytics>>["salesConversion"];
}

export async function computeCrmDashboard(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  opts: CrmDashboardOptions = {},
): Promise<CrmDashboard> {
  const periodDays = opts.sinceDays ?? 30;
  const listLimit = opts.listLimit ?? 20;

  // Reuse, don't duplicate: salesConversion (won/lost/open counts, win rate,
  // lead-to-deal rate) and leadQualification.totalLeads come straight from
  // the existing growth/revenue analytics composition.
  const growth = await computeGrowthRevenueAnalytics(tenantDb, tenantId, projectId, { sinceDays: periodDays });

  const pipelineResult = await tenantDb.query<{ stage: string; deal_count: number; total_value: string | null }>(
    `SELECT stage, count(*)::int AS deal_count, COALESCE(sum(value_amount), 0)::numeric AS total_value
     FROM deals
     WHERE tenant_id = $1 AND project_id = $2
     GROUP BY stage
     ORDER BY stage`,
    [tenantId, projectId],
  );
  const pipelineByStage: PipelineStageSummary[] = pipelineResult.rows.map((r) => ({
    stage: r.stage,
    dealCount: r.deal_count,
    totalValue: Number(r.total_value ?? 0),
  }));

  const dealsPeriodResult = await tenantDb.query<{ stage: string; count: number; total_value: string | null }>(
    `SELECT stage, count(*)::int AS count, COALESCE(sum(value_amount), 0)::numeric AS total_value
     FROM deals
     WHERE tenant_id = $1 AND project_id = $2
       AND stage IN ('won', 'lost')
       AND stage_changed_at >= now() - ($3 * interval '1 day')
     GROUP BY stage`,
    [tenantId, projectId, periodDays],
  );
  const periodMap = new Map(dealsPeriodResult.rows.map((r) => [r.stage, { count: r.count, totalValue: Number(r.total_value ?? 0) }]));

  const upcomingMeetingsResult = await tenantDb.query<{
    id: string;
    lead_id: string;
    type: string;
    scheduled_at: string;
  }>(
    `SELECT id, lead_id, type, scheduled_at
     FROM meetings
     WHERE tenant_id = $1 AND project_id = $2
       AND status = 'scheduled' AND scheduled_at >= now()
     ORDER BY scheduled_at ASC
     LIMIT $3`,
    [tenantId, projectId, listLimit],
  );

  const overdueTasksResult = await tenantDb.query<{
    id: string;
    lead_id: string;
    task_type: string;
    title: string;
    due_at: string;
  }>(
    `SELECT id, lead_id, task_type, title, due_at
     FROM crm_tasks
     WHERE tenant_id = $1 AND project_id = $2
       AND status = 'open' AND due_at IS NOT NULL AND due_at < now()
     ORDER BY due_at ASC
     LIMIT $3`,
    [tenantId, projectId, listLimit],
  );

  const customersResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM customers WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  const totalCustomers = customersResult.rows[0]?.count ?? 0;
  const totalLeads = growth.leadQualification.totalLeads;

  return {
    periodDays,
    pipelineByStage,
    dealsThisPeriod: {
      won: periodMap.get("won") ?? { count: 0, totalValue: 0 },
      lost: periodMap.get("lost") ?? { count: 0, totalValue: 0 },
    },
    upcomingMeetings: upcomingMeetingsResult.rows.map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      type: r.type,
      scheduledAt: r.scheduled_at,
    })),
    overdueFollowUpTasks: overdueTasksResult.rows.map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      taskType: r.task_type,
      title: r.title,
      dueAt: r.due_at,
    })),
    leadToCustomerConversion: {
      totalLeads,
      totalCustomers,
      rate: totalLeads > 0 ? totalCustomers / totalLeads : null,
    },
    salesConversion: growth.salesConversion,
  };
}
