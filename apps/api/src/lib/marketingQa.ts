/**
 * marketingQa: Phase 2 item 6 ("Marketing Intelligence Agent") —
 * "Ask questions in natural language. Explain why leads or conversions
 * changed."
 *
 * This is a REAL but deliberately SIMPLE deterministic intent classifier:
 * an ordered, word-boundary-aware, case-insensitive list of regex
 * patterns, each mapped to a handler that runs a REAL query against real
 * data and returns a REAL answer — exactly the same convention as
 * apps/api/src/lib/classifyReply.ts. This is NOT an LLM call and does NOT
 * perform true NLU: no LLM API key is wired up in this environment. The
 * `answerQuestion` function signature (`question: string` in,
 * `{matchedIntent, answer}` out) is the upgrade seam — a future version
 * can swap the matching strategy for a real LLM call (or a hybrid) without
 * any caller (src/routes/marketingIntelligence.ts) needing to change.
 *
 * An unmatched question NEVER gets a fabricated/generic response: it
 * returns an honest "I can't answer that yet" message that lists the
 * supported question types, derived from the same INTENTS array used to
 * match — so adding a new intent and forgetting to update the fallback
 * text is not possible.
 *
 * Every dependent table that isn't guaranteed to exist yet in every
 * environment is queried via runOptional (pgOptional.ts) — the same
 * SAVEPOINT-catch-42P01 convention used throughout this codebase's recent
 * routes (see apps/api/src/routes/learningLoop.ts) — so a missing table
 * degrades that one answer honestly instead of 500ing.
 */

import { recommendNextActions } from "./nextBestAction.js";
import { getLlmProvider } from "./llmProvider.js";
import { isLlmBudgetExceeded, recordLlmUsage } from "./llmBudget.js";
import { logger } from "./logger.js";

export type MarketingQaHandler = (
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  question: string,
) => Promise<string>;

export interface MarketingQaIntent {
  /** Stable machine-readable identifier, logged to marketing_qa_log. */
  intent: string;
  /** Short human-readable description, used to build the fallback message. */
  summary: string;
  patterns: RegExp[];
  handler: MarketingQaHandler;
}

interface ParsedTimeWindow {
  label: "this week" | "this month" | "all time";
  since: Date | null;
}

/**
 * Small helper: parses an optional "this week" / "this month" time window
 * out of free-text, defaulting to all-time when neither phrase appears.
 * Deliberately narrow — exactly two supported windows, documented, no
 * attempt at general date parsing.
 */
function parseTimeWindow(question: string): ParsedTimeWindow {
  const normalized = question.toLowerCase();
  const now = new Date();
  if (/\bthis\s+week\b/.test(normalized)) {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { label: "this week", since };
  }
  if (/\bthis\s+month\b/.test(normalized)) {
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { label: "this month", since };
  }
  return { label: "all time", since: null };
}

async function handleLeadCount(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  question: string,
): Promise<string> {
  const window = parseTimeWindow(question);
  const result = window.since
    ? await tenantDb.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3`,
        [tenantId, projectId, window.since.toISOString()],
      )
    : await tenantDb.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2`,
        [tenantId, projectId],
      );
  const count = result.rows[0]?.count ?? 0;
  if (window.label === "all time") {
    return `There are ${count} lead(s) in total.`;
  }
  return `There are ${count} lead(s) ${window.label}.`;
}

async function handleWhyLeadsDropped(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<string> {
  const now = new Date();
  const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [thisWeekResult, lastWeekResult] = await Promise.all([
    tenantDb.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3`,
      [tenantId, projectId, thisWeekStart.toISOString()],
    ),
    tenantDb.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2 AND created_at >= $3 AND created_at < $4`,
      [tenantId, projectId, lastWeekStart.toISOString(), thisWeekStart.toISOString()],
    ),
  ]);

  const thisWeek = thisWeekResult.rows[0]?.count ?? 0;
  const lastWeek = lastWeekResult.rows[0]?.count ?? 0;

  if (lastWeek === 0 && thisWeek === 0) {
    return "There isn't enough lead data yet in either week to explain a change — no leads were created in the last 14 days.";
  }
  if (thisWeek < lastWeek) {
    const pctDrop = Math.round((1 - thisWeek / lastWeek) * 100);
    return `Leads dropped from ${lastWeek} last week to ${thisWeek} this week (a ${pctDrop}% decrease).`;
  }
  if (thisWeek > lastWeek) {
    return `Leads didn't drop — up from ${lastWeek} to ${thisWeek} this week.`;
  }
  return `Leads stayed flat at ${thisWeek} this week, same as last week.`;
}

async function handleTopSource(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<string> {
  const result = await tenantDb.query<{ source: string; count: number }>(
    `SELECT source, count(*)::int AS count
     FROM leads
     WHERE tenant_id = $1 AND project_id = $2
     GROUP BY source
     ORDER BY count DESC, source ASC
     LIMIT 1`,
    [tenantId, projectId],
  );
  if (result.rowCount === 0) {
    return "There are no leads yet, so there is no top source to report.";
  }
  const { source, count } = result.rows[0];
  return `The top lead source is "${source}" with ${count} lead(s).`;
}

// Roadmap item 7's lead statuses that count as "converted" for this
// honest ratio — mirrors the qualified-union reasoning documented in
// analytics.ts's /funnel endpoint, but kept simple here (status-only, no
// lead_scores union) since this answer is a quick spoken ratio, not a
// funnel stage.
const CONVERTED_STATUSES = ["qualified", "approved_for_outreach"] as const;

async function handleConversionRate(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<string> {
  const result = await tenantDb.query<{ total: number; converted: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = ANY($3::text[]))::int AS converted
     FROM leads
     WHERE tenant_id = $1 AND project_id = $2`,
    [tenantId, projectId, CONVERTED_STATUSES as unknown as string[]],
  );
  const { total, converted } = result.rows[0] ?? { total: 0, converted: 0 };
  if (total === 0) {
    return "There are no leads yet, so there is no conversion rate to report.";
  }
  const rate = Math.round((converted / total) * 1000) / 10;
  return `${converted} of ${total} lead(s) have converted (status qualified or approved_for_outreach) — a conversion rate of ${rate}%.`;
}

async function handleNextBestAction(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<string> {
  const actions = await recommendNextActions(tenantDb, tenantId, projectId);
  if (actions.length === 0) {
    return "Nothing stands out right now — no recommendation is currently flagged for this project.";
  }
  return actions.join(" ");
}

/**
 * Ordered intent list — first match wins, same priority-matters convention
 * as classifyReply.ts's RULES. Keep this array as the single source of
 * truth: both matching and the fallback "try asking" message are derived
 * from it.
 */
export const INTENTS: MarketingQaIntent[] = [
  {
    intent: "lead_count",
    summary: "how many leads do we have",
    patterns: [/\bhow many leads\b/i, /\blead count\b/i, /\btotal leads\b/i],
    handler: (tenantDb, tenantId, projectId, question) => handleLeadCount(tenantDb, tenantId, projectId, question),
  },
  {
    intent: "why_leads_dropped",
    summary: "why did leads drop",
    patterns: [/\bwhy did leads (drop|decrease|fall)\b/i, /\bleads?\s+(going\s+)?down\b/i, /\bwhy are leads down\b/i],
    handler: (tenantDb, tenantId, projectId) => handleWhyLeadsDropped(tenantDb, tenantId, projectId),
  },
  {
    intent: "top_source",
    summary: "what's our top lead source",
    patterns: [/\btop source\b/i, /\bbest source\b/i, /\bwhich source\b/i],
    handler: (tenantDb, tenantId, projectId) => handleTopSource(tenantDb, tenantId, projectId),
  },
  {
    intent: "conversion_rate",
    summary: "what's our conversion rate",
    patterns: [/\bconversion rate\b/i, /\bhow many( leads)? converted\b/i],
    handler: (tenantDb, tenantId, projectId) => handleConversionRate(tenantDb, tenantId, projectId),
  },
  {
    intent: "next_best_action",
    summary: "what should I do next",
    patterns: [/\bnext best action\b/i, /\bwhat should i do\b/i, /\brecommend\b/i],
    handler: (tenantDb, tenantId, projectId) => handleNextBestAction(tenantDb, tenantId, projectId),
  },
];

function buildFallbackAnswer(): string {
  const list = INTENTS.map((i) => i.summary).join(", ");
  return `I can't answer that yet. Try asking: ${list}.`;
}

export interface AnswerQuestionResult {
  matchedIntent: string | null;
  answer: string;
  /**
   * Milestone 5 (P4): an OPTIONAL, LLM-generated natural-language
   * elaboration of `answer`, never a replacement for it. `null` whenever no
   * LLM is configured (every environment this codebase has actually run in
   * today — see llmProvider.ts), the tenant's monthly LLM token budget is
   * already exceeded (llmBudget.ts), or the LLM call itself fails for any
   * reason — this field degrading to null never changes `answer` or
   * `matchedIntent`, which are always the same deterministic values
   * computed below with no LLM configured at all.
   */
  llmExplanation: string | null;
}

/**
 * Tries each intent in INTENTS, in order, against `question`. First match
 * wins and its handler runs a real query/computation. No match returns the
 * honest fallback (never a fabricated/generic answer).
 *
 * Deterministic-fallback-first: the matchedIntent/answer computed below are
 * IDENTICAL, byte-for-byte, to what this function returned before the LLM
 * enhancement seam was added — the optional `llmExplanation` step below
 * only ever adds information on top, after the deterministic answer is
 * already final, and can never change it.
 */
export async function answerQuestion(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  question: string,
): Promise<AnswerQuestionResult> {
  const normalized = (question ?? "").trim();
  if (normalized.length === 0) {
    return { matchedIntent: null, answer: buildFallbackAnswer(), llmExplanation: null };
  }

  for (const candidate of INTENTS) {
    if (candidate.patterns.some((pattern) => pattern.test(normalized))) {
      const answer = await candidate.handler(tenantDb, tenantId, projectId, normalized);
      const llmExplanation = await tryLlmExplanation(tenantDb, tenantId, projectId, normalized, answer);
      return { matchedIntent: candidate.intent, answer, llmExplanation };
    }
  }

  return { matchedIntent: null, answer: buildFallbackAnswer(), llmExplanation: null };
}

/**
 * Milestone 5 (P4) enhancement seam: when an LLM is configured and this
 * tenant's monthly token budget isn't already exceeded, asks it for a
 * short, friendlier natural-language elaboration of the ALREADY-COMPUTED
 * deterministic `answer` — grounded only in that answer text (the prompt
 * does not ask the LLM to compute or invent any new number). Returns `null`
 * on any failure (not configured, budget exceeded, network/API error) —
 * never throws, so `answerQuestion`'s deterministic result is always
 * returned regardless of what happens here.
 */
async function tryLlmExplanation(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  question: string,
  deterministicAnswer: string,
): Promise<string | null> {
  const provider = getLlmProvider();
  if (!provider.isConfigured) return null;

  try {
    if (await isLlmBudgetExceeded(tenantDb, tenantId)) return null;

    const result = await provider.complete(
      `A user asked this marketing-analytics question: "${question}"\n\n` +
        `The exact, already-computed, factual answer is: "${deterministicAnswer}"\n\n` +
        `In one or two short sentences, restate this answer in a friendlier, more conversational tone. ` +
        `Do not add any new numbers, facts, or claims beyond what is stated above.`,
      { maxTokens: 150, systemPrompt: "You rephrase a given factual answer conversationally. Never invent new facts or numbers." },
    );
    await recordLlmUsage(tenantDb, tenantId, projectId, result, { feature: "marketing_qa_explanation" });
    const text = result.text.trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    logger.warn({ err, tenantId, projectId }, "marketingQa: LLM explanation call failed, falling back to deterministic answer only");
    return null;
  }
}
