import { z } from "zod";
import type { AgentDefinition } from "@devlaunch/agent-sdk";

const rubricCriterionSchema = z.object({
  key: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  weight: z.number().positive(),
  description: z.string().max(2000).optional(),
});

const evidenceEntrySchema = z.object({
  present: z.boolean(),
  summary: z.string().max(2000).optional(),
  source: z.string().max(2000).optional(),
});

export const leadScoringInputSchema = z.object({
  leadId: z.string().min(1),
  rubric: z.object({
    criteria: z.array(rubricCriterionSchema).min(1),
  }),
  evidence: z.record(z.string(), evidenceEntrySchema),
});
export type LeadScoringInput = z.infer<typeof leadScoringInputSchema>;

const criterionScoreSchema = z.object({
  score: z.number().min(0),
  maxScore: z.number().min(0),
  hasEvidence: z.boolean(),
  evidenceSummary: z.string().optional(),
  evidenceSource: z.string().optional(),
});

export const leadScoringOutputSchema = z.object({
  leadId: z.string(),
  totalScore: z.number().min(0).max(100),
  criteriaEvidence: z.record(z.string(), criterionScoreSchema),
  whySummary: z.string(),
  nextResearchNote: z.string(),
  computedAt: z.string(),
});
export type LeadScoringOutput = z.infer<typeof leadScoringOutputSchema>;

/**
 * AgentDefinition for `lead-scoring` v1.
 *
 * Deterministic, explainable scoring: for each rubric criterion, full
 * credit (= its weight) if the caller-supplied evidence map marks that
 * criterion's key as `present`, zero credit otherwise — "missing evidence
 * scores zero" is a hard requirement (roadmap item 7), not a suggestion.
 * totalScore is the sum of per-criterion scores normalized against the sum
 * of all criteria weights, scaled to 0-100. This agent does NOT query the
 * DB itself — the caller (the API layer, via lib/leadScoringEvidence.ts or
 * similar, not built here) is responsible for assembling the evidence map
 * from discovered_organizations/discovered_contacts/crawled pages/lead
 * custom_fields and keying it by rubric criterion key before invoking this
 * agent.
 */
export const leadScoringDefinition: AgentDefinition = {
  id: "lead-scoring",
  version: "1",
  name: "Lead Scoring",
  description:
    "Scores a lead against a project's configurable rubric. Each criterion scores its full weight when the caller-supplied " +
    "evidence map marks it present, and zero when evidence is missing. Produces a why-this-lead summary and a what-to-" +
    "research-next note alongside the numeric score.",
  inputSchema: leadScoringInputSchema,
  outputSchema: leadScoringOutputSchema,
  requiredPermissions: ["agent:lead-scoring:run"],
  tools: [],
};

export async function runLeadScoring(rawInput: unknown): Promise<LeadScoringOutput> {
  const input = leadScoringInputSchema.parse(rawInput);

  const criteriaEvidence: LeadScoringOutput["criteriaEvidence"] = {};
  const withEvidence: string[] = [];
  const withoutEvidence: string[] = [];
  let weightedScoreSum = 0;
  let weightSum = 0;

  for (const criterion of input.rubric.criteria) {
    weightSum += criterion.weight;
    const ev = input.evidence[criterion.key];
    const hasEvidence = Boolean(ev?.present);
    // Deterministic, explainable scoring: full credit for present evidence,
    // zero for missing/absent evidence. No partial/fabricated credit.
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

  const whySummary = buildWhySummary(withEvidence, withoutEvidence, totalScore);
  const nextResearchNote = buildNextResearchNote(withoutEvidence);

  const output: LeadScoringOutput = {
    leadId: input.leadId,
    totalScore,
    criteriaEvidence,
    whySummary,
    nextResearchNote,
    computedAt: new Date().toISOString(),
  };

  // Defensive: validate our own output against outputSchema before
  // returning, so a bug here fails loudly instead of persisting a
  // schema-invalid row into lead_scores.
  return leadScoringOutputSchema.parse(output);
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
