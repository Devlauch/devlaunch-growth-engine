import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { PoolClient } from "pg";

// Same mocking pattern as learningLoop.test.ts / replies.test.ts: fake the
// pg pool so the route-level tests are true unit tests with no real
// Postgres. The lib-level tests (answerQuestion / recommendNextActions /
// generateReport) instead build a minimal fake PoolClient directly, since
// those functions take a tenantDb client as a parameter rather than going
// through the pool.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

const { marketingIntelligenceRouter } = await import("../src/routes/marketingIntelligence.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { answerQuestion } = await import("../src/lib/marketingQa.js");
const { recommendNextActions } = await import("../src/lib/nextBestAction.js");
const { generateReport, computePeriodEnd } = await import("../src/lib/reportGenerator.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/tenants/:tenantId/projects/:projectId/marketing-intelligence",
    marketingIntelligenceRouter,
  );
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

/**
 * A minimal fake PoolClient for calling the lib functions directly
 * (answerQuestion / recommendNextActions / generateReport), bypassing the
 * route/pool layer entirely. `query` responses are queued in the exact
 * order the function under test is expected to issue them.
 */
function fakeClient() {
  const q = vi.fn();
  return { client: { query: q } as unknown as PoolClient, q };
}

function queueMany(q: ReturnType<typeof vi.fn>, n: number, response: unknown) {
  for (let i = 0; i < n; i++) q.mockResolvedValueOnce(response);
}

const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";

describe("answerQuestion", () => {
  it("answers 'how many leads do we have' (all-time) with a real count", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ count: 42 }] });

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "How many leads do we have?");

    expect(result.matchedIntent).toBe("lead_count");
    expect(result.answer).toBe("There are 42 lead(s) in total.");
  });

  it("answers a lead-count question scoped to 'this week'", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ count: 5 }] });

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "how many leads this week");

    expect(result.matchedIntent).toBe("lead_count");
    expect(result.answer).toBe("There are 5 lead(s) this week.");
  });

  it("honestly explains a real lead drop week-over-week", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ count: 4 }] }); // this week
    q.mockResolvedValueOnce({ rows: [{ count: 12 }] }); // last week

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "why did leads drop?");

    expect(result.matchedIntent).toBe("why_leads_dropped");
    expect(result.answer).toBe("Leads dropped from 12 last week to 4 this week (a 67% decrease).");
  });

  it("honestly reports when leads did NOT drop, instead of forcing a decline narrative", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ count: 9 }] }); // this week
    q.mockResolvedValueOnce({ rows: [{ count: 4 }] }); // last week

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "why are leads down");

    expect(result.matchedIntent).toBe("why_leads_dropped");
    expect(result.answer).toBe("Leads didn't drop — up from 4 to 9 this week.");
  });

  it("names the real top lead source", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ source: "referral", count: 7 }] });

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "which source is best?");

    expect(result.matchedIntent).toBe("top_source");
    expect(result.answer).toBe('The top lead source is "referral" with 7 lead(s).');
  });

  it("honestly reports no leads yet for top source when there are none", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "top source?");

    expect(result.matchedIntent).toBe("top_source");
    expect(result.answer).toBe("There are no leads yet, so there is no top source to report.");
  });

  it("computes a real conversion rate", async () => {
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: 10, converted: 3 }] });

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "what's our conversion rate?");

    expect(result.matchedIntent).toBe("conversion_rate");
    expect(result.answer).toBe(
      "3 of 10 lead(s) have converted (status qualified or approved_for_outreach) — a conversion rate of 30%.",
    );
  });

  it("delegates 'what should I do next' to recommendNextActions and reports honestly when nothing is flagged", async () => {
    const { client, q } = fakeClient();
    // recommendNextActions' four checks, all non-triggering (see
    // recommendNextActions test suite below for the exact query shapes).
    queueMany(q, 3, { rows: [{ count: 0 }] }); // uncontactedHighScored
    queueMany(q, 3, { rows: [{ count: 0 }] }); // unscoredLeads
    queueMany(q, 3, { rows: [] }); // domainHealth
    queueMany(q, 3, { rows: [{ count: 1 }] }); // activeRubric present

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "what should I do next?");

    expect(result.matchedIntent).toBe("next_best_action");
    expect(result.answer).toBe("Nothing stands out right now — no recommendation is currently flagged for this project.");
  });

  it("returns the honest fallback, listing supported questions, for an unmatched question", async () => {
    const { client } = fakeClient();

    const result = await answerQuestion(client, TENANT_ID, PROJECT_ID, "what's the weather like today?");

    expect(result.matchedIntent).toBeNull();
    expect(result.answer).toMatch(/^I can't answer that yet\. Try asking:/);
    expect(result.answer).toContain("how many leads do we have");
    expect(result.answer).toContain("why did leads drop");
    expect(result.answer).toContain("what's our top lead source");
    expect(result.answer).toContain("what's our conversion rate");
    expect(result.answer).toContain("what should I do next");
  });
});

describe("recommendNextActions", () => {
  it("flags every condition that is actually true", async () => {
    const { client, q } = fakeClient();
    // 1. uncontactedHighScored: SAVEPOINT, query, RELEASE
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce({ rows: [{ count: 5 }] });
    q.mockResolvedValueOnce(undefined);
    // 2. unscoredLeads
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    q.mockResolvedValueOnce(undefined);
    // 3. domainHealth — one domain with an elevated bounce rate (10/100 = 10% > 5%)
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce({
      rows: [{ domain: "example.com", sent_count: 100, bounced_count: 10, complained_count: 0 }],
    });
    q.mockResolvedValueOnce(undefined);
    // 4. activeRubric: none active
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    q.mockResolvedValueOnce(undefined);

    const actions = await recommendNextActions(client, TENANT_ID, PROJECT_ID);

    expect(actions).toEqual([
      "5 lead(s) scored above 70 have not been contacted yet — review the priority queue.",
      "3 lead(s) are still unscored — consider running /recompute.",
      expect.stringContaining("Bounce/complaint rate on example.com is elevated"),
      "No scoring rubric is active for this project yet — set one up to start qualifying leads.",
    ]);
  });

  it("returns an empty array when no condition is actually true", async () => {
    const { client, q } = fakeClient();
    queueMany(q, 3, { rows: [{ count: 0 }] }); // uncontactedHighScored
    queueMany(q, 3, { rows: [{ count: 0 }] }); // unscoredLeads
    queueMany(q, 3, { rows: [] }); // domainHealth: no domains
    queueMany(q, 3, { rows: [{ count: 1 }] }); // activeRubric present

    const actions = await recommendNextActions(client, TENANT_ID, PROJECT_ID);

    expect(actions).toEqual([]);
  });

  it("degrades gracefully when lead_scores/message_drafts don't exist, and still reports real unscored-lead count via the fallback query", async () => {
    const { client, q } = fakeClient();
    const missingTable = Object.assign(new Error('relation "lead_scores" does not exist'), { code: "42P01" });

    // 1. uncontactedHighScored: SAVEPOINT, query (rejects), ROLLBACK, RELEASE
    q.mockResolvedValueOnce(undefined);
    q.mockRejectedValueOnce(missingTable);
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce(undefined);
    // 2. unscoredLeads: SAVEPOINT, query (rejects), ROLLBACK, RELEASE, then the
    // honest fallback: a real total-leads count (no join needed).
    q.mockResolvedValueOnce(undefined);
    q.mockRejectedValueOnce(missingTable);
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce({ rows: [{ count: 7 }] });
    // 3. domainHealth: table missing too
    const missingDomains = Object.assign(new Error('relation "sending_domains" does not exist'), { code: "42P01" });
    q.mockResolvedValueOnce(undefined);
    q.mockRejectedValueOnce(missingDomains);
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce(undefined);
    // 4. activeRubric: table missing too
    const missingRubrics = Object.assign(new Error('relation "scoring_rubrics" does not exist'), { code: "42P01" });
    q.mockResolvedValueOnce(undefined);
    q.mockRejectedValueOnce(missingRubrics);
    q.mockResolvedValueOnce(undefined);
    q.mockResolvedValueOnce(undefined);

    const actions = await recommendNextActions(client, TENANT_ID, PROJECT_ID);

    expect(actions).toEqual(["7 lead(s) are still unscored — consider running /recompute."]);
  });
});

describe("generateReport", () => {
  function queueHappyPath(q: ReturnType<typeof vi.fn>, overrides: Partial<{ newLeads: number }> = {}) {
    q.mockResolvedValueOnce({ rows: [{ count: overrides.newLeads ?? 0 }] }); // newLeadsResult
    q.mockResolvedValueOnce({ rows: [] }); // byStatusResult
    q.mockResolvedValueOnce({ rows: [] }); // bySourceResult
    q.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // campaignsCreatedResult
    q.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // campaignsApprovedResult
    queueMany(q, 3, { rows: [] }); // avgScoreResult (runOptional, degraded=false, no rows -> "no data yet")
    queueMany(q, 3, { rows: [{ count: 0 }] }); // discoveredOrganizations
    queueMany(q, 3, { rows: [{ count: 0 }] }); // qualifiedCombined
    queueMany(q, 3, { rows: [{ count: 0 }] }); // contacted
    queueMany(q, 3, { rows: [{ count: 0 }] }); // replied
  }

  it("computes the correct weekly period boundary (periodStart + 6 days)", () => {
    const start = new Date("2026-11-02T00:00:00.000Z"); // a Monday
    const end = computePeriodEnd("weekly", start);
    expect(end.toISOString().slice(0, 10)).toBe("2026-11-08");
  });

  it("computes the correct monthly period boundary (last day of periodStart's month)", () => {
    const start = new Date("2026-02-10T00:00:00.000Z");
    const end = computePeriodEnd("monthly", start);
    // 2026 is not a leap year — February has 28 days.
    expect(end.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("computes the correct monthly period boundary for a 31-day month", () => {
    const start = new Date("2026-01-15T00:00:00.000Z");
    const end = computePeriodEnd("monthly", start);
    expect(end.toISOString().slice(0, 10)).toBe("2026-01-31");
  });

  it("returns a real weekly report with matching period boundaries", async () => {
    const { client, q } = fakeClient();
    queueHappyPath(q, { newLeads: 11 });

    const report = await generateReport(client, TENANT_ID, PROJECT_ID, "weekly", new Date("2026-11-02T00:00:00.000Z"));

    expect(report.periodType).toBe("weekly");
    expect(report.periodStart).toBe("2026-11-02");
    expect(report.periodEnd).toBe("2026-11-08");
    expect(report.leads.newCount).toBe(11);
    expect(report.averageLeadScore).toBeNull();
    expect(report.averageLeadScoreNote).toBe("no data yet");
  });

  it("returns a real monthly report with matching period boundaries", async () => {
    const { client, q } = fakeClient();
    queueHappyPath(q, { newLeads: 3 });

    const report = await generateReport(
      client,
      TENANT_ID,
      PROJECT_ID,
      "monthly",
      new Date("2026-02-01T00:00:00.000Z"),
    );

    expect(report.periodType).toBe("monthly");
    expect(report.periodStart).toBe("2026-02-01");
    expect(report.periodEnd).toBe("2026-02-28");
    expect(report.leads.newCount).toBe(3);
  });
});

describe("POST .../marketing-intelligence/ask", () => {
  it("logs and honestly answers an unmatched question with the supported-questions fallback", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), projectRow, undefined /* INSERT marketing_qa_log */]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/marketing-intelligence/ask`)
      .set("X-Dev-User-Id", USER_1)
      .send({ question: "what's the stock market doing" });

    expect(res.status).toBe(200);
    expect(res.body.matchedIntent).toBeNull();
    expect(res.body.answer).toMatch(/^I can't answer that yet\. Try asking:/);

    // The question is logged regardless of match — confirm the insert ran
    // with matched_intent = null, not silently skipped.
    const insertCall = queryMock.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO marketing_qa_log"));
    expect(insertCall).toBeTruthy();
    expect(insertCall![1]).toEqual([
      TENANT_A,
      PROJECT_1,
      USER_1,
      "what's the stock market doing",
      null,
      res.body.answer,
    ]);
  });

  it("logs and answers a matched question for a real intent", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      { rows: [{ count: 9 }] }, // lead_count query
      undefined, // INSERT marketing_qa_log
    ]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/marketing-intelligence/ask`)
      .set("X-Dev-User-Id", USER_1)
      .send({ question: "how many leads do we have" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matchedIntent: "lead_count",
      answer: "There are 9 lead(s) in total.",
      // Milestone 5 (P4): no LLM is configured in this test environment, so
      // the optional LLM-explanation enhancement honestly degrades to null
      // and the deterministic matchedIntent/answer above are unchanged.
      llmExplanation: null,
    });

    const insertCall = queryMock.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO marketing_qa_log"));
    expect(insertCall![1]).toEqual([TENANT_A, PROJECT_1, USER_1, "how many leads do we have", "lead_count", "There are 9 lead(s) in total."]);
  });

  it("rejects an empty question with a 400 before touching the database", async () => {
    const app = buildApp();
    queueResponses([...mockMembership(), projectRow]);

    const res = await request(app)
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/marketing-intelligence/ask`)
      .set("X-Dev-User-Id", USER_1)
      .send({ question: "" });

    expect(res.status).toBe(400);
  });
});

describe("GET .../marketing-intelligence/next-best-actions", () => {
  it("returns an empty array, not an error, when nothing is flagged", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      undefined,
      { rows: [{ count: 0 }] },
      undefined, // uncontactedHighScored
      undefined,
      { rows: [{ count: 0 }] },
      undefined, // unscoredLeads
      undefined,
      { rows: [] },
      undefined, // domainHealth
      undefined,
      { rows: [{ count: 1 }] },
      undefined, // activeRubric
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/marketing-intelligence/next-best-actions`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ actions: [] });
  });
});

describe("GET .../marketing-intelligence/qa-log", () => {
  it("lists logged questions, matched or not", async () => {
    const app = buildApp();
    queueResponses([
      ...mockMembership(),
      projectRow,
      {
        rows: [
          { id: "q1", question: "how many leads?", matched_intent: "lead_count", answer_summary: "There are 2 lead(s) in total.", created_at: "2026-11-01T00:00:00Z" },
          { id: "q2", question: "what's the weather", matched_intent: null, answer_summary: "I can't answer that yet. Try asking: ...", created_at: "2026-11-02T00:00:00Z" },
        ],
      },
    ]);

    const res = await request(app)
      .get(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/marketing-intelligence/qa-log`)
      .set("X-Dev-User-Id", USER_1);

    expect(res.status).toBe(200);
    expect(res.body.qaLog).toHaveLength(2);
    expect(res.body.qaLog[1].matched_intent).toBeNull();
  });
});
