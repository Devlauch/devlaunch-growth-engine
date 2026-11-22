import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocked-pg-pool-free unit-test style as advanceSequences/suppression
// consumers (sequences.test.ts): these stage functions take a PoolClient
// directly, so we fake just enough of it (query) rather than standing up
// express/supertest at all.
const checkSendEligibilityMock = vi.fn();
vi.mock("../src/lib/suppression.js", () => ({
  checkSendEligibility: (...args: unknown[]) => checkSendEligibilityMock(...args),
}));

const advanceDueEnrollmentsMock = vi.fn();
vi.mock("../src/lib/advanceSequences.js", () => ({
  advanceDueEnrollments: (...args: unknown[]) => advanceDueEnrollmentsMock(...args),
}));

const { runApprovalComplianceGateStage, runCampaignExecutionStage } = await import(
  "../src/workflow/stages/approvalAndExecution.js"
);

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const RUN_1 = "44444444-4444-4444-4444-444444444444";
const LEAD_1 = "55555555-5555-5555-5555-555555555555";
const LEAD_2 = "66666666-6666-6666-6666-666666666666";
const DRAFT_1 = "77777777-7777-7777-7777-777777777777";
const DRAFT_2 = "88888888-8888-8888-8888-888888888888";

function makeQueryMock(responses: unknown[]) {
  const queryMock = vi.fn();
  for (const r of responses) {
    queryMock.mockResolvedValueOnce(r);
  }
  return queryMock;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    workflowRunId: RUN_1,
    priorStageResults: {},
    inputConfig: {},
    ...overrides,
  };
}

beforeEach(() => {
  checkSendEligibilityMock.mockReset();
  advanceDueEnrollmentsMock.mockReset();
});

describe("runApprovalComplianceGateStage", () => {
  it("returns completed with an honest 'nothing to approve' summary when content_campaign produced no drafts", async () => {
    const queryMock = makeQueryMock([]);
    const result = await runApprovalComplianceGateStage(
      baseInput({
        tenantDb: { query: queryMock },
        priorStageResults: {},
      }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.stage).toBe("approval_compliance_gate");
    expect(result.data.approvedAndEligible).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns needs_approval with the exact pending draft ids when drafts are still draft/pending_approval", async () => {
    const queryMock = makeQueryMock([
      {
        rowCount: 2,
        rows: [
          { id: DRAFT_1, status: "draft", lead_id: LEAD_1, approval_id: null },
          { id: DRAFT_2, status: "pending_approval", lead_id: LEAD_2, approval_id: "approval-2" },
        ],
      }, // SELECT message_drafts
      { rowCount: 1, rows: [{ id: "new-approval-1" }] }, // INSERT approvals for DRAFT_1 (still 'draft')
      { rowCount: 1, rows: [{}] }, // UPDATE message_drafts for DRAFT_1
    ]);

    const result = await runApprovalComplianceGateStage(
      baseInput({
        tenantDb: { query: queryMock },
        priorStageResults: {
          content_campaign: { data: { messageDraftIds: [DRAFT_1, DRAFT_2] }, summary: "drafted 2" },
        },
      }) as any,
    );

    expect(result.status).toBe("needs_approval");
    expect(result.approvalContext).toEqual({ entityType: "message_drafts", entityIds: [DRAFT_1, DRAFT_2] });
    expect(result.data.pending).toEqual([DRAFT_1, DRAFT_2]);
    expect(result.data.approvedAndEligible).toEqual([]);

    // Confirms DRAFT_1 (still 'draft') was really submitted for approval.
    const insertApprovalCall = queryMock.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT INTO approvals"),
    );
    expect(insertApprovalCall).toBeDefined();
    expect(insertApprovalCall![1]).toEqual(
      expect.arrayContaining([TENANT_A, DRAFT_1]),
    );
  });

  it("returns completed with the approved/blocked/rejected breakdown once every draft has a human decision", async () => {
    checkSendEligibilityMock
      .mockResolvedValueOnce({ eligible: true, blockReasons: [] }) // DRAFT_1 -> eligible
      .mockResolvedValueOnce({ eligible: false, blockReasons: ["suppressed:unsubscribed"] }); // DRAFT_2 -> blocked

    const queryMock = makeQueryMock([
      {
        rowCount: 3,
        rows: [
          { id: DRAFT_1, status: "approved", lead_id: LEAD_1, approval_id: "a1" },
          { id: DRAFT_2, status: "approved", lead_id: LEAD_2, approval_id: "a2" },
          { id: "99999999-9999-9999-9999-999999999999", status: "rejected", lead_id: LEAD_1, approval_id: "a3" },
        ],
      }, // SELECT message_drafts
      { rowCount: 1, rows: [{ id: LEAD_1, email: "lead1@example.com" }] }, // lead for DRAFT_1
      { rowCount: 1, rows: [{ id: LEAD_2, email: "lead2@example.com" }] }, // lead for DRAFT_2
    ]);

    const result = await runApprovalComplianceGateStage(
      baseInput({
        tenantDb: { query: queryMock },
        priorStageResults: {
          content_campaign: {
            data: { messageDraftIds: [DRAFT_1, DRAFT_2, "99999999-9999-9999-9999-999999999999"] },
            summary: "drafted 3",
          },
        },
      }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.approvedAndEligible).toEqual([DRAFT_1]);
    expect(result.data.approvedButBlocked).toEqual([
      { draftId: DRAFT_2, leadId: LEAD_2, blockReasons: ["suppressed:unsubscribed"] },
    ]);
    expect(result.data.rejected).toEqual(["99999999-9999-9999-9999-999999999999"]);
    expect(checkSendEligibilityMock).toHaveBeenCalledTimes(2);
  });
});

describe("runCampaignExecutionStage", () => {
  it("delegates to advanceDueEnrollments with the right project and passes its result through honestly", async () => {
    advanceDueEnrollmentsMock.mockResolvedValueOnce({
      advanced: 2,
      tasksCreated: 1,
      skipped: [{ enrollmentId: "enr-1", reason: "no_matching_draft_variant" }],
    });

    const result = await runCampaignExecutionStage(
      baseInput({
        tenantDb: { query: vi.fn() },
        priorStageResults: {
          approval_compliance_gate: { data: { approvedAndEligible: [DRAFT_1] }, summary: "gate completed" },
          content_campaign: { data: { sequenceId: "seq-1" }, summary: "drafted" },
        },
      }) as any,
    );

    expect(advanceDueEnrollmentsMock).toHaveBeenCalledWith(expect.anything(), TENANT_A, PROJECT_1);
    expect(result.status).toBe("completed");
    expect(result.stage).toBe("campaign_execution");
    expect(result.data).toEqual({
      advancedCount: 2,
      tasksCreated: 1,
      heldForSender: [{ enrollmentId: "enr-1", reason: "no_matching_draft_variant" }],
      skipped: [{ enrollmentId: "enr-1", reason: "no_matching_draft_variant" }],
      approvedAndEligibleDraftIds: [DRAFT_1],
    });
    expect(result.summary).toContain("Advanced 2 sequence enrollment(s)");
  });
});
