import type { Touchpoint } from "./multiTouchEngagement.js";

/**
 * leadIntentScoring.ts: Workstream G2 — deterministic, explainable 0-100
 * "lead intent" score + a cold/warm/hot tier, computed purely from real
 * touchpoint history (multiTouchEngagement.ts) plus optional real site
 * events (site_events, 503_create_site_events.sql). Same deterministic,
 * rule-based, NOT-an-LLM-call style as dealHealth.ts/scoreLead.ts — no LLM
 * credentials exist anywhere in this codebase. Every signal below is
 * literally present on a Touchpoint/SiteEvent the caller already queried
 * for real; this function never invents a signal that wasn't passed in.
 */

export type IntentTier = "cold" | "warm" | "hot";

export interface SiteEvent {
  eventName: string;
  occurredAt: string;
}

export interface IntentScoreResult {
  score: number;
  tier: IntentTier;
  signals: string[];
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
}

// --- Tunable thresholds (documented constants, not magic numbers) ---
const RECENCY_WINDOW_DAYS = 7;
const FREQUENCY_WINDOW_DAYS = 30;
const SITE_VISIT_RECENCY_DAYS = 3;

const RECENT_ANY_TOUCH_BONUS = 15;
const RECENT_INBOUND_TOUCH_BONUS = 20;
const FREQUENCY_BONUS_PER_TOUCH = 4;
const FREQUENCY_BONUS_CAP = 20;
const CHANNEL_DIVERSITY_BONUS_PER_CHANNEL = 5;
const CHANNEL_DIVERSITY_BONUS_CAP = 20;
const INTERESTED_REPLY_BONUS = 25;
const MEETING_SCHEDULED_OR_COMPLETED_BONUS = 15;
const RECENT_SITE_VISIT_BONUS = 10;
const UNSUBSCRIBE_SCORE = 0;
const STALE_PENALTY = 15;
const STALE_WINDOW_DAYS = 21;

const HOT_THRESHOLD = 65;
const WARM_THRESHOLD = 35;

const INTERNAL_CHANNELS = new Set(["internal"]);

/**
 * Deterministic intent scoring. `signals` traces every point swing back to
 * a real queried fact — never a fabricated one. An unsubscribe reply
 * anywhere in the touchpoint history is treated as an absolute override
 * (score forced to 0 / tier 'cold'): no amount of prior engagement should
 * ever outrank an explicit opt-out.
 */
export function computeIntentScore(
  touchpoints: Touchpoint[],
  siteEvents: SiteEvent[] = [],
  now: Date = new Date(),
): IntentScoreResult {
  const signals: string[] = [];

  const unsubscribed = touchpoints.some(
    (t) => t.type === "reply" && /classified "unsubscribe"/.test(t.summary),
  );
  if (unsubscribed) {
    return {
      score: UNSUBSCRIBE_SCORE,
      tier: "cold",
      signals: ["Lead has an unsubscribe reply on record — intent is forced to 0/cold regardless of any other signal."],
    };
  }

  if (touchpoints.length === 0 && siteEvents.length === 0) {
    return {
      score: 0,
      tier: "cold",
      signals: ["No touchpoints or site events recorded for this lead yet — nothing to score."],
    };
  }

  let score = 0;

  const sorted = [...touchpoints].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const mostRecent = sorted[0] ?? null;
  const mostRecentInbound = sorted.find((t) => t.direction === "inbound") ?? null;

  // --- Recency ---
  if (mostRecent) {
    const days = Math.round(daysSince(mostRecent.timestamp, now));
    if (days <= RECENCY_WINDOW_DAYS) {
      score += RECENT_ANY_TOUCH_BONUS;
      signals.push(`Most recent touchpoint ("${mostRecent.summary}") was ${days} day(s) ago (+${RECENT_ANY_TOUCH_BONUS}).`);
    } else if (days >= STALE_WINDOW_DAYS) {
      score -= STALE_PENALTY;
      signals.push(`Most recent touchpoint was ${days} day(s) ago, over the ${STALE_WINDOW_DAYS}-day stale window (-${STALE_PENALTY}).`);
    } else {
      signals.push(`Most recent touchpoint was ${days} day(s) ago — no recency bonus or penalty.`);
    }
  } else {
    signals.push("No touchpoints recorded — recency signal skipped.");
  }

  if (mostRecentInbound) {
    const days = Math.round(daysSince(mostRecentInbound.timestamp, now));
    if (days <= RECENCY_WINDOW_DAYS) {
      score += RECENT_INBOUND_TOUCH_BONUS;
      signals.push(
        `Most recent INBOUND touchpoint ("${mostRecentInbound.summary}") was ${days} day(s) ago (+${RECENT_INBOUND_TOUCH_BONUS}) — the lead engaged back, not just received outreach.`,
      );
    } else {
      signals.push(`Most recent inbound touchpoint was ${days} day(s) ago — outside the ${RECENCY_WINDOW_DAYS}-day recency window.`);
    }
  } else {
    signals.push("No inbound touchpoint (reply, chatbot conversation, site visit) recorded yet — no inbound-recency bonus.");
  }

  // --- Frequency (last FREQUENCY_WINDOW_DAYS days) ---
  const recentCount = touchpoints.filter((t) => daysSince(t.timestamp, now) <= FREQUENCY_WINDOW_DAYS).length;
  if (recentCount > 0) {
    const bonus = Math.min(FREQUENCY_BONUS_CAP, recentCount * FREQUENCY_BONUS_PER_TOUCH);
    score += bonus;
    signals.push(
      `${recentCount} touchpoint(s) in the last ${FREQUENCY_WINDOW_DAYS} days (+${bonus}, capped at ${FREQUENCY_BONUS_CAP}).`,
    );
  } else {
    signals.push(`No touchpoints in the last ${FREQUENCY_WINDOW_DAYS} days — no frequency bonus.`);
  }

  // --- Channel diversity (real, distinct non-internal channels touched) ---
  const realChannels = new Set(
    touchpoints.filter((t) => !INTERNAL_CHANNELS.has(t.channel)).map((t) => t.channel),
  );
  if (realChannels.size > 0) {
    const bonus = Math.min(CHANNEL_DIVERSITY_BONUS_CAP, realChannels.size * CHANNEL_DIVERSITY_BONUS_PER_CHANNEL);
    score += bonus;
    signals.push(
      `Engaged across ${realChannels.size} distinct channel(s) (${[...realChannels].join(", ")}) (+${bonus}, capped at ${CHANNEL_DIVERSITY_BONUS_CAP}).`,
    );
  } else {
    signals.push("No real (non-internal) channel touches recorded yet — no channel-diversity bonus.");
  }

  // --- Reply classification signal ---
  const interestedReply = touchpoints.find((t) => t.type === "reply" && /classified "interested"/.test(t.summary));
  if (interestedReply) {
    score += INTERESTED_REPLY_BONUS;
    signals.push(`Has a reply classified "interested" (+${INTERESTED_REPLY_BONUS}).`);
  }

  // --- Meeting signal ---
  const hasMeeting = touchpoints.some((t) => t.type === "meeting");
  if (hasMeeting) {
    score += MEETING_SCHEDULED_OR_COMPLETED_BONUS;
    signals.push(`Has at least one meeting on record (+${MEETING_SCHEDULED_OR_COMPLETED_BONUS}).`);
  }

  // --- Site visit recency (optional; only scored when real site events were passed in) ---
  if (siteEvents.length > 0) {
    const mostRecentVisit = [...siteEvents].sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    )[0];
    const days = Math.round(daysSince(mostRecentVisit.occurredAt, now));
    if (days <= SITE_VISIT_RECENCY_DAYS) {
      score += RECENT_SITE_VISIT_BONUS;
      signals.push(`Visited the site ${days} day(s) ago (+${RECENT_SITE_VISIT_BONUS}, event: ${mostRecentVisit.eventName}).`);
    } else {
      signals.push(`Most recent site visit was ${days} day(s) ago — outside the ${SITE_VISIT_RECENCY_DAYS}-day window.`);
    }
  } else {
    signals.push("No site_events correlated to this lead (leads.session_id) — site-visit signal skipped, not fabricated.");
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tier: IntentTier = clamped >= HOT_THRESHOLD ? "hot" : clamped >= WARM_THRESHOLD ? "warm" : "cold";

  return { score: clamped, tier, signals };
}
