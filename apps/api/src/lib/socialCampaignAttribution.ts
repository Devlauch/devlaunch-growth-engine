/**
 * socialCampaignAttribution: extends the EXISTING campaign_attribution
 * read layer (apps/api/src/lib/campaignAttribution.ts, itself a thin typed
 * wrapper over the campaign_attribution SQL view —
 * 276_create_campaign_attribution.sql) with social's real contribution,
 * rather than duplicating any of that module's logic. This file computes
 * exactly one new thing — a rollup over `social_content_calendar` rows for
 * the campaign — and joins it with the existing attribution row; it never
 * re-derives member/reply/conversion counts itself.
 */

import type { PoolClient } from "pg";
import { getCampaignAttribution, type CampaignAttributionRow } from "./campaignAttribution.js";

export interface SocialContentSummaryRow {
  calendar_item_count: number;
  published_count: number;
  pending_approval_count: number;
  rejected_count: number;
  platforms: string[];
}

export interface AttributionResult {
  campaignId: string;
  /** Null when the campaign exists but has no campaign_attribution row yet (e.g. no members/replies at all) — never fabricated. */
  campaignAttribution: CampaignAttributionRow | null;
  socialContent: SocialContentSummaryRow;
}

function toSocialSummary(row: Record<string, unknown>): SocialContentSummaryRow {
  return {
    calendar_item_count: Number(row.calendar_item_count ?? 0),
    published_count: Number(row.published_count ?? 0),
    pending_approval_count: Number(row.pending_approval_count ?? 0),
    rejected_count: Number(row.rejected_count ?? 0),
    platforms: Array.isArray(row.platforms) ? (row.platforms as string[]).filter((p): p is string => typeof p === "string") : [],
  };
}

/**
 * attributeSocialEngagementToCampaign(): joins social_content_calendar rows
 * (by campaign_id) with the EXISTING campaign_attribution view's row for
 * that same campaign — reusing getCampaignAttribution() verbatim rather
 * than re-querying the view — to show social's real, honest contribution
 * (how many calendar items exist for this campaign, how many actually
 * published, how many are stuck pending approval). Never fabricates a
 * "social-driven conversions" number: this codebase has no real
 * click/conversion tracking linking a specific published social post back
 * to a lead/conversion event, so this function does not invent one — it
 * reports the calendar's real, stored state only.
 */
export async function attributeSocialEngagementToCampaign(
  tenantDb: PoolClient,
  tenantId: string,
  campaignId: string,
): Promise<AttributionResult> {
  const campaign = await tenantDb.query<{ project_id: string }>(
    `SELECT project_id FROM campaigns WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  );
  if (campaign.rowCount === 0) {
    throw new Error(`Campaign ${campaignId} not found in tenant ${tenantId}`);
  }
  const projectId = campaign.rows[0].project_id;

  const [campaignAttribution, socialRows] = await Promise.all([
    getCampaignAttribution(tenantDb, tenantId, projectId, campaignId),
    tenantDb.query(
      `SELECT
         COUNT(*) AS calendar_item_count,
         COUNT(*) FILTER (WHERE published_status = 'published') AS published_count,
         COUNT(*) FILTER (WHERE approval_status = 'pending') AS pending_approval_count,
         COUNT(*) FILTER (WHERE approval_status = 'rejected') AS rejected_count,
         COALESCE(array_agg(DISTINCT platform) FILTER (WHERE platform IS NOT NULL), '{}') AS platforms
       FROM social_content_calendar
       WHERE tenant_id = $1 AND campaign_id = $2`,
      [tenantId, campaignId],
    ),
  ]);

  return {
    campaignId,
    campaignAttribution,
    socialContent: toSocialSummary(socialRows.rows[0] ?? {}),
  };
}
