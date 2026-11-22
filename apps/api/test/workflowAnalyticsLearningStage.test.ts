import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocked-pg-pool-free unit-test style as
// workflowApprovalAndExecutionStage.test.ts: these stage functions take a
// PoolClient directly, so we fake just enough of it (query) rather than
// standing up express/supertest at all.
//
// computeFunnelDropoff and recommendNextActions are real, already-tested
// library functions (see funnelDropoff.ts / nextBestAction.ts and their own
// test coverage elsewhere) — mocked here the same way
// workflowApprovalAndExecutionStage.test.ts mocks checkSendEligibility /
// advanceDueEnrollments, so this file only tests analyticsLearning.ts's own
// composition logic, not re-testing those libraries' internals.
const computeFunnelDropoffMock = vi.fn();
vi.mock("../src/lib/funnelDropoff.js", () => ({
  computeFunnelDropoff: (...args: unknown[]) => computeFunnelDropoffMock(...args),
}));

const recommendNextActionsMock = vi.fn();
vi.mock("../src/lib/nextBestAction.js", () => ({
  recommendNextActions: (...args: unknown[]) => recommendNextActionsMock(...args),
}));

const { runAnalyticsLearningStage } = await import("../src/workflow/stages/analyticsLearning.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const RUN_1 = "44444444-4444-4444-4444-444444444444";

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

/**
 * Builds a queryMock that answers, in order:
 *   - variant-performance's runOptional: SAVEPOINT, <actual select>, RELEASE
 *     (or SAVEPOINT, <actual select throws>, ROLLBACK, RELEASE if degraded)
 *   - rubric-review-readiness's runOptional: same shape
 *
 * `variant` / `rubric` each describe what the "actual select" step should
 * do: either `{ rows }` (succeeds) or `{ missingTable: true }` (throws a
 * 42P01 so runOptional degrades it).
 */
function makeQueryMock(
  variant: { rows: unknown[] } | { missingTable: true },
  rubric: { rows: unknown[] } | { missingTable: true },
) {
  const queryMock = vi.fn();

  function queueSection(section: { rows: unknown[] } | { missingTable: true }) {
    queryMock.mockResolvedValueOnce(undefined); // SAVEPOINT
    if ("missingTable" in section) {
      const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
      queryMock.mockRejectedValueOnce(err); // the actual SELECT
      queryMock.mockResolvedValueOnce(undefined); // ROLLBACK TO SAVEPOINT
      queryMock.mockResolvedValueOnce(undefined); // RELEASE SAVEPOINT
    } else {
      queryMock.mockResolvedValueOnce({ rows: section.rows }); // the actual SELECT
      queryMock.mockResolvedValueOnce(undefined); // RELEASE SAVEPOINT
    }
  }

  queueSection(variant);
  queueSection(rubric);

  return queryMock;
}

const FULL_PRIOR_STAGE_RESULTS = {
  client_onboarding: {
    data: { industryTemplate: "saas", icpProfilesCreated: [{ id: "icp-1" }, { id: "icp-2" }] },
    summary: "onboarded",
  },
  research: {
    data: { findings: [{ id: "f-1" }, { id: "f-2" }, { id: "f-3" }] },
    summary: "researched",
  },
  lead_generation: {
    data: { leadsCreated: [{ id: "lead-1" }, { id: "lead-2" }, { id: "lead-3" }, { id: "lead-4" }] },
    summary: "4 leads generated",
  },
  content_campaign: {
    data: { itemCount: 4, enrollmentCount: 4, messageDraftIds: ["d-1", "d-2", "d-3", "d-4"] },
    summary: "4 messages drafted",
  },
  approval_compliance_gate: {
    data: { approvedAndEligible: ["d-1", "d-2", "d-3", "d-4"], approvedButBlocked: [], rejected: [] },
    summary: "all approved",
  },
  campaign_execution: {
    data: { advancedCount: 2, tasksCreated: 2 },
    summary: "2 sequence tasks created",
  },
};

beforeEach(() => {
  computeFunnelDropoffMock.mockReset();
  recommendNextActionsMock.mockReset();
});

describe("runAnalyticsLearningStage", () => {
  it("happy path: composes real data from every sub-call plus a cross-stage pipelineSummary", async () => {
    computeFunnelDropoffMock.mockResolvedValueOnce({
      stages: [
        { stage: "discovered", count: 10 },
        { stage: "qualified", count: 8 },
        { stage: "contacted", count: 4 },
        { stage: "replied", count: 2 },
      ],
      dropoffs: [
        { fromStage: "discovered", toStage: "qualified", dropoffPercent: 20 },
        { fromStage: "qualified", toStage: "contacted", dropoffPercent: 50 },
        { fromStage: "contacted", toStage: "replied", dropoffPercent: 50 },
      ],
    });
    recommendNextActionsMock.mockResolvedValueOnce([
      "2 lead(s) scored above 70 have not been contacted yet — review the priority queue.",
      "No scoring rubric is active for this project yet — set one up to start qualifying leads.",
    ]);

    const queryMock = makeQueryMock(
      { rows: [{ channel: "email", total_variants: "2", leads_contacted: "6", leads_replied_interested: "3" }] },
      { rows: [{ feedback: "good", count: "20" }, { feedback: "bad", count: "15" }] },
    );

    const result = await runAnalyticsLearningStage(
      baseInput({
        tenantDb: { query: queryMock },
        priorStageResults: FULL_PRIOR_STAGE_RESULTS,
      }) as any,
    );

    expect(result.stage).toBe("analytics_learning");
    expect(result.status).toBe("completed");

    // Real numbers from prior stages show up in the summary sentence.
    expect(result.summary).toContain("4 lead(s) generated");
    expect(result.summary).toContain("4 message(s) drafted");
    expect(result.summary).toContain("4 sequence enrollment(s)");
    expect(result.summary).toContain("2 sequence task(s) created");
    expect(result.summary).toContain("50% between qualified and contacted");
    expect(result.summary).toContain("2 next-best-action(s) recommended");

    // Full structured sub-call output lands in data.
    expect(result.data.funnel).toEqual({
      stages: [
        { stage: "discovered", count: 10 },
        { stage: "qualified", count: 8 },
        { stage: "contacted", count: 4 },
        { stage: "replied", count: 2 },
      ],
      dropoffs: [
        { fromStage: "discovered", toStage: "qualified", dropoffPercent: 20 },
        { fromStage: "qualified", toStage: "contacted", dropoffPercent: 50 },
        { fromStage: "contacted", toStage: "replied", dropoffPercent: 50 },
      ],
    });
    expect(result.data.variantPerformance).toEqual({
      channels: [
        { channel: "email", totalVariants: 2, leadsContacted: 6, leadsRepliedInterested: 3, replyRate: 0.5 },
      ],
      note: null,
    });
    expect(result.data.rubricReviewReadiness).toEqual({
      feedbackCount: 35,
      readyForReview: true,
      goodCount: 20,
      badCount: 15,
    });
    expect(result.data.nextBestActions).toEqual([
      "2 lead(s) scored above 70 have not been contacted yet — review the priority queue.",
      "No scoring rubric is active for this project yet — set one up to start qualifying leads.",
    ]);

    // Cross-stage pipelineSummary pulls real numbers from all 6 prior stages.
    expect(result.data.pipelineSummary).toEqual({
      clientOnboarding: { industryTemplate: "saas", icpProfilesCreated: 2 },
      research: { findingsCount: 3 },
      leadGeneration: { leadsCreated: 4 },
      contentCampaign: { itemCount: 4, enrollmentCount: 4 },
      approvalComplianceGate: { approvedAndEligible: 4, approvedButBlocked: 0, rejected: 0 },
      campaignExecution: { tasksCreated: 2, advancedCount: 2 },
    });
  });

  it("does not fail the whole stage when computeFunnelDropoff throws — records an honest error section instead", async () => {
    computeFunnelDropoffMock.mockRejectedValueOnce(new Error("boom"));
    recommendNextActionsMock.mockResolvedValueOnce([]);

    const queryMock = makeQueryMock({ missingTable: true }, { missingTable: true });

    const result = await runAnalyticsLearningStage(
      baseInput({ tenantDb: { query: queryMock }, priorStageResults: {} }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.funnel).toEqual({ section: "funnel", error: "boom" });
    // The rest of the stage still ran and reported honestly.
    expect(result.data.variantPerformance).toEqual({ channels: [], note: "not enough data yet" });
    expect(result.data.rubricReviewReadiness).toEqual({
      feedbackCount: 0,
      readyForReview: false,
      goodCount: 0,
      badCount: 0,
    });
  });

  it("does not fail the whole stage when recommendNextActions throws — records an honest error section instead", async () => {
    computeFunnelDropoffMock.mockResolvedValueOnce({ stages: [], dropoffs: [] });
    recommendNextActionsMock.mockRejectedValueOnce(new Error("db exploded"));

    const queryMock = makeQueryMock({ missingTable: true }, { missingTable: true });

    const result = await runAnalyticsLearningStage(
      baseInput({ tenantDb: { query: queryMock }, priorStageResults: {} }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.nextBestActions).toEqual({ section: "nextBestActions", error: "db exploded" });
  });

  it("degrades variant-performance gracefully when message_draft_variants is missing, without failing the stage", async () => {
    computeFunnelDropoffMock.mockResolvedValueOnce({ stages: [], dropoffs: [] });
    recommendNextActionsMock.mockResolvedValueOnce([]);

    const queryMock = makeQueryMock(
      { missingTable: true },
      { rows: [{ feedback: "good", count: "1" }] },
    );

    const result = await runAnalyticsLearningStage(
      baseInput({ tenantDb: { query: queryMock }, priorStageResults: {} }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.variantPerformance).toEqual({ channels: [], note: "not enough data yet" });
    expect(result.summary).toContain("not enough data yet");
  });

  it("degrades rubric-review-readiness gracefully when lead_score_feedback is missing, without failing the stage", async () => {
    computeFunnelDropoffMock.mockResolvedValueOnce({ stages: [], dropoffs: [] });
    recommendNextActionsMock.mockResolvedValueOnce([]);

    const queryMock = makeQueryMock(
      { rows: [] },
      { missingTable: true },
    );

    const result = await runAnalyticsLearningStage(
      baseInput({ tenantDb: { query: queryMock }, priorStageResults: {} }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.data.rubricReviewReadiness).toEqual({
      feedbackCount: 0,
      readyForReview: false,
      goodCount: 0,
      badCount: 0,
    });
  });

  it("reports an honest 'no prior-stage counts' summary when priorStageResults is empty", async () => {
    computeFunnelDropoffMock.mockResolvedValueOnce({ stages: [], dropoffs: [] });
    recommendNextActionsMock.mockResolvedValueOnce([]);

    const queryMock = makeQueryMock({ missingTable: true }, { missingTable: true });

    const result = await runAnalyticsLearningStage(
      baseInput({ tenantDb: { query: queryMock }, priorStageResults: {} }) as any,
    );

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("no prior-stage counts were available to report");
    expect(result.data.pipelineSummary).toEqual({
      clientOnboarding: null,
      research: null,
      leadGeneration: null,
      contentCampaign: null,
      approvalComplianceGate: null,
      campaignExecution: null,
    });
  });
});
