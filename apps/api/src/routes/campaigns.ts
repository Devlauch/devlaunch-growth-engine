import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { notifyTenantOwnersAndAdmins } from "../lib/notify.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/campaigns
 *
 * Campaigns go through a real draft -> pending_approval -> approved |
 * rejected flow, using the existing `approvals` table/pattern (see
 * src/routes/approvals.ts and packages/db/migrations
 * 023_add_campaign_id_to_approvals.sql) rather than a parallel approval
 * mechanism. There is no outbound email/social send integration in this
 * phase: "approved" only means a human signed off — nothing is actually
 * sent/published, and the API never claims otherwise.
 */
export const campaignsRouter = Router({ mergeParams: true });
campaignsRouter.use(requireAuth, requireTenantMembership);

const CHANNELS = ["email", "social", "content", "event", "other"] as const;

const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: z.enum(CHANNELS).optional(),
  objective: z.string().trim().max(2000).optional(),
  audienceDescription: z.string().trim().max(2000).optional(),
  scheduledAt: z.string().datetime().optional(),
});

const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  channel: z.enum(CHANNELS).optional(),
  objective: z.string().trim().max(2000).optional(),
  audienceDescription: z.string().trim().max(2000).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
});

const addMemberSchema = z.object({
  leadId: z.string().uuid(),
});

const CAMPAIGN_COLUMNS = `id, tenant_id, project_id, name, channel, objective, audience_description, status,
       scheduled_at, created_by, created_at, updated_at`;

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadCampaignOr404(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  campaignId: string,
) {
  const result = await tenantDb.query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [campaignId, tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Campaign not found");
  return result.rows[0];
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/campaigns */
campaignsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId],
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/campaigns */
campaignsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);
    const body = createCampaignSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO campaigns (tenant_id, project_id, name, channel, objective, audience_description, scheduled_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.name,
        body.channel ?? "email",
        body.objective ?? null,
        body.audienceDescription ?? null,
        body.scheduledAt ?? null,
        req.userId,
      ],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'campaign.created', 'campaign', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id],
    );

    res.status(201).json({ campaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/campaigns/:campaignId */
campaignsRouter.get("/:campaignId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);
    const campaign = await loadCampaignOr404(req.tenantDb!, req.tenantId!, projectId, campaignId);

    const members = await req.tenantDb!.query(
      `SELECT cm.id, cm.status, cm.created_at, l.id AS lead_id, l.name, l.email, l.company, l.source
       FROM campaign_members cm
       JOIN leads l ON l.id = cm.lead_id
       WHERE cm.tenant_id = $1 AND cm.campaign_id = $2
       ORDER BY cm.created_at DESC`,
      [req.tenantId, campaignId],
    );

    const approvals = await req.tenantDb!.query(
      `SELECT id, status, requested_by, reviewed_by, reason, decision_notes, requested_at, reviewed_at
       FROM approvals
       WHERE tenant_id = $1 AND campaign_id = $2
       ORDER BY requested_at DESC`,
      [req.tenantId, campaignId],
    );

    res.json({ campaign, members: members.rows, approvals: approvals.rows });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/tenants/:tenantId/projects/:projectId/campaigns/:campaignId — only while 'draft' */
campaignsRouter.patch("/:campaignId", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);
    const body = updateCampaignSchema.parse(req.body);
    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one field is required");
    }

    const existing = await loadCampaignOr404(req.tenantDb!, req.tenantId!, projectId, campaignId);
    if (existing.status !== "draft") {
      throw Errors.conflict("Only a draft campaign can be edited");
    }

    const result = await req.tenantDb!.query(
      `UPDATE campaigns
       SET name = COALESCE($3, name),
           channel = COALESCE($4, channel),
           objective = COALESCE($5, objective),
           audience_description = COALESCE($6, audience_description),
           scheduled_at = CASE WHEN $7 THEN $8::timestamptz ELSE scheduled_at END
       WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [
        campaignId,
        req.tenantId,
        body.name ?? null,
        body.channel ?? null,
        body.objective ?? null,
        body.audienceDescription ?? null,
        body.scheduledAt !== undefined,
        body.scheduledAt ?? null,
      ],
    );
    if (result.rowCount === 0) throw Errors.conflict("Only a draft campaign can be edited");

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'campaign.updated', 'campaign', $3, $4::jsonb)`,
      [req.tenantId, req.userId, campaignId, JSON.stringify(body)],
    );

    res.json({ campaign: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tenants/:tenantId/projects/:projectId/campaigns/:campaignId/submit-for-approval
 *
 * draft -> pending_approval, and creates the real approvals row that the
 * existing approvals queue (GET /api/v1/tenants/:tenantId/approvals) and
 * decision route (POST .../approvals/:approvalId/decision) both already
 * handle generically.
 */
campaignsRouter.post("/:campaignId/submit-for-approval", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);

    const existing = await loadCampaignOr404(req.tenantDb!, req.tenantId!, projectId, campaignId);
    if (existing.status !== "draft") {
      throw Errors.conflict("Only a draft campaign can be submitted for approval");
    }

    const updated = await req.tenantDb!.query(
      `UPDATE campaigns SET status = 'pending_approval'
       WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [campaignId, req.tenantId],
    );
    if (updated.rowCount === 0) throw Errors.conflict("Only a draft campaign can be submitted for approval");

    const approval = await req.tenantDb!.query(
      `INSERT INTO approvals (tenant_id, campaign_id, requested_by, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id, campaign_id, status, requested_by, requested_at`,
      [req.tenantId, campaignId, req.userId, `Campaign "${existing.name}" submitted for approval`],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'campaign.submitted_for_approval', 'campaign', $3, $4::jsonb)`,
      [req.tenantId, req.userId, campaignId, JSON.stringify({ approvalId: approval.rows[0].id })],
    );

    // Real in-app notification: whoever can approve (owners/admins) needs
    // to know a campaign is now waiting on them — never email/WhatsApp
    // (see src/lib/notify.ts).
    await notifyTenantOwnersAndAdmins({
      client: req.tenantDb!,
      tenantId: req.tenantId!,
      excludeUserId: req.userId,
      type: "campaign.submitted_for_approval",
      title: "Campaign awaiting your approval",
      body: `Campaign "${existing.name}" was submitted for approval.`,
      linkUrl: `/tenants/${req.tenantId}/projects/${projectId}/campaigns/${campaignId}`,
    });

    res.status(201).json({ campaign: updated.rows[0], approval: approval.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/campaigns/:campaignId/members */
campaignsRouter.get("/:campaignId/members", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);
    await loadCampaignOr404(req.tenantDb!, req.tenantId!, projectId, campaignId);

    const members = await req.tenantDb!.query(
      `SELECT cm.id, cm.status, cm.created_at, l.id AS lead_id, l.name, l.email, l.company, l.source
       FROM campaign_members cm
       JOIN leads l ON l.id = cm.lead_id
       WHERE cm.tenant_id = $1 AND cm.campaign_id = $2
       ORDER BY cm.created_at DESC`,
      [req.tenantId, campaignId],
    );
    res.json({ members: members.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/campaigns/:campaignId/members */
campaignsRouter.post("/:campaignId/members", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);
    const body = addMemberSchema.parse(req.body);

    await loadCampaignOr404(req.tenantDb!, req.tenantId!, projectId, campaignId);

    const lead = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
      body.leadId,
      req.tenantId,
      projectId,
    ]);
    if (lead.rowCount === 0) throw Errors.notFound("Lead not found in this project");

    const existing = await req.tenantDb!.query(
      "SELECT 1 FROM campaign_members WHERE tenant_id = $1 AND campaign_id = $2 AND lead_id = $3",
      [req.tenantId, campaignId, body.leadId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw Errors.conflict("This lead is already attached to the campaign");
    }

    const result = await req.tenantDb!.query(
      `INSERT INTO campaign_members (tenant_id, campaign_id, lead_id, added_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, campaign_id, lead_id, status, created_at`,
      [req.tenantId, campaignId, body.leadId, req.userId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'campaign.member_added', 'campaign', $3, $4::jsonb)`,
      [req.tenantId, req.userId, campaignId, JSON.stringify({ leadId: body.leadId })],
    );

    res.status(201).json({ member: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
