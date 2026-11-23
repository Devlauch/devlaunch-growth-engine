import type { PoolClient } from "pg";
import { z } from "zod";
import { getLeadActivityTimeline, type ActivityItem } from "../../activityTimeline.js";
import { computeSiteAnalytics, type SiteAnalytics } from "../../siteAnalytics.js";
import { computeIcpConversionPerformance, type IcpConversionPerformance } from "../../icpRefinement.js";
import { getWebSearchProvider, type WebSearchResult } from "../../webSearchProvider.js";
import { getEmbeddingProvider } from "../../embeddingProvider.js";
import { getQdrantClient, type QdrantSearchResult } from "../../qdrantClient.js";

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

/**
 * Reads real, live external web-search results via the pluggable
 * webSearchProvider.ts (Tavily/Serper) — the one tool in this registry
 * that is NOT a read-only query against an internal DevLaunch table, since
 * its whole purpose is external research grounding (market/competitor/ICP
 * agents need real-time information this platform's own tables don't
 * have). Unlike every other tool here, a not-configured external provider
 * is an expected, common, non-error state (no real Tavily/Serper key
 * exists in most environments) — so this tool returns a
 * `{ status: "not_configured" }` result rather than throwing, letting the
 * calling agent's run continue and report that gap in its own evidence
 * rather than crashing the whole run.
 */
export const webSearchTool: AgentTool<
  { query: string; maxResults?: number },
  { status: "ok"; results: WebSearchResult[] } | { status: "not_configured"; results: WebSearchResult[] }
> = {
  name: "web_search",
  description:
    "Searches the live public web (via Tavily or Serper, whichever is configured) for real-time, outside-DevLaunch information. Returns { status: \"not_configured\", results: [] } if no web-search provider is configured in this environment — not an error.",
  inputSchema: z.object({ query: z.string().min(1).max(500), maxResults: z.number().int().min(1).max(10).optional() }),
  async execute(input) {
    const provider = getWebSearchProvider();
    if (!provider.isConfigured) {
      return { status: "not_configured" as const, results: [] };
    }
    return { status: "ok" as const, results: await provider.search(input.query, { maxResults: input.maxResults }) };
  },
};

/**
 * Semantic search over a Qdrant vector collection — new ground this round
 * (see qdrantClient.ts/embeddingProvider.ts). Requires BOTH a configured
 * embedding provider (to embed the query text) AND a configured Qdrant
 * instance (to search); if either is missing this tool returns
 * `{ status: "not_configured", results: [] }` rather than throwing — same
 * graceful, non-throwing "expected external-dependency-missing state"
 * convention as webSearchTool above, since no real OpenAI/Qdrant
 * credentials exist in most environments.
 *
 * CRITICAL: this tool calls `getQdrantClient().searchForTenant()`, NEVER
 * the raw unscoped `search()` (which qdrantClient.ts doesn't even export
 * for this purpose) — every result returned is filtered server-side to
 * `payload.tenant_id === context.tenantId`, the tenant-isolation boundary
 * for the vector store documented in qdrantClient.ts's header comment.
 *
 * DELIBERATE SCOPE LIMIT: this tool is registered below but NOT assigned to
 * any agent via assignAgentTools() — there is no real indexed content in
 * any Qdrant collection yet (no ingestion/indexing pipeline exists in this
 * round), so attaching it to an agent now would let that agent call a tool
 * that can only ever return either "not_configured" or an empty/irrelevant
 * result set. A future round should build the indexing pipeline for a
 * specific collection first, then assign this tool to the agent(s) that
 * collection is meant to ground.
 */
export const semanticSearchTool: AgentTool<
  { query: string; collection: string; limit?: number },
  { status: "ok"; results: QdrantSearchResult[] } | { status: "not_configured"; results: QdrantSearchResult[] }
> = {
  name: "semantic_search",
  description:
    "Performs tenant-scoped semantic (vector) search over a named Qdrant collection. Returns { status: \"not_configured\", results: [] } if no embedding provider or Qdrant instance is configured in this environment — not an error.",
  inputSchema: z.object({
    query: z.string().min(1).max(2000),
    collection: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async execute(input, context) {
    const embeddingProvider = getEmbeddingProvider();
    const qdrant = getQdrantClient();
    if (!embeddingProvider.isConfigured || !qdrant.isConfigured) {
      return { status: "not_configured" as const, results: [] };
    }
    const [vector] = await embeddingProvider.embed([input.query]);
    const results = await qdrant.searchForTenant(input.collection, context.tenantId, vector, { limit: input.limit });
    return { status: "ok" as const, results };
  },
};

registerTool(leadActivityTimelineTool);
registerTool(siteAnalyticsSummaryTool);
registerTool(competitorSnapshotTool);
registerTool(growthAnalysisReadTool);
registerTool(icpConversionPerformanceTool);
registerTool(webSearchTool);
registerTool(semanticSearchTool);
// NOTE: semanticSearchTool is registered but deliberately NOT assigned to
// any agent (see its own doc comment above) — this is a scope limit, not an
// oversight.
