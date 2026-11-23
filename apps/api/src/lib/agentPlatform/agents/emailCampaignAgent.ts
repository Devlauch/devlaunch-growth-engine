import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { getCampaignAttribution, type CampaignAttributionRow } from "../../campaignAttribution.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * emailCampaignAgent: grounds its output in the real campaign_attribution
 * view (campaigns/campaign_members/sequence_enrollments/lead_replies,
 * 276_create_campaign_attribution.sql) via campaignAttribution.ts's
 * getCampaignAttribution() — REUSED directly, not re-derived. Never
 * invents an open rate, click rate, reply, or conversion count beyond this
 * real rollup.
 */

export type EmailCampaignEvidence = CampaignAttributionRow | null;

export async function gatherEmailCampaignEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  subjectId: string,
): Promise<EmailCampaignEvidence> {
  return getCampaignAttribution(tenantDb, tenantId, projectId, subjectId);
}

const emailCampaignEvidenceTool: AgentTool<{ campaignId: string }, EmailCampaignEvidence> = {
  name: "email_campaign_evidence_read",
  description:
    "Reads one real campaign's attribution rollup (member/enrollment/reply/conversion counts) from the campaign_attribution view for this tenant+project. Read-only; reuses campaignAttribution.ts's getCampaignAttribution directly.",
  inputSchema: z.object({ campaignId: z.string().uuid() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    return gatherEmailCampaignEvidence(context.tenantDb, context.tenantId, projectId, input.campaignId);
  },
};

registerTool(emailCampaignEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  weakSignals: z.array(z.string()),
  recommendations: z.array(z.string()),
  evidence: z.array(z.string()),
});

export type EmailCampaignOutput = z.infer<typeof outputSchema>;

export const emailCampaignAgent: AgentDefinition<{ campaignId: string }, EmailCampaignOutput> = {
  key: "email_campaign",
  label: "Email Campaign Agent",
  description:
    "Analyzes one real outbound campaign's attribution rollup (members, sequence enrollments/completions, replies by classification, conversions) and recommends improvements, grounded only in that real rollup.",
  systemPrompt:
    "You are an email/outbound campaign analysis assistant for a B2B marketing platform. You will be given one campaign's real attribution row: member_count, active_member_count, sequence_enrollment_count/active/completed counts, conversion_count, unsubscribed/bounced/stopped_for_reply counts, and reply counts by classification (interested/unsubscribe/not_now/wrong_person). You never invent an open rate, click rate, or metric not present in this row. If the row is null, say there is no attribution data for this campaign. Every recommendation must cite a specific field from the evidence (e.g. a high unsubscribed_count or a low conversion_count relative to active_member_count).",
  inputSchema: z.object({ campaignId: z.string().uuid() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "weakSignals": string[] (each citing a specific field from the attribution row), "recommendations": string[], "evidence": string[] }',
  tools: [emailCampaignEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(emailCampaignAgent.key, [emailCampaignEvidenceTool.name]);
