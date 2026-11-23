import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { LlmProvider, LlmCompleteOptions, LlmCompleteResult } from "../src/lib/llmProvider.js";
import type { AgentDefinition } from "../src/lib/agentPlatform/core/agentRunner.js";
import {
  runAgentEvals,
  isValidJsonCheck,
  matchesOutputSchemaCheck,
  noPlaceholderTextCheck,
  groundedInEvidenceCheck,
} from "../src/lib/agentPlatform/core/agentEvalHarness.js";

/**
 * Harness-level tests against a FAKE, injectable LlmProvider that returns
 * canned text — same HONESTY NOTE as llmEvals.test.ts: this exercises the
 * REAL harness logic (prompt construction via the same buildAgentPrompt()
 * runAgent() itself uses, JSON-parseability, outputSchema structural
 * validation, placeholder detection, evidence-grounding check), never a
 * real LLM API call (no ANTHROPIC_API_KEY exists in this test environment).
 */
class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly isConfigured = true;
  constructor(private readonly responses: string[]) {}
  private callCount = 0;
  async complete(_prompt: string, _opts?: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const text = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount += 1;
    return { text, inputTokens: 10, outputTokens: 10 };
  }
}

const outputSchema = z.object({
  findings: z.array(z.string()),
  evidence: z.array(z.string()),
});

const fixtureAgent: AgentDefinition<{ subjectId: string }, z.infer<typeof outputSchema>> = {
  key: "fixture_agent",
  label: "Fixture Agent",
  systemPrompt: "You are a test fixture agent. Only use the grounding data given.",
  inputSchema: z.object({ subjectId: z.string() }),
  outputSchema,
  outputFormatDescription: '{ "findings": string[], "evidence": string[] }',
};

describe("runAgentEvals", () => {
  it("passes every default check for a well-formed, schema-valid, grounded response", async () => {
    const provider = new FakeLlmProvider([JSON.stringify({ findings: ["Finding A"], evidence: ["tool:x said A"] })]);
    const results = await runAgentEvals(fixtureAgent, provider, [
      { name: "case 1", input: { subjectId: "s1" }, toolEvidence: ["[tool:x] A"] },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].schemaValid).toBe(true);
    expect(results[0].allPassed).toBe(true);
    expect(results[0].checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        isValidJsonCheck.name,
        matchesOutputSchemaCheck.name,
        noPlaceholderTextCheck.name,
        groundedInEvidenceCheck.name,
      ]),
    );
  });

  it("fails isValidJsonCheck and matchesOutputSchemaCheck (but not noPlaceholderTextCheck) when the response isn't JSON at all", async () => {
    const provider = new FakeLlmProvider(["this is not json"]);
    const results = await runAgentEvals(fixtureAgent, provider, [{ name: "case 1", input: { subjectId: "s1" } }]);

    const byName = Object.fromEntries(results[0].checks.map((c) => [c.name, c.passed]));
    expect(byName[isValidJsonCheck.name]).toBe(false);
    expect(byName[matchesOutputSchemaCheck.name]).toBe(false);
    expect(byName[noPlaceholderTextCheck.name]).toBe(true);
    expect(results[0].allPassed).toBe(false);
    expect(results[0].parsedOutput).toBeNull();
  });

  it("fails matchesOutputSchemaCheck when the JSON is well-formed but doesn't match outputSchema", async () => {
    const provider = new FakeLlmProvider([JSON.stringify({ findings: "not an array" })]);
    const results = await runAgentEvals(fixtureAgent, provider, [{ name: "case 1", input: { subjectId: "s1" } }]);

    expect(results[0].schemaValid).toBe(false);
    const byName = Object.fromEntries(results[0].checks.map((c) => [c.name, c.passed]));
    expect(byName[isValidJsonCheck.name]).toBe(true);
    expect(byName[matchesOutputSchemaCheck.name]).toBe(false);
  });

  it("fails noPlaceholderTextCheck when the response contains unfilled template placeholder text", async () => {
    const provider = new FakeLlmProvider([JSON.stringify({ findings: ["[INSERT FINDING HERE]"], evidence: ["e1"] })]);
    const results = await runAgentEvals(fixtureAgent, provider, [{ name: "case 1", input: { subjectId: "s1" } }]);

    const byName = Object.fromEntries(results[0].checks.map((c) => [c.name, c.passed]));
    expect(byName[noPlaceholderTextCheck.name]).toBe(false);
  });

  it("fails groundedInEvidenceCheck when findings are non-empty but evidence[] is empty", async () => {
    const provider = new FakeLlmProvider([JSON.stringify({ findings: ["A confident claim"], evidence: [] })]);
    const results = await runAgentEvals(fixtureAgent, provider, [{ name: "case 1", input: { subjectId: "s1" } }]);

    const byName = Object.fromEntries(results[0].checks.map((c) => [c.name, c.passed]));
    expect(byName[groundedInEvidenceCheck.name]).toBe(false);
    expect(results[0].allPassed).toBe(false);
  });

  it("passes groundedInEvidenceCheck when both findings and evidence are empty (an honest 'no data' response, not an ungrounded claim)", async () => {
    const provider = new FakeLlmProvider([JSON.stringify({ findings: [], evidence: [] })]);
    const results = await runAgentEvals(fixtureAgent, provider, [{ name: "case 1", input: { subjectId: "s1" } }]);

    const byName = Object.fromEntries(results[0].checks.map((c) => [c.name, c.passed]));
    expect(byName[groundedInEvidenceCheck.name]).toBe(true);
  });

  it("retries are not performed by the eval harness itself — it reports the raw single-call result honestly", async () => {
    const provider = new FakeLlmProvider(["not json at all"]);
    const results = await runAgentEvals(fixtureAgent, provider, [{ name: "case 1", input: { subjectId: "s1" } }]);
    expect(results[0].rawText).toBe("not json at all");
  });
});
