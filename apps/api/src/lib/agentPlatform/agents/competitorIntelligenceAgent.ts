import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { assignAgentTools, competitorSnapshotTool, webSearchTool } from "../core/agentTools.js";

/**
 * competitorIntelligenceAgent: grounds its output in ONE tracked
 * competitor's real, existing latest crawled snapshot + real detected
 * changes over the last 30 days (competitor_snapshots/competitor_changes,
 * populated by routes/competitors.ts's POST /:id/crawl — this agent never
 * crawls anything itself and never invents a competitor's pricing,
 * messaging, or roadmap beyond what was actually crawled).
 */

const outputSchema = z.object({
  summary: z.string().min(1),
  positioningSignals: z.array(z.string()),
  recentChanges: z.array(z.string()),
  evidence: z.array(z.string()),
});

export type CompetitorIntelligenceOutput = z.infer<typeof outputSchema>;

export const competitorIntelligenceAgent: AgentDefinition<{ competitorId: string }, CompetitorIntelligenceOutput> = {
  key: "competitor_intelligence",
  label: "Competitor Intelligence Agent",
  description:
    "Summarizes one tracked competitor's real, latest crawled snapshot and recently detected site changes into a grounded competitive-positioning brief.",
  systemPrompt:
    "You are a competitive intelligence analyst for a B2B SaaS marketing platform. You only ever summarize and interpret the real grounding data you are given about ONE named competitor — you never invent pricing, feature claims, or roadmap information that is not present in the grounding data. If no recent changes were detected, say so plainly instead of fabricating activity. Any evidence returned by the web_search tool is real-time external information from the public internet, not internal DevLaunch data, and must be explicitly cited as such (e.g. \"per a web search\") wherever it informs a finding.",
  inputSchema: z.object({ competitorId: z.string().uuid() }),
  outputSchema,
  outputFormatDescription:
    '{ "summary": string (2-4 sentences about this one competitor), "positioningSignals": string[] (grounded observations about their messaging/keywords), "recentChanges": string[] (plain-English restatements of real detected changes; empty if none), "evidence": string[] (which grounding facts each claim is based on) }',
  tools: [competitorSnapshotTool, webSearchTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(competitorIntelligenceAgent.key, [competitorSnapshotTool.name, webSearchTool.name]);
