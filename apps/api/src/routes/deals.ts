import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { DEAL_STAGES, STAGE_STALL_THRESHOLD_DAYS, assertActiveTenantMember, checkStalledDeals } from "../lib/salesPipeline.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/deals
 *
 * Sales Conversion Agent (roadmap items 6/7): the real sales pipeline
 * (`deals`, packages/db/migrations/278_create_deals.sql) plus lead
 * assignment (`lead_assignments`,
 * packages/db/migrations/279_create_lead_assignments.sql). Both tables are
 * tenant/project-scoped and real RLS-protected
 * (283_enable_rls_sales_conversion.sql); every number here is a real SQL
 * read/write, nothing fabricated.
 *
 * Lead assignment lives in this same router (rather than a separate route
 * file) since it is a thin adjunct to the sales pipeline, not an
 * independent feature — same "don't invent a parallel structure" reasoning
 * as sequenceEnrollmentsRouter being nested inside sequencesRouter.
 */
export const dealsRouter = Router({ mergeParams: true });
dealsRouter.use(requireAuth, requireTenantMembership);

const DEAL_COLUMNS = `id, tenant_id, project_id, lead_id, stage, value_amount, expected_close_date, owner_user_id, created_by, lost_reason, won_reason, stage_changed_at, created_at, updated_at`;
const ASSIGNMENT_COLUMNS = `id, tenant_id, project_id, lead_id, assigned_user_id, assigned_by, assigned_at, created_at`;

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

async function assertLeadInProject(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3", [
    leadId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
}

async function loadDealOr404(req: Request, projectId: string, dealId: string) {
  const r = await req.tenantDb!.query(
    `SELECT ${DEAL_COLUMNS} FROM deals WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [dealId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Deal not found");
  return r.rows[0];
}

const createDealSchema = z.object({
  leadId: z.string().uuid(),
  stage: z.enum(DEAL_STAGES).default("new"),
  valueAmount: z.number().nonnegative().max(999_999_999.99).optional(),
  expectedCloseDate: z.string().date().optional(),
  ownerUserId: z.string().uuid().optional(),
});

/** POST /deals */
dealsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createDealSchema.parse(req.body);
    await assertLeadInProject(req, projectId, body.leadId);
    if (body.ownerUserId) await assertActiveTenantMember(req.tenantDb!, req.tenantId!, body.ownerUserId);

    const result = await req.tenantDb!.query(
      `INSERT INTO deals (tenant_id, project_id, lead_id, stage, value_amount, expected_close_date, owner_user_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${DEAL_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.leadId,
        body.stage,
        body.valueAmount ?? null,
        body.expectedCloseDate ?? null,
        body.ownerUserId ?? null,
        req.userId,
      ],
    );
    const deal = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'deal.created', 'deal', $3, $4::jsonb)`,
      [req.tenantId, req.userId, deal.id, JSON.stringify({ leadId: body.leadId, stage: body.stage })],
    );

    res.status(201).json({ deal });
  } catch (err) {
    next(err);
  }
});

/** GET /deals — filterable by stage/leadId */
dealsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const stage = typeof req.query.stage === "string" ? req.query.stage : undefined;
    if (stage) z.enum(DEAL_STAGES).parse(stage);
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    if (leadId) z.string().uuid().parse(leadId);

    const result = await req.tenantDb!.query(
      `SELECT ${DEAL_COLUMNS} FROM deals
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::text IS NULL OR stage = $3)
         AND ($4::uuid IS NULL OR lead_id = $4)
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.tenantId, projectId, stage ?? null, leadId ?? null],
    );
    res.json({ deals: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /deals/customers — real customers (won deals), read from the
 * `customers` VIEW (278_create_deals.sql). Explicitly filtered by
 * tenant_id/project_id here, same reasoning as that view's header comment.
 */
dealsRouter.get("/customers", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT lead_id, tenant_id, project_id, name, email, company, won_deal_id, won_deal_value, won_at
       FROM customers
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY won_at DESC
       LIMIT 200`,
      [req.tenantId, projectId],
    );
    res.json({ customers: result.rows });
  } catch (err) {
    next(err);
  }
});

const assignLeadSchema = z.object({
  leadId: z.string().uuid(),
  assignedUserId: z.string().uuid(),
});

/** POST /deals/assignments — assign (or reassign) a lead to a real tenant member */
dealsRouter.post("/assignments", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = assignLeadSchema.parse(req.body);
    await assertLeadInProject(req, projectId, body.leadId);
    await assertActiveTenantMember(req.tenantDb!, req.tenantId!, body.assignedUserId);

    const result = await req.tenantDb!.query(
      `INSERT INTO lead_assignments (tenant_id, project_id, lead_id, assigned_user_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ASSIGNMENT_COLUMNS}`,
      [req.tenantId, projectId, body.leadId, body.assignedUserId, req.userId],
    );
    const assignment = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'lead.assigned', 'lead', $3, $4::jsonb)`,
      [req.tenantId, req.userId, body.leadId, JSON.stringify({ assignedUserId: body.assignedUserId })],
    );

    res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

/** GET /deals/assignments/:leadId — current (most recent) assignment for a lead */
dealsRouter.get("/assignments/:leadId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await assertLeadInProject(req, projectId, leadId);

    const result = await req.tenantDb!.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM lead_assignments
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY assigned_at DESC
       LIMIT 1`,
      [req.tenantId, projectId, leadId],
    );
    res.json({ assignment: result.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /deals/check-stalled — manually run the stalled-deal follow-up
 * check (no cron/scheduler infra exists in this codebase; same gap/
 * workaround as POST .../sequences/advance).
 */
dealsRouter.post("/check-stalled", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const created = await checkStalledDeals(req.tenantDb!, req.tenantId!, projectId);
    res.json({ followUpsCreated: created, thresholdDays: STAGE_STALL_THRESHOLD_DAYS });
  } catch (err) {
    next(err);
  }
});

/** GET /deals/:id */
dealsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const dealId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const deal = await loadDealOr404(req, projectId, dealId);
    res.json({ deal });
  } catch (err) {
    next(err);
  }
});

const updateDealSchema = z
  .object({
    stage: z.enum(DEAL_STAGES).optional(),
    valueAmount: z.number().nonnegative().max(999_999_999.99).nullish(),
    expectedCloseDate: z.string().date().nullish(),
    ownerUserId: z.string().uuid().nullish(),
    // Ported from milestone3-phase2 (packages/db/migrations/
    // 442_add_outcome_reasons_to_deals.sql): the spec's "record lost/won
    // outcomes" requirement — moving a deal to 'lost' requires a reason,
    // moving to 'won' accepts an optional one. This does not change which
    // stage transitions are allowed (still unrestricted, per this file's
    // own header comment) — only what's required alongside a transition
    // to these two specific stages.
    lostReason: z.string().trim().min(1).max(2000).optional(),
    wonReason: z.string().trim().min(1).max(2000).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.stage === "lost" && !body.lostReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lostReason is required when moving a deal to the 'lost' stage",
        path: ["lostReason"],
      });
    }
  });

/**
 * PATCH /deals/:id — update stage/value/expected close date/owner. A real
 * stage change bumps stage_changed_at to now() (the API layer, not a DB
 * trigger — see 278_create_deals.sql's header comment), which is what
 * drives the stalled-deal follow-up check. Reaching 'won' is what makes a
 * lead appear in the `customers` view.
 *
 * lostReason/wonReason (packages/db/migrations/
 * 442_add_outcome_reasons_to_deals.sql, ported from milestone3-phase2):
 * moving a deal to 'lost' requires lostReason in the body (rejected
 * otherwise); moving to 'won' accepts an optional wonReason. This does not
 * add a transition-adjacency restriction — any stage can still move to any
 * other stage, per this file's own header comment — it only requires a
 * reason alongside these two specific target stages.
 */
dealsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const dealId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const existing = await loadDealOr404(req, projectId, dealId);
    const body = updateDealSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw Errors.badRequest("At least one field is required");
    }
    if (body.ownerUserId) await assertActiveTenantMember(req.tenantDb!, req.tenantId!, body.ownerUserId);

    const stageChanged = body.stage !== undefined && body.stage !== existing.stage;

    const result = await req.tenantDb!.query(
      `UPDATE deals
       SET stage = COALESCE($3, stage),
           value_amount = CASE WHEN $4::boolean THEN $5 ELSE value_amount END,
           expected_close_date = CASE WHEN $6::boolean THEN $7 ELSE expected_close_date END,
           owner_user_id = CASE WHEN $8::boolean THEN $9 ELSE owner_user_id END,
           lost_reason = CASE WHEN $3 = 'lost' THEN $11 ELSE lost_reason END,
           won_reason = CASE WHEN $3 = 'won' THEN $12 ELSE won_reason END,
           stage_changed_at = CASE WHEN $10::boolean THEN now() ELSE stage_changed_at END
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${DEAL_COLUMNS}`,
      [
        dealId,
        req.tenantId,
        body.stage ?? null,
        "valueAmount" in body,
        body.valueAmount ?? null,
        "expectedCloseDate" in body,
        body.expectedCloseDate ?? null,
        "ownerUserId" in body,
        body.ownerUserId ?? null,
        stageChanged,
        body.lostReason ?? null,
        body.wonReason ?? null,
      ],
    );
    const deal = result.rows[0];

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'deal.updated', 'deal', $3, $4::jsonb)`,
      [req.tenantId, req.userId, dealId, JSON.stringify({ ...body, stageChanged })],
    );

    res.json({ deal });
  } catch (err) {
    next(err);
  }
});
