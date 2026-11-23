import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { getCalendarForProject, type SocialContentCalendarRow } from "../../socialContentCalendar.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * socialMediaStrategyAgent: grounds its output in the real
 * social_content_calendar table (socialContentCalendar.ts's
 * getCalendarForProject — the same table the Postiz integration
 * (postizClient.ts) publishes scheduled posts through, per
 * approveAndPublish()). Never invents a post, a platform, or an
 * engagement number beyond what is scheduled/recorded.
 */

export interface SocialMediaStrategyEvidence {
  items: SocialContentCalendarRow[];
}

export async function gatherSocialMediaStrategyEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  _subjectId: string | null,
): Promise<SocialMediaStrategyEvidence> {
  const items = await getCalendarForProject(tenantDb, tenantId, projectId);
  return { items };
}

const socialMediaStrategyEvidenceTool: AgentTool<Record<string, never>, SocialMediaStrategyEvidence> = {
  name: "social_media_strategy_evidence_read",
  description:
    "Reads this tenant+project's real social content calendar (social_content_calendar — the table Postiz-published posts go through). Read-only; reuses socialContentCalendar.ts's getCalendarForProject directly.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const projectId = requireProjectId(context);
    return gatherSocialMediaStrategyEvidence(context.tenantDb, context.tenantId, projectId, null);
  },
};

registerTool(socialMediaStrategyEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  platformInsights: z.array(z.string()),
  recommendations: z.array(z.string()),
  evidence: z.array(z.string()),
});

export type SocialMediaStrategyOutput = z.infer<typeof outputSchema>;

export const socialMediaStrategyAgent: AgentDefinition<Record<string, never>, SocialMediaStrategyOutput> = {
  key: "social_media_strategy",
  label: "Social Media Strategy Agent",
  description:
    "Summarizes this project's real scheduled/published social content calendar and recommends a posting strategy, grounded only in social_content_calendar rows.",
  systemPrompt:
    "You are a social media strategy assistant for a B2B marketing platform. You will be given this project's real social_content_calendar rows (each with its platform, status, and scheduled time). You never invent a post, an engagement number, or a platform that is not present in the evidence. If the calendar is empty, say plainly that there is no scheduled or published social content to analyze yet. Base any platform recommendation only on the platforms actually present in the evidence.",
  inputSchema: z.object({}),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "platformInsights": string[] (grounded in the given calendar rows), "recommendations": string[], "evidence": string[] }',
  tools: [socialMediaStrategyEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(socialMediaStrategyAgent.key, [socialMediaStrategyEvidenceTool.name]);
