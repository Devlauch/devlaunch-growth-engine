import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import type { DealStage } from "../lib/salesPipeline.js";
import { computeDealHealth, type DealHealthSignals } from "../lib/dealHealth.js";
import { computePipelineForecast } from "../lib/pipelineForecast.js";
import { computeLostDealAnalysis } from "../lib/lostDealAnalysis.js";
import type { ReplyClassification } from "../lib/classifyReply.js";

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

/** This project's real deal-value sample needs at least this many OTHER
 * priced deals before "typical deal size" means anything — otherwise the
 * size-relative health signal is honestly skipped (see dealHealth.ts). */
const MIN_DEALS_FOR_TYPICAL_VALUE = 3;

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

    const [
      meetingResult,
      replyResult,
      meetingActivityResult,
      replyActivityResult,
      noteActivityResult,
      taskActivityResult,
      typicalValueResult,
    ] = await Promise.all([
      // Prefer a meeting explicitly tied to this deal; fall back to the
      // lead's most recent meeting if none is deal-specific (meetings.deal_id
      // is nullable — 280_create_meetings.sql).
      req.tenantDb!.query<{ status: string; next_step: string | null; scheduled_at: string }>(
        `SELECT status, next_step, scheduled_at FROM meetings
         WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3 AND (deal_id = $4 OR deal_id IS NULL)
         ORDER BY (deal_id = $4) DESC, scheduled_at DESC
         LIMIT 1`,
        [req.tenantId, projectId, deal.lead_id, dealId],
      ),
      req.tenantDb!.query<{ classification: string; received_at: string }>(
        `SELECT classification, received_at FROM lead_replies
         WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
         ORDER BY received_at DESC LIMIT 1`,
        [req.tenantId, projectId, deal.lead_id],
      ),
      req.tenantDb!.query<{ max: string | null }>(
        `SELECT MAX(scheduled_at) FROM meetings WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [req.tenantId, projectId, deal.lead_id],
      ),
      req.tenantDb!.query<{ max: string | null }>(
        `SELECT MAX(received_at) FROM lead_replies WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [req.tenantId, projectId, deal.lead_id],
      ),
      req.tenantDb!.query<{ max: string | null }>(
        `SELECT MAX(created_at) FROM notes WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [req.tenantId, projectId, deal.lead_id],
      ),
      req.tenantDb!.query<{ max: string | null }>(
        `SELECT MAX(updated_at) FROM crm_tasks WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [req.tenantId, projectId, deal.lead_id],
      ),
      req.tenantDb!.query<{ avg_value: string | null; cnt: string }>(
        `SELECT AVG(value_amount) AS avg_value, COUNT(*) AS cnt FROM deals
         WHERE tenant_id = $1 AND project_id = $2 AND value_amount IS NOT NULL AND id != $3`,
        [req.tenantId, projectId, dealId],
      ),
    ]);

    const activityTimestamps = [meetingActivityResult, replyActivityResult, noteActivityResult, taskActivityResult]
      .map((r) => r.rows[0]?.max)
      .filter((v): v is string => Boolean(v));
    const lastActivityAt =
      activityTimestamps.length > 0
        ? activityTimestamps.reduce((latest, t) => (new Date(t) > new Date(latest) ? t : latest))
        : null;

    const typicalCount = Number(typicalValueResult.rows[0]?.cnt ?? 0);
    const typicalAvg = typicalValueResult.rows[0]?.avg_value ?? null;
    const typicalDealValue = typicalCount >= MIN_DEALS_FOR_TYPICAL_VALUE && typicalAvg !== null ? Number(typicalAvg) : null;

    const signals: DealHealthSignals = {
      latestMeeting: meetingResult.rows[0] ?? null,
      latestReply: replyResult.rows[0]
        ? {
            classification: replyResult.rows[0].classification as ReplyClassification,
            received_at: replyResult.rows[0].received_at,
          }
        : null,
      lastActivityAt,
      typicalDealValue,
    };

    const health = computeDealHealth(
      {
        stage: deal.stage,
        stage_changed_at: deal.stage_changed_at,
        created_at: deal.created_at,
        value_amount: deal.value_amount,
      },
      signals,
    );

    res.json({ dealId, score: health.score, why: health.why });
  } catch (err) {
    next(err);
  }
});
