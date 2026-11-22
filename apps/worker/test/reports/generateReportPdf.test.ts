import { describe, it, expect, vi, beforeEach } from "vitest";

// The real pdfkit library does real binary font rendering, which is slow
// and unnecessary to exercise in a unit test — mock it the same way other
// worker-side tests mock heavy external dependencies, and assert it was
// invoked with the real query data (never fabricated numbers).
const texts = vi.hoisted(() => [] as string[]);

vi.mock("pdfkit", () => {
  function FakePDFDocument(this: Record<string, unknown>) {
    const handlers: Record<string, () => void> = {};
    this.on = (event: string, cb: () => void) => {
      handlers[event] = cb;
      return this;
    };
    this.fontSize = () => this;
    this.fillColor = () => this;
    this.moveDown = () => this;
    this.text = (str: string) => {
      texts.push(str);
      return this;
    };
    this.end = () => {
      handlers.end?.();
    };
  }
  return { default: FakePDFDocument };
});

const { generateReportPdf } = await import("../../src/reports/generateReportPdf.js");
import type { ReportData } from "../../src/reports/reportQueries.js";

beforeEach(() => {
  texts.length = 0;
});

describe("generateReportPdf", () => {
  it("writes the real query results into the PDF content, not fabricated numbers", async () => {
    const data: ReportData = {
      leadsTotal: 42,
      leadsByStatus: [
        { status: "new", count: 30 },
        { status: "qualified", count: 12 },
      ],
      newLeadsInPeriod: 7,
      campaignsByStatus: [{ status: "approved", count: 3 }],
      agentExecutionsByStatus: [{ status: "succeeded", count: 9 }],
    };

    await generateReportPdf(data, {
      projectName: "Acme Growth",
      periodStart: new Date("2026-11-15T00:00:00Z"),
      periodEnd: new Date("2026-11-22T00:00:00Z"),
      generatedAt: new Date("2026-11-22T01:00:00Z"),
    });

    const joined = texts.join("\n");
    expect(joined).toContain("Total leads: 42");
    expect(joined).toContain("New leads this period: 7");
    expect(joined).toContain("new: 30");
    expect(joined).toContain("qualified: 12");
    expect(joined).toContain("approved: 3");
    expect(joined).toContain("succeeded: 9");
    expect(joined).toContain("Acme Growth");
  });

  it("never invents numbers for an empty project — reports honest zero/empty sections", async () => {
    const data: ReportData = {
      leadsTotal: 0,
      leadsByStatus: [],
      newLeadsInPeriod: 0,
      campaignsByStatus: [],
      agentExecutionsByStatus: [],
    };

    await generateReportPdf(data, {
      projectName: "New Project",
      periodStart: new Date("2026-11-15T00:00:00Z"),
      periodEnd: new Date("2026-11-22T00:00:00Z"),
      generatedAt: new Date("2026-11-22T01:00:00Z"),
    });

    const joined = texts.join("\n");
    expect(joined).toContain("Total leads: 0");
    expect(joined).toContain("No campaigns yet.");
    expect(joined).toContain("No agent executions yet.");
    // Never claims any made-up non-zero figure.
    expect(joined).not.toMatch(/Total leads: [1-9]/);
  });
});
