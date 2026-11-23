import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { computeNpsScore, computeCsatScore } from "../lib/surveyEngine.js";
import { getFormAbandonmentStats } from "../lib/formAbandonmentTracking.js";

/**
 * Authenticated survey CRUD + NPS/CSAT/abandonment dashboards. Mounted
 * under the existing tenant/project prefix, same convention as
 * routes/seoCampaigns.ts etc:
 *   app.use(
 *     "/api/v1/tenants/:tenantId/projects/:projectId/surveys",
 *     mainCors,
 *     surveysRouter,
 *   );
 */
export const surveysRouter = Router({ mergeParams: true });
surveysRouter.use(requireAuth, requireTenantMembership);

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

async function loadSurveyOr404(req: Request, projectId: string, surveyId: string) {
  const r = await req.tenantDb!.query(`SELECT * FROM surveys WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
    surveyId,
    req.tenantId,
    projectId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Survey not found");
  return r.rows[0];
}

const questionSchema = z.object({
  key: z.string().trim().min(1).max(100),
  type: z.enum(["text", "single_choice", "multi_choice", "rating", "nps", "csat"]),
  label: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().max(200)).optional(),
  conditionalOn: z
    .object({
      questionKey: z.string().trim().min(1).max(100),
      equals: z.unknown().optional(),
      notEquals: z.unknown().optional(),
      in: z.array(z.unknown()).optional(),
    })
    .optional(),
});

const createSurveySchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(["multi_step_form", "nps", "csat", "post_demo_feedback", "qualification"]),
  questions: z.array(questionSchema).default([]),
  status: z.enum(["draft", "active", "archived"]).optional(),
});

const updateSurveySchema = createSurveySchema.partial();

/** GET /:projectId/surveys — list this project's surveys, newest first. */
surveysRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const result = await req.tenantDb!.query(
      `SELECT * FROM surveys WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ surveys: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /:projectId/surveys — create a new survey (draft by default). */
surveysRouter.post("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createSurveySchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO surveys (tenant_id, project_id, name, type, questions, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [req.tenantId, projectId, body.name, body.type, JSON.stringify(body.questions), body.status ?? "draft"],
    );
    res.status(201).json({ survey: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /:projectId/surveys/:id */
surveysRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const survey = await loadSurveyOr404(req, projectId, paramId(req, "id"));
    res.json({ survey });
  } catch (err) {
    next(err);
  }
});

/** PATCH /:projectId/surveys/:id — update name/type/questions/status. */
surveysRouter.patch("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const surveyId = paramId(req, "id");
    await loadSurveyOr404(req, projectId, surveyId);
    const body = updateSurveySchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `UPDATE surveys
         SET name = COALESCE($1, name),
             type = COALESCE($2, type),
             questions = COALESCE($3::jsonb, questions),
             status = COALESCE($4, status)
       WHERE id = $5 AND tenant_id = $6 AND project_id = $7
       RETURNING *`,
      [
        body.name ?? null,
        body.type ?? null,
        body.questions ? JSON.stringify(body.questions) : null,
        body.status ?? null,
        surveyId,
        req.tenantId,
        projectId,
      ],
    );
    res.json({ survey: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /:projectId/surveys/:id — also drops its responses (ON DELETE CASCADE, 632's FK). */
surveysRouter.delete("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const surveyId = paramId(req, "id");
    await loadSurveyOr404(req, projectId, surveyId);
    await req.tenantDb!.query(`DELETE FROM surveys WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
      surveyId,
      req.tenantId,
      projectId,
    ]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const listResponsesQuerySchema = z.object({
  completed: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /:projectId/surveys/:id/responses — raw response rows for review/export. */
surveysRouter.get("/:id/responses", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const surveyId = paramId(req, "id");
    await loadSurveyOr404(req, projectId, surveyId);
    const query = listResponsesQuerySchema.parse(req.query);

    const conditions = ["tenant_id = $1", "survey_id = $2"];
    const params: unknown[] = [req.tenantId, surveyId];
    if (query.completed !== undefined) {
      params.push(query.completed === "true");
      conditions.push(`completed = $${params.length}`);
    }
    params.push(query.limit ?? 100);

    const result = await req.tenantDb!.query(
      `SELECT * FROM survey_responses WHERE ${conditions.join(" AND ")} ORDER BY started_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ responses: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /:projectId/surveys/:id/nps — real NPS dashboard (score/promoters/passives/detractors). */
surveysRouter.get("/:id/nps", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const surveyId = paramId(req, "id");
    await loadSurveyOr404(req, projectId, surveyId);

    const result = await req.tenantDb!.query<{ score: number | null }>(
      `SELECT score FROM survey_responses WHERE tenant_id = $1 AND survey_id = $2 AND completed = true`,
      [req.tenantId, surveyId],
    );
    res.json({ nps: computeNpsScore(result.rows) });
  } catch (err) {
    next(err);
  }
});

/** GET /:projectId/surveys/:id/csat — real CSAT dashboard (average/distribution/top-box %). */
surveysRouter.get("/:id/csat", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const surveyId = paramId(req, "id");
    await loadSurveyOr404(req, projectId, surveyId);

    const result = await req.tenantDb!.query<{ score: number | null }>(
      `SELECT score FROM survey_responses WHERE tenant_id = $1 AND survey_id = $2 AND completed = true`,
      [req.tenantId, surveyId],
    );
    res.json({ csat: computeCsatScore(result.rows) });
  } catch (err) {
    next(err);
  }
});

const dateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** GET /:projectId/surveys/:id/abandonment — real started-vs-completed-per-step funnel. */
surveysRouter.get("/:id/abandonment", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const surveyId = paramId(req, "id");
    await loadSurveyOr404(req, projectId, surveyId);
    const query = dateRangeQuerySchema.parse(req.query);

    const stats = await getFormAbandonmentStats(req.tenantDb!, req.tenantId!, projectId, surveyId, {
      from: query.from,
      to: query.to,
    });
    res.json({ abandonment: stats });
  } catch (err) {
    next(err);
  }
});
