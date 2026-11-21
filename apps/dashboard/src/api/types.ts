// Shapes mirror exactly what apps/api returns — never widened/guessed
// beyond what a route handler actually sends, so the UI never fabricates
// fields that aren't really there.

export interface User {
  id: string;
  email: string;
  fullName: string | null;
  status: string;
}

export interface Membership {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: string;
  status: string;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  industry: string | null;
  status: string;
  role?: string;
}

export interface Project {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  public_api_key?: string;
  allowed_origins?: string[];
  public_widget_enabled?: boolean;
  created_at: string;
  updated_at?: string;
}

export interface AgentTemplate {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  version: number;
  default_config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
}

export interface AgentInstance {
  id: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
  schedule: string | null;
  last_run_at: string | null;
  created_at: string;
  agent_key: string;
  agent_version: number;
}

export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "needs_approval";

export interface AgentRunResult {
  executionId: string;
  status: ExecutionStatus;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ExecutionDetail {
  executionId: string;
  status: ExecutionStatus;
  result?: unknown;
  error?: { code: string; message: string };
  agentInstanceId: string;
  trigger: string;
  input: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

// GET /tenants/:tenantId/projects/:projectId/agent-executions — list shape
// (distinct from ExecutionDetail, which is the single-execution GET).
export interface AgentExecutionSummary {
  id: string;
  status: ExecutionStatus;
  trigger: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  agent_instance_id: string;
  agent_instance_name: string;
}

export type LeadSource = "internal" | "public_widget" | "agent" | "import";

export interface Lead {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  message: string | null;
  source: LeadSource;
  status: string;
  created_at: string;
}

export type CampaignChannel = "email" | "social" | "content" | "event" | "other";
export type CampaignStatus = "draft" | "pending_approval" | "approved" | "rejected" | "archived";

export interface Campaign {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  channel: CampaignChannel;
  objective: string | null;
  audience_description: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignMember {
  id: string;
  status: string;
  created_at: string;
  lead_id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  source: LeadSource;
}

export interface StatusCount {
  status: string;
  count: number;
}

export interface LeadsPerDay {
  day: string;
  count: number;
}

// GET /tenants/:tenantId/projects/:projectId/analytics/overview — every
// field here is a real SQL aggregate, never an estimated/fabricated value.
export interface AnalyticsOverview {
  leads: {
    total: number;
    byStatus: StatusCount[];
    perDay: LeadsPerDay[];
  };
  campaigns: {
    byStatus: StatusCount[];
  };
  agentExecutions: {
    byStatus: StatusCount[];
  };
}

export type IntegrationProvider = "twenty" | "mautic" | "postiz" | "listmonk" | "posthog" | "formbricks";
export type IntegrationStatus = "not_connected" | "pending_setup" | "connected" | "error";

// GET /tenants/:tenantId/projects/:projectId/integrations — a registry
// entry, never a working live connection in this phase (see
// apps/api/src/routes/integrations.ts).
export interface IntegrationEntry {
  provider: IntegrationProvider;
  label: string;
  category: string;
  status: IntegrationStatus;
  scopes: string[];
  updatedAt: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  status: ApprovalStatus;
  requested_by: string | null;
  reviewed_by: string | null;
  reason: string | null;
  decision_notes: string | null;
  requested_at: string;
  reviewed_at: string | null;
}
