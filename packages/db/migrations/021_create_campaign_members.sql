-- Up Migration

-- campaign_members links a real leads row (see 015_create_leads.sql) to a
-- campaign — "this lead is part of this outreach plan". Tenant-owned, same
-- as every other table here. Never implies anything was actually sent to
-- the lead: status only tracks whether the lead is currently attached to
-- the campaign (there is no send/outreach pipeline yet — see
-- 020_create_campaigns.sql's comment).
CREATE TABLE campaign_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  added_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_members_campaign_lead_key UNIQUE (campaign_id, lead_id)
);

CREATE TRIGGER trg_campaign_members_set_updated_at
  BEFORE UPDATE ON campaign_members
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_campaign_members_tenant_id ON campaign_members (tenant_id);
CREATE INDEX idx_campaign_members_campaign_id ON campaign_members (campaign_id);
CREATE INDEX idx_campaign_members_lead_id ON campaign_members (lead_id);

-- Down Migration

DROP TABLE IF EXISTS campaign_members;
