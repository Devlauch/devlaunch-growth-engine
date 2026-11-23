import type pg from "pg";
import { env } from "../config/env.js";
import { recordUsageEvent } from "./usageEvents.js";
import type { LlmCompleteResult } from "./llmProvider.js";

/**
 * llmBudget.ts: Milestone 5 (P4) token-usage tracking + per-tenant monthly
 * token budget enforcement.
 *
 * Scope decision (documented, not an oversight): this is PER-TENANT, not
 * platform-wide. Every other usage signal in this codebase (usage_events
 * itself, quota.ts's enforceQuota) is scoped by tenant_id, and
 * GET .../usage/overview is a per-tenant view — a platform-wide budget
 * would need a new, parallel aggregation path with no existing UI to show
 * it. Reusing the tenant scope keeps this consistent with the rest of the
 * usage-tracking system and makes it visible through the existing usage
 * overview once llm_tokens_input/llm_tokens_output rows exist.
 *
 * Reuses the EXISTING recordUsageEvent()/usage_events mechanism (see
 * usageEvents.ts) — no parallel ledger. Only ever records a REAL token
 * count a real provider response actually reported
 * (LlmCompleteResult.inputTokens/outputTokens); never an estimate, and
 * never called at all if the LLM call itself never happened.
 *
 * Budget enforcement deliberately does NOT reuse quota.ts's enforceQuota()
 * (which throws Errors.paymentRequired — a hard 402 that would break every
 * caller's existing deterministic-first behavior). An LLM-enhanced code
 * path must always have a deterministic fallback already (that's the
 * entire design of this milestone), so "budget exceeded" here is checked
 * BEFORE attempting the LLM call and, when exceeded, simply skips the LLM
 * call and lets the caller's existing deterministic result stand — never an
 * error surfaced to the end user. quota.ts's pattern (a real COUNT query
 * against a real plan limit) is reused in spirit: getLlmTokenUsageThisMonth
 * below is the same "real SUM query, scoped by tenant_id, compared against
 * a configured limit" shape as quota.ts's countCurrentUsage/getQuotaUsage.
 */

const LLM_EVENT_TYPES = ["llm_tokens_input", "llm_tokens_output"] as const;

export interface LlmTokenUsage {
  /** Real SUM of llm_tokens_input + llm_tokens_output quantities since the start of the current calendar month (UTC). */
  tokensUsedThisMonth: number;
  /** `null` means unlimited (no LLM_MONTHLY_TOKEN_BUDGET_PER_TENANT configured). */
  monthlyBudget: number | null;
}

/** Real SUM query, scoped to tenant_id + the current calendar month (UTC) — never an estimate or cached counter. */
export async function getLlmTokenUsageThisMonth(client: pg.PoolClient, tenantId: string): Promise<LlmTokenUsage> {
  const result = await client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(quantity), 0)::numeric AS total
     FROM usage_events
     WHERE tenant_id = $1
       AND event_type = ANY($2::text[])
       AND created_at >= date_trunc('month', now())`,
    [tenantId, LLM_EVENT_TYPES],
  );
  return {
    tokensUsedThisMonth: Number(result.rows[0]?.total ?? 0),
    monthlyBudget: env.llmMonthlyTokenBudgetPerTenant,
  };
}

/**
 * True when this tenant has already used up its configured monthly LLM
 * token budget. ALWAYS false when no budget is configured
 * (env.llmMonthlyTokenBudgetPerTenant === null, the default in every
 * environment this codebase has actually run in) — unlimited by default,
 * same as every `limit: number | null` resource in quota.ts.
 *
 * Call this BEFORE attempting an LLM call on any enhanced code path; when
 * it returns true, skip the call entirely and use the existing
 * deterministic result — never throw/502, exactly like a provider that
 * simply isn't configured.
 */
export async function isLlmBudgetExceeded(client: pg.PoolClient, tenantId: string): Promise<boolean> {
  const { tokensUsedThisMonth, monthlyBudget } = await getLlmTokenUsageThisMonth(client, tenantId);
  if (monthlyBudget === null) return false;
  return tokensUsedThisMonth >= monthlyBudget;
}

// ---------------------------------------------------------------------------
// Cost estimate (clearly labeled, never invented)
// ---------------------------------------------------------------------------

/**
 * Published Anthropic Claude Sonnet-family per-token pricing, as of this
 * model's own training/knowledge cutoff (noted explicitly below) — NOT
 * fetched from a live pricing API (none exists) and NOT verified against
 * Anthropic's current pricing page from inside this environment (no
 * network access to confirm it hasn't changed since). Treat
 * estimatedCostUsd as a rough, clearly-labeled approximation only; it is
 * never written anywhere as if it were a real invoice line.
 */
export const PUBLISHED_PRICE_PER_MILLION_INPUT_TOKENS_USD = 3.0;
export const PUBLISHED_PRICE_PER_MILLION_OUTPUT_TOKENS_USD = 15.0;
export const PUBLISHED_PRICING_NOTE =
  "estimated based on published Anthropic Claude Sonnet-family pricing as of the assistant's Jan 2026 knowledge cutoff — not fetched live, not an actual invoice amount, and not re-verified against Anthropic's current pricing page from inside this environment";

export interface LlmCostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  note: string;
}

/** Computes a cost estimate FROM real token counts only — never an invented flat number. */
export function estimateLlmCostUsd(inputTokens: number, outputTokens: number): LlmCostEstimate {
  const estimatedCostUsd =
    (inputTokens / 1_000_000) * PUBLISHED_PRICE_PER_MILLION_INPUT_TOKENS_USD +
    (outputTokens / 1_000_000) * PUBLISHED_PRICE_PER_MILLION_OUTPUT_TOKENS_USD;
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
    note: PUBLISHED_PRICING_NOTE,
  };
}

/**
 * Single write path for llm_tokens_input/llm_tokens_output usage_events —
 * every real LLM completion call that actually succeeds goes through this
 * one function, same "one function, every caller goes through it"
 * convention as usageEvents.ts's own recordUsageEvent(). `client` must
 * already be inside the caller's tenant-scoped transaction, exactly like
 * recordUsageEvent's own contract.
 */
export async function recordLlmUsage(
  client: pg.PoolClient,
  tenantId: string,
  projectId: string | null,
  result: LlmCompleteResult,
  metadata: Record<string, unknown> = {},
): Promise<LlmCostEstimate> {
  const cost = estimateLlmCostUsd(result.inputTokens, result.outputTokens);
  await recordUsageEvent({
    client,
    tenantId,
    projectId,
    eventType: "llm_tokens_input",
    quantity: result.inputTokens,
    metadata: { ...metadata, estimatedCostUsd: cost.estimatedCostUsd, pricingNote: cost.note },
  });
  await recordUsageEvent({
    client,
    tenantId,
    projectId,
    eventType: "llm_tokens_output",
    quantity: result.outputTokens,
    metadata: { ...metadata, estimatedCostUsd: cost.estimatedCostUsd, pricingNote: cost.note },
  });
  return cost;
}
