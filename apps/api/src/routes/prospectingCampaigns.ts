import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { getCampaignResultsSummary, startCampaignRun } from "../lib/prospectingCampaigns.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/prospecting-campaigns
 *
 * Milestone 3 Phase 2 (Intelligent Lead Acquisition) — the real "batch of
 * discovery work with a goal" entity discovery_sources never had: a
 * name/goal, a status lifecycle (draft -> running -> completed/paused), a
 * link to the icp_profiles row it targets, and a real results summary
 * (lib/prospectingCampaigns.ts's getCampaignResultsSummary — always
 * computed fresh from real discovered_organizations/discovered_contacts/
 * leads rows, never fabricated/cached).
 */
export const prospectingCampaignsRouter = Router({ mergeParams: true });
prospectingCampaignsRouter.use(requireAuth, requireTenantMembership);

const CAMPAIGN_COLUMNS = `id, tenant_id, project_id, name, goal, icp_profile_id, status, started_at, completed_at, created_at, updated_at`;

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadCampaignOr404(req: Request, projectId: string, campaignId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM prospecting_campaigns WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [campaignId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Prospecting campaign not found");
  return r.rows[0];
}

const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().max(2000).optional(),
  icpProfileId: z.string().uuid().optional(),
});

const updateCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    goal: z.string().trim().max(2000).optional(),
    icpProfileId: z.string().uuid().nullable().optional(),
    // Only the two manual, non-run-driven transitions are allowed here —
    // 'running'/'completed' are set exclusively by startCampaignRun, never
    // by a direct client PATCH, so the status lifecycle can't be forged
    // out of band with a real run's own bookkeeping.
    status: z.enum(["draft", "paused"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

async function assertIcpProfileInProject(req: Request, projectId: string, icpProfileId: string) {
  const r = await req.tenantDb!.query(
    `SELECT 1 FROM icp_profiles WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [icpProfileId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.badRequest("icpProfileId does not belong to this project");
}

/** GET / — list campaigns (no per-row results summary, to avoid an N+1
 * query fan-out on a list view; see GET /:id for the real summary). */
prospectingCampaignsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ${CAMPAIGN_COLUMNS} FROM prospecting_campaigns WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ prospectingCampaigns: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST / — create a campaign in 'draft' status. */
prospectingCampaignsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createCampaignSchema.parse(req.body);
    if (body.icpProfileId) await assertIcpProfileInProject(req, projectId, body.icpProfileId);

    const result = await req.tenantDb!.query(
      `INSERT INTO prospecting_campaigns (tenant_id, project_id, name, goal, icp_profile_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [req.tenantId, projectId, body.name, body.goal ?? null, body.icpProfileId ?? null],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'prospecting_campaign.created', 'prospecting_campaign', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id],
    );

    res.status(201).json({ prospectingCampaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /:id — one campaign plus its real results summary and configured sources. */
prospectingCampaignsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const campaign = await loadCampaignOr404(req, projectId, campaignId);

    const [sourcesResult, resultsSummary] = await Promise.all([
      req.tenantDb!.query(
        `SELECT pcs.id, pcs.discovery_source_id, pcs.priority, ds.name, ds.connector_type, ds.enabled
         FROM prospecting_campaign_sources pcs
         JOIN discovery_sources ds ON ds.id = pcs.discovery_source_id
         WHERE pcs.prospecting_campaign_id = $1 AND pcs.tenant_id = $2
         ORDER BY pcs.priority ASC, pcs.created_at ASC`,
        [campaignId, req.tenantId],
      ),
      getCampaignResultsSummary(req.tenantDb!, req.tenantId as string, projectId, campaignId),
    ]);

    res.json({
      prospectingCampaign: campaign,
      sources: sourcesResult.rows,
      resultsSummary,
    });
  } catch (err) {
    next(err);
  }
});

interface StatusCountRow {
  status: string;
  count: number;
}

interface ScoreBucketRow {
  bucket: string;
  count: number;
}

/**
 * GET /:id/analytics
 *
 * Campaign-level discovery analytics, one level deeper than GET /:id's
 * resultsSummary (which only gives flat totals): a status breakdown for
 * this campaign's discovered_organizations, a verification-status
 * breakdown for their discovered_contacts, and a real distribution
 * (min/max/avg + bucketed histogram) of lead_scores among the leads this
 * campaign's organizations were promoted into. Every number is a genuine
 * SQL aggregate — no fabricated totals or placeholder buckets.
 *
 * Built directly against this tree's own schema
 * (packages/db/migrations/323_create_prospecting_campaigns.sql), NOT the
 * isolated milestone3-phase2 worktree's schema this endpoint was ported
 * from: that worktree had a separate prospecting_campaign_organizations
 * join table and budget_cents/spend_cents_to_date/target_prospect_count
 * columns on prospecting_campaigns, none of which exist here. Here, a
 * discovered_organizations row is tagged with the campaign that created it
 * directly via its own prospecting_campaign_id column (added by the same
 * migration, see discoveryRun.ts/lib/prospectingCampaigns.ts's
 * getCampaignResultsSummary, which this endpoint's organizations/contacts
 * counts are a finer-grained breakdown of) rather than through a join
 * table — so there is no separate "spend" section here; that data simply
 * isn't tracked by this schema. A promoted lead still has no direct FK back
 * to the discovered_organizations row it came from (see discovery.ts's
 * promote-to-lead route), so the leads join below goes through
 * leads.custom_fields's discoveredOrganizationId, the same provenance key
 * that route itself writes and the same join getCampaignResultsSummary
 * already uses.
 */
prospectingCampaignsRouter.get("/:id/analytics", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const campaign = await loadCampaignOr404(req, projectId, campaignId);

    const orgStatusResult = await req.tenantDb!.query<StatusCountRow>(
      `SELECT status, count(*)::int AS count
       FROM discovered_organizations
       WHERE tenant_id = $1 AND project_id = $2 AND prospecting_campaign_id = $3
       GROUP BY status`,
      [req.tenantId, projectId, campaignId],
    );
    const organizationsTotal = orgStatusResult.rows.reduce((sum, r) => sum + r.count, 0);

    const contactVerificationResult = await req.tenantDb!.query<StatusCountRow>(
      `SELECT c.verification_status AS status, count(*)::int AS count
       FROM discovered_contacts c
       JOIN discovered_organizations o ON o.id = c.organization_id
       WHERE o.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = $3
       GROUP BY c.verification_status`,
      [req.tenantId, projectId, campaignId],
    );
    const contactsTotal = contactVerificationResult.rows.reduce((sum, r) => sum + r.count, 0);

    const promotedLeadsResult = await req.tenantDb!.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM leads l
       JOIN discovered_organizations o
         ON o.tenant_id = l.tenant_id AND o.id::text = l.custom_fields ->> 'discoveredOrganizationId'
       WHERE l.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = $3`,
      [req.tenantId, projectId, campaignId],
    );
    const leadsPromoted = promotedLeadsResult.rows[0]?.count ?? 0;

    const scoreStatsResult = await req.tenantDb!.query<{
      count: number;
      avg_score: string | null;
      min_score: string | null;
      max_score: string | null;
    }>(
      `SELECT count(*)::int AS count, avg(ls.total_score) AS avg_score,
              min(ls.total_score) AS min_score, max(ls.total_score) AS max_score
       FROM leads l
       JOIN discovered_organizations o
         ON o.tenant_id = l.tenant_id AND o.id::text = l.custom_fields ->> 'discoveredOrganizationId'
       JOIN lead_scores ls ON ls.lead_id = l.id
       WHERE l.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = $3`,
      [req.tenantId, projectId, campaignId],
    );
    const scoreStats = scoreStatsResult.rows[0];

    const scoreDistributionResult = await req.tenantDb!.query<ScoreBucketRow>(
      `SELECT CASE
                WHEN ls.total_score < 25 THEN '0-25'
                WHEN ls.total_score < 50 THEN '25-50'
                WHEN ls.total_score < 75 THEN '50-75'
                ELSE '75-100'
              END AS bucket,
              count(*)::int AS count
       FROM leads l
       JOIN discovered_organizations o
         ON o.tenant_id = l.tenant_id AND o.id::text = l.custom_fields ->> 'discoveredOrganizationId'
       JOIN lead_scores ls ON ls.lead_id = l.id
       WHERE l.tenant_id = $1 AND o.project_id = $2 AND o.prospecting_campaign_id = $3
       GROUP BY bucket`,
      [req.tenantId, projectId, campaignId],
    );

    res.json({
      prospectingCampaign: campaign,
      organizations: {
        total: organizationsTotal,
        byStatus: orgStatusResult.rows,
      },
      contacts: {
        total: contactsTotal,
        byVerificationStatus: contactVerificationResult.rows,
      },
      leads: {
        promotedCount: leadsPromoted,
        scoredCount: scoreStats?.count ?? 0,
        averageScore: scoreStats?.avg_score === null || scoreStats?.avg_score === undefined ? null : Number(scoreStats.avg_score),
        minScore: scoreStats?.min_score === null || scoreStats?.min_score === undefined ? null : Number(scoreStats.min_score),
        maxScore: scoreStats?.max_score === null || scoreStats?.max_score === undefined ? null : Number(scoreStats.max_score),
        scoreDistribution: scoreDistributionResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /:id — update name/goal/icpProfileId, or manually draft<->paused. */
prospectingCampaignsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCampaignOr404(req, projectId, campaignId);
    const body = updateCampaignSchema.parse(req.body);
    if (body.icpProfileId) await assertIcpProfileInProject(req, projectId, body.icpProfileId);

    const fields: string[] = [];
    const values: unknown[] = [campaignId];
    if (body.name !== undefined) {
      values.push(body.name);
      fields.push(`name = $${values.length}`);
    }
    if (body.goal !== undefined) {
      values.push(body.goal);
      fields.push(`goal = $${values.length}`);
    }
    if (body.icpProfileId !== undefined) {
      values.push(body.icpProfileId);
      fields.push(`icp_profile_id = $${values.length}`);
    }
    if (body.status !== undefined) {
      values.push(body.status);
      fields.push(`status = $${values.length}`);
    }

    const result = await req.tenantDb!.query(
      `UPDATE prospecting_campaigns SET ${fields.join(", ")} WHERE id = $1 RETURNING ${CAMPAIGN_COLUMNS}`,
      values,
    );

    res.json({ prospectingCampaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:id */
prospectingCampaignsRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCampaignOr404(req, projectId, campaignId);

    await req.tenantDb!.query(`DELETE FROM prospecting_campaigns WHERE id = $1`, [campaignId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const addSourceSchema = z.object({
  discoverySourceId: z.string().uuid(),
  priority: z.number().int().min(0).max(1000).optional(),
});

/** GET /:id/sources */
prospectingCampaignsRouter.get("/:id/sources", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCampaignOr404(req, projectId, campaignId);

    const result = await req.tenantDb!.query(
      `SELECT pcs.id, pcs.discovery_source_id, pcs.priority, ds.name, ds.connector_type, ds.enabled
       FROM prospecting_campaign_sources pcs
       JOIN discovery_sources ds ON ds.id = pcs.discovery_source_id
       WHERE pcs.prospecting_campaign_id = $1 AND pcs.tenant_id = $2
       ORDER BY pcs.priority ASC, pcs.created_at ASC`,
      [campaignId, req.tenantId],
    );
    res.json({ sources: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/sources — attach a discovery_sources row to this campaign at a
 * given waterfall priority (lower runs first). */
prospectingCampaignsRouter.post("/:id/sources", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadCampaignOr404(req, projectId, campaignId);
    const body = addSourceSchema.parse(req.body);

    const sourceExists = await req.tenantDb!.query(
      `SELECT 1 FROM discovery_sources WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [body.discoverySourceId, req.tenantId, projectId],
    );
    if (sourceExists.rowCount === 0) throw Errors.badRequest("discoverySourceId does not belong to this project");

    const result = await req.tenantDb!.query(
      `INSERT INTO prospecting_campaign_sources (tenant_id, prospecting_campaign_id, discovery_source_id, priority)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (prospecting_campaign_id, discovery_source_id) DO UPDATE SET priority = EXCLUDED.priority
       RETURNING *`,
      [req.tenantId, campaignId, body.discoverySourceId, body.priority ?? 0],
    );

    res.status(201).json({ campaignSource: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:id/sources/:sourceId — detach by prospecting_campaign_sources.id. */
prospectingCampaignsRouter.delete("/:id/sources/:sourceId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    const campaignSourceId = paramId(req, "sourceId");
    await assertProjectInTenant(req, projectId);
    await loadCampaignOr404(req, projectId, campaignId);

    const result = await req.tenantDb!.query(
      `DELETE FROM prospecting_campaign_sources WHERE id = $1 AND prospecting_campaign_id = $2 AND tenant_id = $3`,
      [campaignSourceId, campaignId, req.tenantId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Campaign source not found");
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const startRunSchema = z
  .object({
    industry: z.string().trim().min(1).max(100).optional(),
    geography: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .optional();

/**
 * POST /:id/start-run
 *
 * Kicks off the real discovery waterfall (lib/prospectingCampaigns.ts's
 * startCampaignRun, built on lib/discoveryRun.ts / the EXISTING generic
 * providerWaterfall.ts) across this campaign's configured sources, in
 * priority order, targeting its accepted ICP profile when one is set.
 * Every discovered_organizations row created by this run is tagged with
 * this campaign's id, so GET /:id's resultsSummary reflects it immediately
 * afterward — never a fabricated count.
 */
prospectingCampaignsRouter.post("/:id/start-run", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const campaignId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const body = startRunSchema.parse(req.body ?? {}) ?? {};

    const runResult = await startCampaignRun(req.tenantDb!, req.tenantId as string, projectId, campaignId, body);

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'prospecting_campaign.run_started', 'prospecting_campaign', $3, $4::jsonb)`,
      [
        req.tenantId,
        req.userId,
        campaignId,
        JSON.stringify({
          answeredBySourceId: runResult.answeredBySourceId,
          attempts: runResult.attempts,
          organizationsFound: runResult.persisted.organizationsFound,
          organizationsCreated: runResult.persisted.organizationsCreated,
        }),
      ],
    );

    res.status(200).json({
      prospectingCampaign: runResult.campaign,
      answeredBySourceId: runResult.answeredBySourceId,
      answeredBySourceName: runResult.answeredBySourceName,
      attempts: runResult.attempts,
      ...runResult.persisted,
    });
  } catch (err) {
    next(err);
  }
});
