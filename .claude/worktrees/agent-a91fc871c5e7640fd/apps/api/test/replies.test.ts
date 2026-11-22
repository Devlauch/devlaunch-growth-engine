import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as campaigns.test.ts / scoring.test.ts /
// discovery.test.ts: fake the pg pool so these are true unit tests with no
// real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { repliesRouter } = await import("../src/routes/replies.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { classifyReply } = await import("../src/lib/classifyReply.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/leads/:leadId/replies",
    repliesRouter,
  );
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "88888888-8888-8888-8888-888888888888";
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

const leadRow = { rowCount: 1, rows: [{ id: LEAD_1, name: "Jane Doe", email: "jane@example.com" }] };

const replyRow = (overrides: Record<string, unknown> = {}) => ({
  rowCount: 1,
  rows: [
    {
      id: "reply-1",
      tenant_id: TENANT_A,
      project_id: PROJECT_1,
      lead_id: LEAD_1,
      channel: "email",
      raw_content: "text",
      classification: "unclassified",
      classification_confidence: "low",
      draft_response_id: null,
      crm_task_id: null,
      received_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      ...overrides,
    },
  ],
});

describe("classifyReply", () => {
  it("classifies unsubscribe-ish phrases as unsubscribe/high", () => {
    expect(classifyReply("Please unsubscribe me")).toEqual({ classification: "unsubscribe", confidence: "high" });
    expect(classifyReply("stop emailing me")).toEqual({ classification: "unsubscribe", confidence: "high" });
    expect(classifyReply("remove me from this list")).toEqual({
      classification: "unsubscribe",
      confidence: "high",
    });
    expect(classifyReply("I'd like to opt out")).toEqual({ classification: "unsubscribe", confidence: "high" });
  });

  it("lets 'stop emailing' override a competing 'not interested' signal", () => {
    // "not interested" alone would match not_now; unsubscribe must win
    // because it's checked first and has compliance weight.
    expect(classifyReply("Not interested, please stop emailing me")).toEqual({
      classification: "unsubscribe",
      confidence: "high",
    });
  });

  it("classifies wrong-person phrases", () => {
    expect(classifyReply("You have the wrong person")).toEqual({
      classification: "wrong_person",
      confidence: "high",
    });
    expect(classifyReply("I don't work there anymore")).toEqual({
      classification: "wrong_person",
      confidence: "medium",
    });
    expect(classifyReply("Please contact John Smith instead")).toEqual({
      classification: "wrong_person",
      confidence: "medium",
    });
  });

  it("classifies interested phrases", () => {
    expect(classifyReply("Let's schedule a call next week")).toEqual({
      classification: "interested",
      confidence: "high",
    });
    expect(classifyReply("Tell me more about this")).toEqual({
      classification: "interested",
      confidence: "medium",
    });
    expect(classifyReply("Sounds good, interested to learn more")).toEqual({
      classification: "interested",
      confidence: "medium",
    });
  });

  it("classifies decline phrases as not_now/medium", () => {
    expect(classifyReply("Not interested right now")).toEqual({ classification: "not_now", confidence: "medium" });
    expect(classifyReply("Maybe later")).toEqual({ classification: "not_now", confidence: "medium" });
    expect(classifyReply("No thanks")).toEqual({ classification: "not_now", confidence: "medium" });
  });

  it("falls back to unclassified/low for anything else", () => {
    expect(classifyReply("What time zone are you in?")).toEqual({
      classification: "unclassified",
      confidence: "low",
    });
    expect(classifyReply("")).toEqual({ classification: "unclassified", confidence: "low" });
  });
});

describe("POST .../leads/:leadId/replies — side effects", () => {
  it("creates a CRM task and a draft skeleton for an interested reply", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      leadRow, // loadLeadOr404
      undefined, // SAVEPOINT reply_crm_task
      { rowCount: 1, rows: [{ id: "task-1" }] }, // crm_tasks insert
      undefined, // RELEASE SAVEPOINT reply_crm_task
      undefined, // SAVEPOINT reply_draft
      { rowCount: 1, rows: [{ id: "draft-1" }] }, // message_drafts insert
      undefined, // RELEASE SAVEPOINT reply_draft
      replyRow({ classification: "interested", classification_confidence: "high", crm_task_id: "task-1", draft_response_id: "draft-1" }), // lead_replies insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", content: "Sounds good, let's schedule a call" });

    expect(res.status).toBe(201);
    expect(res.body.classification.classification).toBe("interested");
    expect(res.body.sideEffects).toEqual({
      crmTaskCreated: true,
      draftCreated: true,
      suppressed: false,
      enrollmentsStopped: 0,
    });
    expect(res.body.notes).toEqual([]);
  });

  it("skips CRM task creation when crm_tasks table is missing, but still records the reply", async () => {
    const app = buildApp();
    const missingTableError = Object.assign(new Error("relation \"crm_tasks\" does not exist"), { code: "42P01" });
    queueResponses([
      ...mockMembership(),
      leadRow,
      undefined, // SAVEPOINT reply_crm_task
    ]);
    queryMock.mockRejectedValueOnce(missingTableError); // crm_tasks insert fails
    queueResponses([
      undefined, // ROLLBACK TO SAVEPOINT reply_crm_task
      undefined, // SAVEPOINT reply_draft
      { rowCount: 1, rows: [{ id: "draft-1" }] },
      undefined, // RELEASE SAVEPOINT reply_draft
      replyRow({ classification: "interested", classification_confidence: "high", draft_response_id: "draft-1" }),
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", content: "I'm interested, tell me more" });

    expect(res.status).toBe(201);
    expect(res.body.sideEffects.crmTaskCreated).toBe(false);
    expect(res.body.notes).toContain("crm_tasks table not available yet, skipped CRM task creation");
  });

  it("skips draft creation when message_drafts table is missing", async () => {
    const app = buildApp();
    const missingTableError = Object.assign(new Error("relation \"message_drafts\" does not exist"), {
      code: "42P01",
    });
    queueResponses([
      ...mockMembership(),
      leadRow,
      undefined, // SAVEPOINT reply_crm_task
      { rowCount: 1, rows: [{ id: "task-1" }] },
      undefined, // RELEASE SAVEPOINT reply_crm_task
      undefined, // SAVEPOINT reply_draft
    ]);
    queryMock.mockRejectedValueOnce(missingTableError); // message_drafts insert fails
    queueResponses([
      undefined, // ROLLBACK TO SAVEPOINT reply_draft
      replyRow({ classification: "interested", classification_confidence: "high", crm_task_id: "task-1" }),
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", content: "Interested, let's talk" });

    expect(res.status).toBe(201);
    expect(res.body.sideEffects.draftCreated).toBe(false);
    expect(res.body.notes).toContain("message_drafts table not available yet, skipped draft response creation");
  });

  it("suppresses the lead and stops active enrollments for an unsubscribe reply", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      leadRow,
      undefined, // SAVEPOINT reply_suppression
      { rowCount: 1, rows: [] }, // suppression_list insert
      undefined, // RELEASE SAVEPOINT reply_suppression
      undefined, // SAVEPOINT reply_stop_enrollments
      { rowCount: 2, rows: [] }, // sequence_enrollments update
      undefined, // RELEASE SAVEPOINT reply_stop_enrollments
      replyRow({ classification: "unsubscribe", classification_confidence: "high" }),
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", content: "unsubscribe please" });

    expect(res.status).toBe(201);
    expect(res.body.sideEffects).toEqual({
      crmTaskCreated: false,
      draftCreated: false,
      suppressed: true,
      enrollmentsStopped: 2,
    });
  });

  it("skips suppression when suppression_list table is missing, and skips enrollment-stop when that table is missing", async () => {
    const app = buildApp();
    const missingSuppression = Object.assign(new Error("relation \"suppression_list\" does not exist"), {
      code: "42P01",
    });
    const missingEnrollments = Object.assign(new Error("relation \"sequence_enrollments\" does not exist"), {
      code: "42P01",
    });
    queueResponses([
      ...mockMembership(),
      leadRow,
      undefined, // SAVEPOINT reply_suppression
    ]);
    queryMock.mockRejectedValueOnce(missingSuppression); // suppression_list insert fails
    queueResponses([
      undefined, // ROLLBACK TO SAVEPOINT reply_suppression
      undefined, // SAVEPOINT reply_stop_enrollments
    ]);
    queryMock.mockRejectedValueOnce(missingEnrollments); // sequence_enrollments update fails
    queueResponses([
      undefined, // ROLLBACK TO SAVEPOINT reply_stop_enrollments
      replyRow({ classification: "unsubscribe", classification_confidence: "high" }),
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", content: "unsubscribe please" });

    expect(res.status).toBe(201);
    expect(res.body.sideEffects).toEqual({
      crmTaskCreated: false,
      draftCreated: false,
      suppressed: false,
      enrollmentsStopped: 0,
    });
    expect(res.body.notes).toContain("suppression_list table not available yet, skipped suppression");
    expect(res.body.notes).toContain("sequence_enrollments table not available yet, skipped stopping enrollments");
  });

  it("records a wrong_person/not_now/unclassified reply with no side effects", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      leadRow,
      replyRow({ classification: "not_now", classification_confidence: "medium" }),
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", content: "No thanks, not interested" });

    expect(res.status).toBe(201);
    expect(res.body.sideEffects).toEqual({
      crmTaskCreated: false,
      draftCreated: false,
      suppressed: false,
      enrollmentsStopped: 0,
    });
  });

  it("404s when the lead does not belong to the project/tenant", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 0, rows: [] }, // loadLeadOr404 miss
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1)
      .send({ channel: "email", content: "hello" });

    expect(res.status).toBe(404);
  });
});

describe("GET .../leads/:leadId/replies", () => {
  it("lists replies for the lead", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), leadRow, { rowCount: 1, rows: [replyRow().rows[0]] }]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/leads/${LEAD_1}/replies`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.replies).toHaveLength(1);
  });
});
