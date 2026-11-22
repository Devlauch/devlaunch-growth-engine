-- Up Migration
--
-- trial_signups: real trial/subscription lifecycle tracking for DevLaunch's
-- own internal acquisition workspace (see
-- 421_create_devlaunch_internal_workspace.sql). Status transitions are
-- real, staff-recorded events — see apps/api/src/routes/internalGrowth.ts's
-- PATCH .../trials/:id/status. There is no real payment/billing
-- integration anywhere in this codebase (confirmed: no Stripe/billing
-- client exists), so 'converted' is NEVER inferred from a payment webhook
-- here — it is always a manually-recorded real event by a real DevLaunch
-- staff member (converted_by/converted_at), honestly labeled as such in
-- the API response, never dressed up as if it came from a real billing
-- system.
CREATE TABLE trial_signups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id        uuid REFERENCES leads (id) ON DELETE SET NULL,
  company_name   text,
  contact_email  text NOT NULL,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('growth_audit', 'demo_request', 'manual')),
  status         text NOT NULL DEFAULT 'trial_started'
                   CHECK (status IN ('trial_started', 'trial_active', 'converted', 'churned')),
  notes          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  converted_at   timestamptz,
  converted_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  churned_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_trial_signups_set_updated_at
  BEFORE UPDATE ON trial_signups
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_trial_signups_tenant_id ON trial_signups (tenant_id);
CREATE INDEX idx_trial_signups_project_id ON trial_signups (project_id);
CREATE INDEX idx_trial_signups_tenant_status ON trial_signups (tenant_id, status);
CREATE INDEX idx_trial_signups_tenant_started_at ON trial_signups (tenant_id, started_at);

-- Down Migration

DROP TABLE IF EXISTS trial_signups;
