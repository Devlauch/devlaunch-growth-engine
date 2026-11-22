import { AgentRegistry } from "@devlaunch/agent-sdk";
import { marketResearchDefinition, runMarketResearch } from "./marketResearch.js";
import { leadScoringDefinition, runLeadScoring } from "./leadScoring.js";
import { messageDraftingDefinition, runMessageDrafting } from "./messageDrafting.js";

// TODO(mastra-migration): once @mastra/core publishes a stable, non-alpha
// semver (current is 1.86.0-alpha.3 — see packages/agent-sdk/README.md for
// the full rationale for deferring it), add a `MastraAgentRuntime` class
// here that implements the same `execute(agentId, input) => output` shape
// as the hand-rolled executors below, backed by an actual Mastra agent
// graph. Swap individual agents over to it one at a time (starting with
// anything beyond market-research's complexity) without changing
// AgentDefinition / AgentRunRequest / AgentRunResult or the queue/executions
// model at all — this registry is the only place that needs to change.

export type AgentExecutor = (input: unknown) => Promise<unknown>;

/** Registry of AgentDefinitions this worker knows about. */
export const agentRegistry = new AgentRegistry();
agentRegistry.register(marketResearchDefinition);
agentRegistry.register(leadScoringDefinition);
agentRegistry.register(messageDraftingDefinition);

/** Maps an agent id -> the function that actually runs it. */
const executors: Record<string, AgentExecutor> = {
  "market-research": (input) => runMarketResearch(input),
  "lead-scoring": (input) => runLeadScoring(input),
  "message-drafting": (input) => runMessageDrafting(input),
};

export function getExecutor(agentId: string): AgentExecutor | undefined {
  return executors[agentId];
}
