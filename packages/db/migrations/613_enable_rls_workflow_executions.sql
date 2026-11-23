-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration,
-- applied to 612_create_workflow_executions.sql.
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_executions_isolation ON workflow_executions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS workflow_executions_isolation ON workflow_executions;
ALTER TABLE workflow_executions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions DISABLE ROW LEVEL SECURITY;
