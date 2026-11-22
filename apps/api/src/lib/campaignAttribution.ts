/**
 * campaignAttribution: a thin, typed read layer over the campaign_attribution
 * SQL view (packages/db/migrations/276_create_campaign_attribution.sql) —
 * a real rollup computed entirely from existing tables (campaigns,
 * campaign_members, sequence_enrollments, lead_replies). No new fact table
 * is introduced; this module never aggregates anything itself beyond what
 * the view already computes in SQL, so there is exactly one source of
 * truth for these numbers.
 */

import type { PoolClient } from "pg";

export interface CampaignAttributionRow {
  tenant_id: string;
  project_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  campaign_channel: string;
  member_count: number;
  active_member_count: number;
  sequence_enrollment_count: number;
  sequence_active_count: number;
  sequence_completed_count: number;
  conversion_count: number;
  unsubscribed_count: number;
  bounced_count: number;
  stopped_for_reply_count: number;
  reply_count: number;
  interested_reply_count: number;
  unsubscribe_reply_count: number;
  not_now_reply_count: number;
  wrong_person_reply_count: number;
}

function toNumericRow(row: Record<string, unknown>): CampaignAttributionRow {
  // The view's COUNT(...) aggregates come back from node-postgres as
  // strings (COUNT returns bigint) — coerce every count column to a real
  // JS number so callers get numbers, not numeric-looking strings.
  const numericKeys = [
    "member_count",
    "active_member_count",
    "sequence_enrollment_count",
    "sequence_active_count",
    "sequence_completed_count",
    "conversion_count",
    "unsubscribed_count",
    "bounced_count",
    "stopped_for_reply_count",
    "reply_count",
    "interested_reply_count",
    "unsubscribe_reply_count",
    "not_now_reply_count",
    "wrong_person_reply_count",
  ] as const;

  const out: Record<string, unknown> = { ...row };
  for (const key of numericKeys) {
    out[key] = Number(row[key] ?? 0);
  }
  return out as unknown as CampaignAttributionRow;
}

/** Lists campaign_attribution rows for this tenant+project, alphabetically by campaign name (the view has no created_at of its own). */
export async function listCampaignAttribution(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<CampaignAttributionRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = await tenantDb.query(
    `SELECT * FROM campaign_attribution WHERE tenant_id = $1 AND project_id = $2 ORDER BY campaign_name ASC LIMIT $3 OFFSET $4`,
    [tenantId, projectId, limit, offset],
  );
  return result.rows.map(toNumericRow);
}

/** A single campaign's attribution row, or null if the campaign has no row (e.g. it was deleted, or doesn't belong to this tenant/project — the LEFT JOINs still produce a zeroed row for any existing campaign with no members, so null here means "no such campaign in this tenant/project"). */
export async function getCampaignAttribution(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  campaignId: string,
): Promise<CampaignAttributionRow | null> {
  const result = await tenantDb.query(
    `SELECT * FROM campaign_attribution WHERE tenant_id = $1 AND project_id = $2 AND campaign_id = $3`,
    [tenantId, projectId, campaignId],
  );
  if (result.rowCount === 0) return null;
  return toNumericRow(result.rows[0]);
}
