-- Up Migration
--
-- Same tenant-isolation pattern as every other _enable_rls_ migration
-- (e.g. 433_enable_rls_growth_advisor_recommendations.sql,
-- 552_enable_rls_seo_campaigns.sql), applied to all four Workstream C2
-- tables: 642_create_growth_experiments.sql,
-- 643_create_experiment_exposures.sql,
-- 644_create_experiment_conversions.sql, and
-- 645_create_growth_experiment_actions.sql.
ALTER TABLE growth_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_experiments FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_experiments_isolation ON growth_experiments
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE experiment_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_exposures FORCE ROW LEVEL SECURITY;

CREATE POLICY experiment_exposures_isolation ON experiment_exposures
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE experiment_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_conversions FORCE ROW LEVEL SECURITY;

CREATE POLICY experiment_conversions_isolation ON experiment_conversions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE growth_experiment_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_experiment_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_experiment_actions_isolation ON growth_experiment_actions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS growth_experiment_actions_isolation ON growth_experiment_actions;
ALTER TABLE growth_experiment_actions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_experiment_actions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS experiment_conversions_isolation ON experiment_conversions;
ALTER TABLE experiment_conversions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE experiment_conversions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS experiment_exposures_isolation ON experiment_exposures;
ALTER TABLE experiment_exposures NO FORCE ROW LEVEL SECURITY;
ALTER TABLE experiment_exposures DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS growth_experiments_isolation ON growth_experiments;
ALTER TABLE growth_experiments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_experiments DISABLE ROW LEVEL SECURITY;
