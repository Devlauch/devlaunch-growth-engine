import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { listCampaignAttribution, getCampaignAttribution } from "../lib/campaignAttribution.js";

/**
 * campaignAttributionRouter: mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/campaign-attribution
 *
 * Multi-Channel Customer Acquisition / Campaign Execution: real attribution
 * read-only endpoints over the campaign_attribution SQL view
 * (packages/db/migrations/276_create_campaign_attribution.sql), which
 * rolls up campaign_id -> enrolled leads -> their outcomes entirely from
 * EXISTING tables (campaigns, campaign_members, sequence_enrollments,
 * lead_replies). Nothing here fabricates ad-spend/impression/click data —
 * that requires the Google Ads/Meta Ads integrations, which are honest
 * NotConfigured stubs in this environment (see lib/channelProviders.ts).
 *
 * NOTE: like routes/sequences.ts, this router is intentionally not wired
 * into app.ts here (file boundaries for this task excluded app.ts) —
 * whoever integrates this feature end-to-end should mount it the same way
 * campaignsRouter is mounted, at the path above.
 */
export const campaignAttributionRouter = Router({ mergeParams: true });
campaignAttributionRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

function parsePagination(req: import("express").Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/campaign-attribution */
campaignAttributionRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const { limit, offset } = parsePagination(req);

    const rows = await listCampaignAttribution(req.tenantDb!, req.tenantId!, projectId, { limit, offset });
    res.json({ campaignAttribution: rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/campaign-attribution/:campaignId */
campaignAttributionRouter.get("/:campaignId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const row = await getCampaignAttribution(req.tenantDb!, req.tenantId!, projectId, campaignId);
    if (!row) throw Errors.notFound("Campaign not found");

    res.json({ campaignAttribution: row });
  } catch (err) {
    next(err);
  }
});
