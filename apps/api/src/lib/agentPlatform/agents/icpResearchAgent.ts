import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { assignAgentTools, icpConversionPerformanceTool, webSearchTool } from "../core/agentTools.js";

/**
 * icpResearchAgent: grounds its output in real, computed-fresh ICP segment
 * conversion performance (icpRefinement.ts's computeIcpConversionPerformance
 * — matched leads, qualified leads, deals, won value, all real COUNT/SUM
 * queries over icp_match_scores/leads/deals, never estimated). This agent
 * never invents a persona's firmographics or pain points beyond what
 * icp_profiles already records and the real conversion numbers computed
 * from it.
 */

const outputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(z.string()),
  recommendations: z.array(z.string()),
  evidence: z.array(z.string()),
});

export type IcpResearchOutput = z.infer<typeof outputSchema>;

export const icpResearchAgent: AgentDefinition<{ icpProfileId?: string }, IcpResearchOutput> = {
  key: "icp_research",
  label: "ICP Research Agent",
  description:
    "Summarizes real, computed ICP segment conversion performance (matched/qualified leads, deals, won value) into a grounded ICP-refinement brief, optionally scoped to one profile.",
  systemPrompt:
    "You are an ICP (Ideal Customer Profile) research analyst for a B2B SaaS marketing platform. You only ever summarize and interpret the real conversion-performance grounding data you are given — you never invent a persona's firmographics, pain points, or conversion rates that are not present in the grounding data. A profile with zero matched leads should be reported as having insufficient data, never a fabricated rate. Any evidence returned by the web_search tool is real-time external information from the public internet, not internal DevLaunch data, and must be explicitly cited as such (e.g. \"per a web search\") wherever it informs a finding.",
  inputSchema: z.object({ icpProfileId: z.string().uuid().optional() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string (2-4 sentences), "findings": string[] (grounded observations per ICP segment), "recommendations": string[] (grounded re-prioritization suggestions, may be empty when data is too thin), "evidence": string[] (which grounding facts each finding is based on) }',
  tools: [icpConversionPerformanceTool, webSearchTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(icpResearchAgent.key, [icpConversionPerformanceTool.name, webSearchTool.name]);
