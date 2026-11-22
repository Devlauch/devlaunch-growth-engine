import type { Job } from "bullmq";
import type { ReportGenerationJobData } from "@devlaunch/agent-sdk";
import { withTenantContext } from "../db.js";
import { generateGrowthAuditReportPdf, type GrowthAuditReportData } from "./generateReportPdf.js";
import { saveReportFile, reportRelativePath } from "./reportFileStore.js";
import { logger } from "../logger.js";

/**
 * The growth-audit branch of report generation (see
 * reportWorker.ts's processReportGeneration, which dispatches here when
 * job.data.kind === "growth_audit"). Reuses the exact same
 * generated_reports queued -> running -> succeeded/failed lifecycle, the
 * same BullMQ queue/worker, and the same reportFileStore — the only new
 * thing is the data source (a real growth_analyses row, see
 * packages/db/migrations/260_create_growth_analyses.sql) and render
 * function (generateGrowthAuditReportPdf, generateReportPdf.ts).
 */
export async function processGrowthAuditReport(job: Job<ReportGenerationJobData>): Promise<void> {
  const { reportId, tenantId, growthAnalysisId } = job.data;
  const log = logger.child({ reportId, tenantId, jobId: job.id, kind: "growth_audit" });

  if (!growthAnalysisId) {
    const message = "growth_audit report job is missing growthAnalysisId";
    await withTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE generated_reports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND tenant_id = $3`,
        [reportId, message, tenantId],
      );
    });
    log.error(message);
    throw new Error(message);
  }

  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `UPDATE generated_reports SET status = 'running', started_at = now() WHERE id = $1 AND tenant_id = $2`,
      [reportId, tenantId],
    );
  });
  log.info("growth audit report generation started");

  try {
    const analysisRow = await withTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `SELECT domain, status, pages_crawled, crawl_error, products_services, value_propositions,
                target_audience_signals, recommended_icp, conversion_opportunities, growth_plan_summary
         FROM growth_analyses WHERE id = $1 AND tenant_id = $2`,
        [growthAnalysisId, tenantId],
      );
      return result.rows[0];
    });
    if (!analysisRow) {
      throw new Error(`growth_analyses row ${growthAnalysisId} not found for tenant ${tenantId}`);
    }

    const requestRow = await withTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `SELECT email FROM growth_audit_requests WHERE growth_analysis_id = $1 AND tenant_id = $2 LIMIT 1`,
        [growthAnalysisId, tenantId],
      );
      return result.rows[0] as { email: string } | undefined;
    });

    const data: GrowthAuditReportData = {
      domain: analysisRow.domain,
      status: analysisRow.status,
      pagesCrawled: analysisRow.pages_crawled,
      crawlError: analysisRow.crawl_error,
      productsServices: analysisRow.products_services ?? [],
      valuePropositions: analysisRow.value_propositions ?? [],
      targetAudienceSignals: analysisRow.target_audience_signals ?? [],
      recommendedIcp: analysisRow.recommended_icp,
      conversionOpportunities: analysisRow.conversion_opportunities ?? [],
      growthPlanSummary: analysisRow.growth_plan_summary,
    };

    const pdfBuffer = await generateGrowthAuditReportPdf(data, {
      email: requestRow?.email ?? "unknown",
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
      await client.query(
        `UPDATE growth_audit_requests SET report_id = $2 WHERE growth_analysis_id = $1 AND tenant_id = $3`,
        [growthAnalysisId, reportId, tenantId],
      );
    });
    log.info({ bytes: pdfBuffer.byteLength }, "growth audit report generation succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE generated_reports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND tenant_id = $3`,
        [reportId, message, tenantId],
      );
    });
    log.error({ err }, "growth audit report generation failed");
    throw err;
  }
}
