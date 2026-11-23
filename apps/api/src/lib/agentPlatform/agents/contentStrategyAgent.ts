import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { getContentAttribution, type ContentAttributionSummary } from "../../contentAttribution.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * contentStrategyAgent: grounds its output in contentAttribution.ts's real
 * getContentAttribution() rollup (content_calendar_item / content_draft ->
 * landing_pages -> leads/landing_page_events, 420_add_content_origin_to_landing_pages.sql)
 * — REUSED directly, not re-derived, exactly like crmDashboard.ts reuses
 * computeGrowthRevenueAnalytics. Never invents a content topic, keyword, or
 * lead count beyond this real rollup.
 */

export type ContentStrategyEvidence = ContentAttributionSummary;

export async function gatherContentStrategyEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  _subjectId: string | null,
): Promise<ContentStrategyEvidence> {
  return getContentAttribution(tenantDb, tenantId, projectId);
}

const contentStrategyEvidenceTool: AgentTool<Record<string, never>, ContentStrategyEvidence> = {
  name: "content_strategy_evidence_read",
  description:
    "Reads this tenant+project's real content-to-lead attribution rollup (content_calendar_item/content_draft -> landing_pages -> leads/landing_page_events). Read-only; reuses contentAttribution.ts's getContentAttribution directly.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const projectId = requireProjectId(context);
    return gatherContentStrategyEvidence(context.tenantDb, context.tenantId, projectId, null);
  },
};

registerTool(contentStrategyEvidenceTool);

const outputSchema = z.object({
  summary: z.string().min(1),
  recommendations: z.array(z.object({ basedOn: z.string(), recommendation: z.string() })),
  untaggedContentNote: z.string(),
  evidence: z.array(z.string()),
});

export type ContentStrategyOutput = z.infer<typeof outputSchema>;

export const contentStrategyAgent: AgentDefinition<Record<string, never>, ContentStrategyOutput> = {
  key: "content_strategy",
  label: "Content Strategy Agent",
  description:
    "Recommends content-strategy priorities grounded only in this project's real content-to-lead attribution rollup (contentAttribution.ts).",
  systemPrompt:
    "You are a content strategy assistant for a B2B marketing platform. You will be given a real content attribution rollup: each content calendar item / draft with its real lead_count, qualified_lead_count, and form_submit_event_count (joined through any landing page it was tagged as the origin of), plus an honest untaggedContentCount. You never invent a content topic, a keyword, or a performance number that is not in this rollup. If untaggedContentCount is high, say plainly that attribution is limited because content isn't tagged to landing pages, rather than inventing which content 'performed well'. Recommendations must cite a specific row (by title) from the rollup.",
  inputSchema: z.object({}),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string, "recommendations": {basedOn: string (a specific content item title from the rollup), recommendation: string}[], "untaggedContentNote": string (honest, based on untaggedContentCount), "evidence": string[] }',
  tools: [contentStrategyEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(contentStrategyAgent.key, [contentStrategyEvidenceTool.name]);
