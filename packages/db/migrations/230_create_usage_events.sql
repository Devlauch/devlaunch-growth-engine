-- Up Migration
--
-- usage_events: real, append-only usage tracking across four event types:
--   - agent_run      : one row per agent run queued (quantity = 1).
--   - api_request    : API request volume, written as periodic batched
--                      counts (quantity = number of requests in that
--                      flush window) rather than one row per request —
--                      see apps/api/src/lib/usageTracking.ts for why.
--   - lead_captured  : one row per real lead ingested through
--                      apps/api/src/lib/leadIngestion.ts (internal AND
--                      public-widget leads both go through that one path).
--   - ai_tokens      : reserved for real LLM token counts, when an agent
--                      executor actually reports one. Nothing in this
--                      codebase (apps/worker/src/agents/*) does yet —
--                      market-research is a Phase 1 mock stub with no live
--                      LLM call — so no code path writes this event_type
--                      today. Never backfill/estimate it; leave it
--                      genuinely empty until a real token count exists.
--
-- project_id is nullable because api_request volume (and some agent_run /
-- lead_captured call sites) is naturally tenant-level, not always tied to
-- one project.
--
-- quantity is numeric (not integer) so an ai_tokens row can hold a real
-- token count in the thousands+ range, while still defaulting to 1 for a
-- simple per-event count (agent_run, lead_captured, or one flushed
-- api_request batch's count).
CREATE TABLE usage_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('agent_run', 'api_request', 'lead_captured', 'ai_tokens')),
  quantity   numeric NOT NULL DEFAULT 1,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_events_tenant_id ON usage_events (tenant_id);
CREATE INDEX idx_usage_events_project_id ON usage_events (project_id);
-- Primary aggregation index for GET .../usage/overview (grouped by
-- event_type, filtered to the last 30 days, per tenant).
CREATE INDEX idx_usage_events_tenant_type_created ON usage_events (tenant_id, event_type, created_at);

-- Down Migration

DROP TABLE IF EXISTS usage_events;
