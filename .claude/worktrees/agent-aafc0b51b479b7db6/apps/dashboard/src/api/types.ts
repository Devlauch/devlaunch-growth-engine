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
  // Client onboarding + white-label branding (packages/db/migrations/
  // 210_add_branding_to_tenants.sql). `subdomain` is a plain requested
  // reference string only — no DNS/TLS/custom-domain is ever provisioned
  // for it anywhere in this codebase; see BrandingPage.tsx.
  goals?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
  subdomain?: string | null;
  status: string;
  role?: string;
}

// GET /tenants/:tenantId/onboarding-completeness — every `done` flag is a
// real computed boolean from actual row existence, never a fabricated
// percentage (see apps/api/src/routes/tenants.ts).
export interface OnboardingChecklistItem {
  key: string;
  label: string;
  done: boolean;
}

export interface OnboardingCompleteness {
  checklist: OnboardingChecklistItem[];
  completedCount: number;
  totalCount: number;
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
