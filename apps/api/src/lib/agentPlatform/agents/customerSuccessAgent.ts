import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { computeCrmDashboard, type CrmDashboard } from "../../crmDashboard.js";
import { computeRevenueIntelligence, type RevenueIntelligence } from "../../revenueIntelligence.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * customerSuccessAgent: grounds its output in two real, existing rollups —
 * crmDashboard.ts's computeCrmDashboard() (pipeline by stage, deals
 * won/lost this period, upcoming meetings, overdue follow-up tasks,
 * lead-to-customer conversion) and revenueIntelligence.ts's
 * computeRevenueIntelligence() (per-campaign qualified leads -> meetings
 * -> deals won -> revenue -> CAC/ROI) — REUSED directly, not re-derived.
 *
 * Honesty note: this tenant/project schema has no dedicated churn-risk-score
 * or renewal-date table today (confirmed by grep across
 * apps/api/src/lib/*.ts before this agent was authored) — this agent
 * therefore grounds in the closest real signals that DO exist (overdue
 * follow-up tasks, stalled/lost deals, lead-to-customer conversion) rather
 * than inventing a churn score or a renewal date that isn't tracked
 * anywhere in this codebase.
 */

export interface CustomerSuccessEvidence {
  dashboard: CrmDashboard;
  revenue: RevenueIntelligence;
}

export async function gatherCustomerSuccessEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  _subjectId: string | null,
): Promise<CustomerSuccessEvidence> {
  const [dashboard, revenue] = await Promise.all([
    computeCrmDashboard(tenantDb, tenantId, projectId),
    computeRevenueIntelligence(tenantDb, tenantId, projectId),
  ]);
  return { dashboard, revenue };
}

const customerSuccessEvidenceTool: AgentTool<Record<string, never>, CustomerSuccessEvidence> = {
  name: "customer_success_evidence_read",
  description:
    "Reads this tenant+project's real CRM dashboard rollup (pipeline, deals won/lost, upcoming meetings, overdue follow-ups, lead-to-customer conversion) and real revenue intelligence (per-campaign CAC/ROI). Read-only; reuses crmDashboard.ts/revenueIntelligence.ts directly.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const projectId = requireProjectId(context);
    return gatherCustomerSuccessEvidence(context.tenantDb, context.tenantId, projectId, null);
  },
};

registerTool(customerSuccessEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  atRiskSignals: z.array(z.object({ signal: z.string(), explanation: z.string() })),
  recommendedAction: z.string(),
  evidence: z.array(z.string()),
});

export type CustomerSuccessOutput = z.infer<typeof outputSchema>;

export const customerSuccessAgent: AgentDefinition<Record<string, never>, CustomerSuccessOutput> = {
  key: "customer_success",
  label: "Customer Success Agent",
  description:
    "Surfaces real account-health signals (overdue follow-ups, stalled/lost deals, lead-to-customer conversion, per-campaign CAC/ROI) grounded only in crmDashboard.ts/revenueIntelligence.ts's real rollups.",
  systemPrompt:
    "You are a customer success assistant for a B2B SaaS platform. You will be given two real rollups: a CRM dashboard (pipeline by stage, deals won/lost this period, upcoming meetings, overdue follow-up tasks, lead-to-customer conversion rate) and revenue intelligence (per-campaign qualified leads, meetings, deals won, revenue, CAC, ROI). This platform does not track a dedicated churn-risk score or renewal date anywhere — never invent one. Ground every 'at risk' signal in a real field from the evidence (e.g. a high overdueFollowUpTasks count, a low leadToCustomerConversion.rate, or a campaign with 'not_available' ROI). If a number is null/not_available in the evidence, say so plainly rather than guessing a value.",
  inputSchema: z.object({}),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "atRiskSignals": {signal: string, explanation: string}[] (each grounded in a real field from the dashboard/revenue evidence), "recommendedAction": string, "evidence": string[] }',
  tools: [customerSuccessEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(customerSuccessAgent.key, [customerSuccessEvidenceTool.name]);
