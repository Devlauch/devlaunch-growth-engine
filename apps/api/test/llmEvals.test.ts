import { describe, it, expect } from "vitest";
import type { LlmProvider, LlmCompleteResult } from "../src/lib/llmProvider.js";
import {
  runLlmEvals,
  isValidJsonCheck,
  underApproxTokenLimitCheck,
  noPlaceholderTextCheck,
  nonEmptyCheck,
  type LlmEvalCase,
} from "../src/lib/llmEvalHarness.js";

/**
 * These are REAL tests of the eval harness and its checking logic, against
 * a fake/injectable LlmProvider that returns fixed, canned responses — NOT
 * tests that skip because no real LLM key exists (that distinction is the
 * whole point of this file, per this milestone's spec). Each `it` below
 * proves the harness correctly distinguishes a passing canned response from
 * a failing one, which is exactly what it would need to do correctly once a
 * real ANTHROPIC_API_KEY is ever configured and it runs against real
 * completions. test/llmRealApi.skip.test.ts separately documents what a
 * genuine real-provider run would assert (BLOCKED today, no key available).
 */

/** A fake LlmProvider whose `complete()` returns one fixed, injected response per call, in order. */
function fakeProvider(responses: LlmCompleteResult[]): LlmProvider {
  let i = 0;
  return {
    name: "fake",
    isConfigured: true,
    complete: async () => {
      const result = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return result;
    },
  };
}

describe("runLlmEvals + reusable checks", () => {
  it("passes a well-formed JSON response under the token ceiling with no placeholder text", async () => {
    const provider = fakeProvider([{ text: '{"recommendation":"follow up tomorrow","confidence":0.8}', inputTokens: 20, outputTokens: 15 }]);
    const cases: LlmEvalCase[] = [
      {
        name: "deal next-step suggestion is valid JSON",
        prompt: "Suggest a next step for this deal as JSON: {recommendation, confidence}.",
        maxTokens: 100,
        checks: [isValidJsonCheck, underApproxTokenLimitCheck(100), noPlaceholderTextCheck, nonEmptyCheck],
      },
    ];

    const [result] = await runLlmEvals(provider, cases);

    expect(result.allPassed).toBe(true);
    expect(result.checks).toEqual([
      { name: isValidJsonCheck.name, passed: true },
      { name: underApproxTokenLimitCheck(100).name, passed: true },
      { name: noPlaceholderTextCheck.name, passed: true },
      { name: nonEmptyCheck.name, passed: true },
    ]);
  });

  it("flags a response that is NOT valid JSON when JSON is required", async () => {
    const provider = fakeProvider([{ text: "Sure, here's a recommendation: follow up tomorrow.", inputTokens: 10, outputTokens: 12 }]);
    const cases: LlmEvalCase[] = [
      { name: "must be JSON", prompt: "Respond as JSON.", checks: [isValidJsonCheck] },
    ];

    const [result] = await runLlmEvals(provider, cases);

    expect(result.allPassed).toBe(false);
    expect(result.checks).toEqual([{ name: isValidJsonCheck.name, passed: false }]);
  });

  it("flags a response that exceeds the approximate token ceiling", async () => {
    const longText = "word ".repeat(500); // ~2500 chars => ~625 approx tokens
    const provider = fakeProvider([{ text: longText, inputTokens: 5, outputTokens: 625 }]);
    const cases: LlmEvalCase[] = [
      { name: "must be short", prompt: "Be brief.", maxTokens: 50, checks: [underApproxTokenLimitCheck(50)] },
    ];

    const [result] = await runLlmEvals(provider, cases);

    expect(result.allPassed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
  });

  it("flags obvious unfilled-template placeholder text", async () => {
    const provider = fakeProvider([{ text: "Hi [INSERT NAME], following up on {{deal_name}}.", inputTokens: 5, outputTokens: 10 }]);
    const cases: LlmEvalCase[] = [
      { name: "no placeholders allowed", prompt: "Draft a follow-up.", checks: [noPlaceholderTextCheck] },
    ];

    const [result] = await runLlmEvals(provider, cases);

    expect(result.allPassed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
  });

  it("flags an empty response", async () => {
    const provider = fakeProvider([{ text: "   ", inputTokens: 1, outputTokens: 0 }]);
    const cases: LlmEvalCase[] = [{ name: "must say something", prompt: "Say something.", checks: [nonEmptyCheck] }];

    const [result] = await runLlmEvals(provider, cases);

    expect(result.allPassed).toBe(false);
  });

  it("runs multiple fixed eval cases in order and reports a real per-case result for each", async () => {
    const provider = fakeProvider([
      { text: '{"ok":true}', inputTokens: 5, outputTokens: 5 },
      { text: "not json at all", inputTokens: 5, outputTokens: 5 },
    ]);
    const cases: LlmEvalCase[] = [
      { name: "case 1", prompt: "p1", checks: [isValidJsonCheck] },
      { name: "case 2", prompt: "p2", checks: [isValidJsonCheck] },
    ];

    const results = await runLlmEvals(provider, cases);

    expect(results).toHaveLength(2);
    expect(results[0].allPassed).toBe(true);
    expect(results[1].allPassed).toBe(false);
    // Real token counts are carried through from the (fake) provider's own
    // response, never recomputed/estimated by the harness itself.
    expect(results[0].inputTokens).toBe(5);
    expect(results[0].outputTokens).toBe(5);
  });
});
