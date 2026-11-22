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

export type IntegrationProvider =
  | "twenty"
  | "mautic"
  | "postiz"
  | "listmonk"
  | "posthog"
  | "formbricks"
  | "chatwoot";
export type IntegrationStatus = "not_connected" | "pending_setup" | "connected" | "error";

// GET /tenants/:tenantId/projects/:projectId/integrations — a registry
// entry. Milestone 2: listmonk/chatwoot/postiz support a real per-tenant
// connection (encrypted credential + health-check); every other provider
// remains registry-only (see apps/api/src/routes/integrations.ts).
export interface IntegrationEntry {
  provider: IntegrationProvider;
  label: string;
  category: string;
  status: IntegrationStatus;
  scopes: string[];
  config: Record<string, unknown>;
  hasSecret: boolean;
  real: boolean;
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
// How a discovered_organizations/discovered_contacts row's data was
// obtained — see packages/db/migrations/268_add_prospect_discovery_fields.sql.
export type SourceConfidence = "verified" | "inferred" | "unconfirmed";

export interface DiscoveredContact {
  id: string;
  organization_id: string;
  name: string | null;
  role_title: string | null;
  email: string | null;
  phone: string | null;
  contact_channel: ContactChannel;
  verification_status: VerificationStatus;
  source_confidence: SourceConfidence;
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
  source_confidence: SourceConfidence;
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

// CRM module: first-class companies/contacts (packages/db/migrations
// 302_create_companies.sql / 307_create_contacts.sql), distinct from
// leads.company (free text) and leads themselves.
export interface Company {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size_range: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  tenant_id: string;
  project_id: string;
  company_id: string | null;
  lead_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// POST /tenants/:tenantId/projects/:projectId/integrations/:provider/connect
export interface IntegrationConnectResponse {
  integration: {
    id: string;
    provider: IntegrationProvider;
    status: IntegrationStatus;
    scopes: string[];
    config: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  };
  note: string;
}

// POST /tenants/:tenantId/projects/:projectId/integrations/:provider/health-check
// `status` is "integration_not_yet_implemented" when the real
// listmonk/chatwoot/postiz client doesn't exist yet in this environment —
// an honest "not built" response, never a fabricated success (see
// apps/api/src/routes/integrations.ts).
export interface IntegrationHealthCheckResponse {
  provider: IntegrationProvider;
  status: IntegrationStatus | "integration_not_yet_implemented";
  detail?: string;
  note?: string;
}

export type ProspectingCampaignStatus = "draft" | "running" | "paused" | "completed";

export interface ProspectingCampaign {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  goal: string | null;
  icp_profile_id: string | null;
  status: ProspectingCampaignStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProspectingCampaignSource {
  id: string;
  discovery_source_id: string;
  priority: number;
  name: string;
  connector_type: DiscoveryConnectorType;
  enabled: boolean;
}

export interface ProspectingCampaignResultsSummary {
  organizationsFound: number;
  contactsFound: number;
  leadsCreated: number;
  leadsQualified: number;
}

// Campaign-level discovery analytics — GET .../prospecting-campaigns/:id/analytics.
// A finer-grained breakdown than ProspectingCampaignResultsSummary's flat
// totals above: real status/verification-status distributions plus a
// lead_scores distribution for this campaign's promoted leads. Every number
// is a genuine SQL aggregate from apps/api/src/routes/prospectingCampaigns.ts.
export interface ProspectingCampaignAnalyticsStatusCount {
  status: string;
  count: number;
}

export interface ProspectingCampaignAnalyticsScoreBucket {
  bucket: string;
  count: number;
}

export interface ProspectingCampaignAnalytics {
  prospectingCampaign: ProspectingCampaign;
  organizations: {
    total: number;
    byStatus: ProspectingCampaignAnalyticsStatusCount[];
  };
  contacts: {
    total: number;
    byVerificationStatus: ProspectingCampaignAnalyticsStatusCount[];
  };
  leads: {
    promotedCount: number;
    scoredCount: number;
    averageScore: number | null;
    minScore: number | null;
    maxScore: number | null;
    scoreDistribution: ProspectingCampaignAnalyticsScoreBucket[];
  };
}

// DevLaunch's own internal customer-acquisition workspace (not a client
// tenant feature) — see apps/api/src/routes/publicGrowth.ts /
// internalGrowth.ts, packages/db/migrations 421-427.

export interface GrowthAuditRequest {
  id: string;
  domain: string;
  email: string;
  lead_id: string | null;
  growth_analysis_id: string | null;
  report_id: string | null;
  status: "completed" | "partial" | "failed";
  created_at: string;
  growth_plan_summary: string | null;
  report_status: string | null;
}

export interface DemoRequest {
  id: string;
  name: string;
  email: string;
  company: string | null;
  message: string | null;
  lead_id: string | null;
  created_at: string;
}

export type TrialSignupStatus = "trial_started" | "trial_active" | "converted" | "churned";

export interface TrialSignup {
  id: string;
  tenant_id: string;
  project_id: string;
  lead_id: string | null;
  company_name: string | null;
  contact_email: string;
  source: "growth_audit" | "demo_request" | "manual";
  status: TrialSignupStatus;
  notes: string | null;
  started_at: string;
  converted_at: string | null;
  converted_by: string | null;
  churned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcquisitionCost {
  id: string;
  tenant_id: string;
  project_id: string;
  channel: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CacResult {
  periodStart: string;
  periodEnd: string;
  totalCostCents: number;
  convertedCount: number;
  cacCents: number | null;
  reason: "insufficient_data" | null;
}

// AI Growth Advisor (apps/api/src/lib/growthAdvisor.ts /
// apps/api/src/routes/growthAdvisor.ts). Distinct from, and not to be
// confused with, GrowthAnalysis/its own `growth_recommendations` above —
// this is a different feature, backed by a separate
// `growth_advisor_recommendations` table (see
// packages/db/migrations/432_create_growth_advisor_recommendations.sql).
export type GrowthAdvisorRecommendationStatus = "new" | "acknowledged" | "dismissed" | "actioned";
export type GrowthAdvisorSeverity = "low" | "medium" | "high";

export interface GrowthAdvisorRecommendation {
  id: string;
  tenant_id: string;
  project_id: string;
  rule_key: string;
  severity: GrowthAdvisorSeverity;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  status: GrowthAdvisorRecommendationStatus;
  suggested_action: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface GrowthAdvisorAction {
  id: string;
  tenant_id: string;
  project_id: string;
  recommendation_id: string;
  action_type: "auto_assign_leads";
  payload: { leadIds: string[] };
  status: "pending_approval" | "approved" | "rejected";
  created_at: string;
}

export interface GrowthAdvisorPreparedApproval {
  id: string;
  growth_advisor_action_id: string;
  status: string;
  requested_by: string | null;
  requested_at: string;
}
