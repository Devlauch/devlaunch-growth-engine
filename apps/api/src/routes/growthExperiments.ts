import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { requireRole, GTM_ROLES } from "../middleware/rbac.js";
import { Errors } from "../lib/httpError.js";
import {
  GROWTH_EXPERIMENT_COLUMNS,
  loadExperimentOr404,
  evaluateExperiment,
  applyWinningVariant,
} from "../lib/experimentEngine.js";

export const growthExperimentsRouter = Router({ mergeParams: true });
growthExperimentsRouter.use(requireAuth, requireTenantMembership);

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

const variantSchema = z.object({
  key: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  weight: z.number().positive().max(1000000),
});

const createExperimentSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    hypothesis: z.string().trim().max(5000).optional(),
    targetEntityType: z.enum(["landing_page", "form", "email_subject", "cta"]),
    targetEntityId: z.string().uuid(),
    variants: z.array(variantSchema).min(2).max(10),
    primaryMetricEvent: z.string().trim().min(1).max(200),
    minSampleSize: z.number().int().positive().max(10000000).optional(),
  })
  .refine((body) => new Set(body.variants.map((v) => v.key)).size === body.variants.length, {
    message: "Variant keys must be unique within an experiment",
  });

const updateExperimentSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    hypothesis: z.string().trim().max(5000).optional(),
    status: z.enum(["draft", "running", "abandoned"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" });

growthExperimentsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const result = await req.tenantDb!.query(
      `SELECT ${GROWTH_EXPERIMENT_COLUMNS} FROM growth_experiments
       WHERE tenant_id = $1 AND project_id = $2 AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC`,
      [req.tenantId, projectId, statusFilter ?? null],
    );
    res.json({ experiments: result.rows });
  } catch (err) {
    next(err);
  }
});

growthExperimentsRouter.post("/", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = createExperimentSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO growth_experiments (
         tenant_id, project_id, name, hypothesis, target_entity_type, target_entity_id,
         variants, primary_metric_event, min_sample_size, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING ${GROWTH_EXPERIMENT_COLUMNS}`,
      [
        req.tenantId,
        projectId,
        body.name,
        body.hypothesis ?? null,
        body.targetEntityType,
        body.targetEntityId,
        JSON.stringify(body.variants),
        body.primaryMetricEvent,
        body.minSampleSize ?? 100,
        req.userId,
      ],
    );
    res.status(201).json({ experiment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

growthExperimentsRouter.get("/:id", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const experimentId = paramId(req, "id");
    const experiment = await loadExperimentOr404(req.tenantDb!, req.tenantId as string, experimentId);
    if (experiment.project_id !== projectId) throw Errors.notFound("Growth experiment not found");
    res.json({ experiment });
  } catch (err) {
    next(err);
  }
});

growthExperimentsRouter.patch("/:id", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const experimentId = paramId(req, "id");
    const existing = await loadExperimentOr404(req.tenantDb!, req.tenantId as string, experimentId);
    if (existing.project_id !== projectId) throw Errors.notFound("Growth experiment not found");
    const body = updateExperimentSchema.parse(req.body);

    if (body.status === "running" && existing.status !== "draft") {
      throw Errors.conflict("Only a draft experiment can be started");
    }
    if (body.status === "abandoned" && existing.status === "concluded") {
      throw Errors.conflict("A concluded experiment cannot be abandoned");
    }

    const startedAtClause = body.status === "running" && existing.started_at === null;

    const result = await req.tenantDb!.query(
      `UPDATE growth_experiments SET
         name = $1, hypothesis = $2, status = $3,
         started_at = CASE WHEN $4 THEN now() ELSE started_at END
       WHERE id = $5 AND tenant_id = $6 AND project_id = $7
       RETURNING ${GROWTH_EXPERIMENT_COLUMNS}`,
      [
        body.name ?? existing.name,
        body.hypothesis ?? existing.hypothesis,
        body.status ?? existing.status,
        startedAtClause,
        experimentId,
        req.tenantId,
        projectId,
      ],
    );
    res.json({ experiment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

growthExperimentsRouter.delete("/:id", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const experimentId = paramId(req, "id");
    const existing = await loadExperimentOr404(req.tenantDb!, req.tenantId as string, experimentId);
    if (existing.project_id !== projectId) throw Errors.notFound("Growth experiment not found");
    if (existing.status !== "draft") {
      throw Errors.conflict("Only a draft experiment can be deleted -- abandon a running one instead");
    }

    await req.tenantDb!.query(`DELETE FROM growth_experiments WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
      experimentId,
      req.tenantId,
      projectId,
    ]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

growthExperimentsRouter.get("/:id/evaluate", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const experimentId = paramId(req, "id");
    const existing = await loadExperimentOr404(req.tenantDb!, req.tenantId as string, experimentId);
    if (existing.project_id !== projectId) throw Errors.notFound("Growth experiment not found");

    const evaluation = await evaluateExperiment(req.tenantDb!, req.tenantId as string, experimentId);
    res.json({ evaluation });
  } catch (err) {
    next(err);
  }
});

growthExperimentsRouter.post("/:id/apply-winner", requireRole(...GTM_ROLES), async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const experimentId = paramId(req, "id");
    const existing = await loadExperimentOr404(req.tenantDb!, req.tenantId as string, experimentId);
    if (existing.project_id !== projectId) throw Errors.notFound("Growth experiment not found");

    const outcome = await applyWinningVariant(req.tenantDb!, req.tenantId as string, experimentId, req.userId as string);
    res.status(201).json(outcome);
  } catch (err) {
    next(err);
  }
});

export default growthExperimentsRouter;
