/**
 * Prospecting campaign management — the real gap Milestone 3 Phase 2 asked
 * for: discovery_sources (026_create_discovery_sources.sql) is purely a
 * connector CONFIG row with no name/goal, no status, no results summary, no
 * link to which icp_profiles row it's targeting. prospecting_campaigns
 * (packages/db/migrations/323_create_prospecting_campaigns.sql) is the
 * missing entity: one row per "a batch of discovery work with a goal",
 * owning one or more discovery_sources (prospecting_campaign_sources,
 * ordered by `priority`) and optionally targeting a real icp_profiles row.
 *
 * This module owns exactly two real operations beyond plain CRUD (which
 * lives directly in routes/prospectingCampaigns.ts, same convention as
 * routes/companies.ts):
 *   1. getCampaignResultsSummary — computes a real results summary fresh
 *      from actual discovered_organizations/discovered_contacts/leads rows
 *      tagged with this campaign's id. Never a stored/cached/fabricated
 *      count.
 *   2. startCampaignRun — runs the real discovery waterfall
 *      (lib/discoveryRun.ts, itself built on the EXISTING generic
 *      providerWaterfall.ts) across the campaign's configured sources, in
 *      priority order, targeting the campaign's accepted ICP profile (if
 *      any) the same way routes/discovery.ts's POST .../discovery-sources/run
 *      does, and tags every created discovered_organizations row with this
 *      campaign's id.
 */

import type pg from "pg";
import { Errors } from "./httpError.js";
import {
  runDiscoveryWaterfall,
  persistDiscoveryResult,
  type DiscoverySourceRow,
  type DiscoveryRunInput,
  type PersistDiscoveryResultOutcome,
} from "./discoveryRun.js";
import type { WaterfallAttempt } from "./providerWaterfall.js";

export interface CampaignResultsSummary {
  /** Real COUNT(*) of discovered_organizations tagged with this campaign. */
  organizationsFound: number;
  /** Real COUNT(*) of discovered_contacts belonging to those organizations. */
  contactsFound: number;
  /** Real COUNT(*) of leads whose custom_fields.discoveredOrganizationId
   * traces back to one of this campaign's discovered organizations (the
   * same provenance link POST .../promote-to-lead already records — no
   * second counter to keep in sync). */
  leadsCreated: number;
  /** Of those, how many have leads.status = 'qualified' — reads the
   * EXISTING leads.status column (015_create_leads.sql) directly; this
   * module does not implement or duplicate any scoring/qualification
   * logic of its own (that's routes/scoring.ts's concern). */
  leadsQualified: number;
}

/**
 * Computes a campaign's results summary fresh, every call — no stored
 * counter, so it can never drift from reality or report a fabricated
 * number. Safe to call on a campaign with zero activity (returns all
 * zeros, not an error).
 */
export async function getCampaignResultsSummary(
  tenantDb: pg.PoolClient,
  tenantId: string,
  projectId: string,
  campaignId: string,
): Promise<CampaignResultsSummary> {
  const result = await tenantDb.query(
    `WITH campaign_orgs AS (
       SELECT id FROM discovered_organizations
       WHERE tenant_id = $1 AND project_id = $2 AND prospecting_campaign_id = $3
     )
     SELECT
       (SELECT count(*)::int FROM campaign_orgs) AS organizations_found,
       (SELECT count(*)::int FROM discovered_contacts c
          JOIN campaign_orgs o ON o.id = c.organization_id
          WHERE c.tenant_id = $1) AS contacts_found,
       (SELECT count(*)::int FROM leads l
          WHERE l.tenant_id = $1 AND l.project_id = $2
            AND l.custom_fields ->> 'discoveredOrganizationId' = ANY (ARRAY(SELECT id::text FROM campaign_orgs))
       ) AS leads_created,
       (SELECT count(*)::int FROM leads l
          WHERE l.tenant_id = $1 AND l.project_id = $2 AND l.status = 'qualified'
            AND l.custom_fields ->> 'discoveredOrganizationId' = ANY (ARRAY(SELECT id::text FROM campaign_orgs))
       ) AS leads_qualified`,
    [tenantId, projectId, campaignId],
  );
  const row = result.rows[0] ?? {
    organizations_found: 0,
    contacts_found: 0,
    leads_created: 0,
    leads_qualified: 0,
  };
  return {
    organizationsFound: row.organizations_found ?? 0,
    contactsFound: row.contacts_found ?? 0,
    leadsCreated: row.leads_created ?? 0,
    leadsQualified: row.leads_qualified ?? 0,
  };
}

/** recommendIcp's own placeholder (lib/growthAnalyzer.ts) for "no
 * geography detected" — never pass this through to a connector as a real
 * search term. */
function isRealGeography(candidate: string | undefined): candidate is string {
  return Boolean(candidate) && !candidate!.startsWith("Global (");
}

export interface StartCampaignRunResult {
  campaign: Record<string, unknown>;
  persisted: PersistDiscoveryResultOutcome;
  answeredBySourceId: string | null;
  answeredBySourceName: string | null;
  attempts: WaterfallAttempt[];
}

/**
 * Starts a real discovery run for `campaignId`: loads its configured
 * sources (in priority order), resolves industry/geography targeting from
 * its accepted ICP profile (campaign-supplied overrides win — same
 * precedence routes/discovery.ts's own run-waterfall endpoint uses), runs
 * the real waterfall, persists whatever it found tagged with this
 * campaign's id, and marks the campaign 'completed'. Refuses to start a
 * second concurrent run (409) or a run with zero configured sources (400)
 * — never silently no-ops.
 */
export async function startCampaignRun(
  tenantDb: pg.PoolClient,
  tenantId: string,
  projectId: string,
  campaignId: string,
  overrides: DiscoveryRunInput,
): Promise<StartCampaignRunResult> {
  const campaignResult = await tenantDb.query(
    `SELECT * FROM prospecting_campaigns WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [campaignId, tenantId, projectId],
  );
  if (campaignResult.rowCount === 0) throw Errors.notFound("Prospecting campaign not found");
  const campaign = campaignResult.rows[0];

  if (campaign.status === "running") {
    throw Errors.conflict("This campaign already has a run in progress.");
  }

  const sourcesResult = await tenantDb.query(
    `SELECT ds.id, ds.connector_type, ds.name, ds.enabled, ds.rate_limit_per_minute, ds.terms_note, ds.config
     FROM discovery_sources ds
     JOIN prospecting_campaign_sources pcs ON pcs.discovery_source_id = ds.id
     WHERE pcs.prospecting_campaign_id = $1 AND pcs.tenant_id = $2
     ORDER BY pcs.priority ASC, pcs.created_at ASC`,
    [campaignId, tenantId],
  );
  const sources: DiscoverySourceRow[] = sourcesResult.rows;
  if (sources.length === 0) {
    throw Errors.badRequest(
      "This campaign has no discovery sources configured — add at least one before starting a run.",
    );
  }

  let industry = overrides.industry;
  let geography = overrides.geography;
  if (campaign.icp_profile_id && (industry === undefined || geography === undefined)) {
    const icpResult = await tenantDb.query(`SELECT firmographics FROM icp_profiles WHERE id = $1 AND tenant_id = $2`, [
      campaign.icp_profile_id,
      tenantId,
    ]);
    const firmographics = (icpResult.rows[0]?.firmographics ?? {}) as {
      industries?: string[];
      geographies?: string[];
    };
    if (industry === undefined) industry = firmographics.industries?.[0];
    if (geography === undefined) {
      const candidate = firmographics.geographies?.[0];
      geography = isRealGeography(candidate) ? candidate : undefined;
    }
  }

  await tenantDb.query(
    `UPDATE prospecting_campaigns SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1`,
    [campaignId],
  );

  const waterfall = await runDiscoveryWaterfall(sources, { industry, geography, limit: overrides.limit });

  const persisted = waterfall.result
    ? await persistDiscoveryResult(
        tenantDb,
        tenantId,
        projectId,
        waterfall.answeredBySourceId as string,
        waterfall.result,
        { prospectingCampaignId: campaignId },
      )
    : {
        organizationsFound: 0,
        organizationsCreated: 0,
        organizationsDuplicate: 0,
        contactsCreated: 0,
        contactsDuplicate: 0,
        organizations: [],
      };

  const updated = await tenantDb.query(
    `UPDATE prospecting_campaigns SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
    [campaignId],
  );

  return {
    campaign: updated.rows[0],
    persisted,
    answeredBySourceId: waterfall.answeredBySourceId,
    answeredBySourceName: waterfall.answeredBySourceName,
    attempts: waterfall.attempts,
  };
}
