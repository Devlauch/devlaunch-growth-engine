-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql, applied to the two tables added in
-- 020_create_campaigns.sql and 021_create_campaign_members.sql.

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;

CREATE POLICY campaigns_isolation ON campaigns
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE campaign_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_members FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_members_isolation ON campaign_members
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS campaign_members_isolation ON campaign_members;
ALTER TABLE campaign_members NO FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_members DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaigns_isolation ON campaigns;
ALTER TABLE campaigns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns DISABLE ROW LEVEL SECURITY;
