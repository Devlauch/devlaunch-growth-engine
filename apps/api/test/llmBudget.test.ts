import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

/**
 * Lib-level tests against a minimal fake PoolClient — same pattern as
 * marketingIntelligence.test.ts's fakeClient() helper (answerQuestion /
 * recommendNextActions lib tests).
 */
function fakeClient() {
  const q = vi.fn();
  return { client: { query: q } as unknown as PoolClient, q };
}

const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";

describe("getLlmTokenUsageThisMonth / isLlmBudgetExceeded", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports unlimited (never exceeded) when no monthly budget is configured — the default in every environment this codebase runs in today", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { llmMonthlyTokenBudgetPerTenant: null } }));
    const { getLlmTokenUsageThisMonth, isLlmBudgetExceeded } = await import("../src/lib/llmBudget.js");

    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: "999999" }] });
    const usage = await getLlmTokenUsageThisMonth(client, TENANT_ID);
    expect(usage).toEqual({ tokensUsedThisMonth: 999999, monthlyBudget: null });

    q.mockResolvedValueOnce({ rows: [{ total: "999999" }] });
    expect(await isLlmBudgetExceeded(client, TENANT_ID)).toBe(false);
  });

  it("real SUM query scopes event_type to only the two LLM token types and the current calendar month", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { llmMonthlyTokenBudgetPerTenant: null } }));
    const { getLlmTokenUsageThisMonth } = await import("../src/lib/llmBudget.js");
    const { client, q } = fakeClient();
    q.mockResolvedValueOnce({ rows: [{ total: "0" }] });

    await getLlmTokenUsageThisMonth(client, TENANT_ID);

    const [sql, params] = q.mock.calls[0];
    expect(sql).toMatch(/event_type = ANY/);
    expect(sql).toMatch(/date_trunc\('month', now\(\)\)/);
    expect(params[0]).toBe(TENANT_ID);
    expect(params[1]).toEqual(["llm_tokens_input", "llm_tokens_output"]);
  });

  it("is exceeded once real usage reaches (or passes) a configured budget", async () => {
    vi.doMock("../src/config/env.js", () => ({ env: { llmMonthlyTokenBudgetPerTenant: 1000 } }));
    const { isLlmBudgetExceeded } = await import("../src/lib/llmBudget.js");
    const { client, q } = fakeClient();

    q.mockResolvedValueOnce({ rows: [{ total: "999" }] });
    expect(await isLlmBudgetExceeded(client, TENANT_ID)).toBe(false);

    q.mockResolvedValueOnce({ rows: [{ total: "1000" }] });
    expect(await isLlmBudgetExceeded(client, TENANT_ID)).toBe(true);

    q.mockResolvedValueOnce({ rows: [{ total: "5000" }] });
    expect(await isLlmBudgetExceeded(client, TENANT_ID)).toBe(true);
  });
});

describe("estimateLlmCostUsd", () => {
  it("computes cost FROM real token counts using documented per-million pricing, never a flat invented number", async () => {
    const { estimateLlmCostUsd, PUBLISHED_PRICE_PER_MILLION_INPUT_TOKENS_USD, PUBLISHED_PRICE_PER_MILLION_OUTPUT_TOKENS_USD } =
      await import("../src/lib/llmBudget.js");

    const result = estimateLlmCostUsd(1_000_000, 1_000_000);
    expect(result.estimatedCostUsd).toBeCloseTo(
      PUBLISHED_PRICE_PER_MILLION_INPUT_TOKENS_USD + PUBLISHED_PRICE_PER_MILLION_OUTPUT_TOKENS_USD,
      6,
    );
    expect(result.note).toMatch(/estimated based on published/i);
    expect(result.note).toMatch(/not an actual invoice amount/i);
  });

  it("returns exactly 0 for zero tokens", async () => {
    const { estimateLlmCostUsd } = await import("../src/lib/llmBudget.js");
    expect(estimateLlmCostUsd(0, 0).estimatedCostUsd).toBe(0);
  });
});

describe("recordLlmUsage", () => {
  it("writes exactly one llm_tokens_input row and one llm_tokens_output row, with the REAL token counts from the provider result — never an estimate", async () => {
    vi.resetModules();
    vi.doMock("../src/config/env.js", () => ({ env: { llmMonthlyTokenBudgetPerTenant: null } }));
    const { recordLlmUsage } = await import("../src/lib/llmBudget.js");
    const { client, q } = fakeClient();
    q.mockResolvedValue(undefined);

    await recordLlmUsage(client, TENANT_ID, PROJECT_ID, { text: "hi", inputTokens: 123, outputTokens: 45 }, { feature: "test" });

    expect(q).toHaveBeenCalledTimes(2);
    const [inputSql, inputParams] = q.mock.calls[0];
    expect(inputSql).toMatch(/INSERT INTO usage_events/);
    expect(inputParams).toEqual([TENANT_ID, PROJECT_ID, "llm_tokens_input", 123, expect.stringContaining('"feature":"test"')]);

    const [, outputParams] = q.mock.calls[1];
    expect(outputParams).toEqual([TENANT_ID, PROJECT_ID, "llm_tokens_output", 45, expect.stringContaining('"feature":"test"')]);
  });
});
