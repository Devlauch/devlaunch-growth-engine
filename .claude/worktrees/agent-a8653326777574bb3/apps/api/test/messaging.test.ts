import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same mocking pattern as discovery.test.ts / campaigns.test.ts / scoring.test.ts:
// fake the pg pool so these are true unit tests with no real Postgres.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { messageDraftsRouter } = await import("../src/routes/messaging.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/message-drafts", messageDraftsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "88888888-8888-8888-8888-888888888888";
const DRAFT_1 = "99999999-9999-9999-9999-999999999999";
const DRAFT_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const APPROVAL_1 = "55555555-5555-5555-5555-555555555555";
const APPROVAL_2 = "66666666-6666-6666-6666-666666666666";
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

const LEAD_ROW = { id: LEAD_1, tenant_id: TENANT_A, project_id: PROJECT_1, name: "Jane Doe", email: "jane@acme.com" };

describe("POST /message-drafts", () => {
  it("creates a draft with 4 variants, flags unsourced claims, and surfaces sendEligibility", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [LEAD_ROW] }, // loadLeadOr404
      { rowCount: 0, rows: [] }, // isSuppressed (not suppressed)
      {
        rowCount: 1,
        rows: [
          {
            id: DRAFT_1,
            tenant_id: TENANT_A,
            project_id: PROJECT_1,
            lead_id: LEAD_1,
            status: "draft",
            approval_id: null,
            evidence_summary: "Acme Corp recently expanded",
            unsourced_claims: ["the #1 solution in the market", "guaranteed results within 30 days"],
          },
        ],
      }, // INSERT message_drafts
      { rowCount: 1, rows: [{ id: "v1", channel: "email" }] },
      { rowCount: 1, rows: [{ id: "v2", channel: "whatsapp" }] },
      { rowCount: 1, rows: [{ id: "v3", channel: "call_script" }] },
      { rowCount: 1, rows: [{ id: "v4", channel: "linkedin_note" }] },
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts`)
      .set("X-Dev-User-Id", USER_1)
      .send({
        leadId: LEAD_1,
        approvedClaims: ["We cut onboarding time in half"],
        evidenceSummary: "Acme Corp recently expanded",
        evidenceFacts: ["Acme Corp recently expanded"],
      });

    expect(res.status).toBe(201);
    expect(res.body.messageDraft.status).toBe("draft");
    expect(res.body.variants).toHaveLength(4);
    expect(res.body.sendEligibility).toEqual({ eligible: true, blockReasons: [] });

    const insertDraftCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO message_drafts"),
    );
    expect(insertDraftCall).toBeDefined();
  });

  it("404s when the lead does not belong to this tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // loadLeadOr404 -> not found
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts`)
      .set("X-Dev-User-Id", USER_1)
      .send({ leadId: LEAD_1, evidenceSummary: "x" });

    expect(res.status).toBe(404);
  });
});

describe("GET /message-drafts", () => {
  it("lists drafts scoped to tenant/project", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 0, rows: [] }, // list
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.messageDrafts).toEqual([]);
  });
});

describe("GET /message-drafts/:id", () => {
  it("returns a draft with its variants and sendEligibility", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      {
        rowCount: 1,
        rows: [{ id: DRAFT_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1, status: "draft" }],
      }, // loadDraftOr404
      { rowCount: 1, rows: [{ id: "v1", channel: "email" }] }, // variants
      { rowCount: 1, rows: [LEAD_ROW] }, // loadLeadOr404
      { rowCount: 0, rows: [] }, // isSuppressed
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts/${DRAFT_1}`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.messageDraft.id).toBe(DRAFT_1);
    expect(res.body.variants).toHaveLength(1);
    expect(res.body.sendEligibility.eligible).toBe(true);
  });
});

describe("POST /message-drafts/:id/submit-for-approval", () => {
  it("moves a draft to pending_approval and creates an approvals row referencing it", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [{ id: DRAFT_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1, status: "draft" }],
      }, // loadDraftOr404
      {
        rowCount: 1,
        rows: [{ id: APPROVAL_1, message_draft_id: DRAFT_1, status: "pending", requested_by: USER_1 }],
      }, // INSERT approvals
      {
        rowCount: 1,
        rows: [{ id: DRAFT_1, status: "pending_approval", approval_id: APPROVAL_1 }],
      }, // UPDATE message_drafts
      undefined, // audit insert
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts/${DRAFT_1}/submit-for-approval`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(201);
    expect(res.body.messageDraft.status).toBe("pending_approval");
    expect(res.body.approval.message_draft_id).toBe(DRAFT_1);

    const insertApprovalCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO approvals"),
    );
    expect(insertApprovalCall).toBeDefined();
  });

  it("rejects submitting a draft that isn't in 'draft' status", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [{ id: DRAFT_1, tenant_id: TENANT_A, project_id: PROJECT_1, lead_id: LEAD_1, status: "approved" }],
      }, // loadDraftOr404
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts/${DRAFT_1}/submit-for-approval`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(409);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO approvals"), expect.anything());
  });
});

describe("POST /message-drafts/batch-approve", () => {
  it("approves every draft in the batch when under the daily limit", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ message_approval_daily_limit: 10 }] }, // tenant limit
      {
        rowCount: 2,
        rows: [
          { id: DRAFT_1, status: "pending_approval", approval_id: APPROVAL_1 },
          { id: DRAFT_2, status: "pending_approval", approval_id: APPROVAL_2 },
        ],
      }, // drafts select
      { rowCount: 1, rows: [{ count: 0 }] }, // approvedToday count
      undefined, // UPDATE approvals (draft 1)
      { rowCount: 1, rows: [{ id: DRAFT_1, status: "approved" }] }, // UPDATE message_drafts (draft 1)
      undefined, // audit insert (draft 1)
      undefined, // UPDATE approvals (draft 2)
      { rowCount: 1, rows: [{ id: DRAFT_2, status: "approved" }] }, // UPDATE message_drafts (draft 2)
      undefined, // audit insert (draft 2)
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts/batch-approve`)
      .set("X-Dev-User-Id", USER_1)
      .send({ draftIds: [DRAFT_1, DRAFT_2] });

    expect(res.status).toBe(200);
    expect(res.body.messageDrafts).toHaveLength(2);
    expect(res.body.messageDrafts.every((d: { status: string }) => d.status === "approved")).toBe(true);
  });

  it("rejects the whole batch (no partial approval) when it would exceed the tenant's daily limit", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ message_approval_daily_limit: 1 }] }, // tenant limit
      {
        rowCount: 2,
        rows: [
          { id: DRAFT_1, status: "pending_approval", approval_id: APPROVAL_1 },
          { id: DRAFT_2, status: "pending_approval", approval_id: APPROVAL_2 },
        ],
      }, // drafts select
      { rowCount: 1, rows: [{ count: 0 }] }, // approvedToday count: 0 already approved, but batch of 2 > limit of 1
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts/batch-approve`)
      .set("X-Dev-User-Id", USER_1)
      .send({ draftIds: [DRAFT_1, DRAFT_2] });

    expect(res.status).toBe(409);
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE approvals"), expect.anything());
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE message_drafts"), expect.anything());
  });

  it("rejects the batch when a draft id is not pending_approval", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ message_approval_daily_limit: null }] }, // tenant limit (unlimited)
      {
        rowCount: 2,
        rows: [
          { id: DRAFT_1, status: "pending_approval", approval_id: APPROVAL_1 },
          { id: DRAFT_2, status: "draft", approval_id: null },
        ],
      }, // drafts select
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/message-drafts/batch-approve`)
      .set("X-Dev-User-Id", USER_1)
      .send({ draftIds: [DRAFT_1, DRAFT_2] });

    expect(res.status).toBe(409);
  });
});
