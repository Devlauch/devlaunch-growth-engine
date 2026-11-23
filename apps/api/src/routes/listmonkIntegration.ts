import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, GTM_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";
import { getListmonkClient } from "../lib/listmonkClient.js";
import { syncProjectSubscribers, createDraftCampaign, triggerCampaignSend, CampaignNotApprovedError } from "../lib/listmonkSync.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/integrations/listmonk
 *
 * Authenticated sync/campaign surface for the real listmonk integration
 * (see docs/INTEGRATION_STATUS.md's Agent B row). Connect + health-check
 * are deliberately NOT duplicated here: the orchestrator's section-6
 * registry/route-layer upgrade already added a generic
 * `POST/.../integrations/:provider/connect` and
 * `POST/.../integrations/:provider/health-check` to
 * apps/api/src/routes/integrations.ts (not edited by this change) that
 * work for listmonk out of the box once listmonkClient.ts exports
 * `checkHealth` (see that file) — building a second, incompatible
 * connect/health path here would just fragment where a tenant's
 * credential lives. This router owns everything listmonk-specific beyond
 * that generic contract: subscriber sync, campaign drafting, and the
 * approval-gated send trigger.
 */
export const listmonkIntegrationRouter = Router({ mergeParams: true });
listmonkIntegrationRouter.use(requireAuth, requireTenantMembership);

function parseProjectId(req: import("express").Request): string {
  return z.string().uuid().parse((req.params as Record<string, string>).projectId);
}

async function assertProjectInTenant(req: import("express").Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [projectId, req.tenantId]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

/**
 * GET / — real status overview: real counts from platform's own mapping
 * tables, never a fabricated subscriber count.
 */
listmonkIntegrationRouter.get("/", async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);

    const integration = await req.tenantDb!.query(
      `SELECT id, status, created_at, updated_at FROM integrations WHERE tenant_id = $1 AND project_id = $2 AND provider = 'listmonk'`,
      [req.tenantId, projectId],
    );
    const list = await req.tenantDb!.query(
      `SELECT listmonk_list_id, name FROM listmonk_lists WHERE tenant_id = $1 AND project_id = $2`,
      [req.tenantId, projectId],
    );
    const subscriberCounts = await req.tenantDb!.query<{ sync_status: string; count: string }>(
      `SELECT sync_status, count(*) FROM listmonk_subscribers WHERE tenant_id = $1 AND project_id = $2 GROUP BY sync_status`,
      [req.tenantId, projectId],
    );
    const campaigns = await req.tenantDb!.query(
      `SELECT lc.campaign_id, lc.listmonk_campaign_id, lc.listmonk_status, c.name, c.status AS platform_status
       FROM listmonk_campaigns lc JOIN campaigns c ON c.id = lc.campaign_id
       WHERE lc.tenant_id = $1 AND lc.project_id = $2
       ORDER BY lc.created_at DESC`,
      [req.tenantId, projectId],
    );

    res.json({
      integration: integration.rows[0] ?? null,
      list: list.rows[0] ?? null,
      subscriberCounts: Object.fromEntries(subscriberCounts.rows.map((r) => [r.sync_status, Number(r.count)])),
      campaigns: campaigns.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /sync-subscribers
 *
 * Syncs eligible leads (never suppressed — see listmonkSync.ts) into
 * listmonk as subscribers. Real upsert semantics; safe to call repeatedly.
 */
listmonkIntegrationRouter.post("/sync-subscribers", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);

    const { client, integrationId } = await getListmonkClient(req.tenantDb!, req.tenantId!, projectId);
    if (!integrationId)
      throw Errors.badRequest("No usable listmonk credential for this project — call POST .../integrations/listmonk/connect first");

    const result = await syncProjectSubscribers(req.tenantDb!, req.tenantId!, projectId, integrationId, client);
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1),
});

/**
 * POST /campaigns
 *
 * Creates a platform `campaigns` row (status 'pending_approval') + a real
 * listmonk DRAFT campaign + a pending `approvals` row in one transaction.
 * This never sends anything — see POST /campaigns/:campaignId/send, which
 * is the only path that can trigger a real send, and only once the
 * approval above has been decided 'approved'.
 */
listmonkIntegrationRouter.post("/campaigns", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const body = createCampaignSchema.parse(req.body);

    const { client, integrationId } = await getListmonkClient(req.tenantDb!, req.tenantId!, projectId);
    if (!integrationId)
      throw Errors.badRequest("No usable listmonk credential for this project — call POST .../integrations/listmonk/connect first");

    const campaignResult = await req.tenantDb!.query<{ id: string }>(
      `INSERT INTO campaigns (tenant_id, project_id, name, channel, status, created_by)
       VALUES ($1, $2, $3, 'email', 'pending_approval', $4)
       RETURNING id`,
      [req.tenantId, projectId, body.name, req.userId],
    );
    const campaignId = campaignResult.rows[0].id;

    const draft = await createDraftCampaign(req.tenantDb!, req.tenantId!, projectId, integrationId, client, {
      campaignId,
      name: body.name,
      subject: body.subject,
      body: body.body,
      requestedBy: req.userId ?? null,
    });

    res.status(201).json({ campaignId, listmonkCampaignId: draft.listmonkCampaignId, approvalId: draft.approvalId });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /campaigns/:campaignId/send
 *
 * The ONLY route that triggers a real listmonk send
 * (PUT /api/campaigns/:id/status {status:'running'}). Refuses unless
 * campaigns.status = 'approved' — set exclusively by the EXISTING
 * approvals decision flow (apps/api/src/routes/approvals.ts, untouched by
 * this round).
 */
listmonkIntegrationRouter.post("/campaigns/:campaignId/send", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = parseProjectId(req);
    await assertProjectInTenant(req, projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);

    const { client, integrationId } = await getListmonkClient(req.tenantDb!, req.tenantId!, projectId);
    if (!integrationId)
      throw Errors.badRequest("No usable listmonk credential for this project — call POST .../integrations/listmonk/connect first");

    try {
      const result = await triggerCampaignSend(req.tenantDb!, req.tenantId!, campaignId, client);
      await req.tenantDb!.query(
        `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'user', $2, 'listmonk_campaign.sent', 'campaign', $3, $4::jsonb)`,
        [req.tenantId, req.userId, campaignId, JSON.stringify({ listmonkStatus: result.listmonkStatus })],
      );
      res.json({ result });
    } catch (err) {
      if (err instanceof CampaignNotApprovedError) throw Errors.forbidden(err.message);
      throw err;
    }
  } catch (err) {
    next(err);
  }
});
