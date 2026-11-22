/**
 * Shared agent contract used by the API (to enqueue/poll runs) and the
 * worker (to register and execute agents). Keeping this contract in its
 * own package means neither side depends on a specific agent runtime
 * (e.g. Mastra) — see AgentRegistry below and apps/worker/src/agents/registry.ts
 * for the Phase 1 stub-based implementation and the migration TODO.
 */

/** Static description of an agent: what it is, what it needs, what it returns. */
export interface AgentDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  requiredPermissions: string[];
  tools: string[];
}

/** A request to run a given agent for a given tenant/project. */
export interface AgentRunRequest {
  tenantId: string;
  projectId: string;
  agentId: string;
  input: unknown;
  idempotencyKey?: string;
}

/** The result of (or current status of) an agent run. */
export interface AgentRunResult<T = unknown> {
  executionId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "needs_approval";
  result?: T;
  error?: { code: string; message: string };
}

/**
 * A single piece of evidence an agent collected while researching
 * (e.g. a web page, a search result snippet). Used by research-style
 * agents such as `market-research`.
 */
export interface EvidenceItem {
  source: string;
  timestamp: string;
  confidence: number;
  summary?: string;
  url?: string;
}

/** Name of the BullMQ queue apps/api enqueues onto and apps/worker consumes. */
export const AGENT_RUN_QUEUE_NAME = "agent-runs";

/** Shape of the BullMQ job payload for an agent run (shared by api + worker). */
export interface AgentRunJobData {
  executionId: string;
  tenantId: string;
  projectId: string;
  agentId: string;
  input: unknown;
}

/**
 * Name of the BullMQ queue apps/api enqueues report-generation jobs onto
 * and apps/worker consumes (see apps/worker/src/reports/reportWorker.ts).
 * A separate queue from AGENT_RUN_QUEUE_NAME since report generation is not
 * an agent-registry executor — it's a direct, real SQL-query + PDF-render
 * job (see docs on generated_reports in packages/db/migrations).
 */
export const REPORT_GENERATION_QUEUE_NAME = "report-generation";

/** Shape of the BullMQ job payload for a report-generation run (shared by api + worker). */
export interface ReportGenerationJobData {
  reportId: string;
  tenantId: string;
  projectId: string;
  scheduleId?: string | null;
  periodStart: string;
  periodEnd: string;
  /**
   * Additive, optional (defaults to the pre-existing "client_summary"
   * behavior when omitted — every existing call site is unaffected).
   * "growth_audit" is DevLaunch's own internal-workspace public
   * growth-audit report (see apps/api/src/routes/publicGrowth.ts,
   * apps/worker/src/reports/growthAuditReportWorker.ts): the SAME queue
   * and worker process branches to a different, real-data render function
   * instead of the generic leads/campaigns client summary.
   */
  kind?: "client_summary" | "growth_audit";
  /** Only set when kind === "growth_audit": the real growth_analyses row to render. */
  growthAnalysisId?: string;
}
