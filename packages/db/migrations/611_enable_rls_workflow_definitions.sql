-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 552_enable_rls_seo_campaigns.sql), applied to
-- 610_create_workflow_definitions.sql.
ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_definitions_isolation ON workflow_definitions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS workflow_definitions_isolation ON workflow_definitions;
ALTER TABLE workflow_definitions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions DISABLE ROW LEVEL SECURITY;
