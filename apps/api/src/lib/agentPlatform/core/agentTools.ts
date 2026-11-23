import type { PoolClient } from "pg";
import { z } from "zod";
import { getLeadActivityTimeline, type ActivityItem } from "../../activityTimeline.js";
import { computeSiteAnalytics, type SiteAnalytics } from "../../siteAnalytics.js";
import { computeIcpConversionPerformance, type IcpConversionPerformance } from "../../icpRefinement.js";

/**
 * agentTools.ts: Workstream A1, a minimal tool-calling abstraction for the
 * native agent platform (ideas borrowed from mastra's tool-definition shape
 * — name/description/inputSchema/execute — NOT its code; see this task's
 * handback for the license note. Mastra is Apache-2.0, so copying code
 * would in fact be permitted, but this is an independent implementation
 * anyway, sized to exactly what this milestone needs: no multi-step
 * tool-choice loop, no streaming, no parallel tool orchestration — every
 * tool attached to an AgentDefinition is simply run once, up front, against
 * the agent's own input, and its result is handed to the LLM as grounding
 * evidence (see agentRunner.ts's gatherToolEvidence()). That is a
 * deliberate scope limit, not an oversight.
 *
 * Every tool below is READ-ONLY and queries an EXISTING DevLaunch table —
 * nothing here writes anything. Every query is explicitly scoped by
 * tenant_id (and, where the table has one, project_id) in the SQL itself —
 * defense in depth on top of the RLS already enforced via
 * app.current_tenant_id on the request-scoped tenantDb client (same
 * "explicit WHERE clause as defense in depth" convention documented in
 * activityTimeline.ts's own header comment). No tool here ever accepts a
 * tenantId/projectId from its `input` — only from `context`, which the
 * caller (agentRunner.ts) builds from the authenticated request, so a
 * tenant can never point a tool at another tenant's data by crafting input.
 */

export interface AgentToolContext {
  tenantDb: PoolClient;
  tenantId: string;
  projectId: string | null;
  actorUserId: string | null;
}

export interface AgentTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: AgentToolContext): Promise<TOutput>;
}

function requireProjectId(context: AgentToolContext): string {
  if (!context.projectId) {
    throw new Error("This tool requires a projectId in the agent run context");
  }
  return context.projectId;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const toolRegistry = new Map<string, AgentTool>();
const agentToolAssignments = new Map<string, string[]>();

/** Registers a tool by name. Re-registering the same name overwrites it (useful for tests injecting a fake tool). */
export function registerTool(tool: AgentTool): void {
  toolRegistry.set(tool.name, tool);
}

/** Declares which registered tools (by name) an agent key uses. Called once per agent definition module (see agents/*.ts). */
export function assignAgentTools(agentKey: string, toolNames: string[]): void {
  agentToolAssignments.set(agentKey, toolNames);
}

/** Resolves an agent key's assigned tools into real AgentTool objects (silently skipping any name that isn't registered, rather than throwing — a missing tool should degrade the agent's grounding, not crash it). */
export function getToolsForAgent(agentKey: string): AgentTool[] {
  const names = agentToolAssignments.get(agentKey) ?? [];
  return names.map((name) => toolRegistry.get(name)).filter((tool): tool is AgentTool => Boolean(tool));
}

export function getTool(name: string): AgentTool | undefined {
  return toolRegistry.get(name);
}

// ---------------------------------------------------------------------------
// Real tools (read-only, tenant-scoped)
// ---------------------------------------------------------------------------

/** Reads a lead's real, existing activity timeline (reuses activityTimeline.ts's getLeadActivityTimeline directly — not reimplemented). */
export const leadActivityTimelineTool: AgentTool<{ leadId: string }, { items: ActivityItem[] }> = {
  name: "lead_activity_timeline",
  description:
    "Reads the real, existing activity timeline (assignments, deal stage changes, meetings, tasks, notes, replies, audit events) for one lead in this tenant+project. Read-only.",
  inputSchema: z.object({ leadId: z.string().uuid() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    const leadCheck = await context.tenantDb.query(`SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND project_id = $3`, [
      input.leadId,
      context.tenantId,
      projectId,
    ]);
    if (leadCheck.rowCount === 0) {
      throw new Error(`Lead ${input.leadId} not found in this tenant/project`);
    }
    const items = await getLeadActivityTimeline(context.tenantDb, context.tenantId, projectId, input.leadId);
    return { items };
  },
};

/** Reads real, existing site_analytics aggregates (reuses siteAnalytics.ts's computeSiteAnalytics directly). */
export const siteAnalyticsSummaryTool: AgentTool<{ sinceDays?: number }, SiteAnalytics> = {
  name: "site_analytics_summary",
  description:
    "Reads real, existing website-traffic aggregates (unique visitors, sessions, pageviews, bounce rate, top referrers/landing pages) for this tenant+project over a recent period. Read-only.",
  inputSchema: z.object({ sinceDays: z.number().int().min(1).max(3650).optional() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    return computeSiteAnalytics(context.tenantDb, context.tenantId, projectId, { sinceDays: input.sinceDays });
  },
};

interface CompetitorRow {
  id: string;
  name: string;
  domain: string;
}
interface CompetitorSnapshotRow {
  id: string;
  crawled_at: string;
  extracted_keywords: unknown;
}
interface CompetitorChangeRow {
  change_type: string;
  page_url: string;
  diff_summary: string;
  detected_at: string;
}

/** Reads the latest real competitor_snapshots row + last-30-days competitor_changes for one tracked competitor (same read-only query shapes as routes/competitors.ts's GET /:id/report). */
export const competitorSnapshotTool: AgentTool<
  { competitorId: string },
  { competitor: CompetitorRow; latestSnapshot: CompetitorSnapshotRow | null; recentChanges: CompetitorChangeRow[] }
> = {
  name: "competitor_snapshot_read",
  description:
    "Reads the latest real crawled snapshot and last-30-days detected changes for one tracked competitor in this tenant+project. Read-only.",
  inputSchema: z.object({ competitorId: z.string().uuid() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    const competitorResult = await context.tenantDb.query<CompetitorRow>(
      `SELECT id, name, domain FROM competitors WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [input.competitorId, context.tenantId, projectId],
    );
    if (competitorResult.rowCount === 0) {
      throw new Error(`Competitor ${input.competitorId} not found in this tenant/project`);
    }
    const [snapshotResult, changesResult] = await Promise.all([
      context.tenantDb.query<CompetitorSnapshotRow>(
        `SELECT id, crawled_at, extracted_keywords FROM competitor_snapshots
         WHERE competitor_id = $1 AND tenant_id = $2 ORDER BY crawled_at DESC LIMIT 1`,
        [input.competitorId, context.tenantId],
      ),
      context.tenantDb.query<CompetitorChangeRow>(
        `SELECT change_type, page_url, diff_summary, detected_at FROM competitor_changes
         WHERE competitor_id = $1 AND tenant_id = $2 AND detected_at >= now() - interval '30 days'
         ORDER BY detected_at DESC`,
        [input.competitorId, context.tenantId],
      ),
    ]);
    return {
      competitor: competitorResult.rows[0],
      latestSnapshot: snapshotResult.rows[0] ?? null,
      recentChanges: changesResult.rows,
    };
  },
};

interface GrowthAnalysisRow {
  domain: string;
  status: string;
  extracted_keywords: unknown;
  products_services: unknown;
  value_propositions: unknown;
  target_audience_signals: unknown;
  recommended_icp: unknown;
  growth_plan_summary: string;
}

/** Reads one real, existing growth_analyses row (crawled products/services, value props, target-audience signals, recommended ICP) — reuses the table growthAnalyzer.ts/routes/growthAnalyzer.ts already populate, never re-crawls. */
export const growthAnalysisReadTool: AgentTool<{ growthAnalysisId: string }, GrowthAnalysisRow> = {
  name: "growth_analysis_read",
  description:
    "Reads one real, existing website growth-analysis record (crawled products/services, value propositions, target-audience signals, recommended ICP) for this tenant+project. Read-only.",
  inputSchema: z.object({ growthAnalysisId: z.string().uuid() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    const result = await context.tenantDb.query<GrowthAnalysisRow>(
      `SELECT domain, status, extracted_keywords, products_services, value_propositions, target_audience_signals, recommended_icp, growth_plan_summary
       FROM growth_analyses WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
      [input.growthAnalysisId, context.tenantId, projectId],
    );
    if (result.rowCount === 0) {
      throw new Error(`Growth analysis ${input.growthAnalysisId} not found in this tenant/project`);
    }
    return result.rows[0];
  },
};

/** Reads real, computed-fresh ICP segment conversion performance (reuses icpRefinement.ts's computeIcpConversionPerformance directly). */
export const icpConversionPerformanceTool: AgentTool<{ icpProfileId?: string }, IcpConversionPerformance[]> = {
  name: "icp_conversion_performance",
  description:
    "Reads real, computed-fresh ICP segment conversion performance (matched leads, qualified leads, deals, won value) for this tenant+project, via the existing icp_match_scores/leads/deals join. Read-only.",
  inputSchema: z.object({ icpProfileId: z.string().uuid().optional() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    const all = await computeIcpConversionPerformance(context.tenantDb, context.tenantId, projectId);
    return input.icpProfileId ? all.filter((profile) => profile.icpProfileId === input.icpProfileId) : all;
  },
};

registerTool(leadActivityTimelineTool);
registerTool(siteAnalyticsSummaryTool);
registerTool(competitorSnapshotTool);
registerTool(growthAnalysisReadTool);
registerTool(icpConversionPerformanceTool);
