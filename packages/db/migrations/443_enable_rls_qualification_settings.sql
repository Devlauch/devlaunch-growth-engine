-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 283_enable_rls_sales_conversion.sql / 439_enable_rls_contact_provenance_events.sql,
-- applied to the table added in 442_create_qualification_settings.sql.

ALTER TABLE qualification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY qualification_settings_isolation ON qualification_settings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS qualification_settings_isolation ON qualification_settings;
ALTER TABLE qualification_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE qualification_settings DISABLE ROW LEVEL SECURITY;
