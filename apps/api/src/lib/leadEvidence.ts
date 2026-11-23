import type { PoolClient } from "pg";
import type { DraftMessageEvidence } from "./draftMessage.js";

/**
 * leadEvidence.ts: closes a real personalization gap in message drafting
 * (roadmap item 9 / Phase 6a). Before this file existed, POST
 * .../message-drafts (routes/messaging.ts) required a human to manually
 * type `evidenceSummary`/`evidenceFacts` into every request — there was no
 * path from a lead's own ALREADY-COMPUTED, ALREADY-STORED real evidence
 * (lead_scores from scoring.ts's rubric engine, buying_signals from
 * buyingSignals.ts, icp_match_scores from icpMatching.ts — all three
 * already surfaced read-only by routes/leadIntelligence.ts's GET /explain)
 * into a drafted message. In practice this meant every lead in a sequence
 * tended to get whatever evidence text a human happened to paste in once,
 * rather than text that reflects THIS lead's current, specific state.
 *
 * This module is the auto-assembly path: given a lead's real stored rows
 * from those three tables, it builds the same `{ summary, facts }` shape
 * draftMessage.ts's `draftMessage()` already consumes — no new drafting
 * logic, no LLM call, nothing invented. A fact only ever appears here if it
 * is a verbatim (or near-verbatim, e.g. "<type>: <detail> (<confidence>
 * confidence)") rendering of a real stored row. A lead with none of this
 * evidence yet gets `null` back — routes/messaging.ts must treat that as
 * "caller must supply evidenceSummary/evidenceFacts manually", never
 * silently draft from nothing.
 */

export interface LeadEvidenceCriterionEntry {
  present: boolean;
  evidenceSummary?: string;
}

export interface LeadScoreEvidenceSource {
  totalScore: number;
  whySummary: string;
  criteriaEvidence: Record<string, LeadEvidenceCriterionEntry>;
}

export interface BuyingSignalEvidenceSource {
  signalType: string;
  detail: string;
  confidence: string;
}

export interface IcpMatchEvidenceSource {
  icpProfileName: string;
  matchScore: number;
  matchReasons: string[];
}

export interface LeadEvidenceSources {
  leadScore: LeadScoreEvidenceSource | null;
  buyingSignals: BuyingSignalEvidenceSource[];
  icpMatches: IcpMatchEvidenceSource[];
}

/**
 * Pure — no DB access. Composes real, lead-specific facts in a stable,
 * explainable order: rubric criteria evidence first (most directly tied to
 * "why this lead qualifies"), then detected buying signals (most directly
 * tied to "why now"), then the single best ICP match (most directly tied to
 * "why this persona"). Returns null when none of the three sources has
 * anything real to say about this lead yet.
 */
export function assembleLeadEvidence(sources: LeadEvidenceSources): DraftMessageEvidence | null {
  const facts: string[] = [];

  if (sources.leadScore) {
    for (const entry of Object.values(sources.leadScore.criteriaEvidence)) {
      if (entry.present && entry.evidenceSummary) {
        facts.push(entry.evidenceSummary);
      }
    }
  }

  for (const signal of sources.buyingSignals) {
    facts.push(`${signal.signalType} signal: ${signal.detail} (${signal.confidence} confidence)`);
  }

  const bestIcpMatch = sources.icpMatches[0];
  if (bestIcpMatch && bestIcpMatch.matchScore > 0) {
    const reason = bestIcpMatch.matchReasons[0];
    facts.push(
      `Matches the '${bestIcpMatch.icpProfileName}' ICP (${bestIcpMatch.matchScore}% fit${reason ? `: ${reason}` : ""})`,
    );
  }

  if (!sources.leadScore && facts.length === 0) {
    return null;
  }

  const summary =
    sources.leadScore?.whySummary ?? (facts.length > 0 ? facts[0] : "No scoring evidence computed yet for this lead.");

  return { summary, facts };
}

/**
 * DB-touching wrapper: loads this lead's current lead_scores /
 * buying_signals / icp_match_scores rows (the exact same three sources
 * routes/leadIntelligence.ts's GET /explain already reads read-only) and
 * hands them to the pure assembleLeadEvidence() above. Returns null when
 * none of the three sources has a row for this lead yet — callers must not
 * fabricate evidence in that case.
 */
export async function loadLeadEvidence(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<DraftMessageEvidence | null> {
  const [scoreResult, signalsResult, icpResult] = await Promise.all([
    tenantDb.query(
      `SELECT total_score, why_summary, criteria_evidence FROM lead_scores WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3`,
      [leadId, tenantId, projectId],
    ),
    tenantDb.query(
      `SELECT signal_type, detail, confidence FROM buying_signals
       WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3 ORDER BY detected_at DESC LIMIT 5`,
      [leadId, tenantId, projectId],
    ),
    tenantDb.query(
      `SELECT ims.match_score, ims.match_reasons, icp.name AS icp_profile_name
       FROM icp_match_scores ims
       JOIN icp_profiles icp ON icp.id = ims.icp_profile_id
       WHERE ims.lead_id = $1 AND ims.tenant_id = $2 AND ims.project_id = $3
       ORDER BY ims.match_score DESC LIMIT 1`,
      [leadId, tenantId, projectId],
    ),
  ]);

  const scoreRow = scoreResult.rows[0] as
    | { total_score: string | number; why_summary: string; criteria_evidence: Record<string, LeadEvidenceCriterionEntry> }
    | undefined;

  const leadScore: LeadScoreEvidenceSource | null = scoreRow
    ? {
        totalScore: Number(scoreRow.total_score),
        whySummary: scoreRow.why_summary,
        criteriaEvidence: scoreRow.criteria_evidence ?? {},
      }
    : null;

  const buyingSignals: BuyingSignalEvidenceSource[] = signalsResult.rows.map((r: Record<string, unknown>) => ({
    signalType: String(r.signal_type),
    detail: String(r.detail),
    confidence: String(r.confidence),
  }));

  const icpMatches: IcpMatchEvidenceSource[] = icpResult.rows.map((r: Record<string, unknown>) => ({
    icpProfileName: String(r.icp_profile_name),
    matchScore: Number(r.match_score),
    matchReasons: Array.isArray(r.match_reasons) ? (r.match_reasons as string[]) : [],
  }));

  return assembleLeadEvidence({ leadScore, buyingSignals, icpMatches });
}
