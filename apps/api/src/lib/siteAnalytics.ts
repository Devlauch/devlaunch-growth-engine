import type { PoolClient } from "pg";

/**
 * Milestone 2 (P1): real, tenant-scoped website-traffic aggregates, built
 * entirely from the new site_visitors/site_sessions/site_pageviews/
 * site_events tables (see packages/db/migrations/500-504 and
 * apps/api/src/routes/publicAnalytics.ts). Every number here is a real SQL
 * aggregate over rows an actual tracked pageview/event wrote — nothing
 * estimated or fabricated, same honesty convention as
 * apps/api/src/lib/growthRevenueAnalytics.ts.
 *
 * Bot handling: every query here filters `is_bot = false` (see
 * apps/api/src/lib/botDetection.ts) — bot sessions are stored for
 * transparency but never counted as real traffic. `botSessionsExcluded` is
 * reported alongside the real numbers so a tenant can see how much traffic
 * was filtered, rather than that filtering being invisible.
 *
 * Relationship to growthRevenueAnalytics.ts's "website traffic" field: that
 * field is explicitly labeled a UTM/lead-capture proxy (leads with a
 * referrer/UTM, not real pageview/session data — see its own doc comment).
 * This module is the real replacement data source; growthRevenueAnalytics.ts
 * itself is NOT edited this round (hot/out of scope — see this feature's
 * handback), so the two coexist until a follow-up round wires
 * growthRevenueAnalytics.ts's websiteTraffic field to read from here
 * instead.
 */
export interface SiteAnalyticsOptions {
  sinceDays?: number;
}

export interface SiteAnalytics {
  periodDays: number;
  uniqueVisitors: number;
  sessions: number;
  pageviews: number;
  /** Single-pageview-session ratio over total (non-bot) sessions — a real, if simple, bounce-rate proxy. */
  bounceRate: number | null;
  topReferrers: { referrer: string; count: number }[];
  topLandingPages: { landingUrl: string; count: number }[];
  botSessionsExcluded: number;
}

export async function computeSiteAnalytics(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  opts: SiteAnalyticsOptions = {},
): Promise<SiteAnalytics> {
  const periodDays = opts.sinceDays ?? 30;
  // periodDays is always validated as a bounded integer by the route layer
  // (routes/siteAnalytics.ts) before reaching here, but this module
  // defensively re-coerces to an integer before string-interpolating it
  // into the interval literal below, since Postgres doesn't support a
  // parameterized `interval '$1 days'`.
  const safeDays = Math.max(1, Math.min(3650, Math.trunc(periodDays)));
  const since = `now() - interval '${safeDays} days'`;

  const visitorsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(DISTINCT s.visitor_id)::int AS count
     FROM site_sessions s
     WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_bot = false AND s.started_at >= ${since}`,
    [tenantId, projectId],
  );

  const sessionsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM site_sessions s
     WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_bot = false AND s.started_at >= ${since}`,
    [tenantId, projectId],
  );

  const botSessionsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM site_sessions s
     WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_bot = true AND s.started_at >= ${since}`,
    [tenantId, projectId],
  );

  const pageviewsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM site_pageviews p
     JOIN site_sessions s ON s.tenant_id = p.tenant_id AND s.project_id = p.project_id AND s.session_id = p.session_id
     WHERE p.tenant_id = $1 AND p.project_id = $2 AND s.is_bot = false AND p.viewed_at >= ${since}`,
    [tenantId, projectId],
  );

  // Bounce-rate-style ratio: sessions (non-bot, in period) whose pageview
  // count within the period is exactly 1, divided by total non-bot sessions
  // in the period. A real, simple proxy -- not a claim of matching any
  // particular analytics vendor's exact bounce definition.
  const singlePageviewSessionsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT p.session_id
       FROM site_pageviews p
       JOIN site_sessions s ON s.tenant_id = p.tenant_id AND s.project_id = p.project_id AND s.session_id = p.session_id
       WHERE p.tenant_id = $1 AND p.project_id = $2 AND s.is_bot = false AND p.viewed_at >= ${since}
       GROUP BY p.session_id
       HAVING count(*) = 1
     ) one_pageview`,
    [tenantId, projectId],
  );

  const topReferrersResult = await tenantDb.query<{ referrer: string | null; count: number }>(
    `SELECT referrer, count(*)::int AS count
     FROM site_sessions s
     WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_bot = false AND s.started_at >= ${since}
       AND referrer IS NOT NULL AND referrer <> ''
     GROUP BY referrer ORDER BY count DESC LIMIT 20`,
    [tenantId, projectId],
  );

  const topLandingPagesResult = await tenantDb.query<{ landing_url: string | null; count: number }>(
    `SELECT landing_url, count(*)::int AS count
     FROM site_sessions s
     WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_bot = false AND s.started_at >= ${since}
       AND landing_url IS NOT NULL AND landing_url <> ''
     GROUP BY landing_url ORDER BY count DESC LIMIT 20`,
    [tenantId, projectId],
  );

  const sessions = sessionsResult.rows[0]?.count ?? 0;
  const bounceRate = sessions > 0 ? (singlePageviewSessionsResult.rows[0]?.count ?? 0) / sessions : null;

  return {
    periodDays,
    uniqueVisitors: visitorsResult.rows[0]?.count ?? 0,
    sessions,
    pageviews: pageviewsResult.rows[0]?.count ?? 0,
    bounceRate,
    topReferrers: topReferrersResult.rows.map((r) => ({ referrer: r.referrer as string, count: r.count })),
    topLandingPages: topLandingPagesResult.rows.map((r) => ({ landingUrl: r.landing_url as string, count: r.count })),
    botSessionsExcluded: botSessionsResult.rows[0]?.count ?? 0,
  };
}
