import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PassThrough } from "node:stream";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const statMock = vi.fn();
const createReadStreamMock = vi.fn();
vi.mock("node:fs", () => ({
  default: {
    stat: (...args: unknown[]) => (statMock as (...a: unknown[]) => void)(...args),
    createReadStream: (...args: unknown[]) => (createReadStreamMock as (...a: unknown[]) => unknown)(...args),
  },
}));

// runGrowthAnalysis does a real network crawl — stubbed here the same way
// every other route-level test in this repo stubs an expensive external
// call (see growthAnalyzer.test.ts's fetch stub), but mocked at the
// module boundary since publicGrowth.ts's own job is the capture/
// persistence flow around it, not the crawl itself (already covered by
// growthAnalyzer.test.ts).
const runGrowthAnalysisMock = vi.fn();
vi.mock("../src/lib/growthAnalyzer.js", () => ({
  runGrowthAnalysis: runGrowthAnalysisMock,
}));

const enqueueReportGenerationMock = vi.fn();
vi.mock("../src/lib/reportQueue.js", () => ({
  enqueueReportGeneration: enqueueReportGenerationMock,
}));

const { publicGrowthRouter } = await import("../src/routes/publicGrowth.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/public", publicGrowthRouter);
  app.use(errorHandler);
  return app;
}

const INTERNAL_TENANT_ID = "d3f6a1b0-0000-4000-8000-000000000001";

const FAKE_ANALYSIS = {
  domain: "example.com",
  status: "completed" as const,
  pagesDiscovered: 3,
  pagesCrawled: 3,
  crawlError: null,
  sitemapFound: true,
  robotsFound: true,
  extractedKeywords: [],
  productsServices: ["saas"],
  valuePropositions: ["we help teams ship faster"],
  targetAudienceSignals: ["developers"],
  recommendedIcp: { industries: ["SaaS / Software"], geographies: ["Global (no specific geography detected)"], segments: [], rationale: "r" },
  conversionOpportunities: [],
  growthPlanSummary: "Growth plan for example.com, based on 3 crawled page(s).",
};

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  runGrowthAnalysisMock.mockReset();
  enqueueReportGenerationMock.mockReset();
  runGrowthAnalysisMock.mockResolvedValue(FAKE_ANALYSIS);
});

describe("POST /api/v1/public/growth-audit", () => {
  it("rejects an invalid domain with 400 and never calls runGrowthAnalysis", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/v1/public/growth-audit").send({ domain: "not a domain", email: "a@b.com" });
    expect(res.status).toBe(400);
    expect(runGrowthAnalysisMock).not.toHaveBeenCalled();
  });

  it("runs a real growth analysis, creates a real lead via ingestLead, and persists growth_audit_requests + a queued growth_audit report", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config internal tenant
      .mockResolvedValueOnce({ rows: [{ id: "analysis-1" }] }) // insert growth_analyses
      .mockResolvedValueOnce({ rows: [{ id: "lead-1", created_at: "2026-01-01T00:00:00.000Z" }] }) // ingestLead: insert leads
      .mockResolvedValueOnce(undefined) // ingestLead: insert audit_events (lead.created)
      .mockResolvedValueOnce(undefined) // ingestLead: insert usage_events
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ingestLead: notifyTenantOwnersAndAdmins lookup
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ingestLead: chatwootSync's getIntegrationCredential lookup (not configured)
      .mockResolvedValueOnce({ rows: [{ id: "gar-1" }] }) // insert growth_audit_requests
      .mockResolvedValueOnce({ rows: [{ id: "report-1" }] }) // insert generated_reports
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app).post("/api/v1/public/growth-audit").send({ domain: "example.com", email: "visitor@acme.com" });

    expect(runGrowthAnalysisMock).toHaveBeenCalledWith("example.com");
    expect(res.status).toBe(201);
    expect(res.body.growthAuditRequestId).toBe("gar-1");
    expect(res.body.reportId).toBe("report-1");
    expect(res.body.status).toBe("completed");

    const analysisInsert = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO growth_analyses"));
    expect(analysisInsert![1][0]).toBe(INTERNAL_TENANT_ID);

    const leadInsert = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO leads"));
    expect(leadInsert![1]).toContain(INTERNAL_TENANT_ID);
    expect(leadInsert![1]).toContain("visitor@acme.com");

    const auditReqInsert = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO growth_audit_requests"));
    expect(auditReqInsert![1]).toEqual([INTERNAL_TENANT_ID, expect.any(String), "example.com", "visitor@acme.com", "lead-1", "analysis-1", "completed", expect.any(String)]);

    expect(enqueueReportGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: "report-1", tenantId: INTERNAL_TENANT_ID, kind: "growth_audit", growthAnalysisId: "analysis-1" }),
    );
  });

  it("honeypot: a filled companyWebsiteConfirm field is silently accepted and writes nothing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/growth-audit")
      .send({ domain: "example.com", email: "bot@spam.com", companyWebsiteConfirm: "http://spam.example" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accepted: true });
    expect(runGrowthAnalysisMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("enforces per-IP rate limiting", async () => {
    const app = buildApp();
    const maxRequests = Number(process.env.PUBLIC_GROWTH_AUDIT_RATE_LIMIT_PER_IP_PER_MIN ?? 3);

    let lastStatus = 0;
    for (let i = 0; i < maxRequests + 3; i++) {
      // Honeypot path: cheap, no DB/network calls, still passes through the
      // rate-limit middleware first (same mechanism as the real path).
      const res = await request(app)
        .post("/api/v1/public/growth-audit")
        .send({ domain: "example.com", email: `bot${i}@spam.com`, companyWebsiteConfirm: "x" });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("POST /api/v1/public/demo-request", () => {
  it("rejects a submission with no name and no email", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/v1/public/demo-request").send({ company: "Acme" });
    expect(res.status).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("creates a real lead via ingestLead, a demo_requests row, and a demo_request.created audit event", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config internal tenant
      .mockResolvedValueOnce({ rows: [{ id: "lead-1", created_at: "2026-01-01T00:00:00.000Z" }] }) // ingestLead: insert leads
      .mockResolvedValueOnce(undefined) // ingestLead: insert audit_events (lead.created)
      .mockResolvedValueOnce(undefined) // ingestLead: insert usage_events
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ingestLead: notifyTenantOwnersAndAdmins lookup
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ingestLead: chatwootSync's getIntegrationCredential lookup (not configured)
      .mockResolvedValueOnce({ rows: [{ id: "demo-1" }] }) // insert demo_requests
      .mockResolvedValueOnce(undefined) // insert audit_events (demo_request.created)
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/demo-request")
      .send({ name: "Jane Buyer", email: "jane@acme.com", company: "Acme Inc", message: "Interested in a demo" });

    expect(res.status).toBe(201);
    expect(res.body.demoRequestId).toBe("demo-1");
    expect(res.body.lead.id).toBe("lead-1");

    const demoInsert = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO demo_requests"));
    expect(demoInsert![1]).toEqual([INTERNAL_TENANT_ID, expect.any(String), "Jane Buyer", "jane@acme.com", "Acme Inc", "Interested in a demo", "lead-1", expect.any(String)]);

    const demoAuditInsert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("'demo_request.created'"),
    );
    expect(demoAuditInsert).toBeDefined();
  });

  it("honeypot: a filled companyWebsiteConfirm field is silently accepted and writes nothing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/public/demo-request")
      .send({ name: "Bot", email: "bot@spam.com", companyWebsiteConfirm: "http://spam.example" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ accepted: true });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("enforces per-IP rate limiting", async () => {
    const app = buildApp();
    const maxRequests = Number(process.env.PUBLIC_DEMO_REQUEST_RATE_LIMIT_PER_IP_PER_MIN ?? 10);

    let lastStatus = 0;
    for (let i = 0; i < maxRequests + 3; i++) {
      const res = await request(app)
        .post("/api/v1/public/demo-request")
        .send({ name: "Bot", email: `bot${i}@spam.com`, companyWebsiteConfirm: "x" });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("GET /api/v1/public/growth-audit/:growthAuditRequestId/report", () => {
  const GAR_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    statMock.mockReset();
    createReadStreamMock.mockReset();
  });

  it("rejects a non-UUID id with 400 and never connects to the db", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/v1/public/growth-audit/not-a-uuid/report");
    expect(res.status).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown growth audit request", async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce({ rows: [] }) // SELECT ... join
      .mockResolvedValueOnce(undefined); // COMMIT

    const app = buildApp();
    const res = await request(app).get(`/api/v1/public/growth-audit/${GAR_ID}/report`);
    expect(res.status).toBe(404);
  });

  it("reports queued status before a report row exists yet", async () => {
    queryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ report_id: null, status: null, file_path: null, error: null }] })
      .mockResolvedValueOnce(undefined);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/public/growth-audit/${GAR_ID}/report`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "queued" });
  });

  it("reports a failed report's error instead of a file", async () => {
    queryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ report_id: "report-1", status: "failed", file_path: null, error: "boom" }] })
      .mockResolvedValueOnce(undefined);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/public/growth-audit/${GAR_ID}/report`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "failed", error: "boom" });
  });

  it("streams the real PDF file once the report succeeded", async () => {
    queryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ report_id: "report-1", status: "succeeded", file_path: "tenant-1/report-1.pdf", error: null }],
      })
      .mockResolvedValueOnce(undefined);

    const fakeBody = Buffer.from("%PDF-1.4 fake");
    statMock.mockImplementation((_path: string, cb: (err: unknown, stat: { isFile(): boolean; size: number }) => void) => {
      cb(null, { isFile: () => true, size: fakeBody.length });
    });
    const fakeStream = new PassThrough();
    createReadStreamMock.mockImplementation(() => {
      process.nextTick(() => {
        fakeStream.end(fakeBody);
      });
      return fakeStream;
    });

    const app = buildApp();
    const res = await request(app).get(`/api/v1/public/growth-audit/${GAR_ID}/report`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });
});
