import type { Touchpoint } from "./multiTouchEngagement.js";
import type { IntentScoreResult } from "./leadIntentScoring.js";
import { STAGE_STALL_THRESHOLD_DAYS, TERMINAL_DEAL_STAGES, type DealStage } from "./salesPipeline.js";

/**
 * followUpRecommendation.ts: Workstream G2 — deterministic, rule-based
 * "what should a rep do next for this lead" recommendation. Same NOT-an-
 * LLM-call style as dealHealth.ts/nextBestAction.ts.
 *
 * OVERLAP CHECK (done before writing this file, per the task's explicit
 * instruction): apps/api/src/lib/salesPipeline.ts's checkStalledDeals()
 * already exists and does something related but NOT the same thing — it
 * is a side-effecting function that actually INSERTs a crm_tasks +
 * follow_up_tasks row for a deal stalled past STAGE_STALL_THRESHOLD_DAYS
 * (7 days), scanning every open deal in a project. recommendNextActions()
 * in apps/api/src/lib/nextBestAction.ts is a third, separate thing again —
 * project-level marketing/ops nudges (unscored leads, uncontacted
 * high-scorers, domain health), not per-lead sales follow-up timing.
 *
 * recommendFollowUp() below is deliberately NOT a duplicate of either:
 * it is a PURE, read-only, per-lead advisory function (touchpoints +
 * intent score + deal stage in, one recommendation out — no DB access, no
 * side effects, nothing written). It is the per-lead "why/when should I
 * follow up" explanation a rep reads on a lead's page; checkStalledDeals()
 * is the per-project automatic crm_tasks creator that already runs today.
 * The two are complementary, not competing: this file REUSES
 * salesPipeline.ts's own STAGE_STALL_THRESHOLD_DAYS and TERMINAL_DEAL_STAGES
 * constants (rather than redefining a second, possibly-divergent "stalled"
 * threshold) so a rep reading "deal stalled" on this recommendation and on
 * an auto-created follow_up_tasks row always means the exact same number
 * of days. Nothing in salesPipeline.ts is modified.
 */

export type FollowUpAction =
  | "none_unsubscribed"
  | "none_closed"
  | "no_action_needed"
  | "call_now"
  | "send_follow_up_email"
  | "try_different_channel"
  | "re_engagement_email"
  | "escalate_stalled_deal";

export interface FollowUpRecommendation {
  action: FollowUpAction;
  suggestedTiming: string;
  reason: string;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
function daysSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
}

const HOT_NO_RESPONSE_DAYS = 5;
const COLD_REENGAGEMENT_DAYS = 14;
const WARM_FOLLOW_UP_DAYS = 7;

/**
 * Deterministic follow-up recommendation for one lead. `dealStage` is
 * optional (a lead may not have a deal yet) — when absent, the
 * deal-stage-specific rules are honestly skipped rather than guessed.
 */
export function recommendFollowUp(
  touchpoints: Touchpoint[],
  intentScore: IntentScoreResult,
  dealStage: DealStage | null,
  now: Date = new Date(),
): FollowUpRecommendation {
  const unsubscribed = touchpoints.some((t) => t.type === "reply" && /classified "unsubscribe"/.test(t.summary));
  if (unsubscribed) {
    return {
      action: "none_unsubscribed",
      suggestedTiming: "never",
      reason: "Lead has an unsubscribe reply on record — no further outreach should be attempted on any channel.",
    };
  }

  if (dealStage && TERMINAL_DEAL_STAGES.has(dealStage)) {
    return {
      action: "none_closed",
      suggestedTiming: "n/a",
      reason: `Deal is already in terminal stage '${dealStage}' — follow-up recommendations are not meaningful for a closed deal.`,
    };
  }

  const sorted = [...touchpoints].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const mostRecent = sorted[0] ?? null;
  const mostRecentInbound = sorted.find((t) => t.direction === "inbound") ?? null;
  const daysSinceAnyTouch = mostRecent ? Math.round(daysSince(mostRecent.timestamp, now)) : null;
  const daysSinceInbound = mostRecentInbound ? Math.round(daysSince(mostRecentInbound.timestamp, now)) : null;

  // --- Rule 1: hot intent, no reply in HOT_NO_RESPONSE_DAYS -> call now ---
  if (intentScore.tier === "hot" && (daysSinceInbound === null || daysSinceInbound >= HOT_NO_RESPONSE_DAYS)) {
    return {
      action: "call_now",
      suggestedTiming: "within 1 business day",
      reason:
        daysSinceInbound === null
          ? `Intent is 'hot' (score ${intentScore.score}) but no inbound response has ever been recorded — a direct call is more likely to break through than another async message.`
          : `Intent is 'hot' (score ${intentScore.score}) but no inbound response in ${daysSinceInbound} day(s) (>= ${HOT_NO_RESPONSE_DAYS}-day threshold) — escalate to a direct call.`,
    };
  }

  // --- Rule 2: cold intent, no touch at all in COLD_REENGAGEMENT_DAYS -> re-engagement email ---
  if (intentScore.tier === "cold" && (daysSinceAnyTouch === null || daysSinceAnyTouch >= COLD_REENGAGEMENT_DAYS)) {
    return {
      action: "re_engagement_email",
      suggestedTiming: "this week",
      reason:
        daysSinceAnyTouch === null
          ? "Intent is 'cold' and no touchpoint has ever been recorded — send a first/re-engagement email."
          : `Intent is 'cold' and no touchpoint in ${daysSinceAnyTouch} day(s) (>= ${COLD_REENGAGEMENT_DAYS}-day threshold) — send a re-engagement email rather than continuing silence.`,
    };
  }

  // --- Rule 3: warm intent, no touch in WARM_FOLLOW_UP_DAYS -> follow-up email, or a new channel if one hasn't been tried ---
  if (intentScore.tier === "warm" && (daysSinceAnyTouch === null || daysSinceAnyTouch >= WARM_FOLLOW_UP_DAYS)) {
    const channelsUsed = new Set(touchpoints.filter((t) => t.channel !== "internal").map((t) => t.channel));
    const triedOnlyOneChannel = channelsUsed.size === 1;
    if (triedOnlyOneChannel) {
      return {
        action: "try_different_channel",
        suggestedTiming: "within 2-3 business days",
        reason: `Intent is 'warm' with no touch in ${daysSinceAnyTouch ?? "N/A"} day(s), and every touchpoint so far used only the "${[...channelsUsed][0]}" channel — try a different channel before writing the lead off.`,
      };
    }
    return {
      action: "send_follow_up_email",
      suggestedTiming: "within 2-3 business days",
      reason: `Intent is 'warm' (score ${intentScore.score}) with no touch in ${daysSinceAnyTouch ?? "N/A"} day(s) (>= ${WARM_FOLLOW_UP_DAYS}-day threshold) — a follow-up is due.`,
    };
  }

  // --- Rule 4: deal has been open this long without a stage change is salesPipeline.ts's own
  // responsibility (checkStalledDeals creates the actual task); here we only surface the SAME
  // threshold as an honest, read-only advisory note when a dealStage is known and non-terminal,
  // reusing the shared constant rather than guessing a second number. ---
  if (dealStage && daysSinceAnyTouch !== null && daysSinceAnyTouch >= STAGE_STALL_THRESHOLD_DAYS) {
    return {
      action: "escalate_stalled_deal",
      suggestedTiming: "today",
      reason: `No touchpoint in ${daysSinceAnyTouch} day(s), at or beyond salesPipeline.ts's own ${STAGE_STALL_THRESHOLD_DAYS}-day stall threshold for an open deal in stage '${dealStage}' — this likely already has (or should have) an automatic follow_up_tasks row from checkStalledDeals().`,
    };
  }

  return {
    action: "no_action_needed",
    suggestedTiming: "continue current cadence",
    reason: `Recent engagement (intent tier '${intentScore.tier}', most recent touch ${daysSinceAnyTouch ?? "N/A"} day(s) ago) does not yet meet any follow-up trigger threshold.`,
  };
}
