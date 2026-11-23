import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking pattern as cohortAnalysis.test.ts / leadIntelligence.test.ts:
// fake pg client, no real Postgres.
const queryMock = vi.fn();
const tenantDb = { query: queryMock } as unknown as import("pg").PoolClient;

const { evaluateConditionalQuestions, recordSurveyResponse, computeNpsScore, computeCsatScore, syncResponseToCrm } =
  await import("../src/lib/surveyEngine.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const SURVEY_1 = "22222222-2222-2222-2222-222222222222";
const RESPONSE_1 = "33333333-3333-3333-3333-333333333333";
const LEAD_1 = "44444444-4444-4444-4444-444444444444";

beforeEach(() => {
  queryMock.mockReset();
});

// ---------------------------------------------------------------------------
// evaluateConditionalQuestions (pure function)
// ---------------------------------------------------------------------------

describe("evaluateConditionalQuestions", () => {
  const survey = {
    id: SURVEY_1,
    type: "qualification" as const,
    questions: [
      { key: "role", type: "single_choice" as const, label: "What is your role?", options: ["Engineer", "Manager"] },
      {
        key: "team_size",
        type: "text" as const,
        label: "How big is your team?",
        conditionalOn: { questionKey: "role", equals: "Manager" },
      },
      {
        key: "wants_demo",
        type: "single_choice" as const,
        label: "Want a live demo?",
        options: ["Yes", "No"],
      },
      {
        key: "demo_time",
        type: "text" as const,
        label: "Preferred time?",
        conditionalOn: { questionKey: "wants_demo", equals: "Yes" },
      },
    ],
  };

  it("shows every unconditional, unanswered question up front", () => {
    const next = evaluateConditionalQuestions(survey, {});
    expect(next.map((q) => q.key)).toEqual(["role", "wants_demo"]);
  });

  it("hides a conditional question until its trigger question is answered", () => {
    const next = evaluateConditionalQuestions(survey, { role: "Engineer" });
    // role=Engineer never satisfies team_size's equals:"Manager" rule.
    expect(next.map((q) => q.key)).toEqual(["wants_demo"]);
  });

  it("reveals a conditional question once its equals rule is satisfied", () => {
    const next = evaluateConditionalQuestions(survey, { role: "Manager" });
    expect(next.map((q) => q.key)).toEqual(["team_size", "wants_demo"]);
  });

  it("can reveal two independent branches at once", () => {
    const next = evaluateConditionalQuestions(survey, { role: "Manager", wants_demo: "Yes" });
    expect(next.map((q) => q.key).sort()).toEqual(["demo_time", "team_size"]);
  });

  it("never re-shows an already-answered question", () => {
    const next = evaluateConditionalQuestions(survey, {
      role: "Manager",
      team_size: "12",
      wants_demo: "Yes",
    });
    expect(next.map((q) => q.key)).toEqual(["demo_time"]);
  });

  it("supports notEquals and in operators", () => {
    const notEqualsSurvey = {
      id: SURVEY_1,
      type: "qualification" as const,
      questions: [
        { key: "a", type: "text" as const, label: "A" },
        { key: "b", type: "text" as const, label: "B", conditionalOn: { questionKey: "a", notEquals: "skip" } },
        { key: "c", type: "text" as const, label: "C", conditionalOn: { questionKey: "a", in: ["x", "y"] } },
      ],
    };
    expect(evaluateConditionalQuestions(notEqualsSurvey, { a: "skip" }).map((q) => q.key)).toEqual([]);
    expect(evaluateConditionalQuestions(notEqualsSurvey, { a: "anything" }).map((q) => q.key)).toEqual(["b"]);
    expect(evaluateConditionalQuestions(notEqualsSurvey, { a: "x" }).map((q) => q.key).sort()).toEqual(["b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// recordSurveyResponse
// ---------------------------------------------------------------------------

describe("recordSurveyResponse", () => {
  it("inserts a brand-new response row when no responseId is given", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: RESPONSE_1 }] });

    const id = await recordSurveyResponse(tenantDb, TENANT_A, SURVEY_1, { step1: "answer" }, { visitorId: "v-123456" });

    expect(id).toBe(RESPONSE_1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO survey_responses/);
    expect(params).toEqual([SURVEY_1, TENANT_A, null, "v-123456", JSON.stringify({ step1: "answer" }), null, false]);
  });

  it("merges partial answers into an existing response when responseId is given", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: RESPONSE_1 }] });

    const id = await recordSurveyResponse(
      tenantDb,
      TENANT_A,
      SURVEY_1,
      { step2: "answer2" },
      { responseId: RESPONSE_1, markComplete: true, score: 9 },
    );

    expect(id).toBe(RESPONSE_1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE survey_responses/);
    expect(params).toEqual([JSON.stringify({ step2: "answer2" }), 9, null, null, true, RESPONSE_1, TENANT_A, SURVEY_1]);
  });

  it("throws when updating a responseId that doesn't exist for this tenant/survey", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      recordSurveyResponse(tenantDb, TENANT_A, SURVEY_1, {}, { responseId: "does-not-exist" }),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// computeNpsScore
// ---------------------------------------------------------------------------

describe("computeNpsScore", () => {
  it("computes the standard %promoters - %detractors formula", () => {
    // 10 responses: 6 promoters (9-10), 2 passives (7-8), 2 detractors (0-6).
    const responses = [
      { score: 9 },
      { score: 10 },
      { score: 9 },
      { score: 10 },
      { score: 9 },
      { score: 9 },
      { score: 7 },
      { score: 8 },
      { score: 3 },
      { score: 5 },
    ];
    const result = computeNpsScore(responses);
    expect(result.promoters).toBe(6);
    expect(result.passives).toBe(2);
    expect(result.detractors).toBe(2);
    // 60% - 20% = 40
    expect(result.score).toBe(40);
  });

  it("returns an all-zero result for no scored responses", () => {
    expect(computeNpsScore([{ score: null }])).toEqual({ score: 0, promoters: 0, passives: 0, detractors: 0 });
  });

  it("can produce a negative score when detractors dominate", () => {
    const responses = [{ score: 0 }, { score: 2 }, { score: 9 }];
    const result = computeNpsScore(responses);
    // 1 promoter (33.3%), 2 detractors (66.7%) -> round(33.33 - 66.67) = -33
    expect(result.score).toBe(-33);
  });
});

// ---------------------------------------------------------------------------
// computeCsatScore
// ---------------------------------------------------------------------------

describe("computeCsatScore", () => {
  it("computes average, distribution, and top-two-box percent on a 1-5 scale", () => {
    const responses = [{ score: 5 }, { score: 5 }, { score: 4 }, { score: 3 }, { score: 1 }];
    const result = computeCsatScore(responses);
    expect(result.average).toBe((5 + 5 + 4 + 3 + 1) / 5);
    expect(result.distribution).toEqual({ 5: 2, 4: 1, 3: 1, 1: 1 });
    // top-box (4 or 5) = 3 of 5 = 60%
    expect(result.topBoxPercent).toBe(60);
  });

  it("returns an all-zero result for no scored responses", () => {
    expect(computeCsatScore([])).toEqual({ average: 0, distribution: {}, topBoxPercent: 0 });
  });
});

// ---------------------------------------------------------------------------
// syncResponseToCrm
// ---------------------------------------------------------------------------

describe("syncResponseToCrm", () => {
  it("writes an audit_events row (the activity-timeline's real read path) when the response has a lead_id", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const wrote = await syncResponseToCrm(tenantDb, TENANT_A, {
      id: RESPONSE_1,
      survey_id: SURVEY_1,
      lead_id: LEAD_1,
      score: 9,
      completed: true,
    });

    expect(wrote).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO audit_events/);
    expect(params[0]).toBe(TENANT_A);
    expect(params[1]).toBe("survey.response_completed");
    expect(params[2]).toBe(LEAD_1);
  });

  it("is a no-op (no query at all) when the response has no lead_id", async () => {
    const wrote = await syncResponseToCrm(tenantDb, TENANT_A, {
      id: RESPONSE_1,
      survey_id: SURVEY_1,
      lead_id: null,
      score: null,
      completed: false,
    });

    expect(wrote).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
