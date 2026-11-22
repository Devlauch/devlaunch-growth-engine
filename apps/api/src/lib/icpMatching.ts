import type { PoolClient } from "pg";
import { Errors } from "./httpError.js";

/**
 * ICP-fit matching: a complementary intelligence layer on top of the
 * EXISTING rubric-based scoring system (scoring_rubrics/lead_scores). This
 * is NOT a replacement for that scoring — it answers a different question
 * ("how well does this lead match this specific named ICP persona?") using
 * real, deterministic, explainable word-overlap matching against the
 * lead's own data (custom_fields + message text), never fuzzy NLP and
 * never a guess. Zero real matches always scores zero — "missing evidence
 * scores zero" is the same hard rule the existing scoring system follows
 * (see scoreLead.ts).
 *
 * Fixed point weights (documented here since they're the whole "model"):
 *   - Segment match (the ICP's `segment` text found in the lead's data): 40 pts.
 *   - Each distinct pain_point found (up to 4): 15 pts each (max 60 pts).
 *   - Each distinct channel found (up to 4): 5 pts each (max 20 pts).
 * The raw sum is capped at 100 (a lead can plausibly match on all three
 * dimensions at once, which would otherwise exceed 100).
 */

const SEGMENT_WEIGHT = 40;
const PAIN_POINT_WEIGHT = 15;
const MAX_PAIN_POINT_MATCHES = 4;
const CHANNEL_WEIGHT = 5;
const MAX_CHANNEL_MATCHES = 4;
const MAX_SCORE = 100;

export interface IcpMatchResult {
  score: number;
  reasons: string[];
}

export interface IcpMatchableLead {
  custom_fields?: Record<string, unknown> | null;
  message?: string | null;
  company?: string | null;
}

export interface IcpMatchableProfile {
  segment?: string | null;
  pain_points?: string[] | null;
  channels?: string[] | null;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "their",
  "about",
  "have",
  "will",
  "they",
  "them",
  "than",
  "then",
]);

/** Pulls out words of length >= 4 (ignoring common stopwords) from a phrase, for overlap checks. */
function significantWords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** Whole-word, case-insensitive containment check (word-overlap, not fuzzy matching). */
function haystackContainsWord(haystack: string, word: string): boolean {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(haystack);
}

/** True if any significant word of `phrase` appears as a whole word in `haystack`. */
function phraseOverlapsHaystack(phrase: string, haystack: string): boolean {
  const words = significantWords(phrase);
  if (words.length === 0) return false;
  return words.some((w) => haystackContainsWord(haystack, w));
}

function buildHaystack(lead: IcpMatchableLead): string {
  const parts: string[] = [];
  if (lead.message) parts.push(lead.message);
  if (lead.company) parts.push(lead.company);
  if (lead.custom_fields) {
    for (const value of Object.values(lead.custom_fields)) {
      if (typeof value === "string") parts.push(value);
      else if (value !== null && value !== undefined) parts.push(JSON.stringify(value));
    }
  }
  return parts.join(" \n ");
}

/**
 * Deterministic word-overlap scoring of one lead against one ICP profile.
 * Checks the lead's custom_fields values and message text (case-insensitive)
 * for mentions of the ICP's segment, pain_points, and channels. Each real
 * match contributes its fixed weight (see constants above); no matches at
 * all means a score of 0 — never padded.
 */
export function matchLeadToIcp(lead: IcpMatchableLead, icpProfile: IcpMatchableProfile): IcpMatchResult {
  const haystack = buildHaystack(lead);
  const reasons: string[] = [];
  let rawScore = 0;

  if (icpProfile.segment && icpProfile.segment.trim().length > 0 && phraseOverlapsHaystack(icpProfile.segment, haystack)) {
    rawScore += SEGMENT_WEIGHT;
    reasons.push(`Lead's data mentions this ICP's segment ("${icpProfile.segment}")`);
  }

  let painPointMatches = 0;
  for (const painPoint of icpProfile.pain_points ?? []) {
    if (painPointMatches >= MAX_PAIN_POINT_MATCHES) break;
    if (!painPoint || painPoint.trim().length === 0) continue;
    if (phraseOverlapsHaystack(painPoint, haystack)) {
      rawScore += PAIN_POINT_WEIGHT;
      painPointMatches += 1;
      reasons.push(`Lead's data mentions a pain point keyword from this ICP ("${painPoint}")`);
    }
  }

  let channelMatches = 0;
  for (const channel of icpProfile.channels ?? []) {
    if (channelMatches >= MAX_CHANNEL_MATCHES) break;
    if (!channel || channel.trim().length === 0) continue;
    if (phraseOverlapsHaystack(channel, haystack)) {
      rawScore += CHANNEL_WEIGHT;
      channelMatches += 1;
      reasons.push(`Lead's data mentions a channel from this ICP ("${channel}")`);
    }
  }

  return { score: Math.min(MAX_SCORE, rawScore), reasons };
}

export interface IcpMatchScoreRow {
  id: string;
  tenant_id: string;
  project_id: string;
  lead_id: string;
  icp_profile_id: string;
  match_score: string | number;
  match_reasons: string[];
  computed_at: string;
  created_at: string;
}

/**
 * Loads every ICP profile for the project, scores the lead against each
 * with matchLeadToIcp, upserts one icp_match_scores row per (lead, ICP)
 * pair, and returns all rows sorted by score descending.
 */
export async function matchLeadToAllIcps(
  tenantDb: Pick<PoolClient, "query">,
  tenantId: string,
  projectId: string,
  leadId: string,
): Promise<IcpMatchScoreRow[]> {
  const leadResult = await tenantDb.query(
    `SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [leadId, tenantId, projectId],
  );
  if (leadResult.rowCount === 0) {
    throw Errors.notFound("Lead not found");
  }
  const lead = leadResult.rows[0] as IcpMatchableLead;

  const icpProfilesResult = await tenantDb.query(
    `SELECT * FROM icp_profiles WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
    [tenantId, projectId],
  );
  const icpProfiles = icpProfilesResult.rows as (IcpMatchableProfile & { id: string })[];

  const rows: IcpMatchScoreRow[] = [];
  for (const icpProfile of icpProfiles) {
    const { score, reasons } = matchLeadToIcp(lead, icpProfile);
    const upserted = await tenantDb.query(
      `INSERT INTO icp_match_scores (tenant_id, project_id, lead_id, icp_profile_id, match_score, match_reasons, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
       ON CONFLICT (lead_id, icp_profile_id) DO UPDATE SET
         match_score = EXCLUDED.match_score,
         match_reasons = EXCLUDED.match_reasons,
         computed_at = EXCLUDED.computed_at
       RETURNING *`,
      [tenantId, projectId, leadId, icpProfile.id, score, JSON.stringify(reasons)],
    );
    rows.push(upserted.rows[0] as IcpMatchScoreRow);
  }

  return rows.sort((a, b) => Number(b.match_score) - Number(a.match_score));
}
