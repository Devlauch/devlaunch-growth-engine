-- Up Migration
--
-- Milestone 2 shared contract: every inbound webhook from an independent
-- integrated service (listmonk bounce/unsubscribe, chatwoot conversation
-- events, postiz post-status callbacks) lands here first, for idempotent,
-- auditable processing — one shared table instead of three near-identical
-- per-provider ones (see docs/INTEGRATION_STATUS.md's "Retry and
-- idempotency" contract).
--
-- tenant_id is denormalized from integrations.tenant_id (copied at insert
-- time) rather than joined at query time, matching the existing
-- landing_page_events/chatbot_messages convention in this codebase, so a
-- plain RLS policy on this table works without a subquery.
CREATE TABLE integration_webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  integration_id     uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('listmonk', 'chatwoot', 'postiz')),
  -- The provider's own event id if it sends one (used for de-dup); when a
  -- provider doesn't send a stable id, the caller must derive a stable one
  -- (e.g. a hash of the raw payload) rather than leaving this null, since
  -- null values aren't compared equal by the unique index below.
  external_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed', 'ignored')),
  error              text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  CONSTRAINT integration_webhook_events_dedup_key UNIQUE (integration_id, external_event_id)
);

CREATE INDEX idx_integration_webhook_events_tenant_id ON integration_webhook_events (tenant_id);
CREATE INDEX idx_integration_webhook_events_integration_id ON integration_webhook_events (integration_id);
CREATE INDEX idx_integration_webhook_events_status ON integration_webhook_events (status) WHERE status = 'pending';

-- Down Migration

DROP TABLE IF EXISTS integration_webhook_events;
