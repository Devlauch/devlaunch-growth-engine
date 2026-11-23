import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { assignAgentTools, leadActivityTimelineTool } from "../core/agentTools.js";

/**
 * leadResearchAgent: grounds its output in ONE real lead's real, existing
 * activity timeline (activityTimeline.ts's getLeadActivityTimeline —
 * assignments, deal stage changes, meetings, tasks, notes, replies, audit
 * events). This agent never invents contact details, company facts, or
 * engagement history beyond what that real timeline already contains.
 */

const outputSchema = z.object({
  summary: z.string().min(1),
  engagementSignals: z.array(z.string()),
  suggestedNextStep: z.string(),
  evidence: z.array(z.string()),
});

export type LeadResearchOutput = z.infer<typeof outputSchema>;

export const leadResearchAgent: AgentDefinition<{ leadId: string }, LeadResearchOutput> = {
  key: "lead_research",
  label: "Lead Research Agent",
  description:
    "Summarizes one lead's real, existing activity timeline into a grounded research brief a sales rep can use before reaching out, including a suggested next step.",
  systemPrompt:
    "You are a sales research assistant for a B2B SaaS marketing platform. You only ever summarize and interpret the real activity-timeline grounding data you are given about ONE lead — you never invent names, companies, meeting outcomes, or facts not present in the grounding data. If the timeline is empty, say so plainly and suggest a sensible generic first-touch step rather than fabricating history.",
  inputSchema: z.object({ leadId: z.string().uuid() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string (2-4 sentences), "engagementSignals": string[] (grounded observations from the real timeline), "suggestedNextStep": string (one concrete, grounded suggestion), "evidence": string[] (which timeline entries each claim is based on) }',
  tools: [leadActivityTimelineTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(leadResearchAgent.key, [leadActivityTimelineTool.name]);
