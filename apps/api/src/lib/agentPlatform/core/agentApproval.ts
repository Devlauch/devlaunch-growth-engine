import type { AgentDefinition } from "./agentRunner.js";

/**
 * agentApproval.ts: Workstream A1, thin interface only — this round's four
 * agents (marketResearchAgent/competitorIntelligenceAgent/icpResearchAgent/
 * leadResearchAgent) are pure research/intelligence: they read existing
 * tenant data and return a structured summary, they never take an
 * external-facing action (no email sent, no sequence enrolled, no deal
 * stage changed), so none of them need a human-in-the-loop approval step.
 *
 * This file exists so a FUTURE agent definition whose output represents an
 * external-facing action (e.g. "send this drafted email", "enroll this lead
 * in a sequence") has a real, already-wired place to declare that via
 * `requiresApproval: true` on its AgentDefinition — routes/agentPlatform.ts
 * and any future action-executing caller should gate on requiresApproval()
 * before executing such an agent's output, the same way
 * routes/approvals.ts already gates other sensitive actions in this
 * codebase. Not reusing approvals.ts's own approval_requests table here:
 * that would mean inventing a write path for a capability with zero real
 * callers this round — left for whichever follow-up round adds the first
 * action-taking agent.
 */
export function requiresApproval(definition: Pick<AgentDefinition, "requiresApproval">): boolean {
  return definition.requiresApproval ?? false;
}
