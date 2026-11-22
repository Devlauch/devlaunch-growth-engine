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

export type LeadSource = "internal" | "public_widget" | "agent" | "import" | "discovery";

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

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link_url: string | null;
  read_at: string | null;
  created_at: string;
}

// GET /tenants/:tenantId/audit-events
export interface AuditEvent {
  id: string;
  actor_type: "user" | "agent" | "system";
  actor_user_id: string | null;
  actor_agent_instance_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
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

export type UsageEventType = "agent_run" | "api_request" | "lead_captured" | "ai_tokens";

export interface UsageSummaryEntry {
  count: number;
  quantity: number;
}

export interface UsagePerDay {
  day: string;
  eventType: UsageEventType;
  quantity: number;
}

// GET /tenants/:tenantId/usage/overview — every field is a real SQL
// aggregate over usage_events (packages/db migrations 230/231), never
// estimated. ai_tokens is honestly empty today: no agent executor in this
// codebase reports a real token count yet (see apps/api/src/routes/usage.ts's
// doc comment) — it is never backfilled with a guessed number.
export interface UsageOverview {
  summary: Record<UsageEventType, UsageSummaryEntry>;
  perDay: UsagePerDay[];
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

// Lead discovery: see apps/api/src/routes/discovery.ts. Only
// connector_type 'public_directory' (OpenStreetMap via the free Overpass
// API — no API key, no crawling) is approved to actually run today; the
// other connector_type values exist in the DB's CHECK constraint for a
// future phase but the API rejects creating a source with them.
export type DiscoveryConnectorType = "public_directory" | "website_crawl" | "csv_upload" | "licensed_api";

export interface DiscoverySource {
  id: string;
  tenant_id: string;
  project_id: string;
  connector_type: DiscoveryConnectorType;
  name: string;
  enabled: boolean;
  rate_limit_per_minute: number;
  terms_note: string | null;
  config: { industry?: string; geography?: string; limit?: number } & Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type ContactChannel = "role_based" | "named_person" | "contact_form" | "phone";
export type VerificationStatus = "verified" | "unverified" | "role_based" | "risky" | "invalid";

export interface DiscoveredContact {
  id: string;
  organization_id: string;
  name: string | null;
  role_title: string | null;
  email: string | null;
  phone: string | null;
  contact_channel: ContactChannel;
  verification_status: VerificationStatus;
  created_at: string;
}

export type DiscoveredOrganizationStatus = "new" | "researched" | "duplicate" | "archived";

export interface DiscoveredOrganization {
  id: string;
  tenant_id: string;
  project_id: string;
  discovery_source_id: string | null;
  name: string;
  domain: string | null;
  source_url: string;
  discovered_at: string;
  status: DiscoveredOrganizationStatus;
  contacts: DiscoveredContact[];
}

export interface DiscoveryRunResult {
  organizationsFound: number;
  organizationsCreated: number;
  organizationsDuplicate: number;
  contactsCreated: number;
  contactsDuplicate: number;
  organizations: DiscoveredOrganization[];
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

export type PlanName = "free" | "starter" | "growth" | "enterprise";

export interface PlanLimits {
  maxProjects: number | null;
  maxAgentRunsPerDay: number | null;
  maxTeamMembers: number | null;
  maxDiscoverySources: number | null;
}

export type QuotaResource = "projects" | "agentRunsPerDay" | "teamMembers" | "discoverySources";

export interface QuotaUsageEntry {
  current: number;
  limit: number | null;
}

export interface PlanUsageResponse {
  plan: PlanName;
  limits: PlanLimits;
  usage: Record<QuotaResource, QuotaUsageEntry>;
}

export type ReportStatus = "queued" | "running" | "succeeded" | "failed";

export interface GeneratedReport {
  id: string;
  schedule_id: string | null;
  status: ReportStatus;
  period_start: string;
  period_end: string;
  file_bytes: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface GenerateReportResult {
  reportId: string;
  status: ReportStatus;
}

// GET/POST/PATCH .../report-schedules. recipients is stored only — this
// environment has no real SMTP/email-provider configured, so nothing is
// ever actually emailed; a due+enabled schedule just produces a real,
// downloadable generated_reports row (see apps/worker/src/reports/scheduleLoop.ts).
export type ReportFrequency = "weekly" | "monthly";

export interface ReportSchedule {
  id: string;
  tenant_id: string;
  project_id: string;
  frequency: ReportFrequency;
  recipients: string[];
  enabled: boolean;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
}
