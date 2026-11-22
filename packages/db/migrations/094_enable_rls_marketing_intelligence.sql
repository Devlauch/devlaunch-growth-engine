-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 022_enable_rls_campaigns.sql, applied to the two tables added in
-- 092_create_marketing_reports.sql / 093_create_marketing_qa_log.sql.

ALTER TABLE marketing_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY marketing_reports_isolation ON marketing_reports
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE marketing_qa_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_qa_log FORCE ROW LEVEL SECURITY;

CREATE POLICY marketing_qa_log_isolation ON marketing_qa_log
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS marketing_qa_log_isolation ON marketing_qa_log;
ALTER TABLE marketing_qa_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE marketing_qa_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_reports_isolation ON marketing_reports;
ALTER TABLE marketing_reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE marketing_reports DISABLE ROW LEVEL SECURITY;
