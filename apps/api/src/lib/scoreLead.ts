/**
 * Pure lead-scoring math, ported from apps/worker/src/agents/leadScoring.ts's
 * `runLeadScoring` (deterministic scoring agent for roadmap item 7,
 * "Configurable scoring"). apps/api has no runtime dependency on the worker
 * process/package (agents only execute inside apps/worker today — see
 * apps/api/package.json), so this is an intentional, small duplication of a
 * pure function rather than a new cross-package dependency for one
 * computation. Keep this in sync with leadScoring.ts's algorithm exactly
 * (same weighting, rounding, and summary text) if either changes.
 */

export interface ScoreLeadCriterion {
  key: string;
  label: string;
  weight: number;
  description?: string;
}

export interface ScoreLeadEvidenceEntry {
  present: boolean;
  summary?: string;
  source?: string;
}

export interface ScoreLeadCriterionScore {
  score: number;
  maxScore: number;
  hasEvidence: boolean;
  evidenceSummary?: string;
  evidenceSource?: string;
}

export interface ScoreLeadResult {
  totalScore: number;
  criteriaEvidence: Record<string, ScoreLeadCriterionScore>;
  whySummary: string;
  nextResearchNote: string;
}

/**
 * Deterministic, explainable scoring: for each rubric criterion, full credit
 * (= its weight) if the evidence map marks that criterion's key as
 * `present`, zero credit otherwise — "missing evidence scores zero" is a
 * hard requirement, not a suggestion. totalScore is the sum of per-criterion
 * scores normalized against the sum of all criteria weights, scaled to
 * 0-100, clamped and rounded to 2 decimal places exactly like the worker
 * agent.
 */
export function scoreLead(
  criteria: ScoreLeadCriterion[],
  evidence: Record<string, ScoreLeadEvidenceEntry>,
): ScoreLeadResult {
  const criteriaEvidence: Record<string, ScoreLeadCriterionScore> = {};
  const withEvidence: string[] = [];
  const withoutEvidence: string[] = [];
  let weightedScoreSum = 0;
  let weightSum = 0;

  for (const criterion of criteria) {
    weightSum += criterion.weight;
    const ev = evidence[criterion.key];
    const hasEvidence = Boolean(ev?.present);
    const score = hasEvidence ? criterion.weight : 0;
    weightedScoreSum += score;

    criteriaEvidence[criterion.key] = {
      score,
      maxScore: criterion.weight,
      hasEvidence,
      ...(ev?.summary ? { evidenceSummary: ev.summary } : {}),
      ...(ev?.source ? { evidenceSource: ev.source } : {}),
    };

    if (hasEvidence) {
      withEvidence.push(criterion.label);
    } else {
      withoutEvidence.push(criterion.label);
    }
  }

  const rawTotal = weightSum > 0 ? (weightedScoreSum / weightSum) * 100 : 0;
  const totalScore = Math.max(0, Math.min(100, Math.round(rawTotal * 100) / 100));

  return {
    totalScore,
    criteriaEvidence,
    whySummary: buildWhySummary(withEvidence, withoutEvidence, totalScore),
    nextResearchNote: buildNextResearchNote(withoutEvidence),
  };
}

function buildWhySummary(withEvidence: string[], withoutEvidence: string[], totalScore: number): string {
  const scoreSentence = `This lead scores ${totalScore}/100 against the active rubric.`;
  if (withEvidence.length === 0) {
    return `${scoreSentence} No criteria had supporting evidence yet, so the score reflects a near-empty profile.`;
  }
  if (withoutEvidence.length === 0) {
    return `${scoreSentence} Evidence was found for every criterion: ${withEvidence.join(", ")}.`;
  }
  return (
    `${scoreSentence} Evidence was found for ${withEvidence.join(", ")}, ` +
    `but not yet for ${withoutEvidence.join(", ")}.`
  );
}

function buildNextResearchNote(withoutEvidence: string[]): string {
  if (withoutEvidence.length === 0) {
    return "All rubric criteria already have supporting evidence — no further research is required right now.";
  }
  return `Next, look for evidence of: ${withoutEvidence.join(", ")}.`;
}
