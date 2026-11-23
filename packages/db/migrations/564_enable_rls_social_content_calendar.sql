-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 320_enable_rls_postiz_tables.sql, 552_enable_rls_seo_campaigns.sql),
-- applied to 563_create_social_content_calendar.sql.
ALTER TABLE social_content_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_content_calendar FORCE ROW LEVEL SECURITY;

CREATE POLICY social_content_calendar_isolation ON social_content_calendar
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS social_content_calendar_isolation ON social_content_calendar;
ALTER TABLE social_content_calendar NO FORCE ROW LEVEL SECURITY;
ALTER TABLE social_content_calendar DISABLE ROW LEVEL SECURITY;
