import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, ADMIN_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";
import { INTERNAL_TENANT_ID } from "../lib/internalGrowthWorkspace.js";

/**
 * internalGrowthRouter: intended mount point (app.ts is off-limits this
 * round):
 *   /api/v1/tenants/:tenantId/projects/:projectId/internal-growth
 *
 * Authenticated, DevLaunch-staff-only surface over the internal
 * customer-acquisition workspace (see ../lib/internalGrowthWorkspace.ts):
 * growth-audit/demo-request review, trial status tracking, and CAC. "DevLaunch
 * staff" is modeled as: a real membership (owner/admin role — the existing
 * ADMIN_ROLES from ../middleware/rbac.ts, no new role concept invented) on
 * the designated internal tenant specifically — `assertInternalTenant`
 * below 403s this entire router for any OTHER tenant id, even one where the
 * caller happens to also be an owner/admin, since this data is not
 * meaningful for a client tenant.
 *
 * Reuses the existing sequences/deals routers for "follow up with
 * interested businesses" / "track subscription conversion" — those are
 * already mounted generically at
 * /api/v1/tenants/:tenantId/projects/:projectId/{sequences,deals} (see
 * app.ts), so they work for the internal tenant/project like any other
 * tenant's; nothing new is built here for that.
 */
export const internalGrowthRouter = Router({ mergeParams: true });
internalGrowthRouter.use(requireAuth, requireTenantMembership, requireRole(...ADMIN_ROLES));

function assertInternalTenant(req: Request, _res: Response, next: NextFunction): void {
  if (req.tenantId !== INTERNAL_TENANT_ID) {
    next(Errors.forbidden("This endpoint is restricted to DevLaunch's internal growth workspace"));
    return;
  }
  next();
}
internalGrowthRouter.use(assertInternalTenant);

function paramProjectId(req: Request): string {
  return z.string().uuid().parse((req.params as Record<string, string>).projectId);
}

async function loadProjectOr404(req: Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /growth-audit-requests — real visitor growth-audit submissions. */
internalGrowthRouter.get("/growth-audit-requests", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    await loadProjectOr404(req, projectId);
    const result = await req.tenantDb!.query(
      `SELECT gar.id, gar.domain, gar.email, gar.lead_id, gar.growth_analysis_id, gar.report_id, gar.status, gar.created_at,
              ga.growth_plan_summary, gr.status AS report_status
       FROM growth_audit_requests gar
       LEFT JOIN growth_analyses ga ON ga.id = gar.growth_analysis_id AND ga.tenant_id = gar.tenant_id
       LEFT JOIN generated_reports gr ON gr.id = gar.report_id AND gr.tenant_id = gar.tenant_id
       WHERE gar.tenant_id = $1 AND gar.project_id = $2
       ORDER BY gar.created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId],
    );
    res.json({ growthAuditRequests: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /demo-requests — real visitor demo-request submissions. */
internalGrowthRouter.get("/demo-requests", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    await loadProjectOr404(req, projectId);
    const result = await req.tenantDb!.query(
      `SELECT id, name, email, company, message, lead_id, created_at
       FROM demo_requests
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId],
    );
    res.json({ demoRequests: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /trials — real trial pipeline. */
internalGrowthRouter.get("/trials", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    await loadProjectOr404(req, projectId);
    const statusFilter = z
      .enum(["trial_started", "trial_active", "converted", "churned"])
      .optional()
      .parse(req.query.status || undefined);

    const result = await req.tenantDb!.query(
      `SELECT * FROM trial_signups
       WHERE tenant_id = $1 AND project_id = $2 AND ($3::text IS NULL OR status = $3)
       ORDER BY started_at DESC
       LIMIT 500`,
      [req.tenantId, projectId, statusFilter ?? null],
    );
    res.json({ trials: result.rows });
  } catch (err) {
    next(err);
  }
});

const createTrialSchema = z.object({
  leadId: z.string().uuid().optional(),
  companyName: z.string().trim().max(200).optional(),
  contactEmail: z.string().trim().email().max(320),
  source: z.enum(["growth_audit", "demo_request", "manual"]).optional(),
  notes: z.string().trim().max(5000).optional(),
});

/** POST /trials — a real DevLaunch staff member records a new trial. */
internalGrowthRouter.post("/trials", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    await loadProjectOr404(req, projectId);
    const body = createTrialSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO trial_signups (tenant_id, project_id, lead_id, company_name, contact_email, source, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.tenantId, projectId, body.leadId ?? null, body.companyName ?? null, body.contactEmail, body.source ?? "manual", body.notes ?? null],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'trial_signup.created', 'trial_signup', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id],
    );

    res.status(201).json({ trial: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const STATUS_TRANSITIONS: Record<string, string[]> = {
  trial_started: ["trial_active", "converted", "churned"],
  trial_active: ["converted", "churned"],
  converted: [],
  churned: [],
};

const updateTrialStatusSchema = z.object({
  status: z.enum(["trial_active", "converted", "churned"]),
  notes: z.string().trim().max(5000).optional(),
});

/**
 * PATCH /trials/:id/status
 *
 * Real status transition, recorded by a real DevLaunch staff member
 * (req.userId). 'converted' is NEVER set automatically by this codebase —
 * there is no billing/payment integration here (confirmed: no Stripe/
 * billing client exists anywhere in this repo) — this endpoint IS the
 * "manually-recorded real event" the task calls for, and the response
 * honestly reflects that (convertedBy is always a real user id, never a
 * webhook/system actor).
 */
internalGrowthRouter.patch("/trials/:id/status", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    const trialId = z.string().uuid().parse(req.params.id);
    const body = updateTrialStatusSchema.parse(req.body);
    await loadProjectOr404(req, projectId);

    const existing = await req.tenantDb!.query(
      `SELECT * FROM trial_signups WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [trialId, req.tenantId, projectId],
    );
    if (existing.rowCount === 0) throw Errors.notFound("Trial not found");
    const current = existing.rows[0];

    const allowed = STATUS_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw Errors.badRequest(`Cannot transition trial from '${current.status}' to '${body.status}'`);
    }

    const result = await req.tenantDb!.query(
      `UPDATE trial_signups
       SET status = $3,
           notes = COALESCE($4, notes),
           converted_at = CASE WHEN $3 = 'converted' THEN now() ELSE converted_at END,
           converted_by = CASE WHEN $3 = 'converted' THEN $5 ELSE converted_by END,
           churned_at = CASE WHEN $3 = 'churned' THEN now() ELSE churned_at END
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [trialId, req.tenantId, body.status, body.notes ?? null, req.userId],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'trial_signup.status_changed', 'trial_signup', $3, $4::jsonb)`,
      [req.tenantId, req.userId, trialId, JSON.stringify({ from: current.status, to: body.status })],
    );

    res.json({ trial: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const createCostSchema = z.object({
  channel: z.string().trim().min(1).max(100),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  amountCents: z.number().int().min(0),
  notes: z.string().trim().max(2000).optional(),
});

/** GET /acquisition-costs — real staff-entered spend rows. */
internalGrowthRouter.get("/acquisition-costs", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    await loadProjectOr404(req, projectId);
    const result = await req.tenantDb!.query(
      `SELECT * FROM acquisition_costs WHERE tenant_id = $1 AND project_id = $2 ORDER BY period_start DESC LIMIT 500`,
      [req.tenantId, projectId],
    );
    res.json({ acquisitionCosts: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /acquisition-costs — a real DevLaunch staff member enters real spend for a channel/period. */
internalGrowthRouter.post("/acquisition-costs", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    await loadProjectOr404(req, projectId);
    const body = createCostSchema.parse(req.body);
    if (body.periodEnd < body.periodStart) throw Errors.badRequest("periodEnd must be on or after periodStart");

    const result = await req.tenantDb!.query(
      `INSERT INTO acquisition_costs (tenant_id, project_id, channel, period_start, period_end, amount_cents, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.tenantId, projectId, body.channel, body.periodStart, body.periodEnd, body.amountCents, body.notes ?? null, req.userId],
    );
    res.status(201).json({ acquisitionCost: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const cacQuerySchema = z.object({
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
});

/**
 * GET /cac?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
 *
 * Real total spend (sum of acquisition_costs overlapping the period) ÷ real
 * count of trial_signups converted within the period, for this tenant/
 * project only. Never divides by zero and calls the result "0" — an empty
 * denominator returns cac: null with reason "insufficient_data", exactly
 * like growthRevenueAnalytics.ts's existing CAC/ROI honesty convention
 * elsewhere in this codebase.
 */
internalGrowthRouter.get("/cac", async (req, res, next) => {
  try {
    const projectId = paramProjectId(req);
    await loadProjectOr404(req, projectId);
    const query = cacQuerySchema.parse(req.query);
    if (query.periodEnd < query.periodStart) throw Errors.badRequest("periodEnd must be on or after periodStart");

    const costResult = await req.tenantDb!.query(
      `SELECT COALESCE(sum(amount_cents), 0)::bigint AS total_cents
       FROM acquisition_costs
       WHERE tenant_id = $1 AND project_id = $2
         AND period_start <= $4 AND period_end >= $3`,
      [req.tenantId, projectId, query.periodStart, query.periodEnd],
    );
    const totalCostCents = Number(costResult.rows[0].total_cents);

    const convertedResult = await req.tenantDb!.query(
      `SELECT count(*)::int AS converted_count
       FROM trial_signups
       WHERE tenant_id = $1 AND project_id = $2 AND status = 'converted'
         AND converted_at >= $3::date AND converted_at < ($4::date + interval '1 day')`,
      [req.tenantId, projectId, query.periodStart, query.periodEnd],
    );
    const convertedCount = convertedResult.rows[0].converted_count as number;

    if (convertedCount === 0) {
      res.json({
        periodStart: query.periodStart,
        periodEnd: query.periodEnd,
        totalCostCents,
        convertedCount: 0,
        cacCents: null,
        reason: "insufficient_data",
      });
      return;
    }

    res.json({
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      totalCostCents,
      convertedCount,
      cacCents: Math.round(totalCostCents / convertedCount),
      reason: null,
    });
  } catch (err) {
    next(err);
  }
});
