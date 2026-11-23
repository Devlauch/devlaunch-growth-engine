-- Up Migration
--
-- Same tenant-isolation pattern as 552_enable_rls_seo_campaigns.sql /
-- 079_enable_rls_seo.sql, applied to the new
-- website_intelligence_snapshots table (640_create_website_intelligence_snapshots.sql).

ALTER TABLE website_intelligence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_intelligence_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY website_intelligence_snapshots_isolation ON website_intelligence_snapshots
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS website_intelligence_snapshots_isolation ON website_intelligence_snapshots;
ALTER TABLE website_intelligence_snapshots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE website_intelligence_snapshots DISABLE ROW LEVEL SECURITY;
