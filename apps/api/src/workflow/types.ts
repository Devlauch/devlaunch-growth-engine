import type { PoolClient } from "pg";

/**
 * Phase 4 orchestration: the shared contract every pipeline stage executor
 * builds against. This file is intentionally the single most stable file
 * in apps/api/src/workflow/ — multiple stage implementations (research,
 * lead generation, content/campaign, approval+compliance gate,
 * analytics/learning) are built independently against these exact shapes,
 * so nothing here should change once a stage depends on it.
 *
 * Mounted route: /api/v1/tenants/:tenantId/projects/:projectId/workflows
 * (see apps/api/src/routes/workflows.ts). The generic engine that drives
 * stages one at a time lives in apps/api/src/workflow/engine.ts; the
 * registry mapping a stage name to its executor lives in
 * apps/api/src/workflow/stageRegistry.ts.
 */

export const WORKFLOW_STAGES = [
  "client_onboarding",
  "research",
  "lead_generation",
  "content_campaign",
  "approval_compliance_gate",
  "campaign_execution",
  "analytics_learning",
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export interface StageInput {
  tenantId: string;
  projectId: string;
  workflowRunId: string;
  tenantDb: PoolClient; // already inside the tenant-scoped transaction opened by requireTenantMembership
  priorStageResults: Record<string, { data: Record<string, unknown>; summary: string }>; // keyed by stage name
  inputConfig: Record<string, unknown>; // the workflow_run's original input_config
}

export interface StageResult {
  stage: WorkflowStage;
  status: "completed" | "failed" | "needs_approval";
  summary: string; // short, real, human-readable — references actual numbers/names, never generic filler
  data: Record<string, unknown>; // real structured output for later stages / the final report to read
  approvalContext?: { entityType: string; entityIds: string[] }; // required when status is "needs_approval"
}

export type StageExecutor = (input: StageInput) => Promise<StageResult>;
