import type { PoolClient } from "pg";

/**
 * Workstream C1: week-over-week returning-visitor cohort retention, computed
 * directly from site_sessions (no new table). Inspired by (not copied from)
 * PostHog's retention insight — grouping subjects by the calendar period of
 * their first qualifying event, then measuring what fraction return in each
 * following period — reimplemented here as plain SQL over our own
 * site_sessions schema instead of PostHog's ClickHouse retention query
 * (posthog/hogql_queries), since we have a single Postgres table, not a
 * columnar events warehouse.
 *
 * Cohort definition: a visitor's cohort is the (Monday-start) calendar week
 * of their EARLIEST non-bot session in this tenant+project — "first_visit_week"
 * is intentionally the only cohortBy mode built (the signature leaves room
 * for e.g. "first_visit_month" later; it is not faked here).
 */

export type CohortByMode = "first_visit_week";

export interface CohortDateRange {
  /** How many days back to look for cohorts. Default 90, clamped [7, 3650]. */
  sinceDays?: number;
  /** How many week-offsets (0 = cohort week itself) to report per cohort. Default 8, clamped [1, 52]. */
  maxWeekOffset?: number;
}

export interface CohortWeekRetention {
  weekOffset: number;
  activeVisitors: number;
  /** activeVisitors / cohortSize, rounded nowhere — the caller formats. */
  retentionRate: number;
}

export interface CohortRow {
  cohortWeekStart: string;
  cohortSize: number;
  weeks: CohortWeekRetention[];
}

export interface CohortTable {
  cohortBy: CohortByMode;
  periodDays: number;
  maxWeekOffset: number;
  cohorts: CohortRow[];
}

/**
 * Computes a real week-over-week retention table: visitors are bucketed by
 * the week of their first non-bot session, then for each subsequent week we
 * count how many of that cohort's visitors had ANY non-bot session that
 * week. Division-by-zero never fabricates a rate — a cohort can only appear
 * here with cohortSize > 0 (it is defined by having at least one visitor).
 */
export async function computeCohortRetention(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  cohortBy: CohortByMode,
  dateRange: CohortDateRange = {},
): Promise<CohortTable> {
  const periodDays = Math.max(7, Math.min(3650, Math.trunc(dateRange.sinceDays ?? 90)));
  const maxWeekOffset = Math.max(1, Math.min(52, Math.trunc(dateRange.maxWeekOffset ?? 8)));
  const since = `now() - interval '${periodDays} days'`;

  // cohortBy is currently always "first_visit_week" (the only mode this
  // function supports — see header comment); kept as a parameter for a
  // future "first_visit_month" mode rather than silently ignored.
  void cohortBy;

  const result = await tenantDb.query<{
    cohort_week: string;
    week_offset: number;
    active_visitors: number;
  }>(
    `WITH visitor_first_week AS (
       SELECT visitor_id, date_trunc('week', min(started_at)) AS cohort_week
       FROM site_sessions
       WHERE tenant_id = $1 AND project_id = $2 AND is_bot = false
       GROUP BY visitor_id
       HAVING min(started_at) >= ${since}
     ),
     visitor_activity_weeks AS (
       SELECT DISTINCT visitor_id, date_trunc('week', started_at) AS activity_week
       FROM site_sessions
       WHERE tenant_id = $1 AND project_id = $2 AND is_bot = false
     ),
     joined AS (
       SELECT
         f.cohort_week,
         f.visitor_id,
         (extract(epoch FROM (a.activity_week - f.cohort_week)) / 604800)::int AS week_offset
       FROM visitor_first_week f
       JOIN visitor_activity_weeks a ON a.visitor_id = f.visitor_id
       WHERE a.activity_week >= f.cohort_week
     )
     SELECT cohort_week::text AS cohort_week, week_offset, count(DISTINCT visitor_id)::int AS active_visitors
     FROM joined
     WHERE week_offset >= 0 AND week_offset <= $3
     GROUP BY cohort_week, week_offset
     ORDER BY cohort_week ASC, week_offset ASC`,
    [tenantId, projectId, maxWeekOffset],
  );

  const byCohort = new Map<string, Map<number, number>>();
  for (const row of result.rows) {
    if (!byCohort.has(row.cohort_week)) byCohort.set(row.cohort_week, new Map());
    byCohort.get(row.cohort_week)!.set(row.week_offset, row.active_visitors);
  }

  const cohorts: CohortRow[] = [];
  for (const [cohortWeekStart, weekMap] of byCohort.entries()) {
    const cohortSize = weekMap.get(0) ?? 0;
    const weeks: CohortWeekRetention[] = [];
    for (let offset = 0; offset <= maxWeekOffset; offset++) {
      const activeVisitors = weekMap.get(offset) ?? 0;
      weeks.push({
        weekOffset: offset,
        activeVisitors,
        retentionRate: cohortSize > 0 ? activeVisitors / cohortSize : 0,
      });
    }
    cohorts.push({ cohortWeekStart, cohortSize, weeks });
  }

  cohorts.sort((a, b) => new Date(a.cohortWeekStart).getTime() - new Date(b.cohortWeekStart).getTime());

  return { cohortBy: "first_visit_week", periodDays, maxWeekOffset, cohorts };
}
