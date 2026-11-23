-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 029_enable_rls_discovery.sql / 283_enable_rls_sales_conversion.sql,
-- applied to the two tables added in 323_create_prospecting_campaigns.sql.

ALTER TABLE prospecting_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospecting_campaigns FORCE ROW LEVEL SECURITY;

CREATE POLICY prospecting_campaigns_isolation ON prospecting_campaigns
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE prospecting_campaign_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospecting_campaign_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY prospecting_campaign_sources_isolation ON prospecting_campaign_sources
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS prospecting_campaign_sources_isolation ON prospecting_campaign_sources;
ALTER TABLE prospecting_campaign_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE prospecting_campaign_sources DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prospecting_campaigns_isolation ON prospecting_campaigns;
ALTER TABLE prospecting_campaigns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE prospecting_campaigns DISABLE ROW LEVEL SECURITY;
