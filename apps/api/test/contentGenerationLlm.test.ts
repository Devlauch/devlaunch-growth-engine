import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";

/**
 * Tests for apps/api/src/lib/contentGeneration.ts's enhanceBlogBodyWithLlm
 * — the opt-in LLM-enhancement seam this task wired in (see that file's
 * header comment + packages/db/migrations/562_*). Same mocking
 * convention as test/aiSalesAssistant.test.ts: fake PoolClient, and
 * ../src/lib/llmProvider.js / ../src/lib/llmBudget.js are mocked directly
 * (rather than mocking global fetch) so these tests exercise ONLY this
 * new orchestration logic — getLlmProvider()'s real Anthropic client
 * wiring is already covered by test/llmProvider.test.ts, and
 * isLlmBudgetExceeded/recordLlmUsage's real SQL by test/llmBudget.test.ts.
 *
 * The first test below is the explicit "deterministic fallback still
 * works with no LLM key configured" case this task's instructions
 * require: it never even imports a mocked llmProvider — it goes through
 * the REAL getLlmProvider()/env.ts with no ANTHROPIC_API_KEY set (the
 * default in this test environment), proving the honest not_configured
 * path works end-to-end, not just against a mock.
 */

function fakeClient() {
  const q = vi.fn();
  return { client: { query: q } as unknown as PoolClient, q };
}

const TENANT_ID = "tenant-1";
const PROJECT_ID = "project-1";

beforeEach(() => {
  vi.resetModules();
});

describe("enhanceBlogBodyWithLlm", () => {
  it("returns not_configured and leaves body null when no ANTHROPIC_API_KEY is set (real env.ts, no mocking)", async () => {
    const { enhanceBlogBodyWithLlm } = await import("../src/lib/contentGeneration.js");
    const { client, q } = fakeClient();

    const result = await enhanceBlogBodyWithLlm(client, TENANT_ID, PROJECT_ID, "Title", "Deterministic template body.");

    expect(result).toEqual({ status: "not_configured", body: null });
    // Never even queries the DB for budget when not configured.
    expect(q).not.toHaveBeenCalled();
  });

  it("returns budget_exceeded and leaves body null without ever calling the LLM when the tenant's monthly budget is used up", async () => {
    vi.doMock("../src/lib/llmProvider.js", () => ({
      getLlmProvider: () => ({
        name: "anthropic",
        isConfigured: true,
        complete: vi.fn(async () => {
          throw new Error("should never be called when budget is exceeded");
        }),
      }),
    }));
    vi.doMock("../src/lib/llmBudget.js", () => ({
      isLlmBudgetExceeded: vi.fn(async () => true),
      recordLlmUsage: vi.fn(async () => {
        throw new Error("should never be called when budget is exceeded");
      }),
    }));

    const { enhanceBlogBodyWithLlm } = await import("../src/lib/contentGeneration.js");
    const { client } = fakeClient();

    const result = await enhanceBlogBodyWithLlm(client, TENANT_ID, PROJECT_ID, "Title", "Deterministic template body.");

    expect(result).toEqual({ status: "budget_exceeded", body: null });
  });

  it("returns the real LLM text and records real usage when configured, under budget, and the call succeeds", async () => {
    const completeMock = vi.fn(async () => ({ text: "A polished, LLM-written article body.", inputTokens: 120, outputTokens: 300 }));
    const recordLlmUsageMock = vi.fn(async () => ({ inputTokens: 120, outputTokens: 300, estimatedCostUsd: 0.0048, note: "test" }));

    vi.doMock("../src/lib/llmProvider.js", () => ({
      getLlmProvider: () => ({ name: "anthropic", isConfigured: true, complete: completeMock }),
    }));
    vi.doMock("../src/lib/llmBudget.js", () => ({
      isLlmBudgetExceeded: vi.fn(async () => false),
      recordLlmUsage: recordLlmUsageMock,
    }));

    const { enhanceBlogBodyWithLlm } = await import("../src/lib/contentGeneration.js");
    const { client } = fakeClient();

    const result = await enhanceBlogBodyWithLlm(client, TENANT_ID, PROJECT_ID, "Title", "Deterministic template body.");

    expect(result).toEqual({ status: "ok", body: "A polished, LLM-written article body." });
    expect(completeMock).toHaveBeenCalledTimes(1);
    // Grounding: the prompt must include the real template body and an
    // explicit instruction not to invent new facts.
    const [prompt] = completeMock.mock.calls[0];
    expect(prompt).toContain("Deterministic template body.");
    expect(prompt.toLowerCase()).toContain("do not invent");
    expect(recordLlmUsageMock).toHaveBeenCalledWith(
      client,
      TENANT_ID,
      PROJECT_ID,
      { text: "A polished, LLM-written article body.", inputTokens: 120, outputTokens: 300 },
      { feature: "content_generation_blog_enhancement" },
    );
  });

  it("returns error and leaves body null (never throws) when the LLM call itself fails", async () => {
    vi.doMock("../src/lib/llmProvider.js", () => ({
      getLlmProvider: () => ({
        name: "anthropic",
        isConfigured: true,
        complete: vi.fn(async () => {
          throw new Error("simulated network failure");
        }),
      }),
    }));
    vi.doMock("../src/lib/llmBudget.js", () => ({
      isLlmBudgetExceeded: vi.fn(async () => false),
      recordLlmUsage: vi.fn(),
    }));

    const { enhanceBlogBodyWithLlm } = await import("../src/lib/contentGeneration.js");
    const { client } = fakeClient();

    const result = await enhanceBlogBodyWithLlm(client, TENANT_ID, PROJECT_ID, "Title", "Deterministic template body.");

    expect(result).toEqual({ status: "error", body: null });
  });
});
