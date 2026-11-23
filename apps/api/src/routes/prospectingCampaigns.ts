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
