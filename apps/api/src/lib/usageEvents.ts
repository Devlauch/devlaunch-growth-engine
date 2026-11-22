import type { PoolClient } from "pg";

export type UsageEventType =
  | "agent_run"
  | "api_request"
  | "lead_captured"
  | "ai_tokens"
  | "hunter_api_request"
  | "hunter_discovery"
  | "hunter_verification"
  | "hunter_request_failed"
  // Added by packages/db/migrations/446_add_google_search_call_to_usage_event_types.sql
  // (Phase 2 reconciliation, Agent A2) — one row per real outbound call to
  // Google's Custom Search JSON API, success or failure. Apollo has no
  // equivalent usage_events type yet — see
  // docs/PHASE_2_CREDENTIAL_AND_COST_REPORT.md for why that gap is
  // documented rather than filled with an invented type.
  | "google_search_call";

export interface RecordUsageEventParams {
  client: PoolClient;
  tenantId: string;
  projectId?: string | null;
  eventType: UsageEventType;
  /** Defaults to 1 (a simple per-event count). For ai_tokens, this must be
   *  a REAL token count from the agent executor — never fabricated. */
  quantity?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Single write path for usage_events (packages/db migrations 230/231) —
 * every real usage signal (agent runs queued, leads captured, API request
 * volume batches, and AI token counts WHEN a real count exists) goes
 * through this one function, so GET .../usage/overview
 * (src/routes/usage.ts) only ever reflects real, already-committed
 * events. Never call this with an estimated/fabricated quantity — if a
 * real number isn't available (e.g. no token count reported by an agent
 * executor), skip the call entirely rather than invent one.
 *
 * `client` must already be inside the caller's tenant-scoped transaction
 * (req.tenantDb from requireTenantMembership, or an equivalent
 * app.current_tenant_id-scoped client such as
 * apps/api/src/db/pool.ts's withTenantContext), exactly like any other
 * tenant-scoped write, so usage_events_isolation RLS
 * (231_enable_rls_usage_events.sql) applies.
 */
export async function recordUsageEvent(params: RecordUsageEventParams): Promise<void> {
  const { client, tenantId, projectId, eventType, quantity = 1, metadata = {} } = params;
  await client.query(
    `INSERT INTO usage_events (tenant_id, project_id, event_type, quantity, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tenantId, projectId ?? null, eventType, quantity, JSON.stringify(metadata)],
  );
}
