import type { PoolClient } from "pg";

/**
 * Workstream C1: a VISITOR-BEHAVIOR funnel, built directly on the existing
 * site_sessions/site_pageviews/site_events tables (see
 * packages/db/migrations/500-504 and apps/api/src/lib/siteAnalytics.ts).
 *
 * This is deliberately a NEW, separate capability from
 * apps/api/src/lib/funnelDropoff.ts (read first, left untouched): that
 * module's "funnel" is a four-stage CRM pipeline (discovered_organizations /
 * leads / message_drafts / lead_replies) — it has nothing to do with
 * anonymous visitor behavior on a tracked site. This module answers a
 * genuinely different question: "of the sessions that did X on the site, how
 * many went on to do Y, then Z?" — an ordered sequence of pageviews/custom
 * events within ONE session. Named/routed separately (see
 * apps/api/src/routes/growthExperimentsAnalytics.ts) so the two never
 * collide.
 *
 * Inspiration (not copied code): PostHog's funnel insight (see
 * ~/project/Growth/posthog, MIT-licensed outside its "ee/" directory — see
 * this feature's handback for the full license note) computes step
 * conversion by matching an ordered sequence of events per-person within a
 * ClickHouse UDF (posthog/user_scripts/aggregate_funnel*). We have no
 * ClickHouse and no per-person event-array UDF; this module gets the same
 * conceptual result — "first occurrence of step N that happened after step
 * N-1's occurrence, per session" — with plain chained SQL CTEs against
 * Postgres, scoped to one tenant+project and one session at a time (not a
 * cross-session "person" timeline — see visitorJourney.ts for the
 * visitor-level view across sessions).
 *
 * Honesty notes (deliberate simplifications vs. a commercial product):
 *  - The "conversion window" is the whole queried date range, not a
 *    per-step time limit (e.g. "within 7 days of the previous step"). A
 *    bounded conversion window is a real, useful feature this does not
 *    build; it is not fabricated here.
 *  - Ordering is strict (step N must occur strictly after step N-1 within
 *    the SAME session_id) — no cross-session stitching by visitor_id.
 *  - Bot sessions (site_sessions.is_bot = true) are always excluded, same
 *    convention as siteAnalytics.ts.
 */

export interface FunnelStepFilter {
  /** For eventName === "page_view": match site_pageviews.path exactly. */
  path?: string;
  /** For a custom event: match properties->>propertyKey = propertyEquals. */
  propertyKey?: string;
  propertyEquals?: string;
}

export interface FunnelStepDef {
  /** "page_view" (matched against site_pageviews) or a site_events.event_name value. */
  eventName: string;
  filter?: FunnelStepFilter;
}

export interface FunnelDateRange {
  /** Days back from now to start the window. Default 30, clamped [1, 3650]. */
  sinceDays?: number;
}

export interface FunnelStepResult {
  stepIndex: number;
  eventName: string;
  sessionCount: number;
  /** sessionCount / previous step's sessionCount, or null for the first step. */
  conversionRateFromPrevious: number | null;
  /** sessionCount / first step's sessionCount, or null for the first step. */
  conversionRateFromFirst: number | null;
}

export interface FunnelResult {
  periodDays: number;
  /** Total non-bot sessions in the window, for context (not necessarily step 1's count). */
  totalSessionsInRange: number;
  steps: FunnelStepResult[];
}

const PAGE_VIEW_EVENT = "page_view";

function buildStepCondition(
  step: FunnelStepDef,
  alias: string,
  params: unknown[],
): string {
  if (step.eventName === PAGE_VIEW_EVENT) {
    params.push(PAGE_VIEW_EVENT);
    let condition = `${alias}.event_name = $${params.length}`;
    if (step.filter?.path) {
      params.push(step.filter.path);
      condition += ` AND ${alias}.prop_path = $${params.length}`;
    }
    return condition;
  }

  params.push(step.eventName);
  let condition = `${alias}.event_name = $${params.length}`;
  if (step.filter?.propertyKey && step.filter.propertyEquals !== undefined) {
    params.push(step.filter.propertyKey);
    const keyParamIdx = params.length;
    params.push(step.filter.propertyEquals);
    const valParamIdx = params.length;
    condition += ` AND ${alias}.properties ->> $${keyParamIdx} = $${valParamIdx}`;
  }
  return condition;
}

/**
 * Computes real, ordered step-by-step session conversion counts/rates for
 * one tenant+project, from site_sessions/site_pageviews/site_events. `steps`
 * must have at least one entry; steps.length === 1 degenerates to a single
 * "how many sessions did this" count (still real, just not a drop-off).
 */
export async function computeFunnel(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  steps: FunnelStepDef[],
  dateRange: FunnelDateRange = {},
): Promise<FunnelResult> {
  if (steps.length === 0) {
    throw new Error("computeFunnel requires at least one step");
  }

  const periodDays = dateRange.sinceDays ?? 30;
  // Same defensive re-coercion convention as siteAnalytics.ts: the route
  // layer validates this first, but we never trust an unbounded/non-integer
  // value into a string-interpolated interval literal.
  const safeDays = Math.max(1, Math.min(3650, Math.trunc(periodDays)));
  const since = `now() - interval '${safeDays} days'`;

  const baseParams: unknown[] = [tenantId, projectId];

  const totalSessionsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM site_sessions
     WHERE tenant_id = $1 AND project_id = $2 AND is_bot = false AND started_at >= ${since}`,
    baseParams,
  );
  const totalSessionsInRange = totalSessionsResult.rows[0]?.count ?? 0;

  // The unified, chronological, per-session event stream this funnel walks.
  // UNION ALL of the two source tables, inner-joined to non-bot sessions in
  // range — nothing new is written anywhere; this is a read-only view over
  // existing rows.
  const eventsUnionCte = `
    events_union AS (
      SELECT p.session_id, '${PAGE_VIEW_EVENT}'::text AS event_name, p.path AS prop_path,
             NULL::jsonb AS properties, p.viewed_at AS ts
      FROM site_pageviews p
      JOIN site_sessions s ON s.tenant_id = p.tenant_id AND s.project_id = p.project_id AND s.session_id = p.session_id
      WHERE p.tenant_id = $1 AND p.project_id = $2 AND s.is_bot = false AND s.started_at >= ${since}
      UNION ALL
      SELECT e.session_id, e.event_name, NULL::text AS prop_path, e.properties, e.occurred_at AS ts
      FROM site_events e
      JOIN site_sessions s ON s.tenant_id = e.tenant_id AND s.project_id = e.project_id AND s.session_id = e.session_id
      WHERE e.tenant_id = $1 AND e.project_id = $2 AND s.is_bot = false AND s.started_at >= ${since}
    )`;

  const params: unknown[] = [tenantId, projectId];
  const cteParts: string[] = [eventsUnionCte];

  for (let i = 0; i < steps.length; i++) {
    const alias = `e${i}`;
    const stepCondition = buildStepCondition(steps[i], alias, params);
    if (i === 0) {
      cteParts.push(`
        step0 AS (
          SELECT ${alias}.session_id, min(${alias}.ts) AS ts
          FROM events_union ${alias}
          WHERE ${stepCondition}
          GROUP BY ${alias}.session_id
        )`);
    } else {
      const prevAlias = `step${i - 1}`;
      cteParts.push(`
        step${i} AS (
          SELECT prev.session_id, min(${alias}.ts) AS ts
          FROM ${prevAlias} prev
          JOIN events_union ${alias} ON ${alias}.session_id = prev.session_id AND ${alias}.ts > prev.ts
          WHERE ${stepCondition}
          GROUP BY prev.session_id
        )`);
    }
  }

  const selectParts = steps.map((_, i) => `(SELECT count(*)::int FROM step${i}) AS step_${i}_count`);
  const sql = `WITH ${cteParts.join(",\n")}\nSELECT ${selectParts.join(", ")}`;

  const result = await tenantDb.query<Record<string, number>>(sql, params);
  const row = result.rows[0] ?? {};

  const stepResults: FunnelStepResult[] = steps.map((step, i) => {
    const sessionCount = row[`step_${i}_count`] ?? 0;
    const firstCount = row[`step_0_count`] ?? 0;
    const prevCount = i > 0 ? row[`step_${i - 1}_count`] ?? 0 : null;
    return {
      stepIndex: i,
      eventName: step.eventName,
      sessionCount,
      conversionRateFromPrevious: prevCount !== null ? (prevCount > 0 ? sessionCount / prevCount : 0) : null,
      conversionRateFromFirst: i === 0 ? null : firstCount > 0 ? sessionCount / firstCount : 0,
    };
  });

  return {
    periodDays,
    totalSessionsInRange,
    steps: stepResults,
  };
}
