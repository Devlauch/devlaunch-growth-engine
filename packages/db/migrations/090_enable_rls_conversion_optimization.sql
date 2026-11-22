-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 022_enable_rls_campaigns.sql, applied to the three tables added in
-- 087_create_landing_page_audits.sql / 088_create_experiments.sql /
-- 089_create_experiment_results.sql.

ALTER TABLE landing_page_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_page_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY landing_page_audits_isolation ON landing_page_audits
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments FORCE ROW LEVEL SECURITY;

CREATE POLICY experiments_isolation ON experiments
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE experiment_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_results FORCE ROW LEVEL SECURITY;

CREATE POLICY experiment_results_isolation ON experiment_results
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS experiment_results_isolation ON experiment_results;
ALTER TABLE experiment_results NO FORCE ROW LEVEL SECURITY;
ALTER TABLE experiment_results DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS experiments_isolation ON experiments;
ALTER TABLE experiments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE experiments DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landing_page_audits_isolation ON landing_page_audits;
ALTER TABLE landing_page_audits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE landing_page_audits DISABLE ROW LEVEL SECURITY;
