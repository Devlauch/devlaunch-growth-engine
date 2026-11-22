import { z } from "zod";
import type { AgentDefinition, EvidenceItem } from "@devlaunch/agent-sdk";
import type { ResearchAdapter } from "./researchAdapter.js";
import { MockResearchAdapter } from "./researchAdapter.js";

export const marketResearchInputSchema = z.object({
  industry: z.string().min(1).max(200),
  geography: z.string().min(1).max(200),
  segment: z.string().min(1).max(200),
  question: z.string().min(1).max(2000),
});
export type MarketResearchInput = z.infer<typeof marketResearchInputSchema>;

const evidenceItemSchema = z.object({
  source: z.string(),
  timestamp: z.string(),
  confidence: z.number().min(0).max(1),
  summary: z.string().optional(),
  url: z.string().optional(),
});

export const marketResearchOutputSchema = z.object({
  industry: z.string(),
  geography: z.string(),
  segment: z.string(),
  question: z.string(),
  answer: z.string(),
  evidence: z.array(evidenceItemSchema),
  generatedAt: z.string(),
  mock: z.literal(true),
});
export type MarketResearchOutput = z.infer<typeof marketResearchOutputSchema>;

/**
 * AgentDefinition for `market-research` v1.
 *
 * Phase 1: a hand-rolled stub behind packages/agent-sdk's AgentDefinition /
 * AgentRunRequest / AgentRunResult contract — NOT a live @mastra/core agent
 * (see packages/agent-sdk/README.md for why) and NOT Crawl4AI-backed (see
 * ./researchAdapter.ts) — both deferred to a later phase. The output below
 * is always schema-valid but explicitly marked `mock: true`.
 */
export const marketResearchDefinition: AgentDefinition = {
  id: "market-research",
  version: "1",
  name: "Market Research (stub)",
  description:
    "Phase 1 demo agent. Given an industry/geography/segment/question, returns a mocked-but-schema-valid structured research result. " +
    "Real Crawl4AI-backed research is later-phase work (see ResearchAdapter).",
  inputSchema: marketResearchInputSchema,
  outputSchema: marketResearchOutputSchema,
  requiredPermissions: ["agent:market-research:run"],
  tools: [],
};

export async function runMarketResearch(
  rawInput: unknown,
  adapter: ResearchAdapter = new MockResearchAdapter(),
): Promise<MarketResearchOutput> {
  const input = marketResearchInputSchema.parse(rawInput);
  const evidence: EvidenceItem[] = await adapter.research(input);

  const output: MarketResearchOutput = {
    industry: input.industry,
    geography: input.geography,
    segment: input.segment,
    question: input.question,
    answer:
      `(MOCK RESULT — Phase 1 stub, no live web research performed) ` +
      `Based on ${evidence.length} mock fixture source(s), here is a placeholder answer to ` +
      `"${input.question}" for the "${input.segment}" segment in the ${input.industry} industry (${input.geography}). ` +
      `Replace this agent's adapter with Crawl4AIResearchAdapter in a later phase for real research.`,
    evidence,
    generatedAt: new Date().toISOString(),
    mock: true,
  };

  // Defensive: validate our own output against outputSchema before
  // returning, so a bug here fails loudly instead of persisting
  // schema-invalid data into agent_executions.output.
  return marketResearchOutputSchema.parse(output);
}
