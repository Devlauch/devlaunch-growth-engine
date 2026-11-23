-- Up Migration
--
-- Milestone 2, Chatwoot agent: idempotency mapping between a Chatwoot
-- contact (account-scoped, app-layer-isolated id — see
-- docs/OPEN_SOURCE_INTEGRATION_AUDIT.md's "chatwoot" section on Chatwoot's
-- own `Account`/`account_id` isolation model) and the platform `leads` row
-- it was synced into (apps/api/src/lib/leadIngestion.ts's ingestLead()).
--
-- Without this table, every inbound AgentBot webhook event that carries
-- the same visitor's contact (contact_created, then conversation_created,
-- then one message_created per message they send) would call ingestLead()
-- again and create a duplicate `leads` row per event. This table makes
-- that sync upsert-safe: one chatwoot contact id -> at most one lead per
-- (tenant, project, chatwoot integration).
--
-- Does NOT reuse integration_webhook_events (286/287) — that table's job
-- is raw inbound-event dedup by `external_event_id`; this one tracks the
-- DOWNSTREAM business mapping (contact -> lead), a different key entirely,
-- and needs its own uniqueness constraint
-- (integration_id, chatwoot_contact_id).
CREATE TABLE chatwoot_contact_leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  integration_id      uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  chatwoot_contact_id text NOT NULL,
  lead_id             uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatwoot_contact_leads_dedup_key UNIQUE (integration_id, chatwoot_contact_id)
);

CREATE INDEX idx_chatwoot_contact_leads_tenant_id ON chatwoot_contact_leads (tenant_id);
CREATE INDEX idx_chatwoot_contact_leads_lead_id ON chatwoot_contact_leads (lead_id);

-- Down Migration

DROP TABLE IF EXISTS chatwoot_contact_leads;
