import type { PoolClient } from "pg";

/**
 * growthRevenueAnalytics.ts: real SQL aggregates backing
 * GET /growth-analytics (roadmap item 7, "Growth/Revenue Analytics"),
 * composed from tables owned by several parallel efforts:
 *   - website traffic / lead source attribution: leads.source,
 *     leads.utm_source (and sibling utm_ columns) / referrer_url (apps/api/src/lib/leadIngestion.ts,
 *     064_add_utm_tracking_to_leads.sql) + discovery_sources (a separate,
 *     possibly-not-yet-migrated effort).
 *   - lead qualification: the SAME union logic
 *     apps/api/src/lib/funnelDropoff.ts and routes/analytics.ts's /funnel
 *     endpoint use (leads.status = 'qualified' OR lead_scores.total_score
 *     >= threshold) — reused verbatim rather than redefined, so "qualified"
 *     means the same thing everywhere in this product.
 *   - meetings booked / sales conversion: this feature's own `meetings` and
 *     `deals` tables.
 *   - customer acquisition cost / ROI: campaigns.spend
 *     (282_add_campaign_spend_to_campaigns.sql, manually entered — there is
 *     no real ad-billing integration) divided by customers won (the
 *     `customers` view, 278_create_deals.sql). NEVER fabricated: when spend
 *     is not recorded for the period, CAC/ROI are reported as the literal
 *     string `"not_available"`, never a guessed number.
 *
 * Follows the same runOptional/SAVEPOINT degrade-gracefully convention as
 * funnelDropoff.ts / analytics.ts's /funnel: a query against a table that
 * might not exist yet in every environment (discovery_sources, lead_scores)
 * rolls back only its own savepoint and reports an honest zero/empty
 * result instead of 500ing the whole endpoint.
 */

// Exported so other real rollups built on top of this one (e.g.
// apps/api/src/lib/revenueIntelligence.ts, Phase 7's per-campaign CAC/ROI)
// reuse the EXACT same "qualified" definition and degrade-gracefully
// SAVEPOINT helper instead of redefining either — one source of truth for
// what "qualified" means and for how an optional table's absence is
// handled across this codebase.
export const QUALIFIED_SCORE_THRESHOLD = 50;
const UNDEFINED_TABLE_ERROR_CODE = "42P01";
let gaSavepointCounter = 0;

export interface OptionalQueryResult<T> {
  rows: T[];
  degraded: boolean;
  note?: string;
}

export async function runOptional<T>(
  tenantDb: PoolClient,
  sql: string,
  params: unknown[],
  tableLabel: string,
): Promise<OptionalQueryResult<T>> {
  const savepoint = `ga_sp_${gaSavepointCounter++}`;
  await tenantDb.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await tenantDb.query(sql, params);
    await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { rows: result.rows as T[], degraded: false };
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === UNDEFINED_TABLE_ERROR_CODE) {
      await tenantDb.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tenantDb.query(`RELEASE SAVEPOINT ${savepoint}`);
      return {
        rows: [],
        degraded: true,
        note: `${tableLabel} table does not exist yet in this environment — reporting an honest zero/empty result instead of fabricating data.`,
      };
    }
    throw err;
  }
}

export interface GrowthRevenueAnalyticsOptions {
  /** How far back to scope "period"-bounded numbers (meetings, deals, spend). Default 30. */
  sinceDays?: number;
}

export interface GrowthRevenueAnalytics {
  periodDays: number;
  websiteTraffic: {
    totalLeads: number;
    leadsWithReferrer: number;
    byReferrer: { referrer_url: string; count: number }[];
    note: string;
  };
  leadSourceAttribution: {
    bySource: { source: string; count: number }[];
    byUtmSource: { utm_source: string | null; count: number }[];
    byDiscoverySource: { name: string; count: number }[] | { note: string };
  };
  leadQualification: {
    totalLeads: number;
    qualifiedCount: number;
    qualifiedRate: number;
    averageScore: number | null;
    threshold: string;
    note?: string;
  };
  meetingsBooked: {
    totalInPeriod: number;
    byType: { type: string; count: number }[];
    byStatus: { status: string; count: number }[];
  };
  salesConversion: {
    totalDeals: number;
    wonDeals: number;
    lostDeals: number;
    openDeals: number;
    winRate: number | null;
    leadToDealRate: number | null;
  };
  customerAcquisitionCost: { value: number; currency: "USD"; customersWon: number; totalSpend: number } | {
    value: "not_available";
    reason: string;
  };
  roi: { value: number; totalRevenue: number; totalSpend: number } | { value: "not_available"; reason: string };
}

export type CacResult =
  | { value: number; currency: "USD"; customersWon: number; totalSpend: number }
  | { value: "not_available"; reason: string };
export type RoiResult = { value: number; totalRevenue: number; totalSpend: number } | { value: "not_available"; reason: string };

/**
 * computeCacRoi: the one, canonical honest-math CAC/ROI computation in this
 * codebase — pure (no I/O) so every caller (this file's tenant/project-wide
 * aggregate below, and apps/api/src/lib/revenueIntelligence.ts's per-
 * campaign rollup) gets byte-identical rounding and byte-identical
 * "not_available" conditions instead of two subtly different reimplementations.
 * Mirrors apps/api/src/routes/internalGrowth.ts's /cac endpoint's own
 * "insufficient_data" convention: a missing/zero denominator is reported
 * honestly, never masked as a zero or a guessed number.
 */
export function computeCacRoi(
  totalSpend: number | null,
  customersWon: number,
  totalRevenue: number,
): { cac: CacResult; roi: RoiResult } {
  let cac: CacResult;
  if (totalSpend === null) {
    cac = {
      value: "not_available",
      reason: "No spend has been recorded for this campaign — CAC cannot be computed without real spend data.",
    };
  } else if (customersWon === 0) {
    cac = {
      value: "not_available",
      reason: "insufficient_data: no deals have been won yet, so there are no customers to divide spend by.",
    };
  } else {
    cac = {
      value: Math.round((totalSpend / customersWon) * 100) / 100,
      currency: "USD",
      customersWon,
      totalSpend,
    };
  }

  let roi: RoiResult;
  if (totalSpend === null) {
    roi = {
      value: "not_available",
      reason: "No spend has been recorded for this campaign — ROI cannot be computed without real spend data.",
    };
  } else if (totalSpend === 0) {
    roi = {
      value: "not_available",
      reason: "insufficient_data: recorded spend is 0 — ROI is undefined (division by zero) rather than fabricated.",
    };
  } else {
    roi = {
      value: Math.round(((totalRevenue - totalSpend) / totalSpend) * 10000) / 10000,
      totalRevenue,
      totalSpend,
    };
  }

  return { cac, roi };
}

export async function computeGrowthRevenueAnalytics(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  opts: GrowthRevenueAnalyticsOptions = {},
): Promise<GrowthRevenueAnalytics> {
  const periodDays = opts.sinceDays ?? 30;

  // --- website traffic (real signal: leads with a captured referrer/UTM) ---
  const totalLeadsResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  const withReferrerResult = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND (referrer_url IS NOT NULL OR utm_source IS NOT NULL)`,
    [tenantId, projectId],
  );
  const byReferrerResult = await tenantDb.query<{ referrer_url: string; count: number }>(
    `SELECT referrer_url, count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND referrer_url IS NOT NULL
     GROUP BY referrer_url ORDER BY count DESC LIMIT 20`,
    [tenantId, projectId],
  );

  // --- lead source attribution ---
  const bySourceResult = await tenantDb.query<{ source: string; count: number }>(
    `SELECT source, count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 GROUP BY source ORDER BY source`,
    [tenantId, projectId],
  );
  const byUtmSourceResult = await tenantDb.query<{ utm_source: string | null; count: number }>(
    `SELECT utm_source, count(*)::int AS count FROM leads
     WHERE tenant_id = $1 AND project_id = $2 AND utm_source IS NOT NULL
     GROUP BY utm_source ORDER BY count DESC LIMIT 20`,
    [tenantId, projectId],
  );
  const byDiscoverySource = await runOptional<{ name: string; count: number }>(
    tenantDb,
    `SELECT ds.name, count(do2.id)::int AS count
     FROM discovery_sources ds
     LEFT JOIN discovered_organizations do2 ON do2.discovery_source_id = ds.id AND do2.tenant_id = ds.tenant_id
     WHERE ds.tenant_id = $1 AND ds.project_id = $2
     GROUP BY ds.name ORDER BY ds.name`,
    [tenantId, projectId],
    "discovery_sources",
  );

  // --- lead qualification: same union logic as funnelDropoff.ts / analytics.ts /funnel ---
  const qualifiedCombined = await runOptional<{ count: number; avg_score: number | null }>(
    tenantDb,
    `SELECT count(*) FILTER (WHERE l.status = 'qualified' OR ls.total_score >= ${QUALIFIED_SCORE_THRESHOLD})::int AS count,
            avg(ls.total_score) AS avg_score
     FROM leads l
     LEFT JOIN lead_scores ls ON ls.lead_id = l.id
     WHERE l.tenant_id = $1 AND l.project_id = $2`,
    [tenantId, projectId],
    "lead_scores",
  );
  let qualifiedCount: number;
  let averageScore: number | null;
  let qualificationNote: string | undefined;
  if (qualifiedCombined.degraded) {
    const statusOnly = await tenantDb.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2 AND status = 'qualified'`,
      [tenantId, projectId],
    );
    qualifiedCount = statusOnly.rows[0]?.count ?? 0;
    averageScore = null;
    qualificationNote = qualifiedCombined.note;
  } else {
    qualifiedCount = qualifiedCombined.rows[0]?.count ?? 0;
    const avg = qualifiedCombined.rows[0]?.avg_score;
    averageScore = avg === null || avg === undefined ? null : Number(avg);
  }
  const totalLeads = totalLeadsResult.rows[0]?.count ?? 0;

  // --- meetings booked (real, this feature's own table) ---
  const meetingsInPeriod = await tenantDb.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM meetings
     WHERE tenant_id = $1 AND project_id = $2 AND scheduled_at >= now() - ($3 * interval '1 day')`,
    [tenantId, projectId, periodDays],
  );
  const meetingsByType = await tenantDb.query<{ type: string; count: number }>(
    `SELECT type, count(*)::int AS count FROM meetings
     WHERE tenant_id = $1 AND project_id = $2 GROUP BY type ORDER BY type`,
    [tenantId, projectId],
  );
  const meetingsByStatus = await tenantDb.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM meetings
     WHERE tenant_id = $1 AND project_id = $2 GROUP BY status ORDER BY status`,
    [tenantId, projectId],
  );

  // --- sales conversion (real, this feature's own table) ---
  const dealStageCounts = await tenantDb.query<{ stage: string; count: number }>(
    `SELECT stage, count(*)::int AS count FROM deals
     WHERE tenant_id = $1 AND project_id = $2 GROUP BY stage`,
    [tenantId, projectId],
  );
  const stageMap = new Map(dealStageCounts.rows.map((r) => [r.stage, r.count]));
  const wonDeals = stageMap.get("won") ?? 0;
  const lostDeals = stageMap.get("lost") ?? 0;
  const totalDeals = [...stageMap.values()].reduce((a, b) => a + b, 0);
  const openDeals = totalDeals - wonDeals - lostDeals;
  const decidedDeals = wonDeals + lostDeals;
  const winRate = decidedDeals > 0 ? wonDeals / decidedDeals : null;
  const leadToDealRate = totalLeads > 0 ? totalDeals / totalLeads : null;

  // --- customer acquisition cost + ROI ---
  const spendResult = await tenantDb.query<{ total_spend: string | null }>(
    `SELECT sum(spend) AS total_spend FROM campaigns WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  const totalSpendRaw = spendResult.rows[0]?.total_spend;
  const totalSpend = totalSpendRaw === null || totalSpendRaw === undefined ? null : Number(totalSpendRaw);

  const customersResult = await tenantDb.query<{ count: number; total_value: string | null }>(
    `SELECT count(*)::int AS count, sum(won_deal_value) AS total_value
     FROM customers WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId],
  );
  const customersWon = customersResult.rows[0]?.count ?? 0;
  const totalRevenueRaw = customersResult.rows[0]?.total_value;
  const totalRevenue = totalRevenueRaw === null || totalRevenueRaw === undefined ? 0 : Number(totalRevenueRaw);

  let customerAcquisitionCost: GrowthRevenueAnalytics["customerAcquisitionCost"];
  if (totalSpend === null) {
    customerAcquisitionCost = {
      value: "not_available",
      reason: "No campaign spend has been recorded (campaigns.spend is null for every campaign) — CAC cannot be computed without real spend data.",
    };
  } else if (customersWon === 0) {
    customerAcquisitionCost = {
      value: "not_available",
      reason: "No deals have been won yet, so there are no customers to divide spend by.",
    };
  } else {
    customerAcquisitionCost = {
      value: Math.round((totalSpend / customersWon) * 100) / 100,
      currency: "USD",
      customersWon,
      totalSpend,
    };
  }

  let roi: GrowthRevenueAnalytics["roi"];
  if (totalSpend === null || totalSpend === 0) {
    roi = {
      value: "not_available",
      reason:
        totalSpend === null
          ? "No campaign spend has been recorded — ROI cannot be computed without real spend data."
          : "Recorded campaign spend is 0 — ROI is undefined (division by zero) rather than fabricated.",
    };
  } else {
    roi = {
      value: Math.round(((totalRevenue - totalSpend) / totalSpend) * 10000) / 10000,
      totalRevenue,
      totalSpend,
    };
  }

  return {
    periodDays,
    websiteTraffic: {
      totalLeads,
      leadsWithReferrer: withReferrerResult.rows[0]?.count ?? 0,
      byReferrer: byReferrerResult.rows,
      note: "No real web-analytics pixel/provider is connected in this codebase — 'traffic' is the real signal this app actually captures: leads whose referrer_url/utm_source was recorded by the embeddable widget at submission time (see apps/api/src/lib/leadIngestion.ts), not raw pageviews.",
    },
    leadSourceAttribution: {
      bySource: bySourceResult.rows,
      byUtmSource: byUtmSourceResult.rows,
      byDiscoverySource: byDiscoverySource.degraded ? { note: byDiscoverySource.note! } : byDiscoverySource.rows,
    },
    leadQualification: {
      totalLeads,
      qualifiedCount,
      qualifiedRate: totalLeads > 0 ? qualifiedCount / totalLeads : 0,
      averageScore,
      threshold: `leads.status = 'qualified' OR lead_scores.total_score >= ${QUALIFIED_SCORE_THRESHOLD}`,
      ...(qualificationNote ? { note: qualificationNote } : {}),
    },
    meetingsBooked: {
      totalInPeriod: meetingsInPeriod.rows[0]?.count ?? 0,
      byType: meetingsByType.rows,
      byStatus: meetingsByStatus.rows,
    },
    salesConversion: {
      totalDeals,
      wonDeals,
      lostDeals,
      openDeals,
      winRate,
      leadToDealRate,
    },
    customerAcquisitionCost,
    roi,
  };
}
