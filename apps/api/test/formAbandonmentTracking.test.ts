import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking pattern as cohortAnalysis.test.ts: fake pg client query, no
// real Postgres.
const queryMock = vi.fn();
const tenantDb = { query: queryMock } as unknown as import("pg").PoolClient;

const { getFormAbandonmentStats } = await import("../src/lib/formAbandonmentTracking.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "22222222-2222-2222-2222-222222222222";
const SURVEY_1 = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  queryMock.mockReset();
});

function mockSurveyWithQuestions(count: number) {
  queryMock.mockResolvedValueOnce({
    rowCount: 1,
    rows: [{ questions: Array.from({ length: count }, (_, i) => ({ key: `q${i}` })) }],
  });
}

describe("getFormAbandonmentStats", () => {
  it("builds a real cumulative started-vs-completed funnel from grouped answer-key counts", async () => {
    mockSurveyWithQuestions(3);
    queryMock.mockResolvedValueOnce({
      rows: [
        { completed: false, answered_count: "0", respondents: "2" },
        { completed: false, answered_count: "1", respondents: "3" },
        { completed: false, answered_count: "2", respondents: "1" },
        { completed: true, answered_count: "3", respondents: "4" },
      ],
    });

    const stats = await getFormAbandonmentStats(tenantDb, TENANT_A, PROJECT_1, SURVEY_1, {});

    expect(stats.totalQuestions).toBe(3);
    expect(stats.totalStarted).toBe(10);
    expect(stats.totalCompleted).toBe(4);
    expect(stats.completionRate).toBeCloseTo(0.4);

    expect(stats.funnel).toHaveLength(4); // steps 0..3

    expect(stats.funnel[0]).toMatchObject({ stepsAnswered: 0, respondentsReachingStep: 10, reachRate: 1, dropOffRate: 0 });
    expect(stats.funnel[1]).toMatchObject({ stepsAnswered: 1, respondentsReachingStep: 8, reachRate: 0.8 });
    expect(stats.funnel[1].dropOffRate).toBeCloseTo(0.2);
    expect(stats.funnel[2]).toMatchObject({ stepsAnswered: 2, respondentsReachingStep: 5, reachRate: 0.5 });
    expect(stats.funnel[2].dropOffRate).toBeCloseTo(0.375);
    expect(stats.funnel[3]).toMatchObject({ stepsAnswered: 3, respondentsReachingStep: 4, reachRate: 0.4 });
    expect(stats.funnel[3].dropOffRate).toBeCloseTo(0.2);
  });

  it("never divides by zero when nobody has started the survey yet", async () => {
    mockSurveyWithQuestions(2);
    queryMock.mockResolvedValueOnce({ rows: [] });

    const stats = await getFormAbandonmentStats(tenantDb, TENANT_A, PROJECT_1, SURVEY_1, {});

    expect(stats.totalStarted).toBe(0);
    expect(stats.totalCompleted).toBe(0);
    expect(stats.completionRate).toBe(0);
    for (const step of stats.funnel) {
      expect(step.reachRate).toBe(0);
      expect(step.dropOffRate).toBe(0);
    }
  });

  it("throws a 404 HttpError when the survey doesn't exist for this tenant/project", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(getFormAbandonmentStats(tenantDb, TENANT_A, PROJECT_1, SURVEY_1, {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it("defaults to a 30-day lookback window when no dateRange is given", async () => {
    mockSurveyWithQuestions(1);
    queryMock.mockResolvedValueOnce({ rows: [] });

    const stats = await getFormAbandonmentStats(tenantDb, TENANT_A, PROJECT_1, SURVEY_1, undefined);

    const from = new Date(stats.rangeFrom).getTime();
    const to = new Date(stats.rangeTo).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(to - from).toBeCloseTo(thirtyDaysMs, -3);
  });
});
