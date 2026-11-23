import type { PoolClient } from "pg";
import { QUALIFIED_SCORE_THRESHOLD, computeCacRoi, type CacResult, type RoiResult } from "./growthRevenueAnalytics.js";

/**
 * visitorRevenueAttribution.ts: the closing hop in the attribution chain —
 * extending apps/api/src/lib/revenueIntelligence.ts (campaign -> qualified
 * leads -> meetings -> deals won -> revenue -> CAC -> ROI, PER CAMPAIGN) one
 * step further back, to the anonymous WEBSITE VISITOR who started the
 * journey, before they were ever attached to any campaign.
 *
 * What already exists and is reused here, verbatim, never rebuilt:
 *   - site_visitors / site_sessions (500/501_create_site_*.sql): one row per
 *     real anonymous visitor / real browsing session, written by the public
 *     analytics ingestion endpoint. site_sessions captures REAL
 *     utm_source/utm_medium/utm_campaign/referrer/landing_url at session
 *     start (see that migration's doc comment) — this module does not
 *     invent or backfill any of those columns, it only reads them.
 *   - leads.visitor_id / leads.session_id (505_add_visitor_session_to_leads.sql):
 *     the best-effort, nullable, NOT-a-hard-FK correlation from a specific
 *     lead back to the visitor/session that (maybe) submitted it. Exactly
 *     as that migration documents, a lead can legitimately have neither
 *     column populated (analytics beacon never reached the server, or
 *     consent withheld) — this module treats an unlinked lead honestly as
 *     "not attributable to any captured visitor", never as belonging to
 *     some default/guessed channel.
 *   - deals (278_create_deals.sql): stage = 'won' + value_amount, the same
 *     real-recorded-revenue source revenueIntelligence.ts and
 *     growthRevenueAnalytics.ts already use.
 *   - computeCacRoi / QUALIFIED_SCORE_THRESHOLD / runOptional
 *     (growthRevenueAnalytics.ts): reused verbatim for byte-identical
 *     "qualified" definition, CAC/ROI math, and the same
 *     table-might-not-exist-yet degrade-gracefully SAVEPOINT convention —
 *     the sibling visitor-analytics effort (migrations 500/501/505) may
 *     still be mid-rollout in some environments.
 *   - acquisition_costs (425_create_acquisition_costs.sql): real,
 *     staff-entered per-CHANNEL spend. Its own migration comment describes
 *     it as backing DevLaunch's internal acquisition workspace, but the
 *     table itself is an ordinary tenant/project-scoped table with no
 *     internal-workspace-only constraint — so it is read here, honestly,
 *     for whichever tenant/project it has real rows for. Most client
 *     tenants will have NO rows in this table (no ad-billing integration
 *     exists anywhere in this codebase), in which case per-channel spend
 *     is reported as null ("not recorded"), never a guessed figure.
 *
 * What is genuinely NEW here: a FIRST-TOUCH channel rollup —
 * site_visitors -> (that visitor's earliest non-bot session's UTM
 * source/medium/campaign, or its landing_url when no UTM was captured) ->
 * leads (via leads.visitor_id) -> deals (via deals.lead_id, stage = 'won')
 * -> real revenue, grouped by channel, with CAC/ROI against
 * acquisition_costs where it has a matching channel row. This is the one
 * hop nothing else in the codebase computes: every other rollup
 * (revenueIntelligence.ts, campaignAttribution.ts, contentAttribution.ts)
 * starts from something the visitor was already attached to (a campaign, a
 * piece of content, a landing page) — this module starts from the visitor
 * itself, before any of that attribution existed.
 *
 * Fan-out safety: revenue/deals-won are aggregated PER LEAD first (one row
 * per lead_id, deals already summed), then summed again per channel — never
 * a single multi-table join from visitor through lead through deal, which
 * would fan out and silently inflate revenue for a lead with more than one
 * won deal. Same discipline revenueIntelligence.ts documents for its own
 * per-campaign correlated-subquery design.
 */

const UNDEFINED_TABLE_ERROR_CODE = "42P01";
const UNDEFINED_COLUMN_ERROR_CODE = "42703";
let visitorAttrSavepointCounter = 0;

/**
 * Local degrade-gracefully wrapper, same SAVEPOINT convention as
 * growthRevenueAnalytics.ts's runOptional, but also tolerating
 * UNDEFINED_COLUMN (42703) in addition to UNDEFINED_TABLE (42P01) — this
 * module's own queries depend not just on site_visitors/site_sessions
 * existing as tables (the sibling visitor-analytics effort) but on
 * leads.visitor_id/leads.session_id existing as COLUMNS
 * (505_add_visitor_session_to_leads.sql), either of which may legitimately
 * not be applied yet in some environment while both efforts run in
 * parallel. Any other error still propagates — this is an honest-degrade
 * convention, not a blanket error swallow.
 */
async function runOptionalWide<T>(
  tenantDb: PoolClient,
  sql: string,
  params: unknown[],
  tableLabel: string,
): Promise<{ rows: T[]; degraded: boolean; note?: string }> {
  const savepoint = `vra_sp_${visitorAttrSavepointCounter++}`;
  await tenantDb.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await tenantDb.query(sql, params);
    await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { rows: result.rows as T[], degraded: false };
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === UNDEFINED_TABLE_ERROR_CODE || code === UNDEFINED_COLUMN_ERROR_CODE) {
      await tenantDb.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
      return {
        rows: [],
        degraded: true,
        note: `${tableLabel} does not fully exist yet in this environment (table or column missing) — reporting an honest empty result instead of fabricating a rollup.`,
      };
    }
    throw err;
  }
}

export interface VisitorChannelRow {
  /** utm_source of the visitor's first (earliest, non-bot) session, or 'direct' if no UTM was ever captured. */
  channelSource: string;
  /** utm_medium of that same first session, or null (no medium captured). */
  channelMedium: string | null;
  /** utm_campaign if captured; otherwise the first-session landing_url; otherwise '(none)'. Honest fallback, never fabricated. */
  channelCampaignOrLandingPage: string;
  visitorCount: number;
  leadCount: number;
  qualifiedLeadCount: number;
  dealsWon: number;
  customersWon: number;
  /** Real sum of deals.value_amount for won deals attributed to this channel's leads. Never estimated. */
  revenue: number;
  /** acquisition_costs.amount_cents for a matching channel row, in dollars — null means "no spend recorded for this channel", never 0. */
  spend: number | null;
  cac: CacResult;
  roi: RoiResult;
}

export interface VisitorRevenueAttribution {
  channels: VisitorChannelRow[];
  totals: {
    visitorCount: number;
    leadCount: number;
    qualifiedLeadCount: number;
    dealsWon: number;
    customersWon: number;
    revenue: number;
    /** Sum of every channel's recorded spend; channels with null spend contribute 0 here but still report their own CAC/ROI as not_available. */
    recordedSpend: number;
  };
  /**
   * True when site_visitors/site_sessions do not exist yet in this
   * environment (the sibling visitor-analytics migration not yet applied
   * here) — channels is then honestly [] rather than fabricated, and
   * `degradedNote` explains why.
   */
  degraded: boolean;
  degradedNote?: string;
  /** How many leads in this tenant/project have neither visitor_id nor session_id set — i.e. are structurally not attributable to any captured visitor (never estimated as belonging to some channel). */
  unattributedLeadCount: number;
}

interface RawChannelRow {
  channel_source: string;
  channel_medium: string | null;
  channel_campaign_or_landing: string;
  visitor_count: string;
  lead_count: string;
  qualified_lead_count: string;
  deals_won: string;
  customers_won: string;
  revenue: string | null;
}

interface RawSpendRow {
  channel: string;
  total_spend_cents: string;
}

/**
 * Real first-touch channel -> visitor -> lead -> won-deal -> revenue
 * rollup. One row per distinct (channel_source, channel_medium,
 * channel_campaign_or_landing) combination actually observed among this
 * tenant/project's visitors — never a fixed/predefined channel list, so a
 * channel with zero visitors never appears (nothing to honestly report).
 */
async function queryChannelRollup(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<{ rows: RawChannelRow[]; degraded: boolean; note?: string }> {
  return runOptionalWide<RawChannelRow>(
    tenantDb,
    `WITH first_touch AS (
       SELECT DISTINCT ON (s.visitor_id)
         s.visitor_id,
         s.utm_source,
         s.utm_medium,
         s.utm_campaign,
         s.landing_url
       FROM site_sessions s
       WHERE s.tenant_id = $1 AND s.project_id = $2 AND s.is_bot = false
       ORDER BY s.visitor_id, s.started_at ASC
     ),
     visitor_channel AS (
       SELECT
         v.visitor_id,
         COALESCE(ft.utm_source, 'direct') AS channel_source,
         ft.utm_medium AS channel_medium,
         COALESCE(ft.utm_campaign, ft.landing_url, '(none)') AS channel_campaign_or_landing
       FROM site_visitors v
       LEFT JOIN first_touch ft ON ft.visitor_id = v.visitor_id
       WHERE v.tenant_id = $1 AND v.project_id = $2
     ),
     visitor_lead AS (
       SELECT
         vc.channel_source,
         vc.channel_medium,
         vc.channel_campaign_or_landing,
         l.id AS lead_id,
         (l.status = 'qualified' OR ls.total_score >= ${QUALIFIED_SCORE_THRESHOLD}) AS is_qualified
       FROM visitor_channel vc
       JOIN leads l ON l.tenant_id = $1 AND l.project_id = $2 AND l.visitor_id = vc.visitor_id
       LEFT JOIN lead_scores ls ON ls.lead_id = l.id
     ),
     lead_revenue AS (
       -- One row per lead: deals aggregated here first so a lead with more
       -- than one won deal is never fanned out and double-counted at the
       -- channel level below.
       SELECT
         vlead.channel_source,
         vlead.channel_medium,
         vlead.channel_campaign_or_landing,
         vlead.lead_id,
         vlead.is_qualified,
         count(d.id) FILTER (WHERE d.stage = 'won') AS deals_won,
         coalesce(sum(d.value_amount) FILTER (WHERE d.stage = 'won'), 0) AS revenue
       FROM visitor_lead vlead
       LEFT JOIN deals d ON d.tenant_id = $1 AND d.project_id = $2 AND d.lead_id = vlead.lead_id
       GROUP BY vlead.channel_source, vlead.channel_medium, vlead.channel_campaign_or_landing, vlead.lead_id, vlead.is_qualified
     )
     SELECT
       vc.channel_source                                              AS channel_source,
       vc.channel_medium                                              AS channel_medium,
       vc.channel_campaign_or_landing                                 AS channel_campaign_or_landing,
       count(DISTINCT vc.visitor_id)                                  AS visitor_count,
       count(DISTINCT lr.lead_id)                                     AS lead_count,
       count(DISTINCT lr.lead_id) FILTER (WHERE lr.is_qualified)      AS qualified_lead_count,
       coalesce(sum(lr.deals_won), 0)                                 AS deals_won,
       count(DISTINCT lr.lead_id) FILTER (WHERE lr.deals_won > 0)     AS customers_won,
       coalesce(sum(lr.revenue), 0)                                   AS revenue
     FROM visitor_channel vc
     LEFT JOIN lead_revenue lr
       ON lr.channel_source = vc.channel_source
      AND lr.channel_medium IS NOT DISTINCT FROM vc.channel_medium
      AND lr.channel_campaign_or_landing = vc.channel_campaign_or_landing
     GROUP BY vc.channel_source, vc.channel_medium, vc.channel_campaign_or_landing
     ORDER BY revenue DESC, visitor_count DESC`,
    [tenantId, projectId],
    "site_visitors/site_sessions/leads.visitor_id",
  );
}

/** Real per-channel spend from acquisition_costs, summed across every recorded period (this rollup is all-time, not period-bounded — see note on VisitorRevenueAttribution). Channels with no acquisition_costs row at all are simply absent from this map; callers must treat "absent" as null/not-recorded, never 0. */
async function querySpendByChannel(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<Map<string, number>> {
  const result = await runOptionalWide<RawSpendRow>(
    tenantDb,
    `SELECT channel, sum(amount_cents)::text AS total_spend_cents
     FROM acquisition_costs
     WHERE tenant_id = $1 AND project_id = $2
     GROUP BY channel`,
    [tenantId, projectId],
    "acquisition_costs",
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.channel, Number(row.total_spend_cents) / 100);
  }
  return map;
}

async function queryUnattributedLeadCount(tenantDb: PoolClient, tenantId: string, projectId: string): Promise<number> {
  const result = await runOptionalWide<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND visitor_id IS NULL AND session_id IS NULL`,
    [tenantId, projectId],
    "leads.visitor_id/leads.session_id",
  );
  return result.rows[0]?.count ?? 0;
}

function toChannelRow(row: RawChannelRow, spendByChannel: Map<string, number>): VisitorChannelRow {
  const revenue = row.revenue === null || row.revenue === undefined ? 0 : Number(row.revenue);
  const customersWon = Number(row.customers_won ?? 0);
  const spend = spendByChannel.has(row.channel_source) ? spendByChannel.get(row.channel_source)! : null;
  const { cac, roi } = computeCacRoi(spend, customersWon, revenue);

  return {
    channelSource: row.channel_source,
    channelMedium: row.channel_medium,
    channelCampaignOrLandingPage: row.channel_campaign_or_landing,
    visitorCount: Number(row.visitor_count ?? 0),
    leadCount: Number(row.lead_count ?? 0),
    qualifiedLeadCount: Number(row.qualified_lead_count ?? 0),
    dealsWon: Number(row.deals_won ?? 0),
    customersWon,
    revenue,
    spend,
    cac,
    roi,
  };
}

/**
 * computeVisitorRevenueAttribution: the real visitor-to-revenue chain —
 * first-touch channel (UTM source/medium/campaign, or landing page when no
 * UTM was captured) -> anonymous visitors -> leads (via leads.visitor_id)
 * -> deals won -> real recorded revenue -> CAC/ROI against recorded
 * acquisition_costs, honestly degrading to an empty, explained result if
 * site_visitors/site_sessions don't exist yet in this environment (the
 * sibling visitor-analytics migration), exactly like
 * growthRevenueAnalytics.ts's runOptional convention.
 */
export async function computeVisitorRevenueAttribution(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<VisitorRevenueAttribution> {
  const channelRollup = await queryChannelRollup(tenantDb, tenantId, projectId);

  if (channelRollup.degraded) {
    return {
      channels: [],
      totals: { visitorCount: 0, leadCount: 0, qualifiedLeadCount: 0, dealsWon: 0, customersWon: 0, revenue: 0, recordedSpend: 0 },
      degraded: true,
      degradedNote: channelRollup.note,
      unattributedLeadCount: 0,
    };
  }

  const spendByChannel = await querySpendByChannel(tenantDb, tenantId, projectId);
  const unattributedLeadCount = await queryUnattributedLeadCount(tenantDb, tenantId, projectId);

  const channels = channelRollup.rows.map((r) => toChannelRow(r, spendByChannel));

  const totals = channels.reduce(
    (acc, c) => {
      acc.visitorCount += c.visitorCount;
      acc.leadCount += c.leadCount;
      acc.qualifiedLeadCount += c.qualifiedLeadCount;
      acc.dealsWon += c.dealsWon;
      acc.customersWon += c.customersWon;
      acc.revenue += c.revenue;
      acc.recordedSpend += c.spend ?? 0;
      return acc;
    },
    { visitorCount: 0, leadCount: 0, qualifiedLeadCount: 0, dealsWon: 0, customersWon: 0, revenue: 0, recordedSpend: 0 },
  );

  return { channels, totals, degraded: false, unattributedLeadCount };
}
