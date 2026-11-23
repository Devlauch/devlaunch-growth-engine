import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

/**
 * Lib-level tests against a minimal fake PoolClient — same fakeClient()
 * pattern as marketingIntelligence.test.ts / llmBudget.test.ts. No LLM is
 * configured in this test environment (ANTHROPIC_API_KEY unset), so every
 * case here exercises the deterministic-fallback-first property: the
 * `deterministic` result is always a complete, real result, and `llm`
 * always honestly reports `status: "not_configured"`.
 */
function fakeClient() {
  const q = vi.fn();
  return { client: { query: q } as unknown as PoolClient, q };
}

const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";
const DEAL_ID = "deal-1";

beforeEach(() => {
  vi.resetModules();
});

describe("summarizeDealForHandoff", () => {
  it("returns a complete deterministic summary and an honest not_configured llm status when no LLM key is set", async () => {
    vi.doMock("../src/config/env.js", () => ({
      env: { anthropicApiKey: null, anthropicModel: "claude-sonnet-4-5-20250929", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" },
    }));
    const { summarizeDealForHandoff } = await import("../src/lib/aiSalesAssistant.js");
    const { client, q } = fakeClient();

    // 1: loadDealOr404
    q.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: DEAL_ID, lead_id: "lead-1", stage: "qualified", stage_changed_at: new Date().toISOString(), created_at: new Date().toISOString(), value_amount: "5000" }],
    });
    // 2-8: loadDealHealthSignals' 7 queries
    q.mockResolvedValueOnce({ rows: [] }); // latest meeting
    q.mockResolvedValueOnce({ rows: [] }); // latest reply
    q.mockResolvedValueOnce({ rows: [{ max: null }] }); // meeting activity max
    q.mockResolvedValueOnce({ rows: [{ max: null }] }); // reply activity max
    q.mockResolvedValueOnce({ rows: [{ max: null }] }); // note activity max
    q.mockResolvedValueOnce({ rows: [{ max: null }] }); // task activity max
    q.mockResolvedValueOnce({ rows: [{ avg_value: null, cnt: "0" }] }); // typical value
    // 9-15: getLeadActivityTimeline's 7 queries
    q.mockResolvedValueOnce({ rows: [] }); // assignments
    q.mockResolvedValueOnce({ rows: [] }); // deals
    q.mockResolvedValueOnce({ rows: [] }); // meetings
    q.mockResolvedValueOnce({ rows: [] }); // tasks
    q.mockResolvedValueOnce({ rows: [] }); // notes
    q.mockResolvedValueOnce({ rows: [] }); // replies
    q.mockResolvedValueOnce({ rows: [] }); // audit events

    const summary = await summarizeDealForHandoff(client, TENANT_ID, PROJECT_ID, DEAL_ID);

    expect(summary.dealId).toBe(DEAL_ID);
    expect(summary.deterministic.stage).toBe("qualified");
    expect(typeof summary.deterministic.score).toBe("number");
    expect(Array.isArray(summary.deterministic.why)).toBe(true);
    expect(summary.deterministic.recentActivity).toEqual([]);
    expect(summary.llm).toEqual({ status: "not_configured", text: null });
  });

  it("propagates a real 404 when the deal doesn't exist in this tenant/project", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" } }));
    const { summarizeDealForHandoff } = await import("../src/lib/aiSalesAssistant.js");
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(summarizeDealForHandoff(client, TENANT_ID, PROJECT_ID, "missing-deal")).rejects.toThrow(/not found/i);
  });
});

describe("draftObjectionResponse", () => {
  it("classifies the objection deterministically and returns a real template response, with an honest not_configured llm status", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { anthropicApiKey: null, anthropicModel: "m", llmMonthlyTokenBudgetPerTenant: null, logLevel: "silent" } }));
    const { draftObjectionResponse } = await import("../src/lib/aiSalesAssistant.js");
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: DEAL_ID }] }); // loadDealOr404

    const draft = await draftObjectionResponse(client, TENANT_ID, PROJECT_ID, DEAL_ID, "We don't have budget for this right now");

    expect(draft.deterministic.classification.theme).toBe("no_budget");
    expect(draft.deterministic.templateResponse.length).toBeGreaterThan(0);
    expect(draft.llm).toEqual({ status: "not_configured", text: null });
  });
});
