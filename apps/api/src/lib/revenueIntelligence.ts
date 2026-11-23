import type { PoolClient } from "pg";
import { QUALIFIED_SCORE_THRESHOLD, computeCacRoi, type CacResult, type RoiResult } from "./growthRevenueAnalytics.js";

/**
 * revenueIntelligence.ts: Phase 7's genuinely new rollup — the missing link
 * between what already exists and a per-campaign revenue/CAC/ROI view.
 *
 * What ALREADY existed (not rebuilt here, only composed/reused):
 *   - apps/api/src/lib/campaignAttribution.ts / campaign_attribution SQL
 *     view (276_create_campaign_attribution.sql): campaign -> member/
 *     sequence/reply outcomes for OUTBOUND `campaigns` only.
 *   - apps/api/src/lib/prospectingCampaigns.ts's getCampaignResultsSummary:
 *     prospecting_campaigns -> discovered_organizations -> leads provenance
 *     (via leads.custom_fields->>'discoveredOrganizationId'), for DISCOVERY
 *     `prospecting_campaigns` only.
 *   - apps/api/src/lib/growthRevenueAnalytics.ts: a tenant/project-WIDE
 *     (not per-campaign) CAC/ROI aggregate, and the canonical honest-math
 *     helper this module reuses verbatim (computeCacRoi) rather than
 *     reimplementing — see that file for the "not_available" convention,
 *     which mirrors apps/api/src/routes/internalGrowth.ts's own
 *     "insufficient_data" CAC for DevLaunch's internal workspace.
 *
 * What was GENUINELY MISSING, and is built here: neither existing module
 * connects a single campaign (of EITHER type) all the way through to
 * qualified leads -> meetings booked -> deals WON -> real recorded revenue
 * -> CAC -> ROI, per campaign. This module computes exactly that, for every
 * outbound `campaigns` row AND every discovery `prospecting_campaigns` row
 * in a tenant/project, from real existing tables only:
 *   - qualified leads: same union logic as growthRevenueAnalytics.ts
 *     (leads.status = 'qualified' OR lead_scores.total_score >= threshold),
 *     scoped to the leads attributed to this one campaign.
 *   - meetings booked: the `meetings` table, joined through lead_id.
 *   - deals won + real recorded revenue: the `deals` table
 *     (stage = 'won', value_amount — a real amount a rep typed in when
 *     marking the deal won; never invented).
 *   - spend: campaigns.spend (282_add_campaign_spend_to_campaigns.sql) for
 *     outbound campaigns, prospecting_campaigns.spend
 *     (550_add_spend_to_prospecting_campaigns.sql, added alongside this
 *     module — the client-tenant-scoped equivalent of a manual cost entry,
 *     same honest-null pattern as campaigns.spend) for discovery campaigns.
 *     NEITHER is a billing/ad-platform integration (none exists in this
 *     codebase) — both are manually-entered figures, nullable, and NULL is
 *     always treated as "no spend recorded", never as zero.
 *
 * A lead is attributed to an outbound campaign via campaign_members (the
 * same join campaign_attribution's view uses) and to a prospecting campaign
 * via the discovered_organizations provenance chain (the same join
 * getCampaignResultsSummary uses) — no new attribution logic, no new
 * fact/junction table.
 */

export type CampaignType = "outbound" | "prospecting";

export interface CampaignRevenueRow {
  campaignType: CampaignType;
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  qualifiedLeads: number;
  meetingsBooked: number;
  dealsWon: number;
  customersWon: number;
  /** Real sum of deals.value_amount for this campaign's won deals. Never estimated. */
  revenue: number;
  /** campaigns.spend / prospecting_campaigns.spend — null means "not recorded", never 0. */
  spend: number | null;
  cac: CacResult;
  roi: RoiResult;
}

export interface RevenueIntelligence {
  campaigns: CampaignRevenueRow[];
  totals: {
    qualifiedLeads: number;
    meetingsBooked: number;
    dealsWon: number;
    customersWon: number;
    revenue: number;
    /** Sum of every campaign's recorded spend; null-spend campaigns contribute 0 here but are
     *  still reported as "not_available" individually — this total is a convenience sum of what
     *  WAS recorded, not a substitute for each campaign's own honest CAC/ROI. */
    recordedSpend: number;
  };
}

interface OutboundRow {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  spend: string | null;
  qualified_leads: string;
  meetings_booked: string;
  deals_won: string;
  customers_won: string;
  revenue: string | null;
}

interface ProspectingRow {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  spend: string | null;
  qualified_leads: string;
  meetings_booked: string;
  deals_won: string;
  customers_won: string;
  revenue: string | null;
}

/**
 * Per-outbound-campaign real rollup. Every metric is a correlated scalar
 * subquery (rather than a single multi-join), deliberately — joining
 * campaign_members to meetings AND deals in one query would fan out rows
 * and double-count, which would silently inflate numbers; this codebase's
 * rule against fabricated/incorrect revenue figures applies just as much to
 * an accidental overcount as to an invented one.
 */
async function queryOutboundCampaignRevenue(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<OutboundRow[]> {
  const result = await tenantDb.query<OutboundRow>(
    `SELECT
       c.id AS campaign_id,
       c.name AS campaign_name,
       c.status AS campaign_status,
       c.spend::text AS spend,
       (SELECT count(DISTINCT cm.lead_id)
          FROM campaign_members cm
          JOIN leads l ON l.id = cm.lead_id AND l.tenant_id = cm.tenant_id
          LEFT JOIN lead_scores ls ON ls.lead_id = l.id
          WHERE cm.campaign_id = c.id AND cm.tenant_id = c.tenant_id
            AND (l.status = 'qualified' OR ls.total_score >= ${QUALIFIED_SCORE_THRESHOLD})
       )::text AS qualified_leads,
       (SELECT count(*)
          FROM meetings m
          JOIN campaign_members cm ON cm.lead_id = m.lead_id AND cm.tenant_id = m.tenant_id
          WHERE cm.campaign_id = c.id AND cm.tenant_id = c.tenant_id
       )::text AS meetings_booked,
       (SELECT count(*)
          FROM deals d
          JOIN campaign_members cm ON cm.lead_id = d.lead_id AND cm.tenant_id = d.tenant_id
          WHERE cm.campaign_id = c.id AND cm.tenant_id = c.tenant_id AND d.stage = 'won'
       )::text AS deals_won,
       (SELECT count(DISTINCT d.lead_id)
          FROM deals d
          JOIN campaign_members cm ON cm.lead_id = d.lead_id AND cm.tenant_id = d.tenant_id
          WHERE cm.campaign_id = c.id AND cm.tenant_id = c.tenant_id AND d.stage = 'won'
       )::text AS customers_won,
       (SELECT coalesce(sum(d.value_amount), 0)
          FROM deals d
          JOIN campaign_members cm ON cm.lead_id = d.lead_id AND cm.tenant_id = d.tenant_id
          WHERE cm.campaign_id = c.id AND cm.tenant_id = c.tenant_id AND d.stage = 'won'
       )::text AS revenue
     FROM campaigns c
     WHERE c.tenant_id = $1 AND c.project_id = $2
     ORDER BY c.name ASC`,
    [tenantId, projectId],
  );
  return result.rows;
}

/**
 * Per-prospecting-campaign real rollup, using the exact same
 * leads.custom_fields->>'discoveredOrganizationId' provenance join
 * apps/api/src/lib/prospectingCampaigns.ts's getCampaignResultsSummary
 * already established (not a new/different attribution path).
 */
async function queryProspectingCampaignRevenue(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<ProspectingRow[]> {
  const result = await tenantDb.query<ProspectingRow>(
    `SELECT
       pc.id AS campaign_id,
       pc.name AS campaign_name,
       pc.status AS campaign_status,
       pc.spend::text AS spend,
       (SELECT count(*)
          FROM leads l
          LEFT JOIN lead_scores ls ON ls.lead_id = l.id
          WHERE l.tenant_id = $1 AND l.project_id = $2
            AND l.custom_fields ->> 'discoveredOrganizationId' = ANY (
              ARRAY(SELECT id::text FROM discovered_organizations o
                    WHERE o.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = pc.id)
            )
            AND (l.status = 'qualified' OR ls.total_score >= ${QUALIFIED_SCORE_THRESHOLD})
       )::text AS qualified_leads,
       (SELECT count(*)
          FROM meetings m
          JOIN leads l ON l.id = m.lead_id AND l.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1 AND m.project_id = $2
            AND l.custom_fields ->> 'discoveredOrganizationId' = ANY (
              ARRAY(SELECT id::text FROM discovered_organizations o
                    WHERE o.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = pc.id)
            )
       )::text AS meetings_booked,
       (SELECT count(*)
          FROM deals d
          JOIN leads l ON l.id = d.lead_id AND l.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 AND d.project_id = $2 AND d.stage = 'won'
            AND l.custom_fields ->> 'discoveredOrganizationId' = ANY (
              ARRAY(SELECT id::text FROM discovered_organizations o
                    WHERE o.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = pc.id)
            )
       )::text AS deals_won,
       (SELECT count(DISTINCT d.lead_id)
          FROM deals d
          JOIN leads l ON l.id = d.lead_id AND l.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 AND d.project_id = $2 AND d.stage = 'won'
            AND l.custom_fields ->> 'discoveredOrganizationId' = ANY (
              ARRAY(SELECT id::text FROM discovered_organizations o
                    WHERE o.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = pc.id)
            )
       )::text AS customers_won,
       (SELECT coalesce(sum(d.value_amount), 0)
          FROM deals d
          JOIN leads l ON l.id = d.lead_id AND l.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 AND d.project_id = $2 AND d.stage = 'won'
            AND l.custom_fields ->> 'discoveredOrganizationId' = ANY (
              ARRAY(SELECT id::text FROM discovered_organizations o
                    WHERE o.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = pc.id)
            )
       )::text AS revenue
     FROM prospecting_campaigns pc
     WHERE pc.tenant_id = $1 AND pc.project_id = $2
     ORDER BY pc.name ASC`,
    [tenantId, projectId],
  );
  return result.rows;
}

function toCampaignRevenueRow(
  campaignType: CampaignType,
  row: OutboundRow | ProspectingRow,
): CampaignRevenueRow {
  const spend = row.spend === null || row.spend === undefined ? null : Number(row.spend);
  const revenue = row.revenue === null || row.revenue === undefined ? 0 : Number(row.revenue);
  const customersWon = Number(row.customers_won ?? 0);
  const { cac, roi } = computeCacRoi(spend, customersWon, revenue);

  return {
    campaignType,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    campaignStatus: row.campaign_status,
    qualifiedLeads: Number(row.qualified_leads ?? 0),
    meetingsBooked: Number(row.meetings_booked ?? 0),
    dealsWon: Number(row.deals_won ?? 0),
    customersWon,
    revenue,
    spend,
    cac,
    roi,
  };
}

/**
 * computeRevenueIntelligence: the real, missing final rollup for CLIENT
 * tenants — campaigns (both outbound `campaigns` and discovery
 * `prospecting_campaigns`) -> qualified leads -> meetings booked -> deals
 * won -> real recorded revenue -> CAC -> ROI, per campaign. Never computes
 * CAC/ROI from a guessed number: a campaign with no spend recorded, or no
 * deals won yet, reports "not_available" (with an "insufficient_data"-
 * tagged reason where the denominator is what's missing), exactly like
 * growthRevenueAnalytics.ts's tenant-wide aggregate and
 * routes/internalGrowth.ts's internal-workspace CAC already do.
 */
export async function computeRevenueIntelligence(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<RevenueIntelligence> {
  const [outboundRows, prospectingRows] = await Promise.all([
    queryOutboundCampaignRevenue(tenantDb, tenantId, projectId),
    queryProspectingCampaignRevenue(tenantDb, tenantId, projectId),
  ]);

  const campaigns = [
    ...outboundRows.map((r) => toCampaignRevenueRow("outbound", r)),
    ...prospectingRows.map((r) => toCampaignRevenueRow("prospecting", r)),
  ];

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.qualifiedLeads += c.qualifiedLeads;
      acc.meetingsBooked += c.meetingsBooked;
      acc.dealsWon += c.dealsWon;
      acc.customersWon += c.customersWon;
      acc.revenue += c.revenue;
      acc.recordedSpend += c.spend ?? 0;
      return acc;
    },
    { qualifiedLeads: 0, meetingsBooked: 0, dealsWon: 0, customersWon: 0, revenue: 0, recordedSpend: 0 },
  );

  return { campaigns, totals };
}
