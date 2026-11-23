import type { AgentDefinition } from "../core/agentRunner.js";
import { marketResearchAgent } from "./marketResearchAgent.js";
import { competitorIntelligenceAgent } from "./competitorIntelligenceAgent.js";
import { icpResearchAgent } from "./icpResearchAgent.js";
import { leadResearchAgent } from "./leadResearchAgent.js";
import { leadQualificationAgent } from "./leadQualificationAgent.js";
import { seoResearchAgent } from "./seoResearchAgent.js";
import { contentStrategyAgent } from "./contentStrategyAgent.js";
import { landingPageOptimizationAgent } from "./landingPageOptimizationAgent.js";
import { emailCampaignAgent } from "./emailCampaignAgent.js";
import { socialMediaStrategyAgent } from "./socialMediaStrategyAgent.js";
import { salesIntelligenceAgent } from "./salesIntelligenceAgent.js";
import { meetingPreparationAgent } from "./meetingPreparationAgent.js";
import { customerSuccessAgent } from "./customerSuccessAgent.js";
import { growthAdvisorLlmAgent } from "./growthAdvisorLlmAgent.js";

/**
 * The fixed registry of agent definitions this round ships
 * (routes/agentPlatform.ts's GET / and POST /:agentKey/run both resolve
 * against this map — never a dynamic/tenant-authored agent definition in
 * this round, same "fixed, code-reviewed set" convention as every other
 * rubric/template registry in this codebase, e.g. scoring_rubrics).
 *
 * Workstream A2 batch (10 agents below marketResearchAgent/
 * competitorIntelligenceAgent/icpResearchAgent/leadResearchAgent, which are
 * Workstream A1's own batch): leadQualificationAgent, seoResearchAgent,
 * contentStrategyAgent, landingPageOptimizationAgent, emailCampaignAgent,
 * socialMediaStrategyAgent, salesIntelligenceAgent, meetingPreparationAgent,
 * customerSuccessAgent, growthAdvisorLlmAgent.
 */
export const AGENT_DEFINITIONS: Record<string, AgentDefinition<any, any>> = {
  [marketResearchAgent.key]: marketResearchAgent,
  [competitorIntelligenceAgent.key]: competitorIntelligenceAgent,
  [icpResearchAgent.key]: icpResearchAgent,
  [leadResearchAgent.key]: leadResearchAgent,
  [leadQualificationAgent.key]: leadQualificationAgent,
  [seoResearchAgent.key]: seoResearchAgent,
  [contentStrategyAgent.key]: contentStrategyAgent,
  [landingPageOptimizationAgent.key]: landingPageOptimizationAgent,
  [emailCampaignAgent.key]: emailCampaignAgent,
  [socialMediaStrategyAgent.key]: socialMediaStrategyAgent,
  [salesIntelligenceAgent.key]: salesIntelligenceAgent,
  [meetingPreparationAgent.key]: meetingPreparationAgent,
  [customerSuccessAgent.key]: customerSuccessAgent,
  [growthAdvisorLlmAgent.key]: growthAdvisorLlmAgent,
};

export function listAgentDefinitions(): AgentDefinition<any, any>[] {
  return Object.values(AGENT_DEFINITIONS);
}

export function getAgentDefinition(agentKey: string): AgentDefinition<any, any> | undefined {
  return AGENT_DEFINITIONS[agentKey];
}

export {
  marketResearchAgent,
  competitorIntelligenceAgent,
  icpResearchAgent,
  leadResearchAgent,
  leadQualificationAgent,
  seoResearchAgent,
  contentStrategyAgent,
  landingPageOptimizationAgent,
  emailCampaignAgent,
  socialMediaStrategyAgent,
  salesIntelligenceAgent,
  meetingPreparationAgent,
  customerSuccessAgent,
  growthAdvisorLlmAgent,
};
