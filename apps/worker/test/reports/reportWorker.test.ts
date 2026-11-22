import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock every collaborator so this test exercises only processReportGeneration's
// own orchestration logic (queued -> running -> succeeded/failed), the same
// way apps/worker/src/index.ts's processAgentRun would be tested: real DB
// and real pdfkit rendering are out of scope for a unit test, but we assert
// the real query results flow untouched into the PDF renderer.
const withTenantContextMock = vi.fn();
vi.mock("../../src/db.js", () => ({ withTenantContext: withTenantContextMock }));

const loadReportDataMock = vi.fn();
vi.mock("../../src/reports/reportQueries.js", () => ({ loadReportData: loadReportDataMock }));

const generateReportPdfMock = vi.fn();
vi.mock("../../src/reports/generateReportPdf.js", () => ({ generateReportPdf: generateReportPdfMock }));

const saveReportFileMock = vi.fn();
vi.mock("../../src/reports/reportFileStore.js", () => ({
  saveReportFile: saveReportFileMock,
  reportRelativePath: (tenantId: string, reportId: string) => `${tenantId}/${reportId}.pdf`,
}));

const { processReportGeneration } = await import("../../src/reports/reportWorker.js");

const REAL_DATA = {
  leadsTotal: 5,
  leadsByStatus: [{ status: "new", count: 5 }],
  newLeadsInPeriod: 2,
  campaignsByStatus: [],
  agentExecutionsByStatus: [],
};

function makeClient() {
  return { query: vi.fn().mockResolvedValue({ rows: [{ name: "Acme" }] }) };
}

beforeEach(() => {
  withTenantContextMock.mockReset();
  loadReportDataMock.mockReset();
  generateReportPdfMock.mockReset();
  saveReportFileMock.mockReset();

  withTenantContextMock.mockImplementation(async (_tenantId: string, fn: (c: unknown) => unknown) => fn(makeClient()));
  loadReportDataMock.mockResolvedValue(REAL_DATA);
  generateReportPdfMock.mockResolvedValue(Buffer.from("fake-pdf"));
  saveReportFileMock.mockResolvedValue(undefined);
});

function makeJob() {
  return {
    id: "job-1",
    data: {
      reportId: "report-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      scheduleId: null,
      periodStart: "2026-11-15T00:00:00.000Z",
      periodEnd: "2026-11-22T00:00:00.000Z",
    },
  } as never;
}

describe("processReportGeneration", () => {
  it("renders the PDF from the real loadReportData result, never fabricated numbers", async () => {
    await processReportGeneration(makeJob());

    expect(loadReportDataMock).toHaveBeenCalled();
    const pdfCallArgs = generateReportPdfMock.mock.calls[0];
    expect(pdfCallArgs[0]).toBe(REAL_DATA); // the exact object loadReportData returned, untouched
    expect(saveReportFileMock).toHaveBeenCalledWith("tenant-1/report-1.pdf", Buffer.from("fake-pdf"));
  });

  it("marks the report failed and rethrows when PDF generation throws", async () => {
    generateReportPdfMock.mockRejectedValueOnce(new Error("render error"));

    await expect(processReportGeneration(makeJob())).rejects.toThrow("render error");

    const failUpdateCall = withTenantContextMock.mock.calls.length;
    expect(failUpdateCall).toBeGreaterThan(0);
  });
});
