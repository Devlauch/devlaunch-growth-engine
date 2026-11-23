import type { PoolClient } from "pg";

/**
 * channelComparison: per-channel rollup of the SAME real data
 * campaign_attribution already computes (276_create_campaign_attribution.sql
 * / apps/api/src/lib/campaignAttribution.ts), just grouped by
 * campaigns.channel instead of per-campaign — no parallel attribution
 * system, no new fact table.
 *
 * Queries the underlying tables directly (campaigns, campaign_members,
 * leads, the `customers` view from 278_create_deals.sql) with the exact
 * same join shape as campaign_attribution, aggregated once PER CAMPAIGN in
 * a CTE and only then summed per channel — summing `campaigns.spend`
 * straight across a campaign_members join would double/triple-count a
 * campaign's spend once per enrolled lead, which is wrong, so the
 * per-campaign CTE exists specifically to avoid that.
 *
 * cost-per-channel / ROI-per-channel reuse the EXACT null-handling
 * convention apps/api/src/lib/growthRevenueAnalytics.ts uses for CAC/ROI:
 * `campaigns.spend` is manually entered (282_add_campaign_spend_to_
 * campaigns.sql) and NULL means "not recorded", reported as the literal
 * string "not_available" with a `reason`, never a fabricated/zero figure.
 */

export interface ChannelPerformanceRow {
  campaign_channel: string;
  campaign_count: number;
  lead_count: number;
  qualified_lead_count: number;
  customer_count: number;
  costPerCustomer:
    | { value: number; currency: "USD"; totalSpend: number; customerCount: number }
    | { value: "not_available"; reason: string };
  roi:
    | { value: number; totalRevenue: number; totalSpend: number }
    | { value: "not_available"; reason: string };
}

interface RawChannelRow {
  campaign_channel: string;
  campaign_count: string;
  lead_count: string;
  qualified_lead_count: string;
  customer_count: string;
  total_revenue: string | null;
  total_spend: string | null;
}

/** Real per-channel performance for this tenant/project, grouped by campaigns.channel. Empty array when the project has no campaigns. */
export async function getChannelPerformance(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<ChannelPerformanceRow[]> {
  const result = await tenantDb.query<RawChannelRow>(
    `WITH per_campaign AS (
       SELECT
         c.id                                                       AS campaign_id,
         c.channel                                                  AS campaign_channel,
         c.spend                                                    AS spend,
         COUNT(DISTINCT cm.lead_id)                                 AS lead_count,
         COUNT(DISTINCT cm.lead_id) FILTER (WHERE l.status = 'qualified') AS qualified_lead_count,
         COUNT(DISTINCT cust.lead_id)                                AS customer_count,
         SUM(cust.won_deal_value)                                   AS revenue
       FROM campaigns c
       LEFT JOIN campaign_members cm
         ON cm.tenant_id = c.tenant_id AND cm.campaign_id = c.id
       LEFT JOIN leads l
         ON l.tenant_id = cm.tenant_id AND l.id = cm.lead_id
       LEFT JOIN customers cust
         ON cust.tenant_id = cm.tenant_id AND cust.lead_id = cm.lead_id
       WHERE c.tenant_id = $1 AND c.project_id = $2
       GROUP BY c.id, c.channel, c.spend
     )
     SELECT
       campaign_channel,
       COUNT(*)::text                                               AS campaign_count,
       COALESCE(SUM(lead_count), 0)::text                           AS lead_count,
       COALESCE(SUM(qualified_lead_count), 0)::text                 AS qualified_lead_count,
       COALESCE(SUM(customer_count), 0)::text                       AS customer_count,
       SUM(revenue)::text                                           AS total_revenue,
       SUM(spend)::text                                             AS total_spend
     FROM per_campaign
     GROUP BY campaign_channel
     ORDER BY campaign_channel ASC`,
    [tenantId, projectId],
  );

  return result.rows.map((row) => {
    const customerCount = Number(row.customer_count ?? 0);
    const totalRevenue = row.total_revenue === null ? 0 : Number(row.total_revenue);
    const totalSpend = row.total_spend === null || row.total_spend === undefined ? null : Number(row.total_spend);

    let costPerCustomer: ChannelPerformanceRow["costPerCustomer"];
    if (totalSpend === null) {
      costPerCustomer = {
        value: "not_available",
        reason:
          "No campaign spend has been recorded for any campaign on this channel (campaigns.spend is null) — cost-per-customer cannot be computed without real spend data.",
      };
    } else if (customerCount === 0) {
      costPerCustomer = {
        value: "not_available",
        reason: "No deals have been won yet for this channel, so there are no customers to divide spend by.",
      };
    } else {
      costPerCustomer = {
        value: Math.round((totalSpend / customerCount) * 100) / 100,
        currency: "USD",
        totalSpend,
        customerCount,
      };
    }

    let roi: ChannelPerformanceRow["roi"];
    if (totalSpend === null || totalSpend === 0) {
      roi = {
        value: "not_available",
        reason:
          totalSpend === null
            ? "No campaign spend has been recorded for this channel — ROI cannot be computed without real spend data."
            : "Recorded campaign spend for this channel is 0 — ROI is undefined (division by zero) rather than fabricated.",
      };
    } else {
      roi = {
        value: Math.round(((totalRevenue - totalSpend) / totalSpend) * 10000) / 10000,
        totalRevenue,
        totalSpend,
      };
    }

    return {
      campaign_channel: row.campaign_channel,
      campaign_count: Number(row.campaign_count ?? 0),
      lead_count: Number(row.lead_count ?? 0),
      qualified_lead_count: Number(row.qualified_lead_count ?? 0),
      customer_count: customerCount,
      costPerCustomer,
      roi,
    };
  });
}
