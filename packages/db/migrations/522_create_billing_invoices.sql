-- Up Migration
--
-- Milestone 4 (P3): real invoice records, populated ONLY from real
-- billing-provider webhook events (an `invoice.paid` from Stripe, or an
-- `invoice`/`payment` entity on a Razorpay `subscription.charged` event —
-- see routes/billingWebhooks.ts) — never synthesized. `subscription_id` is
-- nullable (a provider's invoice event can in principle arrive before this
-- platform has resolved/recorded the matching billing_subscriptions row;
-- recording the invoice anyway, unlinked, beats dropping a real payment
-- record on the floor) and is NOT a FK's sole join key for display
-- (provider_invoice_id is the real identity); the FK exists for the common
-- case where linkage is known.
CREATE TABLE billing_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subscription_id       uuid REFERENCES billing_subscriptions (id) ON DELETE SET NULL,
  provider              text NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
  provider_invoice_id   text NOT NULL,
  -- Smallest currency unit (paise/cents), matching how both providers
  -- report amounts (Stripe's amount_paid, Razorpay's amount_paid) — never
  -- a float, to avoid real-money rounding error.
  amount                bigint NOT NULL CHECK (amount >= 0),
  currency              text NOT NULL,
  status                text NOT NULL CHECK (status IN ('paid', 'open', 'failed', 'void')),
  issued_at             timestamptz NOT NULL,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_invoices_provider_invoice_key UNIQUE (provider, provider_invoice_id)
);

CREATE INDEX idx_billing_invoices_tenant_id ON billing_invoices (tenant_id);
CREATE INDEX idx_billing_invoices_tenant_issued_at ON billing_invoices (tenant_id, issued_at DESC);
CREATE INDEX idx_billing_invoices_subscription_id ON billing_invoices (subscription_id);

-- Down Migration

DROP TABLE IF EXISTS billing_invoices;
