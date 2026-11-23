import { describe, it } from "vitest";

/**
 * BLOCKED: no real Anthropic/OpenAI/any LLM API key is available in this
 * environment (confirmed by docs/BROADER_WORKSTREAM_AUDIT.md — zero LLM
 * credentials exist anywhere in this codebase). This file documents, in a
 * real, skipped test, exactly what a genuine authenticated validation run
 * would assert — it is intentionally never executed as part of the normal
 * suite. Same convention as test/hunterRealApi.skip.test.ts.
 *
 * To actually run this file for real: set a real ANTHROPIC_API_KEY env
 * var, delete the `.skip` on each `it`, and run
 * `ANTHROPIC_API_KEY=... npx vitest run test/llmRealApi.skip.test.ts`.
 */
describe("Anthropic Messages API — real, authenticated validation (BLOCKED: no key available)", () => {
  it.skip("a real completion request returns real, non-empty text and a real, positive input/output token count", async () => {
    // Would assert: new AnthropicLlmProvider(process.env.ANTHROPIC_API_KEY!, env.anthropicModel)
    // .complete("Say the word 'ok' and nothing else.") resolves with
    // result.text.length > 0, result.inputTokens > 0, result.outputTokens > 0 —
    // proving the real Messages API response shape (content[]/usage) matches
    // what llmProvider.ts assumes from documentation alone today.
  });

  it.skip("an invalid API key genuinely returns HTTP 401 from the real API (proving LlmApiError's status-401 classification against a REAL response, not an invented one)", async () => {
    // Would assert: new AnthropicLlmProvider("not-a-real-key", env.anthropicModel)
    // .complete("hi") rejects with LlmApiError whose .status === 401 and
    // .retryable === false.
  });

  it.skip("getLlmProvider() end-to-end: with a real ANTHROPIC_API_KEY set, a call through marketingQa.ts's answerQuestion populates a real, non-null llmExplanation", async () => {
    // Would assert: answerQuestion(tenantDb, tenantId, projectId, "how many leads do we have")
    // resolves with llmExplanation a non-null string, and a corresponding
    // real llm_tokens_input/llm_tokens_output row in usage_events for this
    // tenant (via llmBudget.ts's recordLlmUsage), proving the full
    // provider -> budget -> usage_events wiring works against a real call,
    // not just mocks.
  });
});
