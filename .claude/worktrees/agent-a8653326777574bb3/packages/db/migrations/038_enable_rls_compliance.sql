-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 022_enable_rls_campaigns.sql, applied to the
-- three tables added in 035/036/037 for roadmap item 18 ("Suppression and
-- consent").

ALTER TABLE suppression_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression_list FORCE ROW LEVEL SECURITY;

CREATE POLICY suppression_list_isolation ON suppression_list
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;

CREATE POLICY consent_records_isolation ON consent_records
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE country_send_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE country_send_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY country_send_settings_isolation ON country_send_settings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS country_send_settings_isolation ON country_send_settings;
ALTER TABLE country_send_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE country_send_settings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS consent_records_isolation ON consent_records;
ALTER TABLE consent_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_records DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS suppression_list_isolation ON suppression_list;
ALTER TABLE suppression_list NO FORCE ROW LEVEL SECURITY;
ALTER TABLE suppression_list DISABLE ROW LEVEL SECURITY;
