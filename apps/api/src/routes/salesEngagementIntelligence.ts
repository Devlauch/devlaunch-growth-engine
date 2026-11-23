import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { getTouchpointHistory, getCorrelatedSiteEvents } from "../lib/multiTouchEngagement.js";
import { computeIntentScore } from "../lib/leadIntentScoring.js";
import { recommendFollowUp } from "../lib/followUpRecommendation.js";
import { computeConversionFunnelStats } from "../lib/prospectToMeetingAnalytics.js";
import type { DealStage } from "../lib/salesPipeline.js";

/**
 * salesEngagementIntelligenceRouter: Workstream G2 ("multi-touch sales
 * engagement tracking, lead intent scoring, follow-up recommendations, and
 * prospect-to-meeting conversion analytics").
 *
 * NOT mounted in app.ts by this task (file boundaries excluded app.ts —
 * same convention sequences.ts documents for itself). The exact mount line
 * for whoever wires this in:
 *
 *   import { salesEngagementIntelligenceRouter } from "./routes/salesEngagementIntelligence.js";
 *   app.use("/api/v1/tenants/:tenantId/projects/:projectId/sales-engagement-intelligence", mainCors, salesEngagementIntelligenceRouter);
 *
 * Every endpoint here is read-only and computes fresh on every request from
 * real tables (multiTouchEngagement.ts, leadIntentScoring.ts,
 * followUpRecommendation.ts, prospectToMeetingAnalytics.ts) — nothing is
 * written or cached, same "always-current, never-stale" convention as
 * dealHealth.ts.
 */
export const salesEngagementIntelligenceRouter = Router({ mergeParams: true });
salesEngagementIntelligenceRouter.use(requireAuth, requireTenantMembership);

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

async function loadLeadOr404(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query("SELECT id FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
}

/** Most recent deal's stage for this lead, or null if the lead has no deal yet — never guessed. */
async function loadLatestDealStage(req: Request, projectId: string, leadId: string): Promise<DealStage | null> {
  const r = await req.tenantDb!.query<{ stage: DealStage }>(
    `SELECT stage FROM deals WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
     ORDER BY created_at DESC LIMIT 1`,
    [req.tenantId, projectId, leadId],
  );
  return r.rows[0]?.stage ?? null;
}

/**
 * GET .../leads/:leadId/touchpoints — the full multi-touch engagement
 * history for one lead (multiTouchEngagement.ts's getTouchpointHistory).
 */
salesEngagementIntelligenceRouter.get("/leads/:leadId/touchpoints", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const touchpoints = await getTouchpointHistory(req.tenantDb!, req.tenantId!, projectId, leadId);
    res.json({ leadId, touchpoints });
  } catch (err) {
    next(err);
  }
});

/**
 * GET .../leads/:leadId/intent-score — deterministic intent score + tier +
 * explainable signals for one lead.
 */
salesEngagementIntelligenceRouter.get("/leads/:leadId/intent-score", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const [touchpoints, siteEventRows] = await Promise.all([
      getTouchpointHistory(req.tenantDb!, req.tenantId!, projectId, leadId),
      getCorrelatedSiteEvents(req.tenantDb!, req.tenantId!, projectId, leadId),
    ]);
    const siteEvents = siteEventRows.map((r) => ({ eventName: r.event_name, occurredAt: r.occurred_at }));
    const intent = computeIntentScore(touchpoints, siteEvents);

    res.json({ leadId, intent });
  } catch (err) {
    next(err);
  }
});

/**
 * GET .../leads/:leadId/follow-up-recommendation — deterministic next-step
 * recommendation for one lead, built from the same touchpoint history and
 * intent score the two endpoints above expose individually (so a caller
 * hitting all three sees internally-consistent numbers, not three
 * independently-recomputed drifting views).
 */
salesEngagementIntelligenceRouter.get("/leads/:leadId/follow-up-recommendation", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const [touchpoints, siteEventRows, dealStage] = await Promise.all([
      getTouchpointHistory(req.tenantDb!, req.tenantId!, projectId, leadId),
      getCorrelatedSiteEvents(req.tenantDb!, req.tenantId!, projectId, leadId),
      loadLatestDealStage(req, projectId, leadId),
    ]);
    const siteEvents = siteEventRows.map((r) => ({ eventName: r.event_name, occurredAt: r.occurred_at }));
    const intent = computeIntentScore(touchpoints, siteEvents);
    const recommendation = recommendFollowUp(touchpoints, intent, dealStage);

    res.json({ leadId, intent, dealStage, recommendation });
  } catch (err) {
    next(err);
  }
});

const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * GET .../conversion-funnel — project-level prospect -> reply -> meeting
 * funnel stats (prospectToMeetingAnalytics.ts). Defaults to the trailing
 * 90 days when `from`/`to` query params are omitted (a sensible default
 * window, documented here rather than silently assumed).
 */
salesEngagementIntelligenceRouter.get("/conversion-funnel", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const query = dateRangeSchema.parse(req.query);
    const to = query.to ?? new Date().toISOString();
    const from = query.from ?? new Date(new Date(to).getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const stats = await computeConversionFunnelStats(req.tenantDb!, req.tenantId!, projectId, { from, to });
    res.json({ conversionFunnel: stats });
  } catch (err) {
    next(err);
  }
});
