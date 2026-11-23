-- Up Migration
--
-- Milestone 4 (P3): minimal real data-capture for a usage-quota "overage"
-- concept that does NOT otherwise exist in this codebase yet (checked
-- lib/quota.ts and config/planLimits.ts before writing this — see
-- apps/api/src/lib/billingOverage.ts's header comment for the full
-- gap/decision writeup). This table deliberately does NOT carry a price
-- or an amount: pricing one extra unit of a resource past a plan's limit
-- is a real product/finance decision this change does not invent. It only
-- records the real observed fact ("tenant X was at/over its plan's limit
-- for resource Y, with these exact current/limit numbers, at this time"),
-- so a future, explicitly product-approved overage-billing pass has real
-- data to start from instead of needing to guess retroactively.
--
-- `billed`/`invoice_id` exist so that future pass can mark which overage
-- events it has already folded into a real billing_invoices row, without
-- this table needing a schema change when that logic lands.
CREATE TABLE billing_overage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  resource        text NOT NULL CHECK (resource IN ('projects', 'agentRunsPerDay', 'teamMembers', 'discoverySources')),
  plan            text NOT NULL CHECK (plan IN ('free', 'starter', 'growth', 'enterprise')),
  limit_at_time   integer NOT NULL,
  usage_at_time   integer NOT NULL,
  billed          boolean NOT NULL DEFAULT false,
  invoice_id      uuid REFERENCES billing_invoices (id) ON DELETE SET NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_overage_events_tenant_id ON billing_overage_events (tenant_id);
CREATE INDEX idx_billing_overage_events_unbilled ON billing_overage_events (tenant_id, billed) WHERE billed = false;

-- Down Migration

DROP TABLE IF EXISTS billing_overage_events;
