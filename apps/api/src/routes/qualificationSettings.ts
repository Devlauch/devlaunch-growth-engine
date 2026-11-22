import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at
 * /api/v1/tenants/:tenantId/projects/:projectId/qualification-settings
 *
 * Ported from the isolated milestone3-phase2 branch (adapted to master's
 * naming/conventions; see
 * packages/db/migrations/442_create_qualification_settings.sql). Plain CRUD
 * (really just GET + upsert, since the migration's UNIQUE(project_id) makes
 * this one row per project) over `qualification_settings`. This file is
 * config storage ONLY — the actual "does a lead's score cross this
 * threshold" check still lives in apps/api/src/lib/leadPromotion.ts's
 * evaluateQualification(), which now reads this table's
 * min_score_to_qualify instead of its own hardcoded
 * QUALIFIED_SCORE_THRESHOLD constant when a row exists for the project
 * (falling back to that same constant otherwise). A project with no row
 * yet is a real, meaningful state ("use the default threshold"), not an
 * error to paper over — GET returns `{ qualificationSettings: null }`
 * rather than inventing a number.
 */
export const qualificationSettingsRouter = Router({ mergeParams: true });
qualificationSettingsRouter.use(requireAuth, requireTenantMembership);

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

const QUALIFICATION_SETTINGS_COLUMNS = `id, tenant_id, project_id, min_score_to_qualify, updated_by, created_at, updated_at`;

const upsertSchema = z.object({
  minScoreToQualify: z.number().int().min(0).max(100),
});

/** GET .../qualification-settings — null when this project has no custom threshold configured yet. */
qualificationSettingsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT ${QUALIFICATION_SETTINGS_COLUMNS} FROM qualification_settings WHERE tenant_id = $1 AND project_id = $2`,
      [req.tenantId, projectId],
    );
    res.json({ qualificationSettings: result.rowCount ? result.rows[0] : null });
  } catch (err) {
    next(err);
  }
});

/** PUT .../qualification-settings — upsert the project's single row. */
qualificationSettingsRouter.put("/", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = upsertSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO qualification_settings (tenant_id, project_id, min_score_to_qualify, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE SET
         min_score_to_qualify = EXCLUDED.min_score_to_qualify,
         updated_by = EXCLUDED.updated_by
       RETURNING ${QUALIFICATION_SETTINGS_COLUMNS}`,
      [req.tenantId, projectId, body.minScoreToQualify, req.userId],
    );

    res.status(200).json({ qualificationSettings: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
