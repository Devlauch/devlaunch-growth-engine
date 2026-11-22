-- Up Migration
--
-- Same tenant-isolation pattern as 308_enable_rls_contacts.sql /
-- 324_enable_rls_prospecting_campaigns.sql, applied to
-- 432_create_growth_advisor_recommendations.sql.

ALTER TABLE growth_advisor_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_advisor_recommendations FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_advisor_recommendations_isolation ON growth_advisor_recommendations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS growth_advisor_recommendations_isolation ON growth_advisor_recommendations;
ALTER TABLE growth_advisor_recommendations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_advisor_recommendations DISABLE ROW LEVEL SECURITY;
