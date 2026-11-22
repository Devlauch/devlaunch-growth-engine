import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same DB-mocking pattern as campaigns.test.ts / analytics.test.ts: no real
// Postgres needed. The report-generation BullMQ queue is mocked too, so
// this test never opens a real Redis connection.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const enqueueReportGenerationMock = vi.fn();
vi.mock("../src/lib/reportQueue.js", () => ({
  enqueueReportGeneration: enqueueReportGenerationMock,
}));

// GET .../reports/:id/download streams a real file off REPORT_FILES_DIR —
// point that at a real temp directory with a real file in it so the
// streaming path is exercised for real, not mocked away.
const tmpReportFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlaunch-report-files-"));
process.env.REPORT_FILES_DIR = tmpReportFilesDir;

const { reportsRouter } = await import("../src/routes/reports.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/reports", reportsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const REPORT_1 = "44444444-4444-4444-4444-444444444444";
const USER_1 = "user-1";
const USER_2 = "user-2";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  enqueueReportGenerationMock.mockReset();
  enqueueReportGenerationMock.mockResolvedValue(undefined);
});

afterAll(() => {
  fs.rmSync(tmpReportFilesDir, { recursive: true, force: true });
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("tenant isolation on reports routes", () => {
  it("denies a user with no active membership in the target tenant", async () => {
    const app = buildApp();
    queueResponses([
      undefined, // BEGIN
      undefined, // set_config
      { rowCount: 0, rows: [] }, // membership lookup: none
      undefined, // ROLLBACK
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_B}/projects/${PROJECT_1}/reports`)
      .set("X-Dev-User-Id", USER_2);

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("FROM generated_reports"), expect.anything());
  });

  it("scopes the reports list query to the authenticated tenant_id + project_id", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), { rowCount: 0, rows: [] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/reports`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.reports).toEqual([]);

    const listCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM generated_reports"),
    );
    expect(listCall).toBeDefined();
    expect(listCall![1]).toEqual([TENANT_A, PROJECT_1]);
  });

  it("never returns another tenant's report on download, even with a valid report id", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // SELECT ... WHERE id=$1 AND tenant_id=$2 AND project_id=$3 — not found for this tenant
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/reports/${REPORT_1}/download`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(404);
  });
});

describe("POST /reports/generate", () => {
  it("creates a queued generated_reports row and enqueues a real BullMQ job with that reportId", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: REPORT_1, status: "queued" }] }, // INSERT generated_reports RETURNING
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/reports/generate`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(202);
    expect(res.body.reportId).toBe(REPORT_1);
    expect(res.body.status).toBe("queued");

    expect(enqueueReportGenerationMock).toHaveBeenCalledTimes(1);
    const jobData = enqueueReportGenerationMock.mock.calls[0][0];
    expect(jobData.reportId).toBe(REPORT_1);
    expect(jobData.tenantId).toBe(TENANT_A);
    expect(jobData.projectId).toBe(PROJECT_1);
    expect(jobData.scheduleId).toBeNull();
  });

  it("marks the report failed (502) if enqueueing the job throws", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: REPORT_1, status: "queued" }] }, // INSERT generated_reports RETURNING
      undefined, // audit insert
      { rowCount: 1, rows: [] }, // UPDATE generated_reports ... status = failed
    ]);
    enqueueReportGenerationMock.mockRejectedValueOnce(new Error("redis down"));

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/reports/generate`)
      .set("X-Dev-User-Id", USER_1)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.status).toBe("failed");

    const failUpdateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("status = 'failed'"),
    );
    expect(failUpdateCall).toBeDefined();
  });
});

describe("GET /reports/:id/download", () => {
  it("rejects downloading a report that hasn't succeeded yet", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: REPORT_1, status: "queued", file_path: null }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/reports/${REPORT_1}/download`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(400);
  });

  it("streams the real PDF bytes for a succeeded report", async () => {
    const relativePath = path.posix.join(TENANT_A, `${REPORT_1}.pdf`);
    const fullPath = path.join(tmpReportFilesDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const fakePdfBytes = Buffer.from("%PDF-1.4 fake pdf content for test");
    fs.writeFileSync(fullPath, fakePdfBytes);

    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{ id: REPORT_1, status: "succeeded", file_path: relativePath }] },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/reports/${REPORT_1}/download`)
      .set("X-Dev-User-Id", USER_1)
      .buffer()
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect((res.body as Buffer).toString()).toBe(fakePdfBytes.toString());
  });
});
