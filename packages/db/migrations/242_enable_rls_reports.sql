-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql, applied to the two tables added in
-- 240_create_report_schedules.sql and 241_create_generated_reports.sql.
ALTER TABLE report_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedules FORCE ROW LEVEL SECURITY;

CREATE POLICY report_schedules_isolation ON report_schedules
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE generated_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY generated_reports_isolation ON generated_reports
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS generated_reports_isolation ON generated_reports;
ALTER TABLE generated_reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_reports DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS report_schedules_isolation ON report_schedules;
ALTER TABLE report_schedules NO FORCE ROW LEVEL SECURITY;
ALTER TABLE report_schedules DISABLE ROW LEVEL SECURITY;
