-- Up Migration
--
-- Milestone 4 (P3): append-only idempotency ledger for inbound billing-
-- provider webhook deliveries, mirroring integration_webhook_events'
-- exact shared-landing-table contract (286_create_integration_webhook_events.sql)
-- rather than inventing a new shape — same "record first, process second,
-- ON CONFLICT DO NOTHING de-dupes a retried delivery" pattern as
-- routes/chatwootWebhooks.ts / routes/postizWebhooks.ts, applied to
-- routes/billingWebhooks.ts.
--
-- Not reusing integration_webhook_events itself: that table's
-- integration_id NOT NULL FK ties every row to an `integrations` row
-- (a per-tenant third-party connection), which billing is not — billing
-- is a platform-level provider relationship, not a tenant's own connected
-- integration (see config/env.ts's billing env vars' doc comment) — a
-- separate table keeps that distinction honest at the schema level
-- instead of forcing a fake integrations row to exist just to satisfy a
-- FK that doesn't semantically apply.
--
-- external_event_id: Stripe's own `event.id`; Razorpay's own
-- `x-razorpay-event-id` header value (documented explicitly as "unique per
-- event" for exactly this purpose — see razorpayBillingProvider.ts's doc
-- comment).
CREATE TABLE billing_webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
  external_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed', 'ignored')),
  error              text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  -- Provider event ids are globally unique (the provider's own id space,
  -- not scoped to a tenant) — the same de-dup key shape as
  -- integration_webhook_events' (integration_id, external_event_id), just
  -- keyed on provider instead of a per-tenant integration row.
  CONSTRAINT billing_webhook_events_dedup_key UNIQUE (provider, external_event_id)
);

CREATE INDEX idx_billing_webhook_events_tenant_id ON billing_webhook_events (tenant_id);
CREATE INDEX idx_billing_webhook_events_status ON billing_webhook_events (status) WHERE status = 'pending';

-- Down Migration

DROP TABLE IF EXISTS billing_webhook_events;
