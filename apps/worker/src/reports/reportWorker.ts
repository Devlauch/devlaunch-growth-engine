import { Worker, type Job } from "bullmq";
import { REPORT_GENERATION_QUEUE_NAME, type ReportGenerationJobData } from "@devlaunch/agent-sdk";
import { createRedisConnection } from "../queue.js";
import { withTenantContext } from "../db.js";
import { loadReportData } from "./reportQueries.js";
import { generateReportPdf } from "./generateReportPdf.js";
import { saveReportFile, reportRelativePath } from "./reportFileStore.js";
import { logger } from "../logger.js";

/**
 * Processes one generated_reports row end to end, exactly the same way
 * whether it was queued on-demand (POST .../reports/generate) or by the
 * schedule loop (scheduleLoop.ts): queued -> running -> succeeded/failed,
 * mirroring apps/worker/src/index.ts's agent_executions lifecycle.
 *
 * No email is ever sent from here. report_schedules.recipients is stored
 * only — this environment has no real SMTP/email-provider configured, so a
 * schedule-triggered report is marked generated and left available for
 * download, nothing more. See scheduleLoop.ts for the other half of this
 * limitation note.
 */
export async function processReportGeneration(job: Job<ReportGenerationJobData>): Promise<void> {
  const { reportId, tenantId, projectId, scheduleId, periodStart, periodEnd } = job.data;
  const log = logger.child({ reportId, tenantId, projectId, jobId: job.id });

  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `UPDATE generated_reports SET status = 'running', started_at = now() WHERE id = $1 AND tenant_id = $2`,
      [reportId, tenantId],
    );
  });
  log.info("report generation started");

  try {
    const projectRow = await withTenantContext(tenantId, async (client) => {
      const result = await client.query(`SELECT name FROM projects WHERE id = $1 AND tenant_id = $2`, [
        projectId,
        tenantId,
      ]);
      return result.rows[0] as { name: string } | undefined;
    });
    const projectName = projectRow?.name ?? "Unknown project";

    const periodStartDate = new Date(periodStart);
    const periodEndDate = new Date(periodEnd);

    const data = await withTenantContext(tenantId, (client) =>
      loadReportData(client, tenantId, projectId, periodStartDate, periodEndDate),
    );

    const pdfBuffer = await generateReportPdf(data, {
      projectName,
      periodStart: periodStartDate,
      periodEnd: periodEndDate,
      generatedAt: new Date(),
    });

    const relativePath = reportRelativePath(tenantId, reportId);
    await saveReportFile(relativePath, pdfBuffer);

    await withTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE generated_reports
         SET status = 'succeeded', file_path = $2, file_bytes = $3, finished_at = now()
         WHERE id = $1 AND tenant_id = $4`,
        [reportId, relativePath, pdfBuffer.byteLength, tenantId],
      );
      if (scheduleId) {
        await client.query(
          `UPDATE report_schedules SET last_generated_at = now() WHERE id = $1 AND tenant_id = $2`,
          [scheduleId, tenantId],
        );
      }
    });
    log.info({ bytes: pdfBuffer.byteLength }, "report generation succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE generated_reports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND tenant_id = $3`,
        [reportId, message, tenantId],
      );
    });
    log.error({ err }, "report generation failed");
    throw err;
  }
}

export function startReportWorker(): Worker<ReportGenerationJobData> {
  const connection = createRedisConnection();
  const worker = new Worker<ReportGenerationJobData>(REPORT_GENERATION_QUEUE_NAME, processReportGeneration, {
    connection,
    concurrency: Number(process.env.REPORT_WORKER_CONCURRENCY ?? 2),
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "report job completed");
  });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "report job failed");
  });

  logger.info({ queue: REPORT_GENERATION_QUEUE_NAME }, "report worker started, waiting for jobs");
  return worker;
}
