import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

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

// ---------------------------------------------------------------------------
// scoring_rubrics
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/scoring-rubrics */
export const scoringRubricsRouter = Router({ mergeParams: true });
scoringRubricsRouter.use(requireAuth, requireTenantMembership);

const rubricCriterionSchema = z.object({
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(500),
  weight: z.number().positive(),
  description: z.string().trim().max(2000).optional(),
});

const createRubricSchema = z.object({
  name: z.string().trim().min(1).max(200),
  criteria: z.array(rubricCriterionSchema).min(1).max(100).default([]),
  isActive: z.boolean().optional(),
});

const updateRubricSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    criteria: z.array(rubricCriterionSchema).min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

/** GET /scoring-rubrics */
scoringRubricsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
      [req.tenantId, projectId],
    );
    res.json({ scoringRubrics: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /scoring-rubrics */
scoringRubricsRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createRubricSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO scoring_rubrics (tenant_id, project_id, name, criteria, is_active)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [req.tenantId, projectId, body.name, JSON.stringify(body.criteria), body.isActive ?? true],
    );

    res.status(201).json({ scoringRubric: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** PATCH /scoring-rubrics/:id */
scoringRubricsRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const rubricId = paramId(req, "id");
    await assertProjectInTenant(req, projectId);
    const body = updateRubricSchema.parse(req.body);

    const existing = await req.tenantDb!.query(
      `SELECT 1 FROM scoring_rubrics WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [rubricId, req.tenantId, projectId],
    );
    if (existing.rowCount === 0) throw Errors.notFound("Scoring rubric not found");

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) {
      fields.push(`name = $${++i}`);
      values.push(body.name);
    }
    if (body.criteria !== undefined) {
      fields.push(`criteria = $${++i}::jsonb`);
      values.push(JSON.stringify(body.criteria));
    }
    if (body.isActive !== undefined) {
      fields.push(`is_active = $${++i}`);
      values.push(body.isActive);
    }

    const result = await req.tenantDb!.query(
      `UPDATE scoring_rubrics SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      [rubricId, ...values],
    );

    res.json({ scoringRubric: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// lead_scores (+ lead_score_feedback)
// ---------------------------------------------------------------------------

/** Mounted at /api/v1/tenants/:tenantId/projects/:projectId/lead-scores */
export const leadScoresRouter = Router({ mergeParams: true });
leadScoresRouter.use(requireAuth, requireTenantMembership);

async function loadLeadOr404(req: Request, projectId: string, leadId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, req.tenantId, projectId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Lead not found");
  return r.rows[0];
}

/** GET /lead-scores/:leadId — the current score for a lead, 404 if none exists yet. */
leadScoresRouter.get("/:leadId", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM lead_scores WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, req.tenantId, projectId],
    );
    if (result.rowCount === 0) throw Errors.notFound("No score computed for this lead yet");

    res.json({ leadScore: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

const feedbackSchema = z.object({
  feedback: z.enum(["good", "bad"]),
  note: z.string().trim().max(2000).optional(),
});

/** POST /lead-scores/:leadId/feedback — "good lead / bad lead" button. */
leadScoresRouter.post("/:leadId/feedback", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);
    const body = feedbackSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO lead_score_feedback (tenant_id, lead_id, user_id, feedback, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.tenantId, leadId, req.userId, body.feedback, body.note ?? null],
    );

    res.status(201).json({ feedback: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /lead-scores/:leadId/recompute
 *
 * TODO(scoring-pipeline): a real recompute needs (1) the project's active
 * scoring_rubrics row, (2) an evidence map assembled per-criterion from
 * this lead's custom_fields plus any discovered_organizations/
 * discovered_contacts row joined by matching email domain/company name,
 * and (3) a call to the `lead-scoring` agent (apps/worker/src/agents/
 * leadScoring.ts, runLeadScoring) — most naturally via the same
 * agent_instances/agent_executions + BullMQ enqueue path agentRuns.ts
 * already uses (apps/api/src/lib/queue.ts), so this becomes an async
 * queued run rather than a synchronous one. apps/api has no dependency on
 * @devlaunch/worker today (agents only run inside the worker process), and
 * the discovered_contacts/discovered_organizations join-by-domain-or-email
 * logic needs product input on precedence (e.g. which discovered_contact
 * "wins" when several match) before it's safe to guess at. Left as a
 * documented stub rather than inventing either a fake evidence join or a
 * second, duplicate scoring implementation inside the API process.
 */
leadScoresRouter.post("/:leadId/recompute", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    const leadId = paramId(req, "leadId");
    await assertProjectInTenant(req, projectId);
    await loadLeadOr404(req, projectId, leadId);

    res.status(501).json({
      error: {
        code: "not_implemented",
        message:
          "Recompute is not yet wired to evidence sources. Lead scores are currently populated by whatever " +
          "process invokes the lead-scoring agent and writes a lead_scores row directly; see the TODO comment " +
          "in apps/api/src/routes/scoring.ts for what's left.",
      },
    });
  } catch (err) {
    next(err);
  }
});
