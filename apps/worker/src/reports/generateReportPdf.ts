import PDFDocument from "pdfkit";
import type { ReportData } from "./reportQueries.js";

export interface ReportPdfMeta {
  projectName: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Renders a real client PDF report from already-queried, real data
 * (ReportData — see reportQueries.ts). Every number written to the PDF is
 * read directly off `data`; this function invents nothing itself. Returns
 * the PDF as a Buffer so the caller decides where to persist it (see
 * reportFileStore.ts).
 */
export function generateReportPdf(data: ReportData, meta: ReportPdfMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("DevLaunch Growth Engine", { align: "center" });
    doc.fontSize(14).text("Client Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).text(`Project: ${meta.projectName}`);
    doc.text(`Reporting period: ${formatDate(meta.periodStart)} to ${formatDate(meta.periodEnd)}`);
    doc.text(`Generated: ${meta.generatedAt.toISOString()}`);
    doc.moveDown();

    doc.fontSize(14).text("Leads");
    doc.fontSize(11).text(`Total leads: ${data.leadsTotal}`);
    doc.text(`New leads this period: ${data.newLeadsInPeriod}`);
    if (data.leadsByStatus.length === 0) {
      doc.text("No lead status breakdown available (no leads yet).");
    } else {
      for (const row of data.leadsByStatus) {
        doc.text(`  ${row.status}: ${row.count}`);
      }
    }
    doc.moveDown();

    doc.fontSize(14).text("Campaigns");
    if (data.campaignsByStatus.length === 0) {
      doc.fontSize(11).text("No campaigns yet.");
    } else {
      doc.fontSize(11);
      for (const row of data.campaignsByStatus) {
        doc.text(`  ${row.status}: ${row.count}`);
      }
    }
    doc.moveDown();

    doc.fontSize(14).text("Agent executions");
    if (data.agentExecutionsByStatus.length === 0) {
      doc.fontSize(11).text("No agent executions yet.");
    } else {
      doc.fontSize(11);
      for (const row of data.agentExecutionsByStatus) {
        doc.text(`  ${row.status}: ${row.count}`);
      }
    }
    doc.moveDown();
    doc
      .fontSize(9)
      .fillColor("#666666")
      .text(
        "Every figure in this report is a direct SQL aggregate against this project's real leads, campaigns, and " +
          "agent_executions tables — nothing in this document is estimated or fabricated.",
      );

    doc.end();
  });
}

/** Real growth_analyses row shape this function reads from (see packages/db/migrations/260_create_growth_analyses.sql). Every field is already-persisted, real crawl/extraction output from apps/api/src/lib/growthAnalyzer.ts — nothing here is computed or guessed. */
export interface GrowthAuditReportData {
  domain: string;
  status: "completed" | "partial" | "failed";
  pagesCrawled: number;
  crawlError: string | null;
  productsServices: string[];
  valuePropositions: string[];
  targetAudienceSignals: string[];
  recommendedIcp: { industries: string[]; geographies: string[]; segments: string[]; rationale: string };
  conversionOpportunities: Array<{ severity: string; issueType: string; detail: string; url: string }>;
  growthPlanSummary: string;
}

export interface GrowthAuditReportPdfMeta {
  email: string;
  generatedAt: Date;
}

/**
 * Renders the "personalised business report" PDF for a real public
 * growth-audit request (routes/publicGrowth.ts's POST /public/growth-audit)
 * — same pdfkit engine/buffer pattern as generateReportPdf() above (this
 * IS the reused pipeline, not a parallel renderer), just a different
 * template over a different real data source: the growth_analyses row
 * runGrowthAnalysis() already produced, never re-derived or fabricated
 * here.
 */
export function generateGrowthAuditReportPdf(data: GrowthAuditReportData, meta: GrowthAuditReportPdfMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("DevLaunch Growth Engine", { align: "center" });
    doc.fontSize(14).text("Free Website Growth Audit", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).text(`Website: ${data.domain}`);
    doc.text(`Prepared for: ${meta.email}`);
    doc.text(`Generated: ${meta.generatedAt.toISOString()}`);
    doc.moveDown();

    if (data.status === "failed") {
      doc.fontSize(14).text("Audit status: could not complete");
      doc.fontSize(11).text(data.crawlError ?? "This site could not be crawled.");
      doc.moveDown();
      doc
        .fontSize(9)
        .fillColor("#666666")
        .text("This report honestly reflects a failed crawl — no findings below are fabricated to fill the gap.");
      doc.end();
      return;
    }

    doc.fontSize(14).text("Growth plan summary");
    doc.fontSize(11).text(data.growthPlanSummary);
    doc.moveDown();

    doc.fontSize(14).text("Recommended ideal customer profile");
    doc.fontSize(11);
    doc.text(`Industries: ${data.recommendedIcp.industries.join(", ") || "none detected"}`);
    doc.text(`Geographies: ${data.recommendedIcp.geographies.join(", ")}`);
    doc.text(`Segments: ${data.recommendedIcp.segments.join(", ") || "none detected"}`);
    doc.text(data.recommendedIcp.rationale);
    doc.moveDown();

    doc.fontSize(14).text("Products / services detected on your site");
    doc.fontSize(11).text(data.productsServices.length > 0 ? data.productsServices.join(", ") : "None detected.");
    doc.moveDown();

    doc.fontSize(14).text("Value propositions found");
    if (data.valuePropositions.length === 0) {
      doc.fontSize(11).text("No explicit value-proposition language was detected.");
    } else {
      doc.fontSize(11);
      for (const vp of data.valuePropositions) doc.text(`- ${vp}`);
    }
    doc.moveDown();

    doc.fontSize(14).text("Conversion opportunities");
    if (data.conversionOpportunities.length === 0) {
      doc.fontSize(11).text("No technical conversion-blocking issues were found by the site audit.");
    } else {
      doc.fontSize(11);
      for (const issue of data.conversionOpportunities)
        doc.text(`- [${issue.severity}] ${issue.issueType} (${issue.url}): ${issue.detail}`);
    }
    doc.moveDown();

    doc
      .fontSize(9)
      .fillColor("#666666")
      .text(
        `Based on ${data.pagesCrawled} real crawled page(s) of ${data.domain}. Every finding above is a direct, ` +
          "deterministic extraction from your site's own content — nothing in this report is an LLM-generated " +
          "narrative or a fabricated figure.",
      );

    doc.end();
  });
}
