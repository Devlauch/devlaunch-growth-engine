import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import {
  computeEngagementScore,
  detectIntentSignals,
  getLifecycleStage,
  getUnifiedTimeline,
  type LifecycleDealInput,
  type LifecycleLeadInput,
} from "../lib/unifiedCustomerProfile.js";
import { getNextBestActionForLead } from "../lib/nextBestAction.js";

/**
 * Workstream F ("Unified customer profile"). Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/unified-profile
 * (see this feature's handback for the exact app.ts line — deliberately NOT
 * applied here since app.ts is a concurrently-edited/hot file this round,
 * same convention as routes/leadActivity.ts's own doc comment).
 *
 * A thin HTTP wrapper over apps/api/src/lib/unifiedCustomerProfile.ts +
 * nextBestAction.ts's getNextBestActionForLead — this file has no queries
 * of its own beyond the existing project/lead existence checks every
 * lead-scoped route in this codebase already does (see
 * routes/leadActivity.ts, routes/priorityQueue.ts).
 */
export const customerIntelligenceRouter = Router({ mergeParams: true });
customerIntelligenceRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string): Promise<void> {
  const result = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (result.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadLeadAndDeals(
  req: Request,
  projectId: string,
  leadId: string,
): Promise<{ lead: LifecycleLeadInput; deals: LifecycleDealInput[] }> {
  const leadResult = await req.tenantDb!.query<{ status: string }>(
    `SELECT status FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, req.tenantId, projectId],
  );
  if (leadResult.rowCount === 0) throw Errors.notFound("Lead not found");

  const dealsResult = await req.tenantDb!.query<{ stage: string }>(
    `SELECT stage FROM deals WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
    [req.tenantId, projectId, leadId],
  );

  return { lead: leadResult.rows[0], deals: dealsResult.rows };
}

/**
 * GET /leads/:leadId/unified-profile
 *
 * Returns the merged timeline, engagement score + its contributing signals,
 * detected intent signals, lifecycle stage, and a per-lead next-best-action
 * — everything a unified customer-profile panel needs in one call.
 */
customerIntelligenceRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    const { lead, deals } = await loadLeadAndDeals(req, projectId, leadId);

    const timeline = await getUnifiedTimeline(req.tenantDb!, req.tenantId!, projectId, leadId);
    const engagement = computeEngagementScore(timeline);
    const intentSignals = detectIntentSignals(timeline);
    const lifecycleStage = getLifecycleStage(lead, deals);
    const nextBestAction = await getNextBestActionForLead(req.tenantDb!, req.tenantId!, projectId, leadId);

    res.json({
      timeline,
      engagementScore: engagement.score,
      engagementSignals: engagement.signals,
      intentSignals,
      lifecycleStage,
      nextBestAction,
    });
  } catch (err) {
    next(err);
  }
});
