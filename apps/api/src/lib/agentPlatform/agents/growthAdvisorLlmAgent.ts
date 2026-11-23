import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { RECOMMENDATION_COLUMNS, type GrowthRecommendationRow } from "../../growthAdvisor.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * growthAdvisorLlmAgent: an LLM EXPLANATION LAYER ONLY, same rephrase-only
 * pattern as meetingPreparationAgent / marketingQa.ts's
 * tryLlmExplanation(). This agent reads the real, already-computed, open
 * (status IN ('new','acknowledged')) growth_advisor_recommendations rows
 * (growthAdvisor.ts's own deterministic rule engine — runGrowthAdvisor()
 * writes these rows; this agent deliberately does NOT call
 * runGrowthAdvisor() itself, since that mutates state and this is a
 * read-only grounding tool) and may only explain/group/prioritize them in
 * plain language. It never invents a new recommendation, rule, or
 * severity.
 */

export interface GrowthAdvisorLlmEvidence {
  recommendations: GrowthRecommendationRow[];
}

export async function gatherGrowthAdvisorEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  _subjectId: string | null,
): Promise<GrowthAdvisorLlmEvidence> {
  const result = await tenantDb.query<GrowthRecommendationRow>(
    `SELECT ${RECOMMENDATION_COLUMNS}
       FROM growth_advisor_recommendations
      WHERE tenant_id = $1 AND project_id = $2 AND status IN ('new', 'acknowledged')
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 25`,
    [tenantId, projectId],
  );
  return { recommendations: result.rows };
}

const growthAdvisorLlmEvidenceTool: AgentTool<Record<string, never>, GrowthAdvisorLlmEvidence> = {
  name: "growth_advisor_evidence_read",
  description:
    "Reads this tenant+project's real, currently-open growth_advisor_recommendations rows (produced by growthAdvisor.ts's deterministic rule engine). Read-only; never runs the rule engine itself.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const projectId = requireProjectId(context);
    return gatherGrowthAdvisorEvidence(context.tenantDb, context.tenantId, projectId, null);
  },
};

registerTool(growthAdvisorLlmEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  explainedRecommendations: z.array(z.object({ id: z.string(), explanation: z.string() })),
  evidence: z.array(z.string()),
});

export type GrowthAdvisorLlmOutput = z.infer<typeof outputSchema>;

export const growthAdvisorLlmAgent: AgentDefinition<Record<string, never>, GrowthAdvisorLlmOutput> = {
  key: "growth_advisor_llm",
  label: "Growth Advisor LLM Agent",
  description:
    "Rephrases the already-computed, deterministic growth advisor recommendations (growthAdvisor.ts) into a plain-language briefing — an explanation layer only, never a new source of recommendations.",
  systemPrompt:
    "You are a growth advisory explanation assistant. You will be given this tenant/project's real, currently-open growth_advisor_recommendations rows, each already computed by a deterministic rule engine with a rule_key, severity, title, description, real evidence object, and optional suggested_action. Treat these rows as the complete and only source of truth: explain, group, and prioritize them in plain language. Never invent a new recommendation, rule, or severity not in the evidence, and never re-rank by your own judgment — preserve the given severity ordering. If there are no open recommendations, say plainly that the growth advisor currently has no open recommendations for this project.",
  inputSchema: z.object({}),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "explainedRecommendations": {id: string (a real growth_advisor_recommendations.id from the evidence), explanation: string (plain-language restatement of that row\'s title/description/evidence)}[], "evidence": string[] }',
  tools: [growthAdvisorLlmEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(growthAdvisorLlmAgent.key, [growthAdvisorLlmEvidenceTool.name]);
