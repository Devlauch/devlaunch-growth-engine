import type { PoolClient } from "pg";
import { z } from "zod";
import { getLlmProvider, type LlmProvider } from "../../llmProvider.js";
import { isLlmBudgetExceeded, recordLlmUsage } from "../../llmBudget.js";
import { logger } from "../../logger.js";
import type { AgentTool, AgentToolContext } from "./agentTools.js";
import { recordAgentRun } from "./agentMemory.js";
import { captureProductEvent } from "../../productAnalytics.js";

/**
 * agentRunner.ts: Workstream A1 core — the native, tenant-aware agent
 * execution loop. Architectural ideas (agent = systemPrompt + input/output
 * schema + tools, a thin orchestrator that resolves a model provider and
 * validates structured output) are the same shape mastra's `Agent` class
 * uses, but this is an independent implementation against THIS codebase's
 * own llmProvider.ts/llmBudget.ts, not a port of mastra's code (see this
 * task's handback for the license note — mastra is Apache-2.0, which would
 * in fact permit copying code, but reuse here is "ideas, not code" by
 * design, consistent with this file never importing from
 * ~/project/Growth/mastra).
 *
 * Same honest-stub discipline as aiSalesAssistant.ts's tryLlmText(): never
 * fabricates output when getLlmProvider() reports not configured, never
 * calls the provider past the tenant's monthly budget, and never silently
 * accepts a malformed completion — one retry on invalid JSON/schema
 * mismatch, then an honest `status: "error"` rather than inventing a
 * best-effort shape.
 */

export interface AgentRunContext {
  tenantDb: PoolClient;
  tenantId: string;
  projectId: string | null;
  actorUserId: string | null;
}

export interface AgentDefinition<TInput = unknown, TOutput = unknown> {
  key: string;
  label: string;
  description?: string;
  systemPrompt: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  /**
   * Plain-English description of the required JSON output shape, included
   * directly in the prompt. Deliberately NOT a formal JSON-Schema
   * generator off of outputSchema — same "real but lightweight, never
   * over-engineered for what this milestone needs" convention as
   * llmEvalHarness.ts's checks. outputSchema remains the real,
   * independently-enforced validation boundary regardless of how well this
   * description is worded.
   */
  outputFormatDescription: string;
  tools?: AgentTool[];
  /** Defaults to false (pure research/intelligence agents never need human approval before "running"; see agentApproval.ts). */
  requiresApproval?: boolean;
  maxTokens?: number;
}

export type AgentRunStatus = "ok" | "not_configured" | "budget_exceeded" | "error";

export interface AgentRunResult<TOutput = unknown> {
  status: AgentRunStatus;
  output: TOutput | null;
  evidence?: string[];
  tokensUsed: number;
  error?: string;
}

const DEFAULT_MAX_TOKENS = 800;
const MAX_EVIDENCE_LINE_CHARS = 1500;

function toolResultToEvidenceLine(toolName: string, result: unknown): string {
  const json = JSON.stringify(result);
  const truncated = json.length > MAX_EVIDENCE_LINE_CHARS ? `${json.slice(0, MAX_EVIDENCE_LINE_CHARS)}…` : json;
  return `[tool:${toolName}] ${truncated}`;
}

/**
 * Runs every tool attached to `definition` against the agent's own input
 * (parsed through that tool's own inputSchema — a tool only sees the
 * subset of fields it declares, never the raw full input object). This is
 * "run all grounding tools up front", not a multi-turn tool-choice loop —
 * a deliberate scope limit for this milestone, not an oversight. A single
 * tool failing (e.g. the referenced lead/competitor id doesn't exist) is
 * caught and recorded as its own evidence line — never thrown, since one
 * broken data source must not crash the whole agent run.
 */
async function gatherToolEvidence(tools: AgentTool[], input: unknown, context: AgentRunContext): Promise<string[]> {
  const toolContext: AgentToolContext = {
    tenantDb: context.tenantDb,
    tenantId: context.tenantId,
    projectId: context.projectId,
    actorUserId: context.actorUserId,
  };
  const evidence: string[] = [];
  for (const tool of tools) {
    try {
      const parsedInput = tool.inputSchema.parse(input);
      const result = await tool.execute(parsedInput, toolContext);
      evidence.push(toolResultToEvidenceLine(tool.name, result));
    } catch (err) {
      evidence.push(`[tool:${tool.name}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return evidence;
}

/**
 * Builds the user-turn prompt text. Exported and shared by runAgent() and
 * agentEvalHarness.ts, so an eval exercises the EXACT prompt construction a
 * real run uses rather than a parallel re-implementation of it.
 */
export function buildAgentPrompt(
  definition: Pick<AgentDefinition, "outputFormatDescription">,
  input: unknown,
  evidence: string[],
): string {
  const evidenceBlock = evidence.length > 0 ? evidence.join("\n") : "(no grounding data available)";
  return (
    `Request input (JSON): ${JSON.stringify(input)}\n\n` +
    `Grounding data gathered from this tenant's real, existing records (never invent facts beyond this):\n${evidenceBlock}\n\n` +
    `Respond with ONLY valid JSON (no markdown fencing, no commentary) matching exactly this shape:\n${definition.outputFormatDescription}\n\n` +
    `Every claim must be traceable to the grounding data above. If the grounding data is empty or insufficient, say so plainly in the output (and leave evidence empty) rather than inventing content.`
  );
}

interface CompletionAttempt<TOutput> {
  parsed: TOutput | null;
  inputTokens: number;
  outputTokens: number;
  validationError: string | null;
}

async function completeAndValidate<TOutput>(
  provider: LlmProvider,
  definition: Pick<AgentDefinition<unknown, TOutput>, "systemPrompt" | "maxTokens" | "outputSchema">,
  prompt: string,
): Promise<CompletionAttempt<TOutput>> {
  const completion = await provider.complete(prompt, {
    maxTokens: definition.maxTokens ?? DEFAULT_MAX_TOKENS,
    systemPrompt: definition.systemPrompt,
  });

  let candidate: unknown;
  try {
    candidate = JSON.parse(completion.text);
  } catch {
    return {
      parsed: null,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      validationError: "response was not valid JSON",
    };
  }

  const result = definition.outputSchema.safeParse(candidate);
  if (!result.success) {
    return {
      parsed: null,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      validationError: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
    };
  }

  return { parsed: result.data, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, validationError: null };
}

async function persistRun(
  context: AgentRunContext,
  agentKey: string,
  input: unknown,
  output: unknown,
  status: AgentRunStatus,
  tokensUsed: number,
): Promise<void> {
  try {
    await recordAgentRun(context.tenantDb, {
      tenantId: context.tenantId,
      projectId: context.projectId,
      agentKey,
      input,
      output,
      status,
      tokensUsed,
    });
  } catch (err) {
    // Persistence is best-effort "execution history" — a failure to write
    // it must never hide a real run result from the caller (same
    // never-let-a-side-effect-break-the-main-result convention as
    // leadIntelligence.ts's post-enrichment score recompute).
    logger.error({ err, agentKey, tenantId: context.tenantId }, "agentRunner: failed to persist agent_runs row (non-fatal)");
  }
}

/**
 * Runs one AgentDefinition end-to-end:
 *  1. Validates `input` against definition.inputSchema (throws a real
 *     ZodError on bad input — the route layer's existing global error
 *     handler turns that into a 400, same as every other zod .parse() call
 *     in this codebase).
 *  2. Resolves the real LLM provider; honestly reports `not_configured`
 *     when none is configured — NEVER fabricates output.
 *  3. Enforces this tenant's existing per-tenant monthly LLM token budget
 *     (llmBudget.ts) BEFORE calling the provider.
 *  4. Gathers grounding evidence from definition.tools (see
 *     gatherToolEvidence above).
 *  5. Calls the provider, validates the JSON response against
 *     outputSchema, retrying once on invalid JSON/schema mismatch.
 *  6. Records real token usage via the EXISTING recordLlmUsage() (so this
 *     shows up in the same usage_events-backed budget/overview as every
 *     other LLM-enhanced feature), and persists one agent_runs row
 *     (agentMemory.ts) as execution history — best-effort, never hiding a
 *     real result behind a logging failure.
 */
export async function runAgent<TInput, TOutput>(
  definition: AgentDefinition<TInput, TOutput>,
  input: TInput,
  context: AgentRunContext,
): Promise<AgentRunResult<TOutput>> {
  definition.inputSchema.parse(input);
  const startedAtMs = Date.now();

  const provider = getLlmProvider();
  if (!provider.isConfigured) {
    await persistRun(context, definition.key, input, null, "not_configured", 0);
    return { status: "not_configured", output: null, tokensUsed: 0 };
  }

  try {
    if (await isLlmBudgetExceeded(context.tenantDb, context.tenantId)) {
      await persistRun(context, definition.key, input, null, "budget_exceeded", 0);
      return { status: "budget_exceeded", output: null, tokensUsed: 0 };
    }

    const evidence = await gatherToolEvidence(definition.tools ?? [], input, context);
    const prompt = buildAgentPrompt(definition, input, evidence);

    let attempt = await completeAndValidate(provider, definition, prompt);
    let totalInputTokens = attempt.inputTokens;
    let totalOutputTokens = attempt.outputTokens;

    if (attempt.validationError) {
      logger.warn(
        { agentKey: definition.key, tenantId: context.tenantId, error: attempt.validationError },
        "agentRunner: first completion failed validation, retrying once",
      );
      const retryPrompt = `${prompt}\n\nYour previous response was rejected: ${attempt.validationError}. Respond again with ONLY corrected valid JSON matching the required shape — no markdown, no commentary.`;
      attempt = await completeAndValidate(provider, definition, retryPrompt);
      totalInputTokens += attempt.inputTokens;
      totalOutputTokens += attempt.outputTokens;
    }

    await recordLlmUsage(
      context.tenantDb,
      context.tenantId,
      context.projectId,
      { text: "", inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      { feature: "agent_platform", agentKey: definition.key },
    );
    const tokensUsed = totalInputTokens + totalOutputTokens;

    if (attempt.validationError || attempt.parsed === null) {
      await persistRun(context, definition.key, input, null, "error", tokensUsed);
      // Internal product analytics: a real agent run completing (even an
      // error outcome is a completion worth knowing about for internal
      // product-usage tracking — see productAnalytics.ts's doc comment for
      // why this is never the tenant-facing analytics feature).
      captureProductEvent("agent_run_completed", context.tenantId, {
        agentKey: definition.key,
        projectId: context.projectId,
        status: "error",
        tokensUsed,
        durationMs: Date.now() - startedAtMs,
      });
      return { status: "error", output: null, evidence, tokensUsed, error: attempt.validationError ?? "invalid output" };
    }

    await persistRun(context, definition.key, input, attempt.parsed, "ok", tokensUsed);
    captureProductEvent("agent_run_completed", context.tenantId, {
      agentKey: definition.key,
      projectId: context.projectId,
      status: "ok",
      tokensUsed,
      durationMs: Date.now() - startedAtMs,
    });
    return { status: "ok", output: attempt.parsed, evidence, tokensUsed };
  } catch (err) {
    logger.warn({ err, agentKey: definition.key, tenantId: context.tenantId }, "agentRunner: LLM call failed, reporting error status");
    await persistRun(context, definition.key, input, null, "error", 0);
    captureProductEvent("agent_run_completed", context.tenantId, {
      agentKey: definition.key,
      projectId: context.projectId,
      status: "error",
      tokensUsed: 0,
      durationMs: Date.now() - startedAtMs,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "error", output: null, tokensUsed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
