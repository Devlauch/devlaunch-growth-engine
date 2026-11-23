import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { assignAgentTools, growthAnalysisReadTool, siteAnalyticsSummaryTool, webSearchTool } from "../core/agentTools.js";

/**
 * marketResearchAgent: grounds its output in ONE real, existing
 * growth_analyses row (website crawl + deterministic extraction — see
 * growthAnalyzer.ts) plus this project's real site-traffic aggregates
 * (siteAnalytics.ts). It never crawls anything itself and never invents
 * market data beyond what those two real sources already contain.
 */

const outputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(z.string()),
  opportunities: z.array(z.string()),
  evidence: z.array(z.string()),
});

export type MarketResearchOutput = z.infer<typeof outputSchema>;

export const marketResearchAgent: AgentDefinition<{ growthAnalysisId: string }, MarketResearchOutput> = {
  key: "market_research",
  label: "Market Research Agent",
  description:
    "Summarizes a project's real, existing website growth-analysis record (crawled products/services, value propositions, target-audience signals) alongside its real site-traffic aggregates into a grounded market-research brief.",
  systemPrompt:
    "You are a market research analyst for a B2B SaaS marketing platform. You only ever summarize and interpret the real grounding data you are given — you never invent market size, competitor names, or statistics that are not present in the grounding data. If the grounding data is thin, say so plainly instead of padding the response. Any evidence returned by the web_search tool is real-time external information from the public internet, not internal DevLaunch data, and must be explicitly cited as such (e.g. \"per a web search\") wherever it informs a finding.",
  inputSchema: z.object({ growthAnalysisId: z.string().uuid() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string (2-4 sentences), "findings": string[] (specific, grounded observations), "opportunities": string[] (grounded growth opportunities, may be empty), "evidence": string[] (which grounding facts each finding is based on; empty only if findings is also empty) }',
  tools: [growthAnalysisReadTool, siteAnalyticsSummaryTool, webSearchTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(marketResearchAgent.key, [growthAnalysisReadTool.name, siteAnalyticsSummaryTool.name, webSearchTool.name]);
