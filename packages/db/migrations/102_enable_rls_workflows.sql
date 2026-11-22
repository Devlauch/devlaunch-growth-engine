-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 022_enable_rls_campaigns.sql, applied to the two tables added in
-- 100_create_workflow_runs.sql and 101_create_workflow_stage_results.sql.

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_runs_isolation ON workflow_runs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE workflow_stage_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_stage_results FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_stage_results_isolation ON workflow_stage_results
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS workflow_stage_results_isolation ON workflow_stage_results;
ALTER TABLE workflow_stage_results NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_stage_results DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_runs_isolation ON workflow_runs;
ALTER TABLE workflow_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs DISABLE ROW LEVEL SECURITY;
