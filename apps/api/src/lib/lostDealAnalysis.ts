import type { PoolClient } from "pg";
import { classifyObjection, type ObjectionTheme } from "./classifyObjection.js";

/**
 * lostDealAnalysis.ts: real, deterministic aggregates over this project's
 * `lost`-stage deals (apps/api/src/routes/deals.ts / 278_create_deals.sql),
 * following the same anti-fabrication convention as
 * growthRevenueAnalytics.ts throughout — every number here is a real query
 * result, and an honest "insufficientData" flag (with a human-readable
 * reason) replaces a misleadingly-precise percentage when the sample is
 * too small to mean anything.
 *
 * KNOWN LIMITATION, checked before writing this (not assumed): this schema
 * has NO deal_stage_history table — deals only carries stage_changed_at
 * for its CURRENT (here, 'lost') stage, exactly as
 * apps/api/src/lib/activityTimeline.ts's header comment already documents
 * ("a deal contributes exactly one 'stage_change' item ... not a full
 * history of every stage it has ever passed through"). So "which prior
 * stage a deal stalled longest in before loss" cannot honestly be
 * computed here. What IS real and computed below is simple time-to-loss:
 * deals.created_at -> deals.stage_changed_at (the moment it reached
 * 'lost'). This is reported with an explicit note explaining the
 * limitation, never silently presented as "time stalled in the prior
 * stage".
 */

/** Below this many lost deals, any theme/correlation percentage would be
 * noise dressed up as a pattern — report honestly instead of guessing. */
export const MIN_LOST_DEALS_FOR_ANALYSIS = 3;

export interface LostDealTimeToLoss {
  averageDays: number;
  medianDays: number;
  note: string;
}

export interface LostDealReplyClassificationBucket {
  classification: string;
  count: number;
  percentage: number;
}

export interface LostDealReplyCorrelation {
  byClassification: LostDealReplyClassificationBucket[];
  leadsWithNoReplyOnRecord: number;
  note: string;
}

export interface LostDealObjectionBucket {
  theme: ObjectionTheme;
  count: number;
  percentage: number;
}

export interface LostDealObjectionThemes {
  byTheme: LostDealObjectionBucket[];
  dealsWithNoTextOnRecord: number;
  note: string;
}

export interface LostDealAnalysisResult {
  lostDealCount: number;
  insufficientData: boolean;
  note?: string;
  timeToLoss?: LostDealTimeToLoss;
  replyClassificationCorrelation?: LostDealReplyCorrelation;
  objectionThemes?: LostDealObjectionThemes;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentOf(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 10000) / 100;
}

export async function computeLostDealAnalysis(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<LostDealAnalysisResult> {
  const lostDealsResult = await tenantDb.query<{
    id: string;
    lead_id: string;
    created_at: string;
    stage_changed_at: string;
  }>(
    `SELECT id, lead_id, created_at, stage_changed_at
     FROM deals
     WHERE tenant_id = $1 AND project_id = $2 AND stage = 'lost'`,
    [tenantId, projectId],
  );

  const lostDeals = lostDealsResult.rows;
  const lostDealCount = lostDeals.length;

  if (lostDealCount < MIN_LOST_DEALS_FOR_ANALYSIS) {
    return {
      lostDealCount,
      insufficientData: true,
      note:
        `Only ${lostDealCount} lost deal(s) recorded for this project — fewer than the ` +
        `${MIN_LOST_DEALS_FOR_ANALYSIS} needed for a meaningful pattern analysis. Reporting no ` +
        `percentages or theme breakdown rather than present a misleading pattern from a tiny sample.`,
    };
  }

  // --- 1. Time-to-loss (see this file's header comment for the honest
  // limitation: no stage-history table exists, so this is creation -> loss
  // time, not "time stalled in the prior stage"). ---------------------------
  const daysToLoss = lostDeals
    .map((d) => (new Date(d.stage_changed_at).getTime() - new Date(d.created_at).getTime()) / (1000 * 60 * 60 * 24))
    .sort((a, b) => a - b);
  const averageDays = daysToLoss.reduce((sum, d) => sum + d, 0) / daysToLoss.length;
  const mid = Math.floor(daysToLoss.length / 2);
  const medianDays = daysToLoss.length % 2 === 0 ? (daysToLoss[mid - 1] + daysToLoss[mid]) / 2 : daysToLoss[mid];

  // --- 2. Reply-classification correlation ---------------------------------
  const leadIds = lostDeals.map((d) => d.lead_id);
  const repliesResult = await tenantDb.query<{ lead_id: string; classification: string }>(
    `SELECT DISTINCT ON (lead_id) lead_id, classification
     FROM lead_replies
     WHERE tenant_id = $1 AND project_id = $2 AND lead_id = ANY($3::uuid[])
     ORDER BY lead_id, received_at DESC`,
    [tenantId, projectId, leadIds],
  );
  const replyByLead = new Map(repliesResult.rows.map((r) => [r.lead_id, r.classification]));
  const classificationCounts = new Map<string, number>();
  let leadsWithNoReplyOnRecord = 0;
  for (const leadId of leadIds) {
    const classification = replyByLead.get(leadId);
    if (!classification) {
      leadsWithNoReplyOnRecord += 1;
      continue;
    }
    classificationCounts.set(classification, (classificationCounts.get(classification) ?? 0) + 1);
  }
  const byClassification: LostDealReplyClassificationBucket[] = Array.from(classificationCounts.entries()).map(
    ([classification, count]) => ({
      classification,
      count,
      percentage: percentOf(count, lostDealCount),
    }),
  );

  // --- 3. Objection themes from real free text (lead_replies.raw_content +
  // notes.body attached to these leads/deals) -------------------------------
  const dealIds = lostDeals.map((d) => d.id);
  const [replyTextResult, noteTextResult] = await Promise.all([
    tenantDb.query<{ lead_id: string; raw_content: string }>(
      `SELECT lead_id, raw_content FROM lead_replies
       WHERE tenant_id = $1 AND project_id = $2 AND lead_id = ANY($3::uuid[])`,
      [tenantId, projectId, leadIds],
    ),
    tenantDb.query<{ deal_id: string; body: string }>(
      `SELECT deal_id, body FROM notes
       WHERE tenant_id = $1 AND project_id = $2 AND deal_id = ANY($3::uuid[])`,
      [tenantId, projectId, dealIds],
    ),
  ]);

  const replyTextByLead = new Map<string, string[]>();
  for (const r of replyTextResult.rows) {
    const arr = replyTextByLead.get(r.lead_id) ?? [];
    arr.push(r.raw_content);
    replyTextByLead.set(r.lead_id, arr);
  }
  const noteTextByDeal = new Map<string, string[]>();
  for (const n of noteTextResult.rows) {
    const arr = noteTextByDeal.get(n.deal_id) ?? [];
    arr.push(n.body);
    noteTextByDeal.set(n.deal_id, arr);
  }

  const themeCounts = new Map<ObjectionTheme, number>();
  let dealsWithNoTextOnRecord = 0;
  for (const deal of lostDeals) {
    const texts = [...(replyTextByLead.get(deal.lead_id) ?? []), ...(noteTextByDeal.get(deal.id) ?? [])];
    if (texts.length === 0) {
      dealsWithNoTextOnRecord += 1;
      continue;
    }
    const { theme } = classifyObjection(texts.join(" \n "));
    themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
  }
  const byTheme: LostDealObjectionBucket[] = Array.from(themeCounts.entries()).map(([theme, count]) => ({
    theme,
    count,
    percentage: percentOf(count, lostDealCount),
  }));

  return {
    lostDealCount,
    insufficientData: false,
    timeToLoss: {
      averageDays: round2(averageDays),
      medianDays: round2(medianDays),
      note:
        "This codebase has no deal_stage_history table (only deals.stage_changed_at for the CURRENT " +
        "stage — see activityTimeline.ts's documented limitation), so this is time from deal creation " +
        "to reaching 'lost', not a breakdown of which specific prior stage the deal stalled longest in.",
    },
    replyClassificationCorrelation: {
      byClassification,
      leadsWithNoReplyOnRecord,
      note:
        "Based on each lost deal's lead's most recent classified reply (lead_replies.classification, " +
        "produced by classifyReply.ts). Leads with no reply on record are counted separately, never guessed.",
    },
    objectionThemes: {
      byTheme,
      dealsWithNoTextOnRecord,
      note:
        "Derived from real lead_replies.raw_content and notes.body text attached to each lost deal's " +
        "lead/deal, run through a deterministic keyword classifier (classifyObjection.ts) — not an LLM. " +
        "Deals with no reply or note text on record are counted separately and excluded from this breakdown.",
    },
  };
}
