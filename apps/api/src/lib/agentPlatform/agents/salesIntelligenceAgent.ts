import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { computeDealHealthForDeal, type DealHealthRecord, type DealHealthResult } from "../../dealHealth.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * salesIntelligenceAgent: grounds its output in ONE real deal's real,
 * freshly-computed deal health (dealHealth.ts's computeDealHealthForDeal —
 * the SAME function apps/api/src/routes/dealHealth.ts's GET /:dealId/health
 * and growthAdvisor.ts's lateStageDealPoorHealthRule both call). Never
 * recomputes or invents a health signal itself.
 */

export interface SalesIntelligenceEvidence {
  deal: DealHealthRecord | null;
  health: DealHealthResult | null;
}

export async function gatherSalesIntelligenceEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  subjectId: string,
): Promise<SalesIntelligenceEvidence> {
  const dealResult = await tenantDb.query<DealHealthRecord>(
    `SELECT id, lead_id, stage, stage_changed_at, created_at, value_amount
       FROM deals
      WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [subjectId, tenantId, projectId],
  );
  const deal = dealResult.rows[0] ?? null;
  if (!deal) {
    return { deal: null, health: null };
  }

  const health = await computeDealHealthForDeal(tenantDb, tenantId, projectId, deal);
  return { deal, health };
}

const salesIntelligenceEvidenceTool: AgentTool<{ dealId: string }, SalesIntelligenceEvidence> = {
  name: "sales_intelligence_evidence_read",
  description:
    "Reads one real deal's record and its real, freshly-computed deal health (meeting/reply/activity signals, score, risk factors) for this tenant+project. Read-only; reuses dealHealth.ts's computeDealHealthForDeal directly.",
  inputSchema: z.object({ dealId: z.string().uuid() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    return gatherSalesIntelligenceEvidence(context.tenantDb, context.tenantId, projectId, input.dealId);
  },
};

registerTool(salesIntelligenceEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  riskAssessment: z.enum(["low", "medium", "high", "unknown"]),
  citedSignals: z.array(z.object({ signal: z.string(), explanation: z.string() })),
  recommendedAction: z.string(),
  evidence: z.array(z.string()),
});

export type SalesIntelligenceOutput = z.infer<typeof outputSchema>;

export const salesIntelligenceAgent: AgentDefinition<{ dealId: string }, SalesIntelligenceOutput> = {
  key: "sales_intelligence",
  label: "Sales Intelligence Agent",
  description:
    "Explains one real deal's real, freshly-computed health score and recommends a next action, grounded only in dealHealth.ts's real signals.",
  systemPrompt:
    "You are a sales intelligence assistant for a B2B SaaS platform. You will be given one real deal's record and its real, freshly-computed health result (score, risk factors/signals such as stage stall, last meeting/reply/activity recency, and typical deal value comparison). You never invent a signal, a probability, or a competitor detail not present in the evidence. If the deal is null, say there is no deal data to analyze. Never predict a close outcome with certainty — describe risk qualitatively and tie every claim to a specific cited signal from the health result.",
  inputSchema: z.object({ dealId: z.string().uuid() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "riskAssessment": "low"|"medium"|"high"|"unknown", "citedSignals": {signal: string, explanation: string}[] (grounded in the health result\'s real signals), "recommendedAction": string, "evidence": string[] }',
  tools: [salesIntelligenceEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(salesIntelligenceAgent.key, [salesIntelligenceEvidenceTool.name]);
