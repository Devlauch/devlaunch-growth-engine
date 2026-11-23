import type { PoolClient } from "pg";
import type { AgentToolContext } from "../core/agentTools.js";

/**
 * Shared helpers for agentPlatform/agents/* (Workstream A2 batch of 10).
 *
 * Every gatherXEvidence() function in this batch takes the same
 * (tenantDb, tenantId, projectId, subjectId) shape and is READ-ONLY against
 * real, existing tables/views/computations already used elsewhere in this
 * codebase (reused directly — e.g. computeDealHealthForDeal,
 * buildMeetingPrepBrief, runGrowthAdvisor's own table, getCampaignAttribution,
 * getCalendarForProject, getContentAttribution, computeCrmDashboard,
 * computeRevenueIntelligence — rather than re-deriving a second,
 * possibly-divergent copy of the same math). Each agent's AgentTool.execute
 * is a thin wrapper around its module's gatherXEvidence() — this keeps the
 * same function independently unit-testable (apps/api/test/agentPlatformAgents.test.ts)
 * without needing a real AgentToolContext/PoolClient.
 */

/**
 * Most reused grounding functions in this codebase (getContentAttribution,
 * getCampaignAttribution, getCalendarForProject, computeCrmDashboard,
 * computeRevenueIntelligence, computeFunnelDropoff) are typed against the
 * real `pg` PoolClient directly, not a narrowed pick — so gatherXEvidence()
 * functions that delegate to them take a real PoolClient too, for a
 * straight pass-through with no cast at the call site. Tests construct a
 * minimal `{ query: vi.fn() }` mock and cast it `as unknown as PoolClient`
 * (same pattern used throughout this codebase's own test suite for a fake
 * pg pool/client).
 */
export type QueryableDb = PoolClient;

/** Same "projectId is required for this tool" guard as agentTools.ts's private requireProjectId. */
export function requireProjectId(context: AgentToolContext): string {
  if (!context.projectId) {
    throw new Error("This tool requires a projectId in the agent run context");
  }
  return context.projectId;
}
