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
