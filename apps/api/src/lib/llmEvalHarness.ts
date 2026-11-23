import type { LlmProvider } from "./llmProvider.js";

/**
 * llmEvalHarness.ts: Milestone 5 (P4) section 5, a minimal REAL eval
 * harness for LLM-generated text.
 *
 * HONESTY NOTE: no real LLM API key exists in this environment (same
 * statement as llmProvider.ts), so this harness has never been run against
 * a real completion. What IS real here: the harness logic itself (running
 * a list of fixed prompts through a provider and checking the response
 * shape) and its checks (JSON-parseability, a rough token/length ceiling,
 * absence of obvious unfilled-template placeholder text) are exercised for
 * real in test/llmEvals.test.ts, against a fake/injectable LlmProvider that
 * returns canned responses — that is a genuine test of the harness and its
 * parsing/checking logic, NOT a skipped test and NOT a real LLM
 * validation. test/llmRealApi.skip.test.ts documents, separately and
 * explicitly, what running this harness against a real provider would mean.
 */

export interface LlmEvalCheck {
  /** Short, human-readable name of what this check verifies. */
  name: string;
  /** Returns true when `text` passes this check. */
  run: (text: string) => boolean;
}

export interface LlmEvalCase {
  name: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  checks: LlmEvalCheck[];
}

export interface LlmEvalCheckResult {
  name: string;
  passed: boolean;
}

export interface LlmEvalCaseResult {
  name: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  checks: LlmEvalCheckResult[];
  allPassed: boolean;
}

/** Runs every case in `cases` through `provider`, applying each case's own checks to the real returned text. */
export async function runLlmEvals(provider: LlmProvider, cases: LlmEvalCase[]): Promise<LlmEvalCaseResult[]> {
  const results: LlmEvalCaseResult[] = [];
  for (const evalCase of cases) {
    const completion = await provider.complete(evalCase.prompt, {
      maxTokens: evalCase.maxTokens,
      systemPrompt: evalCase.systemPrompt,
    });
    const checks = evalCase.checks.map((check) => ({ name: check.name, passed: check.run(completion.text) }));
    results.push({
      name: evalCase.name,
      text: completion.text,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      checks,
      allPassed: checks.every((c) => c.passed),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reusable checks
// ---------------------------------------------------------------------------

/** Passes when `text` parses as valid JSON (any shape). */
export const isValidJsonCheck: LlmEvalCheck = {
  name: "parses as valid JSON",
  run: (text) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Passes when `text` is under a rough token-count ceiling, approximated as
 * `text.length / 4` (a commonly-used, documented rough English-text
 * heuristic — this is NOT a real tokenizer; it is a cheap, honestly
 * approximate ceiling check, not a precise count. A real precise count
 * comes from the provider's own `usage.output_tokens`, never estimated
 * from text length in llmBudget.ts itself).
 */
export function underApproxTokenLimitCheck(maxTokens: number): LlmEvalCheck {
  return {
    name: `under ~${maxTokens} tokens (approximated as text.length / 4)`,
    run: (text) => text.length / 4 <= maxTokens,
  };
}

const PLACEHOLDER_PATTERNS = [/\[insert[^\]]*\]/i, /\[your[^\]]*\]/i, /\[placeholder[^\]]*\]/i, /\{\{[^}]*\}\}/, /<[A-Z_]+>/, /\bTODO\b/, /\bFIXME\b/, /\bLOREM IPSUM\b/i];

/** Passes when `text` contains no obvious unfilled-template placeholder text. */
export const noPlaceholderTextCheck: LlmEvalCheck = {
  name: "contains no placeholder text (e.g. [INSERT], {{var}}, TODO)",
  run: (text) => !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text)),
};

/** Passes when `text` is non-empty after trimming. */
export const nonEmptyCheck: LlmEvalCheck = {
  name: "non-empty response",
  run: (text) => text.trim().length > 0,
};
