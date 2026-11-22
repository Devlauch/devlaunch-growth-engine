-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 099_enable_rls_competitors.sql, applied to the two tables added in
-- 260/261 for the AI Website Growth Analyzer.

ALTER TABLE growth_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_analyses FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_analyses_isolation ON growth_analyses
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE growth_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_recommendations FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_recommendations_isolation ON growth_recommendations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS growth_recommendations_isolation ON growth_recommendations;
ALTER TABLE growth_recommendations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_recommendations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS growth_analyses_isolation ON growth_analyses;
ALTER TABLE growth_analyses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_analyses DISABLE ROW LEVEL SECURITY;
