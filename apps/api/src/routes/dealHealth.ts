import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import type { DealStage } from "../lib/salesPipeline.js";
import { computeDealHealthForDeal } from "../lib/dealHealth.js";
import { computePipelineForecast } from "../lib/pipelineForecast.js";
import { computeLostDealAnalysis } from "../lib/lostDealAnalysis.js";

/**
 * Mounted at the SAME base path as dealsRouter
 * (/api/v1/tenants/:tenantId/projects/:projectId/deals,
 * apps/api/src/routes/deals.ts) but kept in this wholly separate,
 * additive file — deals.ts is never edited (task constraint). Three new,
 * read-only analytics endpoints, each following this codebase's strict
 * anti-fabrication convention (growthRevenueAnalytics.ts: every number is
 * a real query, or an honest "insufficient_data"/"not_available" flag,
 * never a guess):
 *
 *   GET /forecast       -> apps/api/src/lib/pipelineForecast.ts
 *   GET /lost-analysis  -> apps/api/src/lib/lostDealAnalysis.ts
 *   GET /:dealId/health -> apps/api/src/lib/dealHealth.ts
 *
 * IMPORTANT wiring note (see this repo's app.ts): this router MUST be
 * mounted BEFORE dealsRouter on this same base path. dealsRouter has a
 * bare `GET /:id` handler (apps/api/src/routes/deals.ts) whose first line
 * is `z.string().uuid().parse(...)` — if dealsRouter is tried first,
 * `/deals/forecast` and `/deals/lost-analysis` would hit that handler,
 * fail uuid parsing on the literal string "forecast"/"lost-analysis", and
 * 400 before this router ever gets a turn. `/:dealId/health` is a
 * two-segment path and is unaffected either way, but mounting this router
 * first keeps all three new routes reachable regardless.
 */
export const dealHealthRouter = Router({ mergeParams: true });
dealHealthRouter.use(requireAuth, requireTenantMembership);

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

/**
 * GET /forecast — deterministic, stage-weighted pipeline forecast across
 * this project's open (non-terminal-stage) deals.
 */
dealHealthRouter.get("/forecast", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const forecast = await computePipelineForecast(req.tenantDb!, req.tenantId!, projectId);
    res.json({ forecast });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /lost-analysis — real, aggregated patterns across this project's
 * lost deals (time-to-loss, reply-classification correlation, objection
 * themes). Returns an honest `insufficientData` flag with too few lost
 * deals to be meaningful.
 */
dealHealthRouter.get("/lost-analysis", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const analysis = await computeLostDealAnalysis(req.tenantDb!, req.tenantId!, projectId);
    res.json({ lostDealAnalysis: analysis });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:dealId/health — deterministic 0-100 deal health score + a
 * human-readable "why" breakdown (see dealHealth.ts's computeDealHealth
 * for the full scoring rationale and its "pure, on-demand, no
 * persistence" design justification).
 */
dealHealthRouter.get("/:dealId/health", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const dealId = paramId(req, "dealId");
    await assertProjectInTenant(req, projectId);

    const dealResult = await req.tenantDb!.query<{
      id: string;
      lead_id: string;
      stage: DealStage;
      stage_changed_at: string;
      created_at: string;
      value_amount: string | null;
    }>(
      `SELECT id, lead_id, stage, stage_changed_at, created_at, value_amount
       FROM deals WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [dealId, req.tenantId, projectId],
    );
    if (dealResult.rowCount === 0) throw Errors.notFound("Deal not found");
    const deal = dealResult.rows[0];

    // Shared with growthAdvisor.ts's lateStageDealPoorHealthRule and
    // meetingPrep.ts's prep brief — see dealHealth.ts's
    // computeDealHealthForDeal header for why this is one function, not
    // three copies of the same five queries.
    const health = await computeDealHealthForDeal(req.tenantDb!, req.tenantId as string, projectId, {
      id: dealId,
      lead_id: deal.lead_id,
      stage: deal.stage,
      stage_changed_at: deal.stage_changed_at,
      created_at: deal.created_at,
      value_amount: deal.value_amount,
    });

    res.json({ dealId, score: health.score, why: health.why });
  } catch (err) {
    next(err);
  }
});
