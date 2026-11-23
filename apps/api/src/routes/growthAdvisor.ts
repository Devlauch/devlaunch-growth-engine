import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, GTM_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";
import { runGrowthAdvisor, RECOMMENDATION_COLUMNS, type GrowthRecommendationRow } from "../lib/growthAdvisor.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/growth-advisor
 *
 * AI Growth Advisor: a deterministic recommendation feed (never an LLM
 * call — see apps/api/src/lib/growthAdvisor.ts's header comment) over real
 * data already in this schema (prospecting campaigns' email-verification
 * results, unassigned leads, landing-page conversion tracking, stuck
 * qualified leads, unresolved SEO audit issues). The one consequential
 * action it can take (round-robin auto-assigning unassigned leads) is never
 * performed directly by this router — it only drafts a row in the existing
 * `approvals` table (see prepare-action below), which a human must approve
 * via the existing POST .../approvals/:approvalId/decision endpoint before
 * anything real happens, same human-in-the-loop convention as every other
 * consequential action in this codebase.
 *
 * NOTE: this file is intentionally NOT wired into apps/api/src/app.ts by
 * this change — app.ts is off-limits in this round (another process wires
 * routers there to avoid merge conflicts). Mount it the same way
 * prospectingCampaignsRouter is mounted, once that's done elsewhere:
 *   app.use(
 *     "/api/v1/tenants/:tenantId/projects/:projectId/growth-advisor",
 *     growthAdvisorRouter,
 *   );
 */
export const growthAdvisorRouter = Router({ mergeParams: true });
growthAdvisorRouter.use(requireAuth, requireTenantMembership);

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadRecommendationOr404(req: Request, projectId: string, recommendationId: string): Promise<GrowthRecommendationRow> {
  const r = await req.tenantDb!.query<GrowthRecommendationRow>(
    `SELECT ${RECOMMENDATION_COLUMNS} FROM growth_advisor_recommendations
     WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [recommendationId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Growth recommendation not found");
  return r.rows[0];
}

const listQuerySchema = z.object({
  status: z.enum(["new", "acknowledged", "dismissed", "actioned"]).optional(),
});

/** GET / — list recommendations for this project, newest first, optional ?status= filter. */
growthAdvisorRouter.get("/recommendations", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const query = listQuerySchema.parse(req.query);

    const result = await req.tenantDb!.query<GrowthRecommendationRow>(
      `SELECT ${RECOMMENDATION_COLUMNS} FROM growth_advisor_recommendations
       WHERE tenant_id = $1 AND project_id = $2 AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC`,
      [req.tenantId, projectId, query.status ?? null],
    );
    res.json({ recommendations: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /run — runs every real growth-advisor rule for this tenant/project
 * right now (no cron/background job exists for this yet — a real, on-demand
 * run, same "manual-trigger only, documented honestly" convention as
 * several other analytics endpoints in this codebase) and upserts the
 * results. Restricted to GTM roles, same as every other write in this
 * router, since this both creates data and (for the one actionable rule)
 * surfaces a path toward a real CRM mutation.
 */
growthAdvisorRouter.post("/run", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const recommendations = await runGrowthAdvisor(req.tenantDb!, req.tenantId as string, projectId);

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'growth_advisor.run', 'project', $3, $4::jsonb)`,
      [req.tenantId, req.userId, projectId, JSON.stringify({ recommendationCount: recommendations.length })],
    );

    res.json({ recommendations });
  } catch (err) {
    next(err);
  }
});

/** POST /recommendations/:id/dismiss — a human says "not actionable right now." */
growthAdvisorRouter.post("/recommendations/:id/dismiss", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const recommendationId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    await loadRecommendationOr404(req, projectId, recommendationId);

    const result = await req.tenantDb!.query<GrowthRecommendationRow>(
      `UPDATE growth_advisor_recommendations SET status = 'dismissed'
       WHERE id = $1 AND tenant_id = $2 AND project_id = $3
       RETURNING ${RECOMMENDATION_COLUMNS}`,
      [recommendationId, req.tenantId, projectId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'growth_advisor.recommendation.dismissed', 'growth_advisor_recommendation', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, recommendationId],
    );

    res.json({ recommendation: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /recommendations/:id/prepare-action
 *
 * The ONE approval-gated action this advisor can prepare: for a
 * 'too_many_unassigned_leads' recommendation, drafts a real round-robin
 * auto-assign action (apps/api/src/lib/leadPromotion.ts's
 * autoAssignLeadRoundRobin is reused — not reimplemented — at execution
 * time, by the existing POST .../approvals/:approvalId/decision endpoint,
 * extended to resolve this one new approval subject type the same way it
 * already resolves campaign_id). This endpoint itself never assigns
 * anything — it only creates a `growth_advisor_actions` row (status
 * 'pending_approval') and a paired `approvals` row (status 'pending'),
 * reusing the exact INSERT INTO approvals pattern already used by
 * routes/campaigns.ts / routes/messaging.ts / routes/postizIntegration.ts.
 *
 * The lead id list is re-verified as still-unassigned right now (not
 * blindly trusted from the recommendation's possibly-stale evidence), so
 * the action that eventually executes always reflects live data.
 */
growthAdvisorRouter.post(
  "/recommendations/:id/prepare-action",
  requireRole(...GTM_ROLES),
  async (req, res, next) => {
    try {
      const projectId = paramId(req, "projectId");
      const recommendationId = paramId(req, "id");
      await assertProjectInTenant(req, projectId);
      const recommendation = await loadRecommendationOr404(req, projectId, recommendationId);

      if (recommendation.rule_key !== "too_many_unassigned_leads") {
        throw Errors.badRequest(
          `No approval-gated action is defined for rule "${recommendation.rule_key}". ` +
            `Only "too_many_unassigned_leads" has a prepared action today.`,
        );
      }
      if (recommendation.status === "dismissed") {
        throw Errors.conflict("This recommendation was dismissed — cannot prepare an action for it.");
      }

      // Re-verify live, not the recommendation's possibly-stale evidence.
      const freshUnassigned = await req.tenantDb!.query<{ lead_id: string }>(
        `SELECT l.id AS lead_id
         FROM leads l
         WHERE l.tenant_id = $1 AND l.project_id = $2
           AND l.status NOT IN ('rejected', 'archived')
           AND NOT EXISTS (SELECT 1 FROM lead_assignments la WHERE la.lead_id = l.id)
         ORDER BY l.created_at ASC
         LIMIT 50`,
        [req.tenantId, projectId],
      );
      const leadIds = freshUnassigned.rows.map((r) => r.lead_id);
      if (leadIds.length === 0) {
        throw Errors.conflict("No unassigned leads remain — nothing to prepare.");
      }

      const actionResult = await req.tenantDb!.query<{ id: string }>(
        `INSERT INTO growth_advisor_actions (tenant_id, project_id, recommendation_id, action_type, payload, created_by)
         VALUES ($1, $2, $3, 'auto_assign_leads', $4::jsonb, $5)
         RETURNING id, tenant_id, project_id, recommendation_id, action_type, payload, status, created_at`,
        [req.tenantId, projectId, recommendationId, JSON.stringify({ leadIds }), req.userId],
      );
      const action = actionResult.rows[0];

      const approvalResult = await req.tenantDb!.query<{ id: string }>(
        `INSERT INTO approvals (tenant_id, growth_advisor_action_id, requested_by, reason)
         VALUES ($1, $2, $3, $4)
         RETURNING id, growth_advisor_action_id, status, requested_by, requested_at`,
        [
          req.tenantId,
          action.id,
          req.userId,
          `Round-robin auto-assign ${leadIds.length} unassigned lead(s) (growth advisor recommendation ${recommendationId})`,
        ],
      );

      const updatedRecommendation = await req.tenantDb!.query<GrowthRecommendationRow>(
        `UPDATE growth_advisor_recommendations SET status = 'actioned'
         WHERE id = $1 AND tenant_id = $2 AND project_id = $3
         RETURNING ${RECOMMENDATION_COLUMNS}`,
        [recommendationId, req.tenantId, projectId],
      );

      await req.tenantDb!.query(
        `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'user', $2, 'growth_advisor.action.prepared', 'growth_advisor_action', $3, $4::jsonb)`,
        [req.tenantId, req.userId, action.id, JSON.stringify({ recommendationId, leadCount: leadIds.length, approvalId: approvalResult.rows[0].id })],
      );

      res.status(201).json({
        action,
        approval: approvalResult.rows[0],
        recommendation: updatedRecommendation.rows[0],
      });
    } catch (err) {
      next(err);
    }
  },
);

export default growthAdvisorRouter;
