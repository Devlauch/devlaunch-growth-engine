import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * leadQualificationAgent: grounds its output in ONE real lead's real,
 * existing record plus its already-computed `lead_scores` row (same table
 * routes/scoring.ts's recompute endpoint writes — this agent never
 * recomputes a score itself, only explains the one that already exists).
 * Never invents a criterion, an evidence summary, or a score that is not
 * in these two rows.
 */

export interface LeadQualificationEvidence {
  lead: Record<string, unknown> | null;
  score: Record<string, unknown> | null;
}

/** Real, read-only: SELECT * FROM leads / lead_scores — same shape as routes/scoring.ts's own GET handlers. */
export async function gatherLeadQualificationEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  subjectId: string,
): Promise<LeadQualificationEvidence> {
  const leadResult = await tenantDb.query(`SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
    subjectId,
    tenantId,
    projectId,
  ]);
  const scoreResult = await tenantDb.query(
    `SELECT * FROM lead_scores WHERE lead_id = $1 AND tenant_id = $2 AND project_id = $3`,
    [subjectId, tenantId, projectId],
  );

  return {
    lead: leadResult.rows[0] ?? null,
    score: scoreResult.rows[0] ?? null,
  };
}

const leadQualificationEvidenceTool: AgentTool<{ leadId: string }, LeadQualificationEvidence> = {
  name: "lead_qualification_evidence_read",
  description:
    "Reads one real lead's record and its already-computed lead_scores row (total score, per-criterion evidence, why_summary, next_research_note) for this tenant+project. Read-only; never recomputes the score.",
  inputSchema: z.object({ leadId: z.string().uuid() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    return gatherLeadQualificationEvidence(context.tenantDb, context.tenantId, projectId, input.leadId);
  },
};

registerTool(leadQualificationEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  qualification: z.enum(["hot", "warm", "cold", "unknown"]),
  citedFactors: z.array(z.object({ factor: z.string(), explanation: z.string() })),
  recommendedAction: z.string(),
  evidence: z.array(z.string()),
});

export type LeadQualificationOutput = z.infer<typeof outputSchema>;

export const leadQualificationAgent: AgentDefinition<{ leadId: string }, LeadQualificationOutput> = {
  key: "lead_qualification",
  label: "Lead Qualification Agent",
  description:
    "Explains one real lead's already-computed lead score (lead_scores) and recommends a next qualification action, grounded only in that lead's real record and score evidence.",
  systemPrompt:
    "You are a lead qualification assistant for a B2B marketing/sales platform. You will be given grounding data for ONE real lead: its record and its already-computed lead_scores row (total_score, criteria_evidence, why_summary, next_research_note). You never invent contact details, company facts, or a score that is not in the grounding data. If the score row is missing, say plainly that this lead has not been scored yet rather than guessing. Every claim about why the lead scored as it did must cite a specific entry from criteria_evidence.",
  inputSchema: z.object({ leadId: z.string().uuid() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "qualification": "hot"|"warm"|"cold"|"unknown", "citedFactors": {factor: string, explanation: string}[] (grounded in criteria_evidence), "recommendedAction": string, "evidence": string[] }',
  tools: [leadQualificationEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(leadQualificationAgent.key, [leadQualificationEvidenceTool.name]);
