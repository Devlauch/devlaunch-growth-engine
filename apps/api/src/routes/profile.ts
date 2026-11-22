import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

export const profileRouter = Router({ mergeParams: true });
profileRouter.use(requireAuth, requireTenantMembership);

const profileSchema = z.object({
  companyName: z.string().trim().max(200).optional(),
  industry: z.string().trim().max(200).optional(),
  websiteUrl: z.string().trim().url().optional(),
  valueProposition: z.string().trim().max(5000).optional(),
  targetMarkets: z.array(z.string().trim().max(200)).max(50).optional(),
  goals: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

async function assertProjectInTenant(req: import("express").Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/profile */
profileRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM project_profiles WHERE project_id = $1 AND tenant_id = $2`,
      [projectId, req.tenantId],
    );
    res.json({ profile: result.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/v1/tenants/:tenantId/projects/:projectId/profile — upsert. */
profileRouter.put("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);
    const body = profileSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO project_profiles (tenant_id, project_id, company_name, industry, website_url, value_proposition, target_markets, goals, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET
         company_name = EXCLUDED.company_name,
         industry = EXCLUDED.industry,
         website_url = EXCLUDED.website_url,
         value_proposition = EXCLUDED.value_proposition,
         target_markets = EXCLUDED.target_markets,
         goals = EXCLUDED.goals,
         metadata = EXCLUDED.metadata
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        body.companyName ?? null,
        body.industry ?? null,
        body.websiteUrl ?? null,
        body.valueProposition ?? null,
        body.targetMarkets ?? [],
        JSON.stringify(body.goals ?? {}),
        JSON.stringify(body.metadata ?? {}),
      ],
    );

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'project_profile.updated', 'project_profile', $3, $4::jsonb)`,
      [req.tenantId, req.userId, result.rows[0].id, JSON.stringify(body)],
    );

    res.json({ profile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
