import type { PoolClient } from "pg";

/**
 * Objection insights: real counts/trends of objection-flavored REPLY
 * signals over time, scoped to a tenant/project.
 *
 * This is deliberately REPLY-side (what a lead said back), distinct from
 * any deal-stage-side "lost deal analysis" (why a deal in the pipeline
 * stalled/closed-lost) that may exist elsewhere in this codebase — this
 * file does not touch deals at all.
 *
 * IMPORTANT — the schema gap this honestly documents rather than papers
 * over: `lead_replies.classification` (see
 * packages/db/migrations/058_create_lead_replies.sql and
 * apps/api/src/lib/classifyReply.ts) currently only has five buckets:
 * 'interested' | 'not_now' | 'wrong_person' | 'unsubscribe' | 'unclassified'.
 * There is no dedicated 'objection' value, and no separate
 * objection-classification column/table existed in this codebase as of
 * when this file was written. A richer, purpose-built objection taxonomy
 * (price objection / timing objection / no-authority objection / etc.) is
 * plausibly being built elsewhere as its own classifier
 * (apps/api/src/lib/classifyObjection.ts) — if that file exists by the
 * time you read this, ITS exported classification values are the correct
 * ones to aggregate and this module should be upgraded to read from
 * wherever it stores results. Until then, this module uses 'not_now' as
 * the closest honest proxy for "objection-flavored" reply signal — a
 * prospect saying "not interested" / "not right now" / "not a good fit" is
 * the closest thing the EXISTING classifier captures to a sales
 * objection — and labels every output with that caveat so nobody mistakes
 * this for a true objection taxonomy.
 */

export type ObjectionTrend = "increasing" | "decreasing" | "stable" | "insufficient_data";

/** Minimum number of objection-flavored replies required before a trend
 * verdict is considered meaningful. Below this, every stat still reports
 * its raw count, but `trend` is forced to 'insufficient_data' rather than
 * faking a direction off a handful of data points. */
const MIN_SAMPLE_SIZE = 5;

export interface ObjectionWeekBucket {
  weekStart: string;
  count: number;
}

export interface ObjectionInsights {
  proxyClassification: string;
  proxyCaveat: string;
  totalObjectionFlavoredReplies: number;
  distinctLeadsWithObjection: number;
  totalReplies: number;
  windowStart: string | null;
  windowEnd: string | null;
  weeklyBuckets: ObjectionWeekBucket[];
  trend: ObjectionTrend;
  trendNote: string;
  sufficientSampleSize: boolean;
}

interface QueryableDb {
  query: PoolClient["query"];
}

/**
 * Aggregates objection-flavored reply signal for a project over the given
 * lookback window (default 90 days). Every number here traces to a real
 * `lead_replies` row — nothing is estimated or interpolated.
 */
export async function getObjectionInsights(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  lookbackDays = 90,
): Promise<ObjectionInsights> {
  const proxyClassification = "not_now";
  const proxyCaveat =
    "lead_replies.classification has no dedicated 'objection' value yet (see classifyReply.ts: " +
    "interested | not_now | wrong_person | unsubscribe | unclassified). 'not_now' is used here as the " +
    "closest honest proxy for an objection-flavored reply; this is NOT a true objection taxonomy.";

  const totalRepliesResult = await tenantDb.query(
    `SELECT count(*)::int AS count
     FROM lead_replies
     WHERE tenant_id = $1 AND project_id = $2 AND received_at >= now() - ($3 || ' days')::interval`,
    [tenantId, projectId, lookbackDays],
  );
  const totalReplies = Number((totalRepliesResult.rows[0] as { count: number } | undefined)?.count ?? 0);

  const objectionRepliesResult = await tenantDb.query(
    `SELECT id, lead_id, received_at
     FROM lead_replies
     WHERE tenant_id = $1 AND project_id = $2 AND classification = $3
       AND received_at >= now() - ($4 || ' days')::interval
     ORDER BY received_at ASC`,
    [tenantId, projectId, proxyClassification, lookbackDays],
  );
  const rows = objectionRepliesResult.rows as Array<{ id: string; lead_id: string; received_at: string }>;

  const totalObjectionFlavoredReplies = rows.length;
  const distinctLeadsWithObjection = new Set(rows.map((r) => r.lead_id)).size;
  const windowStart = rows.length > 0 ? rows[0].received_at : null;
  const windowEnd = rows.length > 0 ? rows[rows.length - 1].received_at : null;

  const weeklyBucketsResult = await tenantDb.query(
    `SELECT date_trunc('week', received_at)::date AS week_start, count(*)::int AS count
     FROM lead_replies
     WHERE tenant_id = $1 AND project_id = $2 AND classification = $3
       AND received_at >= now() - ($4 || ' days')::interval
     GROUP BY week_start
     ORDER BY week_start ASC`,
    [tenantId, projectId, proxyClassification, lookbackDays],
  );
  const weeklyBuckets: ObjectionWeekBucket[] = (
    weeklyBucketsResult.rows as Array<{ week_start: string; count: number }>
  ).map((r) => ({ weekStart: r.week_start, count: Number(r.count) }));

  const sufficientSampleSize = totalObjectionFlavoredReplies >= MIN_SAMPLE_SIZE;

  let trend: ObjectionTrend = "insufficient_data";
  let trendNote = `Fewer than ${MIN_SAMPLE_SIZE} objection-flavored replies (${totalObjectionFlavoredReplies}) in the last ${lookbackDays} days — not enough signal to call a trend honestly.`;

  if (sufficientSampleSize && weeklyBuckets.length >= 2) {
    // Compare the first half of the weekly buckets against the second half
    // (simple, explainable, deterministic — not a statistical forecast).
    const mid = Math.ceil(weeklyBuckets.length / 2);
    const firstHalf = weeklyBuckets.slice(0, mid);
    const secondHalf = weeklyBuckets.slice(mid);
    const firstHalfAvg = firstHalf.reduce((sum, b) => sum + b.count, 0) / firstHalf.length;
    const secondHalfAvg =
      secondHalf.length > 0 ? secondHalf.reduce((sum, b) => sum + b.count, 0) / secondHalf.length : firstHalfAvg;

    const delta = secondHalfAvg - firstHalfAvg;
    const relativeThreshold = Math.max(0.5, firstHalfAvg * 0.2); // avoid noise on small averages

    if (delta > relativeThreshold) {
      trend = "increasing";
      trendNote = `Weekly objection-flavored reply rate rose from an average of ${firstHalfAvg.toFixed(2)}/week to ${secondHalfAvg.toFixed(2)}/week across the ${lookbackDays}-day window.`;
    } else if (delta < -relativeThreshold) {
      trend = "decreasing";
      trendNote = `Weekly objection-flavored reply rate fell from an average of ${firstHalfAvg.toFixed(2)}/week to ${secondHalfAvg.toFixed(2)}/week across the ${lookbackDays}-day window.`;
    } else {
      trend = "stable";
      trendNote = `Weekly objection-flavored reply rate stayed roughly flat (~${firstHalfAvg.toFixed(2)}/week) across the ${lookbackDays}-day window.`;
    }
  } else if (sufficientSampleSize && weeklyBuckets.length < 2) {
    trend = "insufficient_data";
    trendNote = `All ${totalObjectionFlavoredReplies} objection-flavored replies fall within a single week bucket — not enough time spread to call a trend.`;
  }

  return {
    proxyClassification,
    proxyCaveat,
    totalObjectionFlavoredReplies,
    distinctLeadsWithObjection,
    totalReplies,
    windowStart,
    windowEnd,
    weeklyBuckets,
    trend,
    trendNote,
    sufficientSampleSize,
  };
}
