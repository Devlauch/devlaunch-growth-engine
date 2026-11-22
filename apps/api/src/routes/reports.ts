import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { enqueueReportGeneration } from "../lib/reportQueue.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Mounted at /api/v1/tenants/:tenantId/projects/:projectId/reports
 *
 * Real downloadable PDF client reports. POST /generate follows the exact
 * same queued -> running -> succeeded/failed lifecycle as agent_executions
 * (see apps/api/src/routes/agentRuns.ts): it creates a generated_reports
 * row, enqueues a real BullMQ job (apps/worker/src/reports/reportWorker.ts),
 * and returns the reportId to poll. Every number that ends up in the PDF is
 * a real SQL aggregate (apps/worker/src/reports/reportQueries.ts) — nothing
 * is fabricated.
 *
 * There is no object storage (S3/etc) configured in this environment, so
 * the PDF bytes live on a local volume shared with apps/worker (see
 * docker-compose.yml's `report_files` volume) and are only ever reachable
 * through GET /:id/download, which is authenticated and tenant-isolated —
 * never a public URL.
 */
export const reportsRouter = Router({ mergeParams: true });
reportsRouter.use(requireAuth, requireTenantMembership);

const DEFAULT_PERIOD_DAYS = 7;

async function loadProjectOr404(tenantDb: import("pg").PoolClient, tenantId: string, projectId: string) {
  const project = await tenantDb.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    tenantId,
  ]);
  if (project.rowCount === 0) throw Errors.notFound("Project not found");
}

const generateSchema = z.object({
  periodDays: z.number().int().positive().max(366).optional(),
});

/** POST /api/v1/tenants/:tenantId/projects/:projectId/reports/generate */
reportsRouter.post("/generate", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const body = generateSchema.parse(req.body ?? {});
    await loadProjectOr404(req.tenantDb!, req.tenantId!, projectId);

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - (body.periodDays ?? DEFAULT_PERIOD_DAYS) * 24 * 60 * 60 * 1000);

    const insert = await req.tenantDb!.query(
      `INSERT INTO generated_reports (tenant_id, project_id, schedule_id, status, period_start, period_end, created_by)
       VALUES ($1, $2, NULL, 'queued', $3, $4, $5)
       RETURNING id, status`,
      [req.tenantId, projectId, periodStart.toISOString(), periodEnd.toISOString(), req.userId],
    );
    const reportId = insert.rows[0].id as string;

    await req.tenantDb!.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'user', $2, 'generated_report.queued', 'generated_report', $3, '{}'::jsonb)`,
      [req.tenantId, req.userId, reportId],
    );

    try {
      await enqueueReportGeneration({
        reportId,
        tenantId: req.tenantId as string,
        projectId,
        scheduleId: null,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });
    } catch (err) {
      logger.error({ err, reportId }, "failed to enqueue report generation; marking report failed");
      await req.tenantDb!.query(
        `UPDATE generated_reports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [reportId, "Failed to enqueue report generation job"],
      );
      res.status(502).json({ reportId, status: "failed", error: { code: "enqueue_failed", message: "Failed to enqueue report generation" } });
      return;
    }

    res.status(202).json({ reportId, status: "queued" });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/reports */
reportsRouter.get("/", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const result = await req.tenantDb!.query(
      `SELECT id, schedule_id, status, period_start, period_end, file_bytes, error, created_at, started_at, finished_at
       FROM generated_reports
       WHERE tenant_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.tenantId, projectId],
    );
    res.json({ reports: result.rows });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/tenants/:tenantId/projects/:projectId/reports/:id/download */
reportsRouter.get("/:id/download", async (req, res, next) => {
  try {
    const projectId = z.string().uuid().parse((req.params as Record<string, string>).projectId);
    const reportId = z.string().uuid().parse(req.params.id);

    const result = await req.tenantDb!.query(
      `SELECT id, status, file_path FROM generated_reports WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [reportId, req.tenantId, projectId],
    );
    if (result.rowCount === 0) throw Errors.notFound("Report not found");

    const row = result.rows[0];
    if (row.status !== "succeeded" || !row.file_path) {
      throw Errors.badRequest(`Report is ${row.status}, not yet available for download`);
    }

    // file_path is stored relative to env.reportFilesDir (never absolute,
    // never attacker-controlled — it's whatever reportFileStore.ts on the
    // worker side wrote at generation time), so this never serves a path
    // outside the report files volume.
    const fullPath = path.join(env.reportFilesDir, row.file_path);

    fs.stat(fullPath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        next(Errors.notFound("Report file is missing on disk"));
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="report-${reportId}.pdf"`);
      res.setHeader("Content-Length", String(stat.size));
      const stream = fs.createReadStream(fullPath);
      stream.on("error", (streamErr) => next(streamErr));
      stream.pipe(res);
    });
  } catch (err) {
    next(err);
  }
});
