import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { INDUSTRY_TEMPLATES, type IndustryKey } from "../lib/industryTemplates.js";

/**
 * Onboarding wizard (roadmap item 20): "Enter the website, offer and ICP,
 * and the app pre-fills the profile, rubric, pipeline and sequence
 * templates."
 *
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/onboarding.
 *
 * Every route here runs inside the request-scoped transaction opened by
 * requireTenantMembership (req.tenantDb) — see middleware/tenant.ts: it is
 * committed on a non-error response and rolled back otherwise, so the
 * multi-table writes POST /apply performs are already atomic without this
 * file needing its own BEGIN/COMMIT.
 */
export const onboardingRouter = Router({ mergeParams: true });
onboardingRouter.use(requireAuth, requireTenantMembership);

const INDUSTRY_KEYS = Object.keys(INDUSTRY_TEMPLATES) as IndustryKey[];

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

/** GET /templates — short previews only, enough for a wizard's industry picker. */
onboardingRouter.get("/templates", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);

    const templates = INDUSTRY_KEYS.map((key) => {
      const t = INDUSTRY_TEMPLATES[key];
      return {
        key,
        label: t.label,
        valuePropositionPreview: t.defaultValueProposition,
        icpProfileNames: t.icpProfiles.map((icp) => icp.name),
        scoringCriteriaCount: t.scoringCriteria.length,
        sequenceStepCount: t.sequenceTemplate.steps.length,
      };
    });

    res.json({ templates });
  } catch (err) {
    next(err);
  }
});

const applySchema = z.object({
  website: z.string().trim().url(),
  offer: z.string().trim().min(1).max(5000),
  industryTemplate: z.enum(INDUSTRY_KEYS as [IndustryKey, ...IndustryKey[]]),
});

/**
 * POST /apply — applies an industry template to this project:
 *   1. Upserts project_profiles (website/offer/industry).
 *   2. Inserts the template's ICP profiles, skipping any whose name already
 *      exists for this project (icp_profiles has no DB uniqueness
 *      constraint on (project_id, name) — see
 *      packages/db/migrations/007_create_icp_profiles.sql — so this is an
 *      app-level idempotency guard rather than an ON CONFLICT).
 *   3. Inserts a new scoring_rubrics row. If an active rubric already
 *      exists for the project, the new one is created with is_active:
 *      false instead of silently deactivating tenant-owned config. If a
 *      rubric from *this same template* already exists (by name), it is
 *      left alone and reported rather than duplicated.
 *   4. Best-effort: inserts a sequences row + its sequence_steps, inside a
 *      SAVEPOINT so that if the sequences/sequence_steps tables don't
 *      exist yet (the parallel sequences migration may not have landed),
 *      only that savepoint is rolled back — the rest of this transaction
 *      (profile/ICPs/rubric) still commits. Also skipped (without even
 *      attempting the insert) if a sequence from this template already
 *      exists for the project, by name.
 */
onboardingRouter.post("/apply", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const body = applySchema.parse(req.body);
    const template = INDUSTRY_TEMPLATES[body.industryTemplate];
    const db = req.tenantDb!;
    const notes: string[] = [];

    // 1. project_profiles upsert (mirrors routes/profile.ts PUT).
    const profileResult = await db.query(
      `INSERT INTO project_profiles (tenant_id, project_id, industry, website_url, value_proposition)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id) DO UPDATE SET
         industry = EXCLUDED.industry,
         website_url = EXCLUDED.website_url,
         value_proposition = EXCLUDED.value_proposition
       RETURNING *`,
      [req.tenantId, projectId, body.industryTemplate, body.website, body.offer],
    );

    // 2. icp_profiles — skip ones that collide by name (case-insensitive,
    // trimmed) with an existing row for this project.
    const existingIcpResult = await db.query(
      `SELECT name, is_primary FROM icp_profiles WHERE tenant_id = $1 AND project_id = $2`,
      [req.tenantId, projectId],
    );
    const existingIcpRows = existingIcpResult.rows as { name: string; is_primary?: boolean }[];
    const existingIcpNames = new Set(existingIcpRows.map((r) => r.name.trim().toLowerCase()));
    const hasExistingPrimaryIcp = existingIcpRows.some((r) => r.is_primary);

    const icpProfilesCreated: unknown[] = [];
    for (const icp of template.icpProfiles) {
      if (existingIcpNames.has(icp.name.trim().toLowerCase())) {
        notes.push(`ICP profile "${icp.name}" already existed, skipped`);
        continue;
      }
      // The first newly-created ICP becomes primary, unless the project
      // already has a primary ICP (never silently reassign that).
      const isPrimary = !hasExistingPrimaryIcp && icpProfilesCreated.length === 0;
      const inserted = await db.query(
        `INSERT INTO icp_profiles (tenant_id, project_id, name, segment, description, pain_points, channels, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [req.tenantId, projectId, icp.name, icp.segment, icp.description, icp.painPoints, icp.channels, isPrimary],
      );
      icpProfilesCreated.push(inserted.rows[0]);
    }

    // 3. scoring_rubrics
    const rubricName = `${template.label} starter rubric`;
    const existingByNameResult = await db.query(
      `SELECT * FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 AND name = $3 LIMIT 1`,
      [req.tenantId, projectId, rubricName],
    );

    let rubricCreated: unknown;
    if (existingByNameResult.rowCount && existingByNameResult.rowCount > 0) {
      rubricCreated = existingByNameResult.rows[0];
      notes.push(`A rubric named "${rubricName}" already existed, left untouched`);
    } else {
      const activeRubricResult = await db.query(
        `SELECT 1 FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 AND is_active = true LIMIT 1`,
        [req.tenantId, projectId],
      );
      const hasExistingActiveRubric = (activeRubricResult.rowCount ?? 0) > 0;
      if (hasExistingActiveRubric) {
        notes.push("An active rubric already existed for this project; the new rubric was created as inactive rather than replacing it");
      }

      const rubricResult = await db.query(
        `INSERT INTO scoring_rubrics (tenant_id, project_id, name, criteria, is_active)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING *`,
        [req.tenantId, projectId, rubricName, JSON.stringify(template.scoringCriteria), !hasExistingActiveRubric],
      );
      rubricCreated = rubricResult.rows[0];
    }

    // 4. sequences + sequence_steps — best-effort; the parallel migration
    // creating these tables may not have landed yet. The whole check (does
    // a sequence from this template already exist?) + insert runs inside
    // one SAVEPOINT: if "relation does not exist" (42P01) is thrown at any
    // point, we roll back to the savepoint (not the whole transaction) so
    // the profile/ICP/rubric writes above still commit, and just note the
    // skip instead of failing the request.
    let sequenceCreated: unknown = null;
    const sequenceName = template.sequenceTemplate.name;

    await db.query("SAVEPOINT onboarding_sequence");
    try {
      const existingSequenceResult = await db.query(
        `SELECT * FROM sequences WHERE tenant_id = $1 AND project_id = $2 AND name = $3 LIMIT 1`,
        [req.tenantId, projectId, sequenceName],
      );

      if (existingSequenceResult.rowCount && existingSequenceResult.rowCount > 0) {
        sequenceCreated = existingSequenceResult.rows[0];
        notes.push(`A sequence named "${sequenceName}" already existed, left untouched`);
      } else {
        const sequenceResult = await db.query(
          `INSERT INTO sequences (tenant_id, project_id, name, is_active)
           VALUES ($1, $2, $3, true)
           RETURNING *`,
          [req.tenantId, projectId, sequenceName],
        );
        const sequenceRow = sequenceResult.rows[0];

        const stepRows: unknown[] = [];
        for (let i = 0; i < template.sequenceTemplate.steps.length; i++) {
          const step = template.sequenceTemplate.steps[i];
          const stepResult = await db.query(
            `INSERT INTO sequence_steps (tenant_id, sequence_id, step_order, day_offset, step_type, task_instructions)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [req.tenantId, sequenceRow.id, i, step.dayOffset, step.stepType, step.taskInstructions ?? null],
          );
          stepRows.push(stepResult.rows[0]);
        }

        sequenceCreated = { ...sequenceRow, steps: stepRows };
      }

      await db.query("RELEASE SAVEPOINT onboarding_sequence");
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT onboarding_sequence").catch(() => undefined);
      const code = (err as { code?: string } | undefined)?.code;
      if (code === "42P01") {
        sequenceCreated = null;
        notes.push("sequences table not available yet, skipped");
      } else {
        throw err;
      }
    }

    res.status(201).json({
      profileUpdated: true,
      profile: profileResult.rows[0],
      icpProfilesCreated,
      rubricCreated,
      sequenceCreated,
      notes,
    });
  } catch (err) {
    next(err);
  }
});
