-- Up Migration
--
-- Same tenant-isolation pattern as 433_enable_rls_growth_advisor_recommendations.sql,
-- applied to 434_create_growth_advisor_actions.sql.

ALTER TABLE growth_advisor_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_advisor_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_advisor_actions_isolation ON growth_advisor_actions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS growth_advisor_actions_isolation ON growth_advisor_actions;
ALTER TABLE growth_advisor_actions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_advisor_actions DISABLE ROW LEVEL SECURITY;
