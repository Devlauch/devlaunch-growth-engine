-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 022_enable_rls_campaigns.sql, applied to the tables added in
-- 046_create_sequences.sql, 047_create_sequence_steps.sql,
-- 048_create_sequence_enrollments.sql and 049_create_crm_tasks.sql.
-- (050 intentionally skipped — no real gap required it.)

ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY sequences_isolation ON sequences
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY sequence_steps_isolation ON sequence_steps
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments FORCE ROW LEVEL SECURITY;

CREATE POLICY sequence_enrollments_isolation ON sequence_enrollments
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE crm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_tasks_isolation ON crm_tasks
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS crm_tasks_isolation ON crm_tasks;
ALTER TABLE crm_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_tasks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sequence_enrollments_isolation ON sequence_enrollments;
ALTER TABLE sequence_enrollments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sequence_steps_isolation ON sequence_steps;
ALTER TABLE sequence_steps NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sequences_isolation ON sequences;
ALTER TABLE sequences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sequences DISABLE ROW LEVEL SECURITY;
