import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, GTM_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";
import {
  scheduleContent,
  requestCalendarApproval,
  approveAndPublish,
  getCalendarForProject,
} from "../lib/socialContentCalendar.js";
import { attributeSocialEngagementToCampaign } from "../lib/socialCampaignAttribution.js";
import { summarizeConversationForHandoff, handoffToSales } from "../lib/conversationIntelligence.js";

/**
 * NOT YET MOUNTED — this agent was told not to edit app.ts. Mount this
 * router exactly where the other dedicated-integration routers are
 * mounted (apps/api/src/app.ts, right after the chatwoot/listmonk/postiz
 * lines, same mainCors convention), at:
 *
 *   app.use(
 *     "/api/v1/tenants/:tenantId/projects/:projectId/social-communication-intelligence",
 *     mainCors,
 *     socialCommunicationIntelligenceRouter,
 *   );
 *
 * And import it near the other route imports:
 *   import { socialCommunicationIntelligenceRouter } from "./routes/socialCommunicationIntelligence.js";
 *
 * Workstream H: orchestration on top of the existing, real Postiz
 * (postizIntegration.ts/postizClient.ts) and Chatwoot
 * (chatwootIntegration.ts/chatwootClient.ts/chatwootWebhooks.ts)
 * integrations — this router never talks to either provider directly, it
 * only calls the lib modules that do (socialContentCalendar.ts,
 * socialCampaignAttribution.ts, conversationIntelligence.ts).
 */
export const socialCommunicationIntelligenceRouter = Router({ mergeParams: true });
socialCommunicationIntelligenceRouter.use(requireAuth, requireTenantMembership);

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid(),
});

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [projectId, tenantId]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

// ---------------------------------------------------------------------------
// 1. Social content calendar: create, list, request approval, publish.
// ---------------------------------------------------------------------------

const scheduleSchema = z.object({
  platform: z.string().trim().min(1).max(100),
  contentDraft: z.string().trim().min(1).max(10_000),
  mediaRefs: z.array(z.unknown()).optional(),
  scheduledAt: z.string().datetime().optional(),
  campaignId: z.string().uuid().optional(),
});

/** POST .../social-communication-intelligence/calendar — create a calendar item (always approval_status='pending'). */
socialCommunicationIntelligenceRouter.post("/calendar", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const body = scheduleSchema.parse(req.body);

    const item = await scheduleContent(
      req.tenantDb!,
      tenantId,
      projectId,
      {
        platform: body.platform,
        contentDraft: body.contentDraft,
        mediaRefs: body.mediaRefs,
        scheduledAt: body.scheduledAt,
        campaignId: body.campaignId,
      },
      req.userId ?? null,
    );
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

/** GET .../social-communication-intelligence/calendar?from&to — list the project's calendar. */
socialCommunicationIntelligenceRouter.get("/calendar", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;

    const items = await getCalendarForProject(req.tenantDb!, tenantId, projectId, { from, to });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/** POST .../calendar/:itemId/request-approval — submits a pending item to the EXISTING approvals queue. */
socialCommunicationIntelligenceRouter.post(
  "/calendar/:itemId/request-approval",
  requireRole(...GTM_ROLES),
  async (req, res, next) => {
    try {
      const { tenantId, projectId } = paramsSchema.parse(req.params);
      await loadProjectOr404(req.tenantDb!, tenantId, projectId);
      const itemId = z.string().uuid().parse(req.params.itemId);

      const result = await requestCalendarApproval(req.tenantDb!, tenantId, itemId, req.userId ?? null);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST .../calendar/:itemId/approve-and-publish
 *
 * Despite the name, this does NOT itself approve anything — approveAndPublish()
 * (socialContentCalendar.ts) only proceeds past its gate once a real human
 * has already decided the linked `approvals` row 'approved' via the
 * EXISTING POST .../approvals/:approvalId/decision route. This endpoint is
 * what a human/agent calls AFTER that decision to actually trigger the real
 * Postiz publish call.
 */
socialCommunicationIntelligenceRouter.post(
  "/calendar/:itemId/approve-and-publish",
  requireRole(...GTM_ROLES),
  async (req, res, next) => {
    try {
      const { tenantId, projectId } = paramsSchema.parse(req.params);
      await loadProjectOr404(req.tenantDb!, tenantId, projectId);
      const itemId = z.string().uuid().parse(req.params.itemId);

      const item = await approveAndPublish(req.tenantDb!, tenantId, itemId, req.userId ?? null);
      res.json({ item });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// 2. Campaign attribution: social's real contribution to a campaign.
// ---------------------------------------------------------------------------

/** GET .../campaigns/:campaignId/attribution */
socialCommunicationIntelligenceRouter.get("/campaigns/:campaignId/attribution", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const campaignId = z.string().uuid().parse(req.params.campaignId);

    const result = await attributeSocialEngagementToCampaign(req.tenantDb!, tenantId, campaignId);
    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      next(Errors.notFound(err.message));
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 3. Conversation intelligence: summary + sales handoff.
// ---------------------------------------------------------------------------

/** GET .../conversations/:conversationId/summary */
socialCommunicationIntelligenceRouter.get("/conversations/:conversationId/summary", async (req, res, next) => {
  try {
    const { tenantId, projectId } = paramsSchema.parse(req.params);
    await loadProjectOr404(req.tenantDb!, tenantId, projectId);
    const conversationId = z.string().trim().min(1).parse(req.params.conversationId);

    const summary = await summarizeConversationForHandoff(req.tenantDb!, tenantId, conversationId);
    res.json({ summary });
  } catch (err) {
    next(err);
  }
});

const handoffSchema = z
  .object({
    leadId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.leadId) !== Boolean(v.dealId), {
    message: "Exactly one of leadId/dealId is required",
  });

/** POST .../conversations/:conversationId/handoff — body: { leadId } or { dealId }. */
socialCommunicationIntelligenceRouter.post(
  "/conversations/:conversationId/handoff",
  requireRole(...GTM_ROLES),
  async (req, res, next) => {
    try {
      const { tenantId, projectId } = paramsSchema.parse(req.params);
      await loadProjectOr404(req.tenantDb!, tenantId, projectId);
      const conversationId = z.string().trim().min(1).parse(req.params.conversationId);
      const body = handoffSchema.parse(req.body);

      const result = await handoffToSales(
        req.tenantDb!,
        tenantId,
        conversationId,
        { leadId: body.leadId, dealId: body.dealId },
        req.userId ?? null,
      );
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        next(Errors.notFound(err.message));
        return;
      }
      next(err);
    }
  },
);
