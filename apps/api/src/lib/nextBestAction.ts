/**
 * recommendNextActions: Phase 2 item 6 ("Marketing Intelligence Agent") —
 * "Recommend the next best marketing action." Real, rule-based
 * recommendations computed from real current data, in the same spirit as
 * apps/api/src/lib/warmupPlan.ts's `shouldPauseForHealth` (a pure,
 * documented, auditable rule evaluated against real stats) — NOT an LLM
 * call. Each check below is independent: it appends a recommendation only
 * when its real condition is actually true against the data, and the
 * function returns an empty array (not filler text) when nothing is
 * flagged. A table that doesn't exist yet in this environment degrades
 * that one check to "nothing to recommend here yet" rather than failing
 * the whole call (see pgOptional.ts's SAVEPOINT-based runOptional, the
 * same pattern used throughout this codebase's recent routes).
 */

import { shouldPauseForHealth } from "./warmupPlan.js";
import { runOptional, firstCount } from "./pgOptional.js";
import {
  computeEngagementScore,
  detectIntentSignals,
  getLifecycleStage,
  getUnifiedTimeline,
  type LifecycleDealInput,
  type LifecycleLeadInput,
} from "./unifiedCustomerProfile.js";

// Roadmap item 8 ("priority queue"): a lead scored above this is
// considered high-priority. Mirrors QUALIFIED_SCORE_THRESHOLD-style
// documented constants elsewhere (see analytics.ts) rather than a bare
// magic number.
const HIGH_SCORE_THRESHOLD = 70;

export async function recommendNextActions(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
): Promise<string[]> {
  const actions: string[] = [];

  // --- 1. High-scored leads that haven't been contacted yet ---
  // Trigger: a lead_scores row with total_score > HIGH_SCORE_THRESHOLD for
  // a lead in this project that has no 'approved' message_drafts row (the
  // closest real signal this codebase has for "a human cleared this lead
  // for outreach" — see learningLoop.ts's identical proxy). Degrades
  // honestly if lead_scores and/or message_drafts don't exist yet.
  const uncontactedHighScored = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count
     FROM lead_scores ls
     JOIN leads l ON l.id = ls.lead_id
     WHERE ls.tenant_id = $1 AND l.project_id = $2 AND ls.total_score > ${HIGH_SCORE_THRESHOLD}
       AND NOT EXISTS (
         SELECT 1 FROM message_drafts md WHERE md.lead_id = l.id AND md.status = 'approved'
       )`,
    [tenantId, projectId],
    "lead_scores/message_drafts",
  );
  if (!uncontactedHighScored.degraded) {
    const count = firstCount(uncontactedHighScored);
    if (count > 0) {
      actions.push(
        `${count} lead(s) scored above ${HIGH_SCORE_THRESHOLD} have not been contacted yet — review the priority queue.`,
      );
    }
  }

  // --- 2. Unscored leads ---
  // Trigger: leads in this project with no matching lead_scores row. If
  // lead_scores doesn't exist at all yet, every lead is honestly unscored
  // (no join needed — a real, simpler query for the same real fact).
  const unscoredLeads = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count
     FROM leads l
     WHERE l.tenant_id = $1 AND l.project_id = $2
       AND NOT EXISTS (SELECT 1 FROM lead_scores ls WHERE ls.lead_id = l.id)`,
    [tenantId, projectId],
    "lead_scores",
  );
  let unscoredCount: number;
  if (unscoredLeads.degraded) {
    const allLeads = await tenantDb.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
    );
    unscoredCount = allLeads.rows[0]?.count ?? 0;
  } else {
    unscoredCount = firstCount(unscoredLeads);
  }
  if (unscoredCount > 0) {
    actions.push(`${unscoredCount} lead(s) are still unscored — consider running /recompute.`);
  }

  // --- 3. Elevated bounce/complaint rate on a sending domain ---
  // Trigger: reuses shouldPauseForHealth's real threshold math (bounce
  // rate > 5% or complaint rate > 0.1% of that domain's most recent
  // send_health_stats row) against this tenant's sending_domains. Domains
  // are tenant-level, not project-level (see 060_create_sending_domains.sql),
  // so this check is scoped to tenant_id only.
  const domainHealth = await runOptional<{
    domain: string;
    sent_count: number | null;
    bounced_count: number | null;
    complained_count: number | null;
  }>(
    tenantDb,
    `SELECT sd.domain, shs.sent_count, shs.bounced_count, shs.complained_count
     FROM sending_domains sd
     LEFT JOIN LATERAL (
       SELECT sent_count, bounced_count, complained_count
       FROM send_health_stats
       WHERE sending_domain_id = sd.id
       ORDER BY stat_date DESC
       LIMIT 1
     ) shs ON true
     WHERE sd.tenant_id = $1`,
    [tenantId],
    "sending_domains/send_health_stats",
  );
  if (!domainHealth.degraded) {
    for (const row of domainHealth.rows) {
      if (row.sent_count === null) continue; // no health stats recorded for this domain yet
      const decision = shouldPauseForHealth({
        sentCount: row.sent_count,
        bouncedCount: row.bounced_count ?? 0,
        complainedCount: row.complained_count ?? 0,
      });
      if (decision.pause) {
        actions.push(
          `Bounce/complaint rate on ${row.domain} is elevated — sending may be auto-paused soon. (${decision.reason})`,
        );
      }
    }
  }

  // --- 4. No active scoring rubric for this project ---
  const activeRubric = await runOptional<{ count: number }>(
    tenantDb,
    `SELECT count(*)::int AS count FROM scoring_rubrics WHERE tenant_id = $1 AND project_id = $2 AND is_active = true`,
    [tenantId, projectId],
    "scoring_rubrics",
  );
  if (!activeRubric.degraded && firstCount(activeRubric) === 0) {
    actions.push("No scoring rubric is active for this project yet — set one up to start qualifying leads.");
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Workstream F ("Unified customer profile"): a PER-LEAD next-best-action,
// extending (not duplicating) recommendNextActions above. recommendNextActions
// is project-level ("what should this tenant look at across all its leads
// today") and stays completely unmodified; getNextBestActionForLead is a new,
// separate entry point for "what should a rep do about THIS one lead right
// now," built on top of unifiedCustomerProfile.ts's new
// timeline/engagement-score/intent-signal/lifecycle-stage aggregation. Same
// deterministic-rules-over-real-data convention as every rule above — no LLM
// call anywhere in this function.
// ---------------------------------------------------------------------------

export interface NextBestAction {
  action: string;
  reason: string;
}

// Reuses unifiedCustomerProfile.ts's computeEngagementScore 0-100 scale
// (see that file for the exact formula) — these are just the two
// thresholds this rule set checks against, named rather than inlined.
const HIGH_ENGAGEMENT_SCORE_THRESHOLD = 60;
const LOW_ENGAGEMENT_SCORE_THRESHOLD = 20;

/**
 * Deterministic, rules-based next-best-action for a single lead. Loads the
 * lead's own status + its deals' stages (the same real columns
 * getLifecycleStage expects — see unifiedCustomerProfile.ts), builds this
 * lead's unified timeline, then evaluates one ordered set of rules against
 * lifecycleStage + engagementScore + intentSignals. The first matching rule
 * wins; there is always a fallback at the end, so this never returns
 * nothing.
 */
export async function getNextBestActionForLead(
  tenantDb: import("pg").PoolClient,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<NextBestAction> {
  const leadResult = await tenantDb.query<{ status: string }>(
    `SELECT status FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  if (leadResult.rowCount === 0) {
    return { action: "No action", reason: "Lead not found in this tenant/project." };
  }
  const lead: LifecycleLeadInput = leadResult.rows[0];

  const dealsResult = await tenantDb.query<{ stage: string }>(
    `SELECT stage FROM deals WHERE tenant_id = $1 AND project_id = $2 AND lead_id = $3`,
    [tenantId, projectId, leadId],
  );
  const deals: LifecycleDealInput[] = dealsResult.rows;

  const timeline = await getUnifiedTimeline(tenantDb, tenantId, projectId, leadId);
  const { score } = computeEngagementScore(timeline);
  const intentSignals = detectIntentSignals(timeline);
  const stage = getLifecycleStage(lead, deals);

  if (stage === "customer") {
    return {
      action: "Monitor for renewal/expansion opportunity",
      reason: `Lifecycle stage is "customer" (has a won deal); engagement score ${score}.`,
    };
  }

  if (stage === "opportunity") {
    const reviewingPricing = intentSignals.some((signal) => signal.toLowerCase().includes("pricing"));
    if (reviewingPricing) {
      return {
        action: "Reach out proactively — lead is actively reviewing pricing",
        reason: `Lifecycle stage is "opportunity" and intent signals include: ${intentSignals.join("; ")}.`,
      };
    }
    return {
      action: "Follow up on the open deal",
      reason: `Lifecycle stage is "opportunity" with engagement score ${score}; no high-intent signal detected yet.`,
    };
  }

  if (stage === "sql") {
    const meetingScheduled = intentSignals.some((signal) => signal.toLowerCase().includes("upcoming meeting"));
    if (meetingScheduled) {
      return {
        action: "Prepare for the scheduled meeting",
        reason: `Lifecycle stage is "sql" and a meeting is already scheduled: ${intentSignals.join("; ")}.`,
      };
    }
    return {
      action: "Schedule a discovery call",
      reason: `Lifecycle stage is "sql" (approved for outreach) with engagement score ${score} but no meeting scheduled yet.`,
    };
  }

  if (stage === "mql") {
    if (score >= HIGH_ENGAGEMENT_SCORE_THRESHOLD) {
      return {
        action: "Promote to sales outreach (approve for outreach)",
        reason: `Lifecycle stage is "mql" with a high engagement score (${score} >= ${HIGH_ENGAGEMENT_SCORE_THRESHOLD}).`,
      };
    }
    return {
      action: "Continue the nurture sequence",
      reason: `Lifecycle stage is "mql" with engagement score ${score}, below the ${HIGH_ENGAGEMENT_SCORE_THRESHOLD}-point outreach threshold.`,
    };
  }

  // stage === "lead" or "visitor"
  if (score <= LOW_ENGAGEMENT_SCORE_THRESHOLD && intentSignals.length === 0) {
    return {
      action: "Add to a low-touch nurture sequence",
      reason: `Lifecycle stage is "${stage}" with low engagement (score ${score}) and no intent signals detected.`,
    };
  }
  return {
    action: "Qualify this lead",
    reason: `Lifecycle stage is "${stage}" with engagement score ${score} and ${intentSignals.length} intent signal(s) — review and qualify.`,
  };
}
