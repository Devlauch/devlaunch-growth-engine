-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration,
-- applied to 614_create_workflow_execution_steps.sql.
ALTER TABLE workflow_execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_execution_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_execution_steps_isolation ON workflow_execution_steps
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS workflow_execution_steps_isolation ON workflow_execution_steps;
ALTER TABLE workflow_execution_steps NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_execution_steps DISABLE ROW LEVEL SECURITY;
