/**
 * ICP refinement feedback loop (Phase 4 business intelligence — "ICP
 * refinement" half of the backlog item; website analysis / recommended-ICP
 * generation itself already lives in ../lib/growthAnalyzer.ts and is
 * unchanged by this file).
 *
 * The gap this closes: growthAnalyzer.ts's recommendIcp() + the accept-icp
 * endpoint (routes/growthAnalyzer.ts) are a one-shot suggestion — an ICP
 * profile gets created once from crawled site copy and is then never
 * revisited. Once that profile is actually used (prospecting_campaigns
 * targets an icp_profile_id, discovery finds organizations/contacts,
 * leads get created and scored against it via icp_match_scores — see
 * ../lib/icpMatching.ts — and some of those leads become real deals), there
 * was previously NOTHING feeding the REAL outcome back. "Refinement" implies
 * a feedback loop, not just the initial suggestion.
 *
 * This module adds exactly that: a single real-data aggregation (no new
 * table, no ML, no LLM) joining the EXISTING icp_match_scores, leads, and
 * deals tables to answer, per ICP profile: how many real leads actually
 * matched this persona, and of those, how many became qualified leads /
 * real deals / real won revenue. A lead counts toward an ICP profile only
 * when that profile is its OWN best match (icp_match_scores row with the
 * highest match_score for that lead) and that score is > 0 — a lead with no
 * real match to any ICP contributes to none of them, same "missing evidence
 * counts for nothing" rule icpMatching.ts itself follows.
 *
 * Honesty contract: every number here is a real COUNT/SUM over real rows
 * computed fresh on every call — never stored, cached, or estimated. When a
 * profile has zero matched leads yet, its signal says exactly that instead
 * of fabricating a rate.
 */

import type { PoolClient } from "pg";

export interface IcpConversionPerformance {
  icpProfileId: string;
  icpProfileName: string;
  /** Real leads whose single best icp_match_scores match (by match_score) is this profile, with match_score > 0. */
  matchedLeads: number;
  /** Of those matched leads, how many have leads.status = 'qualified'. */
  qualifiedLeads: number;
  /** Real deals whose lead_id is one of this profile's matched leads. */
  dealsCount: number;
  /** Of those deals, how many reached stage = 'won'. */
  dealsWon: number;
  /** Of those deals, how many reached stage = 'lost'. */
  dealsLost: number;
  /** Real SUM(value_amount) of this profile's won deals (0 when none). */
  wonValue: number;
  /** dealsWon / matchedLeads as a percentage, rounded to 1 decimal; null when matchedLeads is 0 (no rate to report, not 0%). */
  conversionRatePct: number | null;
  /** Human-readable, honest summary of the above — never a recommendation beyond "consider re-prioritizing", and only when there's real data to back it. */
  signal: string;
}

interface IcpConversionRow {
  icp_profile_id: string;
  icp_profile_name: string;
  matched_leads: string | number;
  qualified_leads: string | number;
  deals_count: string | number;
  deals_won: string | number;
  deals_lost: string | number;
  won_value: string | number | null;
}

function toNumber(value: string | number | null): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function buildSignal(row: {
  icpProfileName: string;
  matchedLeads: number;
  qualifiedLeads: number;
  dealsCount: number;
  dealsWon: number;
  conversionRatePct: number | null;
}): string {
  const { icpProfileName, matchedLeads, qualifiedLeads, dealsCount, dealsWon, conversionRatePct } = row;
  if (matchedLeads === 0) {
    return `No leads have matched the "${icpProfileName}" ICP profile yet — not enough data to refine this persona.`;
  }
  if (dealsCount === 0) {
    return (
      `${matchedLeads} lead(s) have matched "${icpProfileName}" (${qualifiedLeads} qualified so far), ` +
      `but none have an associated deal yet — too early to score conversion.`
    );
  }
  return (
    `The "${icpProfileName}" ICP segment has converted at ${conversionRatePct}% ` +
    `(${dealsWon} won / ${matchedLeads} matched lead(s), ${qualifiedLeads} qualified, ${dealsCount} total deal(s) created) — ` +
    `consider ${dealsWon > 0 ? "re-prioritizing prospecting toward" : "re-examining whether to keep targeting"} this segment.`
  );
}

/**
 * Computes real conversion-rate-by-ICP-segment for one project, fresh on
 * every call. Returns one row per icp_profiles row in the project (in
 * created_at order, same as routes/icpProfiles.ts's own GET /), including
 * profiles with zero matched leads — callers decide whether to filter
 * those out.
 */
export async function computeIcpConversionPerformance(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
): Promise<IcpConversionPerformance[]> {
  const result = await tenantDb.query(
    `WITH best_match AS (
       -- One row per lead: the ICP profile it matches best, per the
       -- EXISTING icp_match_scores table (icpMatching.ts). Ties broken by
       -- icp_profile_id for a deterministic, repeatable pick.
       SELECT DISTINCT ON (lead_id) lead_id, icp_profile_id, match_score
       FROM icp_match_scores
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY lead_id, match_score DESC, icp_profile_id ASC
     )
     SELECT
       icp.id AS icp_profile_id,
       icp.name AS icp_profile_name,
       count(DISTINCT bm.lead_id) AS matched_leads,
       count(DISTINCT l.id) FILTER (WHERE l.status = 'qualified') AS qualified_leads,
       count(DISTINCT d.id) AS deals_count,
       count(DISTINCT d.id) FILTER (WHERE d.stage = 'won') AS deals_won,
       count(DISTINCT d.id) FILTER (WHERE d.stage = 'lost') AS deals_lost,
       COALESCE(SUM(d.value_amount) FILTER (WHERE d.stage = 'won'), 0) AS won_value
     FROM icp_profiles icp
     LEFT JOIN best_match bm ON bm.icp_profile_id = icp.id AND bm.match_score > 0
     LEFT JOIN leads l ON l.id = bm.lead_id AND l.tenant_id = icp.tenant_id
     LEFT JOIN deals d ON d.lead_id = l.id AND d.tenant_id = icp.tenant_id
     WHERE icp.tenant_id = $1 AND icp.project_id = $2
     GROUP BY icp.id, icp.name, icp.created_at
     ORDER BY icp.created_at ASC`,
    [tenantId, projectId],
  );

  return (result.rows as IcpConversionRow[]).map((row) => {
    const matchedLeads = toNumber(row.matched_leads);
    const qualifiedLeads = toNumber(row.qualified_leads);
    const dealsCount = toNumber(row.deals_count);
    const dealsWon = toNumber(row.deals_won);
    const dealsLost = toNumber(row.deals_lost);
    const wonValue = toNumber(row.won_value);
    const conversionRatePct = matchedLeads > 0 ? Math.round((dealsWon / matchedLeads) * 1000) / 10 : null;

    return {
      icpProfileId: row.icp_profile_id,
      icpProfileName: row.icp_profile_name,
      matchedLeads,
      qualifiedLeads,
      dealsCount,
      dealsWon,
      dealsLost,
      wonValue,
      conversionRatePct,
      signal: buildSignal({ icpProfileName: row.icp_profile_name, matchedLeads, qualifiedLeads, dealsCount, dealsWon, conversionRatePct }),
    };
  });
}

/**
 * Deterministic, templated overall summary across every ICP profile in the
 * project — real sorting only (by conversionRatePct, matched-leads as
 * tiebreak), never a model-generated narrative. Returns an honest
 * "not enough data yet" message when fewer than two profiles have any real
 * matched leads to compare.
 */
export function buildIcpRefinementSummary(performances: IcpConversionPerformance[]): string {
  const withData = performances.filter((p) => p.matchedLeads > 0);
  if (performances.length === 0) {
    return "No ICP profiles exist for this project yet.";
  }
  if (withData.length === 0) {
    return "No leads have matched any ICP profile yet — run prospecting campaigns and score leads before refinement signal is available.";
  }
  if (withData.length === 1) {
    return withData[0].signal;
  }

  const ranked = [...withData].sort((a, b) => {
    const rateA = a.conversionRatePct ?? -1;
    const rateB = b.conversionRatePct ?? -1;
    if (rateB !== rateA) return rateB - rateA;
    return b.matchedLeads - a.matchedLeads;
  });
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  if (best.icpProfileId === worst.icpProfileId) {
    return best.signal;
  }

  return (
    `Across ${withData.length} ICP profile(s) with real lead-match data, "${best.icpProfileName}" converts best ` +
    `(${best.conversionRatePct ?? 0}%, ${best.dealsWon}/${best.matchedLeads} matched leads won) while "${worst.icpProfileName}" ` +
    `converts worst (${worst.conversionRatePct ?? 0}%, ${worst.dealsWon}/${worst.matchedLeads}) — ` +
    `consider shifting future prospecting-campaign targeting toward "${best.icpProfileName}".`
  );
}
