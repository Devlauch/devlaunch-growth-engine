import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { approvalsRouter } = await import("../src/routes/approvals.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/approvals", approvalsRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const APPROVAL_1 = "77777777-7777-7777-7777-777777777777";
const CAMPAIGN_1 = "44444444-4444-4444-4444-444444444444";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const REQUESTER = "requester-1";
const REVIEWER = "reviewer-1";

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

function mockMembership(role = "admin") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] },
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
}

describe("POST .../approvals/:approvalId/decision", () => {
  it("writes an audit_events row AND a real notification to the original requester, not the reviewer", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [
          {
            id: APPROVAL_1,
            agent_execution_id: null,
            campaign_id: CAMPAIGN_1,
            status: "approved",
            requested_by: REQUESTER,
            reviewed_by: REVIEWER,
            decision_notes: null,
            reviewed_at: "2026-01-02",
            campaign_project_id: PROJECT_1,
          },
        ],
      }, // UPDATE approvals ... RETURNING
      { rowCount: 1, rows: [] }, // UPDATE campaigns SET status = 'approved'
      undefined, // audit insert
      undefined, // notify insert (requested_by != reviewer)
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/approvals/${APPROVAL_1}/decision`)
      .set("X-Dev-User-Id", REVIEWER)
      .send({ decision: "approved" });

    expect(res.status).toBe(200);

    const auditCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO audit_events"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1]).toEqual([TENANT_A, REVIEWER, APPROVAL_1, expect.stringContaining("approved")]);

    const notifyCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO notifications"),
    );
    expect(notifyCall).toBeDefined();
    const [, params] = notifyCall!;
    expect(params[0]).toBe(TENANT_A);
    // The recipient is the REQUESTER, never the reviewer who made the
    // decision — a real notification about a real decision going to the
    // person who actually needs to know.
    expect(params[1]).toBe(REQUESTER);
    expect(params[2]).toBe("approval.decided");
  });

  it("never notifies a reviewer of their own decision when they were also the requester", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      {
        rowCount: 1,
        rows: [
          {
            id: APPROVAL_1,
            agent_execution_id: null,
            campaign_id: CAMPAIGN_1,
            status: "approved",
            requested_by: REVIEWER,
            reviewed_by: REVIEWER,
            decision_notes: null,
            reviewed_at: "2026-01-02",
            campaign_project_id: PROJECT_1,
          },
        ],
      },
      { rowCount: 1, rows: [] }, // UPDATE campaigns
      undefined, // audit insert
      // No notify insert mocked — if the code tried to notify here, the
      // query sequence would be exhausted and the handler would throw.
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/approvals/${APPROVAL_1}/decision`)
      .set("X-Dev-User-Id", REVIEWER)
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
    const notifyCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO notifications"),
    );
    expect(notifyCall).toBeUndefined();
  });
});
