-- Up Migration
--
-- Milestone 4 (P3): real SaaS billing data model. One row per tenant's
-- real subscription as known to whichever billing provider (Razorpay or
-- Stripe — see apps/api/src/lib/billingProvider.ts) is actually handling
-- it. This is NOT a replacement for `tenants.plan` (migration
-- 220_add_plan_to_tenants.sql, the single source of truth the quota system
-- already reads) — it is the provider-facing record a webhook updates,
-- which in turn drives `tenants.plan` via applyPlanChange()
-- (apps/api/src/lib/billingPlanSync.ts). A tenant with no real billing
-- provider configured (every environment this codebase runs in today)
-- simply has zero rows here — the manual/admin PATCH .../plan path
-- (routes/planUsage.ts) keeps working exactly as before regardless.
--
-- One tenant may have at most one subscription per provider over time in
-- principle, but this is NOT constrained to one row per tenant: a
-- canceled subscription followed by a new one (replatforming from
-- Razorpay to Stripe, or resubscribing after a cancellation) is a new
-- row, not an overwrite — status history is preserved rather than
-- destroyed, mirroring this codebase's general preference for append/
-- insert over silent overwrite where history has real audit value (see
-- contact_provenance_events, migration 438, for the same philosophy
-- applied to a different domain). "Current" subscription for a tenant is
-- simply the most recent row by created_at that isn't canceled — no
-- separate `is_current` flag is needed for that query.
CREATE TABLE billing_subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider                  text NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
  provider_subscription_id  text NOT NULL,
  plan_id                   text NOT NULL CHECK (plan_id IN ('free', 'starter', 'growth', 'enterprise')),
  status                    text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  current_period_end        timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_subscriptions_provider_sub_key UNIQUE (provider, provider_subscription_id)
);

CREATE TRIGGER trg_billing_subscriptions_set_updated_at
  BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_billing_subscriptions_tenant_id ON billing_subscriptions (tenant_id);
CREATE INDEX idx_billing_subscriptions_tenant_created_at ON billing_subscriptions (tenant_id, created_at DESC);
CREATE INDEX idx_billing_subscriptions_status ON billing_subscriptions (status);

-- Down Migration

DROP TABLE IF EXISTS billing_subscriptions;
