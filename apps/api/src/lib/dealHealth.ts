import type { PoolClient } from "pg";
import { STAGE_STALL_THRESHOLD_DAYS, type DealStage } from "./salesPipeline.js";
import { STAGE_FORECAST_WEIGHTS } from "./pipelineForecast.js";
import type { ReplyClassification } from "./classifyReply.js";

/**
 * dealHealth.ts: deterministic 0-100 deal health score + a human-readable
 * "why" breakdown, in the same deterministic-math-plus-honest-explanation
 * style as apps/api/src/lib/scoreLead.ts. NOT an LLM call — no LLM
 * credentials exist anywhere in this codebase (same statement as
 * classifyReply.ts/scoreLead.ts).
 *
 * Deliberately a PURE, on-demand computation with NO persistence table.
 * This is a considered choice, not an oversight:
 *   - Every signal below is a cheap, already-indexed read (one deals row
 *     by id, plus a handful of MAX()/LIMIT 1 queries scoped by
 *     tenant_id/project_id/lead_id — the same query shapes
 *     activityTimeline.ts already does per-lead). There is no expensive
 *     computation worth caching.
 *   - This codebase has NO cron/scheduler infrastructure (documented
 *     repeatedly: salesPipeline.ts's checkStalledDeals header comment,
 *     advanceSequences.ts) — a persisted score would go stale the moment
 *     a meeting outcome or reply classification changes, with nothing to
 *     ever recompute it, silently lying to a user who trusts a stored
 *     number. Computing fresh on every GET means the score is ALWAYS
 *     accurate as of the request, matching growthRevenueAnalytics.ts's
 *     "every number is a real query, computed fresh" convention rather
 *     than lead_scores' "recompute on demand, persist until next
 *     recompute" model (which only works there because recompute is an
 *     explicit user action against a configurable rubric, not an
 *     always-should-be-current health signal).
 *
 * computeDealHealth() itself takes plain data (no PoolClient) so it is a
 * pure, directly-unit-testable function — the DB reads live in
 * apps/api/src/routes/dealHealth.ts.
 */

export interface DealHealthDealInput {
  stage: DealStage;
  stage_changed_at: string;
  created_at: string;
  value_amount: string | number | null;
}

export interface DealHealthMeetingSignal {
  status: string;
  next_step: string | null;
  scheduled_at: string;
}

export interface DealHealthReplySignal {
  classification: ReplyClassification;
  received_at: string;
}

export interface DealHealthSignals {
  /** Most recent meeting tied to this deal (or, failing that, this lead) — null if none exists. Never fabricated. */
  latestMeeting: DealHealthMeetingSignal | null;
  /** Most recent classified reply from this lead — null if none exists yet. */
  latestReply: DealHealthReplySignal | null;
  /** Most recent of: meeting scheduled_at, reply received_at, note created_at, crm_task updated_at for this lead — null if none recorded. */
  lastActivityAt: string | null;
  /** Average value_amount across OTHER deals with a value set in this project — null if too few (fewer than MIN_DEALS_FOR_TYPICAL_VALUE) to be meaningful. */
  typicalDealValue: number | null;
}

export interface DealHealthResult {
  score: number;
  why: string[];
}

/** Same threshold concept salesPipeline.ts uses to decide a deal is "stalled". */
const STALL_PENALTY = 20;
const ON_TRACK_BONUS = 10;
const MEETING_NO_SHOW_PENALTY = 15;
const MEETING_COMPLETED_WITH_NEXT_STEP_BONUS = 15;
const MEETING_COMPLETED_NO_NEXT_STEP_BONUS = 5;
const MEETING_SCHEDULED_BONUS = 10;
const REPLY_INTERESTED_BONUS = 15;
const REPLY_NOT_NOW_PENALTY = 5;
const REPLY_WRONG_PERSON_PENALTY = 20;
const REPLY_UNSUBSCRIBE_PENALTY = 30;
const NO_RECENT_ACTIVITY_PENALTY = 10;
const RECENT_ACTIVITY_BONUS = 5;
const VALUE_WELL_ABOVE_TYPICAL_BONUS = 5;
const VALUE_WELL_BELOW_TYPICAL_PENALTY = 5;
const STAGE_PROGRESS_MAX_POINTS = 40;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
}

/**
 * Deterministic deal health scoring. Every point swing is justified in the
 * returned `why` array; a missing signal is NEVER fabricated — it is
 * omitted from the score and explicitly called out as absent instead
 * (e.g. "No meeting scheduled yet for this deal").
 */
export function computeDealHealth(
  deal: DealHealthDealInput,
  signals: DealHealthSignals,
  now: Date = new Date(),
): DealHealthResult {
  if (deal.stage === "won") {
    return {
      score: 100,
      why: ["Deal has already reached 'won' — health scoring is not meaningful for a closed, successful deal."],
    };
  }
  if (deal.stage === "lost") {
    return {
      score: 0,
      why: ["Deal has already reached 'lost' — health scoring is not meaningful for a closed, unsuccessful deal."],
    };
  }

  const why: string[] = [];
  let score = 0;

  // --- Stage progress -------------------------------------------------
  // Reuses the same stage-weight estimates as the pipeline forecast
  // (pipelineForecast.ts's STAGE_FORECAST_WEIGHTS) rather than a second,
  // divergent set of "how far along is this deal" numbers.
  const stageWeight = STAGE_FORECAST_WEIGHTS[deal.stage as keyof typeof STAGE_FORECAST_WEIGHTS] ?? 0;
  const stagePoints = Math.round(stageWeight * STAGE_PROGRESS_MAX_POINTS);
  score += stagePoints;
  why.push(
    `Deal is in stage '${deal.stage}' (estimated ${Math.round(stageWeight * 100)}% probability-to-close), contributing ${stagePoints}/${STAGE_PROGRESS_MAX_POINTS} points.`,
  );

  // --- Stall signal -----------------------------------------------------
  const daysInStage = Math.round(daysSince(deal.stage_changed_at, now));
  if (daysInStage >= STAGE_STALL_THRESHOLD_DAYS) {
    score -= STALL_PENALTY;
    why.push(
      `Deal has sat in stage '${deal.stage}' for ${daysInStage} day(s), over the ${STAGE_STALL_THRESHOLD_DAYS}-day stall threshold (-${STALL_PENALTY} points).`,
    );
  } else {
    score += ON_TRACK_BONUS;
    why.push(
      `Deal has been in stage '${deal.stage}' for ${daysInStage} day(s), within the ${STAGE_STALL_THRESHOLD_DAYS}-day stall threshold (+${ON_TRACK_BONUS} points).`,
    );
  }

  // --- Meeting signal -----------------------------------------------------
  if (signals.latestMeeting) {
    const m = signals.latestMeeting;
    if (m.status === "no_show") {
      score -= MEETING_NO_SHOW_PENALTY;
      why.push(`Most recent meeting was a no-show (-${MEETING_NO_SHOW_PENALTY} points).`);
    } else if (m.status === "completed" && m.next_step) {
      score += MEETING_COMPLETED_WITH_NEXT_STEP_BONUS;
      why.push(`Most recent meeting completed with a recorded next step (+${MEETING_COMPLETED_WITH_NEXT_STEP_BONUS} points).`);
    } else if (m.status === "completed") {
      score += MEETING_COMPLETED_NO_NEXT_STEP_BONUS;
      why.push(
        `Most recent meeting completed, but no next step was recorded (+${MEETING_COMPLETED_NO_NEXT_STEP_BONUS} points).`,
      );
    } else if (m.status === "scheduled") {
      score += MEETING_SCHEDULED_BONUS;
      why.push(`A meeting is scheduled (+${MEETING_SCHEDULED_BONUS} points).`);
    } else {
      why.push(`Most recent meeting status is '${m.status}' — no score contribution either way.`);
    }
  } else {
    why.push("No meeting scheduled yet for this deal — no score contribution either way (never fabricated).");
  }

  // --- Reply classification signal ---------------------------------------
  if (signals.latestReply) {
    const c = signals.latestReply.classification;
    if (c === "interested") {
      score += REPLY_INTERESTED_BONUS;
      why.push(`Most recent reply was classified 'interested' (+${REPLY_INTERESTED_BONUS} points).`);
    } else if (c === "not_now") {
      score -= REPLY_NOT_NOW_PENALTY;
      why.push(`Most recent reply was classified 'not_now' (-${REPLY_NOT_NOW_PENALTY} points).`);
    } else if (c === "wrong_person") {
      score -= REPLY_WRONG_PERSON_PENALTY;
      why.push(`Most recent reply was classified 'wrong_person' (-${REPLY_WRONG_PERSON_PENALTY} points).`);
    } else if (c === "unsubscribe") {
      score -= REPLY_UNSUBSCRIBE_PENALTY;
      why.push(`Most recent reply was classified 'unsubscribe' — a strong negative signal (-${REPLY_UNSUBSCRIBE_PENALTY} points).`);
    } else {
      why.push("Most recent reply was 'unclassified' — no score contribution either way.");
    }
  } else {
    why.push("No reply has been received and classified for this lead yet — no score contribution either way.");
  }

  // --- Activity recency ---------------------------------------------------
  // Distinct from the stage-stall signal above: considers ANY recorded
  // activity (meeting, reply, note, task), not just this deal's own
  // stage_changed_at, same aggregation scope as activityTimeline.ts.
  if (signals.lastActivityAt) {
    const daysSinceActivity = Math.round(daysSince(signals.lastActivityAt, now));
    if (daysSinceActivity >= STAGE_STALL_THRESHOLD_DAYS) {
      score -= NO_RECENT_ACTIVITY_PENALTY;
      why.push(
        `No recorded activity (meeting, reply, note, or task) in ${daysSinceActivity} day(s) (-${NO_RECENT_ACTIVITY_PENALTY} points).`,
      );
    } else {
      score += RECENT_ACTIVITY_BONUS;
      why.push(`Last recorded activity (meeting, reply, note, or task) was ${daysSinceActivity} day(s) ago (+${RECENT_ACTIVITY_BONUS} points).`);
    }
  } else {
    why.push("No recorded activity (meeting, reply, note, or task) found for this lead — no score contribution either way.");
  }

  // --- Deal value relative to the project's typical deal size ------------
  // Optional and only scored when BOTH this deal's value and a real
  // typical value are known — never fabricated or guessed.
  const value = deal.value_amount === null ? null : Number(deal.value_amount);
  if (value !== null && signals.typicalDealValue !== null && signals.typicalDealValue > 0) {
    const ratio = value / signals.typicalDealValue;
    if (ratio >= 1.5) {
      score += VALUE_WELL_ABOVE_TYPICAL_BONUS;
      why.push(
        `Deal value (${value}) is well above this project's typical deal size (${signals.typicalDealValue.toFixed(2)}) (+${VALUE_WELL_ABOVE_TYPICAL_BONUS} points).`,
      );
    } else if (ratio <= 0.5) {
      score -= VALUE_WELL_BELOW_TYPICAL_PENALTY;
      why.push(
        `Deal value (${value}) is well below this project's typical deal size (${signals.typicalDealValue.toFixed(2)}) (-${VALUE_WELL_BELOW_TYPICAL_PENALTY} points).`,
      );
    } else {
      why.push(
        `Deal value (${value}) is in line with this project's typical deal size (${signals.typicalDealValue.toFixed(2)}) — no score contribution.`,
      );
    }
  } else if (value === null) {
    why.push("No deal value (value_amount) set — the size-relative signal is skipped rather than guessed.");
  } else {
    why.push(
      "Not enough other deals with a value set in this project to compute a meaningful typical deal size — the size-relative signal is skipped.",
    );
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return { score: clamped, why };
}

/** This project's real deal-value sample needs at least this many OTHER
 * priced deals before "typical deal size" means anything — otherwise the
 * size-relative health signal is honestly skipped. Exported so every caller
 * (the route, growthAdvisor.ts's sales rules, meetingPrep.ts) shares the
 * exact same threshold rather than redefining it. */
export const MIN_DEALS_FOR_TYPICAL_VALUE = 3;

export interface DealHealthRecord {
  id: string;
  lead_id: string;
  stage: DealStage;
  stage_changed_at: string;
  created_at: string;
  value_amount: string | number | null;
}

/**
 * Gathers the real, per-deal DB signals (latest meeting, latest classified
 * reply, last-activity-across-any-channel, and this project's typical deal
 * value) and computes the deterministic health score for ONE given deal —
 * the exact same query shapes apps/api/src/routes/dealHealth.ts's GET
 * /:dealId/health handler used to run inline.
 *
 * Extracted here (rather than left duplicated in the route) so every other
 * caller that needs "this deal's real health score" — meetingPrep.ts's prep
 * brief, and growthAdvisor.ts's lateStageDealPoorHealthRule — REUSES this
 * single computation instead of re-deriving it, per this codebase's
 * anti-duplication convention (dealHealth.ts's own header: a cached/stored
 * score would go stale; a single shared on-demand function cannot drift
 * between callers the way two independent copies of the same five queries
 * eventually would).
 */
export async function computeDealHealthForDeal(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  deal: DealHealthRecord,
): Promise<DealHealthResult> {
  const [
    meetingResult,
    replyResult,
    meetingActivityResult,
    replyActivityResult,
    noteActivityResult,
    taskActivityResult,
    typicalValueResult,
  ] = await Promise.all([
    tenantDb.query<{ status: string; next_step: string | null; scheduled_at: string }>(
      `SELECT status, next_step, scheduled_at FROM meetings
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3 AND (deal_id = $4 OR deal_id IS NULL)
       ORDER BY (deal_id = $4) DESC, scheduled_at DESC
       LIMIT 1`,
      [tenantId, projectId, deal.lead_id, deal.id],
    ),
    tenantDb.query<{ classification: string; received_at: string }>(
      `SELECT classification, received_at FROM lead_replies
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3
       ORDER BY received_at DESC LIMIT 1`,
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
  const typicalDealValue =
    typicalCount >= MIN_DEALS_FOR_TYPICAL_VALUE && typicalAvg !== null ? Number(typicalAvg) : null;

  const signals: DealHealthSignals = {
    latestMeeting: meetingResult.rows[0] ?? null,
    latestReply: replyResult.rows[0]
      ? {
          classification: replyResult.rows[0].classification as ReplyClassification,
          received_at: replyResult.rows[0].received_at,
        }
      : null,
    lastActivityAt,
    typicalDealValue,
  };

  return computeDealHealth(
    {
      stage: deal.stage,
      stage_changed_at: deal.stage_changed_at,
      created_at: deal.created_at,
      value_amount: deal.value_amount,
    },
    signals,
  );
}
