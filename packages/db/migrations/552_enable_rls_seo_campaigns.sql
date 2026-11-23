-- Up Migration
--
-- Same tenant-isolation pattern as 079_enable_rls_seo.sql, applied to the
-- new seo_campaigns table (551_create_seo_campaigns.sql).

ALTER TABLE seo_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_campaigns FORCE ROW LEVEL SECURITY;

CREATE POLICY seo_campaigns_isolation ON seo_campaigns
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS seo_campaigns_isolation ON seo_campaigns;
ALTER TABLE seo_campaigns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE seo_campaigns DISABLE ROW LEVEL SECURITY;
