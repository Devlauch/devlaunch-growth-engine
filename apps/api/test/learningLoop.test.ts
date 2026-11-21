import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as campaigns.test.ts / scoring.test.ts: fake the pg
// pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { learningLoopRouter } = await import("../src/routes/learningLoop.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/learning-loop", learningLoopRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const USER_1 = "user-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
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

const projectRow = { rowCount: 1, rows: [{ "?column?": 1 }] };

describe("GET .../learning-loop/variant-performance", () => {
  it("honestly reports not enough data yet when the sample size is below the threshold", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow, // assertProjectInTenant
      {
        rowCount: 1,
        rows: [
          { channel: "email", total_variants: "2", leads_contacted: "2", leads_replied_interested: "0" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/learning-loop/variant-performance`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channels: [], note: "not enough data yet" });
  });

  it("honestly reports not enough data yet when message_draft_variants/message_drafts don't exist", async () => {
    const app = buildApp();
    const missingTable = Object.assign(new Error('relation "message_draft_variants" does not exist'), {
      code: "42P01",
    });
    queueResponses([...mockMembership(), projectRow]);
    queryMock.mockRejectedValueOnce(missingTable);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/learning-loop/variant-performance`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channels: [], note: "not enough data yet" });
  });

  it("computes a real per-channel reply rate once sample size clears the threshold", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      {
        rowCount: 2,
        rows: [
          { channel: "email", total_variants: "10", leads_contacted: "8", leads_replied_interested: "4" },
          { channel: "whatsapp", total_variants: "3", leads_contacted: "3", leads_replied_interested: "0" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/learning-loop/variant-performance`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.note).toBeNull();
    expect(res.body.channels).toEqual([
      { channel: "email", totalVariants: 10, leadsContacted: 8, leadsRepliedInterested: 4, replyRate: 0.5 },
      { channel: "whatsapp", totalVariants: 3, leadsContacted: 3, leadsRepliedInterested: 0, replyRate: 0 },
    ]);
  });
});

describe("GET .../learning-loop/rubric-review-readiness", () => {
  it("reports not ready when feedback count is below 30", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      {
        rowCount: 2,
        rows: [
          { feedback: "good", count: "10" },
          { feedback: "bad", count: "5" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/learning-loop/rubric-review-readiness`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ feedbackCount: 15, readyForReview: false, goodCount: 10, badCount: 5 });
  });

  it("reports ready once feedback count reaches 30", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      {
        rowCount: 2,
        rows: [
          { feedback: "good", count: "20" },
          { feedback: "bad", count: "10" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/learning-loop/rubric-review-readiness`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ feedbackCount: 30, readyForReview: true, goodCount: 20, badCount: 10 });
  });

  it("honestly reports zero when lead_score_feedback table doesn't exist", async () => {
    const app = buildApp();
    const missingTable = Object.assign(new Error('relation "lead_score_feedback" does not exist'), {
      code: "42P01",
    });
    queueResponses([...mockMembership(), projectRow]);
    queryMock.mockRejectedValueOnce(missingTable);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/learning-loop/rubric-review-readiness`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ feedbackCount: 0, readyForReview: false, goodCount: 0, badCount: 0 });
  });
});
