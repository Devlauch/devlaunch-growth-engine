import type { LlmProvider } from "../../llmProvider.js";
import { buildAgentPrompt, type AgentDefinition } from "./agentRunner.js";

/**
 * agentEvalHarness.ts: Workstream A1, extending llmEvalHarness.ts's pattern
 * (fixed fixture inputs run through a provider, structural checks applied
 * to the real response) to a full AgentDefinition rather than a bare
 * prompt/checks pair. Same HONESTY NOTE as llmEvalHarness.ts: no real LLM
 * API key exists in this environment, so this harness has never been run
 * against a real completion — what IS real and exercised for real in
 * apps/api/test/agentEvalHarness.test.ts is the harness logic itself
 * (prompt construction via the SAME buildAgentPrompt() runAgent() uses,
 * JSON-parseability, outputSchema structural validation, placeholder-text
 * detection, and the evidence-grounding check below) against a fake,
 * injectable LlmProvider that returns canned text.
 */

export interface AgentEvalCase<TInput = unknown> {
  name: string;
  input: TInput;
  /** Fixture grounding data this case pretends a real tool run already gathered — omit/empty to exercise the "no real grounding data available" path. */
  toolEvidence?: string[];
}

export interface AgentEvalCheck {
  name: string;
  /** Receives the raw completion text AND the parsed/validated output (null when parsing or schema validation failed). */
  run: (rawText: string, parsedOutput: unknown) => boolean;
}

export interface AgentEvalCheckResult {
  name: string;
  passed: boolean;
}

export interface AgentEvalCaseResult {
  name: string;
  rawText: string;
  parsedOutput: unknown;
  schemaValid: boolean;
  checks: AgentEvalCheckResult[];
  allPassed: boolean;
}

// ---------------------------------------------------------------------------
// Reusable checks
// ---------------------------------------------------------------------------

/** Passes when the raw completion text parses as JSON (any shape) — independent of whether it also matches the agent's outputSchema. */
export const isValidJsonCheck: AgentEvalCheck = {
  name: "parses as valid JSON",
  run: (rawText) => {
    try {
      JSON.parse(rawText);
      return true;
    } catch {
      return false;
    }
  },
};

/** Passes when the parsed output actually validated against the agent's outputSchema (parsedOutput is non-null only when it did — see runAgentEvals below). */
export const matchesOutputSchemaCheck: AgentEvalCheck = {
  name: "matches the agent's outputSchema",
  run: (_rawText, parsedOutput) => parsedOutput !== null,
};

const PLACEHOLDER_PATTERNS = [/\[insert[^\]]*\]/i, /\[your[^\]]*\]/i, /\[placeholder[^\]]*\]/i, /\{\{[^}]*\}\}/, /<[A-Z_]+>/, /\bTODO\b/, /\bFIXME\b/, /\bLOREM IPSUM\b/i];

/** Passes when the raw completion text contains no obvious unfilled-template placeholder text (same patterns as llmEvalHarness.ts's own check). */
export const noPlaceholderTextCheck: AgentEvalCheck = {
  name: "contains no placeholder text (e.g. [INSERT], {{var}}, TODO)",
  run: (rawText) => !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(rawText)),
};

/**
 * Grounded-in-evidence check: every one of this milestone's four agent
 * outputSchemas includes an `evidence: string[]` field (see
 * agents/*.ts). This check fails only when that field is EMPTY while some
 * OTHER field in the output (a non-empty array or a non-blank string) still
 * carries real content — i.e. the agent made claims without citing any
 * evidence for them. Agents whose output has no `evidence` key at all are
 * not this check's concern (it passes trivially) — this is a convention
 * check for grounded-research agents, not a universal schema requirement.
 */
export const groundedInEvidenceCheck: AgentEvalCheck = {
  name: "claims are grounded in evidence (non-empty evidence[] whenever other findings are non-empty)",
  run: (_rawText, parsedOutput) => {
    if (!parsedOutput || typeof parsedOutput !== "object") return true;
    const obj = parsedOutput as Record<string, unknown>;
    if (!("evidence" in obj) || !Array.isArray(obj.evidence)) return true;
    if (obj.evidence.length > 0) return true;
    const hasOtherClaims = Object.entries(obj).some(([key, value]) => {
      if (key === "evidence") return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "string") return value.trim().length > 0;
      return false;
    });
    return !hasOtherClaims;
  },
};

const DEFAULT_CHECKS: AgentEvalCheck[] = [isValidJsonCheck, matchesOutputSchemaCheck, noPlaceholderTextCheck, groundedInEvidenceCheck];

/**
 * Runs every fixture case in `cases` through `definition` using the given
 * (real or fake/injectable) provider — the SAME buildAgentPrompt() runAgent
 * itself uses, so this is a genuine exercise of this agent's actual prompt
 * construction, not a parallel re-implementation of it. Does NOT touch the
 * database, budget enforcement, or agent_runs persistence — this is a pure
 * prompt-in/response-out structural eval, same scope as llmEvalHarness.ts's
 * runLlmEvals().
 */
export async function runAgentEvals<TInput, TOutput>(
  definition: AgentDefinition<TInput, TOutput>,
  provider: LlmProvider,
  cases: AgentEvalCase<TInput>[],
  extraChecks: AgentEvalCheck[] = [],
): Promise<AgentEvalCaseResult[]> {
  const checks = [...DEFAULT_CHECKS, ...extraChecks];
  const results: AgentEvalCaseResult[] = [];

  for (const evalCase of cases) {
    const prompt = buildAgentPrompt(definition, evalCase.input, evalCase.toolEvidence ?? []);
    const completion = await provider.complete(prompt, {
      maxTokens: definition.maxTokens,
      systemPrompt: definition.systemPrompt,
    });

    let parsedOutput: unknown = null;
    let schemaValid = false;
    try {
      const candidate = JSON.parse(completion.text);
      const parseResult = definition.outputSchema.safeParse(candidate);
      if (parseResult.success) {
        parsedOutput = parseResult.data;
        schemaValid = true;
      }
    } catch {
      // leaves parsedOutput null / schemaValid false — isValidJsonCheck and
      // matchesOutputSchemaCheck below report this honestly rather than throwing.
    }

    const checkResults = checks.map((check) => ({ name: check.name, passed: check.run(completion.text, parsedOutput) }));
    results.push({
      name: evalCase.name,
      rawText: completion.text,
      parsedOutput,
      schemaValid,
      checks: checkResults,
      allPassed: checkResults.every((c) => c.passed),
    });
  }

  return results;
}
