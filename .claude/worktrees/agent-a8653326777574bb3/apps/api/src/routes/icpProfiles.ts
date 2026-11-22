import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

export const icpProfilesRouter = Router({ mergeParams: true });
icpProfilesRouter.use(requireAuth, requireTenantMembership);

const createIcpSchema = z.object({
  name: z.string().trim().min(1).max(200),
  segment: z.string().trim().max(200).optional(),
  description: z.string().trim().max(5000).optional(),
  painPoints: z.array(z.string().trim().max(500)).max(50).optional(),
  channels: z.array(z.string().trim().max(100)).max(50).optional(),
  firmographics: z.record(z.string(), z.unknown()).optional(),
  isPrimary: z.boolean().optional(),
});

async function assertProjectInTenant(req: import("express").Request, projectId: string) {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

/** GET /api/v1/tenants/:tenantId/projects/:projectId/icp-profiles */
icpProfilesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);

    const result = await req.tenantDb!.query(
      `SELECT * FROM icp_profiles WHERE project_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [projectId, req.tenantId],
    );
    res.json({ icpProfiles: result.rows });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/icp-profiles */
icpProfilesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    await assertProjectInTenant(req, projectId);
    const body = createIcpSchema.parse(req.body);

    const result = await req.tenantDb!.query(
      `INSERT INTO icp_profiles (tenant_id, project_id, name, segment, description, pain_points, channels, firmographics, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING *`,
      [
        req.tenantId,
        projectId,
        body.name,
        body.segment ?? null,
        body.description ?? null,
        body.painPoints ?? [],
        body.channels ?? [],
        JSON.stringify(body.firmographics ?? {}),
        body.isPrimary ?? false,
      ],
    );

    res.status(201).json({ icpProfile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
