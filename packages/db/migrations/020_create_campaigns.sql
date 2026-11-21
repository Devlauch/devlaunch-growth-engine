-- Up Migration

-- campaigns is a project-scoped outreach plan (e.g. "Q1 email nurture for
-- career switchers"). Tenant-owned, same shape as every other table here.
--
-- Status lifecycle (enforced at the API layer, not just this CHECK):
--   draft -> pending_approval -> approved | rejected
--   draft/approved/rejected -> archived
-- A campaign is only editable while 'draft' (see apps/api
-- src/routes/campaigns.ts). Reaching 'approved' means a human reviewed and
-- signed off on it via the existing approvals table/flow
-- (023_add_campaign_id_to_approvals.sql) — it does NOT mean anything was
-- actually sent/published: there is no outbound email/social provider wired
-- up yet in this phase, so "approved" just means "cleared to send, once
-- that integration exists." The dashboard must say so explicitly.
CREATE TABLE campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name                  text NOT NULL,
  channel               text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'social', 'content', 'event', 'other')),
  objective             text,
  audience_description  text,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'archived')),
  scheduled_at          timestamptz,
  created_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_campaigns_set_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_campaigns_tenant_id ON campaigns (tenant_id);
CREATE INDEX idx_campaigns_project_id ON campaigns (project_id);
CREATE INDEX idx_campaigns_tenant_status ON campaigns (tenant_id, status);
CREATE INDEX idx_campaigns_tenant_created_at ON campaigns (tenant_id, created_at);

-- Down Migration

DROP TABLE IF EXISTS campaigns;
