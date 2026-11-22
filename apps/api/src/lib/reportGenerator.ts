/**
 * reportGenerator: Phase 2 item 6 ("Marketing Intelligence Agent") —
 * "Generate weekly and monthly reports." Computes a real summary of a
 * project's marketing activity for a given period window, using the same
 * kind of real aggregate SQL as apps/api/src/routes/analytics.ts's
 * /overview and /funnel endpoints (query logic duplicated here rather than
 * imported, same precedent as apps/api/src/lib/scoreLead.ts duplicating
 * apps/worker/src/agents/leadScoring.ts — these are read-only SELECTs,
 * cheap to duplicate, and analytics.ts is a route file this module must
 * not import from).
 *
 * Every field in the returned ReportData is either a real number computed
 * from real rows, or an honest `null`/"no data yet" — never a fabricated
 * figure. Tables owned by other, parallel roadmap items (lead_scores,
 * discovered_organizations, message_drafts, lead_replies) may not exist yet
 * in every environment; each of those is queried via pgOptional.ts's
 * runOptional (same SAVEPOINT-catch-42P01 convention as analytics.ts's
 * /funnel and learningLoop.ts), degrading that one field honestly instead
 * of failing report generation. leads and campaigns are this app's oldest
 * tables and are never treated as optional.
 */

import { runOptional, firstCount } from "./pgOptional.js";

export type ReportPeriodType = "weekly" | "monthly";

export interface ReportData {
  periodType: ReportPeriodType;
  periodStart: string; // ISO date (YYYY-MM-DD)
  periodEnd: string; // ISO date (YYYY-MM-DD), inclusive
  leads: {
    newCount: number;
    byStatus: Array<{ status: string; count: number }>;
    bySource: Array<{ source: string; count: number }>;
  };
  campaigns: {
    created: number;
    approved: number;
  };
  averageLeadScore: number | null;
  averageLeadScoreNote?: string;
  funnel: {
    discoveredOrganizations: { count: number; note?: string };
    qualified: { count: number };
    contacted: { count: number; note?: string };
    replied: { count: number; note?: string };
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Computes the inclusive period end date for a report window.
 *   - weekly: periodStart + 6 days (a 7-day window)
 *   - monthly: the last day of periodStart's calendar month (regardless of
 *     what day-of-month periodStart falls on — a report starting mid-month
 *     still ends on that month's last day, documented behavior, not a bug)
 */
export function computePeriodEnd(periodType: ReportPeriodType, periodStart: Date): Date {
  const end = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()),
  );
  if (periodType === "weekly") {
    end.setUTCDate(end.getUTCDate() + 6);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0); // last day of the (now-previous) month
  }
  return end;
}

const QUALIFIED_SCORE_THRESHOLD = 50;

export async function generateReport(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  periodType: ReportPeriodType,
  periodStart: Date,
): Promise<ReportData> {
  const periodEnd = computePeriodEnd(periodType, periodStart);
  // Exclusive upper bound for created_at/updated_at range queries: the day
  // after periodEnd, at midnight UTC.
  const endExclusive = new Date(periodEnd.getTime() + 24 * 60 * 60 * 1000);
  const startIso = periodStart.toISOString();
  const endExclusiveIso = endExclusive.toISOString();

  const newLeadsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3 AND created_at < $4`,
    [tenantId, projectId, startIso, endExclusiveIso],
  );

  const byStatusResult = await tenantDb.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3 AND created_at < $4
     GROUP BY status ORDER BY status`,
    [tenantId, projectId, startIso, endExclusiveIso],
  );

  const bySourceResult = await tenantDb.query<{ source: string; count: number }>(
    `SELECT source, count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3 AND created_at < $4
     GROUP BY source ORDER BY source`,
    [tenantId, projectId, startIso, endExclusiveIso],
  );

  const campaignsCreatedResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM campaigns
     WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3 AND created_at < $4`,
    [tenantId, projectId, startIso, endExclusiveIso],
  );

  // No `approved_at` column exists on campaigns (see 020_create_campaigns.sql)
  // — updated_at is the closest real signal of "became approved during this
  // window", documented assumption rather than a silent guess.
  const campaignsApprovedResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM campaigns
     WHERE tenant_id = $1 AND project_id = $2 AND status = 'approved'
       AND updated_at >= $3 AND updated_at < $4`,
    [tenantId, projectId, startIso, endExclusiveIso],
  );

  // --- average lead score (lead_scores may not exist yet) ---
  const avgScoreResult = await runOptional<{ avg: string | null; count: number }>(
    tenantDb,
    `SELECT avg(ls.total_score)::numeric AS avg, count(*)::int AS count
     FROM lead_scores ls
     JOIN leads l ON l.id = ls.lead_id
     WHERE ls.tenant_id = $1 AND l.project_id = $2 AND ls.computed_at >= $3 AND ls.computed_at < $4`,
    [tenantId, projectId, startIso, endExclusiveIso],
    "lead_scores",
  );
  let averageLeadScore: number | null = null;
  let averageLeadScoreNote: string | undefined;
  if (avgScoreResult.degraded) {
    averageLeadScoreNote = avgScoreResult.note;
  } else {
    const row = avgScoreResult.rows[0];
    if (!row || row.count === 0 || row.avg === null) {
      averageLeadScoreNote = "no data yet";
    } else {
      averageLeadScore = Math.round(Number(row.avg) * 100) / 100;
    }
  }

  // --- funnel-stage counts for this window (same stages/approach as
  // analytics.ts's /funnel, time-boxed to this report's period) ---
  const discoveredOrganizations = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count FROM discovered_organizations
     WHERE tenant_id = $1 AND project_id = $2 AND discovered_at >= $3 AND discovered_at < $4`,
    [tenantId, projectId, startIso, endExclusiveIso],
    "discovered_organizations",
  );

  const qualifiedCombined = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count
     FROM leads l
     WHERE l.tenant_id = $1 AND l.project_id = $2 AND l.created_at >= $3 AND l.created_at < $4
       AND (
         l.status = 'qualified'
         OR EXISTS (SELECT 1 FROM lead_scores ls WHERE ls.lead_id = l.id AND ls.total_score >= ${QUALIFIED_SCORE_THRESHOLD})
       )`,
    [tenantId, projectId, startIso, endExclusiveIso],
    "lead_scores",
  );
  let qualifiedCount: number;
  if (qualifiedCombined.degraded) {
    const statusOnly = await tenantDb.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM leads
       WHERE tenant_id = $1 AND project_id = $2 AND status = 'qualified'
         AND created_at >= $3 AND created_at < $4`,
      [tenantId, projectId, startIso, endExclusiveIso],
    );
    qualifiedCount = statusOnly.rows[0]?.count ?? 0;
  } else {
    qualifiedCount = firstCount(qualifiedCombined);
  }

  const contacted = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(DISTINCT md.lead_id)::int AS count
     FROM message_drafts md
     WHERE md.tenant_id = $1 AND md.project_id = $2 AND md.status = 'approved'
       AND md.created_at >= $3 AND md.created_at < $4`,
    [tenantId, projectId, startIso, endExclusiveIso],
    "message_drafts",
  );

  const replied = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(DISTINCT lr.lead_id)::int AS count
     FROM lead_replies lr
     WHERE lr.tenant_id = $1 AND lr.project_id = $2 AND lr.received_at >= $3 AND lr.received_at < $4`,
    [tenantId, projectId, startIso, endExclusiveIso],
    "lead_replies",
  );

  return {
    periodType,
    periodStart: toIsoDate(periodStart),
    periodEnd: toIsoDate(periodEnd),
    leads: {
      newCount: newLeadsResult.rows[0]?.count ?? 0,
      byStatus: byStatusResult.rows,
      bySource: bySourceResult.rows,
    },
    campaigns: {
      created: campaignsCreatedResult.rows[0]?.count ?? 0,
      approved: campaignsApprovedResult.rows[0]?.count ?? 0,
    },
    averageLeadScore,
    ...(averageLeadScoreNote ? { averageLeadScoreNote } : {}),
    funnel: {
      discoveredOrganizations: {
        count: firstCount(discoveredOrganizations),
        ...(discoveredOrganizations.degraded ? { note: discoveredOrganizations.note } : {}),
      },
      qualified: { count: qualifiedCount },
      contacted: {
        count: firstCount(contacted),
        ...(contacted.degraded ? { note: contacted.note } : {}),
      },
      replied: {
        count: firstCount(replied),
        ...(replied.degraded ? { note: replied.note } : {}),
      },
    },
  };
}
