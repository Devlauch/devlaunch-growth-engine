import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/report-schedules
 *
 * Manages recurring report_schedules rows. Nothing here sends email —
 * `recipients` is stored only (see 240_create_report_schedules.sql); this
 * environment has no real SMTP/email-provider configured. The worker-side
 * schedule loop (apps/worker/src/reports/scheduleLoop.ts) is what actually
 * turns a due, enabled schedule into a real generated report.
 */
export const reportSchedulesRouter = Router({ mergeParams: true });
reportSchedulesRouter.use(requireAuth, requireTenantMembership);

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

const createSchema = z.object({
  frequency: z.enum(["weekly", "monthly"]),
  recipients: z.array(z.string().email()).default([]),
  enabled: z.boolean().default(true),
});

const updateSchema = z
  .object({
    frequency: z.enum(["weekly", "monthly"]).optional(),
    recipients: z.array(z.string().email()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

/** POST /api/v1/tenants/:tenantId/projects/:projectId/report-schedules */
reportSchedulesRouter.post("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const body = createSchema.parse(req.body);
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const result = await req.tenantDb!.query(
      `INSERT INTO report_schedules (tenant_id, project_id, frequency, recipients, enabled, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id, tenant_id, project_id, frequency, recipients, enabled, last_generated_at, created_at, updated_at`,
      [req.tenantId, projectId, body.frequency, JSON.stringify(body.recipients), body.enabled, req.userId],
    );

    res.status(201).json({ schedule: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/report-schedules */
reportSchedulesRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const result = await req.tenantDb!.query(
      `SELECT id, tenant_id, project_id, frequency, recipients, enabled, last_generated_at, created_at, updated_at
       FROM report_schedules
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC`,
      [req.tenantId, projectId],
    );
    res.json({ schedules: result.rows });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/v1/tenants/:tenantId/projects/:projectId/report-schedules/:id */
reportSchedulesRouter.patch("/:id", async (req, res, next) => {
  try {
    const scheduleId = z.string().uuid().parse(req.params.id);
    const body = updateSchema.parse(req.body);

    const existing = await req.tenantDb!.query(
      `SELECT id FROM report_schedules WHERE id = $1 AND tenant_id = $2`,
      [scheduleId, req.tenantId],
    );
    if (existing.rowCount === 0) throw Errors.notFound("Report schedule not found");

    const result = await req.tenantDb!.query(
      `UPDATE report_schedules
       SET frequency = COALESCE($3, frequency),
           recipients = COALESCE($4::jsonb, recipients),
           enabled = COALESCE($5, enabled)
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, project_id, frequency, recipients, enabled, last_generated_at, created_at, updated_at`,
      [
        scheduleId,
        req.tenantId,
        body.frequency ?? null,
        body.recipients !== undefined ? JSON.stringify(body.recipients) : null,
        body.enabled ?? null,
      ],
    );

    res.json({ schedule: result.rows[0] });
  } catch (err) {
    next(err);
  }
});
