import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";
import type { DealStage } from "./salesPipeline.js";
import { computeDealHealth, type DealHealthSignals } from "./dealHealth.js";
import type { ReplyClassification } from "./classifyReply.js";
import { getLeadActivityTimeline, type ActivityItem } from "./activityTimeline.js";
import { classifyObjection, type ClassifyObjectionResult } from "./classifyObjection.js";
import { getLlmProvider } from "./llmProvider.js";
import { isLlmBudgetExceeded, recordLlmUsage } from "./llmBudget.js";
import { logger } from "./logger.js";

/**
 * aiSalesAssistant.ts: Milestone 5 (P4) section 4, "AI sales assistant" —
 * a NEW capability (not a retrofit of any existing feature/file), offering
 * "draft a response to this objection" and "summarize this deal's status
 * for a handoff".
 *
 * Grounding, never fabrication: every fact fed to the LLM prompt (or used
 * to build the deterministic fallback text when no LLM is configured) comes
 * from REAL data already assembled by existing, reused libraries:
 *   - apps/api/src/lib/activityTimeline.ts's getLeadActivityTimeline
 *     (reused directly, not reimplemented) for the lead's real event
 *     history.
 *   - apps/api/src/lib/dealHealth.ts's computeDealHealth (reused directly)
 *     for the deal's real 0-100 health score + "why" breakdown. The signal
 *     assembly queries below mirror apps/api/src/routes/dealHealth.ts's own
 *     (that file is never edited — see this task's constraints — so the
 *     handful of read-only queries needed to build DealHealthSignals are
 *     duplicated here rather than extracted, a deliberate, narrow
 *     exception noted in this milestone's handback).
 *   - apps/api/src/lib/classifyObjection.ts's classifyObjection (reused
 *     directly) for a deterministic objection theme.
 *
 * Deterministic-fallback-first: BOTH capabilities below always return a
 * complete, real, non-LLM result built purely from the above (the
 * `deterministic` field is NEVER null/absent). The LLM-generated text
 * (`llm` field) is strictly additive: `status: "not_configured"` when no
 * ANTHROPIC_API_KEY is set (every environment this codebase has actually
 * run in today), `status: "budget_exceeded"` when this tenant's monthly LLM
 * token budget is already used up, `status: "error"` if the LLM call itself
 * fails for any reason (caught, logged, never thrown), and `status: "ok"`
 * with real generated text otherwise.
 */

const MIN_DEALS_FOR_TYPICAL_VALUE = 3;

export type LlmTextStatus = "ok" | "not_configured" | "budget_exceeded" | "error";

export interface LlmTextResult {
  status: LlmTextStatus;
  text: string | null;
}

interface DealRow {
  id: string;
  lead_id: string;
  stage: DealStage;
  stage_changed_at: string;
  created_at: string;
  value_amount: string | null;
}

async function loadDealOr404(tenantDb: PoolClient, tenantId: string, projectId: string, dealId: string): Promise<DealRow> {
  const result = await tenantDb.query<DealRow>(
    `SELECT id, lead_id, stage, stage_changed_at, created_at, value_amount
     FROM deals WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [dealId, tenantId, projectId],
  );
  if (result.rowCount === 0) throw Errors.notFound("Deal not found");
  return result.rows[0];
}

/**
 * Assembles DealHealthSignals for one deal — same read-only query shapes as
 * apps/api/src/routes/dealHealth.ts's GET /:dealId/health handler (see this
 * file's header comment for why these are duplicated here rather than
 * imported from that route file).
 */
async function loadDealHealthSignals(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  deal: DealRow,
): Promise<DealHealthSignals> {
  const [meetingResult, replyResult, meetingActivityResult, replyActivityResult, noteActivityResult, taskActivityResult, typicalValueResult] =
    await Promise.all([
      tenantDb.query<{ status: string; next_step: string | null; scheduled_at: string }>(
        `SELECT status, next_step, scheduled_at FROM meetings
         WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3 AND (deal_id = $4 OR deal_id IS NULL)
         ORDER BY (deal_id = $4) DESC, scheduled_at DESC LIMIT 1`,
        [tenantId, projectId, deal.lead_id, deal.id],
      ),
      tenantDb.query<{ classification: string; received_at: string }>(
        `SELECT classification, received_at FROM lead_replies
         WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3 ORDER BY received_at DESC LIMIT 1`,
        [tenantId, projectId, deal.lead_id],
      ),
      tenantDb.query<{ max: string | null }>(
        `SELECT MAX(scheduled_at) FROM meetings WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [tenantId, projectId, deal.lead_id],
      ),
      tenantDb.query<{ max: string | null }>(
        `SELECT MAX(received_at) FROM lead_replies WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [tenantId, projectId, deal.lead_id],
      ),
      tenantDb.query<{ max: string | null }>(
        `SELECT MAX(created_at) FROM notes WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [tenantId, projectId, deal.lead_id],
      ),
      tenantDb.query<{ max: string | null }>(
        `SELECT MAX(updated_at) FROM crm_tasks WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
        [tenantId, projectId, deal.lead_id],
      ),
      tenantDb.query<{ avg_value: string | null; cnt: string }>(
        `SELECT AVG(value_amount) AS avg_value, COUNT(*) AS cnt FROM deals
         WHERE tenant_id = $1 AND project_id = $2 AND value_amount IS NOT NULL AND id != $3`,
        [tenantId, projectId, deal.id],
      ),
    ]);

  const activityTimestamps = [meetingActivityResult, replyActivityResult, noteActivityResult, taskActivityResult]
    .map((r) => r.rows[0]?.max)
    .filter((v): v is string => Boolean(v));
  const lastActivityAt =
    activityTimestamps.length > 0
      ? activityTimestamps.reduce((latest, t) => (new Date(t) > new Date(latest) ? t : latest))
      : null;

  const typicalCount = Number(typicalValueResult.rows[0]?.cnt ?? 0);
  const typicalAvg = typicalValueResult.rows[0]?.avg_value ?? null;
  const typicalDealValue = typicalCount >= MIN_DEALS_FOR_TYPICAL_VALUE && typicalAvg !== null ? Number(typicalAvg) : null;

  return {
    latestMeeting: meetingResult.rows[0] ?? null,
    latestReply: replyResult.rows[0]
      ? { classification: replyResult.rows[0].classification as ReplyClassification, received_at: replyResult.rows[0].received_at }
      : null,
    lastActivityAt,
    typicalDealValue,
  };
}

async function tryLlmText(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  prompt: string,
  systemPrompt: string,
  metadata: Record<string, unknown>,
): Promise<LlmTextResult> {
  const provider = getLlmProvider();
  if (!provider.isConfigured) return { status: "not_configured", text: null };

  try {
    if (await isLlmBudgetExceeded(tenantDb, tenantId)) {
      return { status: "budget_exceeded", text: null };
    }
    const result = await provider.complete(prompt, { maxTokens: 400, systemPrompt });
    await recordLlmUsage(tenantDb, tenantId, projectId, result, metadata);
    const text = result.text.trim();
    return { status: "ok", text: text.length > 0 ? text : null };
  } catch (err) {
    logger.warn({ err, tenantId, projectId, metadata }, "aiSalesAssistant: LLM call failed, falling back to deterministic result only");
    return { status: "error", text: null };
  }
}

// ---------------------------------------------------------------------------
// Capability 1: summarize a deal's status for a handoff
// ---------------------------------------------------------------------------

export interface DealHandoffSummary {
  dealId: string;
  deterministic: {
    stage: DealStage;
    score: number;
    why: string[];
    recentActivity: ActivityItem[];
  };
  llm: LlmTextResult;
}

export async function summarizeDealForHandoff(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  dealId: string,
): Promise<DealHandoffSummary> {
  const deal = await loadDealOr404(tenantDb, tenantId, projectId, dealId);
  const [signals, activity] = await Promise.all([
    loadDealHealthSignals(tenantDb, tenantId, projectId, deal),
    getLeadActivityTimeline(tenantDb, tenantId, projectId, deal.lead_id),
  ]);

  const health = computeDealHealth(
    { stage: deal.stage, stage_changed_at: deal.stage_changed_at, created_at: deal.created_at, value_amount: deal.value_amount },
    signals,
  );
  const recentActivity = activity.slice(0, 10);

  const prompt =
    `Write a concise handoff summary (3-5 sentences) for a sales rep taking over this deal.\n\n` +
    `Deal stage: ${deal.stage}\n` +
    `Health score (0-100): ${health.score}\n` +
    `Health factors: ${health.why.join("; ") || "none recorded"}\n` +
    `Recent activity (newest first):\n` +
    recentActivity.map((a) => `- [${a.type}] ${a.summary}`).join("\n") +
    `\n\nOnly use the facts above. Do not invent names, numbers, or events not listed.`;

  const llm = await tryLlmText(
    tenantDb,
    tenantId,
    projectId,
    prompt,
    "You write short, factual sales handoff summaries strictly grounded in the data given. Never invent facts.",
    { feature: "ai_sales_assistant_handoff_summary", dealId },
  );

  return {
    dealId,
    deterministic: { stage: deal.stage, score: health.score, why: health.why, recentActivity },
    llm,
  };
}

// ---------------------------------------------------------------------------
// Capability 2: draft a response to a sales objection
// ---------------------------------------------------------------------------

export interface ObjectionResponseDraft {
  dealId: string;
  deterministic: {
    classification: ClassifyObjectionResult;
    /** A simple, real (non-LLM) templated starting point per theme — never fabricated claims, always generic/safe phrasing. */
    templateResponse: string;
  };
  llm: LlmTextResult;
}

const TEMPLATE_RESPONSES: Record<ClassifyObjectionResult["theme"], string> = {
  price: "Thanks for being upfront about budget. Would it help to walk through the ROI case and see which plan tier best fits where you are today?",
  timing: "Understood — totally fine if now isn't the right moment. Would it be useful to check back in at a specific point, or would you like a few resources to review in the meantime?",
  competitor: "Appreciate you sharing that you're evaluating other options. Happy to put together a direct comparison on the specific points that matter most to your team.",
  no_budget: "That makes sense. Would it help to look at a lower-tier plan or a phased rollout that fits within what's currently approved?",
  no_authority: "Thanks for letting us know. Would it help if we prepared a short summary you could share with the decision-maker, or would a joint call work better?",
  not_interested: "Thanks for the honest feedback. Would you be open to sharing what specifically isn't a fit, so we can make sure we're not missing something relevant?",
  none: "Thanks for sharing your thoughts — could you tell us a bit more about your main concern so we can address it directly?",
};

export async function draftObjectionResponse(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  dealId: string,
  objectionText: string,
): Promise<ObjectionResponseDraft> {
  await loadDealOr404(tenantDb, tenantId, projectId, dealId);
  const classification = classifyObjection(objectionText);
  const templateResponse = TEMPLATE_RESPONSES[classification.theme];

  const prompt =
    `A prospect raised this objection: "${objectionText}"\n\n` +
    `It has been deterministically classified as theme "${classification.theme}" (confidence: ${classification.confidence}).\n` +
    `A safe, generic starting-point response is: "${templateResponse}"\n\n` +
    `Write a short (2-4 sentence), warm, specific-sounding reply a sales rep could send, building on the starting point above. ` +
    `Do not invent pricing, dates, product names, or commitments not implied by the objection text itself.`;

  const llm = await tryLlmText(
    tenantDb,
    tenantId,
    projectId,
    prompt,
    "You draft short, professional sales objection-handling replies. Never invent concrete facts (prices, dates, guarantees) not given to you.",
    { feature: "ai_sales_assistant_objection_draft", dealId, objectionTheme: classification.theme },
  );

  return { dealId, deterministic: { classification, templateResponse }, llm };
}
